import sharp from "sharp";
import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { Episode, ImageRow, LineRow, PublicUser, Series } from "../types";
import type { PageData, RegionData } from "../workflow";
import { sliceHeight, allowedSliceHeight as allowedHeight, manualSliceRanges, type ManualSlice, type ResliceSizeOptions } from "../reslice";
import { db, sqlite } from "./db";
import { images, lines } from "./db/schema";
import { nid, now } from "./ids";
import { MIN_BAND_PX } from "./spreadGutter";
import {
  STITCH_TARGET_H,
  episodeDir,
  imagePath,
  origImagePath,
  readWorkingOrOrig,
  removeImageFile,
  saveImageFile,
} from "./storage";
import { listImages, listLines, toImage, toLine } from "./queries";
import { isCreditsPage } from "../credits";
import { broadcast } from "./realtime";
import { getDoc, putDoc, readAsset } from "./workflowStore";
import { captureResliceWork, protectedResliceRanges, sliceCompletion, slicePageWork, sliceRegionWork } from "./resliceWork";
import { pushUndo, popUndo } from "./pageUndo";
import { createJob, pageResult, runWithJob, updateJob } from "./jobs";

export const RESLICE_MAX_H = STITCH_TARGET_H;
export const MIN_WHITE_RUN = Math.max(8, MIN_BAND_PX);
const MIN_PAGE_H = 200;
/** Small RGB variation covers compression noise, without ignoring any ink pixels. */
export const SOLID_COLOR_RANGE = 6;
export { SLICE_HEIGHT_SLACK, manualSliceRanges } from "../reslice";

export type WhiteBand = { top: number; bottom: number; y: number };

export type PageEditCtx = { series: Series; episode: Episode; user: PublicUser };

async function storyImages(episodeId: string, imageIds?: string[]) {
  const all = (await listImages(episodeId)).filter((i) => !isCreditsPage(i));
  return imageIds?.length ? all.filter((i) => imageIds.includes(i.id)) : all;
}

export class ResliceError extends Error {
  status: number;
  manualImageId?: string;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Validate before starting a background job, and retain sizing when retrying it. */
export function parseResliceSize(body: Record<string, unknown>): ResliceSizeOptions {
  if (body.sizing === undefined) return {};
  if (typeof body.sizing !== "string" || !["pages", "strips", "custom"].includes(body.sizing))
    throw new ResliceError("Choose normal pages, custom height, or tall strips.");
  const opts = { sizing: body.sizing, maxHeight: body.maxHeight } as ResliceSizeOptions;
  try { sliceHeight(800, opts); }
  catch (e) { throw new ResliceError(e instanceof Error ? e.message : String(e)); }
  return opts;
}

export function findSolidRowBands(
  data: Buffer,
  width: number,
  height: number,
  ch: number,
): WhiteBand[] {
  const bands: WhiteBand[] = [];
  let run = -1;
  let low = [255, 255, 255], high = [0, 0, 0];
  const finish = (bottom: number) => {
    if (run >= 0 && bottom - run >= MIN_WHITE_RUN)
      bands.push({ top: run, bottom, y: Math.round((run + bottom) / 2) });
    run = -1;
  };
  for (let y = 0; y < height; y++) {
    const rowLow = [255, 255, 255], rowHigh = [0, 0, 0];
    let solid = true;
    // Inspect every pixel, including narrow lettering and the image edges.
    for (let x = 0; x < width && solid; x++) {
      const i = (y * width + x) * ch;
      for (let c = 0; c < 3; c++) {
        const value = data[i + (ch < 3 ? 0 : c)];
        rowLow[c] = Math.min(rowLow[c], value);
        rowHigh[c] = Math.max(rowHigh[c], value);
        if (rowHigh[c] - rowLow[c] > SOLID_COLOR_RANGE) solid = false;
      }
    }
    if (!solid) { finish(y); continue; }
    if (run >= 0 && rowLow.some((value, c) =>
      Math.max(high[c], rowHigh[c]) - Math.min(low[c], value) > SOLID_COLOR_RANGE)) {
      finish(y);
    }
    if (run < 0) {
      run = y;
      low = rowLow;
      high = rowHigh;
    } else {
      for (let c = 0; c < 3; c++) {
        low[c] = Math.min(low[c], rowLow[c]);
        high[c] = Math.max(high[c], rowHigh[c]);
      }
    }
  }
  finish(height);
  return bands;
}

/** Kept for callers of the original white-only detector. */
export const findWhiteRowBands = findSolidRowBands;

function protectBands(bands: WhiteBand[], ranges: { top: number; bottom: number }[]): WhiteBand[] {
  return bands.flatMap(band => {
    let parts = [{ top: band.top, bottom: band.bottom }];
    for (const range of ranges) parts = parts.flatMap(part => {
      if (range.bottom <= part.top || range.top >= part.bottom) return [part];
      return [{ top: part.top, bottom: Math.max(part.top, Math.floor(range.top)) },
        { top: Math.min(part.bottom, Math.ceil(range.bottom)), bottom: part.bottom }];
    });
    return parts.filter(p => p.bottom - p.top >= MIN_WHITE_RUN)
      .map(p => ({ ...p, y: Math.round((p.top + p.bottom) / 2) }));
  });
}

export function chooseCuts(
  height: number,
  bands: WhiteBand[],
  maxH = RESLICE_MAX_H,
): { cuts: number[]; forced: number[]; manualRequired: boolean } {
  const cuts: number[] = [];
  const maxAllowed = allowedHeight(maxH);
  const minPage = Math.min(MIN_PAGE_H, Math.floor(maxH / 2));
  let start = 0;
  while (height - start > maxAllowed) {
    // Balance the last two pages if cutting at the target would leave a tiny tail.
    const ideal = height - (start + maxH) < minPage
      ? Math.round((start + height) / 2) : start + maxH;
    const candidates = bands.flatMap(b => {
      const lo = Math.max(b.top, start + minPage);
      const hi = Math.min(b.bottom - 1, height - minPage);
      // Use the middle of a gutter; an extensive flat background can be cut
      // near the target instead of its distant midpoint.
      const at = b.bottom - b.top >= maxH / 2 ? ideal : b.y;
      return lo <= hi ? [Math.min(hi, Math.max(lo, at))] : [];
    }).sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal) || b - a);
    // Prefer a normal page, but keep looking for a later safe gutter when the
    // artwork spans the target. Only that oversized slice needs manual review.
    const pick = candidates.find(y => y <= start + maxAllowed) ?? candidates[0];
    if (pick === undefined) break;
    cuts.push(pick);
    start = pick;
  }
  return { cuts, forced: [], manualRequired: manualSliceRanges(height, cuts, maxH).length > 0 };
}

