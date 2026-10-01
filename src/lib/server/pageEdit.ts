import { DEFAULT_CHAT_MODEL_ID } from '../modelDefaults';
import { captureGeometry, applyPageGeometry, restoreGeometry, transformRaster, type PixelTransform, type GeometrySnapshot, type EdgeColors, type RasterBackground } from "./pageGeometry";
import { existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import type {
  Episode,
  ImageRow,
  PublicUser,
  Series,
  TranslateEngine,
} from "../types";
import { creditRole, isCreditsPage, storyPages } from "../credits";
import { logActivity } from "./activity";
import { describePageWithCli, compactSceneNotesWithCli } from "./cliTranslate";
import { runCompactSceneNotes, type CompactNotesHandlers } from "./compactNotes";
import { runDescribePage, type DescribePageHandlers } from "./pageDescribe";
import { db } from "./db";
import { images, lines } from "./db/schema";
import { nid, now } from "./ids";
import {
  compactSceneNotes,
  DESCRIBE_SYSTEM,
  DESCRIBE_USER,
  describePage,
  llmReachable,
} from "./llm";
import { imageMessage, localChat, withLocalReview } from "./localReview";
import { qwen3VlReviewId } from "../qwenModels";
import { regionAiSettings } from "../regionAi";
import { seriesCreditsOf } from "./seriesCredits";
import { preferences } from "./workflowService";
import { getDoc, putDoc, readAsset } from "./workflowStore";
import type { Preferences } from "../workflow";
import { popUndo, pushUndo, type PageUndoOp } from "./pageUndo";
import { listImages, listLines, toImage } from "./queries";
import { broadcast } from "./realtime";
import { findWhiteGutter, SOLID_STDEV, splitXFromAt } from "./spreadGutter";
import {
  imagePath,
  nextImageBackupPath,
  origImagePath,
  readWorkingOrOrig,
  removeImageFile,
  saveImageFile,
} from "./storage";
import { undoInpaint } from "./inpaint";
import {
  appendJobLog,
  createJob,
  jobContext,
  pageResult,
  runWithJob,
  sanitizeLlmMessages,
  updateJob,
} from "./jobs";

export class PageEditError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Ctx = { series: Series; episode: Episode; user: PublicUser };

function fillFromSample(sample: { r: number; g: number; b: number }): {
  r: number;
  g: number;
  b: number;
} {
  const luma = 0.2126 * sample.r + 0.7152 * sample.g + 0.0722 * sample.b;
  if (luma < 40) return { r: 0, g: 0, b: 0 };
  if (luma > 220) return { r: 255, g: 255, b: 255 };
  return {
    r: Math.round(sample.r),
    g: Math.round(sample.g),
    b: Math.round(sample.b),
  };
}

async function backupWorking(ctx: Ctx, img: ImageRow) {
  const src = imagePath(ctx.series.slug, ctx.episode.slug, img.filename);
  if (!existsSync(src)) return;
  const bak = await nextImageBackupPath(
    ctx.series.slug,
    ctx.episode.slug,
    img.filename,
  );
  await copyFile(src, bak);
}

async function commitPixels(
  ctx: Ctx,
  img: ImageRow,
  bytes: Buffer,
  undo = true,
  transform?: PixelTransform,
  background: RasterBackground = "#ffffff",
): Promise<ImageRow> {
  const geometry = transform ? await captureGeometry(ctx.episode.id, img.id) : undefined;
  if (undo) {
    await backupWorking(ctx, img);
    await pushUndo(ctx.series.slug, ctx.episode.slug, {
      type: "pixels",
      imageId: img.id,
      ...(geometry ? { geometry: { [img.id]: geometry } } : {}),
    });
  }
  const path = imagePath(ctx.series.slug, ctx.episode.slug, img.filename);
  await writeFile(path, bytes);
  const meta = await sharp(bytes).metadata();
  const t = now();
  await db
    .update(images)
    .set({
      width: meta.width || img.width,
      height: meta.height || img.height,
      updatedAt: t,
    })
    .where(eq(images.id, img.id));
  const row = await db.select().from(images).where(eq(images.id, img.id)).get();
  if (!row) throw new PageEditError("Image not found", 404);
  const image = toImage(row);
  if (transform && geometry) await applyPageGeometry(ctx.episode.id, img, image, geometry, transform, background);
  broadcast(ctx.episode.id, { type: "image:upsert", image });
  return image;
}

function requireImage(list: ImageRow[], id: string): ImageRow {
  const img = list.find((i) => i.id === id);
  if (!img) throw new PageEditError("Image not found", 404);
  return img;
}

export type ContentBox = { x: number; y: number; w: number; h: number };

export async function contentBBox(bytes: Buffer): Promise<ContentBox> {
  const meta = await sharp(bytes).metadata();
  const width = meta.width || 1;
  const height = meta.height || 1;
  const { data, info } = await sharp(bytes)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const rowVar = (y: number) => {
    let sum = 0;
    let sum2 = 0;
    const n = width;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * ch;
      const luma =
        0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      sum += luma;
      sum2 += luma * luma;
    }
    const mean = sum / n;
    const v = sum2 / n - mean * mean;
    return { mean, stdev: Math.sqrt(Math.max(0, v)) };
  };
  const colVar = (x: number) => {
    let sum = 0;
    let sum2 = 0;
    const n = height;
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * ch;
      const luma =
        0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      sum += luma;
      sum2 += luma * luma;
    }
    const mean = sum / n;
    const v = sum2 / n - mean * mean;
    return { mean, stdev: Math.sqrt(Math.max(0, v)) };
  };
  const isMargin = (stat: { stdev: number }) => stat.stdev < SOLID_STDEV;

  let top = 0;
  let bottom = height;
  let left = 0;
  let right = width;
  const step = Math.max(1, Math.round(Math.min(width, height) / 400));
  while (top < height - 8 && isMargin(rowVar(top))) top += step;
  while (bottom > top + 8 && isMargin(rowVar(bottom - 1))) bottom -= step;
  while (left < width - 8 && isMargin(colVar(left))) left += step;
  while (right > left + 8 && isMargin(colVar(right - 1))) right -= step;
  top = Math.max(0, top - step);
  left = Math.max(0, left - step);
  bottom = Math.min(height, bottom + step);
  right = Math.min(width, right + step);
  const w = Math.max(1, right - left);
  const h = Math.max(1, bottom - top);
  if (
    w < Math.max(8, Math.round(width * 0.15)) ||
    h < Math.max(8, Math.round(height * 0.15))
  ) {
    return { x: 0, y: 0, w: width, h: height };
  }
  return { x: left, y: top, w, h };
}

