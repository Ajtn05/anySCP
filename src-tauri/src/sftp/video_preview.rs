//! Window/session-scoped media leases. Remote bytes never enter a local movie
//! file or the transfer queue. Only normalized poster PNGs can reach the cache.
use std::{
    collections::HashMap,
    io::{Cursor, SeekFrom},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use russh_sftp::{
    client::SftpSession,
    protocol::{FileAttributes, FileType},
};
use serde::Serialize;
use tauri::{
    http::{Request, Response},
    ipc::{InvokeBody, Response as IpcResponse},
    AppHandle, Manager, State, Window,
};
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    sync::Semaphore,
};
use tokio_util::sync::CancellationToken;

use super::{
    preview::PreviewManager,
    thumbnail_cache::{CacheKey, ThumbnailCache},
    transfer_manager::TransferManager,
    SftpError, SftpManager,
};

const RANGE_LIMIT: u64 = 1024 * 1024;
const POSTER_BUDGET: u64 = 8 * 1024 * 1024;
const IDLE_SECONDS: u64 = 120;
const TIMEOUT: Duration = Duration::from_secs(15);

fn error(message: impl Into<String>) -> SftpError {
    SftpError::ProtocolError(message.into())
}

pub(super) fn mime(path: &str) -> Option<&'static str> {
    match path.rsplit_once('.')?.1.to_ascii_lowercase().as_str() {
        "mp4" | "m4v" => Some("video/mp4"),
        "mov" => Some("video/quicktime"),
        "webm" => Some("video/webm"),
        _ => None,
    }
}

struct Lease {
    session: String,
    window: String,
    path: String,
    thumbnail: bool,
    token: CancellationToken,
    created: Instant,
    touched: AtomicU64,
    opened: AtomicBool,
    deferred: AtomicBool,
    remaining: AtomicU64,
    metadata: OnceLock<FileAttributes>,
    generation: OnceLock<u64>,
}

impl Lease {
    fn expired(&self) -> bool {
        self.created
            .elapsed()
            .as_secs()
            .saturating_sub(self.touched.load(Ordering::Relaxed))
            >= IDLE_SECONDS
    }
    fn touch(&self) {
        self.touched
            .store(self.created.elapsed().as_secs(), Ordering::Relaxed);
    }
    fn cache_key(&self) -> Option<CacheKey> {
        let attrs = self.metadata.get()?;
        Some(CacheKey {
            session: self.session.clone(),
            path: self.path.clone(),
            size: attrs.size?,
            modified: attrs.mtime?,
            generation: *self.generation.get()?,
        })
    }
}

pub struct VideoManager {
    leases: Mutex<HashMap<String, Arc<Lease>>>,
    // Admission happens before spawning protocol tasks, so a webview cannot
    // build an unbounded queue of range buffers/futures behind the shared worker.
    requests: Arc<Semaphore>,
}

