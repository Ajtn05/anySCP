import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { ExplorerEntry } from "../types/explorer";
import type { VideoSource } from "../types/preview";

export function videoMime(name: string): string | null {
  if (!name.includes(".")) return null;
  switch (name.slice(name.lastIndexOf(".") + 1).toLowerCase()) {
    case "mp4": case "m4v": return "video/mp4";
    case "mov": return "video/quicktime";
    case "webm": return "video/webm";
    default: return null;
  }
}

async function open(session: string, entry: ExplorerEntry, signal: AbortSignal, thumbnail: boolean) {
  signal.throwIfAborted();
  const id = await invoke<string>("sftp_video_begin", { sftpSessionId: session, path: entry.id, thumbnail });
  let released = false;
  const release = () => {
    if (released) return;
    released = true; signal.removeEventListener("abort", release);
    void invoke("sftp_video_cancel", { requestId: id }).catch(() => {});
  };
  signal.addEventListener("abort", release, { once: true });
  try {
    signal.throwIfAborted();
    const info = await invoke<{ source_size: number; mime: string }>("sftp_video_open", { requestId: id });
    signal.throwIfAborted();
    if (!Number.isSafeInteger(info.source_size) || info.source_size <= 0 || info.mime !== videoMime(entry.name)) throw new Error("Invalid video response");
    return { id, url: convertFileSrc(id, "anyscp-video"), mime: info.mime, sourceSize: info.source_size, release,
      deferred: () => invoke<boolean>("sftp_video_deferred", { requestId: id }) };
  } catch (error) { release(); throw error; }
}

export function openSftpVideo(session: string, entry: ExplorerEntry, signal: AbortSignal): Promise<VideoSource> {
  return open(session, entry, signal, false);
}

function firstFrame(video: HTMLVideoElement, source: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false, seeking = false;
    let paint = 0;
    const cleanup = () => {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      video.removeEventListener("loadedmetadata", metadata); video.removeEventListener("loadeddata", ready); video.removeEventListener("error", failed);
      video.removeEventListener("seeked", seeked); cancelAnimationFrame(paint);
    };
    const finish = (error?: unknown) => { if (settled) return; settled = true; cleanup(); if (error) reject(error); else resolve(); };
    const abort = () => finish(signal.reason ?? new DOMException("Preview cancelled", "AbortError"));
    const failed = () => finish(new Error("Video poster unavailable. Use Quick Look or Download."));
    const metadata = () => {
      if (!video.videoWidth || !video.videoHeight || video.videoWidth > 8192 || video.videoHeight > 8192 || video.videoWidth * video.videoHeight > 40_000_000) { failed(); return; }
      // A short seek makes WebKit prepare a drawable frame. loadeddata alone
      // can precede the native frame becoming available to drawImage.
      if (Number.isFinite(video.duration) && video.duration > 0) {
        seeking = true; video.currentTime = Math.min(0.1, video.duration / 2);
      }
    };
    const rendered = () => { if (!paint) paint = requestAnimationFrame(() => { paint = requestAnimationFrame(() => finish()); }); };
    const ready = () => { if (!seeking && !settled) rendered(); };
    const seeked = () => { seeking = false; if (!settled) rendered(); };
    const timer = setTimeout(failed, 15_000);
    signal.addEventListener("abort", abort, { once: true });
    video.addEventListener("loadedmetadata", metadata); video.addEventListener("loadeddata", ready); video.addEventListener("error", failed);
    video.addEventListener("seeked", seeked);
    if (signal.aborted) { abort(); return; }
    video.src = source; video.load();
  });
}

export async function loadSftpVideoPoster(session: string, entry: ExplorerEntry, signal: AbortSignal): Promise<ArrayBuffer> {
  signal.throwIfAborted();
  const video = document.createElement("video");
  const mime = videoMime(entry.name);
  if (!mime || !video.canPlayType(mime)) throw new Error("This webview does not support the video format");
  const source = await open(session, entry, signal, true);
  video.crossOrigin = "anonymous"; video.muted = true; video.playsInline = true; video.preload = "auto";
  try {
    const cached = await invoke<ArrayBuffer>("sftp_video_poster_cached", { requestId: source.id });
    signal.throwIfAborted();
    if (cached.byteLength) return cached;
    try { await firstFrame(video, source.url, signal); }
    catch (error) {
      signal.throwIfAborted();
      if (await source.deferred().catch(() => false)) throw { kind: "preview_deferred" };
      throw error;
    }
    signal.throwIfAborted();
    const scale = Math.min(1, 320 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Video poster unavailable");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Video poster unavailable")), "image/png"));
    if (blob.size > 512 * 1024) throw new Error("Video poster exceeds the thumbnail limit");
    const bytes = await blob.arrayBuffer();
    signal.throwIfAborted();
    // Cache failures must not hide a valid poster. Rust validates/normalizes
    // the binary PNG and checks the lease's invalidation generation.
    await invoke("sftp_video_poster_store", new Uint8Array(bytes), { headers: { "x-preview-id": source.id } }).catch(() => {});
    signal.throwIfAborted();
    return bytes;
  } finally {
    video.pause(); video.removeAttribute("src"); video.load(); source.release();
  }
}
