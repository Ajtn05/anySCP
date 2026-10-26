import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExplorerFileTable } from "./ExplorerFileTable";
import { ExplorerToolbar } from "./ExplorerToolbar";
import { createSftpProvider } from "../../providers/sftp-provider";
import { createS3Provider } from "../../providers/s3-provider";
import { useSettingsStore } from "../../stores/settings-store";
import type { ExplorerEntry, FileSystemProvider } from "../../types/explorer";

const file = (name: string, entryType: ExplorerEntry["entryType"] = "File"): ExplorerEntry => ({
  id: `/photos/${name}`, name, entryType, size: 100, modified: 1,
  permissions: 0o644, permissionsDisplay: "rw-r--r--", storageClass: null, isSymlink: false,
});
const entries = [file(".ssh", "Directory"), file(".secret.jpg"), file("a.jpg"), file("family.photo.jpg")];
beforeEach(() => useSettingsStore.setState({ explorerShowHiddenFiles: true }));
afterEach(() => useSettingsStore.setState({ explorerShowHiddenFiles: true }));

function setup(provider = createSftpProvider("s"), viewMode: "list" | "grid" = "list", files = entries) {
  const props = { provider, entries: files, sortBy: "name" as const, sortAsc: true,
    onSortChange: vi.fn(), clipboard: null, onSetClipboard: vi.fn(), onNavigate: vi.fn(),
    onDownload: vi.fn(), onDownloadMany: vi.fn(), onDelete: vi.fn(async () => {}), onPreview: vi.fn() };
  const view = render(<ExplorerFileTable {...props} viewMode={viewMode} thumbnailsPaused />);
  return { props, view };
}

describe("hidden files in the shared explorer", () => {
  const providers: [string, FileSystemProvider][] = [
    ["SFTP", createSftpProvider("s")], ["SCP", createSftpProvider("s", "scp")],
    ["S3", createS3Provider("s", "bucket")],
  ];
  it.each(providers)("filters dotfiles and folders on %s without changing source entries", (_name, provider) => {
    setup(provider);
    expect(screen.getByTestId("explorer-entry-.ssh")).toBeVisible();
    act(() => useSettingsStore.getState().setExplorerShowHiddenFiles(false));
    expect(screen.queryByTestId("explorer-entry-.ssh")).toBeNull();
    expect(screen.queryByTestId("explorer-entry-.secret.jpg")).toBeNull();
    expect(screen.getByTestId("explorer-entry-family.photo.jpg")).toBeVisible();
    expect(entries).toHaveLength(4);
    act(() => useSettingsStore.getState().setExplorerShowHiddenFiles(true));
    expect(screen.getByTestId("explorer-entry-.secret.jpg")).toBeVisible();
  });

  it("keeps hidden photos out of thumbnail browsing and Quick Look navigation", () => {
    useSettingsStore.setState({ explorerShowHiddenFiles: false });
    const { props, view } = setup(createSftpProvider("s"), "grid");
    expect(view.container.querySelector("[data-view-mode='grid']")).toBeInTheDocument();
    expect(screen.queryByTestId("explorer-entry-.secret.jpg")).toBeNull();
    fireEvent.keyDown(screen.getByTestId("explorer-entry-a.jpg"), { key: " " });
    expect(props.onPreview.mock.calls[0][1].map((entry: ExplorerEntry) => entry.name))
      .toEqual(["a.jpg", "family.photo.jpg"]);
  });

  it("removes newly hidden selections from later downloads, including after revealing them again", () => {
    const { props } = setup();
    fireEvent.click(screen.getByTestId("explorer-entry-.secret.jpg"));
    fireEvent.click(screen.getByTestId("explorer-entry-a.jpg"), { ctrlKey: true });
    act(() => useSettingsStore.getState().setExplorerShowHiddenFiles(false));
    act(() => useSettingsStore.getState().setExplorerShowHiddenFiles(true));
    fireEvent.contextMenu(screen.getByTestId("explorer-entry-a.jpg"));
    expect(screen.queryByRole("menuitem", { name: "Download 2 items" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Download" }));
    expect(props.onDownload).toHaveBeenCalledWith(entries[2]);
  });

  it("selects only visible files for batch downloads", () => {
    useSettingsStore.setState({ explorerShowHiddenFiles: false });
    const { props } = setup();
    const row = screen.getByTestId("explorer-entry-a.jpg");
    fireEvent.keyDown(row, { key: "a", ctrlKey: true });
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole("menuitem", { name: "Download 2 items" }));
    expect(props.onDownloadMany.mock.calls[0][0].map((entry: ExplorerEntry) => entry.name))
      .toEqual(["a.jpg", "family.photo.jpg"]);
  });

  it("offers to reveal hidden items instead of claiming the folder is empty", () => {
    useSettingsStore.setState({ explorerShowHiddenFiles: false });
    setup(createSftpProvider("s"), "list", entries.slice(0, 2));
    expect(screen.getByText("No visible items")).toBeVisible();
    expect(screen.queryByText("This folder is empty")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show hidden files" }));
    expect(screen.getByTestId("explorer-entry-.ssh")).toBeVisible();
  });

  it("shares the saved toolbar preference across explorers without refreshing listings", () => {
    const onRefresh = vi.fn();
    render(<ExplorerToolbar provider={createSftpProvider("s")} currentPath="/photos" segments={[]}
      loading={false} onNavigate={vi.fn()} onRefresh={onRefresh} onUpload={vi.fn()}
      onNewFile={vi.fn()} onNewFolder={vi.fn()} />);
    setup();
    const toggle = screen.getByRole("button", { name: "Show hidden files" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("explorer-entry-.secret.jpg")).toBeNull();
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
