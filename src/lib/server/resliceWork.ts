import sharp from "sharp";
import type { CommentRow, ImageRow, LineRow } from "../types";
import { PAGE_STEPS, pageStepStamp, type PageData, type RegionData } from "../workflow";
import { transformRaster, transformRegion, type GeometrySnapshot } from "./pageGeometry";
import { getDoc, hash, previousSavedArtwork, readAsset, storeAsset, WorkflowError } from "./workflowStore";
import { listComments, listLines } from "./queries";
import { storePageThumbnail } from "./pageThumbnail";
import { layoutKey } from "./typesetting";
import { warpPad } from "../textWarp";

export type SliceWindow = { top: number; bottom: number; width: number; height: number };
type Source = { image: ImageRow; top: number; snapshot: GeometrySnapshot; raw: Buffer; previous?: string };
export type ResliceWork = {
  sources: Source[];
  geometry: Record<string, GeometrySnapshot>;
  comments: CommentRow[];
  lines: LineRow[];
  revisions: Record<string, number>;
};

export async function captureResliceWork(imgs: ImageRow[], raw: (img: ImageRow) => Promise<Buffer>): Promise<ResliceWork> {
  const lines = await listLines(imgs[0].episodeId);
  const comments = await listComments(imgs[0].episodeId);
  const sources: Source[] = [];
  const revisions: Record<string, number> = {};
  let top = 0;
  for (const image of imgs) {
    const doc = getDoc<PageData>(`page:${image.id}`, {});
    const page = doc.data;
    revisions[doc.id] = doc.revision;
    const snapshot: GeometrySnapshot = { page, lines: lines.filter(l => l.imageId === image.id).map(l => ({
      id: l.id, x: l.x, y: l.y, w: l.w, h: l.h, placed: l.placed,
      region: (() => {
        const region = getDoc<RegionData>(`region:${l.id}`, {});
        revisions[region.id] = region.revision;
        return region.data;
      })(),
    })) };
    sources.push({ image, top, snapshot, raw: await raw(image), previous: previousSavedArtwork(`page:${image.id}`, page) });
    top += image.height;
  }
  return { sources, lines, comments, revisions, geometry: Object.fromEntries(sources.map(s => [s.image.id, s.snapshot])) };
}

/** Protect existing regions and lettering, even where the source artwork is flat. */
export function protectedResliceRanges(work: ResliceWork) {
  return work.sources.flatMap(source => {
    // A majority of displaced polygons on a page is evidence that an older
    // strip/crop coordinate frame survived a page edit. Do not infer this just
    // because one valid, hand-drawn interior is larger than its text box.
    const staleFrame = sourceHasStalePolygonFrame(source);
    return source.snapshot.lines.flatMap(saved => {
      const line = work.lines.find(l => l.id === saved.id)!;
      if (line.y == null || line.h == null) return [];
      // Saved polygons may still use an older strip/crop coordinate frame.
      // Such a polygon can cover thousands of unrelated pixels (or sit entirely
      // off-page). Use the current box for protection when its saved interior no
      // longer fits that box/bubble. Keep the saved document itself untouched.
      const polygon = currentReslicePolygon(line, saved.region, source.image, staleFrame);
      const ys = [line.y, line.y + line.h, ...polygon.flatMap(p => p.y)];
      const layout = saved.region.layout;
      const xs = [line.x ?? 0, (line.x ?? 0) + (line.w ?? 0), ...polygon.flatMap(p => p.x)];
      const w = (Math.max(...xs) - Math.min(...xs)) * source.image.width;
      const h = (Math.max(...ys) - Math.min(...ys)) * source.image.height;
      const shear = layout ? Math.abs(Math.tan((layout.style.skewX ?? 0) * Math.PI / 180)) * h / 2 +
        Math.abs(Math.tan((layout.style.skewY ?? 0) * Math.PI / 180)) * w / 2 : 0;
      const margin = layout ? Math.ceil((layout.size * 2 + layout.style.outlineWidth) * layout.dpi / 72 +
        shear + warpPad(layout.style, w, h)) : 0;
      // The box and its saved lettering must stay on the same output page,
      // including lettering deliberately placed outside the box.
      const rowYs = layout?.rows.flatMap(row => [row.baseline - margin, row.baseline + margin]) ?? [];
      return [{ id: line.id,
        top: source.top + Math.min(Math.min(...ys) * source.image.height - margin, ...rowYs),
        bottom: source.top + Math.max(Math.max(...ys) * source.image.height + margin, ...rowYs),
      }];
    });
  });
}

