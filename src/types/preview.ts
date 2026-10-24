import type { ExplorerEntry } from "./explorer";

export type PreviewKind = "image" | "text" | "pdf";

export interface PreviewData {
  kind: PreviewKind;
  sourceSize: number;
  truncated: boolean;
  bytes: ArrayBuffer;
}

/** Optional, read-only content adapter; absent on S3 and SCP. */
export interface PreviewAdapter {
  supports(entry: ExplorerEntry): boolean;
  load(entry: ExplorerEntry, signal: AbortSignal): Promise<PreviewData>;
}
