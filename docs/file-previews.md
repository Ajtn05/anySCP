# File previews

Phase 1 adds read-only Quick Look to the SFTP explorer. Select a supported file
and press Space, or choose **Quick Look** from its context menu. Escape closes
the preview. Previous/next follows the explorer's current sort order. Existing
double-click, Download, Edit, S3, and SCP behavior is unchanged.

Supported formats:

- JPEG and PNG: orientation-aware previews fitted within 2048 × 2048 pixels.
- DNG, CR2, NEF, and ARW: embedded JPEG previews in supported classic TIFF
  layouts, using the same image size and decoding limits. Camera variants differ.
- Text: UTF-8 and BOM-marked UTF-16, with a 512 KiB source prefix limit.
  HTML/SVG are shown as source text. Binary content is rejected.
- PDF: one page at a time in a locally bundled PDF.js worker, including password
  prompts. Fonts and character maps are bundled; no CDN is required.

JPEG/PNG images and PDFs have a 32 MiB source limit. Image decoding is also limited to
40 million pixels, 20,000 pixels per dimension, and a 128 MiB decoder allocation
budget. These limits can reject a file below the source-size limit. PDF canvas
dimensions and pixel count are capped. Use Download for a rejected file.

The optional `FileSystemProvider.preview` adapter uses a separate Tauri command
surface. Registering a request precedes I/O so cancellation can cover pending
metadata/open calls. Rust validates regular-file target metadata, opens files
read-only, releases the session mutex before reading, checks size/mtime again,
and returns a small metadata header followed by binary content. A 30-second
deadline bounds each read request. Preview work never enters the transfer
queue or installs an editor save watcher.

Only one preview job/decoder runs at once. Blocking image decoding retains its
permit until completion even if its caller cancels. Closing a preview, changing
selection/directory, hiding a tab, or closing/swapping an SFTP session cancels
associated reads. Image object URLs and PDF loading/rendering tasks are released
when no longer used. Previews are held in memory; there is no persistent content
cache for original files.

## Thumbnail browsing

Use the **Thumbnail view** toolbar button for a grid. List view remains the
default; selection, sorting, rename, menus, uploads, and drag actions are shared
between both views. JPEG/PNG sources up to 8 MiB and supported embedded RAW
JPEGs up to 8 MiB get automatic thumbnails;
other files retain icons and their existing Quick Look/Download actions. Grid
thumbnails fit within 320 × 320 pixels without enlarging small images.

An IntersectionObserver shared by the scroll container starts work only for
visible images. Scrolling images offscreen cancels their reads and releases
their object URLs. A bounded queue deduplicates requests and fetches one image
at a time across tabs. Hidden tabs and an open Quick Look stop background
loading. Active/queued transfers pause it; the Rust reader also checks queued
and legacy SFTP transfer state between 32 KiB chunks. Blocking decodes retain
their permit until completion.

The compressed-byte memory LRU holds at most 16 MiB / 128 thumbnails, with a
30-second expiry. Symlinks and entries without timestamps bypass memory reuse.
The Rust disk LRU holds at most 64 MiB / 512 thumbnails for ten minutes and
revalidates target metadata before reuse. Its keys contain the SFTP session,
path, source size/mtime, and invalidation generation. Unknown target timestamps
disable disk caching. Thumbnail PNGs are limited to 512 KiB each.

Disk entries are private, atomically written, and **scoped to the current
connection**. They are not reused across reconnections, users, or sudo swaps;
stable server/account identity for cross-connection caching is deferred.
Closing a session purges its disk entries; dropping the cache manager and any
finishing writes removes the run directory. Writes finish atomically even if
their caller cancels. Crash leftovers older than 24 hours are swept on
the next cache write. Original remote filenames never become local paths.

Refresh, completed uploads, editor-save notifications, and mutation-triggered
refreshes invalidate the session's thumbnail caches. The grid toolbar also
offers **Clear thumbnail cache**. In-flight results cannot repopulate an
invalidated generation. Metadata checks and expiry remain best-effort;
explicit refresh bypasses both caches.