impl VideoManager {
    pub fn new() -> Self {
        Self {
            leases: Mutex::new(HashMap::new()),
            requests: Arc::new(Semaphore::new(4)),
        }
    }
    fn begin(
        &self,
        session: String,
        window: String,
        path: String,
        thumbnail: bool,
    ) -> Result<String, SftpError> {
        if !path.starts_with('/') || path.contains('\0') {
            return Err(SftpError::InvalidPath(path));
        }
        if mime(&path).is_none() {
            return Err(error(
                "This video can't be played here. Download the file to open it.",
            ));
        }
        let mut leases = self.leases.lock().unwrap();
        leases.retain(|_, lease| {
            let remove = lease.expired()
                || (lease.window == window
                    && ((!thumbnail && lease.session == session)
                        || (lease.thumbnail && lease.path == path && lease.session == session)));
            if remove {
                lease.token.cancel();
            }
            !remove
        });
        if leases.len() >= 8 {
            return Err(error(
                "Too many videos are open. Close another preview and try again.",
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        leases.insert(
            id.clone(),
            Arc::new(Lease {
                session,
                window,
                path,
                thumbnail,
                token: CancellationToken::new(),
                created: Instant::now(),
                touched: AtomicU64::new(0),
                opened: AtomicBool::new(false),
                deferred: AtomicBool::new(false),
                remaining: AtomicU64::new(POSTER_BUDGET),
                metadata: OnceLock::new(),
                generation: OnceLock::new(),
            }),
        );
        Ok(id)
    }
    fn get(&self, id: &str, window: &str) -> Result<Arc<Lease>, SftpError> {
        let lease = self
            .leases
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or(SftpError::TransferCancelled)?;
        if lease.window != window || lease.token.is_cancelled() || lease.expired() {
            if lease.expired() {
                self.cancel(id, &lease.window);
            }
            return Err(SftpError::TransferCancelled);
        }
        lease.touch();
        Ok(lease)
    }
    fn cancel(&self, id: &str, window: &str) {
        let mut leases = self.leases.lock().unwrap();
        if leases.get(id).is_some_and(|lease| lease.window == window) {
            if let Some(lease) = leases.remove(id) {
                lease.token.cancel();
            }
        }
    }
    fn remove_matching(&self, matches: impl Fn(&Lease) -> bool) {
        self.leases.lock().unwrap().retain(|_, lease| {
            if matches(lease) {
                lease.token.cancel();
                false
            } else {
                true
            }
        });
    }
    pub fn cancel_session(&self, session: &str) {
        self.remove_matching(|lease| lease.session == session);
    }
    pub fn cancel_thumbnails(&self, session: &str) {
        self.remove_matching(|lease| lease.session == session && lease.thumbnail);
    }
    pub fn cancel_window(&self, window: &str) {
        self.remove_matching(|lease| lease.window == window);
    }
    pub(super) fn has_foreground(&self) -> bool {
        self.leases
            .lock()
            .unwrap()
            .values()
            .any(|lease| !lease.thumbnail && !lease.expired() && !lease.token.is_cancelled())
    }
}

#[tauri::command]
pub fn sftp_video_begin(
    sftp_session_id: String,
    path: String,
    thumbnail: Option<bool>,
    window: Window,
    videos: State<'_, VideoManager>,
    sftp: State<'_, Arc<SftpManager>>,
) -> Result<String, SftpError> {
    sftp.get_session(&sftp_session_id)?;
    videos.begin(
        sftp_session_id,
        window.label().into(),
        path,
        thumbnail.unwrap_or(false),
    )
}

#[tauri::command]
pub fn sftp_video_cancel(request_id: String, window: Window, videos: State<'_, VideoManager>) {
    videos.cancel(&request_id, window.label());
}

#[tauri::command]
pub fn sftp_video_deferred(
    request_id: String,
    window: Window,
    videos: State<'_, VideoManager>,
) -> bool {
    videos
        .get(&request_id, window.label())
        .is_ok_and(|lease| lease.deferred.load(Ordering::Relaxed))
}

#[derive(Serialize)]
pub struct VideoInfo {
    source_size: u64,
    mime: &'static str,
}

fn unchanged(before: &FileAttributes, after: &FileAttributes) -> bool {
    after.file_type() == FileType::File && before.size == after.size && before.mtime == after.mtime
}

fn check(lease: &Lease, busy: &impl Fn() -> bool) -> Result<(), SftpError> {
    if lease.token.is_cancelled() {
        return Err(SftpError::TransferCancelled);
    }
    if busy() {
        lease.deferred.store(true, Ordering::Relaxed);
        return Err(SftpError::PreviewDeferred);
    }
    Ok(())
}

async fn inspect(
    session: Arc<tokio::sync::Mutex<SftpSession>>,
    lease: &Lease,
    busy: impl Fn() -> bool,
) -> Result<FileAttributes, SftpError> {
    check(lease, &busy)?;
    let mut file = {
        let sftp = session.lock().await;
        let attrs = sftp
            .metadata(&lease.path)
            .await
            .map_err(|e| error(e.to_string()))?;
        if attrs.file_type() != FileType::File
            || attrs
                .size
                .is_none_or(|size| size < 16 || size > i64::MAX as u64)
        {
            return Err(error(
                "Only regular videos with a known size can be previewed",
            ));
        }
        sftp.open(&lease.path)
            .await
            .map_err(|e| error(e.to_string()))?
    };
    let result = async {
        let before = file.metadata().await.map_err(|e| error(e.to_string()))?;
        if before.file_type() != FileType::File
            || before
                .size
                .is_none_or(|size| size < 16 || size > i64::MAX as u64)
        {
            return Err(error("The video changed before loading"));
        }
        check(lease, &busy)?;
        if lease.thumbnail {
            lease
                .remaining
                .try_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                    left.checked_sub(16)
                })
                .map_err(|_| error("Video poster exceeds the read budget"))?;
        }
        let mut header = [0; 16];
        file.read_exact(&mut header)
            .await
            .map_err(|e| error(e.to_string()))?;
        let valid = if mime(&lease.path) == Some("video/webm") {
            header.starts_with(&[0x1a, 0x45, 0xdf, 0xa3])
        } else {
            &header[4..8] == b"ftyp"
        };
        if !valid {
            return Err(error(
                "This video can't be played here. Download the file to open it.",
            ));
        }
        let after = file.metadata().await.map_err(|e| error(e.to_string()))?;
        if !unchanged(&before, &after) {
            return Err(error("The video changed while loading"));
        }
        Ok(before)
    }
    .await;
    let _ = file.shutdown().await;
    result
}

#[tauri::command]
pub async fn sftp_video_open(
    request_id: String,
    window: Window,
    videos: State<'_, VideoManager>,
    sftp: State<'_, Arc<SftpManager>>,
    previews: State<'_, PreviewManager>,
    transfers: State<'_, Arc<TransferManager>>,
    cache: State<'_, ThumbnailCache>,
) -> Result<VideoInfo, SftpError> {
    let lease = videos.get(&request_id, window.label())?;
    if lease.opened.swap(true, Ordering::SeqCst) {
        return Err(error("Video request is already open"));
    }
    let work = async {
        let busy = || {
            sftp.has_active_transfers()
                || transfers.has_active_transfers()
                || (lease.thumbnail && (previews.has_foreground() || videos.has_foreground()))
        };
        check(&lease, &busy)?;
        let _permit = previews
            .worker()
            .acquire_owned()
            .await
            .map_err(|e| error(e.to_string()))?;
        let generation = cache.generation(&lease.session).await;
        let session = { sftp.get_session(&lease.session)?.sftp.clone() };
        let attrs = inspect(session, &lease, busy).await?;
        let size = attrs.size.unwrap_or(0);
        let _ = lease.metadata.set(attrs);
        let _ = lease.generation.set(generation);
        Ok(VideoInfo {
            source_size: size,
            mime: mime(&lease.path).unwrap(),
        })
    };
    let result = tokio::select! {
        _ = lease.token.cancelled() => Err(SftpError::TransferCancelled),
        result = tokio::time::timeout(TIMEOUT, work) => result.unwrap_or_else(|_| Err(error("Video preview timed out"))),
    };
    if result.is_err() {
        videos.cancel(&request_id, window.label());
    }
    result
}

/// Single byte ranges only, capped even for `bytes=0-`. A no-Range GET is
/// supported only for small files; never turn that request into a full movie.
fn range(header: Option<&str>, size: u64) -> Result<(u64, u64), ()> {
    if size == 0 {
        return Err(());
    }
    let Some(header) = header else {
        return if size <= RANGE_LIMIT {
            Ok((0, size - 1))
        } else {
            Err(())
        };
    };
    let value = header.strip_prefix("bytes=").ok_or(())?;
    let (start, end) = value.split_once('-').ok_or(())?;
    let number = |s: &str| {
        if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
            s.parse::<u64>().map_err(|_| ())
        } else {
            Err(())
        }
    };
    let (start, end) = if start.is_empty() {
        let suffix = number(end)?;
        if suffix == 0 {
            return Err(());
        }
        (size.saturating_sub(suffix), size - 1)
    } else {
        let start = number(start)?;
        (
            start,
            if end.is_empty() {
                size - 1
            } else {
                number(end)?.min(size - 1)
            },
        )
    };
    if start >= size || start > end {
        return Err(());
    }
    Ok((start, end.min(start.saturating_add(RANGE_LIMIT - 1))))
}

