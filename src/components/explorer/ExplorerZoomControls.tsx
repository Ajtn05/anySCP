import { useEffect } from "react";
import { Minus, Plus } from "lucide-react";
import { useSettingsStore } from "../../stores/settings-store";
import {
  EXPLORER_ZOOM_MIN,
  EXPLORER_ZOOM_MAX,
  EXPLORER_ZOOM_DEFAULT,
  EXPLORER_ZOOM_STEP,
} from "../../lib/explorer-zoom";

const BUTTON_CLASS = "flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-text-secondary hover:bg-bg-subtle disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function ExplorerZoomControls({ isActive = true }: { isActive?: boolean }) {
  const zoom = useSettingsStore((s) => s.explorerZoom);
  const setZoom = useSettingsStore((s) => s.setExplorerZoom);
  const isMac = navigator.platform.includes("Mac");
  const modifier = isMac ? "⌘" : "Ctrl+";

  useEffect(() => {
    if (!isActive) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || !(isMac ? event.metaKey : event.ctrlKey)) return;
      const target = event.target;
      // Leave editing fields and modal shortcuts to their own controls.
      if (target instanceof Element && target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='dialog'], [role='menu']")) return;
      const current = useSettingsStore.getState().explorerZoom;
      let next: number;
      if (event.key === "+" || event.key === "=") next = current + EXPLORER_ZOOM_STEP;
      else if (event.key === "-") next = current - EXPLORER_ZOOM_STEP;
      else if (event.key === "0" && !event.shiftKey) next = EXPLORER_ZOOM_DEFAULT;
      else return;
      event.preventDefault();
      setZoom(next);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isActive, isMac, setZoom]);

  return (
    <div className="sticky left-0 flex items-center justify-end gap-1 px-2 py-1 border-t border-border bg-bg-surface shrink-0 no-select" role="group" aria-label="Explorer zoom">
      <button type="button" className={BUTTON_CLASS} aria-label="Zoom out" title={`Zoom out (${modifier}−)`}
        disabled={zoom <= EXPLORER_ZOOM_MIN} onClick={() => setZoom(zoom - EXPLORER_ZOOM_STEP)}>
        <Minus size={14} aria-hidden="true" />
      </button>
      <input type="range" aria-label="Explorer zoom" aria-valuetext={`${zoom}%`}
        min={EXPLORER_ZOOM_MIN} max={EXPLORER_ZOOM_MAX} step={EXPLORER_ZOOM_STEP} value={zoom}
        onChange={(event) => setZoom(Number(event.target.value))}
        className="w-24 h-1.5 cursor-pointer accent-accent rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <button type="button" className={BUTTON_CLASS} aria-label="Zoom in" title={`Zoom in (${modifier}+)`}
        disabled={zoom >= EXPLORER_ZOOM_MAX} onClick={() => setZoom(zoom + EXPLORER_ZOOM_STEP)}>
        <Plus size={14} aria-hidden="true" />
      </button>
      <button type="button" aria-label="Reset explorer zoom" title={`Reset zoom (${modifier}0)`}
        onClick={() => setZoom(EXPLORER_ZOOM_DEFAULT)}
        className="w-12 h-7 rounded-md text-[length:var(--text-xs)] tabular-nums text-text-muted hover:text-text-secondary hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {zoom}%
      </button>
    </div>
  );
}
