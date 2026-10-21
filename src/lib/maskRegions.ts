import type { LineRow } from "./types";
import type { Point, RegionData } from "./workflow";

/** Saved boundaries eligible for automatic lettering removal. */
export function maskRegion(line: Pick<LineRow, "x" | "y" | "w" | "h" | "sourceState">, region?: RegionData): Point[] {
  if (line.sourceState === "ignored") return [];
  const { x, y, w, h } = line;
  const box = x == null || y == null || w == null || h == null ||
      ![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0 ? null : { x, y, w, h };
  const polygon = region?.polygon;
  // The box marks the source lettering; the polygon is the typesetting shape. A
  // polygon that contains the box (a balloon interior) bounds the mask more
  // closely. One that does not (a copy of an older box, or a fitted shape tighter
  // than the lettering) would cut the lettering off, so the box is used instead.
  if (polygon && polygon.length >= 3 && !(box && !containsBox(polygon, box))) return polygon;
  if (!box) return [];
  return [{ x: box.x, y: box.y }, { x: box.x + box.w, y: box.y }, { x: box.x + box.w, y: box.y + box.h }, { x: box.x, y: box.y + box.h }];
}

/** Whether every corner of `box` lies inside (or within a hair of) `polygon`. */
function containsBox(polygon: Point[], box: { x: number; y: number; w: number; h: number }) {
  const e = 0.002;
  const inside = (x: number, y: number) => {
    let hit = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i], b = polygon[j];
      if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
    }
    return hit;
  };
  const left = box.x + e, right = box.x + box.w - e, top = box.y + e, bottom = box.y + box.h - e;
  return [[left, top], [right, top], [right, bottom], [left, bottom]].every(([x, y]) => inside(x, y));
}

export function copiesBox(polygon: Point[] | undefined, box: { x: number | null; y: number | null; w: number | null; h: number | null }) {
  if (!polygon || polygon.length !== 4 || box.x == null || box.y == null || box.w == null || box.h == null) return false;
  const corners = [[box.x, box.y], [box.x + box.w, box.y], [box.x + box.w, box.y + box.h], [box.x, box.y + box.h]];
  return polygon.every((p) => corners.some(([x, y]) => Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6));
}

export type MaskPlacement = "inside" | "outside" | "unknown";

/**
 * Where a region's lettering sits, which decides how its removal mask is
 * fitted: inside a balloon or box it grows to flat paper, outside it also
 * takes the lettering's outline. The Director's own reading of the enclosure
 * wins, then the detector's class, then the bubble line types.
 */
export function maskPlacement(line: Pick<LineRow, "lineType">, region?: RegionData): MaskPlacement {
  const enclosure = region?.directorPresentation?.enclosure;
  if (enclosure === "bubble" || enclosure === "box") return "inside";
  if (enclosure === "none") return "outside";
  if (region?.detectionKind === "bubble") return "inside";
  if (region?.detectionKind === "free") return "outside";
  if (['""', "()"].includes(line.lineType)) return "inside";
  return "unknown";
}
