import sharp, { type OverlayOptions } from "sharp";
import type { ImageRow, LineRow } from "../types";
import type { PageData, RegionData } from "../workflow";
import { sqlite } from "./db";
import { storePageThumbnail } from "./pageThumbnail";
import { getDoc, putDoc, readAsset, storeAsset } from "./workflowStore";
import { listLines } from "./queries";
import { layoutKey } from "./typesetting";
import { broadcast } from "./realtime";

export type PixelTransform = {
  sx: number; sy: number; dx: number; dy: number; width: number; height: number;
  /** Optional source bounds after scaling, before translation and padding. */
  crop?: { x: number; y: number; w: number; h: number };
};
type RasterColor = string | { r: number; g: number; b: number; alpha?: number };
export type EdgeColors = { left: RasterColor; right: RasterColor; top: RasterColor; bottom: RasterColor };
export type RasterBackground = RasterColor | EdgeColors;
export type GeometrySnapshot = {
  page: PageData;
  lines: { id: string; x: number | null | undefined; y: number | null | undefined; w: number | null | undefined; h: number | null | undefined; placed: boolean; region: RegionData }[];
};

export async function captureGeometry(episodeId: string, imageId: string): Promise<GeometrySnapshot> {
  return {
    page: getDoc<PageData>(`page:${imageId}`, {}).data,
    lines: (await listLines(episodeId)).filter(l => l.imageId === imageId).map(l => ({
      id: l.id, x: l.x, y: l.y, w: l.w, h: l.h, placed: l.placed,
      region: getDoc<RegionData>(`region:${l.id}`, {}).data,
    })),
  };
}

/** Clip the source before compositing, including for negative nudges. */
export async function transformRaster(bytes: Buffer, t: PixelTransform, background: RasterBackground) {
  const meta = await sharp(bytes).metadata();
  const width = Math.max(1, Math.round(meta.width! * t.sx)), height = Math.max(1, Math.round(meta.height! * t.sy));
  const left = Math.max(0, -t.dx, t.crop?.x ?? 0), top = Math.max(0, -t.dy, t.crop?.y ?? 0);
  const w = Math.min(width, t.width - t.dx, t.crop ? t.crop.x + t.crop.w : width) - left;
  const h = Math.min(height, t.height - t.dy, t.crop ? t.crop.y + t.crop.h : height) - top;
  const edges = typeof background === "object" && "left" in background ? background : null;
  const canvas = sharp({ create: {
    width: t.width, height: t.height, channels: 4,
    background: edges ? "#ffffff" : background as RasterColor,
  } });
  if (w <= 0 || h <= 0) return canvas.png().toBuffer();
  const x = left + t.dx, y = top + t.dy;
  const layers: OverlayOptions[] = [];
  if (edges) {
    const strip = (left: number, top: number, width: number, height: number, color: RasterColor) => {
      if (width > 0 && height > 0) layers.push({
        input: { create: { width, height, channels: 4, background: color } }, left, top,
      });
    };
    strip(0, 0, t.width, y, edges.top);
    strip(0, y + h, t.width, t.height - y - h, edges.bottom);
    strip(0, 0, x, t.height, edges.left);
    strip(x + w, 0, t.width - x - w, t.height, edges.right);
  }
  const input = await sharp(bytes).resize(width, height, { fit: "fill" })
    .extract({ left, top, width: w, height: h }).png().toBuffer();
  return canvas.composite([...layers, { input, left: x, top: y }]).png().toBuffer();
}

