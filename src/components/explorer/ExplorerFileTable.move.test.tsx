import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createSftpProvider } from "../../providers/sftp-provider";
import { createS3Provider } from "../../providers/s3-provider";
import type { ExplorerEntry } from "../../types/explorer";
import { ExplorerFileTable } from "./ExplorerFileTable";
import { ExplorerToolbar } from "./ExplorerToolbar";

const currentPath = "/home/user/inbox";
const entry = (name: string, directory = false): ExplorerEntry => ({
  id: `${currentPath}/${name}`, name, entryType: directory ? "Directory" : "File", size: 1,
  modified: null, permissions: 0o644, permissionsDisplay: null, isSymlink: false, storageClass: null,
});
const entries = [entry("report.txt"), entry("photos", true), entry("archive", true)];
const elementFromPoint = vi.fn();

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: elementFromPoint });
  elementFromPoint.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "elementFromPoint");
});

function setup({ viewMode = "list", transport = "sftp", s3 = false, busy = false }:
  { viewMode?: "list" | "grid"; transport?: "sftp" | "scp"; s3?: boolean; busy?: boolean } = {}) {
  const onMoveEntries = vi.fn(async () => {}), onCopyEntries = vi.fn(async () => {});
  const onNavigate = vi.fn();
  const onListDirectory = vi.fn(async () => [] as ExplorerEntry[]);
  const provider = s3 ? createS3Provider("s", "bucket") : createSftpProvider("s", transport);
  function Explorer() {
    const [target, setTarget] = useState<string | null>(null);
    return <>
      <ExplorerToolbar provider={provider} currentPath={currentPath} loading={false} busy={busy}
        segments={[{ label: "/", path: "/" }, { label: "home", path: "/home" },
          { label: "user", path: "/home/user" }, { label: "inbox", path: currentPath }]}
        onRefresh={vi.fn()} onNewFolder={vi.fn()} onNewFile={vi.fn()} onUpload={vi.fn()}
        onNavigate={onNavigate} dropTargetPath={target} />
      <ExplorerFileTable provider={provider} entries={entries} sortBy="name" sortAsc currentPath={currentPath}
        clipboard={null} onSetClipboard={vi.fn()} onSortChange={vi.fn()} onNavigate={onNavigate}
        onDownload={vi.fn()} onDelete={vi.fn(async () => {})} onMoveEntries={onMoveEntries}
        onCopyEntries={onCopyEntries} onListDirectory={onListDirectory} onDropTargetChange={setTarget}
        viewMode={viewMode} thumbnailsPaused busy={busy} />
    </>;
  }
  const view = render(<Explorer />);
  return { onMoveEntries, onCopyEntries, onNavigate, onListDirectory, view };
}

function dragTo(source: HTMLElement, target: HTMLElement, altKey = false) {
  elementFromPoint.mockReturnValue(target);
  fireEvent.pointerDown(source, { button: 0, clientX: 80, clientY: 150 });
  fireEvent.pointerMove(window, { clientX: 100, clientY: 20, altKey });
}

