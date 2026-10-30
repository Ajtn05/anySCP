//! Read-only, bounded preview requests. These never enter the transfer queue.
use std::{
    io::Cursor,
    sync::Arc,
    time::{Duration, Instant},
};

use dashmap::DashMap;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use serde::Serialize;
use tauri::{AppHandle, Manager, State, Window};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    sync::Semaphore,
};
use tokio_util::sync::CancellationToken;

use super::{
    jpeg_thumbnail, preview_io, raw_preview,
    thumbnail_cache::{CacheKey, ThumbnailCache},
    transfer_manager::TransferManager,
};
use super::{SftpError, SftpManager};

const SOURCE_LIMIT: u64 = 32 * 1024 * 1024;
const TEXT_LIMIT: u64 = 512 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_PIXELS: u64 = 40_000_000;
const MAX_DECODE_BYTES: u64 = 128 * 1024 * 1024;
const THUMBNAIL_SOURCE_LIMIT: u64 = 8 * 1024 * 1024;
const THUMBNAIL_READ_CHUNK: usize = 128 * 1024;

struct Request {
    session_id: String,
    window: String,
    path: String,
    token: CancellationToken,
    started: bool,
    thumbnail: bool,
}

pub struct PreviewManager {
    requests: DashMap<String, Request>,
    // Includes blocking decodes: cancelling the UI cannot abort spawn_blocking.
    worker: Arc<Semaphore>,
}

impl PreviewManager {
    pub(super) fn worker(&self) -> Arc<Semaphore> {
        self.worker.clone()
    }
    pub(super) fn has_foreground(&self) -> bool {
        self.requests
            .iter()
            .any(|request| !request.thumbnail && request.started)
    }
    pub fn new() -> Self {
        Self {
            requests: DashMap::new(),
            worker: Arc::new(Semaphore::new(1)),
        }
    }

    pub fn cancel_session(&self, session_id: &str) {
        self.requests.retain(|_, request| {
            if request.session_id == session_id {
                request.token.cancel();
                false
            } else {
                true
            }
        });
    }

    pub fn cancel_thumbnails(&self, session_id: &str) {
        self.requests.retain(|_, request| {
            if request.session_id == session_id && request.thumbnail {
                request.token.cancel();
                false
            } else {
                true
            }
        });
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Image,
    Text,
    Pdf,
}

fn kind(path: &str) -> Result<Kind, SftpError> {
    let name = path.rsplit('/').next().unwrap_or(path);
    let extension = name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "jpg" | "jpeg" | "png" | "dng" | "cr2" | "nef" | "arw" => Ok(Kind::Image),
        "pdf" => Ok(Kind::Pdf),
        // Explicit text types, plus extensionless files and dotfiles.
        "txt" | "md" | "markdown" | "log" | "csv" | "tsv" | "json" | "yaml" | "yml" | "toml"
        | "ini" | "conf" | "cfg" | "xml" | "html" | "htm" | "css" | "svg" | "js" | "jsx" | "ts"
        | "tsx" | "rs" | "py" | "sh" | "bash" | "zsh" | "c" | "h" | "cpp" | "hpp" | "java"
        | "go" | "rb" | "php" | "sql" | "env" | "gitignore" | "gitconfig" | "properties"
        | "service" | "" => Ok(Kind::Text),
        _ if name.starts_with('.') => Ok(Kind::Text),
        _ => Err(error(
            "Preview is not available for this file type. Download the file to open it.",
        )),
    }
}

fn error(message: impl Into<String>) -> SftpError {
    SftpError::ProtocolError(message.into())
}

/// Register before starting I/O, so a close can cancel even a pending stat/open.
#[tauri::command]
pub fn sftp_preview_begin(
    sftp_session_id: String,
    path: String,
    thumbnail: Option<bool>,
    window: Window,
    manager: State<'_, PreviewManager>,
    sftp_manager: State<'_, Arc<SftpManager>>,
) -> Result<String, SftpError> {
    sftp_manager.get_session(&sftp_session_id)?;
    if !path.starts_with('/') || path.contains('\0') {
        return Err(SftpError::InvalidPath(path));
    }
    kind(&path)?;
    let thumbnail = thumbnail.unwrap_or(false);
    // Foreground previews take priority over background requests. A thumbnail
    // never cancels a foreground preview or a different thumbnail.
    manager.requests.retain(|_, request| {
        if request.session_id == sftp_session_id
            && request.window == window.label()
            && (!thumbnail || (request.thumbnail && request.path == path))
        {
            request.token.cancel();
            false
        } else {
            true
        }
    });
    if manager.requests.len() >= 16 {
        return Err(error(
            "Too many previews are open. Close another preview and try again.",
        ));
    }
    let id = uuid::Uuid::new_v4().to_string();
    manager.requests.insert(
        id.clone(),
        Request {
            session_id: sftp_session_id,
            path,
            window: window.label().into(),
            token: CancellationToken::new(),
            started: false,
            thumbnail,
        },
    );
    Ok(id)
}

#[tauri::command]
pub async fn sftp_thumbnail_clear(
    sftp_session_id: String,
    manager: State<'_, PreviewManager>,
    cache: State<'_, ThumbnailCache>,
    videos: State<'_, super::video_preview::VideoManager>,
    sftp_manager: State<'_, Arc<SftpManager>>,
) -> Result<(), SftpError> {
    sftp_manager.get_session(&sftp_session_id)?;
    manager.cancel_thumbnails(&sftp_session_id);
    videos.cancel_thumbnails(&sftp_session_id);
    cache.clear_session(&sftp_session_id).await;
    Ok(())
}

#[tauri::command]
pub fn sftp_preview_cancel(request_id: String, window: Window, manager: State<'_, PreviewManager>) {
    manager.requests.remove_if(&request_id, |_, request| {
        if request.window == window.label() {
            request.token.cancel();
            true
        } else {
            false
        }
    });
}

#[derive(Serialize)]
struct Metadata {
    kind: Kind,
    source_size: u64,
    truncated: bool,
}

// A little-endian JSON-header length followed by that header and raw content.
// Keeps file bytes out of JSON/base64 and carries authoritative source metadata.
fn response(kind: Kind, source_size: u64, truncated: bool, bytes: Vec<u8>) -> Vec<u8> {
    let header = serde_json::to_vec(&Metadata {
        kind,
        source_size,
        truncated,
    })
    .expect("preview metadata");
    let mut result = Vec::with_capacity(4 + header.len() + bytes.len());
    result.extend_from_slice(&(header.len() as u32).to_le_bytes());
    result.extend_from_slice(&header);
    result.extend(bytes);
    result
}

