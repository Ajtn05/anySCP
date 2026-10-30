import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Folder, FolderOpen, HardDrive, Home, LayoutPanelLeft, List, Loader2, Pin, PinOff, Plus, Search, Server } from "lucide-react";
import { useSettingsStore } from "../../stores/settings-store";
import { DEFAULT_SERVER_BROWSER } from "../../lib/server-browser";
import { BTN_GHOST, BTN_PRIMARY, ModalShell } from "../shared/ModalShell";
import "./ServerDrive.css";

export function ServerBrowserLayoutToggle({ serverKey }: { serverKey: string }) {
  const layout = useSettingsStore((s) => s.serverBrowsers[serverKey]?.layout ?? "classic");
  const setLayout = useSettingsStore((s) => s.setServerBrowserLayout);
  return (
    <div role="group" aria-label="Server interface" className="flex gap-0.5 rounded-md bg-bg-base p-0.5 shrink-0">
      {(["classic", "drive"] as const).map((mode) => {
        const Icon = mode === "classic" ? List : LayoutPanelLeft;
        return <button key={mode} type="button" aria-label={`${mode === "classic" ? "Classic" : "Drive"} interface`}
          aria-pressed={layout === mode} onClick={() => setLayout(serverKey, mode)}
          title={mode === "drive" ? "Drive interface with server home and pinned folders" : "Classic file browser"}
          className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${layout === mode ? "bg-bg-subtle text-text-primary" : "text-text-muted hover:text-text-primary"}`}>
          <Icon size={12} aria-hidden="true" />{mode === "classic" ? "Classic" : "Drive"}
        </button>;
      })}
    </div>
  );
}

interface ServerDriveProps {
  serverKey: string;
  label: string;
  username: string;
  currentPath: string;
  home: boolean;
  loading: boolean;
  isActive: boolean;
  onHome: () => void;
  onBrowse: () => void;
  onNavigate: (path: string) => void;
  onOpenHome: () => void;
  /** Resolve ~ and check the folder without changing the current listing. */
  onValidatePath: (path: string) => Promise<string>;
  children: ReactNode;
}

export function ServerDrive({ serverKey, label, username, currentPath, home, loading, isActive, onHome, onBrowse, onNavigate, onOpenHome, onValidatePath, children }: ServerDriveProps) {
  const prefs = useSettingsStore((s) => s.serverBrowsers[serverKey] ?? DEFAULT_SERVER_BROWSER);
  const unpin = useSettingsStore((s) => s.unpinServerPath);
  const [query, setQuery] = useState("");
  const [pinDialog, setPinDialog] = useState(false);
  const pinsHeadingId = useId();
  useEffect(() => { if (!isActive) setPinDialog(false); }, [isActive]);
  const needle = query.trim().toLowerCase();
  const filtered = prefs.pinnedPaths.filter((pin) => `${pin.label} ${pin.path}`.toLowerCase().includes(needle));

  return (
    <div className="server-drive-container flex-1 min-h-0">
      <div className="server-drive-layout">
        <nav aria-label="Server navigation" className="server-drive-nav">
          <div className="server-drive-identity">
            <Server size={18} className="text-accent shrink-0" aria-hidden="true" />
            <div className="min-w-0"><p className="text-sm font-medium truncate" title={label}>{label}</p><p className="text-xs text-text-muted truncate">{username || "Server files"}</p></div>
          </div>
          <div className="server-drive-primary-nav">
            <button className="server-drive-nav-link" aria-current={home ? "page" : undefined} onClick={onHome}><Home size={16} aria-hidden="true" />Server home</button>
            <button className="server-drive-nav-link" aria-current={!home ? "page" : undefined} onClick={onBrowse}><FolderOpen size={16} aria-hidden="true" />Browse files</button>
          </div>
          <div className="server-drive-sidebar-pins">
            <div className="flex items-center justify-between gap-2 px-3 mb-2 mt-6 text-xs text-text-muted">
              <span className="flex items-center gap-2"><Pin size={12} aria-hidden="true" />Pinned folders</span>
              <button className="server-drive-icon-button" aria-label="Pin a path" title="Pin a path" onClick={() => setPinDialog(true)}><Plus size={14} aria-hidden="true" /></button>
            </div>
            {prefs.pinnedPaths.length === 0 ? <p className="px-3 text-xs text-text-muted leading-relaxed">Keep your go-to folders here.</p> : prefs.pinnedPaths.map((pin) => (
              <button key={pin.path} className="server-drive-nav-link" title={pin.path} aria-current={!home && pin.path === currentPath ? "location" : undefined}
                disabled={loading} onClick={() => onNavigate(pin.path)}><Folder size={15} aria-hidden="true" /><span className="truncate">{pin.label}</span></button>
            ))}
          </div>
        </nav>

        {home ? (
          <main className="server-drive-home" aria-label="Server home">
            <header className="server-drive-heading">
              <div className="min-w-0"><h1 className="text-[22px] font-semibold tracking-tight break-words">{label}</h1><p className="mt-1 text-sm text-text-secondary">Your folders, right where you need them.</p></div>
              <button className={`${BTN_PRIMARY} inline-flex items-center justify-center gap-2 shrink-0`} onClick={() => setPinDialog(true)}><Plus size={16} aria-hidden="true" />Pin a path</button>
            </header>

            <div className="server-drive-shortcuts">
              <button disabled={loading} onClick={onOpenHome} className="server-drive-shortcut"><Home size={18} className="text-accent" aria-hidden="true" /><span>Home directory</span><ArrowUpRight size={14} className="ml-auto text-text-muted" aria-hidden="true" /></button>
              <button disabled={loading} onClick={() => onNavigate("/")} className="server-drive-shortcut"><HardDrive size={18} className="text-accent" aria-hidden="true" /><span>Filesystem root</span><span className="text-xs text-text-muted ml-auto" aria-hidden="true">/</span></button>
            </div>

            <section aria-labelledby={pinsHeadingId} className="mt-8">
              <div className="server-drive-pins-header">
                <h2 id={pinsHeadingId} className="flex items-center gap-2 text-sm font-medium"><Pin size={15} className="text-accent" aria-hidden="true" />Pinned folders<span className="text-text-muted font-normal text-xs">{prefs.pinnedPaths.length}</span></h2>
                {prefs.pinnedPaths.length > 0 && <label className="server-drive-search"><Search size={15} className="text-text-muted shrink-0" aria-hidden="true" /><input aria-label="Search pinned folders" placeholder="Find a pinned folder" value={query} onChange={(event) => setQuery(event.target.value)} type="search" /></label>}
              </div>
              {prefs.pinnedPaths.length === 0 ? (
                <div className="server-drive-empty">
                  <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-accent/10 text-accent mb-4"><FolderOpen size={25} strokeWidth={1.5} aria-hidden="true" /></div>
                  <h3 className="text-sm font-medium">Make this server feel like home</h3>
                  <p className="text-sm text-text-secondary mt-1.5 max-w-sm">Pin project folders, logs, or any path you visit often. Your shortcuts stay with this server.</p>
                  <button className="mt-5 inline-flex items-center gap-2 text-sm text-accent rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onBrowse}>Browse files to get started<ArrowUpRight size={14} aria-hidden="true" /></button>
                </div>
              ) : filtered.length === 0 ? <p role="status" className="py-12 text-sm text-text-secondary text-center">No pinned folders match “{query}”.</p> : (
                <div className="server-drive-pin-grid">{filtered.map((pin) => (
                  <div key={pin.path} className="server-drive-pin-card">
                    <button className="server-drive-pin-open" disabled={loading} onClick={() => onNavigate(pin.path)} aria-label={`Open ${pin.label}`} title={pin.path}>
                      <Folder size={25} strokeWidth={1.5} className="text-accent mb-5" aria-hidden="true" />
                      <span className="block text-sm font-medium truncate">{pin.label}</span><span className="block text-xs text-text-muted font-mono truncate mt-1">{pin.path}</span>
                    </button>
                    <button className="server-drive-icon-button server-drive-unpin" onClick={() => unpin(serverKey, pin.path)} aria-label={`Unpin ${pin.label}`} title="Unpin folder"><PinOff size={14} aria-hidden="true" /></button>
                  </div>
                ))}</div>
              )}
              {loading && <p role="status" className="flex items-center gap-2 text-xs text-text-muted mt-4"><Loader2 size={14} className="motion-safe:animate-spin" aria-hidden="true" />Loading folder…</p>}
            </section>
          </main>
        ) : <div className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden">{children}</div>}
      </div>
      {pinDialog && isActive && <PinPathDialog serverKey={serverKey} initialPath={home ? "" : currentPath} onClose={() => setPinDialog(false)} onValidatePath={onValidatePath} />}
    </div>
  );
}

function PinPathDialog({ serverKey, initialPath, onClose, onValidatePath }: { serverKey: string; initialPath: string; onClose: () => void; onValidatePath: (path: string) => Promise<string> }) {
  const [path, setPath] = useState(initialPath);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const pathRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    pathRef.current?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const dialog = formRef.current?.closest('[role="dialog"]');
      const focusable = Array.from(dialog?.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input") ?? []).filter((element) => !element.disabled);
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", trapFocus);
    return () => { document.removeEventListener("keydown", trapFocus); previous?.focus(); };
  }, []);

  const save = async () => {
    if (busy || !path.trim()) return;
    setBusy(true);
    setError("");
    try {
      const resolved = await onValidatePath(path);
      const state = useSettingsStore.getState();
      if (state.serverBrowsers[serverKey]?.pinnedPaths.some((pin) => pin.path === resolved)) {
        setError("This folder is already pinned.");
        return;
      }
      state.pinServerPath(serverKey, resolved, label);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : typeof err === "object" && err && "message" in err ? String(err.message) : "Could not open this folder. Check the path and your permissions.");
    } finally { setBusy(false); }
  };

  return <ModalShell open title="Pin a folder" subtitle="Save a shortcut on this server" icon={Pin} maxWidth="md" onClose={onClose} busy={busy}
    footer={<><button type="button" className={BTN_GHOST} disabled={busy} onClick={onClose}>Cancel</button><button type="submit" form="pin-server-folder" className={BTN_PRIMARY} disabled={busy || !path.trim()}>{busy ? "Checking folder…" : "Pin folder"}</button></>}>
    <form id="pin-server-folder" ref={formRef} onSubmit={(event) => { event.preventDefault(); void save(); }} className="flex flex-col gap-4">
      <div><label htmlFor="pin-folder-path" className="block text-sm font-medium mb-1.5">Folder path</label><input ref={pathRef} id="pin-folder-path" value={path} onChange={(event) => setPath(event.target.value)} placeholder="/var/www or ~/projects" required disabled={busy} autoComplete="off" spellCheck={false} aria-describedby={error ? "pin-folder-error" : "pin-folder-hint"} aria-invalid={!!error} className="server-drive-input font-mono" /><p id="pin-folder-hint" className="mt-1.5 text-xs text-text-muted">Use an absolute path or ~ for your home directory.</p></div>
      <div><label htmlFor="pin-folder-label" className="block text-sm font-medium mb-1.5">Name <span className="text-text-muted font-normal">(optional)</span></label><input id="pin-folder-label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Use the folder name" disabled={busy} className="server-drive-input" /></div>
      {error && <p id="pin-folder-error" role="alert" className="text-sm text-status-error">{error}</p>}
    </form>
  </ModalShell>;
}
