import type { Point } from "./workflow";

/**
 * Text that grows or shrinks as it goes: glyph sizes ramp linearly from `from` to `to`
 * percent of the fitted size, first glyph to last, in each paragraph.
 */
export type SizeRamp = { from: number; to: number };

export const RAMP_MIN = 10;
export const RAMP_MAX = 100;

const round = (n: number) => Math.round(n * 10) / 10;

/** A valid ramp, or undefined for none (missing, malformed, or flat). */
export function parseSizeRamp(value: unknown): SizeRamp | undefined {
  if (!value || typeof value !== "object") return undefined;
  const from = Number((value as SizeRamp).from), to = Number((value as SizeRamp).to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined;
  const ramp = {
    from: round(Math.min(RAMP_MAX, Math.max(RAMP_MIN, from))),
    to: round(Math.min(RAMP_MAX, Math.max(RAMP_MIN, to))),
  };
  return Math.abs(ramp.from - ramp.to) < 1 ? undefined : ramp;
}

/** The size factor (percent) of glyph `k` of `n` along a ramp. */
export function rampAt(ramp: SizeRamp, k: number, n: number): number {
  return n > 1 ? ramp.from + ((ramp.to - ramp.from) * k) / (n - 1) : Math.max(ramp.from, ramp.to);
}

/**
 * Shift-dragging a corner of a four-point polygon slants one edge and ramps the text to
 * follow it. Horizontal text: the corner moves up or down only, and the ramp is the ratio
 * of the left and right side heights, so the baseline stays put while the tops follow the
 * slanted edge. Stacked text: the corner moves sideways, and the ramp runs from the top
 * width to the bottom width. `ramp` is null when the sides end up equal (no ramp).
 */
export function rampGeometry(
  polygon: Point[],
  vertex: number,
  to: Point,
  stacked: boolean,
): { polygon: Point[]; ramp: SizeRamp | null } | null {
  if (polygon.length !== 4 || vertex < 0 || vertex > 3) return null;
  const moved = polygon.map((p, i) =>
    i !== vertex ? p : stacked ? { x: to.x, y: p.y } : { x: p.x, y: to.y },
  );
  // Pair the corners into the two sides the text runs between.
  const axis = stacked ? "y" : "x", across = stacked ? "x" : "y";
  const order = [0, 1, 2, 3].sort((a, b) => moved[a][axis] - moved[b][axis]);
  const extent = (pair: number[]) => Math.abs(moved[pair[0]][across] - moved[pair[1]][across]);
  const start = extent(order.slice(0, 2)), end = extent(order.slice(2));
  const big = Math.max(start, end);
  if (big <= 0 || Math.min(start, end) / big < RAMP_MIN / 100) return null;
  return { polygon: moved, ramp: parseSizeRamp({ from: (100 * start) / big, to: (100 * end) / big }) ?? null };
}

/** The point a ramp drag moves a corner to: locked to vertical, or horizontal for stacked text. */
export function rampDragPoint(start: Point, at: Point, stacked: boolean): Point {
  return stacked ? { x: at.x, y: start.y } : { x: start.x, y: at.y };
}
