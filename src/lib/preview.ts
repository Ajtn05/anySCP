import { invoke } from "@tauri-apps/api/core";
import type { PreviewAdapter, PreviewData, PreviewKind } from "../types/preview";
import { thumbnailQueue } from "./thumbnail-queue";
import type { ExplorerEntry } from "../types/explorer";
import { loadSftpVideoPoster, openSftpVideo, videoMime } from "./video-preview";

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "log", "csv", "tsv", "json", "yaml", "yml", "toml",
  "ini", "conf", "cfg", "xml", "html", "htm", "css", "svg", "js", "jsx", "ts",
  "tsx", "rs", "py", "sh", "bash", "zsh", "c", "h", "cpp", "hpp", "java", "go",
  "rb", "php", "sql", "env", "gitignore", "gitconfig", "properties", "service",
]);

/** Classic TIFF containers with embedded JPEG support; camera variants vary. */
export function isRawPreview(name: string): boolean {
  return name.includes(".") && ["dng", "cr2", "nef", "arw"].includes(name.slice(name.lastIndexOf(".") + 1).toLowerCase());
}

export function previewKind(name: string): PreviewKind | null {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (videoMime(name)) return "video";
  if (["jpg", "jpeg", "png"].includes(extension) || isRawPreview(name)) return "image";
  if (extension === "pdf") return "pdf";
  if (!name.includes(".") || name.startsWith(".") || TEXT_EXTENSIONS.has(extension)) return "text";
  return null;
}

export function decodePreview(buffer: ArrayBuffer): PreviewData {
  if (buffer.byteLength < 4) throw new Error("Invalid preview response");
  const length = new DataView(buffer).getUint32(0, true);
  if (length > 1024 || length > buffer.byteLength - 4) throw new Error("Invalid preview response");
  const metadata = JSON.parse(new TextDecoder().decode(buffer.slice(4, length + 4)));
  if (!["image", "text", "pdf"].includes(metadata.kind) ||
      !Number.isSafeInteger(metadata.source_size) || metadata.source_size < 0 ||
      typeof metadata.truncated !== "boolean") throw new Error("Invalid preview metadata");
  return {
    kind: metadata.kind, sourceSize: metadata.source_size,
    truncated: metadata.truncated, bytes: buffer.slice(length + 4),
  };
}

export function createSftpPreviewAdapter(sessionId: string): PreviewAdapter {
  const thumbnailKey = (entry: ExplorerEntry) => JSON.stringify([sessionId, entry.id, entry.size, entry.modified]);
  const cacheable = (entry: ExplorerEntry) => entry.modified != null && !entry.isSymlink;
  const supportsThumbnail = (entry: ExplorerEntry) => entry.entryType === "File" && (videoMime(entry.name) !== null || (previewKind(entry.name) === "image" && (isRawPreview(entry.name) || /\.(jpe?g)$/i.test(entry.name) || entry.size <= 8 * 1024 * 1024)));
  async function read(entry: ExplorerEntry, signal: AbortSignal, thumbnail = false): Promise<ArrayBuffer> {
    signal.throwIfAborted();
    const requestId = await invoke<string>("sftp_preview_begin", {
      sftpSessionId: sessionId, path: entry.id, ...(thumbnail ? { thumbnail: true } : {}),
    });
    const cancel = () => { void invoke("sftp_preview_cancel", { requestId }).catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      const bytes = await invoke<ArrayBuffer>("sftp_preview_read", { requestId });
      signal.throwIfAborted();
      return bytes;
    } finally {
      signal.removeEventListener("abort", cancel); cancel();
    }
  }
  return {
    supports: (entry) => entry.entryType === "File" && previewKind(entry.name) !== null,
    async load(entry, signal) {
      if (videoMime(entry.name)) throw new Error("Use the video preview controls to load this file");
      return decodePreview(await read(entry, signal));
    },
    video: { open: (entry, signal) => openSftpVideo(sessionId, entry, signal) },
    thumbnails: {
      supports: supportsThumbnail,
      getCached: (entry) => supportsThumbnail(entry) && cacheable(entry) ? thumbnailQueue.getCached(sessionId, thumbnailKey(entry)) : undefined,
      load: (entry, signal) => thumbnailQueue.request(sessionId, thumbnailKey(entry),
        (signal) => videoMime(entry.name) ? loadSftpVideoPoster(sessionId, entry, signal) : read(entry, signal, true), signal, cacheable(entry)),
      async clear() {
        thumbnailQueue.clear(sessionId);
        await invoke("sftp_thumbnail_clear", { sftpSessionId: sessionId });
      },
    },
  };
}
