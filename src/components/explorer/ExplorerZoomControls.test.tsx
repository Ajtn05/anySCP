import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExplorerZoomControls } from "./ExplorerZoomControls";
import { ExplorerFileTable } from "./ExplorerFileTable";
import { useSettingsStore } from "../../stores/settings-store";
import { createSftpProvider } from "../../providers/sftp-provider";
import { createS3Provider } from "../../providers/s3-provider";
import type { ExplorerEntry } from "../../types/explorer";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

beforeEach(() => {
  useSettingsStore.setState({ explorerZoom: 100 });
});

describe("explorer zoom controls", () => {
  it("supports the slider, buttons, limits, and reset", () => {
    render(<ExplorerZoomControls />);
    const slider = screen.getByRole("slider", { name: "Explorer zoom" });
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(slider).toHaveValue("125");
    fireEvent.change(slider, { target: { value: "200" } });
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeDisabled();
    expect(slider).toHaveAttribute("aria-valuetext", "200%");
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(slider).toHaveValue("175");
    fireEvent.change(slider, { target: { value: "75" } });
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Reset explorer zoom" }));
    expect(slider).toHaveValue("100");
  });

  it.each(["MacIntel", "Win32"])("uses the platform modifier and ignores hidden tabs on %s", (platform) => {
    const platformMock = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const view = render(<><ExplorerZoomControls /><ExplorerZoomControls isActive={false} /></>);
    const modifier = platform === "MacIntel" ? { metaKey: true } : { ctrlKey: true };
    fireEvent.keyDown(document.body, { key: "=", ...modifier });
    expect(useSettingsStore.getState().explorerZoom).toBe(125);
    fireEvent.keyDown(document.body, { key: "+", shiftKey: true, ...modifier });
    expect(useSettingsStore.getState().explorerZoom).toBe(150);
    fireEvent.keyDown(document.body, { key: "-", ...modifier });
    expect(useSettingsStore.getState().explorerZoom).toBe(125);
    fireEvent.keyDown(document.body, { key: "0", ...modifier });
    expect(useSettingsStore.getState().explorerZoom).toBe(100);
    fireEvent.keyDown(document.body, { key: "+" });
    expect(useSettingsStore.getState().explorerZoom).toBe(100);
    view.rerender(<ExplorerZoomControls isActive={false} />);
    fireEvent.keyDown(document.body, { key: "+", ...modifier });
    expect(useSettingsStore.getState().explorerZoom).toBe(100);
    platformMock.mockRestore();
  });

  it("leaves shortcuts in editing fields, menus, and dialogs alone", () => {
    render(<>
      <ExplorerZoomControls />
      <input aria-label="Rename" />
      <textarea aria-label="Notes" />
      <div contentEditable suppressContentEditableWarning data-testid="editor">Editable</div>
      <div role="dialog"><button>Dialog action</button></div>
      <div role="menu"><button>Menu action</button></div>
    </>);
    for (const target of [screen.getByLabelText("Rename"), screen.getByLabelText("Notes"), screen.getByTestId("editor"),
      screen.getByText("Dialog action"), screen.getByText("Menu action"), screen.getByRole("slider")]) {
      const event = new KeyboardEvent("keydown", { key: "+", ctrlKey: true, metaKey: true, bubbles: true, cancelable: true });
      fireEvent(target, event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(useSettingsStore.getState().explorerZoom).toBe(100);
  });
});

const entry: ExplorerEntry = { name: "photo.jpg", id: "/photo.jpg", entryType: "File", size: 2048, modified: 1,
  permissions: 0o644, permissionsDisplay: "rw-r--r--", storageClass: null, isSymlink: false };

describe("explorer content zoom", () => {
  it.each(["sftp", "scp", "s3"] as const)("keeps selection, focus, and scroll when resizing %s content", (transport) => {
    const onDownloadMany = vi.fn();
    const props = { provider: transport === "s3" ? createS3Provider("s", "bucket") : createSftpProvider("s", transport),
      entries: [entry, { ...entry, id: "/other.jpg", name: "other.jpg" }], sortBy: "name" as const, sortAsc: true,
      clipboard: null, onSortChange: vi.fn(), onSetClipboard: vi.fn(), onNavigate: vi.fn(), onDownload: vi.fn(),
      onDownloadMany, onDelete: vi.fn(async () => {}) };
    const view = render(<ExplorerFileTable {...props} />);
    const row = screen.getByTestId("explorer-entry-photo.jpg");
    fireEvent.click(row);
    fireEvent.click(screen.getByTestId("explorer-entry-other.jpg"), { ctrlKey: true });
    row.focus();
    const scroller = view.container.querySelector<HTMLElement>("[data-explorer-scroll]")!;
    scroller.scrollTop = 80;
    act(() => useSettingsStore.getState().setExplorerZoom(150));
    expect(screen.getByTestId("explorer-entry-photo.jpg")).toBe(row);
    expect(row).toHaveFocus();
    expect(scroller.scrollTop).toBe(80);
    expect(row).toHaveStyle({ padding: "12px 12px" });
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole("menuitem", { name: "Download 2 items" }));
    expect(onDownloadMany.mock.calls[0][0]).toHaveLength(2);
    view.rerender(<ExplorerFileTable {...props} viewMode="grid" />);
    expect(screen.getByRole("slider")).toHaveValue("150");
    if (transport === "sftp") {
      expect(screen.getByRole("list")).toHaveStyle({ gridTemplateColumns: "repeat(auto-fill, minmax(min(216px, 100%), 1fr))" });
      expect(row.firstElementChild).toHaveStyle({ height: "144px" });
    }
  });
});
