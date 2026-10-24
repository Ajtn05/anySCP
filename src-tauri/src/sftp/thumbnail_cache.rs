//! Session-scoped, bounded disk cache. Remote paths never become local paths.
use super::SftpError;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Mutex,
};

const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_ENTRIES: usize = 512;
const MAX_THUMBNAIL: usize = 512 * 1024;
const TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub struct CacheKey {
    pub session: String,
    pub path: String,
    pub size: u64,
    pub modified: u32,
    pub generation: u64,
}

struct Entry {
    path: PathBuf,
    bytes: usize,
    accessed: u64,
    expires: Instant,
}
#[derive(Default)]
struct Contents {
    entries: HashMap<CacheKey, Entry>,
    generations: HashMap<String, u64>,
    bytes: usize,
    tick: u64,
    root: Option<PathBuf>,
}

pub struct ThumbnailCache {
    contents: Arc<Mutex<Contents>>,
    run_id: String,
}
impl ThumbnailCache {
    pub fn new() -> Self {
        Self {
            contents: Arc::new(Mutex::new(Contents::default())),
            run_id: uuid::Uuid::new_v4().to_string(),
        }
    }

    pub async fn generation(&self, session: &str) -> u64 {
        *self
            .contents
            .lock()
            .await
            .generations
            .get(session)
            .unwrap_or(&0)
    }

    pub async fn get(&self, key: &CacheKey) -> Option<Vec<u8>> {
        let mut contents = self.contents.lock().await;
        contents.tick += 1;
        let tick = contents.tick;
        let entry = contents.entries.get_mut(key)?;
        if entry.expires > Instant::now() {
            let read = async {
                let mut bytes = Vec::new();
                tokio::fs::File::open(&entry.path)
                    .await?
                    .take((MAX_THUMBNAIL + 1) as u64)
                    .read_to_end(&mut bytes)
                    .await?;
                Ok::<_, std::io::Error>(bytes)
            }
            .await;
            if let Ok(bytes) = read {
                if bytes.len() == entry.bytes && valid(&bytes) {
                    entry.accessed = tick;
                    return Some(bytes);
                }
            }
        }
        remove(&mut contents, key).await;
        None
    }

    pub async fn put(&self, base: &Path, key: CacheKey, bytes: &[u8]) -> Result<(), SftpError> {
        if !valid(bytes) {
            return Ok(());
        }
        let contents = self.contents.clone();
        let run_id = self.run_id.clone();
        let base = base.to_path_buf();
        let bytes = bytes.to_vec();
        // The caller may cancel a read at any await. This task owns the entire
        // atomic write and index update, so cancellation cannot orphan a partial
        // file. Invalidation still serializes through the same generation lock.
        tokio::spawn(async move { Self::store(&contents, &run_id, &base, key, &bytes).await })
            .await
            .map_err(|e| SftpError::LocalIoError(e.to_string()))?
    }

    async fn store(
        contents: &Mutex<Contents>,
        run_id: &str,
        base: &Path,
        key: CacheKey,
        bytes: &[u8],
    ) -> Result<(), SftpError> {
        if !valid(bytes) {
            return Ok(());
        }
        let mut contents = contents.lock().await;
        if *contents.generations.get(&key.session).unwrap_or(&0) != key.generation {
            return Ok(());
        }
        if contents.root.is_none() {
            // Crash leftovers are private, limited to 64 MiB per run, and swept
            // after 24 hours. Never remove another live process's recent cache.
            if let Ok(mut dirs) = tokio::fs::read_dir(base).await {
                while let Ok(Some(dir)) = dirs.next_entry().await {
                    if uuid::Uuid::parse_str(&dir.file_name().to_string_lossy()).is_ok() {
                        if let Ok(metadata) = dir.metadata().await {
                            if metadata.is_dir()
                                && metadata
                                    .modified()
                                    .ok()
                                    .and_then(|t| t.elapsed().ok())
                                    .is_some_and(|age| age > Duration::from_secs(86400))
                            {
                                let _ = tokio::fs::remove_dir_all(dir.path()).await;
                            }
                        }
                    }
                }
            }
            let root = base.join(run_id);
            private_dir(&root).await?;
            contents.root = Some(root);
        }
        remove(&mut contents, &key).await;
        while contents.entries.len() >= MAX_ENTRIES || contents.bytes + bytes.len() > MAX_BYTES {
            let oldest = contents
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.accessed)
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                remove(&mut contents, &oldest).await;
            } else {
                break;
            }
        }
        let path = contents
            .root
            .as_ref()
            .expect("cache root")
            .join(uuid::Uuid::new_v4().to_string());
        let partial = path.with_extension("partial");
        let result = async {
            let mut options = tokio::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            options.mode(0o600);
            let mut file = options.open(&partial).await?;
            file.write_all(bytes).await?;
            file.flush().await?;
            drop(file);
            tokio::fs::rename(&partial, &path).await
        }
        .await;
        if let Err(error) = result {
            let _ = tokio::fs::remove_file(partial).await;
            return Err(SftpError::LocalIoError(error.to_string()));
        }
        contents.tick += 1;
        let accessed = contents.tick;
        contents.bytes += bytes.len();
        contents.entries.insert(
            key,
            Entry {
                path,
                bytes: bytes.len(),
                accessed,
                expires: Instant::now() + TTL,
            },
        );
        Ok(())
    }

    pub async fn clear_session(&self, session: &str) {
        let mut contents = self.contents.lock().await;
        *contents.generations.entry(session.into()).or_default() += 1;
        let keys: Vec<_> = contents
            .entries
            .keys()
            .filter(|key| key.session == session)
            .cloned()
            .collect();
        for key in keys {
            remove(&mut contents, &key).await;
        }
    }
}

