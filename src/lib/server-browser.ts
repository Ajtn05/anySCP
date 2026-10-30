import { normalizeMovePath } from "./explorer-move";

export type ServerBrowserLayout = "classic" | "drive";

export interface PinnedServerPath {
  path: string;
  label: string;
}

export interface ServerBrowserPreferences {
  layout: ServerBrowserLayout;
  pinnedPaths: PinnedServerPath[];
}

export const DEFAULT_SERVER_BROWSER: ServerBrowserPreferences = { layout: "classic", pinnedPaths: [] };

export function serverPathLabel(path: string): string {
  return path.split("/").filter(Boolean).pop() || "Filesystem root";
}

/** Saved-host IDs keep pins separate even when hosts share an address. */
export function serverBrowserKey(host: { id?: string; host: string; port: number; username: string }): string {
  return host.id ? `host:${host.id}` : `ssh:${JSON.stringify([host.host, host.port, host.username])}`;
}

/** Settings can come from an older version or an imported backup. */
export function parseServerBrowsers(raw: string): Record<string, ServerBrowserPreferences> {
  const result: Record<string, ServerBrowserPreferences> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return result;
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || !(key.startsWith("host:") || key.startsWith("ssh:"))) continue;
      const prefs = value as Record<string, unknown>;
      const pinnedPaths: PinnedServerPath[] = [];
      if (Array.isArray(prefs.pinnedPaths)) {
        for (const pin of prefs.pinnedPaths) {
          if (!pin || typeof pin.path !== "string") continue;
          try {
            const path = normalizeMovePath(pin.path);
            if (!pinnedPaths.some((item) => item.path === path)) {
              pinnedPaths.push({ path, label: typeof pin.label === "string" && pin.label.trim() ? pin.label.trim() : serverPathLabel(path) });
            }
          } catch { /* Skip invalid paths without losing other pins. */ }
        }
      }
      result[key] = { layout: prefs.layout === "drive" ? "drive" : "classic", pinnedPaths };
    }
  } catch { /* Use defaults for malformed settings. */ }
  return result;
}
