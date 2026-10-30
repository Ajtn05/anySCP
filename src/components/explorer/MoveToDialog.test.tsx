import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createSftpProvider } from "../../providers/sftp-provider";
import type { ExplorerEntry } from "../../types/explorer";
import { MoveToDialog } from "./MoveToDialog";

function entry(id: string, directory = false): ExplorerEntry {
  return { id, name: id.split("/").pop()!, entryType: directory ? "Directory" : "File", size: 1,
    modified: null, permissions: null, permissionsDisplay: null, storageClass: null, isSymlink: false };
}
const files = [entry("/home/inbox/report.txt"), entry("/home/inbox/photos", true)];

function setup() {
  const onMove = vi.fn(async (..._args: unknown[]) => {}), onClose = vi.fn();
  const onListDirectory = vi.fn(async (path: string) => path === "/home/inbox"
    ? [...files, entry("/home/inbox/archive", true)] : []);
  render(<MoveToDialog provider={createSftpProvider("s")} entries={files} currentPath="/home/inbox"
    onListDirectory={onListDirectory} onMove={onMove} onClose={onClose} />);
  return { onMove, onClose, onListDirectory };
}

describe("Move to destination picker", () => {
  it("browses independently, disables self/current destinations, and moves the complete selection", async () => {
    const { onMove, onClose } = setup();
    expect(await screen.findByRole("button", { name: "Open folder photos" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Open folder report.txt" })).toBeNull();
    expect(screen.getByRole("button", { name: "Move here" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Open folder archive" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Move here" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Move here" }));
    await waitFor(() => expect(onMove).toHaveBeenCalledWith(files.map((item) => item.id), "/home/inbox/archive"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("normalizes typed paths and requires opening the destination before moving", async () => {
    const { onListDirectory, onMove } = setup();
    await screen.findByRole("button", { name: "Open folder archive" });
    fireEvent.change(screen.getByLabelText("Destination folder"), { target: { value: "/home/../backup//./" } });
    expect(screen.getByRole("button", { name: "Move here" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => expect(onListDirectory).toHaveBeenCalledWith("/backup"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Move here" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Move here" }));
    await waitFor(() => expect(onMove).toHaveBeenCalledWith(files.map((item) => item.id), "/backup"));
  });

  it("keeps listing and move errors visible, supports retry, and prevents duplicate moves", async () => {
    const { onMove, onClose, onListDirectory } = setup();
    await screen.findByRole("button", { name: "Open folder archive" });
    onListDirectory.mockRejectedValueOnce(new Error("Permission denied"));
    fireEvent.click(screen.getByLabelText("Go to parent folder"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Permission denied");
    expect(screen.getByRole("button", { name: "Move here" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Move here" })).toBeEnabled());
    onMove.mockRejectedValueOnce(new Error("Connection lost"));
    fireEvent.click(screen.getByRole("button", { name: "Move here" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost");
    expect(onClose).not.toHaveBeenCalled();
    let finish!: () => void;
    onMove.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Move here" }));
    expect(screen.getByRole("button", { name: "Moving…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(onMove).toHaveBeenCalledTimes(2);
    finish();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("prevents normalized descendant destinations and rejects relative paths", async () => {
    const { onMove } = setup();
    await screen.findByRole("button", { name: "Open folder archive" });
    const input = screen.getByLabelText("Destination folder");
    fireEvent.change(input, { target: { value: "relative/path" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(screen.getByRole("alert")).toHaveTextContent("absolute folder path");
    fireEvent.change(input, { target: { value: "/home/inbox/photos/./child" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => expect(screen.getByText(/cannot be moved into itself/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Move here" })).toBeDisabled();
    expect(onMove).not.toHaveBeenCalled();
  });

  it("allows a parent-folder move and closing without moving", async () => {
    const { onClose, onMove } = setup();
    await screen.findByRole("button", { name: "Open folder archive" });
    fireEvent.click(screen.getByLabelText("Go to root folder"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Move here" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onMove).not.toHaveBeenCalled();
  });

  it("can browse back into the source folder to choose a different subfolder", async () => {
    const { onListDirectory } = setup();
    await screen.findByRole("button", { name: "Open folder archive" });
    onListDirectory.mockResolvedValueOnce([entry("/home/inbox", true)]);
    fireEvent.click(screen.getByLabelText("Go to parent folder"));
    const inbox = await screen.findByRole("button", { name: "Open folder inbox" });
    expect(inbox).toBeEnabled();
    fireEvent.click(inbox);
    expect(await screen.findByRole("button", { name: "Open folder archive" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Move here" })).toBeDisabled();
  });

  it("keeps keyboard focus inside the dialog and supports Escape", async () => {
    const { onClose } = setup();
    await screen.findByRole("button", { name: "Open folder archive" });
    expect(screen.getByLabelText("Destination folder")).toHaveFocus();
    const close = screen.getByRole("button", { name: "Close" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    close.focus();
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