async fn read_range(
    session: Arc<tokio::sync::Mutex<SftpSession>>,
    lease: &Lease,
    start: u64,
    end: u64,
    busy: impl Fn() -> bool,
) -> Result<Vec<u8>, SftpError> {
    check(lease, &busy)?;
    let expected = lease
        .metadata
        .get()
        .ok_or_else(|| error("Video is not open"))?;
    if end < start || end >= expected.size.unwrap_or(0) || end - start >= RANGE_LIMIT {
        return Err(error("Invalid video range"));
    }
    let length = end - start + 1;
    if lease.thumbnail
        && lease
            .remaining
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                left.checked_sub(length)
            })
            .is_err()
    {
        return Err(error("Video poster exceeds the 8 MiB read budget"));
    }
    let mut file = {
        let sftp = session.lock().await;
        let attrs = sftp
            .metadata(&lease.path)
            .await
            .map_err(|e| error(e.to_string()))?;
        if !unchanged(expected, &attrs) {
            return Err(error("The video changed. Open the preview again."));
        }
        sftp.open(&lease.path)
            .await
            .map_err(|e| error(e.to_string()))?
    };
    let result = async {
        let attrs = file.metadata().await.map_err(|e| error(e.to_string()))?;
        if !unchanged(expected, &attrs) {
            return Err(error("The video changed before loading"));
        }
        file.seek(SeekFrom::Start(start))
            .await
            .map_err(|e| error(e.to_string()))?;
        let mut bytes = vec![0; length as usize];
        let mut filled = 0;
        while filled < bytes.len() {
            check(lease, &busy)?;
            let chunk = if lease.thumbnail {
                32 * 1024
            } else {
                256 * 1024
            };
            let end = (filled + chunk).min(bytes.len());
            let n = file
                .read(&mut bytes[filled..end])
                .await
                .map_err(|e| error(e.to_string()))?;
            if n == 0 {
                return Err(error("The video ended before the requested range"));
            }
            filled += n;
        }
        let after = file.metadata().await.map_err(|e| error(e.to_string()))?;
        if !unchanged(expected, &after) {
            return Err(error("The video changed while loading"));
        }
        Ok(bytes)
    }
    .await;
    let _ = file.shutdown().await;
    result
}

