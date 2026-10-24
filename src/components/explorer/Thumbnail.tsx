import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ExplorerEntry } from "../../types/explorer";
import type { PreviewAdapter } from "../../types/preview";

type Watcher = { observer: IntersectionObserver; callbacks: Map<Element, (visible: boolean) => void> };
const watchers = new WeakMap<Element, Watcher>();

function observe(node: Element, callback: (visible: boolean) => void) {
  const root = node.closest("[data-explorer-scroll]");
  if (!root || typeof IntersectionObserver === "undefined") return () => {};
  let watcher = watchers.get(root);
  if (!watcher) {
    const callbacks = new Map<Element, (visible: boolean) => void>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) callbacks.get(entry.target)?.(entry.isIntersecting);
    }, { root });
    watcher = { observer, callbacks }; watchers.set(root, watcher);
  }
  const current = watcher;
  current.callbacks.set(node, callback); current.observer.observe(node);
  return () => {
    current.observer.unobserve(node); current.callbacks.delete(node);
    if (!current.callbacks.size) { current.observer.disconnect(); watchers.delete(root); }
  };
}

export function Thumbnail({ entry, adapter, active, paused, fallback }: {
  entry: ExplorerEntry; adapter: NonNullable<PreviewAdapter["thumbnails"]>;
  active: boolean; paused: boolean; fallback: ReactNode;
}) {
  const node = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [data, setData] = useState<ArrayBuffer | null>(null);
  const [retry, setRetry] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setVisible(false);
    if (!active || !node.current || !adapter.supports(entry)) return;
    return observe(node.current, setVisible);
  }, [active, adapter, entry]);
  useEffect(() => {
    if (!visible || !active) { setData(null); return; }
    if (paused) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setFailed(false);
    void adapter.load(entry, controller.signal).then((bytes) => {
      if (controller.signal.aborted) return;
      setData(bytes);
    }, (reason: unknown) => {
      if (controller.signal.aborted) return;
      if (reason && typeof reason === "object" && "kind" in reason && reason.kind === "preview_deferred") {
        timer = setTimeout(() => setRetry((n) => n + 1), 1500);
      } else if (!(reason instanceof DOMException && reason.name === "AbortError")) setFailed(true);
    });
    return () => {
      controller.abort(); clearTimeout(timer);
    };
  }, [active, visible, paused, adapter, entry, retry]);
  useEffect(() => {
    if (!data) { setUrl(null); return; }
    const objectUrl = URL.createObjectURL(new Blob([data], { type: "image/png" }));
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [data]);
  return <span ref={node} className="flex items-center justify-center w-full h-24 shrink-0" title={failed ? "Thumbnail unavailable. Use Quick Look or Download." : undefined}>
    {url ? <img src={url} alt="" draggable={false} onError={() => { setData(null); setFailed(true); }} className="max-w-full max-h-full object-contain pointer-events-none" /> : fallback}
  </span>;
}
