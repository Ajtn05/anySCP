# File previews

Phase 1 adds read-only Quick Look to the SFTP explorer. Select a supported file
and press Space, or choose **Quick Look** from its context menu. Escape closes
the preview. Previous/next follows the explorer's current sort order. Existing
double-click, Download, Edit, S3, and SCP behavior is unchanged.

Supported formats:

- JPEG and PNG: orientation-aware previews fitted within 2048 × 2048 pixels.
- DNG, CR2, NEF, and ARW: embedded JPEG previews in supported classic TIFF
  layouts, using the same image size and decoding limits. Camera variants differ.
- MP4, M4V, modern MOV, and WebM: explicit video loading and native playback
  controls, with bounded posters in the grid. Codec support varies.
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

**Settings → Explorer → Show hidden files** controls files and folders whose
names start with a dot, such as `.env` and `.ssh`. The eye button in the explorer
toolbar changes the same saved preference. It applies across SFTP, SCP, and S3,
in both list and thumbnail views. Hidden files remain visible by default for
existing users. Hiding selected items removes them from subsequent selection
actions and Quick Look navigation. Listings and recursive folder transfers
retain the underlying contents, and S3 pagination remains available even when
a loaded page contains only hidden items.

Use the **Thumbnail view** toolbar button for a grid. List view remains the
default; selection, sorting, rename, menus, uploads, and drag actions are shared
between both views. JPEG/PNG sources up to 8 MiB, JPEG photos with usable embedded
EXIF thumbnails, supported embedded RAW JPEGs up to 8 MiB, and bounded video
posters get automatic thumbnails;
other files retain icons and their existing Quick Look/Download actions. Grid
thumbnails fit within 320 × 320 pixels without enlarging small images.

Quick Look immediately displays a matching, unexpired image thumbnail from the
memory cache while it loads the larger preview. Cache misses start only the
normal foreground preview, without another thumbnail request. The cached image
remains visible with an error message if the larger preview fails. Navigation
cancels the previous preview and switches to the next file's cached image, or
the normal loading indicator when none is available. The existing session,
metadata, expiry, and invalidation rules apply to this reuse.

An IntersectionObserver shared by the scroll container starts work only for
visible images. Scrolling images offscreen cancels their reads and releases
their object URLs. A bounded queue deduplicates requests and fetches one image
at a time across tabs. Hidden tabs and an open Quick Look stop background
loading. Active/queued transfers pause it; the Rust reader also checks queued
and legacy SFTP transfer state between requests. Full JPEG/PNG fallback reads
request up to 128 KiB at a time; JPEG header probes, RAW reads, and video poster
reads retain 32 KiB checkpoints. Only one read/decoder runs at a time, so a new
transfer can have at most one existing thumbnail read to wait for. Blocking
decodes retain their permit until completion.

### Faster photo thumbnails

JPEG thumbnails first inspect a contiguous prefix of at most 128 KiB for a
standard EXIF APP1 JPEG thumbnail. A usable embedded image avoids reading and
decoding the full photo, including photos larger than the normal automatic
source limit. The existing bounded TIFF reader validates offsets against the
APP1 payload, supports either byte order, and preserves orientation. Missing or
malformed EXIF and undecodable embedded images fall back to the full JPEG only
when the original is within the 8 MiB limit. The already-read prefix is reused;
it is never fetched twice. Large JPEGs without an eligible embedded preview
retain their file icon after the bounded header probe. Quick Look continues to
use the original image, and Download continues to transfer its original bytes.

