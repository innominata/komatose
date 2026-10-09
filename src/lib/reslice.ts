/** Page-sized strips keep their width when a vision model limits the long edge. */
export const PAGE_HEIGHT_RATIO = 1.5;
export const MAX_SLICE_HEIGHT = 16_000;
export const MIN_SLICE_HEIGHT = 200;
export const SLICE_HEIGHT_SLACK = 0.1;
export type ManualSlice = { top: number; bottom: number; height: number };

export function allowedSliceHeight(target: number) {
  return Math.min(MAX_SLICE_HEIGHT, Math.round(target * (1 + SLICE_HEIGHT_SLACK)));
}

export function manualSliceRanges(height: number, cuts: number[], target: number): ManualSlice[] {
  const bounds = [0, ...new Set(cuts)].sort((a, b) => a - b).concat(height);
  return bounds.slice(1).flatMap((bottom, i) => {
    const top = bounds[i];
    return bottom - top > allowedSliceHeight(target) ? [{ top, bottom, height: bottom - top }] : [];
  });
}
export type ResliceSizing = "pages" | "strips" | "custom";
export type ResliceSizeOptions = { sizing?: ResliceSizing; maxHeight?: number };

export function validSliceHeight(height: unknown): height is number {
  return typeof height === "number" && Number.isInteger(height) &&
    height >= MIN_SLICE_HEIGHT && height <= MAX_SLICE_HEIGHT;
}

export function sliceHeight(width: number, opts: ResliceSizeOptions = {}): number {
  if (opts.sizing === "pages") {
    return Math.min(MAX_SLICE_HEIGHT, Math.max(MIN_SLICE_HEIGHT, Math.round(width * PAGE_HEIGHT_RATIO)));
  }
  if (opts.sizing === "custom") {
    if (!validSliceHeight(opts.maxHeight)) {
      throw new Error(`Choose a whole-number slice height from ${MIN_SLICE_HEIGHT} to ${MAX_SLICE_HEIGHT}px.`);
    }
    return opts.maxHeight;
  }
  // Preserve old jobs and API clients that did not specify a size.
  return MAX_SLICE_HEIGHT;
}
