import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

// Vite gives every bundled font/CMap its final asset URL. No CDN or document-
// supplied URL is fetched, and these assets are only loaded with the viewer.
const fontUrls = import.meta.glob<string>("/node_modules/pdfjs-dist/standard_fonts/*", { query: "?url", import: "default", eager: true });
const cmapUrls = import.meta.glob<string>("/node_modules/pdfjs-dist/cmaps/*.bcmap", { query: "?url", import: "default", eager: true });

async function bundledBytes(url: string | undefined) {
  if (!url) throw new Error("A required PDF resource is unavailable");
  const response = await fetch(url);
  if (!response.ok) throw new Error("A required PDF resource could not be loaded");
  return new Uint8Array(await response.arrayBuffer());
}
class FontFactory {
  fetch({ filename }: { filename: string }) { return bundledBytes(fontUrls[`/node_modules/pdfjs-dist/standard_fonts/${filename}`]); }
}
class CMapFactory {
  async fetch({ name }: { name: string }) {
    return { cMapData: await bundledBytes(cmapUrls[`/node_modules/pdfjs-dist/cmaps/${name}.bcmap`]), compressionType: 1 };
  }
}

export default function PdfPreview({ bytes }: { bytes: ArrayBuffer }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [password, setPassword] = useState("");
  const [rendering, setRendering] = useState(true);
  const passwordCallback = useRef<((password: string) => void) | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let disposed = false;
    setDocument(null); setPage(1); setError(null); setPasswordRequired(false);
    const task = getDocument({
      // PDF.js transfers ownership to the worker. Keep the original reusable.
      data: new Uint8Array(bytes.slice(0)), isEvalSupported: false, enableXfa: false,
      useWorkerFetch: false, useWasm: false, disableAutoFetch: true,
      StandardFontDataFactory: FontFactory, CMapReaderFactory: CMapFactory,
    });
    task.onPassword = (submit: (password: string) => void) => {
      if (!disposed) { passwordCallback.current = submit; setPasswordRequired(true); }
    };
    void task.promise.then((pdf) => {
      if (!disposed) { setDocument(pdf); setPasswordRequired(false); passwordCallback.current = null; }
    }, (reason: unknown) => {
      if (!disposed) setError(reason instanceof Error ? reason.message : "This PDF could not be opened.");
    });
    return () => { disposed = true; passwordCallback.current = null; void task.destroy().catch(() => {}); };
  }, [bytes]);

  useEffect(() => {
    if (!document || !canvas.current) return;
    let disposed = false;
    let renderTask: RenderTask | undefined;
    let cleanupPage: (() => void) | undefined;
    setRendering(true); setError(null);
    // Render into a fresh canvas so a cancelled render never writes into the
    // canvas used by the next page. Cap backing pixels, even on Retina screens.
    const target = canvas.current;
    void document.getPage(page).then(async (pdfPage) => {
      if (disposed) { pdfPage.cleanup(); return; }
      cleanupPage = () => { pdfPage.cleanup(); };
      const base = pdfPage.getViewport({ scale: 1 });
      const scale = Math.min(1.5, 2048 / Math.max(base.width, base.height), Math.sqrt(4_000_000 / (base.width * base.height)));
      if (!Number.isFinite(scale) || scale <= 0) throw new Error("This PDF page has invalid dimensions");
      const viewport = pdfPage.getViewport({ scale });
      const scratch = target.ownerDocument.createElement("canvas");
      scratch.width = Math.ceil(viewport.width); scratch.height = Math.ceil(viewport.height);
      renderTask = pdfPage.render({ canvas: scratch, viewport, annotationMode: 0 });
      await renderTask.promise;
      if (!disposed) {
        target.width = scratch.width; target.height = scratch.height;
        target.getContext("2d")?.drawImage(scratch, 0, 0);
        setRendering(false);
      }
    }).catch((reason: unknown) => {
      if (!disposed) { setRendering(false); setError(reason instanceof Error ? reason.message : "This PDF page could not be rendered."); }
    }).finally(() => cleanupPage?.());
    return () => { disposed = true; renderTask?.cancel(); };
  }, [document, page]);

  return <div className="flex flex-col min-h-full">
    {passwordRequired && <form className="flex flex-wrap items-center justify-center gap-2 p-6" onSubmit={(event) => {
      event.preventDefault(); passwordCallback.current?.(password); setPassword(""); setPasswordRequired(false);
    }}>
      <label className="text-sm text-text-secondary" htmlFor="preview-pdf-password">PDF password</label>
      <input id="preview-pdf-password" type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} className="rounded border border-border bg-bg-subtle px-2 py-1 text-text-primary" />
      <button type="submit" className="rounded bg-accent px-3 py-1 text-text-inverse">Unlock PDF</button>
    </form>}
    {document && <div className="sticky top-0 z-10 flex items-center justify-center gap-3 p-2 bg-bg-surface border-b border-border text-sm text-text-secondary">
      <button aria-label="Previous PDF page" disabled={page <= 1} onClick={() => setPage((n) => n - 1)} className="p-1 rounded disabled:opacity-30 focus-visible:ring-2 focus-visible:ring-ring"><ChevronLeft size={18} /></button>
      <span aria-live="polite">Page {page} of {document.numPages}</span>
      <button aria-label="Next PDF page" disabled={page >= document.numPages} onClick={() => setPage((n) => n + 1)} className="p-1 rounded disabled:opacity-30 focus-visible:ring-2 focus-visible:ring-ring"><ChevronRight size={18} /></button>
    </div>}
    {error && <p role="alert" className="p-6 text-sm text-text-secondary">{error}</p>}
    {!error && !passwordRequired && (!document || rendering) && <p role="status" className="p-4 text-center text-sm text-text-muted">Rendering PDF…</p>}
    <canvas ref={canvas} aria-label={`PDF page ${page}`} hidden={!document || !!error || rendering} className="block max-w-full h-auto mx-auto my-4 shadow-md bg-white" />
  </div>;
}
