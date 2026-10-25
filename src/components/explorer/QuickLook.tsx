import { lazy, Suspense, useEffect, useLayoutEffect, useId, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Loader2, X } from "lucide-react";
import type { ExplorerEntry } from "../../types/explorer";
import type { PreviewAdapter, PreviewData } from "../../types/preview";
import { formatBytes } from "../../utils/format";
import { ModalBackdrop } from "../shared/ModalBackdrop";
import { isRawPreview } from "../../lib/preview";
import { videoMime } from "../../lib/video-preview";
import { VideoPreview } from "./VideoPreview";

interface QuickLookProps {
  adapter: PreviewAdapter;
  entry: ExplorerEntry;
  entries: ExplorerEntry[];
  onChange: (entry: ExplorerEntry) => void;
  onClose: () => void;
  onDownload: (entry: ExplorerEntry) => void;
  transfersBusy?: boolean;
}

const BUTTON = "p-2 rounded-md text-text-secondary hover:bg-bg-subtle disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const PdfPreview = lazy(() => import("./PdfPreview"));

export function QuickLook({ adapter, entry, entries, onChange, onClose, onDownload, transfersBusy = false }: QuickLookProps) {
  const [data, setData] = useState<PreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const index = entries.findIndex((item) => item.id === entry.id);
  const isVideo = videoMime(entry.name) !== null && !!adapter.video;

  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);

  useLayoutEffect(() => {
    // Next/previous can disable the button that had focus. Keep subsequent
    // Escape/Space and arrow keys inside the dialog, and clear old content
    // before painting the next file's name.
    panel.current?.focus();
    setData(null);
    setError(null);
  }, [entry.id]);

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(null);
    if (isVideo) return;
    void adapter.load(entry, controller.signal).then((result) => {
      if (!controller.signal.aborted) setData(result);
    }, (reason: unknown) => {
      if (!controller.signal.aborted) setError(
        reason && typeof reason === "object" && "message" in reason ? String(reason.message) : "The preview could not be loaded. Try downloading the file.",
      );
    });
    return () => controller.abort();
  }, [adapter, entry, isVideo]);

  return (
    <ModalBackdrop onClose={onClose} className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-8 bg-black/60">
      <div
        ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        data-testid="quick-look"
        className="flex flex-col w-full max-w-5xl h-[85vh] min-h-0 rounded-xl border border-border bg-bg-overlay shadow-[var(--shadow-lg)] outline-none"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape" || (event.key === " " && event.target === panel.current)) {
            event.preventDefault(); onClose();
          }
          if (event.target === panel.current) {
            if (event.key === "ArrowLeft" && index > 0) { event.preventDefault(); onChange(entries[index - 1]); }
            if (event.key === "ArrowRight" && index < entries.length - 1) { event.preventDefault(); onChange(entries[index + 1]); }
          }
          if (event.key === "Tab") {
            const buttons = Array.from(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), [tabindex='0']") ?? []);
            const first = buttons[0], last = buttons[buttons.length - 1];
            if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }}
      >
        <div className="flex items-center gap-2 px-3 sm:px-5 py-3 border-b border-border shrink-0">
          <div className="flex-1 min-w-0">
            <h2 id={titleId} className="truncate font-medium text-text-primary">{entry.name}</h2>
            <p className="text-xs text-text-muted">{formatBytes(data?.sourceSize ?? entry.size)} · {isRawPreview(entry.name) ? "Embedded JPEG · " : ""}Quick Look</p>
          </div>
          <button className={BUTTON} aria-label="Previous file" disabled={index <= 0} onClick={() => onChange(entries[index - 1])}><ChevronLeft size={18} /></button>
          <button className={BUTTON} aria-label="Next file" disabled={index < 0 || index >= entries.length - 1} onClick={() => onChange(entries[index + 1])}><ChevronRight size={18} /></button>
          <button className={BUTTON} aria-label="Download file" title="Download file" onClick={() => onDownload(entry)}><Download size={18} /></button>
          <button className={BUTTON} aria-label="Close preview" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto bg-bg-base rounded-b-xl" aria-busy={!isVideo && !data && !error}>
          {isVideo ? <VideoPreview key={entry.id} adapter={adapter.video!} entry={entry} busy={transfersBusy} /> : error ? <p role="alert" className="p-8 text-sm text-text-secondary">{error}</p> : !data ? (
            <div role="status" className="flex items-center justify-center gap-2 h-full text-sm text-text-muted"><Loader2 size={18} className="motion-safe:animate-spin" />Loading preview…</div>
          ) : <PreviewContent data={data} name={entry.name} />}
        </div>
      </div>
    </ModalBackdrop>
  );
}

function PreviewContent({ data, name }: { data: PreviewData; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (data.kind !== "image") return;
    const objectUrl = URL.createObjectURL(new Blob([data.bytes], { type: "image/png" }));
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [data]);
  if (data.kind === "image") return url ? <div className="flex items-center justify-center h-full p-4"><img src={url} alt={name} className="max-w-full max-h-full object-contain" /></div> : null;
  if (data.kind === "pdf") return <Suspense fallback={<p role="status" className="p-8 text-sm text-text-muted">Loading PDF viewer…</p>}><PdfPreview bytes={data.bytes} /></Suspense>;
  return <>
    {data.truncated && <p role="status" className="sticky top-0 px-5 py-2 bg-bg-surface border-b border-border text-xs text-text-muted">Showing the first 512 KiB. Download the file for the full content.</p>}
    <pre tabIndex={0} aria-label="File contents" className="p-5 text-sm font-mono whitespace-pre-wrap break-words text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">{new TextDecoder().decode(data.bytes)}</pre>
  </>;
}