#[tauri::command]
#[tracing::instrument(skip_all, fields(%request_id, sftp_session_id = tracing::field::Empty, thumbnail = tracing::field::Empty))]
pub async fn sftp_preview_read(
    request_id: String,
    window: Window,
    manager: State<'_, PreviewManager>,
    sftp_manager: State<'_, Arc<SftpManager>>,
    transfer_manager: State<'_, Arc<TransferManager>>,
    cache: State<'_, ThumbnailCache>,
    app: AppHandle,
) -> Result<tauri::ipc::Response, SftpError> {
    let videos = app.state::<super::video_preview::VideoManager>();
    let (session_id, path, token, thumbnail) = {
        let mut request = manager
            .requests
            .get_mut(&request_id)
            .ok_or(SftpError::TransferCancelled)?;
        if request.window != window.label() || request.started {
            return Err(error("Preview request is unavailable"));
        }
        request.started = true;
        (
            request.session_id.clone(),
            request.path.clone(),
            request.token.clone(),
            request.thumbnail,
        )
    };
    tracing::Span::current().record("sftp_session_id", &session_id);
    tracing::Span::current().record("thumbnail", thumbnail);
    let started = Instant::now();
    let work = async {
        let busy =
            || sftp_manager.has_active_transfers() || transfer_manager.has_active_transfers();
        if thumbnail && (busy() || videos.has_foreground()) {
            return Err(SftpError::PreviewDeferred);
        }
        if thumbnail
            && manager
                .requests
                .iter()
                .any(|request| !request.thumbnail && request.started)
        {
            return Err(SftpError::PreviewDeferred);
        }
        let permit = if thumbnail {
            manager
                .worker
                .clone()
                .try_acquire_owned()
                .map_err(|_| SftpError::PreviewDeferred)?
        } else {
            let permit = tokio::select! {
                _ = token.cancelled() => return Err(SftpError::TransferCancelled),
                permit = manager.worker.clone().acquire_owned() => permit.map_err(|e| error(e.to_string()))?,
            };
            permit
        };
        preview_io::check(&token)?;
        let session = { sftp_manager.get_session(&session_id)?.sftp.clone() };
        if thumbnail {
            let base = app
                .path()
                .app_cache_dir()
                .map_err(|e| error(e.to_string()))?
                .join("thumbnails-v1");
            load_thumbnail(
                session,
                &session_id,
                &path,
                &token,
                permit,
                &cache,
                &base,
                busy,
            )
            .await
        } else {
            load_preview(session, &path, &token, permit).await
        }
    };
    let result = preview_io::run(
        &token,
        REQUEST_TIMEOUT,
        "Preview timed out. Try again or download the file.",
        work,
    )
    .await;
    manager.requests.remove(&request_id);
    match &result {
        Ok(bytes) => tracing::debug!(
            elapsed_ms = started.elapsed().as_millis(),
            bytes = bytes.len(),
            "Preview loaded"
        ),
        Err(SftpError::TransferCancelled | SftpError::PreviewDeferred) => tracing::debug!(
            elapsed_ms = started.elapsed().as_millis(),
            "Preview stopped"
        ),
        Err(error) => {
            tracing::warn!(elapsed_ms = started.elapsed().as_millis(), %error, "Preview failed")
        }
    }
    result.map(tauri::ipc::Response::new)
}

#[allow(clippy::too_many_arguments)]
async fn load_thumbnail(
    session: Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    session_id: &str,
    path: &str,
    token: &CancellationToken,
    permit: tokio::sync::OwnedSemaphorePermit,
    cache: &ThumbnailCache,
    base: &std::path::Path,
    busy: impl Fn() -> bool,
) -> Result<Vec<u8>, SftpError> {
    if kind(path)? != Kind::Image {
        return Err(error(
            "Thumbnails are available for JPEG, PNG, and supported RAW images",
        ));
    }
    let raw = raw_preview::supports(path);
    let jpeg = jpeg_thumbnail::supports(path);
    let permit = Arc::new(permit);
    let generation = cache.generation(session_id).await;
    let attrs = {
        let sftp = preview_io::cancel_safe(token, session.lock()).await?;
        preview_io::check(token)?;
        sftp.metadata(path)
            .await
            .map_err(|e| error(e.to_string()))?
    };
    preview_io::check(token)?;
    if attrs.file_type() != russh_sftp::protocol::FileType::File
        || attrs
            .size
            .is_none_or(|size| !raw && !jpeg && size > THUMBNAIL_SOURCE_LIMIT)
    {
        return Err(error(
            "A thumbnail is not available for this file. Use Quick Look or Download.",
        ));
    }
    let key = attrs.mtime.map(|modified| CacheKey {
        session: session_id.into(),
        path: path.into(),
        size: attrs.size.unwrap_or(0),
        modified,
        generation,
    });
    if let Some(key) = &key {
        if let Some(bytes) = cache.get(key).await {
            return Ok(bytes);
        }
    }
    if busy() {
        return Err(SftpError::PreviewDeferred);
    }
    let mut file = {
        let sftp = preview_io::cancel_safe(token, session.lock()).await?;
        preview_io::check(token)?;
        sftp.open(path).await.map_err(|e| error(e.to_string()))?
    };
    let read = async {
        preview_io::check(token)?;
        let before = file.metadata().await.map_err(|e| error(e.to_string()))?;
        preview_io::check(token)?;
        if before.file_type() != russh_sftp::protocol::FileType::File
            || before.size != attrs.size
            || before.mtime != attrs.mtime
        {
            return Err(error("The image changed before loading"));
        }
        let input = if raw {
            let jpeg = raw_preview::extract(
                &mut file,
                before.size.unwrap_or(0),
                THUMBNAIL_SOURCE_LIMIT,
                true,
                token,
                &busy,
            )
            .await?;
            ThumbnailInput::Source(jpeg.bytes, jpeg.orientation)
        } else if jpeg {
            let probe = jpeg_thumbnail::probe(
                &mut file,
                before.size.unwrap_or(0),
                token,
                &busy,
            )
            .await?;
            let ready = if let Some(embedded) = probe.embedded {
                if busy() {
                    return Err(SftpError::PreviewDeferred);
                }
                // A bad embedded image falls back to the original, within the
                // same source limit. Never make a usable JPEG lose its preview.
                render_thumbnail(embedded.bytes, embedded.orientation, permit.clone())
                    .await
                    .ok()
            } else {
                None
            };
            if let Some(bytes) = ready {
                ThumbnailInput::Ready(bytes)
            } else {
                if before.size.unwrap_or(0) > THUMBNAIL_SOURCE_LIMIT {
                    return Err(error("A thumbnail is not available for this photo. Use Quick Look or Download."));
                }
                ThumbnailInput::Source(
                    read_thumbnail_remainder(&mut file, probe.prefix, token, &busy).await?,
                    None,
                )
            }
        } else {
            ThumbnailInput::Source(read_thumbnail_source(&mut file, token, &busy).await?, None)
        };
        preview_io::check(token)?;
        let after = file.metadata().await.map_err(|e| error(e.to_string()))?;
        preview_io::check(token)?;
        if before.size != after.size
            || before.mtime != after.mtime
            || (!raw && matches!(&input, ThumbnailInput::Source(bytes, _) if bytes.len() as u64 != before.size.unwrap_or(0)))
        {
            return Err(error("The image changed while loading"));
        }
        Ok(input)
    }
    .await;
    let _ = file.shutdown().await;
    preview_io::check(token)?;
    let input = read?;
    if busy() {
        return Err(SftpError::PreviewDeferred);
    }
    let bytes = match input {
        ThumbnailInput::Ready(bytes) => {
            drop(permit);
            bytes
        }
        ThumbnailInput::Source(bytes, orientation) => {
            render_thumbnail(bytes, orientation, permit).await?
        }
    };
    if token.is_cancelled() {
        return Err(SftpError::TransferCancelled);
    }
    if let Some(key) = key {
        // A cache-write failure must not prevent displaying a valid thumbnail.
        let _ = cache.put(base, key, &bytes).await;
    }
    Ok(bytes)
}