impl Drop for Contents {
    fn drop(&mut self) {
        if let Some(root) = &self.root {
            let _ = std::fs::remove_dir_all(root);
        }
    }
}

fn valid(bytes: &[u8]) -> bool {
    bytes.len() <= MAX_THUMBNAIL && bytes.starts_with(b"\x89PNG\r\n\x1a\n")
}
async fn remove(contents: &mut Contents, key: &CacheKey) {
    if let Some(entry) = contents.entries.remove(key) {
        contents.bytes -= entry.bytes;
        let _ = tokio::fs::remove_file(entry.path).await;
    }
}
async fn private_dir(path: &Path) -> Result<(), SftpError> {
    let mut builder = tokio::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder
        .create(path)
        .await
        .map_err(|e| SftpError::LocalIoError(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn key(session: &str, path: &str) -> CacheKey {
        CacheKey {
            session: session.into(),
            path: path.into(),
            size: 20,
            modified: 1,
            generation: 0,
        }
    }
    fn png() -> Vec<u8> {
        b"\x89PNG\r\n\x1a\nfixture".to_vec()
    }

    #[tokio::test]
    async fn isolates_sessions_and_never_uses_remote_paths_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let cache = ThumbnailCache::new();
        let first = key("normal", "/../../same.png");
        let second = key("sudo", "/../../same.png");
        cache.put(dir.path(), first.clone(), &png()).await.unwrap();
        assert_eq!(cache.get(&first).await.unwrap(), png());
        assert!(cache.get(&second).await.is_none());
        let state = cache.contents.lock().await;
        assert!(state.entries[&first].path.starts_with(dir.path()));
        assert!(uuid::Uuid::parse_str(
            state.entries[&first]
                .path
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
        )
        .is_ok());
    }
    #[tokio::test]
    async fn invalidation_blocks_in_flight_stale_inserts_and_preserves_other_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let cache = ThumbnailCache::new();
        cache
            .put(dir.path(), key("a", "/a.png"), &png())
            .await
            .unwrap();
        cache
            .put(dir.path(), key("b", "/a.png"), &png())
            .await
            .unwrap();
        cache.clear_session("a").await;
        cache
            .put(dir.path(), key("a", "/stale.png"), &png())
            .await
            .unwrap();
        assert_eq!(cache.contents.lock().await.entries.len(), 1);
        assert!(cache.get(&key("b", "/a.png")).await.is_some());
    }
    #[tokio::test]
    async fn evicts_least_recently_used_and_rejects_oversized_payloads() {
        let dir = tempfile::tempdir().unwrap();
        let cache = ThumbnailCache::new();
        for i in 0..MAX_ENTRIES {
            cache
                .put(dir.path(), key("a", &i.to_string()), &png())
                .await
                .unwrap();
        }
        cache.get(&key("a", "0")).await.unwrap();
        cache
            .put(dir.path(), key("a", "last"), &png())
            .await
            .unwrap();
        assert!(cache.get(&key("a", "1")).await.is_none());
        assert!(cache.get(&key("a", "0")).await.is_some());
        cache
            .put(dir.path(), key("a", "large"), &vec![0; MAX_THUMBNAIL + 1])
            .await
            .unwrap();
        assert!(cache.get(&key("a", "large")).await.is_none());
        assert!(cache.contents.lock().await.bytes <= MAX_BYTES);
    }
    #[tokio::test]
    async fn corrupt_and_expired_entries_are_discarded() {
        let dir = tempfile::tempdir().unwrap();
        let cache = ThumbnailCache::new();
        let key = key("a", "/a.png");
        cache.put(dir.path(), key.clone(), &png()).await.unwrap();
        let path = cache.contents.lock().await.entries[&key].path.clone();
        tokio::fs::write(path, b"corrupt").await.unwrap();
        assert!(cache.get(&key).await.is_none());
        cache.put(dir.path(), key.clone(), &png()).await.unwrap();
        cache
            .contents
            .lock()
            .await
            .entries
            .get_mut(&key)
            .unwrap()
            .expires = Instant::now();
        assert!(cache.get(&key).await.is_none());
    }

    #[tokio::test]
    async fn cancelling_the_caller_cannot_leave_an_unindexed_partial_write() {
        let directory = tempfile::tempdir().unwrap();
        let cache = Arc::new(ThumbnailCache::new());
        let locked = cache.contents.lock().await;
        let writer_cache = cache.clone();
        let base = directory.path().to_path_buf();
        let writer = tokio::spawn(async move {
            writer_cache
                .put(&base, key("s", "/photo.png"), &png())
                .await
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            while Arc::strong_count(&cache.contents) < 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        writer.abort();
        drop(locked);
        tokio::time::timeout(Duration::from_secs(5), async {
            while cache.get(&key("s", "/photo.png")).await.is_none() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let root = cache.contents.lock().await.root.clone().unwrap();
        let mut files = tokio::fs::read_dir(root).await.unwrap();
        let mut count = 0;
        while let Some(file) = files.next_entry().await.unwrap() {
            assert!(!file.file_name().to_string_lossy().ends_with(".partial"));
            count += 1;
        }
        assert_eq!(count, 1);
    }
}
