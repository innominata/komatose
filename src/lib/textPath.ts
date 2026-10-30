import type { Point, RegionData, TextPath } from "./workflow";

/**
 * Type on a path, after PhotoCraft's `PathFrame` (github.com/storytold/photocraft,
 * crates/text/src/warp.rs, MIT/Apache-2.0): the path is flattened with cumulative arc
 * lengths, text-space x is the distance along it, and each glyph is moved rigidly to the
 * point and tangent under its horizontal centre, so letters keep their shapes.
 */
export type PathFrame = {
  length: number;
  /** Point and unit tangent at arc length `s` (clamped to the ends). */
  at(s: number): { x: number; y: number; tx: number; ty: number };
  /** Affine [a, b, c, d, e, f] placing a glyph centred at arc length `s`; undefined off the path. */
  frame(s: number): [number, number, number, number, number, number] | undefined;
  /** SVG path data of the flattened curve. */
  d: string;
};

/** Points of a Catmull-Rom spline through `pts`, so a few handles make a smooth curve. */
export function smoothPath(pts: Point[], steps = 24): Point[] {
  if (pts.length < 3) return pts.slice();
  const out: Point[] = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let k = 1; k <= steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  return out;
}

/** The frame of a path through `points` (page pixels); undefined for a path without length. */
export function pathFrame(points: Point[], flip = false): PathFrame | undefined {
  const raw = smoothPath(flip ? [...points].reverse() : points);
  const pts: Point[] = [];
  for (const p of raw) {
    const last = pts.at(-1);
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) pts.push(p);
  }
  if (pts.length < 2) return;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const length = cum.at(-1)!;
  if (!(length > 1e-6)) return;
  const at = (s: number) => {
    let lo = 1, hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < s) lo = mid + 1;
      else hi = mid;
    }
    const a = pts[lo - 1], b = pts[lo];
    const len = Math.max(1e-12, cum[lo] - cum[lo - 1]);
    const tx = (b.x - a.x) / len, ty = (b.y - a.y) / len;
    const along = s - cum[lo - 1];
    return { x: a.x + tx * along, y: a.y + ty * along, tx, ty };
  };
  return {
    length,
    at,
    frame(s) {
      if (s < 0 || s > length) return;
      const p = at(s);
      return [p.tx, p.ty, -p.ty, p.tx, p.x, p.y];
    },
    d: pts.map((p, i) => `${i ? "L" : "M"}${Math.round(p.x * 100) / 100} ${Math.round(p.y * 100) / 100}`).join(""),
  };
}

/** A gentle arc across a box: the starting path when a region switches to type on a path. */
export function defaultTextPath(box: { x: number; y: number; w: number; h: number }): Point[] {
  const y = box.y + box.h * 0.62;
  return [
    { x: box.x + box.w * 0.08, y },
    { x: box.x + box.w * 0.5, y: box.y + box.h * 0.35 },
    { x: box.x + box.w * 0.92, y },
  ];
}

export type Cubic = [Point, Point, Point, Point];

/** The curve `pathFrame` follows as exact cubic Bezier segments (Catmull-Rom to Bezier). */
export function textPathBeziers(points: Point[], flip = false): Cubic[] {
  const pts = flip ? [...points].reverse() : points;
  if (pts.length < 2) return [];
  if (pts.length === 2) {
    const [a, b] = pts;
    const at = (t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    return [[a, at(1 / 3), at(2 / 3), b]];
  }
  const out: Cubic[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    out.push([
      p1,
      { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
      { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 },
      p2,
    ]);
  }
  return out;
}

const lerp = (a: Point, b: Point, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
function cubicAt(c: Cubic, t: number): Point {
  const a = lerp(c[0], c[1], t), b = lerp(c[1], c[2], t), d = lerp(c[2], c[3], t);
  return lerp(lerp(a, b, t), lerp(b, d, t), t);
}

/**
 * `segments` with the first `s` of their length cut off, so a reader that starts type at the
 * path's beginning (Photoshop) starts it where our layout does. Split by de Casteljau, so the
 * remaining curve is unchanged.
 */
export function trimBeziers(segments: Cubic[], s: number, steps = 64): Cubic[] {
  if (!(s > 1e-6)) return segments;
  let left = s;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    let walked = 0;
    let prev = seg[0];
    for (let k = 1; k <= steps; k++) {
      const p = cubicAt(seg, k / steps);
      const piece = Math.hypot(p.x - prev.x, p.y - prev.y);
      if (walked + piece >= left) {
        const t = (k - 1 + (piece > 0 ? (left - walked) / piece : 0)) / steps;
        const a = lerp(seg[0], seg[1], t), b = lerp(seg[1], seg[2], t), c = lerp(seg[2], seg[3], t);
        const ab = lerp(a, b, t), bc = lerp(b, c, t), m = lerp(ab, bc, t);
        return [[m, bc, c, seg[3]], ...segments.slice(i + 1)];
      }
      walked += piece;
      prev = p;
    }
    left -= walked;
  }
  return segments.slice(-1).map((seg) => [seg[3], seg[3], seg[3], seg[3]] as Cubic);
}

/** A region's text paths, including a single path saved before regions held several. */
export function regionTextPaths(region: Pick<RegionData, "textPaths" | "textPath">): TextPath[] {
  const paths = region.textPaths ?? (region.textPath ? [region.textPath] : []);
  return paths.filter((p) => p?.points?.length >= 2);
}

/** Every path moved by `map` (for region moves and page geometry changes). */
export function mapTextPaths(region: RegionData, map: (p: Point) => Point): Partial<RegionData> {
  const paths = regionTextPaths(region);
  if (!paths.length) return {};
  return { textPaths: paths.map((p) => ({ ...p, points: p.points.map(map) })), textPath: undefined };
}
