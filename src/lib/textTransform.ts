import type { Point, TextStyle } from "./workflow";

/** Photoshop's Free Transform accepts up to ±89.99°; stop well short of degenerate shears. */
export const MAX_SKEW = 75;
/** 2×2 linear map in SVG/CSS `matrix(a b c d)` order: x' = a·x + c·y, y' = b·x + d·y. */
export type Matrix2 = readonly [a: number, b: number, c: number, d: number];
const rad = (deg: number) => (deg * Math.PI) / 180;
/** m · n — applies n first, then m. */
export function mulMatrix(m: Matrix2, n: Matrix2): Matrix2 {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
  ];
}
const rotationMatrix = (deg: number): Matrix2 => {
  const a = rad(deg);
  return [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a)];
};
const skewXMatrix = (deg: number) => [1, 0, Math.tan(rad(deg)), 1] as const;
const skewYMatrix = (deg: number) => [1, Math.tan(rad(deg)), 0, 1] as const;
/**
 * Whole-layer text transform, rotation outermost: R(rotation) · skewX · skewY.
 * Shared by the SVG preview, live handle dragging, and the PSD text-layer matrix.
 * Sequential shears keep the determinant at 1, so the map is always invertible.
 */
export function textMatrix(
  style: Pick<TextStyle, "rotation" | "skewX" | "skewY">,
): Matrix2 {
  return mulMatrix(
    mulMatrix(rotationMatrix(style.rotation), skewXMatrix(style.skewX ?? 0)),
    skewYMatrix(style.skewY ?? 0),
  );
}
/** Inverse of {@link textMatrix}: skewY⁻¹ · skewX⁻¹ · R⁻¹, exact when skew is zero. */
export function inverseTextMatrix(
  style: Pick<TextStyle, "rotation" | "skewX" | "skewY">,
): Matrix2 {
  return mulMatrix(
    mulMatrix(skewYMatrix(-(style.skewY ?? 0)), skewXMatrix(-(style.skewX ?? 0))),
    rotationMatrix(-style.rotation),
  );
}
/** Apply a linear map about a pivot point. */
export function applyMatrixAbout(m: Matrix2, p: Point, c: Point): Point {
  const dx = p.x - c.x,
    dy = p.y - c.y;
  return { x: c.x + m[0] * dx + m[2] * dy, y: c.y + m[1] * dx + m[3] * dy };
}
/** SVG transform for a layout's outer group; plain `rotate(...)` when there is no skew. */
export function textTransformSvg(style: TextStyle, cx: number, cy: number) {
  const skewX = style.skewX ?? 0,
    skewY = style.skewY ?? 0;
  const rotate = `rotate(${style.rotation} ${cx} ${cy})`;
  if (!skewX && !skewY) return rotate;
  return `${rotate} translate(${cx} ${cy}) skewX(${skewX}) skewY(${skewY}) translate(${-cx} ${-cy})`;
}
/** Incremental SVG wrap that takes `from` to `to` about `(cx, cy)`. */
export function deltaTextTransform(
  from: Pick<TextStyle, "rotation" | "skewX" | "skewY">,
  to: Pick<TextStyle, "rotation" | "skewX" | "skewY">,
  cx: number,
  cy: number,
) {
  const sameSkew =
    (from.skewX ?? 0) === (to.skewX ?? 0) && (from.skewY ?? 0) === (to.skewY ?? 0);
  if (sameSkew) {
    const delta = to.rotation - from.rotation;
    return delta ? `rotate(${delta} ${cx} ${cy})` : "";
  }
  const t = mulMatrix(textMatrix(to), inverseTextMatrix(from));
  return `translate(${cx} ${cy}) matrix(${t[0]} ${t[1]} ${t[2]} ${t[3]} 0 0) translate(${-cx} ${-cy})`;
}
/** CSS `matrix()` for the same incremental map, used with `transform-origin` at the pivot. */
export function cssDeltaTransform(
  from: Pick<TextStyle, "rotation" | "skewX" | "skewY">,
  to: Pick<TextStyle, "rotation" | "skewX" | "skewY">,
) {
  const t = mulMatrix(textMatrix(to), inverseTextMatrix(from));
  return `matrix(${t[0]}, ${t[1]}, ${t[2]}, ${t[3]}, 0, 0)`;
}
export function clampSkew(deg: number) {
  return (
    Math.round(Math.min(MAX_SKEW, Math.max(-MAX_SKEW, deg)) * 10) / 10
  );
}
/**
 * Extra shear from dragging a polygon-edge handle in page pixels, about the region centre.
 * Bottom edge, horizontal drag → skewX; right edge, vertical drag → skewY.
 */
export function draggedSkew(
  axis: "x" | "y",
  initial: number,
  start: Point,
  end: Point,
  center: Point,
  width: number,
  height: number,
) {
  if (axis === "x") {
    const rise = (start.y - center.y) * height;
    if (Math.abs(rise) < 1) return initial;
    return clampSkew(
      initial + (Math.atan(((end.x - start.x) * width) / rise) * 180) / Math.PI,
    );
  }
  const run = (start.x - center.x) * width;
  if (Math.abs(run) < 1) return initial;
  return clampSkew(
    initial + (Math.atan(((end.y - start.y) * height) / run) * 180) / Math.PI,
  );
}
/** Midpoint of the rightmost (or bottommost) polygon edge — where the skew handle sits. */
export function polygonEdgeHandle(pts: Point[], side: "right" | "bottom"): Point {
  if (!pts.length) return { x: 0, y: 0 };
  let best = pts[0];
  let score = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i],
      b = pts[(i + 1) % pts.length];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const s = side === "right" ? mid.x : mid.y;
    if (s > score) {
      score = s;
      best = mid;
    }
  }
  return best;
}