fn reply(
    status: u16,
    mime: &str,
    body: Vec<u8>,
    content_range: Option<String>,
    length: u64,
) -> Response<Vec<u8>> {
    let mut builder = Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Content-Length", length)
        .header("Accept-Ranges", "bytes")
        .header("Cache-Control", "no-store")
        .header("Access-Control-Allow-Origin", "*")
        .header(
            "Access-Control-Expose-Headers",
            "Content-Range, Accept-Ranges, Content-Length",
        )
        .header("X-Content-Type-Options", "nosniff");
    if let Some(value) = content_range {
        builder = builder.header("Content-Range", value);
    }
    builder.body(body).expect("valid video response")
}

pub fn register(
    app: AppHandle,
    window: String,
    request: Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let Ok(admission) = app
        .state::<VideoManager>()
        .requests
        .clone()
        .try_acquire_owned()
    else {
        responder.respond(reply(503, "text/plain", vec![], None, 0));
        return;
    };
    tauri::async_runtime::spawn(async move {
        let _admission = admission;
        let response = serve(&app, &window, request).await;
        responder.respond(response);
    });
}

async fn serve(app: &AppHandle, window: &str, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let videos = app.state::<VideoManager>();
    let path = request.uri().path().trim_start_matches('/');
    if uuid::Uuid::parse_str(path).is_err() || request.uri().query().is_some() {
        return reply(404, "text/plain", vec![], None, 0);
    }
    let Ok(lease) = videos.get(path, window) else {
        return reply(404, "text/plain", vec![], None, 0);
    };
    let Some(attrs) = lease.metadata.get() else {
        return reply(404, "text/plain", vec![], None, 0);
    };
    let size = attrs.size.unwrap_or(0);
    let mime = mime(&lease.path).unwrap();
    if request.method() == "HEAD" {
        return reply(200, mime, vec![], None, size);
    }
    if request.method() != "GET" {
        return reply(405, "text/plain", vec![], None, 0);
    }
    let header = request.headers().get("Range");
    let parsed = match header {
        Some(header) => header
            .to_str()
            .ok()
            .and_then(|value| range(Some(value), size).ok()),
        None => range(None, size).ok(),
    };
    let Some((start, end)) = parsed else {
        return reply(416, mime, vec![], Some(format!("bytes */{size}")), 0);
    };
    let sftp = app.state::<Arc<SftpManager>>();
    let transfers = app.state::<Arc<TransferManager>>();
    let previews = app.state::<PreviewManager>();
    let work = async {
        let busy = || {
            sftp.has_active_transfers()
                || transfers.has_active_transfers()
                || (lease.thumbnail && (previews.has_foreground() || videos.has_foreground()))
        };
        check(&lease, &busy)?;
        let _permit = previews
            .worker()
            .acquire_owned()
            .await
            .map_err(|e| error(e.to_string()))?;
        let session = { sftp.get_session(&lease.session)?.sftp.clone() };
        read_range(session, &lease, start, end, busy).await
    };
    let result = tokio::select! {
        _ = lease.token.cancelled() => Err(SftpError::TransferCancelled),
        result = tokio::time::timeout(TIMEOUT, work) => result.unwrap_or_else(|_| Err(error("Video range timed out"))),
    };
    match result {
        Ok(bytes) => reply(
            if header.is_some() { 206 } else { 200 },
            mime,
            bytes,
            header.map(|_| format!("bytes {start}-{end}/{size}")),
            end - start + 1,
        ),
        Err(SftpError::PreviewDeferred) => reply(503, "text/plain", vec![], None, 0),
        Err(_) => {
            videos.cancel(path, window);
            reply(410, "text/plain", vec![], None, 0)
        }
    }
}