describe("moving explorer selections", () => {
  it.each(["list", "grid"] as const)("moves a file to a highlighted ancestor in %s view", (viewMode) => {
    const { onMoveEntries, onNavigate } = setup({ viewMode });
    const target = screen.getByTitle("Navigate to /home/user");
    dragTo(screen.getByTestId("explorer-entry-report.txt"), target);
    expect(target).toHaveAttribute("data-drop-active", "true");
    fireEvent.pointerUp(window, { clientX: 100, clientY: 20 });
    expect(onMoveEntries).toHaveBeenCalledWith([entries[0].id], "/home/user");
    expect(target).not.toHaveAttribute("data-drop-active");
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("moves multiple selected files and folders to root over SCP", () => {
    const { onMoveEntries } = setup({ transport: "scp" });
    fireEvent.click(screen.getByTestId("explorer-entry-report.txt"));
    fireEvent.click(screen.getByTestId("explorer-entry-photos"), { ctrlKey: true });
    dragTo(screen.getByTestId("explorer-entry-photos"), screen.getByLabelText("Go to root"));
    fireEvent.pointerUp(window, { clientX: 100, clientY: 20 });
    expect(onMoveEntries).toHaveBeenCalledWith(expect.arrayContaining([entries[0].id, entries[1].id]), "/");
  });

  it("preserves Alt-copy and folder-row drops", () => {
    const { onMoveEntries, onCopyEntries } = setup();
    dragTo(screen.getByTestId("explorer-entry-report.txt"), screen.getByTestId("explorer-entry-archive"), true);
    fireEvent.pointerUp(window, { clientX: 100, clientY: 20, altKey: true });
    expect(onCopyEntries).toHaveBeenCalledWith([entries[0].id], entries[2].id);
    expect(onMoveEntries).not.toHaveBeenCalled();
  });

  it("rejects current-directory, self, and other-session targets", () => {
    const { onMoveEntries } = setup();
    const other = document.createElement("div");
    other.dataset.explorerSession = "other-session";
    other.innerHTML = '<button data-explorer-drop-path="/elsewhere">Other folder</button>';
    document.body.append(other);
    for (const target of [screen.getByTitle(currentPath), screen.getByTestId("explorer-entry-photos"), other.firstElementChild as HTMLElement]) {
      dragTo(screen.getByTestId("explorer-entry-photos"), target);
      fireEvent.pointerUp(window, { clientX: 100, clientY: 20 });
    }
    expect(onMoveEntries).not.toHaveBeenCalled();
    other.remove();
  });

  it.each(["Escape", "pointercancel", "unmount"])("cancels a drag on %s and clears highlights", (cancel) => {
    const { onMoveEntries, view } = setup();
    const target = screen.getByTitle("Navigate to /home/user");
    dragTo(screen.getByTestId("explorer-entry-report.txt"), target);
    if (cancel === "Escape") fireEvent.keyDown(window, { key: "Escape" });
    else if (cancel === "pointercancel") fireEvent.pointerCancel(window);
    else view.unmount();
    if (cancel === "unmount") expect(target).not.toBeInTheDocument();
    else expect(target).not.toHaveAttribute("data-drop-active");
    fireEvent.pointerUp(window, { clientX: 100, clientY: 20 });
    expect(onMoveEntries).not.toHaveBeenCalled();
  });

  it("opens Move to for one item and the full multi-selection", async () => {
    const { onListDirectory } = setup();
    const file = screen.getByTestId("explorer-entry-report.txt");
    fireEvent.contextMenu(file);
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to…" }));
    expect(screen.getByRole("dialog", { name: "Move to…" })).toHaveTextContent("report.txt");
    await waitFor(() => expect(onListDirectory).toHaveBeenCalledWith(currentPath));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(file).toHaveFocus();
    fireEvent.click(file);
    fireEvent.click(screen.getByTestId("explorer-entry-photos"), { ctrlKey: true });
    fireEvent.contextMenu(file);
    fireEvent.click(screen.getByRole("menuitem", { name: "Move 2 items to…" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("2 selected items");
  });

  it("does not offer unsupported S3 moves", () => {
    setup({ s3: true });
    fireEvent.contextMenu(screen.getByTestId("explorer-entry-report.txt"));
    expect(screen.queryByRole("menuitem", { name: "Move to…" })).toBeNull();
    expect(screen.getByTitle("Navigate to /home/user")).not.toHaveAttribute("data-explorer-drop-path");
  });

  it("does not start another drag while busy", () => {
    const { onMoveEntries } = setup({ busy: true });
    dragTo(screen.getByTestId("explorer-entry-report.txt"), screen.getByTitle("Navigate to /home/user"));
    fireEvent.pointerUp(window, { clientX: 100, clientY: 20 });
    expect(onMoveEntries).not.toHaveBeenCalled();
  });
});
