import { afterEach, describe, expect, it, vi } from "vitest";
import { ThumbnailQueue } from "./thumbnail-queue";
const signal = () => new AbortController().signal;
const bytes = (n = 3) => new ArrayBuffer(n);
afterEach(() => vi.restoreAllMocks());

describe("thumbnail scheduling and memory cache", () => {
  it("looks up completed thumbnails synchronously without starting or joining work", async () => {
    const queue = new ThumbnailQueue(); let finish!: (data: ArrayBuffer) => void;
    const run = vi.fn(() => new Promise<ArrayBuffer>((resolve) => { finish = resolve; }));
    expect(queue.getCached("s", "photo")).toBeUndefined();
    const pending = queue.request("s", "photo", run, signal());
    expect(queue.getCached("s", "photo")).toBeUndefined();
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const data = bytes(); finish(data); await pending;
    expect(queue.getCached("s", "photo")).toBe(data);
    expect(queue.getCached("other", "photo")).toBeUndefined();
    queue.clear("s");
    expect(queue.getCached("s", "photo")).toBeUndefined();
    expect(run).toHaveBeenCalledOnce();
  });

  it("applies LRU and expiry to synchronous cache lookups", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100);
    const queue = new ThumbnailQueue(6, 2, 10);
    await queue.request("s", "a", async () => bytes(), signal());
    await queue.request("s", "b", async () => bytes(), signal());
    expect(queue.getCached("s", "a")).toBeDefined();
    await queue.request("s", "c", async () => bytes(), signal());
    expect(queue.getCached("s", "b")).toBeUndefined();
    now.mockReturnValue(110);
    expect(queue.getCached("s", "a")).toBeUndefined();
    expect(queue.getCached("s", "c")).toBeUndefined();
    await queue.request("s", "d", async () => bytes(), signal());
    expect(queue.getCached("s", "d")).toBeDefined();
  });

  it("deduplicates requests without cancelling another visible consumer", async () => {
    const queue = new ThumbnailQueue(); let finish!: (data: ArrayBuffer) => void;
    const run = vi.fn((_signal: AbortSignal) => new Promise<ArrayBuffer>((resolve) => { finish = resolve; }));
    const first = new AbortController();
    const a = queue.request("s", "photo", run, first.signal);
    const b = queue.request("s", "photo", run, signal());
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const rejected = expect(a).rejects.toMatchObject({ name: "AbortError" });
    first.abort(); await rejected;
    expect(run.mock.calls[0][0].aborted).toBe(false);
    finish(bytes()); await b;
    await queue.request("s", "photo", run, signal());
    expect(run).toHaveBeenCalledOnce();
  });

  it("runs one fetch at a time and never starts cancelled queued work", async () => {
    const queue = new ThumbnailQueue(); let finish!: (data: ArrayBuffer) => void;
    const first = vi.fn(() => new Promise<ArrayBuffer>((resolve) => { finish = resolve; }));
    const second = vi.fn(async () => bytes()); const controller = new AbortController();
    const a = queue.request("s", "a", first, signal());
    const b = queue.request("s", "b", second, controller.signal);
    await vi.waitFor(() => expect(first).toHaveBeenCalledOnce());
    expect(second).not.toHaveBeenCalled();
    const rejected = expect(b).rejects.toMatchObject({ name: "AbortError" }); controller.abort(); await rejected;
    finish(bytes()); await a;
    await queue.request("s", "c", second, signal());
    expect(second).toHaveBeenCalledOnce();
  });

  it("bounds memory with LRU eviction, expiry, and session isolation", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100);
    const queue = new ThumbnailQueue(6, 2, 10); const run = vi.fn(async () => bytes());
    await queue.request("one", "a", run, signal());
    await queue.request("one", "b", run, signal());
    await queue.request("one", "a", run, signal());
    expect(run).toHaveBeenCalledTimes(2);
    await queue.request("one", "c", run, signal());
    await queue.request("one", "b", run, signal());
    expect(run).toHaveBeenCalledTimes(4);
    await queue.request("two", "b", run, signal());
    expect(run).toHaveBeenCalledTimes(5);
    now.mockReturnValue(111);
    await queue.request("two", "b", run, signal());
    expect(run).toHaveBeenCalledTimes(6);
  });

  it("invalidates in-flight results and preserves other sessions", async () => {
    const queue = new ThumbnailQueue(); let finish!: (data: ArrayBuffer) => void;
    const run = vi.fn(async () => bytes());
    await queue.request("other", "photo", run, signal());
    const pending = queue.request("s", "photo", () => new Promise((resolve) => { finish = resolve; }), signal());
    await vi.waitFor(() => expect(finish).toBeDefined());
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" }); queue.clear("s"); await rejected;
    finish(bytes());
    await queue.request("s", "photo", run, signal());
    await queue.request("other", "photo", run, signal());
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not reuse entries when source metadata cannot be trusted", async () => {
    const queue = new ThumbnailQueue(); const run = vi.fn(async () => bytes());
    await queue.request("s", "photo", run, signal(), false);
    await queue.request("s", "photo", run, signal(), false);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