#[tauri::command]
pub async fn sftp_video_poster_cached(
    request_id: String,
    window: Window,
    videos: State<'_, VideoManager>,
    cache: State<'_, ThumbnailCache>,
    sftp: State<'_, Arc<SftpManager>>,
) -> Result<IpcResponse, SftpError> {
    let lease = videos.get(&request_id, window.label())?;
    let work = async {
        let expected = lease
            .metadata
            .get()
            .ok_or_else(|| error("Video is not open"))?;
        let session = { sftp.get_session(&lease.session)?.sftp.clone() };
        let attrs = session
            .lock()
            .await
            .metadata(&lease.path)
            .await
            .map_err(|e| error(e.to_string()))?;
        if !unchanged(expected, &attrs) {
            return Err(error("The video changed before loading"));
        }
        let bytes = if let Some(key) = lease.cache_key() {
            cache.get(&key).await.unwrap_or_default()
        } else {
            vec![]
        };
        Ok(IpcResponse::new(bytes))
    };
    tokio::select! {
        _ = lease.token.cancelled() => Err(SftpError::TransferCancelled),
        result = tokio::time::timeout(TIMEOUT, work) => result.unwrap_or_else(|_| Err(error("Video poster lookup timed out"))),
    }
}

fn normalize_poster(bytes: &[u8]) -> Result<Vec<u8>, SftpError> {
    if bytes.len() > 512 * 1024 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(error("Invalid video poster"));
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), ImageFormat::Png);
    let mut limits = Limits::default();
    limits.max_image_width = Some(320);
    limits.max_image_height = Some(320);
    limits.max_alloc = Some(1024 * 1024);
    reader.limits(limits);
    let decoder = reader.into_decoder().map_err(|e| error(e.to_string()))?;
    if decoder.total_bytes() > 320 * 320 * 4 {
        return Err(error("Video poster is too large"));
    }
    let image = DynamicImage::from_decoder(decoder).map_err(|e| error(e.to_string()))?;
    let mut output = Cursor::new(vec![]);
    image
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|e| error(e.to_string()))?;
    Ok(output.into_inner())
}

