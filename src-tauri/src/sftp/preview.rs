//! Read-only, bounded preview requests. These never enter the transfer queue.
use std::{io::Cursor, sync::Arc, time::Duration};

use dashmap::DashMap;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use serde::Serialize;
use tauri::{State, Window};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    sync::Semaphore,
};
use tokio_util::sync::CancellationToken;

use super::{SftpError, SftpManager};

const SOURCE_LIMIT: u64 = 32 * 1024 * 1024;
const TEXT_LIMIT: u64 = 512 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_PIXELS: u64 = 40_000_000;
const MAX_DECODE_BYTES: u64 = 128 * 1024 * 1024;

struct Request {
    session_id: String,
    window: String,
    path: String,
    token: CancellationToken,
    started: bool,
}

pub struct PreviewManager {
    requests: DashMap<String, Request>,
    // Includes blocking decodes: cancelling the UI cannot abort spawn_blocking.
    worker: Arc<Semaphore>,
}

impl PreviewManager {
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
        "jpg" | "jpeg" | "png" => Ok(Kind::Image),
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
    window: Window,
    manager: State<'_, PreviewManager>,
    sftp_manager: State<'_, Arc<SftpManager>>,
) -> Result<String, SftpError> {
    sftp_manager.get_session(&sftp_session_id)?;
    if !path.starts_with('/') || path.contains('\0') {
        return Err(SftpError::InvalidPath(path));
    }
    kind(&path)?;
    if manager.requests.len() >= 16 {
        return Err(error(
            "Too many previews are open. Close another preview and try again.",
        ));
    }
    // One request per window/session. Replacing a selection cancels old I/O.
    manager.requests.retain(|_, request| {
        if request.session_id == sftp_session_id && request.window == window.label() {
            request.token.cancel();
            false
        } else {
            true
        }
    });
    let id = uuid::Uuid::new_v4().to_string();
    manager.requests.insert(
        id.clone(),
        Request {
            session_id: sftp_session_id,
            path,
            window: window.label().into(),
            token: CancellationToken::new(),
            started: false,
        },
    );
    Ok(id)
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
pub async fn sftp_preview_read(
    request_id: String,
    window: Window,
    manager: State<'_, PreviewManager>,
    sftp_manager: State<'_, Arc<SftpManager>>,
) -> Result<tauri::ipc::Response, SftpError> {
    let (session_id, path, token) = {
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
        )
    };
    let work = async {
        let permit = tokio::select! {
            _ = token.cancelled() => return Err(SftpError::TransferCancelled),
            permit = manager.worker.clone().acquire_owned() => permit.map_err(|e| error(e.to_string()))?,
        };
        let session = { sftp_manager.get_session(&session_id)?.sftp.clone() };
        load_preview(session, &path, &token, permit).await
    };
    let result = tokio::select! {
        _ = token.cancelled() => Err(SftpError::TransferCancelled),
        result = tokio::time::timeout(REQUEST_TIMEOUT, work) =>
            result.unwrap_or_else(|_| Err(error("Preview timed out. Try again or download the file."))),
    };
    manager.requests.remove(&request_id);
    result.map(tauri::ipc::Response::new)
}

async fn load_preview(
    session: Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    path: &str,
    token: &CancellationToken,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<Vec<u8>, SftpError> {
    let file_kind = kind(path)?;
    let mut file = {
        let sftp = session.lock().await;
        let attrs = sftp
            .metadata(path)
            .await
            .map_err(|e| error(e.to_string()))?;
        if attrs.file_type() != russh_sftp::protocol::FileType::File {
            return Err(error("Only regular files can be previewed"));
        }
        sftp.open(path).await.map_err(|e| error(e.to_string()))?
    };
    let result = async {
        let before = file.metadata().await.map_err(|e| error(e.to_string()))?;
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
        if file_kind != Kind::Text && size > limit {
            return Err(error(
                "This file exceeds the 32 MiB preview limit. Download it to open it.",
            ));
        }
        let bytes = read_bounded(&mut file, limit, token).await?;
        let after = file.metadata().await.map_err(|e| error(e.to_string()))?;
        if before.size != after.size || before.mtime != after.mtime {
            return Err(error(
                "The file changed while loading. Open the preview again.",
            ));
        }
        let truncated = bytes.len() as u64 > limit;
        if file_kind != Kind::Text && (truncated || bytes.len() as u64 != size) {
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
                return tokio::task::spawn_blocking(move || {
                    // Keep the permit until decoding finishes, even on cancellation.
                    let _permit = permit;
                    image_preview(&bytes).map(|bytes| response(file_kind, size, false, bytes))
                })
                .await
                .map_err(|e| error(e.to_string()))?;
            }
        };
        Ok(response(file_kind, size, truncated, bytes))
    }
    .await;
    // Explicitly close even on limit/decode errors. The outer deadline also
    // bounds close; File's Drop remains the last-resort cleanup.
    let _ = file.shutdown().await;
    result
}

