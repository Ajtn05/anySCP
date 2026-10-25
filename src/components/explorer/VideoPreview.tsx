import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Film, Loader2 } from "lucide-react";
import type { ExplorerEntry } from "../../types/explorer";
import type { PreviewAdapter, VideoSource } from "../../types/preview";
import { videoMime } from "../../lib/video-preview";

export function VideoPreview({ adapter, entry, busy }: {
  adapter: NonNullable<PreviewAdapter["video"]>; entry: ExplorerEntry; busy: boolean;
}) {
  const [requested, setRequested] = useState(false);
  const [source, setSource] = useState<VideoSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const position = useRef(0);
  const current = useRef<VideoSource | null>(null);
  const region = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if ((busy || error) && (document.activeElement === document.body || document.activeElement === video.current)) region.current?.focus();
  }, [busy, error]);
  useEffect(() => {
    if (busy) { setRequested(false); setSource(null); return; }
    if (!requested) return;
    const controller = new AbortController();
    setError(null); setSource(null);
    const probe = document.createElement("video");
    if (!probe.canPlayType(videoMime(entry.name) ?? "")) {
      setError("This webview does not support this video format. Download the file to open it."); setRequested(false);
      return;
    }
    void adapter.open(entry, controller.signal).then((result) => {
      if (controller.signal.aborted) { result.release(); return; }
      current.current = result; setSource(result);
    }, (reason: unknown) => {
      if (controller.signal.aborted) return;
      setError(reason && typeof reason === "object" && "kind" in reason && reason.kind === "preview_deferred"
        ? "Video loading paused for a transfer. Try again when it finishes."
        : reason && typeof reason === "object" && "message" in reason ? String(reason.message) : "Video could not be loaded. Try again or download the file.");
      setRequested(false);
    });
    return () => {
      if (video.current) {
        position.current = video.current.currentTime;
        video.current.pause(); video.current.removeAttribute("src"); video.current.load();
      }
      current.current?.release(); current.current = null; controller.abort();
    };
  }, [adapter, entry, requested, busy]);

  const failed = async () => {
    const failedSource = current.current;
    if (!failedSource) return;
    const deferred = await failedSource.deferred().catch(() => false);
    if (current.current !== failedSource) return;
    setError(deferred ? "Video loading paused for a transfer. Try again when it finishes." : "The webview could not play this video. Its codec or container may be unsupported. Download the file to open it.");
    setSource(null); setRequested(false);
  };
  return <div ref={region} tabIndex={-1} className="flex flex-col items-center justify-center h-full min-h-0 gap-4 p-4 sm:p-6 outline-none">
    {source && !busy ? <video key={source.url} ref={(node) => { if (node) { video.current = node; node.focus(); } }} src={source.url}
      controls playsInline preload="metadata" crossOrigin="anonymous" disableRemotePlayback tabIndex={0}
      aria-label={`Video preview: ${entry.name}`} className="w-full min-h-0 flex-1 object-contain rounded-md bg-black"
      onError={() => void failed()} onLoadedMetadata={() => {
        const media = video.current;
        if (!media) return;
        if (!media.videoWidth || !media.videoHeight || media.videoWidth > 8192 || media.videoHeight > 8192 || media.videoWidth * media.videoHeight > 40_000_000) { void failed(); return; }
        if (position.current > 0 && position.current < media.duration) media.currentTime = position.current;
      }} /> : <div className="flex flex-col items-center max-w-md gap-4 text-center">
      <Film size={40} className="text-text-muted" aria-hidden="true" />
      {error && <p role="alert" className="text-sm text-text-secondary">{error}</p>}
      <p className="text-sm text-text-muted">{busy ? "Video loading is paused during transfers." : "Load a remote preview, then use the video controls to play. Playback uses your system’s supported codecs."}</p>
      <button className="inline-flex items-center gap-2 px-4 py-2 text-sm rounded-md border border-border bg-bg-surface text-text-primary hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        disabled={busy || requested} onClick={() => { region.current?.focus(); setRequested(true); }}>
        {requested && <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden="true" />}
        {requested ? "Loading video…" : position.current > 0 ? "Resume video" : error ? "Try video again" : "Load video"}
      </button>
    </div>}
    {source && !busy && <p className="text-xs text-text-muted text-center">Streams from the server. Seeking may need more data. Transfers pause video loading.</p>}
  </div>;
}
