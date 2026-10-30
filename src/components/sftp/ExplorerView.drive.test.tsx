import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ExplorerPage } from "./ExplorerPage";
import { useSftpStore } from "../../stores/sftp-store";
import { useSettingsStore } from "../../stores/settings-store";
import type { SftpEntry } from "../../types";

const { invoke, onDragDropEvent } = vi.hoisted(() => ({ invoke: vi.fn(), onDragDropEvent: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ onDragDropEvent }) }));

const serverKey = "host:development";
const entry: SftpEntry = { name: "projects", path: "/home/deploy/projects", entry_type: "Directory", size: 0, modified: null, permissions: 0o755, permissions_display: "rwxr-xr-x", is_symlink: false };

beforeEach(() => {
  invoke.mockReset();
  onDragDropEvent.mockClear();
  invoke.mockImplementation(async (command: string) => {
    if (command.endsWith("_home_dir")) return "/home/deploy";
    if (command.endsWith("_list_dir")) return [entry];
    return undefined;
  });
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
  useSettingsStore.setState({ serverBrowsers: {} });
  useSftpStore.setState({ sessions: new Map(), activeSftpSessionId: null, clipboard: null });
  useSftpStore.getState().openSession("s", "ssh", "Development", "deploy", false, "", serverKey);
});
afterEach(() => vi.unstubAllGlobals());

async function openDrive(transport: "sftp" | "scp" = "sftp") {
  useSettingsStore.getState().setServerBrowserLayout(serverKey, "drive");
  const view = render(<ExplorerPage sftpSessionId="s" transport={transport} />);
  await waitFor(() => expect(useSftpStore.getState().sessions.get("s")?.loading).toBe(false));
  return view;
}

