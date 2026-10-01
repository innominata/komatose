import type { Point } from "$lib/workflow";

/** Walk a brush path in native pixels so fast strokes do not skip. */
export function interpolateBrushPixels(points: Point[], width: number, height: number) {
  const out: { x: number; y: number }[] = [];
  let prev: { x: number; y: number } | null = null;
  for (const point of points) {
    const x = Math.min(width - 1, Math.max(0, Math.round(point.x * width)));
    const y = Math.min(height - 1, Math.max(0, Math.round(point.y * height)));
    if (!prev) {
      out.push({ x, y });
    } else {
      const steps = Math.max(1, Math.round(Math.hypot(x - prev.x, y - prev.y)));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        out.push({
          x: Math.round(prev.x + (x - prev.x) * t),
          y: Math.round(prev.y + (y - prev.y) * t),
        });
      }
    }
    prev = { x, y };
  }
  return out;
}
