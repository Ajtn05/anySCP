//! Extract embedded JPEGs from classic TIFF-based RAW containers by range.
//! No sensor decoding, maker-note traversal, byte scanning, or external process.
//! This product includes DNG technology under license by Adobe.
use std::{collections::HashSet, io::SeekFrom};

use image::metadata::Orientation;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeek, AsyncSeekExt};
use tokio_util::sync::CancellationToken;

use super::SftpError;

const METADATA_LIMIT: usize = 256 * 1024;
const MAX_IFDS: usize = 32;
const MAX_TAGS: usize = 512;
const CHUNK: usize = 32 * 1024;

pub(super) fn supports(path: &str) -> bool {
    path.rsplit_once('.').is_some_and(|(_, ext)| {
        ["dng", "cr2", "nef", "arw"].contains(&ext.to_ascii_lowercase().as_str())
    })
}

pub(super) struct EmbeddedJpeg {
    pub bytes: Vec<u8>,
    pub orientation: Option<Orientation>,
}

fn invalid() -> SftpError {
    SftpError::ProtocolError(
        "A preview is not available for this photo. Download it to open it.".into(),
    )
}

#[derive(Clone, Copy)]
struct Endian(bool);

impl Endian {
    fn u16(self, bytes: &[u8]) -> u16 {
        let bytes = [bytes[0], bytes[1]];
        if self.0 {
            u16::from_le_bytes(bytes)
        } else {
            u16::from_be_bytes(bytes)
        }
    }
    fn u32(self, bytes: &[u8]) -> u32 {
        let bytes = [bytes[0], bytes[1], bytes[2], bytes[3]];
        if self.0 {
            u32::from_le_bytes(bytes)
        } else {
            u32::from_be_bytes(bytes)
        }
    }
    fn scalar(self, tag: &[u8]) -> Option<u32> {
        if self.u32(&tag[4..]) != 1 {
            return None;
        }
        match self.u16(&tag[2..]) {
            3 => Some(u32::from(self.u16(&tag[8..]))),
            4 | 13 => Some(self.u32(&tag[8..])),
            _ => None,
        }
    }
}

struct Ranges<'a, R, F> {
    reader: &'a mut R,
    size: u64,
    metadata_left: usize,
    metadata_reads_left: usize,
    token: &'a CancellationToken,
    busy: F,
}

impl<R: AsyncRead + AsyncSeek + Unpin, F: Fn() -> bool> Ranges<'_, R, F> {
    fn checkpoint(&self) -> Result<(), SftpError> {
        if self.token.is_cancelled() {
            return Err(SftpError::TransferCancelled);
        }
        if (self.busy)() {
            return Err(SftpError::PreviewDeferred);
        }
        Ok(())
    }

    async fn read(
        &mut self,
        offset: u64,
        length: usize,
        metadata: bool,
    ) -> Result<Vec<u8>, SftpError> {
        self.checkpoint()?;
        if offset
            .checked_add(length as u64)
            .is_none_or(|end| end > self.size)
            || offset > i64::MAX as u64
        {
            return Err(invalid());
        }
        if metadata {
            self.metadata_reads_left = self
                .metadata_reads_left
                .checked_sub(1)
                .ok_or_else(invalid)?;
            self.metadata_left = self.metadata_left.checked_sub(length).ok_or_else(invalid)?;
        }
        self.reader
            .seek(SeekFrom::Start(offset))
            .await
            .map_err(|_| invalid())?;
        let mut bytes = vec![0; length];
        // Manual reads preserve the 32 KiB transfer checkpoint even if a server
        // returns short packets. read_exact would hide those packet boundaries.
        let mut filled = 0;
        while filled < length {
            self.checkpoint()?;
            let end = (filled + CHUNK).min(length);
            let n = self
                .reader
                .read(&mut bytes[filled..end])
                .await
                .map_err(|_| invalid())?;
            self.checkpoint()?;
            if n == 0 {
                return Err(invalid());
            }
            filled += n;
        }
        Ok(bytes)
    }
}

#[derive(Clone, Copy)]
struct Candidate {
    offset: u32,
    length: u32,
    orientation: Option<Orientation>,
}

