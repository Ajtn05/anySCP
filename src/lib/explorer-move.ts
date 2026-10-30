import type { ExplorerEntry } from "../types/explorer";

/** Remote POSIX paths must not depend on the desktop OS's path conventions. */
export function normalizeMovePath(raw: string): string {
  const path = raw.trim();
  if (!path.startsWith("/") || path.includes("\0")) {
    throw new Error("Enter an absolute folder path, starting with /.");
  }
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** Validate the whole selection before starting a move. */
export function moveDestinationError(
  entries: ExplorerEntry[],
  targetDir: string,
  { allowCurrentFolder = false }: { allowCurrentFolder?: boolean } = {},
): string | null {
  for (const entry of entries) {
    if (entry.entryType === "Directory" &&
        (targetDir === entry.id || targetDir.startsWith(`${entry.id}/`))) {
      return "A folder cannot be moved into itself or one of its subfolders.";
    }
    const parent = entry.id.slice(0, entry.id.lastIndexOf("/")) || "/";
    if (!allowCurrentFolder && parent === targetDir) {
      return entries.length === 1
        ? "This item is already in this folder."
        : "The selected items are already in this folder.";
    }
  }
  return null;
}