#[tauri::command]
pub async fn sftp_video_poster_store(
    request: tauri::ipc::Request<'_>,
    window: Window,
    app: AppHandle,
    videos: State<'_, VideoManager>,
    cache: State<'_, ThumbnailCache>,
    previews: State<'_, PreviewManager>,
    sftp: State<'_, Arc<SftpManager>>,
) -> Result<(), SftpError> {
    let id = request
        .headers()
        .get("x-preview-id")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| error("Video request is unavailable"))?;
    let lease = videos.get(id, window.label())?;
    if !lease.thumbnail {
        return Err(error("Only thumbnail requests can store posters"));
    }
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(error("Expected binary PNG data"));
    };
    if bytes.len() > 512 * 1024 {
        return Err(error("Video poster is too large"));
    }
    let bytes = bytes.clone();
    let work = async {
        let permit = previews
            .worker()
            .acquire_owned()
            .await
            .map_err(|e| error(e.to_string()))?;
        let png = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            normalize_poster(&bytes)
        })
        .await
        .map_err(|e| error(e.to_string()))??;
        if lease.token.is_cancelled() {
            return Err(SftpError::TransferCancelled);
        }
        let expected = lease
            .metadata
            .get()
            .ok_or_else(|| error("Video is not open"))?;
        let session = { sftp.get_session(&lease.session)?.sftp.clone() };
        let attrs = session
            .lock()
            .await
            .metadata(&lease.path)
            .await
            .map_err(|e| error(e.to_string()))?;
        if !unchanged(expected, &attrs) {
            return Err(error("The video changed before saving its poster"));
        }
        if let Some(key) = lease.cache_key() {
            let base = app
                .path()
                .app_cache_dir()
                .map_err(|e| error(e.to_string()))?
                .join("thumbnails-v1");
            cache.put(&base, key, &png).await?;
        }
        Ok(())
    };
    tokio::select! {
        _ = lease.token.cancelled() => Err(SftpError::TransferCancelled),
        result = tokio::time::timeout(TIMEOUT, work) => result.unwrap_or_else(|_| Err(error("Video poster cache write timed out"))),
    }
}