describe("Drive server browser", () => {
  it("opts in per server, pins the current folder, opens it from home, and restores Classic", async () => {
    render(<ExplorerPage sftpSessionId="s" />);
    await screen.findByTestId("explorer-entry-projects");
    expect(screen.getByRole("button", { name: "Classic interface" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Drive interface" }));
    expect(screen.getByRole("main", { name: "Server home" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Browse files" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin current folder" }));
    fireEvent.click(screen.getByRole("button", { name: "Server home" }));
    fireEvent.click(screen.getByRole("button", { name: "Open deploy" }));
    await screen.findByRole("button", { name: "Unpin current folder" });
    expect(useSftpStore.getState().sessions.get("s")?.currentPath).toBe("/home/deploy");
    fireEvent.click(screen.getByRole("button", { name: "Classic interface" }));
    expect(screen.queryByRole("navigation", { name: "Server navigation" })).toBeNull();
    expect(useSettingsStore.getState().serverBrowsers[serverKey].pinnedPaths).toEqual([{ path: "/home/deploy", label: "deploy" }]);
  });

  it.each(["sftp", "scp"] as const)("opens pinned folders over %s and keeps failed navigation on home", async (transport) => {
    useSettingsStore.getState().pinServerPath(serverKey, "/var/log", "Logs");
    await openDrive(transport);
    invoke.mockImplementation(async (command: string, args: { path?: string }) => {
      if (command === `${transport}_list_dir` && args.path === "/var/log") throw { message: "Permission denied for /var/log" };
      return [];
    });
    fireEvent.click(screen.getByRole("button", { name: "Open Logs" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Permission denied for /var/log");
    expect(screen.getByRole("main", { name: "Server home" })).toBeInTheDocument();
    expect(useSftpStore.getState().sessions.get("s")?.currentPath).toBe("/home/deploy");
    invoke.mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: "Open Logs" }));
    await screen.findByRole("button", { name: "Unpin current folder" });
    expect(invoke.mock.calls.map((call) => call.slice(0, 2))).toContainEqual([`${transport}_list_dir`, { [transport === "sftp" ? "sftpSessionId" : "scpSessionId"]: "s", path: "/var/log" }]);
    expect(useSftpStore.getState().sessions.get("s")?.currentPath).toBe("/var/log");
  });

  it("validates paths, expands home, prevents duplicate pins, and supports search and unpin", async () => {
    await openDrive();
    fireEvent.click(screen.getAllByRole("button", { name: "Pin a path" })[1]);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Folder path"), { target: { value: "relative/path" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Pin folder" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Enter an absolute folder path");
    fireEvent.change(within(dialog).getByLabelText("Folder path"), { target: { value: "~/projects/" } });
    fireEvent.change(within(dialog).getByLabelText(/Name/), { target: { value: "Work" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Pin folder" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(invoke.mock.calls.map((call) => call.slice(0, 2))).toContainEqual(["sftp_list_dir", { sftpSessionId: "s", path: "/home/deploy/projects" }]);
    expect(useSftpStore.getState().sessions.get("s")?.currentPath).toBe("/home/deploy");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search pinned folders" }), { target: { value: "missing" } });
    expect(screen.getByRole("status")).toHaveTextContent("No pinned folders match");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "projects" } });
    expect(screen.getByRole("button", { name: "Open Work" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Pin a path" })[1]);
    fireEvent.change(screen.getByLabelText("Folder path"), { target: { value: "/home/deploy/projects/." } });
    fireEvent.click(screen.getByRole("button", { name: "Pin folder" }));
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("already pinned");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Unpin Work" }));
    expect(screen.queryByRole("button", { name: "Open Work" })).toBeNull();
    expect(useSettingsStore.getState().serverBrowsers[serverKey].pinnedPaths).toEqual([]);
  });

  it("keeps remote folder errors in the pin dialog and traps and restores focus", async () => {
    await openDrive();
    const add = screen.getAllByRole("button", { name: "Pin a path" })[1];
    add.focus();
    fireEvent.click(add);
    expect(screen.getByLabelText("Folder path")).toHaveFocus();
    const submit = screen.getByRole("button", { name: "Pin folder" });
    fireEvent.change(screen.getByLabelText("Folder path"), { target: { value: "/private" } });
    submit.focus();
    fireEvent.keyDown(submit, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    invoke.mockRejectedValue({ message: "Cannot read /private" });
    fireEvent.click(submit);
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("Cannot read /private");
    expect(useSettingsStore.getState().serverBrowsers[serverKey].pinnedPaths).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(add).toHaveFocus();
  });

  it("does not register upload drops or create-file shortcuts on the landing page", async () => {
    await openDrive();
    expect(onDragDropEvent).not.toHaveBeenCalled();
    fireEvent(document, new CustomEvent("explorer:new-folder"));
    fireEvent(document, new CustomEvent("explorer:new-file"));
    fireEvent.click(screen.getByRole("button", { name: "Browse files" }));
    await waitFor(() => expect(onDragDropEvent).toHaveBeenCalledOnce());
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("opens the server home directory and filesystem root", async () => {
    await openDrive();
    fireEvent.click(screen.getByRole("button", { name: "Home directory" }));
    await waitFor(() => expect(screen.queryByRole("main", { name: "Server home" })).toBeNull());
    expect(useSftpStore.getState().sessions.get("s")?.currentPath).toBe("/home/deploy");
    fireEvent.click(screen.getByRole("button", { name: "Server home" }));
    fireEvent.click(screen.getByRole("button", { name: "Filesystem root" }));
    await waitFor(() => expect(useSftpStore.getState().sessions.get("s")?.currentPath).toBe("/"));
  });

  it("dismisses the pin dialog when its explorer tab becomes inactive", async () => {
    const view = await openDrive();
    fireEvent.click(screen.getAllByRole("button", { name: "Pin a path" })[1]);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    view.rerender(<ExplorerPage sftpSessionId="s" isActive={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(<ExplorerPage sftpSessionId="s" isActive />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lets the user return home while a pinned folder is still loading", async () => {
    useSettingsStore.getState().pinServerPath(serverKey, "/var/log", "Logs");
    await openDrive();
    let resolveListing!: (entries: SftpEntry[]) => void;
    invoke.mockImplementation(async (command: string) => {
      if (command === "sftp_list_dir") return new Promise<SftpEntry[]>((resolve) => { resolveListing = resolve; });
      return undefined;
    });
    fireEvent.click(screen.getByRole("button", { name: "Open Logs" }));
    await waitFor(() => expect(resolveListing).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Server home" }));
    await act(async () => resolveListing([]));
    expect(screen.getByRole("main", { name: "Server home" })).toBeInTheDocument();
  });

  it("retains pins after reconnecting and a sudo session swap", async () => {
    useSettingsStore.getState().pinServerPath(serverKey, "/srv/app", "Application");
    await openDrive();
    act(() => {
      useSftpStore.getState().swapSession("s", "sudo-s", true);
    });
    expect(useSftpStore.getState().sessions.get("sudo-s")?.serverKey).toBe(serverKey);
    act(() => {
      useSftpStore.getState().openSession("s", "new-ssh", "Renamed server", "deploy", false, "", serverKey);
    });
    expect(await screen.findByRole("button", { name: "Open Application" })).toBeInTheDocument();
  });
});
