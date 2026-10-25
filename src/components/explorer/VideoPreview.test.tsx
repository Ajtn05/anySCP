import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { VideoPreview } from "./VideoPreview";
import { QuickLook } from "./QuickLook";
import type { ExplorerEntry } from "../../types/explorer";
const entry = { id: "/clip.mp4", name: "clip.mp4", entryType: "File", size: 100 } as ExplorerEntry;
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup() {
  const signals: AbortSignal[] = [];
  const source = { url: "anyscp-video://localhost/lease", mime: "video/mp4", sourceSize: 100, release: vi.fn(), deferred: vi.fn(async () => false) };
  const adapter = { open: vi.fn(async (_entry: ExplorerEntry, signal: AbortSignal) => { signals.push(signal); return source; }) };
  return { adapter, source, signals };
}
describe("video Quick Look", () => {
  it("does no stream or full-file I/O before an explicit load and preserves Download", async () => {
    const { adapter, source, signals } = setup();
    const load = vi.fn(), download = vi.fn();
    const view = render(<QuickLook adapter={{ supports: () => true, load, video: adapter }} entry={entry} entries={[entry]} onChange={vi.fn()} onClose={vi.fn()} onDownload={download} />);
    expect(load).not.toHaveBeenCalled(); expect(adapter.open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Load video" }));
    const media = await screen.findByLabelText(`Video preview: ${entry.name}`) as HTMLVideoElement;
    expect(media.controls).toBe(true); expect(media.autoplay).toBe(false);
    expect(media.preload).toBe("metadata"); expect(media).toHaveFocus();
    fireEvent.click(screen.getByLabelText("Download file")); expect(download).toHaveBeenCalledWith(entry);
    view.unmount(); expect(signals[0].aborted).toBe(true); expect(source.release).toHaveBeenCalled();
    expect(media.getAttribute("src")).toBeNull();
  });
  it("stops and releases playback for transfers, then requires an explicit resume", async () => {
    const { adapter, source, signals } = setup();
    const view = render(<VideoPreview adapter={adapter} entry={entry} busy={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Load video" }));
    const media = await screen.findByLabelText(`Video preview: ${entry.name}`) as HTMLVideoElement;
    media.currentTime = 12;
    view.rerender(<VideoPreview adapter={adapter} entry={entry} busy />);
    expect(signals[0].aborted).toBe(true); expect(source.release).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Resume video" })).toBeDisabled();
    expect(document.activeElement).not.toBe(document.body);
    view.rerender(<VideoPreview adapter={adapter} entry={entry} busy={false} />);
    expect(adapter.open).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Resume video" }));
    await waitFor(() => expect(adapter.open).toHaveBeenCalledTimes(2));
  });
  it("keeps codec and stream errors recoverable", async () => {
    const { adapter, source } = setup();
    render(<VideoPreview adapter={adapter} entry={entry} busy={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Load video" }));
    const media = await screen.findByLabelText(`Video preview: ${entry.name}`);
    fireEvent.error(media);
    expect(await screen.findByRole("alert")).toHaveTextContent("This video can't be played here. Download the file to open it.");
    expect(source.release).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Try video again" })).toBeEnabled();
  });
  it("rejects a late source when the preview closes while loading", async () => {
    const { adapter, source } = setup();
    let finish!: (value: typeof source) => void;
    adapter.open.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<VideoPreview adapter={adapter} entry={entry} busy={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Load video" })); view.unmount();
    await act(async () => finish(source)); expect(source.release).toHaveBeenCalledOnce();
  });
  it("keeps Escape inside the dialog while a video request is pending", () => {
    const { adapter } = setup();
    adapter.open.mockImplementation(() => new Promise(() => {}));
    const close = vi.fn();
    const view = render(<QuickLook adapter={{ supports: () => true, load: vi.fn(), video: adapter }} entry={entry} entries={[entry]} onChange={vi.fn()} onClose={close} onDownload={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Load video" }));
    expect(document.activeElement?.closest("[role='dialog']")).toBe(screen.getByRole("dialog"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
    view.unmount();
  });
});
