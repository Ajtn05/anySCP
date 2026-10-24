import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QuickLook } from "./QuickLook";
import type { ExplorerEntry } from "../../types/explorer";
import type { PreviewAdapter, PreviewData } from "../../types/preview";

const first = { id: "/a.txt", name: "a.txt", size: 5, entryType: "File" } as ExplorerEntry;
const second = { ...first, id: "/b.txt", name: "b.txt" };
const data: PreviewData = { kind: "text", sourceSize: 5, truncated: true, bytes: new TextEncoder().encode("<script>bad()</script>").buffer };
const props = (adapter: PreviewAdapter) => ({ adapter, entry: first, entries: [first, second], onChange: vi.fn(), onClose: vi.fn(), onDownload: vi.fn() });

describe("Quick Look", () => {
  it("renders escaped text and truncation, and keeps download explicit", async () => {
    const p = props({ supports: () => true, load: vi.fn(async () => data) });
    const { container } = render(<QuickLook {...p} />);
    expect(await screen.findByLabelText("File contents")).toHaveTextContent("<script>bad()</script>");
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText(/Showing the first 512 KiB/)).toBeVisible();
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

  it("labels the embedded RAW JPEG and downloads the original entry", async () => {
    const createObjectURL = vi.fn(() => "blob:raw-preview");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    try {
      const raw = { ...first, id: "/photo.NEF", name: "photo.NEF", size: 50 * 1024 * 1024 };
      const p = props({ supports: () => true, load: async () => ({ kind: "image", sourceSize: raw.size, truncated: false, bytes: new ArrayBuffer(4) }) });
      const view = render(<QuickLook {...p} entry={raw} entries={[raw]} />);
      expect(screen.getByText(/Embedded JPEG · Quick Look/)).toHaveTextContent("50.0 MB");
      expect(await screen.findByRole("img", { name: raw.name })).toHaveAttribute("src", "blob:raw-preview");
      fireEvent.click(screen.getByLabelText("Download file"));
      expect(p.onDownload).toHaveBeenCalledWith(raw);
      expect(createObjectURL).toHaveBeenCalledOnce();
      view.unmount();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:raw-preview");
    } finally { vi.unstubAllGlobals(); }
  });
});