async fn read_bounded<R: AsyncRead + Unpin>(
    reader: &mut R,
    limit: u64,
    token: &CancellationToken,
) -> Result<Vec<u8>, SftpError> {
    let mut bytes = Vec::new();
    let mut reader = reader.take(limit + 1);
    tokio::select! {
        _ = token.cancelled() => Err(SftpError::TransferCancelled),
        result = reader.read_to_end(&mut bytes) => {
            result.map_err(|e| error(e.to_string()))?;
            Ok(bytes)
        }
    }
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

fn image_preview(bytes: &[u8]) -> Result<Vec<u8>, SftpError> {
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
    let orientation = decoder.orientation().map_err(|e| error(e.to_string()))?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(|e| error(e.to_string()))?;
    image.apply_orientation(orientation);
    if image.width() > 2048 || image.height() > 2048 {
        image = image.thumbnail(2048, 2048);
    }
    let mut output = Cursor::new(Vec::new());
    image
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|e| error(e.to_string()))?;
    Ok(output.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh_sftp::protocol::{
        Attrs, Data, FileAttributes, Handle, OpenFlags, Status, StatusCode,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TestServer {
        bytes: Vec<u8>,
        closed: Arc<AtomicUsize>,
        opened: Arc<AtomicUsize>,
        reported_size: Option<u64>,
        mode: u32,
    }

    impl TestServer {
        fn attrs(&self, id: u32) -> Attrs {
            Attrs {
                id,
                attrs: FileAttributes {
                    size: self.reported_size.or(Some(self.bytes.len() as u64)),
                    permissions: Some(self.mode),
                    mtime: Some(1),
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
            Ok(self.attrs(id))
        }
        async fn fstat(&mut self, id: u32, _handle: String) -> Result<Attrs, StatusCode> {
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
            if offset >= self.bytes.len() as u64 {
                return Err(StatusCode::Eof);
            }
            Ok(Data {
                id,
                data: self.bytes
                    [offset as usize..(offset as usize + len as usize).min(self.bytes.len())]
                    .to_vec(),
            })
        }
        async fn close(&mut self, id: u32, _handle: String) -> Result<Status, StatusCode> {
            self.closed.fetch_add(1, Ordering::SeqCst);
            Ok(Status {
                id,
                status_code: StatusCode::Ok,
                error_message: String::new(),
                language_tag: String::new(),
            })
        }
    }

    async fn test_session(
        bytes: Vec<u8>,
        reported_size: Option<u64>,
        mode: u32,
    ) -> (
        Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
        Arc<AtomicUsize>,
        Arc<AtomicUsize>,
    ) {
        let (client, server) = tokio::io::duplex(1024 * 1024);
        let closed = Arc::new(AtomicUsize::new(0));
        let opened = Arc::new(AtomicUsize::new(0));
        tokio::spawn(russh_sftp::server::run(
            server,
            TestServer {
                bytes,
                reported_size,
                mode,
                closed: closed.clone(),
                opened: opened.clone(),
            },
        ));
        let session = russh_sftp::client::SftpSession::new(client).await.unwrap();
        (Arc::new(tokio::sync::Mutex::new(session)), closed, opened)
    }

    async fn permit() -> tokio::sync::OwnedSemaphorePermit {
        Arc::new(Semaphore::new(1)).acquire_owned().await.unwrap()
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
    async fn cancellation_stops_a_stalled_read() {
        let (mut reader, _writer) = tokio::io::duplex(64);
        let token = CancellationToken::new();
        let read = read_bounded(&mut reader, 100, &token);
        let cancel = async {
            tokio::task::yield_now().await;
            token.cancel();
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
    }

    #[test]
    fn image_preview_preserves_transparency_and_bounds_dimensions() {
        let image = DynamicImage::new_rgba8(2500, 2);
        let mut encoded = Cursor::new(Vec::new());
        image.write_to(&mut encoded, ImageFormat::Png).unwrap();
        let preview = image::load_from_memory(&image_preview(encoded.get_ref()).unwrap()).unwrap();
        assert_eq!(preview.width(), 2048);
        assert_eq!(preview.to_rgba8().get_pixel(0, 0).0[3], 0);
        assert!(image_preview(b"invalid").is_err());
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
        let result = image::load_from_memory(&image_preview(&oriented).unwrap()).unwrap();
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