#[cfg(test)]
mod tests {
    use super::super::preview::tests::test_session_counted;
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn movie(size: usize) -> Vec<u8> {
        let mut bytes: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        bytes[..16].copy_from_slice(b"\0\0\0\x20ftypisom\0\0\0\0");
        bytes
    }
    fn lease(thumbnail: bool) -> Arc<Lease> {
        let videos = VideoManager::new();
        let id = videos
            .begin("s".into(), "main".into(), "/movie.mp4".into(), thumbnail)
            .unwrap();
        videos.get(&id, "main").unwrap()
    }
    async fn prepared(
        bytes: Vec<u8>,
        thumbnail: bool,
    ) -> (
        Arc<Lease>,
        super::super::preview::tests::TestConnection,
        Arc<AtomicUsize>,
    ) {
        let (connection, reads) = test_session_counted(bytes, None, 0o100644, false).await;
        let lease = lease(thumbnail);
        let attrs = inspect(connection.0.clone(), &lease, || false)
            .await
            .unwrap();
        lease.metadata.set(attrs).unwrap();
        lease.generation.set(0).unwrap();
        (lease, connection, reads)
    }
    #[test]
    fn ranges_are_inclusive_capped_and_overflow_safe() {
        let size = RANGE_LIMIT * 5;
        assert_eq!(range(Some("bytes=0-1"), size), Ok((0, 1)));
        assert_eq!(
            range(Some("bytes=10-"), size),
            Ok((10, 10 + RANGE_LIMIT - 1))
        );
        assert_eq!(range(Some("bytes=-16"), size), Ok((size - 16, size - 1)));
        assert_eq!(range(Some("bytes=8-999"), 100), Ok((8, 99)));
        assert_eq!(range(Some("bytes=-999"), 100), Ok((0, 99)));
        assert_eq!(range(None, 100), Ok((0, 99)));
        for header in [
            "",
            "bytes=",
            "bytes=0-1,2-3",
            "items=0-1",
            "bytes=-0",
            "bytes=2-1",
            "bytes= 0-1",
            "bytes=+1-2",
            "bytes=18446744073709551616-",
        ] {
            assert!(range(Some(header), size).is_err(), "{header}");
        }
        assert!(range(Some("bytes=100-"), 100).is_err());
        assert!(range(Some("bytes=0-"), 0).is_err());
        assert!(range(None, size).is_err());
    }
    #[test]
    fn leases_are_opaque_owner_scoped_bounded_and_revocable() {
        let videos = VideoManager::new();
        let id = videos
            .begin("s".into(), "main".into(), "/private/clip.MP4".into(), false)
            .unwrap();
        assert!(uuid::Uuid::parse_str(&id).is_ok());
        assert!(!id.contains("private"));
        assert!(videos.get(&id, "other").is_err());
        videos.cancel(&id, "other");
        assert!(videos.get(&id, "main").is_ok());
        let foreground = videos.get(&id, "main").unwrap();
        let thumbnail_id = videos
            .begin("s".into(), "main".into(), "/private/clip.MP4".into(), true)
            .unwrap();
        videos.cancel_thumbnails("s");
        assert!(videos.get(&thumbnail_id, "main").is_err());
        assert!(!foreground.token.is_cancelled());
        videos.cancel_session("s");
        assert!(foreground.token.is_cancelled());
        for index in 0..8 {
            videos
                .begin(format!("s{index}"), "main".into(), "/clip.mp4".into(), true)
                .unwrap();
        }
        assert!(videos
            .begin("ninth".into(), "main".into(), "/clip.mp4".into(), true)
            .is_err());
        videos.cancel_window("main");
        assert!(videos.leases.lock().unwrap().is_empty());
        assert!(videos
            .begin("s".into(), "main".into(), "relative.mp4".into(), false)
            .is_err());
        assert!(videos
            .begin("s".into(), "main".into(), "/clip.mkv".into(), false)
            .is_err());
    }
    #[test]
    fn expired_leases_cannot_be_revived_by_a_request() {
        let mut old = Arc::try_unwrap(lease(false)).ok().unwrap();
        old.created = Instant::now() - Duration::from_secs(IDLE_SECONDS + 1);
        let videos = VideoManager::new();
        videos
            .leases
            .lock()
            .unwrap()
            .insert("old".into(), Arc::new(old));
        assert!(videos.get("old", "main").is_err());
        assert!(videos.leases.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn independent_video_ranges_and_original_download_preserve_bytes() {
        let bytes = movie(3 * RANGE_LIMIT as usize);
        let (lease, (session, closed, opened), reads) = prepared(bytes.clone(), false).await;
        assert_eq!(reads.load(Ordering::SeqCst), 16);
        let first = read_range(session.clone(), &lease, 128, 32767, || false);
        let last = read_range(
            session.clone(),
            &lease,
            bytes.len() as u64 - 128,
            bytes.len() as u64 - 1,
            || false,
        );
        let download = async {
            let mut file = session.lock().await.open("/movie.mp4").await.unwrap();
            let mut downloaded = Vec::new();
            file.read_to_end(&mut downloaded).await.unwrap();
            file.shutdown().await.unwrap();
            downloaded
        };
        let (first, last, downloaded) = tokio::join!(first, last, download);
        assert_eq!(first.unwrap(), bytes[128..32768]);
        assert_eq!(last.unwrap(), bytes[bytes.len() - 128..]);
        assert_eq!(downloaded, bytes);
        assert_eq!(closed.load(Ordering::SeqCst), 4);
        assert_eq!(opened.load(Ordering::SeqCst), 4);
    }
    #[tokio::test]
    async fn poster_budget_is_total_across_seeks_and_refuses_more_io() {
        let (lease, (session, _, opened), reads) =
            prepared(movie(RANGE_LIMIT as usize), true).await;
        for _ in 0..7 {
            assert_eq!(
                read_range(session.clone(), &lease, 0, RANGE_LIMIT - 1, || false)
                    .await
                    .unwrap()
                    .len(),
                RANGE_LIMIT as usize
            );
        }
        let before = reads.load(Ordering::SeqCst);
        assert!(
            read_range(session.clone(), &lease, 0, RANGE_LIMIT - 1, || false)
                .await
                .is_err()
        );
        assert_eq!(reads.load(Ordering::SeqCst), before);
        assert_eq!(opened.load(Ordering::SeqCst), 8);
        assert!(reads.load(Ordering::SeqCst) < POSTER_BUDGET as usize);
    }
    #[tokio::test]
    async fn transfer_deferral_and_cancellation_close_only_preview_handles() {
        let (lease, (session, closed, _), reads) =
            prepared(movie(RANGE_LIMIT as usize), true).await;
        let calls = AtomicUsize::new(0);
        let result = read_range(session.clone(), &lease, 0, RANGE_LIMIT - 1, || {
            calls.fetch_add(1, Ordering::SeqCst) >= 2
        })
        .await;
        assert!(matches!(result, Err(SftpError::PreviewDeferred)));
        assert!(lease.deferred.load(Ordering::Relaxed));
        assert_eq!(reads.load(Ordering::SeqCst), 16 + 32768);
        assert_eq!(closed.load(Ordering::SeqCst), 2);
        lease.token.cancel();
        assert!(matches!(
            read_range(session, &lease, 0, 1, || false).await,
            Err(SftpError::TransferCancelled)
        ));
        assert_eq!(reads.load(Ordering::SeqCst), 16 + 32768);
    }
    #[tokio::test]
    async fn invalid_or_changed_sources_close_handles_without_decoding() {
        let (connection, _) = test_session_counted(vec![0; 32], None, 0o100644, false).await;
        assert!(inspect(connection.0, &lease(false), || false)
            .await
            .is_err());
        assert_eq!(connection.1.load(Ordering::SeqCst), 1);
        let (connection, _) = test_session_counted(movie(64), None, 0o010644, false).await;
        assert!(inspect(connection.0, &lease(false), || false)
            .await
            .is_err());
        assert_eq!(connection.2.load(Ordering::SeqCst), 0);
        let (connection, _) = test_session_counted(movie(64), None, 0o100644, true).await;
        assert!(inspect(connection.0, &lease(false), || false)
            .await
            .is_err());
        assert_eq!(connection.1.load(Ordering::SeqCst), 1);
        let (lease, (session, closed, _), reads) = prepared(movie(64), false).await;
        let mut attrs = lease.metadata.get().unwrap().clone();
        attrs.mtime = Some(999);
        let changed = self::lease(false);
        changed.metadata.set(attrs).unwrap();
        assert!(read_range(session, &changed, 0, 1, || false).await.is_err());
        assert_eq!(closed.load(Ordering::SeqCst), 1);
        assert_eq!(reads.load(Ordering::SeqCst), 16);
    }
    #[test]
    fn poster_png_validation_and_http_headers_are_bounded() {
        let mut png = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(320, 180)
            .write_to(&mut png, ImageFormat::Png)
            .unwrap();
        let mut bytes = png.into_inner();
        bytes.extend_from_slice(b"not part of image");
        let clean = normalize_poster(&bytes).unwrap();
        assert!(!clean.ends_with(b"not part of image"));
        assert!(normalize_poster(b"not png").is_err());
        let mut png = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(321, 1)
            .write_to(&mut png, ImageFormat::Png)
            .unwrap();
        assert!(normalize_poster(png.get_ref()).is_err());
        let response = reply(
            206,
            "video/mp4",
            vec![1, 2],
            Some("bytes 0-1/100".into()),
            2,
        );
        assert_eq!(response.status(), 206);
        assert_eq!(response.headers()["Content-Range"], "bytes 0-1/100");
        assert_eq!(response.headers()["Cache-Control"], "no-store");
        assert_eq!(response.headers()["Access-Control-Allow-Origin"], "*");
        assert_eq!(response.headers()["Content-Length"], "2");
    }
}
