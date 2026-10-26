import type { ExplorerEntry } from "./explorer";

export type PreviewKind = "image" | "text" | "pdf" | "video";

export interface PreviewData {
  kind: Exclude<PreviewKind, "video">;
  sourceSize: number;
  truncated: boolean;
  bytes: ArrayBuffer;
}

export interface VideoSource {
  url: string;
  mime: string;
  sourceSize: number;
  release(): void;
  deferred(): Promise<boolean>;
}

/** Optional, read-only content adapter; absent on S3 and SCP. */
export interface PreviewAdapter {
  supports(entry: ExplorerEntry): boolean;
  load(entry: ExplorerEntry, signal: AbortSignal): Promise<PreviewData>;
  video?: { open(entry: ExplorerEntry, signal: AbortSignal): Promise<VideoSource> };
  thumbnails?: {
    supports(entry: ExplorerEntry): boolean;
    /** Return a cached PNG without I/O, subject to the usual invalidation rules. */
    getCached?(entry: ExplorerEntry): ArrayBuffer | undefined;
    load(entry: ExplorerEntry, signal: AbortSignal): Promise<ArrayBuffer>;
    clear(): Promise<void>;
  };
}
