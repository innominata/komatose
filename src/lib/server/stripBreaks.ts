import sharp from "sharp";
import type { ImageRow } from "../types";
import type { PageData, RegionData } from "../workflow";
import { sliceHeight, allowedSliceHeight, type ResliceSizeOptions } from "../reslice";
import {
  breakRuns,
  normalizeBreaks,
  runSlices,
  sameBreaks,
  currentBreaks,
  sliceOutputs,
  stripHeight,
  type StripPage,
  type StripRange,
} from "../stripBreaks";
import { getDoc, hash, readAsset } from "./workflowStore";
import { listImages, listLines } from "./queries";
import { readWorkingOrOrig } from "./storage";
import { isCreditsPage } from "../credits";
import { nid } from "./ids";
import { protectedResliceRanges, type ResliceWork } from "./resliceWork";
import {
  ResliceError,
  bandsFromRowSummary,
  chooseCuts,
  padRowSummary,
  protectBands,
  rowSummary,
  sliceNameBase,
  type PageEditCtx,
  type WhiteBand,
} from "./reslice";

export type StripLayoutPage = StripPage & { prepared?: string; updatedAt: number };
export type StripLayout = {
  width: number;
  height: number;
  pages: StripLayoutPage[];
  bands: WhiteBand[];
  protected: (StripRange & { id: string })[];
  autoCuts: number[];
  maxHeight: number;
  allowedHeight: number;
  revisionToken: string;
};

/** Row summaries are the expensive part of a layout; a page's only change with its pixels. */
const summaries = (globalThis as typeof globalThis & {
  __stripRowSummaries?: Map<string, Uint8Array>;
}).__stripRowSummaries ??= new Map();
const MAX_CACHED_SUMMARIES = 2000;

async function storyImages(episodeId: string) {
  return (await listImages(episodeId)).filter((i) => !isCreditsPage(i));
}

function offsets(imgs: ImageRow[]): StripPage[] {
  let top = 0;
  return imgs.map((img) => {
    const page = { id: img.id, top, width: img.width, height: img.height };
    top += img.height;
    return page;
  });
}

async function pageSummary(ctx: PageEditCtx, img: ImageRow) {
  const prepared = getDoc<PageData>(`page:${img.id}`, {}).data.prepared;
  const key = `${ctx.episode.id}:${img.id}:${img.updatedAt}:${img.width}x${img.height}:${prepared ?? img.filename}`;
  const cached = summaries.get(key);
  if (cached) return cached;
  const raw = prepared ? await readAsset(prepared) :
    await readWorkingOrOrig(ctx.series.slug, ctx.episode.slug, img.filename);
  if (!raw) throw new ResliceError(`Missing image file for ${img.originalName}`, 404);
  const { data, info } = await sharp(raw)
    .flatten({ background: "white" })
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const summary = rowSummary(data, info.width, info.height, info.channels);
  if (summaries.size >= MAX_CACHED_SUMMARIES) summaries.delete(summaries.keys().next().value!);
  summaries.set(key, summary);
  return summary;
}

/**
 * What a break may not cross: every region and its lettering, in strip coordinates. Only the
 * saved geometry is needed, so this skips reading the artwork that a full reslice capture does.
 */
async function protectedRanges(imgs: ImageRow[], pages: StripPage[]) {
  if (!imgs.length) return [];
  const lines = await listLines(imgs[0].episodeId);
  const work: ResliceWork = {
    lines,
    comments: [],
    revisions: {},
    geometry: {},
    sources: imgs.map((image, i) => ({
      image,
      top: pages[i].top,
      raw: Buffer.alloc(0),
      snapshot: {
        page: getDoc<PageData>(`page:${image.id}`, {}).data,
        lines: lines.filter((l) => l.imageId === image.id).map((l) => ({
          id: l.id, x: l.x, y: l.y, w: l.w, h: l.h, placed: l.placed,
          region: getDoc<RegionData>(`region:${l.id}`, {}).data,
        })),
      },
    })),
  };
  return protectedResliceRanges(work);
}

/** Everything a break edit depends on; cheap enough to recheck before applying. */
async function signature(episodeId: string) {
  const all = await listImages(episodeId), lines = await listLines(episodeId);
  return hash(JSON.stringify({
    pages: all.map((i) => [i.id, i.sortOrder, i.width, i.height, i.updatedAt, i.role,
      getDoc(`page:${i.id}`, {}).revision]),
    lines: lines.map((l) => [l.id, l.imageId, l.x, l.y, l.w, l.h, getDoc(`region:${l.id}`, {}).revision]),
  }));
}

