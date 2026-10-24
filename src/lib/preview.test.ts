import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSftpPreviewAdapter, decodePreview, previewKind } from "./preview";
import { createSftpProvider } from "../providers/sftp-provider";
import { createS3Provider } from "../providers/s3-provider";
import type { ExplorerEntry } from "../types/explorer";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const entry = { id: "/notes.txt", name: "notes.txt", entryType: "File" } as ExplorerEntry;

function packet(kind = "text") {
  const metadata = new TextEncoder().encode(JSON.stringify({ kind, source_size: 3, truncated: false }));
  const result = new Uint8Array(4 + metadata.length + 3);
  new DataView(result.buffer).setUint32(0, metadata.length, true);
  result.set(metadata, 4);
  result.set(new TextEncoder().encode("abc"), 4 + metadata.length);
  return result.buffer;
}

describe("SFTP previews", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (command) => command === "sftp_preview_begin" ? "request" : command === "sftp_preview_read" ? packet() : undefined);
  });

  it("uses a separate read-only command surface and binary metadata", async () => {
    const data = await createSftpPreviewAdapter("session").load(entry, new AbortController().signal);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["sftp_preview_begin", "sftp_preview_read", "sftp_preview_cancel"]);
    expect(invoke).toHaveBeenCalledWith("sftp_preview_begin", { sftpSessionId: "session", path: "/notes.txt" });
    expect(data).toMatchObject({ kind: "text", sourceSize: 3, truncated: false });
    expect(new TextDecoder().decode(data.bytes)).toBe("abc");
  });

  it("does not start I/O if cancelled while registering the request", async () => {
    let registered!: (id: string) => void;
    invoke.mockImplementation((command) => command === "sftp_preview_begin" ? new Promise((resolve) => { registered = resolve; }) : Promise.resolve());
    const controller = new AbortController();
    const pending = createSftpPreviewAdapter("s").load(entry, controller.signal);
    controller.abort();
    registered("request");
    await expect(pending).rejects.toThrow();
    expect(invoke).toHaveBeenCalledWith("sftp_preview_cancel", { requestId: "request" });
    expect(invoke.mock.calls.some(([command]) => command === "sftp_preview_read")).toBe(false);
  });

  it("cancels backend work immediately and rejects a late result", async () => {
    let finish!: (bytes: ArrayBuffer) => void;
    invoke.mockImplementation(async (command) => command === "sftp_preview_begin" ? "request" : command === "sftp_preview_read" ? new Promise((resolve) => { finish = resolve; }) : undefined);
    const controller = new AbortController();
    const pending = createSftpPreviewAdapter("s").load(entry, controller.signal);
    await vi.waitFor(() => expect(finish).toBeDefined());
    controller.abort();
    expect(invoke).toHaveBeenCalledWith("sftp_preview_cancel", { requestId: "request" });
    finish(packet());
    await expect(pending).rejects.toThrow();
  });

  it("rejects malformed framing and metadata", () => {
    expect(() => decodePreview(new ArrayBuffer(1))).toThrow();
    expect(() => decodePreview(new Uint8Array([255, 255, 255, 255]).buffer)).toThrow();
    expect(() => decodePreview(packet("html"))).toThrow();
  });

  it("keeps S3 and SCP outside the preview feature", () => {
    expect(createSftpProvider("s", "scp").preview).toBeUndefined();
    expect(createS3Provider("s", "bucket").preview).toBeUndefined();
    expect(createSftpProvider("s").preview?.supports({ ...entry, entryType: "Directory" })).toBe(false);
  });

  it("recognizes initial formats without treating arbitrary binaries as text", () => {
    expect(previewKind("PHOTO.JPEG")).toBe("image");
    expect(previewKind("report.pdf")).toBe("pdf");
    expect(previewKind(".env.local")).toBe("text");
    expect(previewKind("Dockerfile")).toBe("text");
    expect(previewKind("archive.zip")).toBeNull();
    expect(previewKind("movie.mov")).toBeNull();
  });

  it("uses thumbnail requests with a separate source-size policy", async () => {
    const adapter = createSftpPreviewAdapter("thumb-session").thumbnails!;
    const image = { ...entry, name: "photo.jpg", size: 100, modified: 1 };
    expect(adapter.supports(image)).toBe(true);
    expect(adapter.supports({ ...image, size: 9 * 1024 * 1024 })).toBe(false);
    expect(adapter.supports({ ...image, name: "file.pdf" })).toBe(false);
    await adapter.load(image, new AbortController().signal);
    expect(invoke).toHaveBeenCalledWith("sftp_preview_begin", { sftpSessionId: "thumb-session", path: entry.id, thumbnail: true });
    await adapter.clear();
    expect(invoke).toHaveBeenCalledWith("sftp_thumbnail_clear", { sftpSessionId: "thumb-session" });
  });
});