enum ThumbnailInput {
    Source(Vec<u8>, Option<image::metadata::Orientation>),
    Ready(Vec<u8>),
}

async fn render_thumbnail(
    bytes: Vec<u8>,
    orientation: Option<image::metadata::Orientation>,
    permit: Arc<tokio::sync::OwnedSemaphorePermit>,
) -> Result<Vec<u8>, SftpError> {
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        image_preview_oriented(&bytes, 320, orientation)
    })
    .await
    .map_err(|e| error(e.to_string()))?
}

async fn read_thumbnail_source<R: AsyncRead + Unpin>(
    reader: &mut R,
    token: &CancellationToken,
    busy: &impl Fn() -> bool,
) -> Result<Vec<u8>, SftpError> {
    read_thumbnail_remainder(reader, Vec::new(), token, busy).await
}

async fn read_thumbnail_remainder<R: AsyncRead + Unpin>(
    reader: &mut R,
    mut bytes: Vec<u8>,
    token: &CancellationToken,
    busy: &impl Fn() -> bool,
) -> Result<Vec<u8>, SftpError> {
    let mut chunk = vec![0; THUMBNAIL_READ_CHUNK];
    loop {
        preview_io::check(token)?;
        if busy() {
            return Err(SftpError::PreviewDeferred);
        }
        let want = chunk
            .len()
            .min((THUMBNAIL_SOURCE_LIMIT + 1) as usize - bytes.len());
        let n = reader
            .read(&mut chunk[..want])
            .await
            .map_err(|e| error(e.to_string()))?;
        preview_io::check(token)?;
        if n == 0 {
            return Ok(bytes);
        }
        bytes.extend_from_slice(&chunk[..n]);
        if bytes.len() as u64 > THUMBNAIL_SOURCE_LIMIT {
            return Err(error("The image exceeds the automatic thumbnail limit"));
        }
    }
}

async fn load_preview(
    session: Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    path: &str,
    token: &CancellationToken,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<Vec<u8>, SftpError> {
    let file_kind = kind(path)?;
    let raw = raw_preview::supports(path);
    let permit = Arc::new(permit);
    let mut file = {
        let sftp = preview_io::cancel_safe(token, session.lock()).await?;
        preview_io::check(token)?;
        let attrs = sftp
            .metadata(path)
            .await
            .map_err(|e| error(e.to_string()))?;
        preview_io::check(token)?;
        if attrs.file_type() != russh_sftp::protocol::FileType::File {
            return Err(error("Only regular files can be previewed"));
        }
        sftp.open(path).await.map_err(|e| error(e.to_string()))?
    };
    let result = async {
        preview_io::check(token)?;
        let before = file.metadata().await.map_err(|e| error(e.to_string()))?;
        preview_io::check(token)?;
        if before.file_type() != russh_sftp::protocol::FileType::File {
            return Err(error("Only regular files can be previewed"));
        }
        let size = before
            .size
            .ok_or_else(|| error("The server did not report the file size"))?;
        let limit = if file_kind == Kind::Text {
            TEXT_LIMIT
        } else {
            SOURCE_LIMIT
        };
        if file_kind != Kind::Text && !raw && size > limit {
            return Err(error(
                "This file is too large to preview. Download it to open it.",
            ));
        }
        let (bytes, orientation) = if raw {
            let jpeg = raw_preview::extract(&mut file, size, limit, false, token, || false).await?;
            (jpeg.bytes, jpeg.orientation)
        } else {
            (read_bounded(&mut file, limit, token).await?, None)
        };
        preview_io::check(token)?;
        let after = file.metadata().await.map_err(|e| error(e.to_string()))?;
        preview_io::check(token)?;
        if before.size != after.size || before.mtime != after.mtime {
            return Err(error(
                "The file changed while loading. Open the preview again.",
            ));
        }
        let truncated = bytes.len() as u64 > limit;
        if file_kind != Kind::Text && (truncated || (!raw && bytes.len() as u64 != size)) {
            return Err(error("The file changed or exceeds the preview limit"));
        }
        let bytes = match file_kind {
            Kind::Text => text(&bytes[..bytes.len().min(limit as usize)], truncated)?.into_bytes(),
            Kind::Pdf => {
                if !bytes.starts_with(b"%PDF-") {
                    return Err(error("This file is not a PDF document"));
                }
                bytes
            }
            Kind::Image => {
                let decode_permit = permit.clone();
                return tokio::task::spawn_blocking(move || {
                    // Keep the permit until decoding finishes, even on cancellation.
                    let _permit = decode_permit;
                    image_preview_oriented(&bytes, 2048, orientation)
                        .map(|bytes| response(file_kind, size, false, bytes))
                })
                .await
                .map_err(|e| error(e.to_string()))?;
            }
        };
        Ok(response(file_kind, size, truncated, bytes))
    }
    .await;
    // Never cancel CLOSE after sending it. The library bounds its reply wait.
    let _ = file.shutdown().await;
    preview_io::check(token)?;
    result
}

async fn read_bounded<R: AsyncRead + Unpin>(
    reader: &mut R,
    limit: u64,
    token: &CancellationToken,
) -> Result<Vec<u8>, SftpError> {
    let mut bytes = Vec::new();
    let mut chunk = vec![0; 256 * 1024];
    while (bytes.len() as u64) < limit + 1 {
        preview_io::check(token)?;
        let want = chunk.len().min((limit + 1 - bytes.len() as u64) as usize);
        let n = reader
            .read(&mut chunk[..want])
            .await
            .map_err(|e| error(e.to_string()))?;
        preview_io::check(token)?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..n]);
    }
    Ok(bytes)
}

fn text(bytes: &[u8], truncated: bool) -> Result<String, SftpError> {
    let text = if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        let little = bytes[0] == 0xff;
        let words = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| {
                if little {
                    u16::from_le_bytes([b[0], b[1]])
                } else {
                    u16::from_be_bytes([b[0], b[1]])
                }
            })
            .collect::<Vec<_>>();
        String::from_utf16_lossy(&words)
    } else {
        let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
        match std::str::from_utf8(bytes) {
            Ok(text) => text.to_owned(),
            Err(e) if truncated && e.error_len().is_none() => {
                String::from_utf8_lossy(&bytes[..e.valid_up_to()]).into_owned()
            }
            Err(_) => {
                return Err(error(
                    "This file is binary or uses an unsupported text encoding",
                ))
            }
        }
    };
    if text
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t' | '\u{c}'))
    {
        return Err(error(
            "This file contains binary data and cannot be shown as text",
        ));
    }
    Ok(text)
}

