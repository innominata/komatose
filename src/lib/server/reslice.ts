import sharp from "sharp";
import { mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { Episode, ImageRow, LineRow, PublicUser, Series } from "../types";
import type { RegionData } from "../workflow";
import { db } from "./db";
import { images, lines } from "./db/schema";
import { nid, now } from "./ids";
import {
  MAX_NONWHITE_FRAC,
  MIN_BAND_PX,
  WHITE_LUMA,
} from "./spreadGutter";
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
import { getDoc, putDoc } from "./workflowStore";
import { pushUndo } from "./pageUndo";
import { createJob, pageResult, runWithJob, updateJob } from "./jobs";

export const RESLICE_MAX_H = STITCH_TARGET_H;
export const MIN_WHITE_RUN = Math.max(8, MIN_BAND_PX);
const MIN_PAGE_H = 200;

export type WhiteBand = { top: number; bottom: number; y: number };

export type PageEditCtx = { series: Series; episode: Episode; user: PublicUser };

async function storyImages(episodeId: string, imageIds?: string[]) {
  const all = (await listImages(episodeId)).filter((i) => !isCreditsPage(i));
  return imageIds?.length ? all.filter((i) => imageIds.includes(i.id)) : all;
}

export class ResliceError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function findWhiteRowBands(
  data: Buffer,
  width: number,
  height: number,
  ch: number,
): WhiteBand[] {
  const xStep = width > 1600 ? 2 : 1;
  const samples = Math.ceil(width / xStep);
  const allowedDark = Math.max(2, Math.floor(samples * MAX_NONWHITE_FRAC));
  const white = new Uint8Array(height);
  for (let y = 0; y < height; y++) {
    let dark = 0;
    for (let x = 0; x < width; x += xStep) {
      const i = (y * width + x) * ch;
      const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      if (luma < WHITE_LUMA) dark += 1;
    }
    white[y] = dark <= allowedDark ? 1 : 0;
  }
  const bands: WhiteBand[] = [];
  let run = -1;
  for (let y = 0; y <= height; y++) {
    const on = y < height && white[y];
    if (on && run < 0) run = y;
    if (!on && run >= 0) {
      if (y - run >= MIN_WHITE_RUN) {
        bands.push({ top: run, bottom: y, y: Math.round((run + y) / 2) });
      }
      run = -1;
    }
  }
  return bands;
}

export function chooseCuts(
  height: number,
  bands: WhiteBand[],
  maxH = RESLICE_MAX_H,
): { cuts: number[]; forced: number[] } {
  const cuts: number[] = [];
  const forced: number[] = [];
  let start = 0;
  while (height - start > maxH) {
    const limit = start + maxH;
    const candidates = bands.filter(
      (b) => b.y > start + MIN_PAGE_H && b.y <= limit,
    );
    const pick = candidates.at(-1);
    if (pick) {
      cuts.push(pick.y);
      start = pick.y;
    } else {
      cuts.push(limit);
      forced.push(limit);
      start = limit;
    }
  }
  return { cuts, forced };
}

export async function bandsFromBytes(bytes: Buffer): Promise<{
  bands: WhiteBand[];
  width: number;
  height: number;
}> {
  const { data, info } = await sharp(bytes)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    bands: findWhiteRowBands(data, info.width, info.height, info.channels),
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
        .resize({
          width,
          height: part.height,
          fit: "contain",
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
    const raw = await readWorkingOrOrig(
      ctx.series.slug,
      ctx.episode.slug,
      img.filename,
    );
    if (!raw)
      throw new ResliceError(`Missing image file for ${img.originalName}`, 404);
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
  const width = stitched.width;
  for (const part of parts) {
    offsets.push({ id: part.id, top, height: part.height, width });
    top += part.height;
  }
  return { ...stitched, offsets };
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

export function previewScale(width: number, height: number): number {
  let scale = Math.min(1, PREVIEW_MAX_WIDTH / Math.max(1, width));
  const pixels = width * scale * height * scale;
  if (pixels > PREVIEW_MAX_PIXELS) scale *= Math.sqrt(PREVIEW_MAX_PIXELS / pixels);
  return scale;
}

export async function previewReslice(
  ctx: PageEditCtx,
  imageIds?: string[],
): Promise<{
  imageIds: string[];
  width: number;
  height: number;
  preview: string;
  cuts: number[];
  forced: number[];
  bands: WhiteBand[];
  pages: PreviewPage[];
}> {
  const imgs = await storyImages(ctx.episode.id, imageIds);
  if (imgs.length < 1) throw new ResliceError("Choose pages to reslice");
  const stitch = await stitchImages(ctx, imgs);
  const { bands } = await bandsFromBytes(stitch.bytes);
  const { cuts, forced } = chooseCuts(stitch.height, bands);
  const scale = previewScale(stitch.width, stitch.height);
  const preview = await sharp(stitch.bytes)
    .resize({
      width: Math.max(1, Math.round(stitch.width * scale)),
      height: Math.max(1, Math.round(stitch.height * scale)),
    })
    // The preview is a tall strip, so progressive encoding keeps the first screenful
    // arriving long before the whole image does.
    .jpeg({ quality: 70, mozjpeg: true, progressive: true })
    .toBuffer();
  // Page numbers are the client's business: the sidebar numbers pages by their position in
  // the chapter, and the stored pageNumber can be stale until a renumber. The offsets are
  // what only the server knows.
  return {
    imageIds: imgs.map((i) => i.id),
    width: stitch.width,
    height: stitch.height,
    preview: `data:image/jpeg;base64,${preview.toString("base64")}`,
    cuts,
    forced,
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

function remapBox(
  line: LineRow,
  offset: { top: number; height: number },
  slice: Slice,
) {
  const absY = offset.top + (line.y ?? 0) * offset.height;
  const absH = (line.h ?? 0.01) * offset.height;
  const center = absY + absH / 2;
  if (center < slice.top || center >= slice.bottom) return null;
  return {
    x: line.x ?? 0,
    y: (absY - slice.top) / slice.height,
    w: line.w ?? 0.2,
    h: absH / slice.height,
  };
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
  opts: {
    imageIds?: string[];
    cuts?: number[];
    jobId?: string;
    abort?: AbortSignal;
  } = {},
): Promise<{ images: ImageRow[]; forced: number[] }> {
  const imgs = await storyImages(ctx.episode.id, opts.imageIds);
  if (imgs.length < 1) throw new ResliceError("Choose pages to reslice");
  const stitch = await stitchImages(ctx, imgs);
  const { bands } = await bandsFromBytes(stitch.bytes);
  const auto = chooseCuts(stitch.height, bands);
  const cuts = opts.cuts?.length ? opts.cuts : auto.cuts;
  const forced = opts.cuts?.length ? [] : auto.forced;
  if (opts.cuts?.length) {
    const sorted = [...opts.cuts].sort((a, b) => a - b);
    const bounds = [0, ...sorted, stitch.height];
    for (let i = 0; i < bounds.length - 1; i++) {
      if (bounds[i + 1] - bounds[i] > RESLICE_MAX_H)
        throw new ResliceError(
          `A slice is taller than ${RESLICE_MAX_H}px. Add another cut.`,
        );
    }
  }
  const slices = await slicesFromStitch(
    stitch.bytes,
    stitch.width,
    stitch.height,
    cuts,
  );
  if (!slices.length) throw new ResliceError("No slices to write");

  const undoId = nid();
  const undoDir = join(
    episodeDir(ctx.series.slug, ctx.episode.slug),
    `reslice-undo-${undoId}`,
  );
  await mkdir(undoDir, { recursive: true });
  for (const img of imgs) {
    const src = imagePath(ctx.series.slug, ctx.episode.slug, img.filename);
    if (existsSync(src)) await copyFile(src, join(undoDir, img.filename));
    const orig = origImagePath(ctx.series.slug, ctx.episode.slug, img.filename);
    if (existsSync(orig)) await copyFile(orig, join(undoDir, `${img.filename}.orig`));
  }

  const lns = await listLines(ctx.episode.id);
  const lineSnap = lns
    .filter((l) => l.imageId && imgs.some((i) => i.id === l.imageId))
    .map((l) => ({
      id: l.id,
      imageId: l.imageId,
      x: l.x,
      y: l.y,
      w: l.w,
      h: l.h,
      revision: l.revision,
    }));

  const offsetById = new Map(stitch.offsets.map((o) => [o.id, o]));
  const created: ImageRow[] = [];
  // Chapter order as it stands before a single row moves. The slices take the first selected
  // page's slot and the pages after the window shift down by the size difference, so the run
  // of slices stays one block instead of interleaving with the pages that followed it.
  const before = await listImages(ctx.episode.id);
  const selected = new Set(imgs.map((i) => i.id));
  const insertAt = Math.max(0, before.findIndex((i) => selected.has(i.id)));
  const sourceById = new Map(imgs.map((i) => [i.id, i]));
  // Each slice is named for the page it starts in and counts from 1 again on that page, so
  // the pieces still say where they came from instead of running `reslice-001…` across the
  // whole batch.
  const sliceSources = slices.map((slice) => {
    let offset = stitch.offsets[0];
    for (const o of stitch.offsets) if (o.top <= slice.top) offset = o;
    return sourceById.get(offset.id) ?? imgs[0];
  });
  const sliceNumber = new Map<string, number>();

  for (let i = 0; i < slices.length; i++) {
    if (opts.abort?.aborted) throw new ResliceError("Cancelled", 499);
    const slice = slices[i];
    const source = sliceSources[i];
    const n = (sliceNumber.get(source.id) ?? 0) + 1;
    sliceNumber.set(source.id, n);
    const originalName = `${sliceNameBase(source)}-${n}.png`;
    const saved = await saveImageFile({
      seriesSlug: ctx.series.slug,
      episodeSlug: ctx.episode.slug,
      sortOrder: insertAt + i,
      originalName,
      bytes: slice.bytes,
      mime: "image/png",
    });
    const row = {
      id: nid(),
      episodeId: ctx.episode.id,
      filename: saved.filename,
      originalName,
      sortOrder: insertAt + i,
      width: saved.width,
      height: saved.height,
      dpi: saved.dpi,
      caption: "",
      role: "page",
      createdAt: now(),
      updatedAt: now(),
    };
    await db.insert(images).values(row);
    const image = toImage(row);
    created.push(image);
    if (opts.jobId) pageResult(opts.jobId, image.id, "completed");
    broadcast(ctx.episode.id, { type: "image:upsert", image });
  }

  for (const line of lns) {
    if (!line.imageId || !offsetById.has(line.imageId)) continue;
    const offset = offsetById.get(line.imageId)!;
    let dest: { slice: Slice; image: ImageRow; box: { x: number; y: number; w: number; h: number } } | null =
      null;
    for (let i = 0; i < slices.length; i++) {
      const box = remapBox(line, offset, slices[i]);
      if (box) {
        dest = { slice: slices[i], image: created[i], box };
        break;
      }
    }
    if (!dest) continue;
    const t = now();
    await db
      .update(lines)
      .set({
        imageId: dest.image.id,
        x: dest.box.x,
        y: dest.box.y,
        w: dest.box.w,
        h: dest.box.h,
        revision: (line.revision ?? 0) + 1,
        updatedAt: t,
      })
      .where(eq(lines.id, line.id));
    const doc = getDoc<RegionData>(`region:${line.id}`, {});
    if (doc.data.polygon?.length) {
      const poly = doc.data.polygon.map((p) => ({
        x: p.x,
        y: (offset.top + p.y * offset.height - dest!.slice.top) / dest!.slice.height,
      }));
      putDoc(ctx.episode.id, doc.id, { ...doc.data, polygon: poly }, doc.revision);
    }
    const updated = await db.select().from(lines).where(eq(lines.id, line.id)).get();
    if (updated)
      broadcast(ctx.episode.id, { type: "line:upsert", line: toLine(updated) });
  }

  for (const img of imgs) {
    await db.delete(images).where(eq(images.id, img.id));
    await removeImageFile(ctx.series.slug, ctx.episode.slug, img.filename);
    broadcast(ctx.episode.id, { type: "image:delete", id: img.id });
  }

  // Order comes from the intended result — the kept pages before the window, the slices, then
  // the kept pages after it — and never from comparing sortOrder values. Ties used to decide
  // this, and a page that followed the window could land in the middle of the slices it produced.
  const kept = before.filter((i) => !selected.has(i.id));
  const ordered = [...kept.slice(0, insertAt), ...created, ...kept.slice(insertAt)];
  for (const [i, img] of ordered.entries()) {
    if (img.sortOrder !== i) {
      await db.update(images).set({ sortOrder: i }).where(eq(images.id, img.id));
    }
  }

  await pushUndo(ctx.series.slug, ctx.episode.slug, {
    type: "reslice",
    dir: undoDir,
    previous: imgs,
    lines: lineSnap,
    createdIds: created.map((c) => c.id),
    // The pages after the window were moved down to make room; undo puts them back.
    order: before.map((i) => ({ id: i.id, sortOrder: i.sortOrder })),
  });

  const next = await listImages(ctx.episode.id);
  broadcast(ctx.episode.id, {
    type: "image:reorder",
    order: next.map((img) => ({ id: img.id, sortOrder: img.sortOrder })),
  });
  return { images: next, forced };
}

export function startReslice(
  ctx: PageEditCtx,
  opts: { imageIds?: string[]; cuts?: number[] } = {},
) {
  const abort = new AbortController();
  resliceAborts.set(ctx.episode.id, abort);
  const jobId = createJob(ctx.episode.id, "reslice", {
    imageIds: opts.imageIds,
    cuts: opts.cuts,
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
              : result.forced.length
                ? `Resliced with ${result.forced.length} force-cut(s) at 16k. Review in Reslice tool.`
                : `Wrote ${result.images.length} pages.`,
            forced: result.forced,
            completed: result.images.length,
            total: result.images.length,
          },
        );
      });
    } catch (e) {
      updateJob(
        jobId,
        abort.signal.aborted ? "cancelled" : "failed",
        { message: e instanceof Error ? e.message : String(e) },
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      resliceAborts.delete(ctx.episode.id);
    }
  })();
  return { jobId };
}