export function transformRegion(line: LineRow, region: RegionData, page: ImageRow, t: PixelTransform) {
  const point = (p: { x: number; y: number }) => ({
    x: (p.x * page.width * t.sx + t.dx) / t.width,
    y: (p.y * page.height * t.sy + t.dy) / t.height,
  });
  const position = point({ x: line.x ?? 0, y: line.y ?? 0 });
  const bounds = { ...position, w: (line.w ?? 0) * page.width * t.sx / t.width, h: (line.h ?? 0) * page.height * t.sy / t.height };
  const next: RegionData = { ...region, ...(region.polygon ? { polygon: region.polygon.map(point) } : {}) };
  if (region.layout) {
    const old = region.layout;
    const svg = old.svg.replace(/(<svg\b[^>]*>)/, `$1<g transform="translate(${t.dx} ${t.dy}) scale(${t.sx} ${t.sy})">`).replace(/<\/svg>\s*$/, "</g></svg>")
      .replace(/(<svg\b[^>]*\bwidth=")[^"]*"/, `$1${t.width}"`)
      .replace(/(<svg\b[^>]*\bheight=")[^"]*"/, `$1${t.height}"`)
      .replace(/viewBox="[^"]*"/, `viewBox="0 0 ${t.width} ${t.height}"`);
    next.layout = { ...old, svg, width: t.width, height: t.height,
      rows: old.rows.map(r => ({ ...r, x: r.x * t.sx + t.dx, baseline: r.baseline * t.sy + t.dy, width: r.width * t.sx })) };
    next.layout.key = layoutKey(
      { ...line, ...bounds },
      next,
      { ...page, width: t.width, height: t.height },
      old.style,
      old.dpi,
    );
  }
  return { bounds, region: next };
}

export async function applyPageGeometry(episodeId: string, oldPage: ImageRow, newPage: ImageRow, snapshot: GeometrySnapshot, t: PixelTransform, background: RasterBackground) {
  const page = { ...snapshot.page };
  for (const key of ["prepared", "original", "cleaned", "cleanBase", "previousArtwork", "mask"] as const) {
    const hash = page[key];
    if (hash) page[key] = await storeAsset(await transformRaster(await readAsset(hash), t, key === "mask" ? "#000000" : background));
  }
  if (page.prepared) {
    page.preparedAt = newPage.updatedAt;
    page.thumbnail = await storePageThumbnail(await readAsset(page.prepared));
    page.thumbnailAt = newPage.updatedAt;
  }
  if (page.strokes) page.strokes = page.strokes.map(s => ({ ...s, radius: s.radius * Math.sqrt(t.sx * t.sy),
    points: s.points.map(p => ({ x: (p.x * oldPage.width * t.sx + t.dx) / t.width, y: (p.y * oldPage.height * t.sy + t.dy) / t.height })) }));
  const currentLines = await listLines(episodeId);
  const textMasks = new Map<string, string>();
  for (const saved of snapshot.lines) {
    if (!saved.region.textMask) continue;
    textMasks.set(
      saved.id,
      await storeAsset(await transformRaster(await readAsset(saved.region.textMask), t, "#ffffff")),
    );
  }
  sqlite.transaction(() => {
    for (const saved of snapshot.lines) {
      const line = currentLines.find(l => l.id === saved.id);
      if (!line || !line.placed || line.x == null || line.y == null) continue;
      const transformed = transformRegion(line, saved.region, oldPage, t);
      const b = transformed.bounds;
      const visible = b.x + b.w > 0 && b.y + b.h > 0 && b.x < 1 && b.y < 1;
      sqlite.prepare("UPDATE lines SET x=?,y=?,w=?,h=?,placed=?,updated_at=? WHERE id=? AND episode_id=?")
        .run(b.x, b.y, b.w, b.h, visible ? 1 : 0, Date.now(), line.id, episodeId);
      const doc = getDoc<RegionData>(`region:${line.id}`, {});
      const textMask = textMasks.get(saved.id);
      putDoc(episodeId, doc.id, textMask ? { ...transformed.region, textMask } : transformed.region, doc.revision);
    }
    const doc = getDoc<PageData>(`page:${oldPage.id}`, {});
    putDoc(episodeId, doc.id, page, doc.revision);
  })();
  for (const line of (await listLines(episodeId)).filter(l => l.imageId === oldPage.id))
    broadcast(episodeId, { type: "line:upsert", line });
}

export async function restoreGeometry(episodeId: string, image: ImageRow, snapshot: GeometrySnapshot) {
  sqlite.transaction(() => {
    for (const line of snapshot.lines) {
      const changed = sqlite.prepare("UPDATE lines SET x=?,y=?,w=?,h=?,placed=?,updated_at=? WHERE id=? AND episode_id=? AND image_id=?")
        .run(line.x ?? null, line.y ?? null, line.w ?? null, line.h ?? null, line.placed ? 1 : 0, Date.now(), line.id, episodeId, image.id);
      if (!changed.changes) continue;
      const doc = getDoc<RegionData>(`region:${line.id}`, {});
      putDoc(episodeId, doc.id, line.region, doc.revision);
    }
    const doc = getDoc<PageData>(`page:${image.id}`, {});
    putDoc(episodeId, doc.id, { ...snapshot.page, ...(snapshot.page.prepared ? { preparedAt: image.updatedAt } : {}) }, doc.revision);
  })();
  for (const line of (await listLines(episodeId)).filter(l => l.imageId === image.id))
    broadcast(episodeId, { type: "line:upsert", line });
}