/// Bound metadata separately from the single selected JPEG. The caller owns
/// the deadline, regular-file/fstat checks, handle closure, and decoder limits.
pub(super) async fn extract<R: AsyncRead + AsyncSeek + Unpin>(
    reader: &mut R,
    size: u64,
    jpeg_limit: u64,
    thumbnail: bool,
    token: &CancellationToken,
    busy: impl Fn() -> bool,
) -> Result<EmbeddedJpeg, SftpError> {
    let mut ranges = Ranges {
        reader,
        size,
        metadata_left: METADATA_LIMIT,
        metadata_reads_left: 128,
        token,
        busy,
    };
    let header = ranges.read(0, 16, true).await?;
    let endian = match &header[..4] {
        b"II\x2a\0" => Endian(true),
        b"MM\0\x2a" => Endian(false),
        _ => return Err(invalid()), // BigTIFF, CR3, and other containers are separate formats.
    };
    let root = endian.u32(&header[4..]);
    let canon_root = &header[8..12] == b"CR\x02\0";
    let mut pending = vec![root];
    let mut visited = HashSet::new();
    let mut candidates = Vec::new();
    let mut root_orientation = None;
    while let Some(offset) = pending.pop() {
        if offset == 0 {
            continue;
        }
        if offset < 8 || !visited.insert(offset) || visited.len() > MAX_IFDS {
            return Err(invalid());
        }
        let count = ranges.read(u64::from(offset), 2, true).await?;
        let count = usize::from(endian.u16(&count));
        if count > MAX_TAGS {
            return Err(invalid());
        }
        let table = ranges
            .read(u64::from(offset) + 2, count * 12 + 4, true)
            .await?;
        let mut jpeg_offset = None;
        let mut jpeg_length = None;
        let mut strip_offset = None;
        let mut strip_length = None;
        let mut compression = None;
        let mut photometric = None;
        let mut orientation = None;
        for tag in table[..count * 12].as_chunks::<12>().0 {
            let value = endian.scalar(tag);
            match endian.u16(tag) {
                0x0103 => compression = value,
                0x0106 => photometric = value,
                0x0111 => strip_offset = value,
                0x0117 => strip_length = value,
                0x0201 => jpeg_offset = value,
                0x0202 => jpeg_length = value,
                0x0112 => {
                    orientation = value
                        .and_then(|n| u8::try_from(n).ok())
                        .and_then(Orientation::from_exif)
                }
                0x014a => {
                    let count = endian.u32(&tag[4..]) as usize;
                    if !matches!(endian.u16(&tag[2..]), 4 | 13) || count > MAX_IFDS {
                        return Err(invalid());
                    }
                    if count == 1 {
                        pending.push(endian.u32(&tag[8..]));
                    } else if count > 1 {
                        let offsets = ranges
                            .read(u64::from(endian.u32(&tag[8..])), count * 4, true)
                            .await?;
                        pending.extend(
                            offsets
                                .as_chunks::<4>()
                                .0
                                .iter()
                                .map(|bytes| endian.u32(bytes)),
                        );
                    }
                }
                _ => {} // Never fetch arbitrary tag payloads or maker notes.
            }
        }
        if visited.len() == 1 {
            root_orientation = orientation;
        }
        pending.push(endian.u32(&table[count * 12..]));
        if pending.len() > MAX_IFDS * MAX_IFDS {
            return Err(invalid());
        }
        // Single-strip JPEG previews only. CFA/linear RAW strips can also use
        // JPEG compression; never send those sensor payloads to the decoder.
        // Canon CR2 IFD0 commonly omits PhotometricInterpretation; its CR2
        // header identifies the preview directory. Raw sensor IFDs are excluded.
        let canon_preview =
            canon_root && offset == root && photometric.is_none() && compression == Some(6);
        let strip = if canon_preview
            || (matches!(compression, Some(6 | 7)) && matches!(photometric, Some(2 | 6)))
        {
            strip_offset.zip(strip_length)
        } else {
            None
        };
        for (offset, length) in jpeg_offset.zip(jpeg_length).into_iter().chain(strip) {
            if length >= 3
                && u64::from(length) <= jpeg_limit
                && u64::from(offset) + u64::from(length) <= size
            {
                candidates.push(Candidate {
                    offset,
                    length,
                    orientation: orientation.or(root_orientation),
                });
            }
        }
    }
    // A small embedded image saves bandwidth in the grid. Quick Look selects
    // the largest eligible JPEG. Only probe signatures before reading one body.
    candidates.sort_by_key(|candidate| candidate.length);
    if !thumbnail {
        candidates.reverse();
    }
    for candidate in candidates {
        let start = ranges.read(u64::from(candidate.offset), 3, true).await?;
        if start != [0xff, 0xd8, 0xff] {
            continue;
        }
        let bytes = ranges
            .read(
                u64::from(candidate.offset),
                candidate.length as usize,
                false,
            )
            .await?;
        return Ok(EmbeddedJpeg {
            bytes,
            orientation: candidate.orientation,
        });
    }
    Err(invalid())
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use std::{
        io::Cursor,
        pin::Pin,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        task::{Context, Poll},
    };
    use tokio::io::ReadBuf;

    fn word(value: u16, little: bool) -> [u8; 2] {
        if little {
            value.to_le_bytes()
        } else {
            value.to_be_bytes()
        }
    }
    fn long(value: u32, little: bool) -> [u8; 4] {
        if little {
            value.to_le_bytes()
        } else {
            value.to_be_bytes()
        }
    }
    fn directory(
        bytes: &mut [u8],
        offset: usize,
        little: bool,
        tags: &[(u16, u16, u32)],
        next: u32,
    ) {
        bytes[offset..offset + 2].copy_from_slice(&word(tags.len() as u16, little));
        for (index, (id, typ, value)) in tags.iter().enumerate() {
            let start = offset + 2 + index * 12;
            let tag = &mut bytes[start..start + 12];
            tag[..2].copy_from_slice(&word(*id, little));
            tag[2..4].copy_from_slice(&word(*typ, little));
            tag[4..8].copy_from_slice(&long(1, little));
            if *typ == 3 {
                tag[8..10].copy_from_slice(&word(*value as u16, little));
            } else {
                tag[8..12].copy_from_slice(&long(*value, little));
            }
        }
        let end = offset + 2 + tags.len() * 12;
        bytes[end..end + 4].copy_from_slice(&long(next, little));
    }

    // Original, generated fixtures: TIFF/CR2 headers, Sony-style IFD0 JPEG
    // tags, Nikon-style SubIFDs, and DNG/CR2 single-strip previews. No camera
    // photograph or third-party binary is redistributed.
    pub fn fixture(jpeg: &[u8], little: bool, strip: bool) -> Vec<u8> {
        let mut bytes = vec![0; 4096 + jpeg.len()];
        bytes[..4].copy_from_slice(if little { b"II\x2a\0" } else { b"MM\0\x2a" });
        bytes[4..8].copy_from_slice(&long(16, little));
        bytes[8..12].copy_from_slice(b"CR\x02\0");
        let mut tags = vec![(0x0112, 3, 6)];
        if strip {
            tags.extend([
                (0x0103, 3, 7),
                (0x0106, 3, 6),
                (0x0111, 4, 4096),
                (0x0117, 4, jpeg.len() as u32),
            ]);
        } else {
            tags.extend([(0x0201, 4, 4096), (0x0202, 4, jpeg.len() as u32)]);
        }
        directory(&mut bytes, 16, little, &tags, 0);
        bytes[4096..].copy_from_slice(jpeg);
        bytes
    }

    #[tokio::test]
    async fn both_byte_orders_extract_jpeg_and_strip_layouts_with_orientation() {
        for little in [true, false] {
            for strip in [true, false] {
                let jpeg = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3];
                let bytes = fixture(&jpeg, little, strip);
                let result = extract(
                    &mut Cursor::new(&bytes),
                    256 * 1024 * 1024,
                    1024,
                    false,
                    &CancellationToken::new(),
                    || false,
                )
                .await
                .unwrap();
                assert_eq!(result.bytes, jpeg);
                assert_eq!(result.orientation, Some(Orientation::Rotate90));
            }
        }
    }

    #[tokio::test]
    async fn canon_root_preview_without_photometric_does_not_admit_sensor_strips() {
        let jpeg = [0xff, 0xd8, 0xff, 1];
        let mut bytes = fixture(&jpeg, true, true);
        directory(
            &mut bytes,
            16,
            true,
            &[(0x0103, 3, 6), (0x0111, 4, 4096), (0x0117, 4, 4)],
            128,
        );
        directory(
            &mut bytes,
            128,
            true,
            &[(0x0103, 3, 6), (0x0111, 4, 3000), (0x0117, 4, 100)],
            0,
        );
        bytes[3000..3003].copy_from_slice(&[0xff, 0xd8, 0xff]);
        let result = extract(
            &mut Cursor::new(&bytes),
            bytes.len() as u64,
            1024,
            false,
            &CancellationToken::new(),
            || false,
        )
        .await
        .unwrap();
        assert_eq!(result.bytes, jpeg);
        // Without the CR2 signature the omitted photometric tag is ambiguous.
        bytes[8..12].fill(0);
        assert!(extract(
            &mut Cursor::new(&bytes),
            bytes.len() as u64,
            1024,
            false,
            &CancellationToken::new(),
            || false
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn follows_subifd_arrays_and_next_links_and_selects_small_or_large_jpeg() {
        let small = [0xff, 0xd8, 0xff, 1];
        let large = [0xff, 0xd8, 0xff, 2, 3, 4, 5];
        for little in [false, true] {
            let mut bytes = fixture(&large, little, false);
            directory(
                &mut bytes,
                16,
                little,
                &[(0x014a, 4, 256), (0x0112, 3, 6)],
                128,
            );
            // Turn SubIFD's inline scalar into a two-offset external array.
            bytes[22..26].copy_from_slice(&long(2, little));
            bytes[256..260].copy_from_slice(&long(512, little));
            bytes[260..264].copy_from_slice(&long(768, little));
            directory(
                &mut bytes,
                128,
                little,
                &[(0x0201, 4, 2048), (0x0202, 4, small.len() as u32)],
                0,
            );
            directory(
                &mut bytes,
                512,
                little,
                &[(0x0201, 4, 4096), (0x0202, 4, large.len() as u32)],
                0,
            );
            // CFA sensor strip has a JPEG signature but is not a preview.
            directory(
                &mut bytes,
                768,
                little,
                &[
                    (0x0103, 3, 7),
                    (0x0106, 3, 32803),
                    (0x0111, 4, 3000),
                    (0x0117, 4, 100),
                ],
                0,
            );
            bytes[2048..2048 + small.len()].copy_from_slice(&small);
            bytes[3000..3003].copy_from_slice(&[0xff, 0xd8, 0xff]);
            for thumbnail in [false, true] {
                let result = extract(
                    &mut Cursor::new(&bytes),
                    bytes.len() as u64,
                    1024,
                    thumbnail,
                    &CancellationToken::new(),
                    || false,
                )
                .await
                .unwrap();
                assert_eq!(
                    result.bytes,
                    if thumbnail { &small[..] } else { &large[..] }
                );
                assert_eq!(result.orientation, Some(Orientation::Rotate90));
            }
        }
    }

    #[tokio::test]
    async fn malformed_or_unsupported_containers_have_no_scan_or_full_download_fallback() {
        let good = fixture(&[0xff, 0xd8, 0xff, 1], true, false);
        let mut variants = vec![vec![], b"not raw".to_vec(), b"II\x2b\0\x08\0\0\0".to_vec()];
        let mut cyclic = good.clone();
        directory(&mut cyclic, 16, true, &[], 16);
        variants.push(cyclic);
        let mut excessive = good.clone();
        excessive[16..18].copy_from_slice(&513_u16.to_le_bytes());
        variants.push(excessive);
        let mut dangling = good.clone();
        directory(&mut dangling, 16, true, &[(0x014a, 4, u32::MAX)], 0);
        variants.push(dangling);
        let mut out_of_bounds = good.clone();
        directory(
            &mut out_of_bounds,
            16,
            true,
            &[(0x0201, 4, u32::MAX), (0x0202, 4, 100)],
            0,
        );
        variants.push(out_of_bounds);
        let mut sensor_only = good.clone();
        directory(
            &mut sensor_only,
            16,
            true,
            &[
                (0x0103, 3, 7),
                (0x0106, 3, 34892),
                (0x0111, 4, 4096),
                (0x0117, 4, 4),
            ],
            0,
        );
        variants.push(sensor_only);
        let mut not_jpeg = good.clone();
        not_jpeg[4096] = 0;
        variants.push(not_jpeg);
        let mut excessive_subifds = good.clone();
        directory(&mut excessive_subifds, 16, true, &[(0x014a, 4, 256)], 0);
        excessive_subifds[22..26].copy_from_slice(&33_u32.to_le_bytes());
        variants.push(excessive_subifds);
        let mut long_chain = vec![0; 8192];
        long_chain[..8].copy_from_slice(&good[..8]);
        for index in 0..33 {
            directory(
                &mut long_chain,
                16 + index * 64,
                true,
                &[],
                (16 + (index + 1) * 64) as u32,
            );
        }
        variants.push(long_chain);
        for bytes in variants {
            assert!(extract(
                &mut Cursor::new(&bytes),
                bytes.len() as u64,
                1024,
                false,
                &CancellationToken::new(),
                || false
            )
            .await
            .is_err());
        }
        assert!(extract(
            &mut Cursor::new(&good),
            good.len() as u64,
            3,
            false,
            &CancellationToken::new(),
            || false
        )
        .await
        .is_err());
    }

    struct Counted {
        cursor: Cursor<Vec<u8>>,
        bytes: Arc<AtomicUsize>,
        cancel_at: Option<(u64, CancellationToken)>,
    }
    impl AsyncRead for Counted {
        fn poll_read(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            if let Some((offset, token)) = &self.cancel_at {
                if self.cursor.position() >= *offset {
                    token.cancel();
                }
            }
            let before = buf.filled().len();
            let result = Pin::new(&mut self.cursor).poll_read(cx, buf);
            self.bytes
                .fetch_add(buf.filled().len() - before, Ordering::SeqCst);
            result
        }
    }
    impl AsyncSeek for Counted {
        fn start_seek(mut self: Pin<&mut Self>, position: SeekFrom) -> std::io::Result<()> {
            Pin::new(&mut self.cursor).start_seek(position)
        }
        fn poll_complete(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
        ) -> Poll<std::io::Result<u64>> {
            Pin::new(&mut self.cursor).poll_complete(cx)
        }
    }

    #[tokio::test]
    async fn fetches_only_metadata_and_jpeg_and_yields_between_payload_chunks() {
        let mut jpeg = vec![1; 100_000];
        jpeg[..3].copy_from_slice(&[0xff, 0xd8, 0xff]);
        let bytes = Arc::new(AtomicUsize::new(0));
        let mut reader = Counted {
            cursor: Cursor::new(fixture(&jpeg, true, false)),
            bytes: bytes.clone(),
            cancel_at: None,
        };
        let token = CancellationToken::new();
        let result = extract(
            &mut reader,
            256 * 1024 * 1024,
            200_000,
            true,
            &token,
            || bytes.load(Ordering::SeqCst) >= CHUNK,
        )
        .await;
        assert!(matches!(result, Err(SftpError::PreviewDeferred)));
        assert_eq!(bytes.load(Ordering::SeqCst), CHUNK + 61);
        bytes.store(0, Ordering::SeqCst);
        let result = extract(
            &mut reader,
            256 * 1024 * 1024,
            200_000,
            false,
            &token,
            || false,
        )
        .await
        .unwrap();
        assert_eq!(result.bytes, jpeg);
        assert_eq!(bytes.load(Ordering::SeqCst), jpeg.len() + 61);
        token.cancel();
        assert!(matches!(
            extract(
                &mut reader,
                256 * 1024 * 1024,
                200_000,
                false,
                &token,
                || false
            )
            .await,
            Err(SftpError::TransferCancelled)
        ));
        assert_eq!(bytes.load(Ordering::SeqCst), jpeg.len() + 61);
    }

    #[tokio::test]
    async fn cancellation_stops_raw_ranges_after_the_current_reply() {
        let bytes = Arc::new(AtomicUsize::new(0));
        let token = CancellationToken::new();
        let mut reader = Counted {
            cursor: Cursor::new(fixture(&[0xff, 0xd8, 0xff, 1], true, false)),
            bytes,
            cancel_at: Some((4096, token.clone())),
        };
        let result = extract(&mut reader, 8192, 1024, false, &token, || false).await;
        assert!(matches!(result, Err(SftpError::TransferCancelled)));
    }
}
