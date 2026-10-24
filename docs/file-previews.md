# File previews

Phase 1 adds read-only Quick Look to the SFTP explorer. Select a supported file
and press Space, or choose **Quick Look** from its context menu. Escape closes
the preview. Previous/next follows the explorer's current sort order. Existing
double-click, Download, Edit, S3, and SCP behavior is unchanged.

Supported formats:

- JPEG and PNG: orientation-aware previews fitted within 2048 × 2048 pixels.
- Text: UTF-8 and BOM-marked UTF-16, with a 512 KiB source prefix limit.
  HTML/SVG are shown as source text. Binary content is rejected.
- PDF: one page at a time in a locally bundled PDF.js worker, including password
  prompts. Fonts and character maps are bundled; no CDN is required.

Images and PDFs have a 32 MiB source limit. Image decoding is also limited to
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
cache in this phase.

Validation includes frontend interaction/adapter tests and an in-memory SFTP
protocol server that verifies read-only open flags, bounded reads, explicit
handle closure, special-file rejection, and subsequent reads on the same
session. Run `pnpm test`, `pnpm build`, `cargo fmt --all --check`,
`cargo clippy --all-targets -- -D warnings`, and `cargo test`. The Docker E2E
suite (`make e2e`) remains the real-server transfer regression gate.

Next increments from the approved plan:

1. Bounded thumbnail caching, freshness/invalidation, and visible-item grid
   browsing. Pause background fetching during transfers and measure bandwidth.
2. Embedded RAW photography previews with representative camera fixtures.
3. Video posters and range-backed playback with explicit codec/platform tests.

Large PDF range loading, native-webview compatibility, low-bandwidth transfer
benchmarks, and color-management fidelity require further validation. The
current file size/mtime checks are best-effort validators, not content hashes.