Validation includes frontend interaction/adapter tests and an in-memory SFTP
protocol server that verifies read-only open flags, bounded reads, explicit
handle closure, special-file rejection, and subsequent reads on the same
session. Run `pnpm test`, `pnpm build`, `cargo fmt --all --check`,
`cargo clippy --all-targets -- -D warnings`, and `cargo test`. The Docker E2E
suite (`make e2e`) remains the real-server transfer regression gate.

## Embedded RAW previews

RAW Quick Look reads a JPEG up to 32 MiB plus at most 256 KiB of directory
metadata and JPEG signatures. The grid reads a JPEG up to 8 MiB plus the same
metadata budget. These limits apply to the selected embedded image; the RAW
original can be much larger. SFTP seeks fetch the selected ranges without
reading intervening sensor data. No RAW original is staged locally, and no
LibRaw, ExifTool, or other system executable is required at runtime.

The extractor supports little- and big-endian classic TIFF, next-IFD links,
SubIFD arrays, JPEGInterchangeFormat/Length pairs, and single JPEG strips with
RGB/YCbCr photometric tags. CR2's identified root preview may omit the
photometric tag. Sensor strips, arbitrary tag bodies, and maker notes are not
decoded or searched. Traversal is capped at 32 directories, 512 tags per
directory, and 128 metadata range requests, within the existing 30-second
deadline. Background reads check transfer state between packets up to 32 KiB.

Quick Look selects the largest eligible embedded JPEG by compressed byte size;
the grid selects the smallest to save bandwidth. Container orientation is
applied once, falling back to JPEG orientation when absent. The header labels
this as **Embedded JPEG**: it reflects the camera's rendering and can have lower
resolution than the sensor image. Only the resized PNG enters thumbnail caches;
Download continues to transfer the original RAW file.

Missing, corrupt, oversized, or unsupported embedded JPEGs retain the icon and
Download fallback. There is no full RAW decode/download fallback. CR3, RAF,
ORF, generic `.raw`, BigTIFF, tiled/multiple-strip previews, and previews found
only in maker notes are outside this increment. Newer DNG preview codecs such
as JPEG XL are also outside it. Real-camera DNG and ARW validation remains
necessary before claiming broad camera compatibility.

The directory layouts follow [TIFF/DNG documentation from Adobe](https://helpx.adobe.com/camera-raw/desktop/dng-and-file-formats/digital-negative.html)
and the tag mappings in [ExifTool's EXIF implementation](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/Exif.pm).
This product includes DNG technology under license by Adobe.

### RAW validation

Generated fixtures in `raw_preview.rs` exercise both byte orders, next/SubIFD
links, JPEG and strip layouts, CR2's omitted photometric tag, sensor exclusions,
orientation, malformed offsets, directory limits, cycles, missing JPEGs, and
cancellation/transfer deferral. The SFTP protocol tests verify read-only opens,
byte budgets for large reported originals, metadata changes, cache reuse, handle
closure on failure, and a subsequent byte-identical original download.

An optional compatibility test accepts camera originals outside the repository:

```sh
cd src-tauri
ANYSCP_RAW_SAMPLES=/absolute/path/to/camera-files cargo test local_camera_samples -- --ignored --nocapture
```

It passed with Canon EOS 40D CR2 and Nikon D3S NEF originals from
[rawpy's test collection](https://github.com/letmaik/rawpy/tree/main/test).
Those photos are not redistributed here. Observed returned file bytes through
the in-memory SFTP protocol server, excluding SFTP/SSH framing:

| Sample | Original bytes | Quick Look read | Grid read | Quick Look / grid dimensions |
| --- | ---: | ---: | ---: | --- |
| Canon EOS 40D sRAW | 6,800,865 | 482,265 | 12,682 | 1936 × 1288 / 160 × 120 |
| Nikon D3S | 10,656,312 | 855,851 | 855,851 | 2048 × 1363 / 320 × 213 |

The Nikon's smaller maker-note JPEG is intentionally not followed. These are
compatibility and byte-budget checks, not real-network latency benchmarks.

Next increments from the approved plan: more RAW container/camera fixtures,
then video posters and range-backed playback with explicit codec/platform tests.

Large PDF range loading, native-webview compatibility, low-bandwidth transfer
benchmarks, PDF first-page thumbnails, and color-management fidelity require further validation. The
current file size/mtime checks are best-effort validators, not content hashes.
