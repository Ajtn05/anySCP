import { useEffect, useId, useRef, useState } from "react";
import { ArrowUp, ChevronRight, Folder, FolderInput, Home, Loader2 } from "lucide-react";
import type { ExplorerEntry, FileSystemProvider } from "../../types/explorer";
import { moveDestinationError, normalizeMovePath } from "../../lib/explorer-move";
import { useSettingsStore } from "../../stores/settings-store";
import { ModalShell, BTN_GHOST, BTN_PRIMARY, BTN_SECONDARY } from "../shared/ModalShell";

interface MoveToDialogProps {
  provider: FileSystemProvider;
  entries: ExplorerEntry[];
  currentPath: string;
  onListDirectory: (path: string) => Promise<ExplorerEntry[]>;
  onMove: (sourceIds: string[], targetDir: string) => Promise<void>;
  onClose: () => void;
}

const NAV_BUTTON = "p-2 rounded-md text-text-secondary hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40";

export function MoveToDialog({ provider, entries, currentPath, onListDirectory, onMove, onClose }: MoveToDialogProps) {
  const inputId = useId();
  const errorId = useId();
  const [path, setPath] = useState(currentPath);
  const [draft, setDraft] = useState(currentPath);
  const [listing, setListing] = useState<ExplorerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const movingRef = useRef(false);
  const [revision, setRevision] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const showHiddenFiles = useSettingsStore((s) => s.explorerShowHiddenFiles);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = inputRef.current?.closest<HTMLElement>('[role="dialog"]');
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialog) return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>("*"))
        .filter((element) => element.tabIndex >= 0 && !element.matches(":disabled"));
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    dialog?.addEventListener("keydown", trapFocus);
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => { dialog?.removeEventListener("keydown", trapFocus); previous?.focus(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setListError(null);
    setListing([]);
    void onListDirectory(path).then(
      (items) => { if (!cancelled) { setListing(items); setLoading(false); } },
      (err: unknown) => {
        if (!cancelled) {
          setListError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      },
    );
    return () => { cancelled = true; };
  }, [path, onListDirectory, revision]);

  const navigate = (raw: string) => {
    try {
      const next = normalizeMovePath(raw);
      setDraft(next);
      setPath(next);
      setActionError(null);
      setLoading(true);
      setRevision((n) => n + 1);
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  let draftMatchesPath = false;
  try { draftMatchesPath = normalizeMovePath(draft) === path; } catch { /* Validate on Go. */ }
  const invalidDestination = moveDestinationError(entries, path);
  const canMove = !moving && !loading && !listError && !invalidDestination && draftMatchesPath;
  const folders = listing.filter((entry) => entry.entryType === "Directory" &&
    (showHiddenFiles || !entry.name.startsWith(".")))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  const move = async () => {
    if (!canMove || movingRef.current) return;
    movingRef.current = true;
    setMoving(true);
    setActionError(null);
    try {
      await onMove(entries.map((entry) => entry.id), path);
      onClose();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      movingRef.current = false;
      setMoving(false);
    }
  };

  return (
    <ModalShell open onClose={onClose} title="Move to…" icon={FolderInput} maxWidth="lg" busy={moving} scrollable
      testId="explorer-move-dialog"
      subtitle={entries.length === 1 ? entries[0].name : `${entries.length} selected items`}
      footer={<>
        <button type="button" className={BTN_GHOST} onClick={onClose} disabled={moving}>Cancel</button>
        <button type="button" className={BTN_PRIMARY} disabled={!canMove} onClick={() => void move()}>
          {moving ? "Moving…" : "Move here"}
        </button>
      </>}
    >
      <div className="flex flex-col gap-3">
        <form onSubmit={(e) => { e.preventDefault(); if (!moving) navigate(draft); }}>
          <label htmlFor={inputId} className="block mb-1.5 text-[length:var(--text-sm)] text-text-secondary">Destination folder</label>
          <div className="flex gap-2">
            <input ref={inputRef} id={inputId} value={draft} onChange={(e) => { setDraft(e.target.value); setActionError(null); }}
              disabled={moving} spellCheck={false} autoComplete="off" placeholder="/path/to/folder"
              aria-describedby={actionError || listError ? errorId : undefined}
              className="flex-1 min-w-0 px-3 py-1.5 rounded-md border border-border bg-bg-base font-mono text-[length:var(--text-sm)] text-text-primary focus:outline-none focus:ring-2 focus:ring-ring" />
            <button type="submit" disabled={moving || !draft.trim()} className={BTN_SECONDARY}>Go</button>
          </div>
        </form>

        <div className="rounded-lg border border-border overflow-hidden">
          <div className="flex items-center gap-1 px-2 py-1 border-b border-border bg-bg-subtle/40">
            <button type="button" className={NAV_BUTTON} aria-label="Go to root folder" title="Root folder" disabled={moving || path === "/"} onClick={() => navigate("/")}><Home size={15} aria-hidden="true" /></button>
            <button type="button" className={NAV_BUTTON} aria-label="Go to parent folder" title="Parent folder" disabled={moving || path === "/"} onClick={() => navigate(provider.parentPath(path))}><ArrowUp size={15} aria-hidden="true" /></button>
            <span className="min-w-0 truncate ml-1 font-mono text-[length:var(--text-xs)] text-text-secondary" title={path}>{path}</span>
          </div>
          <div className="h-56 overflow-y-auto" aria-label="Destination folders" aria-busy={loading}>
            {loading ? <p role="status" className="flex items-center justify-center gap-2 p-6 text-[length:var(--text-sm)] text-text-muted"><Loader2 size={15} className="motion-safe:animate-spin" aria-hidden="true" />Loading folders…</p>
              : listError ? <p className="p-4 text-[length:var(--text-sm)] text-text-muted">Choose another folder or use Go to try again.</p>
              : folders.length === 0 ? <p className="p-4 text-[length:var(--text-sm)] text-text-muted">No subfolders here.</p>
              : folders.map((folder) => {
                const reason = moveDestinationError(entries, folder.id, { allowCurrentFolder: true });
                return <button key={folder.id} type="button" disabled={moving || !!reason}
                  aria-label={`Open folder ${folder.name}`} title={reason ?? folder.name} onClick={() => navigate(folder.id)}
                  className="flex items-center gap-2.5 w-full px-3 py-2 text-left text-[length:var(--text-sm)] text-text-primary hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-40 disabled:cursor-not-allowed">
                  <Folder size={16} className="shrink-0 text-accent" aria-hidden="true" />
                  <span className="flex-1 min-w-0 truncate">{folder.name}</span>
                  <ChevronRight size={14} className="shrink-0 text-text-muted" aria-hidden="true" />
                </button>;
              })}
          </div>
        </div>
        {(actionError || listError) && <p id={errorId} role="alert" className="text-[length:var(--text-sm)] text-status-error break-words">{actionError || listError}</p>}
        {invalidDestination && !listError && <p className="text-[length:var(--text-xs)] text-text-muted">{invalidDestination}</p>}
        {!draftMatchesPath && <p className="text-[length:var(--text-xs)] text-text-muted">Press Enter or Go to open the typed path.</p>}
        <p className="text-[length:var(--text-xs)] text-text-muted">Items with an existing name get a numbered suffix.</p>
      </div>
    </ModalShell>
  );
}