This follows the APP1/IFD1 layout in the [CIPA EXIF specification](https://www.cipa.jp/std/documents/e/DC-008-2012_E.pdf).
Only the resulting resized PNG enters the existing thumbnail caches. A camera's
embedded thumbnail may have lower resolution or reflect an earlier camera render.

Deterministic SFTP protocol fixtures verify that a generated 10 MiB JPEG with a
small EXIF thumbnail reads 32 KiB in one data request, then reads no additional
file data on a cache hit. A generated 2 MiB JPEG without a thumbnail takes 18
read requests, including EOF, instead of the previous 65. These are byte/request
counts from an in-memory server, not real-network timing guarantees. Tests also
cover larger metadata segments, bad offsets, malformed embedded JPEG fallback,
orientation, metadata changes, cancellation, transfer deferral, closed handles,
and byte-identical original downloads.

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
applied once, falling back to JPEG orientation when absent. The preview reflects
the camera's rendering and can have lower resolution than the sensor image.
Only the resized PNG enters thumbnail caches;
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

## Video previews and posters

Select a supported video and open Quick Look. **Load video** creates a scoped
stream; native controls then start playback. There is no autoplay. Transfer
activity releases the media source and cancels its lease. Afterward, **Resume
video** reloads the stream at the saved position; playback still waits for the
native Play control. Closing the dialog, changing files, hiding the explorer,
closing its window, or closing the SFTP session cancels its video work.

The optional provider video adapter uses separate begin/open/cancel commands.
A Tauri asynchronous `anyscp-video` protocol serves opaque UUID URLs, validated
against the requesting webview and its SFTP session. Remote filenames and
credentials do not appear in URLs. Each source must be a regular file with a
known size. The reader checks target metadata, opens read-only, releases the
session mutex before reading, and compares size/mtime before and after each
range. It never creates a local movie, transfer job, editor watcher, or network
listener. S3 and SCP do not expose this adapter.

Single inclusive/open-ended/suffix byte ranges return `206`, `Content-Range`,
`Accept-Ranges`, and `no-store`; invalid/multiple ranges return `416`. Each
response is capped at 1 MiB. A no-Range GET can return `200` only when the whole
file fits that limit; larger no-Range GETs fail instead of downloading a movie.
HEAD returns metadata without file bytes. Ranges share the existing single
preview worker, and at most four protocol requests are admitted at once.
The service allows at most eight leases and expires them after two minutes
without requests. Each I/O request has a 15-second timeout. Background reads
check transfer state between packets up to 32 KiB; foreground playback uses up
to 256 KiB to reduce network round trips. The SFTP library's server limits can
reduce those packet sizes. Active SFTP transfers defer range reads in Rust;
the explorer also pauses video for queued/active transfers of any provider.

Grid posters use the existing visible-only queue and memory LRU. A muted,
detached video element decodes a frame after a short seek (up to 100 ms).
Waiting for seek completion and two paint frames avoids WebKit's early
`loadeddata` event producing an empty canvas. Extraction never calls Play.
Every poster lease has an 8 MiB **total** file-read budget, including the
container signature and all seeks/repeated ranges, plus a 15-second wait for
the decoded frame. Only one poster is decoded by the queue at a time. The canvas fits
within 320 × 320 without enlargement. Rust validates and re-encodes the binary
PNG before putting it in the existing private session cache; arbitrary payloads
and original videos cannot enter that cache. Refresh and Clear thumbnail cache
cancel poster leases and invalidate their cache generation. Media sources,
event listeners, timers, paint callbacks, and leases are released on all exits.

The webview, rather than a bundled transcoder, supplies codecs. MIME checks are
only a preflight hint. Unsupported codecs, malformed files, poster read-budget
failures, and older MOV files without an initial `ftyp` box retain an icon and
Download fallback. Video metadata dimensions above 8192 per edge or 40 million
pixels are rejected in the frontend; native decoder memory behavior still
depends on the platform. No FFmpeg or other system executable is required at
runtime. Playback can eventually read an entire movie after explicit Play;
the response cap limits each request, not total foreground bandwidth. High
latency, high-bitrate, inter-frame dependencies, and large/non-fast-start
metadata can delay playback or prevent a poster within its budget.

The protocol approach follows [Tauri's streaming example](https://github.com/tauri-apps/tauri/blob/dev/examples/streaming/main.rs),
with remote reads, scope checks, cancellation, and stricter bounds. Media
format preflight uses the standard [canPlayType API](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/canPlayType).

### Video validation

Rust tests cover range syntax/limits/overflow, window ownership, lease bounds
and expiry, read-only protocol opens, concurrent independent ranges beside an
unchanged original download, total poster budgets, transfer deferral,
cancellation, file changes, special files, PNG normalization, and HTTP headers.
Frontend tests cover explicit loading, original downloads, codec errors,
transfer pause/resume, stale results, poster seek timing, bounded canvases,
cache hits, binary IPC, timeouts, and resource cleanup. The Docker E2E spec
adds a malformed-video fallback followed by a byte-identical queued download.

An isolated macOS Tauri harness used generated H.264 MP4 and VP9 WebM files
through an in-memory SFTP server and the actual custom protocol. Native checks
confirmed metadata-only loading without autoplay, playback, MP4 metadata at
the file's end, seeking to six seconds, source release during a simulated
transfer, explicit resumption at that position, and a drawable PNG poster.
The generated 6.5 MiB MP4 produced a roughly 20 KiB poster. Visual checks used
380, 720, and 1050-pixel panel fixtures. The temporary harness and videos are
not part of the shipped application. Windows/WebView2, Linux/WebKitGTK,
M4V/MOV variants, audio codecs, and real-network benchmarks remain validation
gates; this is not a claim of universal container/codec support.

Large PDF range loading, more RAW camera fixtures, cross-platform native media
compatibility, low-bandwidth transfer benchmarks, PDF first-page thumbnails,
and color-management fidelity require further validation. The
current file size/mtime checks are best-effort validators, not content hashes.
