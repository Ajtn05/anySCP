//! Read a bounded JPEG header and reuse its optional EXIF thumbnail.
//! Keep the prefix so the full-image fallback never fetches it a second time.
use std::{io::Cursor, ops::Range};

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio_util::sync::CancellationToken;

use super::{raw_preview, SftpError};

const HEADER_LIMIT: usize = 128 * 1024;
const CHUNK: usize = 32 * 1024;

pub(super) fn supports(path: &str) -> bool {
    path.rsplit_once('.')
        .is_some_and(|(_, ext)| matches!(ext.to_ascii_lowercase().as_str(), "jpg" | "jpeg"))
}

pub(super) struct Probe {
    pub prefix: Vec<u8>,
    pub embedded: Option<raw_preview::EmbeddedJpeg>,
}

enum Scan {
    More,
    Exif(Range<usize>),
    Done,
}

fn scan(bytes: &[u8]) -> Scan {
    if bytes.len() < 2 {
        return Scan::More;
    }
    if !bytes.starts_with(&[0xff, 0xd8]) {
        return Scan::Done;
    }
    let mut offset = 2;
    for _ in 0..512 {
        if offset >= bytes.len() {
            return Scan::More;
        }
        if bytes[offset] != 0xff {
            return Scan::Done;
        }
        // Marker fill bytes are legal, but never scan entropy-coded image data.
        while bytes.get(offset) == Some(&0xff) {
            offset += 1;
        }
        let Some(&marker) = bytes.get(offset) else {
            return Scan::More;
        };
        offset += 1;
        match marker {
            0xda | 0xd9 | 0xd8 | 0x00 => return Scan::Done,
            0x01 | 0xd0..=0xd7 => continue,
            _ => {}
        }
        let Some(length) = bytes.get(offset..offset + 2) else {
            return Scan::More;
        };
        let length = usize::from(u16::from_be_bytes([length[0], length[1]]));
        if length < 2 || offset + length > HEADER_LIMIT {
            return Scan::Done;
        }
        let end = offset + length;
        let Some(payload) = bytes.get(offset + 2..end) else {
            return Scan::More;
        };
        if marker == 0xe1 && payload.starts_with(b"Exif\0\0") {
            return Scan::Exif(offset + 8..end);
        }
        offset = end;
    }
    Scan::Done
}

