import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExplorerFileTable } from "./ExplorerFileTable";
import { createSftpProvider } from "../../providers/sftp-provider";
import { createS3Provider } from "../../providers/s3-provider";
import { ExplorerToolbar } from "./ExplorerToolbar";
import type { ExplorerEntry } from "../../types/explorer";

const file = (name: string): ExplorerEntry => ({ name, id: `/${name}`, size: 100, modified: 1, entryType: "File",
  permissions: 0o644, permissionsDisplay: "rw-r--r--", storageClass: null, isSymlink: false });
const entries = [{ ...file("folder"), entryType: "Directory" as const }, file("a.jpg"), file("b.png")];
function setup() {
  const props = { provider: createSftpProvider("s"), entries, sortBy: "name" as const, sortAsc: true, clipboard: null,
    onSortChange: vi.fn(), onSetClipboard: vi.fn(), onNavigate: vi.fn(), onDownload: vi.fn(), onDownloadMany: vi.fn(),
    onPreview: vi.fn(), onDelete: vi.fn(async () => {}), onRename: vi.fn(async () => {}) };
  const view = render(<ExplorerFileTable {...props} viewMode="grid" thumbnailsPaused />);
  return { props, view };
}
describe("thumbnail grid shares explorer actions", () => {
  it("preserves selection and batch downloads when switching back to list", () => {
    const { props, view } = setup();
    fireEvent.click(screen.getByTestId("explorer-entry-a.jpg"));
    fireEvent.click(screen.getByTestId("explorer-entry-b.png"), { ctrlKey: true });
    view.rerender(<ExplorerFileTable {...props} viewMode="list" />);
    fireEvent.contextMenu(screen.getByTestId("explorer-entry-a.jpg"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Download 2 items" }));
    expect(props.onDownloadMany.mock.calls[0][0].map((entry: ExplorerEntry) => entry.name)).toEqual(["a.jpg", "b.png"]);
  });
  it("keeps directory navigation, Quick Look, and rename working", () => {
    const { props } = setup();
    fireEvent.doubleClick(screen.getByTestId("explorer-entry-folder"));
    expect(props.onNavigate).toHaveBeenCalledWith("/folder");
    const row = screen.getByTestId("explorer-entry-a.jpg");
    fireEvent.keyDown(row, { key: " " });
    expect(props.onPreview).toHaveBeenCalled(); expect(props.onDownload).not.toHaveBeenCalled();
    fireEvent.keyDown(row, { key: "F2" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "renamed.jpg" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(props.onRename).toHaveBeenCalledWith(entries[1], "renamed.jpg");
  });
  it("moves vertically by the number of grid columns", () => {
    setup();
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
    const styles = vi.spyOn(window, "getComputedStyle").mockReturnValue({ gridTemplateColumns: "150px 150px" } as CSSStyleDeclaration);
    const folder = screen.getByTestId("explorer-entry-folder"); folder.focus();
    fireEvent.keyDown(folder, { key: "ArrowDown" });
    expect(screen.getByTestId("explorer-entry-b.png")).toHaveFocus();
    fireEvent.keyDown(screen.getByTestId("explorer-entry-b.png"), { key: "ArrowLeft" });
    expect(screen.getByTestId("explorer-entry-a.jpg")).toHaveFocus();
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    styles.mockRestore(); Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });
});

describe("grid toolbar controls", () => {
  it("only offers thumbnail controls on an adapter that supports them", () => {
    const onViewModeChange = vi.fn(), onClearThumbnails = vi.fn();
    const props = { currentPath: "/", segments: [], loading: false, onRefresh: vi.fn(), onNewFolder: vi.fn(),
      onNewFile: vi.fn(), onNavigate: vi.fn(), onUpload: vi.fn(), onViewModeChange, onClearThumbnails };
    const view = render(<ExplorerToolbar {...props} provider={createSftpProvider("s")} viewMode="grid" />);
    expect(screen.getByLabelText("Thumbnail view")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByLabelText("List view")); expect(onViewModeChange).toHaveBeenCalledWith("list");
    fireEvent.click(screen.getByLabelText("Clear thumbnail cache")); expect(onClearThumbnails).toHaveBeenCalledOnce();
    view.rerender(<ExplorerToolbar {...props} provider={createSftpProvider("s")} viewMode="grid" thumbnailCacheBusy />);
    fireEvent.click(screen.getByLabelText("Clear thumbnail cache")); expect(onClearThumbnails).toHaveBeenCalledOnce();
    view.rerender(<ExplorerToolbar {...props} provider={createS3Provider("s", "bucket")} />);
    expect(screen.queryByLabelText("Thumbnail view")).toBeNull();
    view.rerender(<ExplorerToolbar {...props} provider={createSftpProvider("s", "scp")} />);
    expect(screen.queryByLabelText("Thumbnail view")).toBeNull();
  });
});
