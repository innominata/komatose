import type { LineRow } from "./types";
import type { Point, RegionData } from "./workflow";

/** Saved boundaries eligible for automatic lettering removal. */
export function maskRegion(line: Pick<LineRow, "x" | "y" | "w" | "h" | "sourceState">, region?: RegionData): Point[] {
  if (line.sourceState === "ignored") return [];
  if (region?.polygon && region.polygon.length >= 3) return region.polygon;
  const { x, y, w, h } = line;
  if (x == null || y == null || w == null || h == null ||
      ![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return [];
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}