export async function bandsFromBytes(bytes: Buffer): Promise<{
  bands: WhiteBand[];
  width: number;
  height: number;
}> {
  const { data, info } = await sharp(bytes)
    .flatten({ background: "white" })
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    bands: findSolidRowBands(data, info.width, info.height, info.channels),
    width: info.width,
    height: info.height,
  };
}

async function compositeVertical(
  parts: { bytes: Buffer; width: number; height: number }[],
): Promise<{ bytes: Buffer; width: number; height: number }> {
  if (parts.length === 1) return parts[0];
  const width = Math.max(...parts.map((p) => p.width));
  const height = parts.reduce((s, p) => s + p.height, 0);
  const layers: { input: Buffer; top: number; left: number }[] = [];
  let top = 0;
  for (const part of parts) {
    let input = part.bytes;
    if (part.width !== width) {
      input = await sharp(part.bytes)
        .extend({
          left: Math.floor((width - part.width) / 2),
          right: Math.ceil((width - part.width) / 2),
          top: 0,
          bottom: 0,
          background: { r: 255, g: 255, b: 255 },
        })
        .toBuffer();
    }
    layers.push({ input, top, left: 0 });
    top += part.height;
  }
  const bytes = await sharp({
    create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite(layers)
    .png()
    .toBuffer();
  return { bytes, width, height };
}

export async function stitchImages(
  ctx: PageEditCtx,
  imgs: ImageRow[],
): Promise<{
  bytes: Buffer;
  width: number;
  height: number;
  offsets: { id: string; top: number; height: number; width: number }[];
}> {
  const parts: { bytes: Buffer; width: number; height: number; id: string }[] =
    [];
  for (const img of imgs) {
    const raw = await sourceBytes(ctx, img);
    parts.push({
      bytes: raw,
      width: img.width,
      height: img.height,
      id: img.id,
    });
  }
  const stitched = await compositeVertical(parts);
  const offsets: { id: string; top: number; height: number; width: number }[] =
    [];
  let top = 0;
  for (const part of parts) {
    offsets.push({ id: part.id, top, height: part.height, width: part.width });
    top += part.height;
  }
  return { ...stitched, offsets };
}

async function sourceBytes(ctx: PageEditCtx, img: ImageRow) {
  const page = getDoc<PageData>(`page:${img.id}`, {}).data;
  const raw = page.prepared ? await readAsset(page.prepared) :
    await readWorkingOrOrig(ctx.series.slug, ctx.episode.slug, img.filename);
  if (!raw) throw new ResliceError(`Missing image file for ${img.originalName}`, 404);
  return raw;
}

/** One source page's band inside the stitched preview, for the boundary markers. */
export type PreviewPage = {
  id: string;
  top: number;
  height: number;
};

/**
 * How much the stitched preview may shrink. A webtoon stitch is thousands of pixels tall,
 * so scaling by the long edge (as a plain max-edge rule does) collapses an 800px-wide strip
 * to a few dozen pixels across and the canvas then blows that back up to screen width. The
 * width is what the canvas is sized by, so it is held near native and only a total-pixel
 * budget may pull it down.
 */
export const PREVIEW_MAX_WIDTH = 1400;
export const PREVIEW_MAX_PIXELS = 32_000_000;
/** libjpeg cannot encode a side larger than 65,500 pixels. PNG can. */
const PREVIEW_JPEG_MAX_SIDE = 65_500;

export function previewScale(width: number, height: number): number {
  let scale = Math.min(1, PREVIEW_MAX_WIDTH / Math.max(1, width));
  const pixels = width * scale * height * scale;
  if (pixels > PREVIEW_MAX_PIXELS) scale *= Math.sqrt(PREVIEW_MAX_PIXELS / pixels);
  return scale;
}

export async function previewReslice(
  ctx: PageEditCtx,
  imageIds?: string[],
  size: ResliceSizeOptions = {},
): Promise<{
  imageIds: string[];
  width: number;
  height: number;
  maxHeight: number;
  preview: string;
  cuts: number[];
  forced: number[];
  manualRequired: boolean;
  manualSlices: ManualSlice[];
  bands: WhiteBand[];
  pages: PreviewPage[];
}> {
  const imgs = await storyImages(ctx.episode.id, imageIds);
  if (imgs.length < 1) throw new ResliceError("Choose pages to reslice");
  const stitch = await stitchImages(ctx, imgs);
  const detected = await bandsFromBytes(stitch.bytes);
  const work = await captureResliceWork(imgs, img => sourceBytes(ctx, img));
  const bands = protectBands(detected.bands, protectedResliceRanges(work));
  const maxHeight = sliceHeight(stitch.width, size);
  const { cuts, forced, manualRequired } = chooseCuts(stitch.height, bands, maxHeight);
  const scale = previewScale(stitch.width, stitch.height);
  const previewWidth = Math.max(1, Math.round(stitch.width * scale));
  const previewHeight = Math.max(1, Math.round(stitch.height * scale));
  const format = Math.max(previewWidth, previewHeight) > PREVIEW_JPEG_MAX_SIDE ? "png" : "jpeg";
  const previewImage = sharp(stitch.bytes).resize({ width: previewWidth, height: previewHeight });
  // Very long chapters exceed JPEG's dimension limit even after the pixel
  // budget is applied. Keep their readable width and encode as PNG instead.
  const preview = await (format === "png" ? previewImage.png()
    : previewImage.jpeg({ quality: 70, mozjpeg: true, progressive: true })).toBuffer();
  // Page numbers are the client's business: the sidebar numbers pages by their position in
  // the chapter, and the stored pageNumber can be stale until a renumber. The offsets are
  // what only the server knows.
  return {
    imageIds: imgs.map((i) => i.id),
    width: stitch.width,
    height: stitch.height,
    maxHeight,
    preview: `data:image/${format};base64,${preview.toString("base64")}`,
    cuts,
    forced,
    manualRequired,
    manualSlices: manualSliceRanges(stitch.height, cuts, maxHeight),
    bands,
    pages: stitch.offsets
      .filter((o) => o.height > 0)
      .map((o) => ({ id: o.id, top: o.top, height: o.height })),
  };
}

type Slice = { top: number; bottom: number; bytes: Buffer; width: number; height: number };

async function slicesFromStitch(
  bytes: Buffer,
  width: number,
  height: number,
  cuts: number[],
): Promise<Slice[]> {
  const bounds = [0, ...cuts.filter((y) => y > 0 && y < height).sort((a, b) => a - b), height];
  const unique = bounds.filter((y, i) => i === 0 || y > bounds[i - 1]);
  const out: Slice[] = [];
  for (let i = 0; i < unique.length - 1; i++) {
    const top = unique[i];
    const bottom = unique[i + 1];
    const h = bottom - top;
    if (h < 1) continue;
    const sliceBytes = await sharp(bytes)
      .extract({ left: 0, top, width, height: h })
      .png()
      .toBuffer();
    out.push({ top, bottom, bytes: sliceBytes, width, height: h });
  }
  return out;
}

const resliceAborts = (globalThis as typeof globalThis & {
  __scanReslice?: Map<string, AbortController>;
}).__scanReslice ??
  ((globalThis as typeof globalThis & { __scanReslice?: Map<string, AbortController> }).__scanReslice =
    new Map());

export function cancelReslice(episodeId: string) {
  resliceAborts.get(episodeId)?.abort();
}

export function isResliceRunning(episodeId: string) {
  return resliceAborts.has(episodeId);
}

/**
 * The name a slice inherits from its page. `filename` is the app's own `NN-<name>.ext`, so
 * dropping the leading `NN-` recovers `page3.png` → `page3` without guessing at what a
 * user-named upload meant; a trailing number group (`page-1`, `pages-001-003`) is the source
 * page's own name and is kept, so two different pages never collapse onto one slice name.
 */
function sliceNameBase(img: ImageRow) {
  const stem = img.filename.replace(/\.[^.]+$/, "").replace(/^\d+-/, "");
  return stem || "page";
}

export async function reslicePages(
  ctx: PageEditCtx,
  opts: ResliceSizeOptions & {
    imageIds?: string[];
    cuts?: number[];
    jobId?: string;
    abort?: AbortSignal;
  } = {},
): Promise<{ images: ImageRow[]; forced: number[]; manualSlices: (ManualSlice & { imageId: string })[] }> {
  const imgs = await storyImages(ctx.episode.id, opts.imageIds);
  if (imgs.length < 1) throw new ResliceError("Choose pages to reslice");
  const stitch = await stitchImages(ctx, imgs);
  const detected = await bandsFromBytes(stitch.bytes);
  const work = await captureResliceWork(imgs, img => sourceBytes(ctx, img));
  const protectedRanges = protectedResliceRanges(work);
  const bands = protectBands(detected.bands, protectedRanges);
  const maxHeight = sliceHeight(stitch.width, opts);
  const auto = chooseCuts(stitch.height, bands, maxHeight);
  const cuts = opts.cuts ?? auto.cuts;
  const forced = opts.cuts === undefined ? auto.forced :
    cuts.filter(y => !bands.some(b => y >= b.top && y < b.bottom));
  if (opts.cuts !== undefined) {
    if (opts.cuts.some(y => !Number.isInteger(y) || y <= 0 || y >= stitch.height))
      throw new ResliceError("Cuts must be whole pixel positions inside the strip.");
    for (const y of opts.cuts) {
      const region = protectedRanges.find(r => y > r.top && y < r.bottom);
      if (region) throw new ResliceError(`This cut crosses an existing region or its lettering (${region.id}). Move the cut outside it to preserve your work.`);
    }
  }
  const slices = await slicesFromStitch(
    stitch.bytes,
    stitch.width,
    stitch.height,
    cuts,
  );
  if (!slices.length) throw new ResliceError("No slices to write");

  // Calculate all pixel layers and geometry before changing any source page.
  const before = await listImages(ctx.episode.id);
  const selected = new Set(imgs.map(i => i.id));
  const insertAt = Math.max(0, before.findIndex(i => selected.has(i.id)));
  const sliceNumber = new Map<string, number>();
  const plans: { slice: Slice; image: ImageRow; page: PageData }[] = [];
  for (const [i, slice] of slices.entries()) {
    if (opts.abort?.aborted) throw new ResliceError("Cancelled", 499);
    const sources = work.sources.filter(s => s.top < slice.bottom && s.top + s.image.height > slice.top);
    const source = sources[0].image;
    const n = (sliceNumber.get(source.id) ?? 0) + 1;
    sliceNumber.set(source.id, n);
    const captions = [...new Set(sources.map(s => s.image.caption).filter(Boolean))];
    const image: ImageRow = { id: nid(), episodeId: ctx.episode.id, filename: "",
      originalName: `${sliceNameBase(source)}-${n}.png`, sortOrder: insertAt + i,
      width: slice.width, height: slice.height, dpi: source.dpi ?? 72,
      caption: captions.join("\n\n"), role: "page", createdAt: now(), updatedAt: now() };
    const page = await slicePageWork(work, slice, image);
    image.dpi = page.dpi;
    plans.push({ slice, image, page });
  }
  const moved: { line: LineRow; region: RegionData }[] = [];
  for (const source of work.sources) {
    for (const line of work.lines.filter(l => l.imageId === source.image.id)) {
      // Preserve unplaced and out-of-bounds regions too; none may be orphaned
      // when the old image rows are removed.
      const center = source.top + Math.max(0, Math.min(source.image.height - 0.001,
        ((line.y ?? 0) + (line.h ?? 0) / 2) * source.image.height));
      const plan = plans.find(p => center >= p.slice.top && center < p.slice.bottom)!;
      const transformed = await sliceRegionWork(line, source, plan.slice, plan.image, plan.page.dpi ?? 72);
      const bounds = transformed.bounds;
      moved.push({ line: { ...line, imageId: plan.image.id,
        x: line.x == null ? line.x : bounds.x, y: line.y == null ? line.y : bounds.y,
        w: line.w == null ? line.w : bounds.w, h: line.h == null ? line.h : bounds.h,
        revision: (line.revision ?? 0) + 1, updatedAt: now() }, region: transformed.region });
    }
  }
  for (const plan of plans) {
    const pageRegions = moved.filter(m => m.line.imageId === plan.image.id);
    sliceCompletion(work, plan.slice, plan.page, pageRegions.map(m => m.line),
      pageRegions.map(m => ({ id: m.line.id, data: m.region })));
  }

  const undoDir = join(episodeDir(ctx.series.slug, ctx.episode.slug), `reslice-undo-${nid()}`);
  await mkdir(undoDir, { recursive: true });
  for (const img of imgs) {
    const src = imagePath(ctx.series.slug, ctx.episode.slug, img.filename);
    if (existsSync(src)) await copyFile(src, join(undoDir, img.filename));
    const orig = origImagePath(ctx.series.slug, ctx.episode.slug, img.filename);
    if (existsSync(orig)) await copyFile(orig, join(undoDir, `${img.filename}.orig`));
  }
  const kept = before.filter(i => !selected.has(i.id));
  const created = plans.map(p => p.image);
  const ordered = [...kept.slice(0, insertAt), ...created, ...kept.slice(insertAt)];
  let undoWritten = false;
  try {
    for (const plan of plans) {
      if (opts.abort?.aborted) throw new ResliceError("Cancelled", 499);
      const saved = await saveImageFile({ seriesSlug: ctx.series.slug, episodeSlug: ctx.episode.slug,
        sortOrder: plan.image.sortOrder, originalName: plan.image.originalName,
        bytes: plan.slice.bytes, mime: "image/png" });
      plan.image.filename = saved.filename;
      await writeFile(origImagePath(ctx.series.slug, ctx.episode.slug, saved.filename), await readAsset(plan.page.original!));
    }
    await pushUndo(ctx.series.slug, ctx.episode.slug, { type: "reslice", dir: undoDir,
      previous: imgs, createdIds: created.map(i => i.id), geometry: work.geometry,
      lines: work.lines.filter(l => l.imageId && selected.has(l.imageId)).map(l => ({
        id: l.id, imageId: l.imageId, x: l.x, y: l.y, w: l.w, h: l.h, revision: l.revision,
      })), order: before.map(i => ({ id: i.id, sortOrder: i.sortOrder })) });
    undoWritten = true;
    // Pixel assets are already written; commit page membership, saved layers,
    // lettering and approvals together. Cancellation cannot leave half a split.
    sqlite.transaction(() => {
      if (opts.abort?.aborted) throw new ResliceError("Cancelled", 499);
      for (const source of work.sources) {
        const current = db.select().from(images).where(eq(images.id, source.image.id)).get();
        if (!current || current.updatedAt !== source.image.updatedAt || current.caption !== source.image.caption)
          throw new ResliceError("A source page changed while reslicing. Retry.", 409);
      }
      for (const [id, revision] of Object.entries(work.revisions))
        if (getDoc(id, {}).revision !== revision)
          throw new ResliceError("Saved cleaning or lettering changed while reslicing. Retry.", 409);
      for (const image of created) db.insert(images).values(image).run();
      for (const item of moved) {
        const old = work.lines.find(l => l.id === item.line.id)!;
        const changed = sqlite.prepare("UPDATE lines SET image_id=?,x=?,y=?,w=?,h=?,revision=?,updated_at=? WHERE id=? AND episode_id=? AND revision=?")
          .run(item.line.imageId, item.line.x ?? null, item.line.y ?? null, item.line.w ?? null, item.line.h ?? null,
            item.line.revision, item.line.updatedAt, item.line.id, ctx.episode.id, old.revision ?? 0);
        if (!changed.changes) throw new ResliceError("A region changed while reslicing. Retry.", 409);
        // Geometry alone does not invalidate a pending source/English suggestion.
        sqlite.prepare("UPDATE suggestions SET base_revision=? WHERE episode_id=? AND line_id=? AND base_revision=? AND state='pending'")
          .run(item.line.revision, ctx.episode.id, item.line.id, old.revision ?? 0);
        const doc = getDoc<RegionData>(`region:${item.line.id}`, {});
        putDoc(ctx.episode.id, doc.id, item.region, doc.revision);
      }
      for (const plan of plans) putDoc(ctx.episode.id, `page:${plan.image.id}`, plan.page, 0);
      for (const img of imgs) db.delete(images).where(eq(images.id, img.id)).run();
      for (const [i, img] of ordered.entries()) db.update(images).set({ sortOrder: i }).where(eq(images.id, img.id)).run();
    })();
  } catch (e) {
    if (undoWritten) await popUndo(ctx.series.slug, ctx.episode.slug);
    for (const image of created) if (image.filename) await removeImageFile(ctx.series.slug, ctx.episode.slug, image.filename);
    throw e;
  }
  for (const img of imgs) {
    await removeImageFile(ctx.series.slug, ctx.episode.slug, img.filename);
    broadcast(ctx.episode.id, { type: "image:delete", id: img.id });
  }
  for (const image of created) {
    if (opts.jobId) pageResult(opts.jobId, image.id, "completed");
    broadcast(ctx.episode.id, { type: "image:upsert", image });
  }
  for (const item of moved) broadcast(ctx.episode.id, { type: "line:upsert", line: item.line });
  const next = await listImages(ctx.episode.id);
  broadcast(ctx.episode.id, { type: "image:reorder", order: next.map(img => ({ id: img.id, sortOrder: img.sortOrder })) });
  const manualSlices = plans.filter(p => p.slice.height > allowedHeight(maxHeight)).map(p => ({
    imageId: p.image.id, top: p.slice.top, bottom: p.slice.bottom, height: p.slice.height,
  }));
  return { images: next, forced, manualSlices };

}

export function startReslice(
  ctx: PageEditCtx,
  opts: ResliceSizeOptions & { imageIds?: string[]; cuts?: number[] } = {},
) {
  parseResliceSize(opts);
  const abort = new AbortController();
  resliceAborts.set(ctx.episode.id, abort);
  const jobId = createJob(ctx.episode.id, "reslice", {
    imageIds: opts.imageIds,
    cuts: opts.cuts,
    sizing: opts.sizing,
    maxHeight: opts.maxHeight,
  });
  updateJob(jobId, "running", {
    message: "Stitching pages…",
    completed: 0,
    total: 0,
  });
  void (async () => {
    try {
      await runWithJob({ jobId, step: "reslice" }, async () => {
        const result = await reslicePages(ctx, { ...opts, jobId, abort: abort.signal });
        updateJob(
          jobId,
          abort.signal.aborted ? "cancelled" : "completed",
          {
            message: abort.signal.aborted
              ? "Cancelled"
              : result.manualSlices.length
                ? `Wrote ${result.images.length} pages. ${result.manualSlices.length} oversized page(s) need manual splitting; automatic cuts stayed on solid-color gaps.`
                : result.forced.length
                ? `Resliced with ${result.forced.length} cut(s) through artwork. Review the new page boundaries.`
                : `Wrote ${result.images.length} pages.`,
            forced: result.forced,
            manualRequired: result.manualSlices.length > 0,
            manualImageId: result.manualSlices[0]?.imageId,
            manualSlices: result.manualSlices,
            completed: result.images.length,
            total: result.images.length,
          },
        );
      });
    } catch (e) {
      updateJob(
        jobId,
        abort.signal.aborted ? "cancelled" : "failed",
        { message: e instanceof Error ? e.message : String(e),
          manualRequired: e instanceof ResliceError && !!e.manualImageId,
          manualImageId: e instanceof ResliceError ? e.manualImageId : undefined },
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      resliceAborts.delete(ctx.episode.id);
    }
  })();
  return { jobId };
}
