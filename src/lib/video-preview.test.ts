import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSftpVideoPoster, openSftpVideo, videoMime } from "./video-preview";
import type { ExplorerEntry } from "../types/explorer";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (id: string, scheme: string) => `${scheme}://localhost/${id}` }));
const entry = { id: "/movie.mp4", name: "movie.mp4", entryType: "File", size: 1024 } as ExplorerEntry;
let cached: ArrayBuffer, frame: "ready" | "error" | "pending";
let load: ReturnType<typeof vi.spyOn>, pause: ReturnType<typeof vi.spyOn>, draw: ReturnType<typeof vi.fn>;
const png = new Uint8Array([137, 80, 78, 71]).buffer;
beforeEach(() => {
  cached = new ArrayBuffer(0); frame = "ready";
  invoke.mockReset();
  invoke.mockImplementation(async (command) => command === "sftp_video_begin" ? "lease" : command === "sftp_video_open" ? { source_size: 1024, mime: "video/mp4" } : command === "sftp_video_poster_cached" ? cached : false);
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
  pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  load = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(function (this: HTMLVideoElement) {
    if (!this.getAttribute("src") || frame === "pending") return;
    queueMicrotask(() => { this.dispatchEvent(new Event("loadedmetadata")); this.dispatchEvent(new Event(frame === "error" ? "error" : "loadeddata")); });
  });
  vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(640);
  vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(360);
  draw = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback({ size: 4, arrayBuffer: async () => png } as Blob));
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("video range leases and posters", () => {
  it("opens an opaque protocol URL and cancels on abort without a transfer command", async () => {
    const controller = new AbortController();
    const source = await openSftpVideo("s", entry, controller.signal);
    expect(source.url).toBe("anyscp-video://localhost/lease");
    expect(source.url).not.toContain("movie.mp4");
    expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual(["sftp_video_begin", "sftp_video_open"]);
    expect(invoke).toHaveBeenCalledWith("sftp_video_begin", { sftpSessionId: "s", path: entry.id, thumbnail: false });
    controller.abort(); source.release();
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "sftp_video_cancel")).toHaveLength(1);
  });
  it("cancels a lease registered after the caller aborted without opening it", async () => {
    let finish!: (id: string) => void;
    invoke.mockImplementation((cmd) => cmd === "sftp_video_begin" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve());
    const controller = new AbortController();
    const pending = openSftpVideo("s", entry, controller.signal);
    controller.abort(); finish("late");
    await expect(pending).rejects.toThrow();
    expect(invoke).toHaveBeenCalledWith("sftp_video_cancel", { requestId: "late" });
    expect(invoke.mock.calls.some(([cmd]) => cmd === "sftp_video_open")).toBe(false);
  });
  it("uses cached poster bytes without starting the decoder", async () => {
    cached = png;
    expect(await loadSftpVideoPoster("s", entry, new AbortController().signal)).toBe(png);
    expect(draw).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledOnce(); // cleanup with no source
    expect(pause).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("sftp_video_cancel", { requestId: "lease" });
  });
  it("captures a bounded first frame without playing audio and sends binary PNG data", async () => {
    expect(await loadSftpVideoPoster("s", entry, new AbortController().signal)).toBe(png);
    const [video, , , width, height] = draw.mock.calls[0];
    expect([width, height]).toEqual([320, 180]);
    expect(video.muted).toBe(true);
    expect(video.autoplay).toBe(false);
    expect(video.getAttribute("src")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("sftp_video_poster_store", new Uint8Array(png), { headers: { "x-preview-id": "lease" } });
    expect(load).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalledOnce();
  });
  it("cancels pending poster I/O and does not save a late frame", async () => {
    frame = "pending";
    const controller = new AbortController();
    const pending = loadSftpVideoPoster("s", entry, controller.signal);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(draw).not.toHaveBeenCalled();
    expect(invoke.mock.calls.some(([cmd]) => cmd === "sftp_video_poster_store")).toBe(false);
    expect(invoke).toHaveBeenCalledWith("sftp_video_cancel", { requestId: "lease" });
  });
  it("waits for the short seek to finish before drawing a native frame", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(8);
    const pending = loadSftpVideoPoster("s", entry, new AbortController().signal);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    expect(draw).not.toHaveBeenCalled();
    const video = load.mock.instances[0] as HTMLVideoElement;
    expect(video.currentTime).toBe(0.1);
    video.dispatchEvent(new Event("seeked"));
    await pending;
    expect(draw).toHaveBeenCalledOnce();
  });
  it("retries transfer deferral while retaining the icon for unsupported codecs", async () => {
    frame = "error";
    invoke.mockImplementation(async (cmd) => cmd === "sftp_video_begin" ? "lease" : cmd === "sftp_video_open" ? { source_size: 1024, mime: "video/mp4" } : cmd === "sftp_video_poster_cached" ? cached : cmd === "sftp_video_deferred");
    await expect(loadSftpVideoPoster("s", entry, new AbortController().signal)).rejects.toEqual({ kind: "preview_deferred" });
    invoke.mockClear();
    vi.mocked(HTMLMediaElement.prototype.canPlayType).mockReturnValue("");
    await expect(loadSftpVideoPoster("s", entry, new AbortController().signal)).rejects.toThrow("does not support");
    expect(invoke).not.toHaveBeenCalled();
    expect(videoMime("clip.WEBM")).toBe("video/webm");
    expect(videoMime("clip.MOV")).toBe("video/quicktime");
    expect(videoMime("clip.mkv")).toBeNull();
  });
  it("bounds poster wait time and rejects excessive frame dimensions", async () => {
    vi.useFakeTimers(); frame = "pending";
    const result = loadSftpVideoPoster("s", entry, new AbortController().signal);
    const failed = expect(result).rejects.toThrow("Video poster unavailable");
    await vi.advanceTimersByTimeAsync(15_001);
    await failed;
    vi.useRealTimers(); frame = "ready";
    vi.mocked(Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, "videoWidth")!.get!).mockReturnValue(20_000);
    await expect(loadSftpVideoPoster("s", entry, new AbortController().signal)).rejects.toThrow();
    expect(draw).not.toHaveBeenCalled();
  });
});
