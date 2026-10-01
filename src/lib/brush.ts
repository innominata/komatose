export const BRUSH_PRESETS = [2, 4, 8, 12, 16, 32] as const;
export const SIZE_BRUSH_TOOLS = [
  "brush",
  "erase",
  "clone-stamp",
  "blur",
  "restore",
  "raw",
] as const;
export type SizeBrushTool = (typeof SIZE_BRUSH_TOOLS)[number];

export function usesBrushSize(tool: string): tool is SizeBrushTool {
  return (SIZE_BRUSH_TOOLS as readonly string[]).includes(tool);
}
export const PAGE_BRUSH_MIN = 1;
export const PAGE_BRUSH_MAX = 200;
export const REVIEW_BRUSH_MAX = 80;
export const REVIEW_CROP_ZOOMS = [1, 2, 4] as const;
export type ReviewCropZoom = (typeof REVIEW_CROP_ZOOMS)[number];

export function clampBrush(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function nudgeBrush(value: number, delta: number, min: number, max: number) {
  return clampBrush(value + delta, min, max);
}

export function brushDeltaFromWheel(event: WheelEvent) {
  const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
  if (!delta) return 0;
  return delta < 0 ? 1 : -1;
}

/** Circle diameter in the 32px tool button, scaled from a 2–32px brush. */
export function brushSwatchPx(size: number) {
  return Math.max(3, Math.round((size / 32) * 16));
}

export type ShiftBrushWheelOpts = {
  enabled: () => boolean;
  value: () => number;
  set: (size: number) => void;
  min: number;
  max: number;
};

/** Svelte action: Shift+wheel changes brush size by 1px. */
export function shiftBrushWheel(node: HTMLElement, opts: ShiftBrushWheelOpts) {
  let current = opts;
  const onWheel = (event: WheelEvent) => {
    if (!current.enabled() || !event.shiftKey) return;
    const step = brushDeltaFromWheel(event);
    if (!step) return;
    event.preventDefault();
    current.set(nudgeBrush(current.value(), step, current.min, current.max));
  };
  node.addEventListener("wheel", onWheel, { passive: false });
  return {
    update(next: ShiftBrushWheelOpts) {
      current = next;
    },
    destroy() {
      node.removeEventListener("wheel", onWheel);
    },
  };
}
