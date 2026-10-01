import type { Point } from "./workflow";

export function normalizeRotation(angle: number) {
  return Math.round((((angle + 180) % 360 + 360) % 360 - 180) * 10) / 10;
}

/** Compute angles in image pixels so non-square pages rotate correctly. */
export function draggedRotation(initial: number, start: Point, end: Point, center: Point, width: number, height: number) {
  const angle = (point: Point) => Math.atan2((point.y - center.y) * height, (point.x - center.x) * width);
  if (Math.hypot((end.x - center.x) * width, (end.y - center.y) * height) < 1) return initial;
  return normalizeRotation(initial + (angle(end) - angle(start)) * 180 / Math.PI);
}