export async function stripLayout(ctx: PageEditCtx, size: ResliceSizeOptions = {}): Promise<StripLayout> {
  const imgs = await storyImages(ctx.episode.id);
  if (!imgs.length) throw new ResliceError("Add story pages first");
  const revisionToken = await signature(ctx.episode.id);
  const pages = offsets(imgs);
  const width = Math.max(...imgs.map((i) => i.width)), height = stripHeight(pages);
  const parts: Uint8Array[] = [];
  for (const img of imgs) {
    const summary = await pageSummary(ctx, img);
    parts.push(img.width < width ? padRowSummary(summary) : summary);
  }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  const ranges = await protectedRanges(imgs, pages);
  const bands = protectBands(bandsFromRowSummary(all), ranges);
  const maxHeight = sliceHeight(width, size);
  return {
    width,
    height,
    pages: imgs.map((img, i) => ({
      ...pages[i],
      prepared: getDoc<PageData>(`page:${img.id}`, {}).data.prepared,
      updatedAt: img.updatedAt,
    })),
    bands,
    protected: ranges.map((r) => ({ id: r.id, top: Math.floor(r.top), bottom: Math.ceil(r.bottom) })),
    autoCuts: chooseCuts(height, bands, maxHeight).cuts,
    maxHeight,
    allowedHeight: allowedSliceHeight(maxHeight),
    revisionToken,
  };
}

/** Validate a break list against the chapter as it is now; throws before any job starts. */
export async function planStripBreaks(ctx: PageEditCtx, input: unknown, revisionToken: unknown) {
  if (!Array.isArray(input) || input.some((b) => typeof b !== "number" || !Number.isInteger(b)))
    throw new ResliceError("Breaks must be whole pixel positions on the strip.");
  if (typeof revisionToken !== "string" || !revisionToken)
    throw new ResliceError("Reload the strip before applying page breaks.");
  if (revisionToken !== await signature(ctx.episode.id))
    throw new ResliceError("Pages or saved work changed since the strip was loaded. Review the breaks again.", 409);
  const imgs = await storyImages(ctx.episode.id), pages = offsets(imgs), height = stripHeight(pages);
  const breaks = normalizeBreaks(input as number[], height);
  if (breaks.length !== new Set(input as number[]).size)
    throw new ResliceError("Breaks must be inside the strip.");
  if (sameBreaks(breaks, currentBreaks(pages))) throw new ResliceError("The page breaks are unchanged.");
  const ranges = await protectedRanges(imgs, pages);
  const moved = new Set(currentBreaks(pages));
  for (const y of breaks) {
    const region = moved.has(y) ? undefined : ranges.find((r) => y > r.top && y < r.bottom);
    if (region) throw new ResliceError(`A break at ${y}px crosses an existing region or its lettering (${region.id}). Move it outside to preserve your work.`);
  }
  const runs = breakRuns(pages, breaks).map((run) => {
    const sources = imgs.slice(run.start, run.end + 1).map((img, i) => ({
      ...pages[run.start + i],
      name: sliceNameBase(img),
    }));
    const outputs = sliceOutputs(sources, runSlices(pages, run, breaks), { newId: nid, reuseIds: true });
    return { ids: sources.map((s) => s.id), outputs };
  });
  return { breaks, runs };
}

export async function applyStripBreaks(
  ctx: PageEditCtx,
  plan: Awaited<ReturnType<typeof planStripBreaks>>,
  opts: { jobId?: string; abort?: AbortSignal; onRun?: (done: number, total: number) => void } = {},
) {
  const { executeReframe } = await import("./pageReframe");
  const changed: string[] = [];
  // Each run is a separate consecutive reframe, so unchanged pages between edits keep their
  // review state. Runs only touch their own page ids, so earlier runs cannot shift later ones.
  for (const [i, run] of plan.runs.entries()) {
    opts.abort?.throwIfAborted();
    const description = plan.runs.length > 1 ? `Edit page breaks (${i + 1} of ${plan.runs.length})` : "Edit page breaks";
    await executeReframe(ctx, run.ids, run.outputs, description, undefined, opts.abort, opts.jobId);
    changed.push(...run.outputs.map((o) => o.id));
    opts.onRun?.(i + 1, plan.runs.length);
  }
  return { changedIds: changed, runs: plan.runs.length };
}
