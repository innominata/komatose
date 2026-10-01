import type { ImageRow, LineRow } from "../types";
import type { RegionData } from "../workflow";
import { deltaTextTransform } from "../textTransform";
import { layoutKey, regionPolygon } from "./typesetting";

/** Transform existing glyphs without changing their font size or line breaks. */
export function transformPlacedText(
  line: LineRow,
  region: RegionData,
  page: ImageRow,
  x: number,
  y: number,
  rotation?: number,
  skewX?: number,
  skewY?: number,
) {
  const dx = x - (line.x ?? 0), dy = y - (line.y ?? 0);
  const next: RegionData = { ...region };
  const poly = regionPolygon(line, region, page);
  const cx = (Math.min(...poly.map(p => p.x)) + Math.max(...poly.map(p => p.x))) / 2;
  const cy = (Math.min(...poly.map(p => p.y)) + Math.max(...poly.map(p => p.y))) / 2;
  if (region.polygon) next.polygon = region.polygon.map(p => ({ x: p.x + dx, y: p.y + dy }));
  if (rotation !== undefined || skewX !== undefined || skewY !== undefined)
    next.style = {
      ...region.style,
      ...(rotation !== undefined ? { rotation } : {}),
      ...(skewX !== undefined ? { skewX } : {}),
      ...(skewY !== undefined ? { skewY } : {}),
    };
  if (region.layout) {
    const old = region.layout;
    const style = {
      ...old.style,
      ...(rotation !== undefined ? { rotation } : {}),
      ...(skewX !== undefined ? { skewX } : {}),
      ...(skewY !== undefined ? { skewY } : {}),
    };
    const extra = deltaTextTransform(old.style, style, cx, cy);
    const transform = `translate(${dx * page.width} ${dy * page.height})${extra ? ` ${extra}` : ""}`;
    next.layout = {
      ...old, style,
      rows: old.rows.map(row => ({ ...row, x: row.x + dx * page.width, baseline: row.baseline + dy * page.height })),
      svg: old.svg.replace(/(<svg\b[^>]*>)/, `$1<g transform="${transform}">`).replace(/<\/svg>\s*$/, "</g></svg>"),
    };
    // Preserve an existing stale state instead of approving unrelated style/text changes.
    if (old.key === layoutKey(line, region, page, old.style, old.dpi))
      next.layout.key = layoutKey({ ...line, x, y }, next, page, style, old.dpi);
  }
  return next;
}
