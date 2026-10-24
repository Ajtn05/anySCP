import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ExplorerFileTable } from "./ExplorerFileTable";
import { createSftpProvider } from "../../providers/sftp-provider";
import type { ExplorerEntry } from "../../types/explorer";

const file = (name: string): ExplorerEntry => ({ name, id: `/${name}`, entryType: "File", size: 1, modified: null,
  permissions: 0o644, permissionsDisplay: "rw-r--r--", isSymlink: false, storageClass: null });
const entries = [file("b.txt"), file("a.txt"), { ...file("dir"), entryType: "Directory" as const }];
function table(transport: "sftp" | "scp" = "sftp") {
  const onPreview = vi.fn(), onDownload = vi.fn();
  const result = render(<ExplorerFileTable provider={createSftpProvider("s", transport)} entries={entries} sortBy="name" sortAsc
    onSortChange={() => {}} clipboard={null} onSetClipboard={() => {}} onNavigate={() => {}} onDownload={onDownload}
    onPreview={onPreview} onDelete={async () => {}} onRename={async () => {}} />);
  return { ...result, onPreview, onDownload };
}
describe("Explorer preview actions", () => {
  it("opens with Space in display order without downloading", () => {
    const { onPreview, onDownload } = table();
    fireEvent.keyDown(screen.getByTestId("explorer-entry-b.txt"), { key: " " });
    expect(onPreview.mock.calls[0][0].name).toBe("b.txt");
    expect(onPreview.mock.calls[0][1].map((entry: ExplorerEntry) => entry.name)).toEqual(["dir", "a.txt", "b.txt"]);
    expect(onDownload).not.toHaveBeenCalled();
  });
  it("does not intercept Space in rename fields, directories, or repeated keys", () => {
    const { onPreview } = table();
    fireEvent.keyDown(screen.getByTestId("explorer-entry-dir"), { key: " " });
    const row = screen.getByTestId("explorer-entry-b.txt");
    fireEvent.keyDown(row, { key: " ", repeat: true });
    fireEvent.keyDown(row, { key: "F2" });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: " " });
    expect(onPreview).not.toHaveBeenCalled();
  });
  it("offers Quick Look in the menu and restores focus to the source row", () => {
    const { onPreview } = table();
    const row = screen.getByTestId("explorer-entry-b.txt");
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole("menuitem", { name: "Quick Look" }));
    expect(onPreview).toHaveBeenCalledOnce();
    expect(row).toHaveFocus();
  });
  it("never offers a preview on SCP even when a callback is present", () => {
    const { onPreview } = table("scp");
    const row = screen.getByTestId("explorer-entry-a.txt");
    fireEvent.keyDown(row, { key: " " });
    fireEvent.contextMenu(row);
    expect(screen.queryByRole("menuitem", { name: "Quick Look" })).toBeNull();
    expect(onPreview).not.toHaveBeenCalled();
  });
});
