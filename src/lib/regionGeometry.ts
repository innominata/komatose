import type { LineRow } from './types';
import type { Point } from './workflow';

type Bounds = Pick<LineRow, 'x' | 'y' | 'w' | 'h'>;

/**
 * Paint order for page regions. Larger boxes are drawn first so a smaller
 * box on top receives the click where they overlap.
 */
export function regionPaintOrder<T extends Bounds>(regions: T[]): { line: T; index: number }[] {
  return regions
    .map((line, index) => ({
      line,
      index,
      area: Math.max(0, line.w ?? 0.2) * Math.max(0, line.h ?? 0.1),
    }))
    .sort((a, b) => b.area - a.area || a.index - b.index)
    .map(({ line, index }) => ({ line, index }));
}

export function regionRectangle(line: Bounds): Point[] {
  const x = line.x ?? 0, y = line.y ?? 0;
  const w = line.w ?? 0.2, h = line.h ?? 0.1;
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

/** Slide a polygon without changing its shape. The whole shape stays inside the page. */
export function translatePolygon(points: Point[], dx: number, dy: number): Point[] {
  if (!points.length) return [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const x = Math.max(-minX, Math.min(1 - maxX, dx));
  const y = Math.max(-minY, Math.min(1 - maxY, dy));
  return points.map(p => ({ x: p.x + x, y: p.y + y }));
}

/** Interior prompt for SAM: draft points if the user placed any, otherwise the box centre. */
export function bubbleFitPoints(line: Bounds, draft: Point[] = []): Point[] {
  if (draft.length) return draft;
  const x = line.x ?? 0, y = line.y ?? 0;
  const w = line.w ?? 0.2, h = line.h ?? 0.1;
  return [{ x: x + w / 2, y: y + h / 2 }];
}

/** Ellipse inscribed in the box. Enough vertices for scanline fitting to follow the curve. */
export function regionOval(line: Bounds, segments = 48): Point[] {
  const x = line.x ?? 0, y = line.y ?? 0;
  const w = Math.max(0.005, line.w ?? 0.2), h = Math.max(0.002, line.h ?? 0.1);
  const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
  const count = Math.max(8, Math.min(96, Math.round(segments)));
  return Array.from({ length: count }, (_, i) => {
    const t = (i / count) * Math.PI * 2;
    return { x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) };
  });
}

/** Reject tiny detected interiors (often gaps within lettering), regardless of page size. */
export function automaticRegionPolygon(line: Bounds, polygon: Point[] | undefined): Point[] {
  const rectangle = regionRectangle(line);
  if (!polygon || polygon.length < 3 || polygon.some(p =>
    !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x > 1 || p.y > 1
  )) return rectangle;
  const left = Math.min(...polygon.map(p => p.x)), right = Math.max(...polygon.map(p => p.x));
  const top = Math.min(...polygon.map(p => p.y)), bottom = Math.max(...polygon.map(p => p.y));
  if (right <= (line.x ?? 0) || left >= (line.x ?? 0) + (line.w ?? .2) ||
      bottom <= (line.y ?? 0) || top >= (line.y ?? 0) + (line.h ?? .1)) return rectangle;
  let twiceArea = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    twiceArea += a.x * b.y - b.x * a.y;
  }
  const area = Math.abs(twiceArea) / 2;
  const regionArea = (line.w ?? 0.2) * (line.h ?? 0.1);
  return !Number.isFinite(area) || area <= 0 || area < regionArea * 0.25 ? rectangle : polygon;
}

/**
 * Same region across a redetection pass.
 *
 * Geometry alone cannot separate a tightened box from side lettering nested in a
 * bubble, so recognised text breaks the tie: two different texts are two regions
 * whatever their scale, while matching text lets a redetection shrink the box.
 * With no text to compare (a bare draft) we keep the old similar-scale rule, and
 * containment never counts on its own.
 */
export function sameDetectedTextBox(
  a: Bounds,
  b: Bounds,
  sourceA?: string | null,
  sourceB?: string | null,
): boolean {
  if (a.x == null || a.y == null || a.w == null || a.h == null ||
      b.x == null || b.y == null || b.w == null || b.h == null) return false;
  const aa = a.w * a.h, ab = b.w * b.h;
  if (aa <= 0 || ab <= 0) return false;
  const overlap = Math.max(0, Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)) *
    Math.max(0, Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
  if (overlap / Math.min(aa, ab) <= .7) return false;
  const textA = (sourceA ?? '').trim(), textB = (sourceB ?? '').trim();
  if (textA && textB && textA !== textB) return false;
  if (textA && textB) return true;
  return Math.min(aa, ab) / Math.max(aa, ab) > .5;
}