async function sampleBg(
  bytes: Buffer,
): Promise<{ r: number; g: number; b: number }> {
  const { data } = await sharp(bytes)
    .resize(32, 32, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({
      resolveWithObject: true,
    });
  const corners = [0, 31, 32 * 31, 32 * 32 - 1];
  let r = 0;
  let g = 0;
  let b = 0;
  for (const i of corners) {
    r += data[i * 3];
    g += data[i * 3 + 1];
    b += data[i * 3 + 2];
  }
  return fillFromSample({ r: r / 4, g: g / 4, b: b / 4 });
}

async function samplePadding(bytes: Buffer): Promise<EdgeColors> {
  const { data, info } = await sharp(bytes)
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const solidEdge = (start: number, stride: number, count: number) => {
    const min = [255, 255, 255], max = [0, 0, 0], sum = [0, 0, 0];
    for (let n = 0; n < count; n++) {
      for (let c = 0; c < 3; c++) {
        const value = data[(start + n * stride) * info.channels + c];
        min[c] = Math.min(min[c], value);
        max[c] = Math.max(max[c], value);
        // Allow small compression differences, but never average artwork into a fill.
        if (max[c] - min[c] > 4) return "#ffffff";
        sum[c] += value;
      }
    }
    return { r: Math.round(sum[0] / count), g: Math.round(sum[1] / count), b: Math.round(sum[2] / count) };
  };
  return {
    left: solidEdge(0, info.width, info.height),
    right: solidEdge(info.width - 1, info.width, info.height),
    top: solidEdge(0, 1, info.width),
    bottom: solidEdge((info.height - 1) * info.width, 1, info.width),
  };
}

export async function cropPage(
  ctx: Ctx,
  imageId: string,
  box: ContentBox,
  opts: { undo?: boolean } = {},
): Promise<ImageRow> {
  const imgs = await listImages(ctx.episode.id);
  const img = requireImage(imgs, imageId);
  const raw = await readFile(
    imagePath(ctx.series.slug, ctx.episode.slug, img.filename),
  );
  const left = Math.max(0, Math.round(box.x));
  const top = Math.max(0, Math.round(box.y));
  const width = Math.max(1, Math.round(box.w));
  const height = Math.max(1, Math.round(box.h));
  const bytes = await sharp(raw)
    .extract({ left, top, width, height })
    .png()
    .toBuffer();
  const image = await commitPixels(ctx, img, bytes, opts.undo !== false, { sx: 1, sy: 1, dx: -left, dy: -top, width, height });
  void logActivity({
    seriesId: ctx.series.id,
    episodeId: ctx.episode.id,
    userId: ctx.user.id,
    action: "cropped_page",
    payload: { imageId },
  });
  return image;
}

export async function resizePage(
  ctx: Ctx,
  imageId: string,
  width: number,
  height: number,
): Promise<ImageRow> {
  const imgs = await listImages(ctx.episode.id);
  const img = requireImage(imgs, imageId);
  const w = Math.round(width);
  const h = Math.round(height);
  if (w < 32 || h < 32 || w > 20000 || h > 20000)
    throw new PageEditError("Invalid size");
  const raw = await readFile(
    imagePath(ctx.series.slug, ctx.episode.slug, img.filename),
  );
  const bytes = await sharp(raw).resize(w, h, { fit: "fill" }).png().toBuffer();
  const image = await commitPixels(ctx, img, bytes, true, { sx: w / img.width, sy: h / img.height, dx: 0, dy: 0, width: w, height: h });
  void logActivity({
    seriesId: ctx.series.id,
    episodeId: ctx.episode.id,
    userId: ctx.user.id,
    action: "resized_page",
    payload: { imageId, width: w, height: h },
  });
  return image;
}

export async function nudgePage(
  ctx: Ctx,
  imageId: string,
  dx: number,
  dy: number,
  fill?: "auto" | "white" | "black",
): Promise<ImageRow> {
  const imgs = await listImages(ctx.episode.id);
  const img = requireImage(imgs, imageId);
  const raw = await readFile(
    imagePath(ctx.series.slug, ctx.episode.slug, img.filename),
  );
  const meta = await sharp(raw).metadata();
  const width = meta.width || img.width;
  const height = meta.height || img.height;
  const bg =
    fill === "white"
      ? { r: 255, g: 255, b: 255 }
      : fill === "black"
        ? { r: 0, g: 0, b: 0 }
        : await sampleBg(raw);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new PageEditError("Invalid nudge");
  const transform = { sx: 1, sy: 1, dx: Math.round(dx), dy: Math.round(dy), width, height };
  const bytes = await transformRaster(raw, transform, bg);
  const image = await commitPixels(ctx, img, bytes, true, transform, bg);
  void logActivity({
    seriesId: ctx.series.id,
    episodeId: ctx.episode.id,
    userId: ctx.user.id,
    action: "nudged_page",
    payload: { imageId, dx, dy },
  });
  return image;
}

export async function scalePageToWidth(
  ctx: Ctx,
  img: ImageRow,
  targetW: number,
  opts: { undo?: boolean } = {},
): Promise<ImageRow> {
  const raw = await readFile(
    imagePath(ctx.series.slug, ctx.episode.slug, img.filename),
  );
  const meta = await sharp(raw).metadata();
  const width = meta.width || img.width;
  const height = meta.height || img.height;
  if (width === targetW) return img;
  const bytes = await sharp(raw).resize({ width: targetW }).png().toBuffer();
  const out = await sharp(bytes).metadata();
  const newH = out.height || Math.max(1, Math.round(height * (targetW / width)));
  const transform: PixelTransform = {
    sx: targetW / width,
    sy: newH / height,
    dx: 0,
    dy: 0,
    width: targetW,
    height: newH,
  };
  return commitPixels(ctx, img, bytes, opts.undo !== false, transform, "#ffffff");
}

export async function autoCropPages(
  ctx: Ctx,
  imageIds?: string[],
): Promise<ImageRow[]> {
  const imgs = await listImages(ctx.episode.id);
  const targets = storyPages(
    imageIds?.length ? imgs.filter((i) => imageIds.includes(i.id)) : imgs,
  );
  const out: ImageRow[] = [];
  const changed: string[] = [];
  const geometry: Record<string, GeometrySnapshot> = {};
  for (const img of targets) {
    const raw = await readFile(
      imagePath(ctx.series.slug, ctx.episode.slug, img.filename),
    );
    const box = await contentBBox(raw);
    if (
      box.x <= 1 &&
      box.y <= 1 &&
      box.w >= img.width - 2 &&
      box.h >= img.height - 2
    ) {
      out.push(img);
      continue;
    }
    await backupWorking(ctx, img);
    geometry[img.id] = await captureGeometry(ctx.episode.id, img.id);
    changed.push(img.id);
    out.push(await cropPage(ctx, img.id, box, { undo: false }));
  }
  if (changed.length) {
    await pushUndo(ctx.series.slug, ctx.episode.slug, {
      type: "pixels",
      imageId: changed[0],
      imageIds: changed,
      geometry,
    });
  }
  return out;
}

export async function autoAlignPages(ctx: Ctx): Promise<ImageRow[]> {
  const imgs = await listImages(ctx.episode.id);
  if (!imgs.length) return [];
  const loaded = [];
  for (const img of imgs) {
    const raw = await readFile(
      imagePath(ctx.series.slug, ctx.episode.slug, img.filename),
    );
    const box = await contentBBox(raw);
    loaded.push({ img, raw, box });
  }
  const story = loaded.filter((p) => !isCreditsPage(p.img));
  if (!story.length) return imgs;
  const targetW = Math.max(...story.map((p) => p.box.w));
  const targetH = Math.max(...story.map((p) => p.box.h));
  const next = new Map<string, ImageRow>();
  const geometry: Record<string, GeometrySnapshot> = {};
  const changed: string[] = [];
  for (const p of story) {
    const art = await sharp(p.raw)
      .extract({
        left: p.box.x,
        top: p.box.y,
        width: p.box.w,
        height: p.box.h,
      })
      .png()
      .toBuffer();
    const bg = await samplePadding(art);
    const left = Math.round((targetW - p.box.w) / 2);
    const top = Math.round((targetH - p.box.h) / 2);
    const transform: PixelTransform = {
      sx: 1, sy: 1, dx: left - p.box.x, dy: top - p.box.y,
      width: targetW, height: targetH, crop: p.box,
    };
    const bytes = await transformRaster(p.raw, transform, bg);
    await backupWorking(ctx, p.img);
    geometry[p.img.id] = await captureGeometry(ctx.episode.id, p.img.id);
    changed.push(p.img.id);
    next.set(p.img.id, await commitPixels(ctx, p.img, bytes, false, transform, bg));
  }
  for (const p of loaded.filter((row) => isCreditsPage(row.img))) {
    const width = (await sharp(p.raw).metadata()).width || p.img.width;
    if (width === targetW) {
      next.set(p.img.id, p.img);
      continue;
    }
    await backupWorking(ctx, p.img);
    geometry[p.img.id] = await captureGeometry(ctx.episode.id, p.img.id);
    changed.push(p.img.id);
    next.set(p.img.id, await scalePageToWidth(ctx, p.img, targetW, { undo: false }));
  }
  if (changed.length) {
    await pushUndo(ctx.series.slug, ctx.episode.slug, {
      type: "pixels",
      imageId: changed[0],
      imageIds: changed,
      geometry,
    });
  }
  void logActivity({
    seriesId: ctx.series.id,
    episodeId: ctx.episode.id,
    userId: ctx.user.id,
    action: "aligned_pages",
    payload: { width: targetW, height: targetH },
  });
  return imgs.map((img) => next.get(img.id) ?? img);
}

export async function addSeriesCredits(ctx: Ctx): Promise<{ images: ImageRow[]; added: number }> {
  const credits = seriesCreditsOf(ctx.series);
  const kinds = (["pre", "post"] as const).filter((kind) => credits[kind]);
  if (!kinds.length) throw new PageEditError("This series has no credits pages");
  const created: ImageRow[] = [];
  for (const kind of kinds) {
    const current = await listImages(ctx.episode.id);
    if (current.some((img) => img.role === creditRole(kind))) continue;
    const credit = credits[kind]!;
    const bytes = await readAsset(credit.hash);
    const sortOrder = kind === "pre" ? 0 : current.length;
    if (kind === "pre") {
      for (const img of current) {
        await db
          .update(images)
          .set({ sortOrder: img.sortOrder + 1 })
          .where(eq(images.id, img.id));
      }
    }
    const saved = await saveImageFile({
      seriesSlug: ctx.series.slug,
      episodeSlug: ctx.episode.slug,
      sortOrder,
      originalName: credit.originalName,
      bytes,
      mime: "image/png",
    });
    const t = now();
    const row = {
      id: nid(),
      episodeId: ctx.episode.id,
      filename: saved.filename,
      originalName: credit.originalName,
      sortOrder,
      width: saved.width,
      height: saved.height,
      dpi: saved.dpi,
      caption: "",
      role: creditRole(kind),
      createdAt: t,
      updatedAt: t,
    };
    await db.insert(images).values(row);
    const image = toImage(row);
    created.push(image);
    broadcast(ctx.episode.id, { type: "image:upsert", image });
  }
  const story = storyPages(await listImages(ctx.episode.id));
  const targetW = story.length ? Math.max(...story.map((img) => img.width)) : 0;
  if (targetW) {
    for (const img of created) {
      await scalePageToWidth(ctx, img, targetW, { undo: false });
    }
  }
  const next = await listImages(ctx.episode.id);
  broadcast(ctx.episode.id, {
    type: "image:reorder",
    order: next.map((img) => ({ id: img.id, sortOrder: img.sortOrder })),
  });
  void logActivity({
    seriesId: ctx.series.id,
    episodeId: ctx.episode.id,
    userId: ctx.user.id,
    action: "added_series_credits",
    payload: { count: created.length, kinds },
  });
  return { images: next, added: created.length };
}

export async function splitSpread(
  ctx: Ctx,
  imageId: string,
  opts: { force?: boolean; at?: number } = {},
): Promise<ImageRow[]> {
  const imgs = await listImages(ctx.episode.id);
  const img = requireImage(imgs, imageId);
  if (isCreditsPage(img)) throw new PageEditError("Credits pages cannot be split");
  const raw = await readWorkingBytes(ctx, img);
  const meta = await sharp(raw).metadata();
  const width = meta.width || img.width;
  const height = meta.height || img.height;
  if (width < 80) throw new PageEditError("Page is too narrow to split");
  const at =
    typeof opts.at === "number" && Number.isFinite(opts.at)
      ? opts.at
      : undefined;
  const gutter = await findWhiteGutter(raw, at != null ? { around: at } : {});
  if (!gutter && !opts.force) {
    throw new PageEditError(
      at != null
        ? "No full-height white gutter at the clicked position."
        : "No full-height white gutter in the middle. Split only runs when each half would be at least 40% of the width.",
      400,
      "no_gutter",
    );
  }
  const mid =
    at != null ? splitXFromAt(width, at) : (gutter?.x ?? Math.round(width / 2));
  const right = await sharp(raw)
    .extract({ left: mid, top: 0, width: width - mid, height })
    .png()
    .toBuffer();
  const left = await sharp(raw)
    .extract({ left: 0, top: 0, width: mid, height })
    .png()
    .toBuffer();

  await backupWorking(ctx, img);
  const prevOrder = imgs.map((i) => ({ id: i.id, sortOrder: i.sortOrder }));
  const rightMeta = await sharp(right).metadata();
  await writeFile(
    imagePath(ctx.series.slug, ctx.episode.slug, img.filename),
    right,
  );
  const t = now();
  await db
    .update(images)
    .set({
      width: rightMeta.width || mid,
      height: rightMeta.height || height,
      updatedAt: t,
    })
    .where(eq(images.id, img.id));

  const savedName = img.filename.replace(/(\.[^.]+)$/, "-l$1");
  const leftPath = imagePath(ctx.series.slug, ctx.episode.slug, savedName);
  await writeFile(leftPath, left);
  const origLeft = leftPath + ".orig";
  await writeFile(origLeft, left);
  const leftMeta = await sharp(left).metadata();
  const newId = nid();
  const leftRow = {
    id: newId,
    episodeId: ctx.episode.id,
    filename: savedName,
    originalName: img.originalName.replace(/(\.[^.]+)$/, "-left$1"),
    sortOrder: img.sortOrder + 1,
    width: leftMeta.width || mid,
    height: leftMeta.height || height,
    caption: img.caption || "",
    role: img.role ?? "page",
    createdAt: t,
    updatedAt: t,
  };
  for (const other of imgs) {
    if (other.sortOrder > img.sortOrder) {
      await db
        .update(images)
        .set({ sortOrder: other.sortOrder + 1 })
        .where(eq(images.id, other.id));
    }
  }
  await db.insert(images).values(leftRow);

  const splitFrac = mid / width;
  const placed = (await listLines(ctx.episode.id)).filter(
    (l) => l.imageId === img.id && l.placed,
  );
  for (const line of placed) {
    const x = line.x ?? 0;
    if (x >= splitFrac) {
      const span = 1 - splitFrac;
      await db
        .update(lines)
        .set({
          x: span > 0 ? (x - splitFrac) / span : 0,
          w: Math.min(1, (line.w ?? 0.4) / Math.max(span, 0.01)),
          updatedAt: t,
        })
        .where(eq(lines.id, line.id));
    } else {
      await db
        .update(lines)
        .set({
          imageId: newId,
          x: splitFrac > 0 ? x / splitFrac : 0,
          w: Math.min(1, (line.w ?? 0.4) / Math.max(splitFrac, 0.01)),
          updatedAt: t,
        })
        .where(eq(lines.id, line.id));
    }
  }

  await pushUndo(ctx.series.slug, ctx.episode.slug, {
    type: "split",
    originalId: img.id,
    createdId: newId,
    order: prevOrder,
  });

  const next = await listImages(ctx.episode.id);
  for (const image of next)
    broadcast(ctx.episode.id, { type: "image:upsert", image });
  for (const line of await listLines(ctx.episode.id)) {
    broadcast(ctx.episode.id, { type: "line:upsert", line });
  }
  void logActivity({
    seriesId: ctx.series.id,
    episodeId: ctx.episode.id,
    userId: ctx.user.id,
    action: "split_spread",
    payload: { imageId, createdId: newId, forced: !gutter },
  });
  return next;
}

export async function splitWideSpreads(
  ctx: Ctx,
  opts: { force?: boolean; imageIds?: string[] } = {},
): Promise<{ images: ImageRow[]; skipped: string[] }> {
  const imgs = await listImages(ctx.episode.id);
  const targets = (opts.imageIds?.length
    ? imgs.filter((img) => opts.imageIds!.includes(img.id))
    : imgs
  ).filter((img) => !isCreditsPage(img));
  const skipped: string[] = [];
  for (const img of targets) {
    try {
      await splitSpread(ctx, img.id, { force: opts.force });
    } catch (e) {
      if (e instanceof PageEditError && e.code === "no_gutter") {
        skipped.push(img.id);
        continue;
      }
      if (e instanceof PageEditError) continue;
      throw e;
    }
  }
  return { images: await listImages(ctx.episode.id), skipped };
}

export async function reorderPages(
  ctx: Ctx,
  order: { id: string; sortOrder: number }[],
): Promise<void> {
  const imgs = await listImages(ctx.episode.id);
  await pushUndo(ctx.series.slug, ctx.episode.slug, {
    type: "reorder",
    order: imgs.map((i) => ({ id: i.id, sortOrder: i.sortOrder })),
  });
  for (const item of order) {
    await db
      .update(images)
      .set({ sortOrder: item.sortOrder })
      .where(eq(images.id, item.id));
  }
  broadcast(ctx.episode.id, { type: "image:reorder", order });
}

async function readWorkingBytes(ctx: Ctx, img: ImageRow): Promise<Buffer> {
  const bytes = await readWorkingOrOrig(
    ctx.series.slug,
    ctx.episode.slug,
    img.filename,
  );
  if (!bytes)
    throw new PageEditError(`Missing image file for ${img.originalName}`, 404);
  return bytes;
}

async function describePageWithQwen3Vl(
  jpeg: Buffer,
  abort?: AbortSignal,
  model?: string,
): Promise<string> {
  const id = qwen3VlReviewId(model);
  const messages = [
    { role: "system" as const, content: DESCRIBE_SYSTEM },
    imageMessage(jpeg, DESCRIBE_USER),
  ];
  const request = sanitizeLlmMessages(messages);
  try {
    const text = await withLocalReview(
      (signal) => localChat(id, messages, signal, undefined, 256),
      abort,
    );
    const caption = text.replace(/^["'\s]+|["'\s]+$/g, "").trim();
    const ctx = jobContext();
    if (ctx)
      appendJobLog(ctx.jobId, {
        engine: id,
        model: id,
        request,
        response: caption,
      });
    return caption;
  } catch (e) {
    const ctx = jobContext();
    if (ctx)
      appendJobLog(ctx.jobId, {
        engine: id,
        model: id,
        request,
        error: e instanceof Error ? e.message : String(e),
      });
    throw e;
  }
}

/** The real scene-describe handlers — exported so model probes run the very same path. */
export const describePageHandlers: DescribePageHandlers = {
  cli: (engine, opts) => describePageWithCli(engine, opts.jpeg, { model: opts.model, abort: opts.abort }),
  local: (opts) => describePage(opts.jpeg, { model: opts.model, abort: opts.abort }),
  qwen3vl: (opts) => describePageWithQwen3Vl(opts.jpeg, opts.abort, opts.model),
};

async function describeOne(
  jpeg: Buffer,
  engine: TranslateEngine,
  model?: string,
  abort?: AbortSignal,
): Promise<string> {
  return runDescribePage(engine, { jpeg, model, abort });
}

const describeAborts = (globalThis as typeof globalThis & {
  __scanDescribe?: Map<string, AbortController>;
}).__scanDescribe ??
  ((globalThis as typeof globalThis & {
    __scanDescribe?: Map<string, AbortController>;
  }).__scanDescribe = new Map());

export function cancelDescribePages(episodeId: string) {
  describeAborts.get(episodeId)?.abort();
}

export function isDescribeRunning(episodeId: string) {
  return describeAborts.has(episodeId);
}

export function startDescribePages(
  ctx: Ctx,
  imageIds?: string[],
  overwrite = false,
  engine: TranslateEngine = DEFAULT_CHAT_MODEL_ID,
  model?: string,
) {
  const abort = new AbortController();
  describeAborts.set(ctx.episode.id, abort);
  const jobId = createJob(ctx.episode.id, "describe", {
    engine,
    model,
    modelSelections: [regionAiSettings(preferences(ctx.episode.id, ctx.series.id).regionAi).proofread],
    imageIds,
    overwrite,
  });
  updateJob(jobId, "running", {
    message: "Starting scene description…",
    completed: 0,
    total: 0,
  });
  void (async () => {
    try {
      await runWithJob(
        { jobId, step: "describe", engine, model },
        async () => {
          await describePages(
            ctx,
            imageIds,
            overwrite,
            engine,
            model,
            abort.signal,
            jobId,
          );
        },
      );
      updateJob(
        jobId,
        abort.signal.aborted ? "cancelled" : "completed",
        {
          message: abort.signal.aborted ? "Cancelled" : "Page described",
        },
      );
    } catch (e) {
      updateJob(
        jobId,
        abort.signal.aborted ? "cancelled" : "failed",
        { message: e instanceof Error ? e.message : String(e) },
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      describeAborts.delete(ctx.episode.id);
      broadcast(ctx.episode.id, {
        type: "page:describe",
        running: false,
        imageIndex: 0,
        imageCount: 0,
        message: "",
      });
    }
  })();
  return { jobId };
}

/** The real compact-notes handlers — exported so model probes run the very same path. */
export const compactNotesHandlers: CompactNotesHandlers = {
  cli: compactSceneNotesWithCli,
  local: compactSceneNotes,
};

async function compactChapterNotes(
  ctx: Ctx,
  abort?: AbortSignal,
  jobId?: string,
) {
  const imgs = await listImages(ctx.episode.id);
  const captions = imgs
    .map((img, i) => ({ i, id: img.id, caption: (img.caption || "").trim(), revision: img.captionRevision ?? 0 }))
    .filter((row) => row.caption);
  if (!captions.length) return;
  if (jobId)
    updateJob(jobId, "running", {
      message: "Compacting scene notes…",
    });
  const prefs = preferences(ctx.episode.id, ctx.series.id);
  const proof = regionAiSettings(prefs.regionAi, {
    engine: DEFAULT_CHAT_MODEL_ID,
    model: "",
  }).proofread;
  const rows = captions.map(({ i, caption }) => ({ i, caption }));
  const result = await runCompactSceneNotes(
    proof.engine,
    rows,
    { abort, model: proof.model },
  );
  if (jobId) {
    appendJobLog(jobId, {
      step: "compact-notes",
      engine: proof.engine,
      model: proof.model,
      request: captions.map((row) => `[${row.i}]\n${row.caption}`).join("\n\n"),
      response: JSON.stringify(result, null, 2),
    });
  }
  for (const row of captions) {
    const next = result.pages.find((p) => p.i === row.i)?.caption ?? row.caption;
    if (!next || next === row.caption) continue;
    const saved = await db
      .update(images)
      .set({ caption: next })
      .where(and(eq(images.id, row.id), eq(images.captionRevision, row.revision)));
    if (!saved.changes) continue;
    const image = toImage(
      (await db.select().from(images).where(eq(images.id, row.id)).get())!,
    );
    broadcast(ctx.episode.id, { type: "image:upsert", image });
  }
  if (result.chapter.trim() && result.chapter !== prefs.chapterSummary) {
    const doc = getDoc<Partial<Preferences>>(`chapter:${ctx.episode.id}`, {});
    try {
      putDoc(
        ctx.episode.id,
        doc.id,
        { ...doc.data, chapterSummary: result.chapter.trim() },
        doc.revision,
      );
    } catch {
      /* concurrent chapter-pref edit; page notes still saved */
    }
  }
}

export async function describePages(
  ctx: Ctx,
  imageIds?: string[],
  overwrite = false,
  engine: TranslateEngine = DEFAULT_CHAT_MODEL_ID,
  model?: string,
  abort?: AbortSignal,
  jobId?: string,
): Promise<ImageRow[]> {
  const imgs = await listImages(ctx.episode.id);
  const targets = imageIds?.length
    ? imgs.filter((i) => imageIds.includes(i.id))
    : imgs;
  const jobs = overwrite
    ? targets
    : targets.filter((img) => !img.caption.trim());
  try {
    if (jobId)
      updateJob(jobId, "running", {
        message: jobs.length
          ? `Describing 1 of ${jobs.length}…`
          : "Nothing to describe",
        completed: 0,
        total: jobs.length,
        imageIndex: 0,
        imageCount: jobs.length,
      });
    for (let i = 0; i < jobs.length; i++) {
      if (abort?.aborted) throw new Error("Cancelled");
      const img = jobs[i];
      const message = `Describing ${i + 1} of ${jobs.length}…`;
      broadcast(ctx.episode.id, {
        type: "page:describe",
        running: true,
        imageIndex: i,
        imageCount: jobs.length,
        message,
        imageId: img.id,
      });
      if (jobId) {
        pageResult(jobId, img.id, "running");
        updateJob(jobId, "running", {
          message,
          completed: i,
          total: jobs.length,
          imageIndex: i,
          imageCount: jobs.length,
        });
      }
      let raw: Buffer;
      try {
        raw = await readWorkingBytes(ctx, img);
      } catch (e) {
        if (e instanceof PageEditError && e.status === 404 && jobs.length > 1) {
          console.warn(`[describe] skip ${img.filename}: missing file`);
          if (jobId) pageResult(jobId, img.id, "failed", "Missing image file");
          continue;
        }
        throw e;
      }
      const jpeg = await sharp(raw).jpeg({ quality: 75 }).toBuffer();
      const caption = await runWithJob(
        {
          jobId: jobId || jobContext()?.jobId || "",
          step: "describe",
          imageId: img.id,
          engine,
          model,
        },
        () => describeOne(jpeg, engine, model, abort),
      );
      if (!caption)
        throw new PageEditError("Describe returned an empty scene note", 502);
      if (abort?.aborted) throw new Error("Cancelled");
      const saved = await db
        .update(images)
        .set({ caption })
        .where(
          and(
            eq(images.id, img.id),
            eq(images.captionRevision, img.captionRevision ?? 0),
          ),
        );
      if (!saved.changes)
        throw new PageEditError(
          "Scene note changed during description; the newer note was preserved",
          409,
        );
      const row = await db
        .select()
        .from(images)
        .where(eq(images.id, img.id))
        .get();
      if (!row) continue;
      const image = toImage(row);
      if (jobId) {
        pageResult(jobId, img.id, "completed");
        updateJob(jobId, "running", {
          message,
          completed: i + 1,
          total: jobs.length,
          imageIndex: i + 1,
          imageCount: jobs.length,
        });
      }
      broadcast(ctx.episode.id, { type: "image:upsert", image });
    }
    try {
      if (abort?.aborted) throw new Error("Cancelled");
      if (jobId) await compactChapterNotes(ctx, abort, jobId);
    } catch (e) {
      if (abort?.aborted || (e instanceof Error && e.message === "Cancelled"))
        throw e;
      console.warn(
        `[describe] compact notes failed: ${e instanceof Error ? e.message : e}`,
      );
      if (jobId)
        appendJobLog(jobId, {
          step: "compact-notes",
          request: "",
          error: e instanceof Error ? e.message : String(e),
        });
    }
    const latest = await listImages(ctx.episode.id);
    const wanted = new Set(targets.map((img) => img.id));
    return latest.filter((img) => wanted.has(img.id));
  } finally {
    broadcast(ctx.episode.id, {
      type: "page:describe",
      running: false,
      imageIndex: jobs.length,
      imageCount: jobs.length,
      message: jobs.length ? "Page described" : "",
    });
  }
}

export async function revertPageToRaw(
  ctx: Ctx,
  imageId: string,
): Promise<ImageRow> {
  const imgs = await listImages(ctx.episode.id);
  const img = requireImage(imgs, imageId);
  const orig = origImagePath(ctx.series.slug, ctx.episode.slug, img.filename);
  if (!existsSync(orig))
    throw new PageEditError("This page has no saved raw to revert to", 404);
  const bytes = await readFile(orig);
  const image = await commitPixels(ctx, img, bytes);
  void logActivity({
    seriesId: ctx.series.id,
    episodeId: ctx.episode.id,
    userId: ctx.user.id,
    action: "reverted_to_raw",
    payload: { imageId },
  });
  return image;
}

export async function setCaption(
  ctx: Ctx,
  imageId: string,
  caption: string,
  expectedRevision?: number,
): Promise<ImageRow> {
  const existing = await db
    .select()
    .from(images)
    .where(and(eq(images.id, imageId), eq(images.episodeId, ctx.episode.id)))
    .get();
  if (!existing) throw new PageEditError("Image not found", 404);
  if (!Number.isInteger(expectedRevision))
    throw new PageEditError("A scene-note revision is required", 428);
  if (existing.captionRevision !== expectedRevision)
    throw Object.assign(
      new PageEditError(
        "This scene note changed. Your draft is retained.",
        409,
      ),
      { current: { ...toImage(existing), revision: existing.captionRevision } },
    );
  const result = await db
    .update(images)
    .set({ caption })
    .where(
      and(
        eq(images.id, imageId),
        eq(images.captionRevision, expectedRevision!),
      ),
    );
  if (!result.changes)
    throw new PageEditError("Scene note changed during saving", 409);
  const image = toImage(
    (await db.select().from(images).where(eq(images.id, imageId)).get())!,
  );
  broadcast(ctx.episode.id, { type: "image:upsert", image });
  return image;
}

async function applyOrder(
  episodeId: string,
  order: { id: string; sortOrder: number }[],
) {
  for (const item of order) {
    await db
      .update(images)
      .set({ sortOrder: item.sortOrder })
      .where(eq(images.id, item.id));
  }
  broadcast(episodeId, { type: "image:reorder", order });
}

export async function undoPageOp(
  ctx: Ctx,
): Promise<{ op: PageUndoOp | null; image?: ImageRow; images?: ImageRow[] }> {
  const op = await popUndo(ctx.series.slug, ctx.episode.slug);
  if (!op) throw new PageEditError("Nothing to undo");
  if (op.type === "pixels") {
    const ids = op.imageIds?.length ? op.imageIds : [op.imageId];
    const restored: ImageRow[] = [];
    let lastErr: unknown;
    for (const imageId of ids) {
      try {
        const result = await undoInpaint({
          series: ctx.series,
          episode: ctx.episode,
          user: ctx.user,
          imageId,
        });
        if (op.geometry?.[imageId]) await restoreGeometry(ctx.episode.id, result.image, op.geometry[imageId]);
        restored.push(result.image);
      } catch (e) {
        lastErr = e;
      }
    }
    if (!restored.length) {
      if (lastErr instanceof Error) throw lastErr;
      throw new PageEditError("Nothing to undo");
    }
    return { op, image: restored[0], images: restored };
  }
  if (op.type === "reorder") {
    await applyOrder(ctx.episode.id, op.order);
    return { op };
  }
  if (op.type === "reslice") {
    const { copyFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    for (const id of op.createdIds) {
      const row = await db.select().from(images).where(eq(images.id, id)).get();
      if (row) {
        await db.delete(images).where(eq(images.id, id));
        await removeImageFile(ctx.series.slug, ctx.episode.slug, row.filename);
        broadcast(ctx.episode.id, { type: "image:delete", id });
      }
    }
    for (const img of op.previous) {
      await db.insert(images).values({
        id: img.id,
        episodeId: img.episodeId,
        filename: img.filename,
        originalName: img.originalName,
        sortOrder: img.sortOrder,
        width: img.width,
        height: img.height,
        dpi: img.dpi ?? 72,
        caption: img.caption,
        role: img.role ?? "page",
        createdAt: img.createdAt,
        updatedAt: img.updatedAt,
      });
      const dest = imagePath(ctx.series.slug, ctx.episode.slug, img.filename);
      const src = join(op.dir, img.filename);
      if (existsSync(src)) await copyFile(src, dest);
      const origSrc = join(op.dir, `${img.filename}.orig`);
      const origDest = origImagePath(ctx.series.slug, ctx.episode.slug, img.filename);
      if (existsSync(origSrc)) await copyFile(origSrc, origDest);
      const row = await db.select().from(images).where(eq(images.id, img.id)).get();
      if (row) broadcast(ctx.episode.id, { type: "image:upsert", image: toImage(row) });
    }
    // The reslice moved the pages after the window down to make room for its slices; undo
    // puts every page back on the order it had before, including those.
    for (const item of op.order ?? []) {
      await db
        .update(images)
        .set({ sortOrder: item.sortOrder })
        .where(eq(images.id, item.id));
    }
    for (const line of op.lines) {
      await db
        .update(lines)
        .set({
          imageId: line.imageId,
          x: line.x,
          y: line.y,
          w: line.w,
          h: line.h,
          revision: (line.revision ?? 0) + 1,
          updatedAt: now(),
        })
        .where(eq(lines.id, line.id));
    }
    const next = await listImages(ctx.episode.id);
    broadcast(ctx.episode.id, {
      type: "image:reorder",
      order: next.map((img) => ({ id: img.id, sortOrder: img.sortOrder })),
    });
    return { op, images: next };
  }
  const created = await db
    .select()
    .from(images)
    .where(eq(images.id, op.createdId))
    .get();
  if (created) {
    await db.delete(images).where(eq(images.id, created.id));
    await removeImageFile(ctx.series.slug, ctx.episode.slug, created.filename);
    broadcast(ctx.episode.id, { type: "image:delete", id: created.id });
  }
  await undoInpaint({
    series: ctx.series,
    episode: ctx.episode,
    user: ctx.user,
    imageId: op.originalId,
  });
  await applyOrder(ctx.episode.id, op.order);
  return { op };
}