fn image_preview_oriented(
    bytes: &[u8],
    edge: u32,
    orientation: Option<image::metadata::Orientation>,
) -> Result<Vec<u8>, SftpError> {
    let format =
        image::guess_format(bytes).map_err(|_| error("This image could not be decoded"))?;
    if !matches!(format, ImageFormat::Jpeg | ImageFormat::Png) {
        return Err(error("Only JPEG and PNG images are supported"));
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(20_000);
    limits.max_image_height = Some(20_000);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|e| error(e.to_string()))?;
    let (width, height) = decoder.dimensions();
    if u64::from(width) * u64::from(height) > MAX_PIXELS || decoder.total_bytes() > MAX_DECODE_BYTES
    {
        return Err(error(
            "This image is too large to decode safely. Download it to open it.",
        ));
    }
    // Container orientation wins for embedded JPEGs. Apply it exactly once;
    // the JPEG may carry the same EXIF orientation or no orientation at all.
    let orientation = match orientation {
        Some(orientation) => orientation,
        None => decoder.orientation().map_err(|e| error(e.to_string()))?,
    };
    let mut image = DynamicImage::from_decoder(decoder).map_err(|e| error(e.to_string()))?;
    image.apply_orientation(orientation);
    if image.width() > edge || image.height() > edge {
        image = image.thumbnail(edge, edge);
    }
    let mut output = Cursor::new(Vec::new());
    image
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|e| error(e.to_string()))?;
    Ok(output.into_inner())
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use russh_sftp::protocol::{
        Attrs, Data, FileAttributes, Handle, OpenFlags, Status, StatusCode,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Clone)]
    pub(in crate::sftp) struct TestGate {
        operation: &'static str,
        pub(in crate::sftp) started: CancellationToken,
        pub(in crate::sftp) resume: CancellationToken,
    }

    impl TestGate {
        pub(in crate::sftp) fn new(operation: &'static str) -> Self {
            Self {
                operation,
                started: CancellationToken::new(),
                resume: CancellationToken::new(),
            }
        }

        async fn wait(&self, operation: &str) {
            if operation == self.operation && !self.started.is_cancelled() {
                self.started.cancel();
                self.resume.cancelled().await;
            }
        }
    }

    struct TestServer {
        bytes: Vec<u8>,
        closed: Arc<AtomicUsize>,
        opened: Arc<AtomicUsize>,
        bytes_read: Arc<AtomicUsize>,
        read_requests: Arc<AtomicUsize>,
        change_after_read: bool,
        reported_size: Option<u64>,
        mode: u32,
        gate: Option<TestGate>,
    }

    impl TestServer {
        async fn wait(&self, operation: &str) {
            if let Some(gate) = &self.gate {
                gate.wait(operation).await;
            }
        }

        fn attrs(&self, id: u32) -> Attrs {
            Attrs {
                id,
                attrs: FileAttributes {
                    size: self.reported_size.or(Some(self.bytes.len() as u64)),
                    permissions: Some(self.mode),
                    mtime: Some(
                        1 + u32::from(
                            self.change_after_read && self.bytes_read.load(Ordering::SeqCst) > 0,
                        ),
                    ),
                    ..FileAttributes::empty()
                },
            }
        }
    }

    impl russh_sftp::server::Handler for TestServer {
        type Error = StatusCode;
        fn unimplemented(&self) -> StatusCode {
            StatusCode::OpUnsupported
        }
        async fn stat(&mut self, id: u32, _path: String) -> Result<Attrs, StatusCode> {
            self.wait("stat").await;
            Ok(self.attrs(id))
        }
        async fn fstat(&mut self, id: u32, _handle: String) -> Result<Attrs, StatusCode> {
            self.wait("fstat").await;
            Ok(self.attrs(id))
        }
        async fn open(
            &mut self,
            id: u32,
            filename: String,
            flags: OpenFlags,
            _attrs: FileAttributes,
        ) -> Result<Handle, StatusCode> {
            // Any create/write/truncate flag makes the test fail at the wire boundary.
            assert_eq!(flags.bits(), OpenFlags::READ.bits());
            self.opened.fetch_add(1, Ordering::SeqCst);
            self.wait("open").await;
            Ok(Handle {
                id,
                handle: filename,
            })
        }
        async fn read(
            &mut self,
            id: u32,
            _handle: String,
            offset: u64,
            len: u32,
        ) -> Result<Data, StatusCode> {
            self.read_requests.fetch_add(1, Ordering::SeqCst);
            self.wait("read").await;
            if offset >= self.bytes.len() as u64 {
                return Err(StatusCode::Eof);
            }
            let end = (offset as usize + len as usize).min(self.bytes.len());
            self.bytes_read
                .fetch_add(end - offset as usize, Ordering::SeqCst);
            Ok(Data {
                id,
                data: self.bytes[offset as usize..end].to_vec(),
            })
        }
        async fn close(&mut self, id: u32, _handle: String) -> Result<Status, StatusCode> {
            self.closed.fetch_add(1, Ordering::SeqCst);
            self.wait("close").await;
            Ok(Status {
                id,
                status_code: StatusCode::Ok,
                error_message: String::new(),
                language_tag: String::new(),
            })
        }
    }

    pub(in crate::sftp) type TestConnection = (
        Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
        Arc<AtomicUsize>,
        Arc<AtomicUsize>,
    );

    async fn test_session(bytes: Vec<u8>, reported_size: Option<u64>, mode: u32) -> TestConnection {
        test_session_counted(bytes, reported_size, mode, false)
            .await
            .0
    }

    pub(in crate::sftp) async fn test_session_counted(
        bytes: Vec<u8>,
        reported_size: Option<u64>,
        mode: u32,
        change_after_read: bool,
    ) -> (TestConnection, Arc<AtomicUsize>) {
        let (connection, bytes_read, _) =
            test_session_stats(bytes, reported_size, mode, change_after_read).await;
        (connection, bytes_read)
    }

    async fn test_session_stats(
        bytes: Vec<u8>,
        reported_size: Option<u64>,
        mode: u32,
        change_after_read: bool,
    ) -> (TestConnection, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        test_session_stats_with_gate(bytes, reported_size, mode, change_after_read, None).await
    }

    pub(in crate::sftp) async fn test_session_gated(
        bytes: Vec<u8>,
        gate: TestGate,
    ) -> (TestConnection, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        test_session_stats_with_gate(bytes, None, 0o100644, false, Some(gate)).await
    }

    async fn test_session_stats_with_gate(
        bytes: Vec<u8>,
        reported_size: Option<u64>,
        mode: u32,
        change_after_read: bool,
        gate: Option<TestGate>,
    ) -> (TestConnection, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let (client, server) = tokio::io::duplex(1024 * 1024);
        let closed = Arc::new(AtomicUsize::new(0));
        let opened = Arc::new(AtomicUsize::new(0));
        let bytes_read = Arc::new(AtomicUsize::new(0));
        let read_requests = Arc::new(AtomicUsize::new(0));
        tokio::spawn(russh_sftp::server::run(
            server,
            TestServer {
                bytes,
                reported_size,
                mode,
                closed: closed.clone(),
                opened: opened.clone(),
                bytes_read: bytes_read.clone(),
                read_requests: read_requests.clone(),
                change_after_read,
                gate,
            },
        ));
        let session = russh_sftp::client::SftpSession::new(client).await.unwrap();
        (
            (Arc::new(tokio::sync::Mutex::new(session)), closed, opened),
            bytes_read,
            read_requests,
        )
    }

    async fn permit() -> tokio::sync::OwnedSemaphorePermit {
        Arc::new(Semaphore::new(1)).acquire_owned().await.unwrap()
    }

    pub(in crate::sftp) struct ReplyWarnings(pub(in crate::sftp) Arc<AtomicUsize>);

    impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for ReplyWarnings {
        fn on_event(
            &self,
            event: &tracing::Event<'_>,
            _context: tracing_subscriber::layer::Context<'_, S>,
        ) {
            if event.metadata().target() == "russh_sftp::client"
                && *event.metadata().level() == tracing::Level::WARN
            {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
    }

    #[tokio::test]
    async fn cancelled_previews_drain_replies_close_handles_and_keep_the_worker_until_cleanup() {
        use tracing_subscriber::prelude::*;
        let warnings = Arc::new(AtomicUsize::new(0));
        let _subscriber = tracing::subscriber::set_default(
            tracing_subscriber::registry().with(ReplyWarnings(warnings.clone())),
        );
        let source = encoded_jpeg(80, 40);
        for thumbnail in [true, false] {
            for operation in ["stat", "open", "fstat", "read", "close"] {
                let gate = TestGate::new(operation);
                let ((session, closed, opened), _, reads) =
                    test_session_gated(source.clone(), gate.clone()).await;
                let worker = Arc::new(Semaphore::new(1));
                let token = CancellationToken::new();
                let directory = tempfile::tempdir().unwrap();
                let cache = ThumbnailCache::new();
                let work = async {
                    let permit = worker.clone().acquire_owned().await.unwrap();
                    if thumbnail {
                        load_thumbnail(
                            session.clone(),
                            "cancel",
                            "/image.jpg",
                            &token,
                            permit,
                            &cache,
                            directory.path(),
                            || false,
                        )
                        .await
                    } else {
                        load_preview(session.clone(), "/image.jpg", &token, permit).await
                    }
                };
                let cancel = async {
                    gate.started.cancelled().await;
                    token.cancel();
                    tokio::task::yield_now().await;
                    // The next preview cannot overtake a response or CLOSE.
                    assert!(worker.clone().try_acquire_owned().is_err());
                    gate.resume.cancel();
                };
                let (result, ()) = tokio::join!(
                    preview_io::run(&token, REQUEST_TIMEOUT, "timed out", work),
                    cancel,
                );
                assert!(
                    matches!(result, Err(SftpError::TransferCancelled)),
                    "{operation}"
                );
                assert_eq!(
                    closed.load(Ordering::SeqCst),
                    opened.load(Ordering::SeqCst),
                    "{operation}"
                );
                if operation == "stat" {
                    assert_eq!(opened.load(Ordering::SeqCst), 0);
                }
                if operation == "read" {
                    assert_eq!(reads.load(Ordering::SeqCst), 1);
                }
                assert!(worker.clone().try_acquire_owned().is_ok());
                assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);

                let mut file = session.lock().await.open("/image.jpg").await.unwrap();
                let mut original = Vec::new();
                file.read_to_end(&mut original).await.unwrap();
                file.shutdown().await.unwrap();
                assert_eq!(original, source);
            }
        }
        assert_eq!(warnings.load(Ordering::SeqCst), 0);
    }

    fn encoded_jpeg(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(width, height)
            .write_to(&mut bytes, ImageFormat::Jpeg)
            .unwrap();
        bytes.into_inner()
    }

    #[tokio::test]
    async fn camera_jpeg_thumbnail_reads_only_a_header_and_keeps_original_download_intact() {
        let main = encoded_jpeg(800, 400);
        let thumbnail = encoded_jpeg(160, 80);
        let mut source = jpeg_thumbnail::tests::with_thumbnail(&main, &thumbnail, true);
        source.resize(10 * 1024 * 1024, 0);
        let ((session, closed, opened), reads, requests) =
            test_session_stats(source.clone(), None, 0o100644, false).await;
        let directory = tempfile::tempdir().unwrap();
        let cache = ThumbnailCache::new();
        let token = CancellationToken::new();
        let first = load_thumbnail(
            session.clone(),
            "s",
            "/camera.JPG",
            &token,
            permit().await,
            &cache,
            directory.path(),
            || false,
        )
        .await
        .unwrap();
        let image = image::load_from_memory(&first).unwrap();
        assert_eq!((image.width(), image.height()), (80, 160));
        assert_eq!(reads.load(Ordering::SeqCst), 32 * 1024);
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        assert_eq!(closed.load(Ordering::SeqCst), 1);
        assert_eq!(opened.load(Ordering::SeqCst), 1);
        let second = load_thumbnail(
            session.clone(),
            "s",
            "/camera.JPG",
            &token,
            permit().await,
            &cache,
            directory.path(),
            || false,
        )
        .await
        .unwrap();
        assert_eq!(first, second);
        assert_eq!(reads.load(Ordering::SeqCst), 32 * 1024);
        assert_eq!(opened.load(Ordering::SeqCst), 1);
        let mut file = session.lock().await.open("/camera.JPG").await.unwrap();
        let mut downloaded = Vec::new();
        file.read_to_end(&mut downloaded).await.unwrap();
        file.shutdown().await.unwrap();
        assert_eq!(downloaded, source);
    }

    #[tokio::test]
    async fn jpeg_fallback_reuses_header_bytes_and_requests_larger_chunks() {
        let mut source = encoded_jpeg(800, 400);
        source.resize(2 * 1024 * 1024, 0);
        let ((session, closed, _), reads, requests) =
            test_session_stats(source.clone(), None, 0o100644, false).await;
        let directory = tempfile::tempdir().unwrap();
        let bytes = load_thumbnail(
            session,
            "s",
            "/photo.jpg",
            &CancellationToken::new(),
            permit().await,
            &ThumbnailCache::new(),
            directory.path(),
            || false,
        )
        .await
        .unwrap();
        let image = image::load_from_memory(&bytes).unwrap();
        assert_eq!((image.width(), image.height()), (320, 160));
        // Previously 64 data requests plus EOF; now one header, 16 remainder
        // requests, and EOF. The header is never downloaded twice.
        assert_eq!(reads.load(Ordering::SeqCst), source.len());
        assert_eq!(requests.load(Ordering::SeqCst), 18);
        assert_eq!(closed.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn corrupt_embedded_jpegs_fall_back_and_changed_photos_never_enter_cache() {
        let main = encoded_jpeg(800, 400);
        let corrupt = jpeg_thumbnail::tests::with_thumbnail(&main, &[0xff, 0xd8, 0xff, 1], false);
        let ((session, closed, _), reads) =
            test_session_counted(corrupt.clone(), None, 0o100644, false).await;
        let directory = tempfile::tempdir().unwrap();
        let bytes = load_thumbnail(
            session,
            "s",
            "/photo.jpeg",
            &CancellationToken::new(),
            permit().await,
            &ThumbnailCache::new(),
            directory.path(),
            || false,
        )
        .await
        .unwrap();
        let image = image::load_from_memory(&bytes).unwrap();
        assert_eq!((image.width(), image.height()), (160, 320));
        assert_eq!(reads.load(Ordering::SeqCst), corrupt.len());
        assert_eq!(closed.load(Ordering::SeqCst), 1);

        let source = jpeg_thumbnail::tests::with_thumbnail(&main, &encoded_jpeg(160, 80), true);
        let ((session, closed, _), _) = test_session_counted(source, None, 0o100644, true).await;
        let directory = tempfile::tempdir().unwrap();
        let result = load_thumbnail(
            session,
            "s",
            "/changed.jpeg",
            &CancellationToken::new(),
            permit().await,
            &ThumbnailCache::new(),
            directory.path(),
            || false,
        )
        .await;
        assert!(
            matches!(result, Err(SftpError::ProtocolError(message)) if message.contains("changed while loading"))
        );
        assert_eq!(closed.load(Ordering::SeqCst), 1);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn large_jpegs_without_embedded_previews_do_not_trigger_full_downloads() {
        let mut source = encoded_jpeg(800, 400);
        source.resize(64 * 1024, 0);
        let ((session, closed, _), reads) =
            test_session_counted(source, Some(64 * 1024 * 1024), 0o100644, false).await;
        let directory = tempfile::tempdir().unwrap();
        assert!(load_thumbnail(
            session,
            "s",
            "/large.jpg",
            &CancellationToken::new(),
            permit().await,
            &ThumbnailCache::new(),
            directory.path(),
            || false
        )
        .await
        .is_err());
        assert_eq!(reads.load(Ordering::SeqCst), 32 * 1024);
        assert_eq!(closed.load(Ordering::SeqCst), 1);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn preview_is_read_only_closes_its_handle_and_keeps_session_usable() {
        let source = b"server contents".to_vec();
        let (session, closed, opened) = test_session(source.clone(), None, 0o100644).await;
        let result = load_preview(
            session.clone(),
            "/notes.txt",
            &CancellationToken::new(),
            permit().await,
        )
        .await
        .unwrap();
        let header_len = u32::from_le_bytes(result[..4].try_into().unwrap()) as usize;
        assert_eq!(&result[4 + header_len..], source);
        assert_eq!(closed.load(Ordering::SeqCst), 1);
        assert_eq!(opened.load(Ordering::SeqCst), 1);
        // A subsequent transfer can still read the same bytes on this session.
        let mut file = session.lock().await.open("/notes.txt").await.unwrap();
        let mut downloaded = Vec::new();
        file.read_to_end(&mut downloaded).await.unwrap();
        file.shutdown().await.unwrap();
        assert_eq!(downloaded, source);
    }

    #[tokio::test]
    async fn large_raw_preview_reads_ranges_then_original_download_still_matches() {
        let mut jpeg = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(10, 20)
            .write_to(&mut jpeg, ImageFormat::Jpeg)
            .unwrap();
        let source = raw_preview::tests::fixture(jpeg.get_ref(), true, true);
        let ((session, closed, opened), bytes_read) =
            test_session_counted(source.clone(), Some(256 * 1024 * 1024), 0o100644, false).await;
        let result = load_preview(
            session.clone(),
            "/camera.CR2",
            &CancellationToken::new(),
            permit().await,
        )
        .await
        .unwrap();
        let header_len = u32::from_le_bytes(result[..4].try_into().unwrap()) as usize;
        let metadata: serde_json::Value =
            serde_json::from_slice(&result[4..4 + header_len]).unwrap();
        assert_eq!(metadata["kind"], "image");
        assert_eq!(metadata["source_size"], 256 * 1024 * 1024);
        assert_eq!(metadata["truncated"], false);
        let image = image::load_from_memory(&result[4 + header_len..]).unwrap();
        assert_eq!((image.width(), image.height()), (20, 10));
        assert!(bytes_read.load(Ordering::SeqCst) < jpeg.get_ref().len() + 256);
        assert_eq!(closed.load(Ordering::SeqCst), 1);
        assert_eq!(opened.load(Ordering::SeqCst), 1);
        let mut file = session.lock().await.open("/camera.CR2").await.unwrap();
        let mut downloaded = Vec::new();
        file.read_to_end(&mut downloaded).await.unwrap();
        file.shutdown().await.unwrap();
        assert_eq!(downloaded, source);
    }

    #[tokio::test]
    async fn raw_thumbnails_cache_only_the_rendered_jpeg_and_close_on_failure() {
        let mut jpeg = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(800, 400)
            .write_to(&mut jpeg, ImageFormat::Jpeg)
            .unwrap();
        let source = raw_preview::tests::fixture(jpeg.get_ref(), false, false);
        let ((session, closed, opened), bytes_read) =
            test_session_counted(source, Some(256 * 1024 * 1024), 0o100644, false).await;
        let directory = tempfile::tempdir().unwrap();
        let cache = ThumbnailCache::new();
        let token = CancellationToken::new();
        let first = load_thumbnail(
            session.clone(),
            "raw",
            "/camera.nef",
            &token,
            permit().await,
            &cache,
            directory.path(),
            || false,
        )
        .await
        .unwrap();
        let image = image::load_from_memory(&first).unwrap();
        assert_eq!((image.width(), image.height()), (160, 320));
        let read = bytes_read.load(Ordering::SeqCst);
        assert!(read < jpeg.get_ref().len() + 256);
        let second = load_thumbnail(
            session,
            "raw",
            "/camera.nef",
            &token,
            permit().await,
            &cache,
            directory.path(),
            || false,
        )
        .await
        .unwrap();
        assert_eq!(first, second);
        assert_eq!(bytes_read.load(Ordering::SeqCst), read);
        assert_eq!(closed.load(Ordering::SeqCst), 1);
        assert_eq!(opened.load(Ordering::SeqCst), 1);
        let (session, closed, _) =
            test_session(b"invalid raw container".to_vec(), None, 0o100644).await;
        assert!(load_preview(session, "/bad.arw", &token, permit().await)
            .await
            .is_err());
        assert_eq!(closed.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn raw_metadata_changes_are_rejected_before_decoding_or_caching() {
        let source = raw_preview::tests::fixture(&[0xff, 0xd8, 0xff, 1], true, false);
        let ((session, closed, _), _) = test_session_counted(source, None, 0o100644, true).await;
        let result = load_preview(
            session.clone(),
            "/changed.dng",
            &CancellationToken::new(),
            permit().await,
        )
        .await;
        assert!(
            matches!(result, Err(SftpError::ProtocolError(message)) if message.contains("changed while loading"))
        );
        assert_eq!(closed.load(Ordering::SeqCst), 1);
        let directory = tempfile::tempdir().unwrap();
        let cache = ThumbnailCache::new();
        let source = raw_preview::tests::fixture(&[0xff, 0xd8, 0xff, 1], false, true);
        let ((session, closed, _), _) = test_session_counted(source, None, 0o100644, true).await;
        let result = load_thumbnail(
            session,
            "s",
            "/changed.dng",
            &CancellationToken::new(),
            permit().await,
            &cache,
            directory.path(),
            || false,
        )
        .await;
        assert!(
            matches!(result, Err(SftpError::ProtocolError(message)) if message.contains("changed while loading"))
        );
        assert_eq!(closed.load(Ordering::SeqCst), 1);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    /// Optional compatibility gate for locally supplied camera originals.
    /// Keep large photos and their licensing outside the repository.
    #[tokio::test]
    #[ignore = "Set ANYSCP_RAW_SAMPLES to a directory of camera DNG/CR2/NEF/ARW originals"]
    async fn local_camera_samples() {
        let directory = std::env::var("ANYSCP_RAW_SAMPLES").expect("ANYSCP_RAW_SAMPLES directory");
        let mut count = 0;
        for entry in std::fs::read_dir(directory).unwrap() {
            let entry = entry.unwrap();
            let name = entry.file_name().to_string_lossy().into_owned();
            if !entry.file_type().unwrap().is_file() || !raw_preview::supports(&name) {
                continue;
            }
            let source = std::fs::read(entry.path()).unwrap();
            let size = source.len();
            let path = format!("/{name}");
            let ((session, closed, _), reads) =
                test_session_counted(source, None, 0o100644, false).await;
            let token = CancellationToken::new();
            let result = load_preview(session.clone(), &path, &token, permit().await)
                .await
                .expect(&name);
            let header_len = u32::from_le_bytes(result[..4].try_into().unwrap()) as usize;
            let image = image::load_from_memory(&result[4 + header_len..]).unwrap();
            assert!(image.width() <= 2048 && image.height() <= 2048);
            let preview_reads = reads.load(Ordering::SeqCst);
            assert!(preview_reads <= SOURCE_LIMIT as usize + 256 * 1024);
            let temp = tempfile::tempdir().unwrap();
            let result = load_thumbnail(
                session,
                "camera",
                &path,
                &token,
                permit().await,
                &ThumbnailCache::new(),
                temp.path(),
                || false,
            )
            .await
            .expect(&name);
            let thumbnail = image::load_from_memory(&result).unwrap();
            assert!(thumbnail.width() <= 320 && thumbnail.height() <= 320);
            let thumbnail_reads = reads.load(Ordering::SeqCst) - preview_reads;
            assert!(thumbnail_reads <= THUMBNAIL_SOURCE_LIMIT as usize + 256 * 1024);
            assert_eq!(closed.load(Ordering::SeqCst), 2);
            println!("{name}: source={size}, Quick Look reads={preview_reads} ({}x{}), thumbnail reads={thumbnail_reads} ({}x{})", image.width(), image.height(), thumbnail.width(), thumbnail.height());
            count += 1;
        }
        assert!(count > 0, "No supported camera files found");
    }

    #[tokio::test]
    async fn oversized_sources_and_special_files_do_not_get_read() {
        let (session, closed, _) =
            test_session(b"not fetched".to_vec(), Some(SOURCE_LIMIT + 1), 0o100644).await;
        assert!(load_preview(
            session,
            "/photo.jpg",
            &CancellationToken::new(),
            permit().await
        )
        .await
        .is_err());
        assert_eq!(closed.load(Ordering::SeqCst), 1);
        let (session, _, opened) = test_session(Vec::new(), None, 0o010644).await;
        assert!(load_preview(
            session,
            "/pipe.txt",
            &CancellationToken::new(),
            permit().await
        )
        .await
        .is_err());
        assert_eq!(opened.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn text_prefix_reports_truncation_with_authoritative_size() {
        let (session, _, _) =
            test_session(vec![b'a'; TEXT_LIMIT as usize + 100], None, 0o100644).await;
        let result = load_preview(
            session,
            "/large.log",
            &CancellationToken::new(),
            permit().await,
        )
        .await
        .unwrap();
        let header_len = u32::from_le_bytes(result[..4].try_into().unwrap()) as usize;
        let metadata: serde_json::Value =
            serde_json::from_slice(&result[4..4 + header_len]).unwrap();
        assert_eq!(metadata["source_size"], TEXT_LIMIT + 100);
        assert_eq!(metadata["truncated"], true);
        assert_eq!(result.len() - 4 - header_len, TEXT_LIMIT as usize);
    }

    #[tokio::test]
    async fn thumbnails_reuse_disk_bytes_after_metadata_validation_and_clear_refetches() {
        let mut encoded = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(800, 400)
            .write_to(&mut encoded, ImageFormat::Png)
            .unwrap();
        let (session, _, opened) = test_session(encoded.into_inner(), None, 0o100644).await;
        let directory = tempfile::tempdir().unwrap();
        let cache = ThumbnailCache::new();
        let token = CancellationToken::new();
        let first = load_thumbnail(
            session.clone(),
            "s",
            "/image.png",
            &token,
            permit().await,
            &cache,
            directory.path(),
            || false,
        )
        .await
        .unwrap();
        let image = image::load_from_memory(&first).unwrap();
        assert_eq!((image.width(), image.height()), (320, 160));
        let second = load_thumbnail(
            session.clone(),
            "s",
            "/image.png",
            &token,
            permit().await,
            &cache,
            directory.path(),
            || false,
        )
        .await
        .unwrap();
        assert_eq!(first, second);
        assert_eq!(opened.load(Ordering::SeqCst), 1);
        cache.clear_session("s").await;
        load_thumbnail(
            session,
            "s",
            "/image.png",
            &token,
            permit().await,
            &cache,
            directory.path(),
            || false,
        )
        .await
        .unwrap();
        assert_eq!(opened.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn automatic_thumbnail_budget_rejects_large_sources_before_open() {
        let (session, _, opened) =
            test_session(vec![], Some(THUMBNAIL_SOURCE_LIMIT + 1), 0o100644).await;
        let directory = tempfile::tempdir().unwrap();
        assert!(load_thumbnail(
            session,
            "s",
            "/image.png",
            &CancellationToken::new(),
            permit().await,
            &ThumbnailCache::new(),
            directory.path(),
            || false
        )
        .await
        .is_err());
        assert_eq!(opened.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn background_reads_yield_at_the_next_chunk_when_a_transfer_starts() {
        let source = vec![1; THUMBNAIL_READ_CHUNK * 2];
        let mut reader = source.as_slice();
        let calls = AtomicUsize::new(0);
        let result = read_thumbnail_source(&mut reader, &CancellationToken::new(), &|| {
            calls.fetch_add(1, Ordering::SeqCst) >= 1
        })
        .await;
        assert!(matches!(result, Err(SftpError::PreviewDeferred)));
        assert_eq!(reader.len(), source.len() - THUMBNAIL_READ_CHUNK);
    }

    #[test]
    fn invalidating_thumbnails_does_not_cancel_quick_look() {
        let manager = PreviewManager::new();
        let foreground = CancellationToken::new();
        let background = CancellationToken::new();
        for (id, thumbnail, token) in [
            ("a", false, foreground.clone()),
            ("b", true, background.clone()),
        ] {
            manager.requests.insert(
                id.into(),
                Request {
                    session_id: "s".into(),
                    window: "main".into(),
                    path: "/image.png".into(),
                    token,
                    started: false,
                    thumbnail,
                },
            );
        }
        manager.cancel_thumbnails("s");
        assert!(!foreground.is_cancelled());
        assert!(background.is_cancelled());
    }

    #[tokio::test]
    async fn reads_at_most_limit_plus_one_without_changing_source() {
        let source = b"abcdef";
        let mut reader = &source[..];
        assert_eq!(
            read_bounded(&mut reader, 3, &CancellationToken::new())
                .await
                .unwrap(),
            b"abcd"
        );
        assert_eq!(reader, b"ef");
        assert_eq!(source, b"abcdef");
    }

    #[tokio::test]
    async fn cancellation_drains_the_pending_chunk_before_stopping() {
        let (mut reader, mut writer) = tokio::io::duplex(64);
        let token = CancellationToken::new();
        let read = read_bounded(&mut reader, 100, &token);
        let cancel = async {
            tokio::task::yield_now().await;
            token.cancel();
            writer.write_all(b"pending reply").await.unwrap();
        };
        let (result, ()) = tokio::join!(read, cancel);
        assert!(matches!(result, Err(SftpError::TransferCancelled)));
    }

    #[test]
    fn text_is_bounded_encoding_aware_and_rejects_binary() {
        assert_eq!(text(b"\xef\xbb\xbfhello", false).unwrap(), "hello");
        assert_eq!(text(&[0xff, 0xfe, b'h', 0, b'i', 0], false).unwrap(), "hi");
        assert_eq!(text(&[b'a', 0xe2, 0x82], true).unwrap(), "a");
        assert!(text(b"a\0b", false).is_err());
        assert!(text(&[0xff, 0x00], false).is_err());
        assert_eq!(
            text(b"<script>alert(1)</script>", false).unwrap(),
            "<script>alert(1)</script>"
        );
    }

    #[test]
    fn supported_types_do_not_include_archives_or_video() {
        assert_eq!(kind("/photo.JPEG").unwrap(), Kind::Image);
        assert_eq!(kind("/file.pdf").unwrap(), Kind::Pdf);
        assert_eq!(kind("/.env.local").unwrap(), Kind::Text);
        assert_eq!(kind("/résumé.txt").unwrap(), Kind::Text);
        assert_eq!(kind("/.bashrc").unwrap(), Kind::Text);
        assert!(kind("/file.zip").is_err());
        assert!(kind("/file.mov").is_err());
        for extension in ["DNG", "CR2", "NEF", "ARW"] {
            let path = format!("/camera.{extension}");
            assert_eq!(kind(&path).unwrap(), Kind::Image);
            assert!(raw_preview::supports(&path));
        }
        for extension in ["CR3", "RAF", "ORF", "raw", "tiff"] {
            let path = format!("/camera.{extension}");
            assert!(kind(&path).is_err());
            assert!(!raw_preview::supports(&path));
        }
    }

    #[test]
    fn image_preview_preserves_transparency_and_bounds_dimensions() {
        let image = DynamicImage::new_rgba8(2500, 2);
        let mut encoded = Cursor::new(Vec::new());
        image.write_to(&mut encoded, ImageFormat::Png).unwrap();
        let preview = image::load_from_memory(
            &image_preview_oriented(encoded.get_ref(), 2048, None).unwrap(),
        )
        .unwrap();
        assert_eq!(preview.width(), 2048);
        assert_eq!(preview.to_rgba8().get_pixel(0, 0).0[3], 0);
        assert!(image_preview_oriented(b"invalid", 2048, None).is_err());
    }

    #[test]
    fn jpeg_preview_applies_exif_orientation() {
        let image = DynamicImage::new_rgb8(10, 20);
        let mut jpeg = Cursor::new(Vec::new());
        image.write_to(&mut jpeg, ImageFormat::Jpeg).unwrap();
        // EXIF little-endian IFD with Orientation=6 (90 degrees clockwise).
        let exif = b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0";
        let mut oriented = vec![0xff, 0xd8, 0xff, 0xe1];
        oriented.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
        oriented.extend_from_slice(exif);
        oriented.extend_from_slice(&jpeg.get_ref()[2..]);
        let result =
            image::load_from_memory(&image_preview_oriented(&oriented, 2048, None).unwrap())
                .unwrap();
        assert_eq!((result.width(), result.height()), (20, 10));
        let result = image::load_from_memory(
            &image_preview_oriented(
                &oriented,
                2048,
                Some(image::metadata::Orientation::Rotate90),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!((result.width(), result.height()), (20, 10));
    }

    #[test]
    fn closing_a_session_only_cancels_its_preview_tokens() {
        let manager = PreviewManager::new();
        let first = CancellationToken::new();
        let other = CancellationToken::new();
        for (id, session_id, token) in [("a", "one", first.clone()), ("b", "two", other.clone())] {
            manager.requests.insert(
                id.into(),
                Request {
                    session_id: session_id.into(),
                    window: "main".into(),
                    path: "/file.txt".into(),
                    token,
                    started: false,
                    thumbnail: false,
                },
            );
        }
        manager.cancel_session("one");
        assert!(first.is_cancelled());
        assert!(!other.is_cancelled());
        assert_eq!(manager.requests.len(), 1);
    }

    #[test]
    fn binary_response_has_metadata_and_unmodified_payload() {
        let bytes = response(Kind::Pdf, 10, false, b"%PDF-abc".to_vec());
        let size = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
        let metadata: serde_json::Value = serde_json::from_slice(&bytes[4..4 + size]).unwrap();
        assert_eq!(metadata["source_size"], 10);
        assert_eq!(&bytes[4 + size..], b"%PDF-abc");
    }
}
