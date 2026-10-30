import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ExplorerView } from "./ExplorerView";
import { useSftpStore } from "../../stores/sftp-store";
import type { SftpEntry } from "../../types";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ onDragDropEvent: vi.fn(async () => () => {}) }),
}));

const currentPath = "/home/inbox";
const initial: SftpEntry[] = ["report.txt", "notes.txt"].map((name) => ({
  name, path: `${currentPath}/${name}`, entry_type: "File", size: 1, modified: null,
  permissions: 0o644, permissions_display: "rw-r--r--", is_symlink: false,
}));

beforeEach(() => {
  invoke.mockReset();
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
  useSftpStore.setState({ sessions: new Map(), activeSftpSessionId: null, clipboard: null });
  useSftpStore.getState().openSession("s", "ssh", "Test host", "user");
  useSftpStore.getState().setEntries("s", currentPath, initial);
});
afterEach(() => vi.unstubAllGlobals());

async function chooseParent(multiple = false) {
  const report = await screen.findByTestId("explorer-entry-report.txt");
  fireEvent.click(report);
  if (multiple) fireEvent.click(screen.getByTestId("explorer-entry-notes.txt"), { ctrlKey: true });
  fireEvent.contextMenu(report);
  fireEvent.click(screen.getByRole("menuitem", { name: multiple ? "Move 2 items to…" : "Move to…" }));
  fireEvent.click(screen.getByLabelText("Go to parent folder"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Move here" })).toBeEnabled());
}

describe("ExplorerView move commands", () => {
  it.each(["sftp", "scp"] as const)("dispatches %s moves and refreshes the source without navigating", async (transport) => {
    let files = initial;
    invoke.mockImplementation(async (command: string, args: { path?: string }) => {
      if (command === `${transport}_list_dir`) return args.path === currentPath ? files : [];
      if (command === `${transport}_move_entries`) { files = files.slice(1); return ["/home/report.txt"]; }
      return [];
    });
    render(<ExplorerView sessionId="s" transport={transport} />);
    await chooseParent();
    fireEvent.click(screen.getByRole("button", { name: "Move here" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const moveCall = invoke.mock.calls.find(([command]) => command === `${transport}_move_entries`);
    expect(moveCall?.slice(0, 2)).toEqual([`${transport}_move_entries`, {
      [transport === "sftp" ? "sftpSessionId" : "scpSessionId"]: "s",
      sourcePaths: [initial[0].path], targetDir: "/home",
    }]);
    expect(screen.queryByTestId("explorer-entry-report.txt")).toBeNull();
    expect(screen.getByTestId("explorer-entry-notes.txt")).toBeInTheDocument();
    expect(useSftpStore.getState().sessions.get("s")?.currentPath).toBe(currentPath);
  });

  it("preserves remote errors and retries only sources left after a partial failure", async () => {
    let files = initial;
    let fail = true;
    invoke.mockImplementation(async (command: string, args: { path?: string }) => {
      if (command === "sftp_list_dir") return args.path === currentPath ? files : [];
      if (command === "sftp_move_entries") {
        files = fail ? [initial[1]] : [];
        if (fail) { fail = false; throw { kind: "remote_io_error", message: "Permission denied for notes.txt" }; }
        return ["/home/notes.txt"];
      }
      return [];
    });
    render(<ExplorerView sessionId="s" />);
    await chooseParent(true);
    fireEvent.click(screen.getByRole("button", { name: "Move here" }));
    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Permission denied for notes.txt");
    await waitFor(() => expect(dialog).toHaveTextContent("notes.txt"));
    expect(screen.queryByTestId("explorer-entry-report.txt")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Move here" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const calls = invoke.mock.calls.filter(([command]) => command === "sftp_move_entries");
    expect(calls).toHaveLength(2);
    expect(calls[0][1].sourcePaths).toHaveLength(2);
    expect(calls[1][1].sourcePaths).toEqual([initial[1].path]);
  });

  it("shows structured destination-listing errors inside the picker", async () => {
    invoke.mockImplementation(async (command: string, args: { path?: string }) => {
      if (command === "sftp_list_dir") {
        if (args.path === "/home") throw { kind: "remote_io_error", message: "Cannot read /home: permission denied" };
        return initial;
      }
      return [];
    });
    render(<ExplorerView sessionId="s" />);
    fireEvent.contextMenu(await screen.findByTestId("explorer-entry-report.txt"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to…" }));
    fireEvent.click(screen.getByLabelText("Go to parent folder"));
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("Cannot read /home: permission denied");
    expect(screen.getByRole("button", { name: "Move here" })).toBeDisabled();
    expect(useSftpStore.getState().sessions.get("s")?.currentPath).toBe(currentPath);
  });
});
