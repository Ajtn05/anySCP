export const EXPLORER_ZOOM_MIN = 75;
export const EXPLORER_ZOOM_MAX = 200;
export const EXPLORER_ZOOM_DEFAULT = 100;
export const EXPLORER_ZOOM_STEP = 25;

export function normalizeExplorerZoom(value: number): number {
  if (!Number.isFinite(value)) return EXPLORER_ZOOM_DEFAULT;
  return Math.max(EXPLORER_ZOOM_MIN, Math.min(EXPLORER_ZOOM_MAX,
    Math.round(value / EXPLORER_ZOOM_STEP) * EXPLORER_ZOOM_STEP));
}