pub(super) async fn probe<R: AsyncRead + Unpin>(
    reader: &mut R,
    size: u64,
    token: &CancellationToken,
    busy: &impl Fn() -> bool,
) -> Result<Probe, SftpError> {
    let mut prefix = Vec::new();
    let limit = size.min(HEADER_LIMIT as u64) as usize;
    let mut chunk = [0; CHUNK];
    let exif = loop {
        if token.is_cancelled() {
            return Err(SftpError::TransferCancelled);
        }
        if busy() {
            return Err(SftpError::PreviewDeferred);
        }
        match scan(&prefix) {
            Scan::Exif(range) => break Some(range),
            Scan::Done => break None,
            Scan::More if prefix.len() >= limit => break None,
            Scan::More => {}
        }
        let want = chunk.len().min(limit - prefix.len());
        let n = reader
            .read(&mut chunk[..want])
            .await
            .map_err(|e| SftpError::RemoteIoError(e.to_string()))?;
        super::preview_io::check(token)?;
        if n == 0 {
            break None;
        }
        prefix.extend_from_slice(&chunk[..n]);
    };
    let embedded = if let Some(range) = exif {
        // EXIF is a self-contained TIFF payload. Its offsets must remain inside
        // this APP1 segment; the existing bounded TIFF reader enforces that.
        let bytes = &prefix[range];
        match raw_preview::extract(
            &mut Cursor::new(bytes),
            bytes.len() as u64,
            HEADER_LIMIT as u64,
            true,
            token,
            busy,
        )
        .await
        {
            Ok(jpeg) => Some(jpeg),
            Err(error @ (SftpError::TransferCancelled | SftpError::PreviewDeferred)) => {
                return Err(error);
            }
            // Missing or malformed EXIF must not break an otherwise valid JPEG.
            Err(_) => None,
        }
    } else {
        None
    };
    Ok(Probe { prefix, embedded })
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use image::metadata::Orientation;

    // A standards-shaped APP1: IFD0 orientation, next IFD1 with a JPEG
    // thumbnail. The main JPEG body remains byte-for-byte unchanged.
    pub fn with_thumbnail(main: &[u8], thumbnail: &[u8], little: bool) -> Vec<u8> {
        fn word(bytes: &mut [u8], offset: usize, value: u16, little: bool) {
            bytes[offset..offset + 2].copy_from_slice(&if little {
                value.to_le_bytes()
            } else {
                value.to_be_bytes()
            });
        }
        fn long(bytes: &mut [u8], offset: usize, value: u32, little: bool) {
            bytes[offset..offset + 4].copy_from_slice(&if little {
                value.to_le_bytes()
            } else {
                value.to_be_bytes()
            });
        }
        let mut tiff = vec![0; 68 + thumbnail.len()];
        tiff[..4].copy_from_slice(if little { b"II\x2a\0" } else { b"MM\0\x2a" });
        long(&mut tiff, 4, 8, little);
        word(&mut tiff, 8, 1, little);
        word(&mut tiff, 10, 0x0112, little);
        word(&mut tiff, 12, 3, little);
        long(&mut tiff, 14, 1, little);
        word(&mut tiff, 18, 6, little);
        long(&mut tiff, 22, 26, little);
        word(&mut tiff, 26, 3, little);
        for (index, (tag, typ, value)) in [
            (0x0103, 3, 6),
            (0x0201, 4, 68),
            (0x0202, 4, thumbnail.len() as u32),
        ]
        .into_iter()
        .enumerate()
        {
            let offset = 28 + index * 12;
            word(&mut tiff, offset, tag, little);
            word(&mut tiff, offset + 2, typ, little);
            long(&mut tiff, offset + 4, 1, little);
            if typ == 3 {
                word(&mut tiff, offset + 8, value as u16, little);
            } else {
                long(&mut tiff, offset + 8, value, little);
            }
        }
        tiff[68..].copy_from_slice(thumbnail);
        let length = u16::try_from(tiff.len() + 8).unwrap();
        let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe1];
        jpeg.extend_from_slice(&length.to_be_bytes());
        jpeg.extend_from_slice(b"Exif\0\0");
        jpeg.extend(tiff);
        jpeg.extend_from_slice(&main[2..]);
        jpeg
    }

    #[tokio::test]
    async fn extracts_both_byte_orders_and_inherits_photo_orientation() {
        for little in [true, false] {
            let thumbnail = [0xff, 0xd8, 0xff, 0xd9];
            let mut source = with_thumbnail(&[0xff, 0xd8, 0xff, 0xd9], &thumbnail, little);
            source.resize(1024 * 1024, 0);
            let mut reader = source.as_slice();
            let result = probe(
                &mut reader,
                source.len() as u64,
                &CancellationToken::new(),
                &|| false,
            )
            .await
            .unwrap();
            assert_eq!(result.prefix.len(), CHUNK);
            let embedded = result.embedded.unwrap();
            assert_eq!(embedded.bytes, thumbnail);
            assert_eq!(embedded.orientation, Some(Orientation::Rotate90));
            assert_eq!(reader.len(), source.len() - CHUNK);
        }
    }

    #[tokio::test]
    async fn handles_large_exif_segments_and_other_metadata_before_exif() {
        let mut thumbnail = vec![0xff, 0xd8, 0xff];
        thumbnail.resize(40_000, 0);
        let photo = with_thumbnail(&[0xff, 0xd8, 0xff, 0xd9], &thumbnail, true);
        let mut source = vec![0xff, 0xd8, 0xff, 0xe2];
        source.extend_from_slice(&40_002u16.to_be_bytes());
        source.resize(40_006, 0);
        source.extend_from_slice(&photo[2..]);
        source.resize(1024 * 1024, 0);
        let result = probe(
            &mut source.as_slice(),
            source.len() as u64,
            &CancellationToken::new(),
            &|| false,
        )
        .await
        .unwrap();
        assert_eq!(result.embedded.unwrap().bytes, thumbnail);
        assert_eq!(result.prefix.len(), CHUNK * 3);
    }

    #[tokio::test]
    async fn probe_is_bounded_and_never_scans_past_start_of_scan() {
        // Valid, long APP2 blocks exhaust the header budget without entropy scans.
        let mut source = vec![0xff, 0xd8];
        for _ in 0..8 {
            source.extend([0xff, 0xe2, 0xff, 0xff]);
            source.resize(source.len() + 65533, 0);
        }
        let mut reader = source.as_slice();
        let result = probe(
            &mut reader,
            source.len() as u64,
            &CancellationToken::new(),
            &|| false,
        )
        .await
        .unwrap();
        assert!(result.embedded.is_none());
        assert!(result.prefix.len() <= HEADER_LIMIT);
        assert_eq!(reader.len() + result.prefix.len(), source.len());

        let mut source = vec![0xff, 0xd8, 0xff, 0xda];
        source.extend(with_thumbnail(
            &[0xff, 0xd8, 0xff, 0xd9],
            &[0xff, 0xd8, 0xff],
            true,
        ));
        source.resize(1024 * 1024, 0);
        let result = probe(
            &mut source.as_slice(),
            source.len() as u64,
            &CancellationToken::new(),
            &|| false,
        )
        .await
        .unwrap();
        assert!(result.embedded.is_none());
        assert_eq!(result.prefix.len(), CHUNK);
    }

    #[tokio::test]
    async fn malformed_metadata_and_short_headers_fall_back_without_panicking() {
        let mut malformed = with_thumbnail(&[0xff, 0xd8, 0xff, 0xd9], &[0xff, 0xd8, 0xff], true);
        // IFD1's thumbnail offset points outside its own APP1 segment.
        malformed[12 + 48..12 + 52].copy_from_slice(&u32::MAX.to_le_bytes());
        for source in [
            vec![],
            vec![0xff],
            vec![0xff, 0xd8, 0xff],
            vec![0xff, 0xd8, 0xff, 0xe1, 0, 1],
            malformed,
        ] {
            let result = probe(
                &mut source.as_slice(),
                source.len() as u64,
                &CancellationToken::new(),
                &|| false,
            )
            .await
            .unwrap();
            assert!(result.embedded.is_none());
            assert_eq!(result.prefix, source);
        }
    }

    #[tokio::test]
    async fn cancellation_and_transfer_priority_cover_header_reads() {
        let source = vec![0xff; CHUNK * 2];
        let mut reader = source.as_slice();
        assert!(matches!(
            probe(
                &mut reader,
                source.len() as u64,
                &CancellationToken::new(),
                &|| true
            )
            .await,
            Err(SftpError::PreviewDeferred)
        ));
        assert_eq!(reader.len(), source.len());
        let (mut reader, mut writer) = tokio::io::duplex(64);
        let token = CancellationToken::new();
        let read = probe(&mut reader, 1000, &token, &|| false);
        let cancel = async {
            tokio::task::yield_now().await;
            token.cancel();
            tokio::io::AsyncWriteExt::write_all(&mut writer, b"\xff\xd8")
                .await
                .unwrap();
        };
        let (result, ()) = tokio::join!(read, cancel);
        assert!(matches!(result, Err(SftpError::TransferCancelled)));
    }
}
