import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QuickLook } from "./QuickLook";
import type { ExplorerEntry } from "../../types/explorer";
import type { PreviewAdapter, PreviewData } from "../../types/preview";

const first = { id: "/a.txt", name: "a.txt", size: 5, entryType: "File" } as ExplorerEntry;
const second = { ...first, id: "/b.txt", name: "b.txt" };
const data: PreviewData = { kind: "text", sourceSize: 5, truncated: true, bytes: new TextEncoder().encode("<script>bad()</script>").buffer };
const props = (adapter: PreviewAdapter) => ({ adapter, entry: first, entries: [first, second], onChange: vi.fn(), onClose: vi.fn(), onDownload: vi.fn() });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function imageUrls() {
  let next = 0;
  const createObjectURL = vi.fn((_blob: Blob) => `blob:preview-${++next}`), revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  return { createObjectURL, revokeObjectURL };
}

describe("Quick Look", () => {
  it("shows a cached thumbnail immediately and upgrades it without another thumbnail request", async () => {
    const urls = imageUrls();
    const image = { ...first, id: "/photo.jpg", name: "photo.jpg" };
    const cached = new ArrayBuffer(3);
    let finish!: (result: PreviewData) => void;
    const load = vi.fn(() => new Promise<PreviewData>((resolve) => { finish = resolve; }));
    const loadThumbnail = vi.fn();
    const p = props({ supports: () => true, load, thumbnails: {
      supports: () => true, getCached: () => cached, load: loadThumbnail, clear: vi.fn(),
    } });
    const view = render(<QuickLook {...p} entry={image} entries={[image]} />);
    expect(screen.getByRole("img", { name: image.name })).toHaveAttribute("src", "blob:preview-1");
    expect(screen.getByRole("status")).toHaveTextContent("Loading full preview…");
    expect(screen.queryByText("Loading preview…")).toBeNull();
    expect(screen.getByRole("img").closest("[aria-busy]")).toHaveAttribute("aria-busy", "true");
    expect(load).toHaveBeenCalledOnce();
    expect(loadThumbnail).not.toHaveBeenCalled();
    const full: PreviewData = { kind: "image", bytes: new ArrayBuffer(10), sourceSize: image.size, truncated: false };
    await act(async () => finish(full));
    expect(screen.getByRole("img", { name: image.name })).toHaveAttribute("src", "blob:preview-2");
    expect(screen.queryByRole("status")).toBeNull();
    expect(urls.createObjectURL.mock.calls.map(([blob]) => (blob as Blob).size)).toEqual([3, 10]);
    expect(urls.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
    view.unmount();
    expect(urls.revokeObjectURL).toHaveBeenCalledWith("blob:preview-2");
  });

  it("keeps the cached image and original download available if the full preview fails", async () => {
    imageUrls();
    const image = { ...first, id: "/photo.NEF", name: "photo.NEF" };
    const p = props({ supports: () => true, load: async () => { throw { message: "Preview timed out" }; }, thumbnails: {
      supports: () => true, getCached: () => new ArrayBuffer(3), load: vi.fn(), clear: vi.fn(),
    } });
    render(<QuickLook {...p} entry={image} entries={[image]} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Showing cached thumbnail. Preview timed out");
    expect(screen.getByRole("img", { name: image.name })).toHaveAttribute("src", "blob:preview-1");
    expect(screen.getByRole("img").closest("[aria-busy]")).toHaveAttribute("aria-busy", "false");
    fireEvent.click(screen.getByLabelText("Download file"));
    expect(p.onDownload).toHaveBeenCalledWith(image);
  });

  it("switches cached images on navigation, clears cache misses, and ignores late previews", async () => {
    const urls = imageUrls();
    const images = ["a.jpg", "b.jpg", "c.jpg"].map((name) => ({ ...first, name, id: `/${name}` }));
    const cached = [new ArrayBuffer(3), new ArrayBuffer(4)];
    const signals: AbortSignal[] = [], pending: ((result: PreviewData) => void)[] = [];
    const p = props({ supports: () => true, load: (_entry, signal) => {
      signals.push(signal); return new Promise((resolve) => pending.push(resolve));
    }, thumbnails: {
      supports: () => true, getCached: (entry) => cached[images.findIndex((image) => image.id === entry.id)],
      load: vi.fn(), clear: vi.fn(),
    } });
    const view = render(<QuickLook {...p} entry={images[0]} entries={images} />);
    expect(screen.getByRole("img", { name: images[0].name })).toHaveAttribute("src", "blob:preview-1");
    view.rerender(<QuickLook {...p} entry={images[1]} entries={images} />);
    expect(signals[0].aborted).toBe(true);
    expect(screen.getByRole("img", { name: images[1].name })).toHaveAttribute("src", "blob:preview-2");
    expect(urls.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
    const full: PreviewData = { kind: "image", bytes: new ArrayBuffer(10), sourceSize: 5, truncated: false };
    await act(async () => pending[0](full));
    expect(urls.createObjectURL).toHaveBeenCalledTimes(2);
    view.rerender(<QuickLook {...p} entry={images[2]} entries={images} />);
    expect(signals[1].aborted).toBe(true);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Loading preview…");
    expect(urls.revokeObjectURL).toHaveBeenCalledWith("blob:preview-2");
    await act(async () => pending[1](full));
    expect(screen.queryByRole("img")).toBeNull();
    await act(async () => pending[2](full));
    expect(screen.getByRole("img", { name: images[2].name })).toHaveAttribute("src", "blob:preview-3");
    view.unmount(); expect(signals[2].aborted).toBe(true);
    expect(urls.revokeObjectURL).toHaveBeenCalledWith("blob:preview-3");
  });

  it("renders escaped text and truncation, and keeps download explicit", async () => {
    const p = props({ supports: () => true, load: vi.fn(async () => data) });
    const { container } = render(<QuickLook {...p} />);
    expect(await screen.findByLabelText("File contents")).toHaveTextContent("<script>bad()</script>");
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText(/Showing part of this file/)).toBeVisible();
    expect(p.onDownload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Download file"));
    expect(p.onDownload).toHaveBeenCalledWith(first);
  });

  it("navigates in supplied order, traps focus, and restores focus on close", async () => {
    const origin = document.createElement("button"); document.body.append(origin); origin.focus();
    const p = props({ supports: () => true, load: async () => data });
    const view = render(<QuickLook {...p} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(p.onChange).toHaveBeenCalledWith(second);
    const close = screen.getByLabelText("Close preview"); close.focus();
    fireEvent.keyDown(close, { key: "Tab" });
    expect(screen.getByLabelText("Next file")).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(p.onClose).toHaveBeenCalledOnce();
    await act(async () => view.unmount());
    expect(origin).toHaveFocus(); origin.remove();
  });

  it("cancels on a changed selection and ignores stale content", async () => {
    const signals: AbortSignal[] = [];
    const pending: ((result: PreviewData) => void)[] = [];
    const adapter: PreviewAdapter = { supports: () => true, load: (_entry, signal) => {
      signals.push(signal); return new Promise((resolve) => pending.push(resolve));
    } };
    const p = props(adapter);
    const view = render(<QuickLook {...p} />);
    view.rerender(<QuickLook {...p} entry={second} />);
    expect(signals[0].aborted).toBe(true);
    await act(async () => pending[0](data));
    expect(screen.queryByLabelText("File contents")).toBeNull();
    await act(async () => pending[1]({ ...data, bytes: new TextEncoder().encode("second file").buffer }));
    expect(screen.getByLabelText("File contents")).toHaveTextContent("second file");
    view.unmount(); expect(signals[1].aborted).toBe(true);
  });

  it("shows failures without replacing explorer or transfer state", async () => {
    render(<QuickLook {...props({ supports: () => true, load: async () => { throw { message: "Permission denied" }; } })} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Permission denied"));
  });

  it("keeps keyboard focus when navigation disables the clicked button", async () => {
    const p = props({ supports: () => true, load: async () => data });
    const view = render(<QuickLook {...p} />);
    const next = screen.getByLabelText("Next file"); next.focus();
    fireEvent.click(next);
    view.rerender(<QuickLook {...p} entry={second} />);
    expect(screen.getByRole("dialog")).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(p.onClose).toHaveBeenCalledOnce();
    await act(async () => {});
  });

  it("previews a RAW photo and downloads the original entry", async () => {
    const createObjectURL = vi.fn(() => "blob:raw-preview");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    try {
      const raw = { ...first, id: "/photo.NEF", name: "photo.NEF", size: 50 * 1024 * 1024 };
      const p = props({ supports: () => true, load: async () => ({ kind: "image", sourceSize: raw.size, truncated: false, bytes: new ArrayBuffer(4) }) });
      const view = render(<QuickLook {...p} entry={raw} entries={[raw]} />);
      expect(screen.getByText(/Quick Look/)).toHaveTextContent("50.0 MB");
      expect(await screen.findByRole("img", { name: raw.name })).toHaveAttribute("src", "blob:raw-preview");
      fireEvent.click(screen.getByLabelText("Download file"));
      expect(p.onDownload).toHaveBeenCalledWith(raw);
      expect(createObjectURL).toHaveBeenCalledOnce();
      view.unmount();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:raw-preview");
    } finally { vi.unstubAllGlobals(); }
  });
});