function sourceHasStalePolygonFrame(source: Source) {
  const positioned = source.snapshot.lines.filter(saved => saved.region.polygon?.length &&
    !saved.region.resliceStalePolygon && saved.y != null && saved.h != null);
  const displaced = positioned.filter(saved => {
    const ys = saved.region.polygon!.map(p => p.y);
    return Math.max(...ys) < saved.y! || Math.min(...ys) > saved.y! + saved.h!;
  }).length;
  return positioned.length >= 3 && displaced > positioned.length / 2;
}

function currentReslicePolygon(line: LineRow, region: RegionData, image: ImageRow, staleFrame: boolean) {
  const polygon = region.polygon;
  if (!polygon?.length || polygon.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return [];
  // Keep the classification stable when a page with many old-frame interiors
  // becomes multiple pages with just one or two regions each. An edited shape
  // has a different signature and must immediately be respected again.
  if (region.resliceStalePolygon) return region.resliceStalePolygon === hash(JSON.stringify(polygon)) ? [] : polygon;
  const ys = polygon.map(p => p.y);
  // Permit ordinary edge overflows. Coordinates several page heights away
  // cannot describe an interior in the current page frame.
  const farOutside = Math.min(...ys) < -1 || Math.max(...ys) > 2;
  if (!staleFrame && !farOutside) return polygon;
  const box = { x: line.x ?? 0, y: line.y ?? 0, w: line.w ?? 0, h: line.h ?? 0 };
  const bubble = region.bubbleBounds;
  const toleranceX = 2 / image.width, toleranceY = 2 / image.height;
  const contains = (bounds: typeof box, p: { x: number; y: number }) =>
    p.x >= bounds.x - toleranceX && p.x <= bounds.x + bounds.w + toleranceX &&
    p.y >= bounds.y - toleranceY && p.y <= bounds.y + bounds.h + toleranceY;
  // A bubble is a useful larger frame only when it still contains this box.
  const frame = bubble && contains(bubble, box) && contains(bubble, { x: box.x + box.w, y: box.y + box.h })
    ? bubble : box;
  return polygon.every(p => contains(frame, p)) ? polygon : [];
}

/** Build each raster layer independently, so cleaned pixels never replace the raw layer. */
export async function slicePageWork(work: ResliceWork, slice: SliceWindow, image: ImageRow): Promise<PageData> {
  const sources = work.sources.filter(s => s.top < slice.bottom && s.top + s.image.height > slice.top);
  const first = sources[0].snapshot.page;
  const maskSources = sources.filter(s => s.snapshot.page.mask || s.snapshot.page.strokes?.length);
  type Layer = "prepared" | "original" | "cleaned" | "cleanBase" | "previousArtwork" | "mask";
  const layer = async (key: Layer) => {
    const overlays = [];
    for (const source of sources) {
      const page = source.snapshot.page;
      const hash = key === "cleaned" ? page.cleaned || page.cleanBase || page.prepared
        : key === "cleanBase" ? page.cleanBase || page.prepared
        : key === "previousArtwork" ? source.previous || page.prepared
        : key === "original" ? page.original || page.prepared : page[key];
      if (key === "mask" && !hash) continue;
      const bytes = hash ? await readAsset(hash) : source.raw;
      const meta = await sharp(bytes).metadata();
      if (meta.width !== source.image.width || meta.height !== source.image.height)
        throw new WorkflowError(`Saved ${key} dimensions differ from ${source.image.originalName}. Reslice stopped to preserve the existing work.`);
      const top = Math.max(source.top, slice.top), bottom = Math.min(source.top + source.image.height, slice.bottom);
      overlays.push({ input: await sharp(bytes).extract({ left: 0, top: top - source.top,
        width: source.image.width, height: bottom - top }).png().toBuffer(),
        left: Math.floor((slice.width - source.image.width) / 2), top: top - slice.top });
    }
    return storeAsset(await sharp({ create: { width: slice.width, height: slice.height,
      channels: 4, background: key === "mask" ? "#000000" : "#ffffff" } }).composite(overlays).png().toBuffer());
  };
  const page: PageData = { ...first, prepared: await layer("prepared"), original: await layer("original"),
    preparedAt: image.updatedAt, thumbnailAt: image.updatedAt,
    dpi: first.dpi ?? sources[0].image.dpi ?? 72,
    maskApproved: (maskSources.length ? maskSources : sources).every(s => !!s.snapshot.page.maskApproved),
    cleanApproved: sources.every(s => !!s.snapshot.page.cleanApproved),
    maskDiagnostics: undefined, completed: undefined, strokes: undefined,
  };
  for (const key of ["cleaned", "cleanBase", "previousArtwork", "mask"] as const) {
    const exists = sources.some(s => key === "previousArtwork" ? !!s.previous : !!s.snapshot.page[key]);
    page[key] = exists ? await layer(key) : undefined;
  }
  page.thumbnail = await storePageThumbnail(await readAsset(page.cleaned || page.cleanBase || page.prepared!));
  const strokes = sources.flatMap(source => (source.snapshot.page.strokes ?? []).filter(stroke => {
    const ys = stroke.points.map(p => source.top + p.y * source.image.height);
    return ys.length && Math.max(...ys) + stroke.radius >= slice.top && Math.min(...ys) - stroke.radius <= slice.bottom;
  }).map(stroke => ({ ...stroke, points: stroke.points.map(p => ({
    x: (p.x * source.image.width + Math.floor((slice.width - source.image.width) / 2)) / slice.width,
    y: (source.top + p.y * source.image.height - slice.top) / slice.height,
  })) })));
  if (strokes.length) page.strokes = strokes;
  return page;
}

export async function sliceRegionWork(line: LineRow, source: ResliceWork["sources"][number], slice: SliceWindow, image: ImageRow, dpi: number) {
  const saved = source.snapshot.lines.find(l => l.id === line.id)!;
  const transform = { sx: 1, sy: 1, dx: Math.floor((slice.width - source.image.width) / 2),
    dy: source.top - slice.top, width: slice.width, height: slice.height };
  const next = transformRegion(line, saved.region, source.image, transform);
  if (saved.region.polygon?.length && !currentReslicePolygon(line, saved.region, source.image,
    sourceHasStalePolygonFrame(source)).length && next.region.polygon) {
    next.region.resliceStalePolygon = hash(JSON.stringify(next.region.polygon));
  } else delete next.region.resliceStalePolygon;
  if (saved.region.bubbleBounds) {
    const bounds = saved.region.bubbleBounds;
    next.region.bubbleBounds = { x: (bounds.x * source.image.width + transform.dx) / slice.width,
      y: (bounds.y * source.image.height + transform.dy) / slice.height,
      w: bounds.w * source.image.width / slice.width, h: bounds.h * source.image.height / slice.height };
  }
  if (saved.region.textMask) next.region.textMask = await storeAsset(
    await transformRaster(await readAsset(saved.region.textMask), transform, "#ffffff"));
  if (saved.region.layout && next.region.layout) {
    const old = saved.region.layout;
    const fresh = old.key === layoutKey(line, saved.region, source.image, old.style, old.dpi);
    if (old.dpi !== dpi) {
      const ratio = old.dpi / dpi;
      const style = { ...old.style, ...saved.region.style };
      const scaled = { size: style.size * ratio, minSize: style.minSize * ratio,
        padding: style.padding * ratio, outlineWidth: style.outlineWidth * ratio };
      next.region.style = { ...saved.region.style, ...scaled };
      next.region.layout = { ...next.region.layout, dpi, size: old.size * ratio,
        style: { ...old.style, size: old.style.size * ratio, minSize: old.style.minSize * ratio,
          padding: old.style.padding * ratio, outlineWidth: old.style.outlineWidth * ratio } };
    }
    next.region.layout.key = fresh
      ? layoutKey({ ...line, ...next.bounds }, next.region, image, next.region.layout.style, dpi)
      : old.key;
  }
  return next;
}

/** Carry forward valid completion stamps, recalculated for the new page membership. */
export function sliceCompletion(work: ResliceWork, slice: SliceWindow, page: PageData,
  lines: LineRow[], regions: { id: string; data: RegionData }[]) {
  const sources = work.sources.filter(s => s.top < slice.bottom && s.top + s.image.height > slice.top);
  for (const step of PAGE_STEPS) {
    if (!sources.every(source => source.snapshot.page.completed?.[step] === pageStepStamp(step,
      source.snapshot.page, work.lines.filter(l => l.imageId === source.image.id),
      work.comments.filter(c => source.snapshot.lines.some(l => l.id === c.lineId)),
      source.snapshot.lines.map(l => ({ id: l.id, data: l.region }))))) continue;
    page.completed ??= {};
    page.completed[step] = pageStepStamp(step, page, lines,
      work.comments.filter(c => lines.some(l => l.id === c.lineId)), regions);
  }
}
