import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Thumbnail } from "./Thumbnail";
import type { ExplorerEntry } from "../../types/explorer";
const entry = { id: "/photo.jpg", name: "photo.jpg", entryType: "File", size: 100, modified: 1 } as ExplorerEntry;
let observed: Map<Element, IntersectionObserverCallback>;
let signals: AbortSignal[];
let create: ReturnType<typeof vi.fn>, revoke: ReturnType<typeof vi.fn>;
beforeEach(() => {
  signals = []; observed = new Map();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(node: Element) { observed.set(node, this.callback); }
    unobserve(node: Element) { observed.delete(node); }
    disconnect() {}
  });
  create = vi.fn(() => "blob:thumbnail"); revoke = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
});
afterEach(() => vi.unstubAllGlobals());
function visibility(visible: boolean) {
  act(() => { for (const [target, callback] of observed) callback([{ target, isIntersecting: visible } as IntersectionObserverEntry], {} as IntersectionObserver); });
}
function setup() {
  const adapter = { supports: () => true, load: vi.fn(async (_entry: ExplorerEntry, signal: AbortSignal) => { signals.push(signal); return new ArrayBuffer(8); }), clear: async () => {} };
  const component = (active = true, paused = false) => <div data-explorer-scroll><Thumbnail entry={entry} adapter={adapter} active={active} paused={paused} fallback={<span>File icon</span>} /></div>;
  return { adapter, component };
}
describe("visible thumbnail loading", () => {
  it("does no I/O until visible, then releases decoded images offscreen", async () => {
    const { adapter, component } = setup(); render(component());
    expect(adapter.load).not.toHaveBeenCalled(); visibility(true);
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(signals[0].aborted).toBe(false); visibility(false);
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:thumbnail"));
    expect(signals[0].aborted).toBe(true);
  });
  it("pauses fetches during transfers, resumes, and cancels hidden tabs", async () => {
    const { adapter, component } = setup(); const view = render(component(true, true)); visibility(true);
    expect(adapter.load).not.toHaveBeenCalled(); view.rerender(component(true, false));
    await waitFor(() => expect(adapter.load).toHaveBeenCalledOnce());
    view.rerender(component(false, false)); expect(signals[0].aborted).toBe(true);
    expect(observed.size).toBe(0);
  });
  it("keeps a file icon when thumbnail data cannot be displayed", async () => {
    const { component } = setup(); const view = render(component()); visibility(true);
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    fireEvent.error(view.container.querySelector("img")!);
    expect(screen.getByText("File icon")).toBeVisible();
  });
});
