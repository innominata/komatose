import JSZip from "jszip";
import sharp from "sharp";
import { writePsdBuffer, type Layer, type PixelData, type Psd } from "ag-psd";
import type { Episode, ImageRow, LineRow, Series } from "../types";
import { exportBlockers, exportRequiresCompletion, type FittedLayout, type PageData, type RegionData, type TextPath } from "../workflow";
import { getDoc, readAsset, storeAsset, WorkflowError } from "./workflowStore";
import { listImages, listLines } from "./queries";
import {
  preparePage,
  readiness,
  effectiveDpi,
  preferences,
} from "./workflowService";
import { createJob, updateJob, pageResult } from "./jobs";
import { exportJobPayload, pruneExportJobs, unlinkAssetFiles, unreferencedAssets } from "./exportRetention";
import { textMatrix } from "./typesetting";
import { psdTextWarp, warpPad } from "../textWarp";
import { activeEffects, effectsReach, psdEffects } from "../textEffects";
import { regionTextPaths, textPathBeziers, trimBeziers } from "../textPath";
import { buildTxt2, type Txt2Layer, type Txt2Run } from "./txt2";
import { metaLayer, pixelHash, regionSnapshot, writeMeta, type ExportMeta } from "./psdMeta";
import { applyTextMaskToLayer, cropTextMask, maskPixelData } from "./textMask";
import { db, sqlite } from "./db";
import { images, lines, episodes, series as seriesTable } from "./db/schema";
import { and, asc, eq } from "drizzle-orm";
import { toImage, toLine, toSeries, toEpisode } from "./queries";
import { readWorkingOrOrig } from "./storage";
import { workCredit } from "../workCredit";
import { exportDocument } from './exportDocuments';
import { loadSpeakerAssignments } from './characters';
import type { CharacterAssignment } from '../characters';
import { creditRole } from '../credits';

export type ExportPage = {
  image: ImageRow;
  source: PageData;
  sourceRevision: number;
  regions: { line: LineRow; data: RegionData; revision: number }[];
  dpi: number;
};
export type ExportSnapshot = {
  speakers?: Record<string, CharacterAssignment>;
  schemaVersion: 1;
  revision: number;
  createdAt: number;
  series: Series;
  episode: Episode;
  pages: ExportPage[];
  lines: LineRow[];
  draft: boolean;
  format: string;
  quality: number;
  includeMetadata?: boolean;
  issues: unknown[];
  defaults: { chapter: unknown; series: unknown };
};

/**
 * True when a saved export job payload is a complete snapshot rather than the
 * summary fields kept after the zip exists.
 */
export function isExportSnapshot(value: unknown): value is ExportSnapshot {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    rec.schemaVersion === 1 &&
    Array.isArray(rec.pages) &&
    Array.isArray(rec.lines)
  );
}
async function pixels(bytes: Buffer): Promise<PixelData> {
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data),
  };
}
export async function renderPage(page: ExportPage, options: { includeOverflow?: boolean; base?: Buffer } = {}) {
  const base = options.base ?? await readAsset(page.source.cleaned || page.source.cleanBase || page.source.prepared!);
  const renderable = page.regions.filter(
    (r) =>
      r.line.sourceState !== "ignored" &&
      r.data.renderEnabled !== false &&
      r.data.layout &&
      (options.includeOverflow || !r.data.layout.overflow),
  );
  const layouts = renderable.map((r) => r.data.layout!);
  const layers: {
    bytes: Buffer;
    left: number;
    top: number;
    width: number;
    height: number;
  }[] = [];
  for (const region of renderable) {
    const { line, data } = region;
    const l = data.layout!;
    const points = [
      ...(data.polygon?.length
        ? data.polygon
        : [
            { x: line.x ?? 0, y: line.y ?? 0 },
            {
              x: (line.x ?? 0) + (line.w ?? 0.2),
              y: (line.y ?? 0) + (line.h ?? 0.1),
            },
          ]),
      // Path text can run outside the region; its crop covers every path.
      ...(l.onPath ? regionTextPaths(data).flatMap((p) => p.points) : []),
    ];
    const regionW =
      (Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x))) *
      page.image.width;
    const regionH =
      (Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y))) *
      page.image.height;
    // Skew shears glyphs sideways by up to tan(angle) × half the region extent on the other axis.
    const shear =
      Math.abs(Math.tan(((l.style.skewX ?? 0) * Math.PI) / 180)) * (regionH / 2) +
      Math.abs(Math.tan(((l.style.skewY ?? 0) * Math.PI) / 180)) * (regionW / 2);
    const margin = Math.ceil(
      ((l.size * 2 + l.style.outlineWidth) * page.dpi) / 72 +
        shear +
        warpPad(l.style, regionW, regionH) +
        (effectsReach(l.style.effects) * page.dpi) / 72,
    );
    const left = Math.max(0, Math.min(page.image.width,
      Math.floor(Math.min(...points.map((p) => p.x)) * page.image.width) - margin));
    const top = Math.max(0, Math.min(page.image.height,
      Math.floor(Math.min(...points.map((p) => p.y)) * page.image.height) - margin));
    const right = Math.max(0, Math.min(page.image.width,
      Math.ceil(Math.max(...points.map((p) => p.x)) * page.image.width) + margin));
    const bottom = Math.max(0, Math.min(page.image.height,
      Math.ceil(Math.max(...points.map((p) => p.y)) * page.image.height) + margin));
    if (right <= left || bottom <= top) {
      layers.push({
        bytes: await sharp({ create: { width: 1, height: 1, channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer(),
        left: 0, top: 0, width: 1, height: 1,
      });
      continue;
    }
    const width = right - left;
    const height = bottom - top;
    const cropped = l.svg.replace(
      `width="${page.image.width}" height="${page.image.height}" viewBox="0 0 ${page.image.width} ${page.image.height}"`,
      `width="${width}" height="${height}" viewBox="${left} ${top} ${width} ${height}"`,
    );
    let bytes = await sharp(Buffer.from(cropped)).png().toBuffer();
    if (data.textMask)
      bytes = await applyTextMaskToLayer(
        bytes,
        await readAsset(data.textMask),
        left,
        top,
        width,
        height,
      );
    layers.push({
      bytes,
      left,
      top,
      width,
      height,
    });
  }
  const composite = await sharp(base)
    .composite(
      layers.map((l) => ({ input: l.bytes, left: l.left, top: l.top })),
    )
    .withMetadata({ density: page.dpi })
    .png()
    .toBuffer();
  return { base, layouts, layers, composite };
}

export async function renderGuestPage(series: Series, episode: Episode, image: ImageRow) {
  const doc = getDoc<PageData>(`page:${image.id}`, {});
  const source = doc.data;
  const lns = await listLines(episode.id);
  const prefs = preferences(episode.id, series.id);
  const page: ExportPage = {
    image,
    source,
    sourceRevision: doc.revision,
    dpi: effectiveDpi(source, image, prefs),
    regions: lns
      .filter((l) => l.imageId === image.id)
      .map((line) => {
        const region = getDoc<RegionData>(`region:${line.id}`, {});
        return { line, data: region.data, revision: region.revision };
      }),
  };
  if (source.cleaned || source.cleanBase || source.prepared) {
    try {
      return (await renderPage(page)).composite;
    } catch {
      /* fall back to the working scan */
    }
  }
  const raw = await readWorkingOrOrig(series.slug, episode.slug, image.filename);
  if (!raw) throw new WorkflowError("Missing image file", 404);
  return sharp(raw).png().toBuffer();
}

/** One working page. Clean is the saved artwork; typeset is that artwork with the current lettering. */
export async function pagePng(
  series: Series,
  episode: Episode,
  imageId: string,
  variant: "clean" | "typeset",
): Promise<{ bytes: Buffer; filename: string }> {
  const imgs = await listImages(episode.id);
  const index = imgs.findIndex((item) => item.id === imageId);
  if (index < 0) throw new WorkflowError("Page not found", 404);
  await preparePage(series, episode, imgs[index]);
  const current = (await listImages(episode.id)).find((item) => item.id === imageId);
  if (!current) throw new WorkflowError("Page not found", 404);
  const doc = getDoc<PageData>(`page:${current.id}`, {});
  if (!doc.data.prepared || doc.data.preparedAt !== current.updatedAt)
    throw new WorkflowError("This page changed while preparing the PNG. Try again.", 409);
  const page: ExportPage = {
    image: current,
    source: doc.data,
    sourceRevision: doc.revision,
    dpi: effectiveDpi(doc.data, current, preferences(episode.id, series.id)),
    regions: (await listLines(episode.id))
      .filter((line) => line.imageId === current.id)
      .map((line) => {
        const region = getDoc<RegionData>(`region:${line.id}`, {});
        return { line, data: region.data, revision: region.revision };
      }),
  };
  const artwork = page.source.cleaned || page.source.cleanBase || page.source.prepared;
  if (!artwork) throw new WorkflowError("This page has no image to export", 422);
  const bytes =
    variant === "clean"
      ? await sharp(await readAsset(artwork)).withMetadata({ density: page.dpi }).png().toBuffer()
      : (
          await renderPage(page, {
            // The canvas still draws text that does not fit. This file matches that page.
            includeOverflow: true,
          })
        ).composite;
  const n = page.image.pageNumber ?? index + 1;
  return { bytes, filename: variant === "clean" ? `${n}-clean.png` : `${n}.png` };
}

const rgb = (hex: string) => ({
  r: parseInt(hex.slice(1, 3), 16),
  g: parseInt(hex.slice(3, 5), 16),
  b: parseInt(hex.slice(5, 7), 16),
});
export async function finishedPsd(
  page: ExportPage,
  rendered?: Awaited<ReturnType<typeof renderPage>>,
) {
  const { width, height } = page.image;
  if (width > 30000 || height > 30000 || width * height > 80_000_000)
    throw new WorkflowError(
      `Page ${page.image.pageNumber}: exceeds PSD export limits (${width} × ${height}). Export PNG or split the page.`,
      422,
    );
  const r = rendered ?? (await renderPage(page));
  const original = await pixels(await readAsset(page.source.original!));
  const prepared = await pixels(await readAsset(page.source.prepared!));
  const children: Layer[] = [
    { name: "Original upload", hidden: true, imageData: original },
    { name: "Prepared source", hidden: true, imageData: prepared },
    { name: "Cleaned artwork", imageData: await pixels(r.base) },
  ];
  // Type on a path needs the document Txt2 block; once one layer has it, every type layer
  // gets its object there, numbered by TextIndex in layer order.
  const txt2Layers: Txt2Layer[] = [];
  // Path text that overflows is left out of the composite like any overflow, but the PSD
  // keeps it as type so it can be fixed in Photoshop, where overset path text just stops.
  const overflowing = page.regions.filter(
    (x) => x.data.layout?.onPath && x.data.layout.overflow && x.data.renderEnabled !== false && x.line.sourceState !== "ignored",
  );
  const extra = overflowing.length
    ? await renderPage({ ...page, regions: overflowing }, { includeOverflow: true, base: r.base })
    : undefined;
  const entries = [
    ...r.layouts.map((layout, i) => ({ layout, layer: r.layers[i] })),
    ...(extra?.layouts.map((layout, i) => ({ layout, layer: extra.layers[i] })) ?? []),
  ];
  const writeTxt2 = entries.some((e) => e.layout.onPath && e.layout.rows.length);
  /** Child index → region id of each type layer, for the export record (see psdMeta). */
  const layerRegion = new Map<number, string>();
  for (const [i, { layout, layer }] of entries.entries()) {
    const s = layout.style;
    const rows = layout.rows;
    if (!rows.length) continue;
    const text = rows.map((row) => row.text).join("\r");
    const minX = Math.min(...rows.map((row) => row.x)),
      maxX = Math.max(...rows.map((row) => row.x + row.width));
    const top = rows[0].baseline - (layout.size * page.dpi) / 72;
    const bottom =
      rows.at(-1)!.baseline + ((layout.size * page.dpi) / 72) * 0.3;
    // Same whole-layer map as the render: rotation · skewX · skewY, in matrix(a b c d) order.
    const [a, b, c, d] = textMatrix(s);
    const region = page.regions.find(
      (region) => region.data.layout === layout,
    )!;
    const pts = region.data.polygon ?? [
      { x: region.line.x ?? 0, y: region.line.y ?? 0 },
      {
        x: (region.line.x ?? 0) + (region.line.w ?? 0.2),
        y: (region.line.y ?? 0) + (region.line.h ?? 0.1),
      },
    ];
    const cx =
      ((Math.min(...pts.map((p) => p.x)) + Math.max(...pts.map((p) => p.x))) /
        2) *
      width;
    const cy =
      ((Math.min(...pts.map((p) => p.y)) + Math.max(...pts.map((p) => p.y))) /
        2) *
      height;
    const units = 72 / page.dpi;
    const lineLeading =
      rows.length > 1
        ? (rows[1].baseline - rows[0].baseline) * units
        : layout.size * s.leading;
    const fillOpacity = (s.fillOpacity ?? 100) / 100;
    const outlineOpacity = (s.outlineOpacity ?? 100) / 100;
    const textStyle = {
      font: { name: layout.font.postscriptName },
      fontSize: layout.size,
      leading: lineLeading,
      autoLeading: false,
      fillColor: rgb(s.fill),
      fauxBold: s.emphasis === "bold",
      fauxItalic: s.emphasis === "italic",
      ligatures: true,
      horizontalScale: 1,
      verticalScale: 1,
      strokeFlag: false,
      strokeColor: rgb(s.outline),
      outlineWidth: s.outlineWidth,
    };
    const styleRuns = psdStyleRuns(layout, textStyle);
    const boxBounds: [number, number, number, number] = [minX * units, top * units, maxX * units + 0.5, bottom * units];
    const layerLeft = layer.left;
    const layerTop = layer.top;
    const layerWidth = layer.width;
    const layerHeight = layer.height;
    const layerFx = psdEffects(activeEffects(s.effects), page.dpi) as Layer["effects"];
    const effects: Layer["effects"] =
      s.outlineWidth > 0
        ? {
            ...layerFx,
            stroke: [
              {
                enabled: true,
                position: "outside",
                fillType: "color",
                color: rgb(s.outline),
                size: { units: "Pixels", value: (s.outlineWidth * page.dpi) / 72 },
                opacity: outlineOpacity,
                blendMode: "normal",
              },
            ],
          }
        : layerFx && Object.keys(layerFx).length ? layerFx : undefined;
    const mask = async (): Promise<Layer["mask"]> => region.data.textMask
        ? {
            defaultColor: 255,
            positionRelativeToLayer: false,
            left: layerLeft,
            top: layerTop,
            right: layerLeft + layerWidth,
            bottom: layerTop + layerHeight,
            imageData: await maskPixelData(
              await cropTextMask(
                await readAsset(region.data.textMask),
                layerLeft,
                layerTop,
                layerWidth,
                layerHeight,
              ),
            ),
          }
        : undefined;
    if (layout.onPath) {
      // Photoshop sets one path per type layer, so each path's line is its own layer, with
      // only its own glyphs as the layer's pixels.
      const paths = regionTextPaths(region.data);
      for (const [k, row] of rows.entries()) {
        const path = paths[row.path ?? 0];
        if (!path) continue;
        const geo = psdTextPath(path, row.x, width, height, units);
        const runs = psdStyleRuns({ ...layout, rows: [row] }, textStyle);
        txt2Layers.push({ text: row.text, runs: runs.map(txt2Run), justification: "left", frame: { path: geo.segments } });
        layerRegion.set(children.length, region.line.id);
        children.push({
          name: `Bubble ${i + 1} · line ${k + 1} · ${region.line.id}${layout.overflow ? " · overflows path" : ""}`,
          left: layerLeft,
          top: layerTop,
          right: layerLeft + layerWidth,
          bottom: layerTop + layerHeight,
          imageData: await pixels(await layerPixels(layout.svg, k, page.image, layer, region.data.textMask)),
          fillOpacity: fillOpacity < 1 ? fillOpacity : undefined,
          mask: await mask(),
          text: {
            text: row.text,
            index: txt2Layers.length - 1,
            shapeType: "box",
            // Photoshop describes path text as a box over the path's bounds; the path itself
            // is the layer's Txt2 frame. Text space is the page in points, unrotated.
            boxBounds: geo.bounds,
            transform: [1 / units, 0, 0, 1 / units, 0, 0],
            style: textStyle,
            styleRuns: runs,
            paragraphStyle: { justification: "left", autoHyphenate: false, everyLineComposer: false },
          },
          effects,
        });
      }
      continue;
    }
    if (writeTxt2)
      txt2Layers.push({ text, runs: styleRuns.map((run) => txt2Run(run)), justification: s.align, frame: { box: boxBounds } });
    // Paragraph indents preserve each fitted line's placement within the one editable box.
    layerRegion.set(children.length, region.line.id);
    children.push({
      name: `Bubble ${i + 1} · ${region.line.id}`,
      left: layerLeft,
      top: layerTop,
      right: layerLeft + layerWidth,
      bottom: layerTop + layerHeight,
      imageData: await pixels(isMarked(layout.svg) ? await layerPixels(layout.svg, undefined, page.image, layer, region.data.textMask) : layer.bytes),
      fillOpacity: fillOpacity < 1 ? fillOpacity : undefined,
      mask: await mask(),
      text: {
        text,
        ...(writeTxt2 ? { index: txt2Layers.length - 1 } : {}),
        shapeType: "box",
        boxBounds,
        // Photoshop's 2×3 affine (xx, xy, yx, yy, tx, ty): text space in points → page pixels,
        // pivoting about the region centre. Skew rides along in the same matrix, so the layer
        // stays fully editable (it is what Free Transform → Skew writes).
        transform: [
          a / units,
          b / units,
          c / units,
          d / units,
          cx - (a * cx + c * cy),
          cy - (b * cx + d * cy),
        ],
        style: textStyle,
        styleRuns,
        paragraphStyle: {
          justification: s.align,
          autoHyphenate: false,
          everyLineComposer: false,
        },
        paragraphStyleRuns: rows.map((row, i) => ({
          length: row.text.length + (i < rows.length - 1 ? 1 : 0),
          style: {
            justification: s.align,
            autoHyphenate: false,
            startIndent: (row.x - minX) * units,
            endIndent: (maxX - row.x - row.width) * units,
            spaceBefore: 0,
            spaceAfter: 0,
          },
        })),
        warp: psdTextWarp(s),
      },
      effects,
    });
  }
  // The export record: fixed layer ids (Photoshop keeps them through edits and renames), the
  // layer → region map and each region as exported, so an import applies only what changed.
  children.forEach((child, k) => (child.id = k + 1));
  const meta: ExportMeta = {
    v: 1,
    page: page.image.id,
    exportedAt: Date.now(),
    artwork: await pixelHash(r.base),
    regions: Object.fromEntries(
      page.regions.flatMap((x) => {
        const snap = regionSnapshot(x.line, x.data);
        return snap && [...layerRegion.values()].includes(x.line.id) ? [[x.line.id, snap]] : [];
      }),
    ),
    layers: Object.fromEntries([...layerRegion].map(([k, id]) => [String(children[k].id), id])),
  };
  const hidden = metaLayer(meta, children.length + 1);
  if (writeTxt2) {
    hidden.text!.index = txt2Layers.length;
    txt2Layers.push({ text: hidden.text!.text, runs: [txt2Run({ length: hidden.text!.text.length, style: { font: { name: "ArialMT" }, fontSize: 1, leading: 1, fauxBold: false, fauxItalic: false, horizontalScale: 1, verticalScale: 1, fillColor: { r: 0, g: 0, b: 0 }, strokeColor: { r: 0, g: 0, b: 0 } } })], justification: "left", frame: { box: [0, 0, 1, 1] } });
  }
  children.push(hidden);
  const psd: Psd = {
    width,
    height,
    children,
    ...(writeTxt2 ? { engineData: Buffer.from(buildTxt2(txt2Layers)).toString("base64") } : {}),
    imageData: await pixels(r.composite),
    imageResources: {
      resolutionInfo: {
        horizontalResolution: page.dpi,
        verticalResolution: page.dpi,
        horizontalResolutionUnit: "PPI",
        verticalResolutionUnit: "PPI",
        widthUnit: "Inches",
        heightUnit: "Inches",
      },
    },
  };
  writeMeta(psd, meta);
  return writePsdBuffer(psd, { generateThumbnail: false });
}
export async function captureExport(
  series: Series,
  episode: Episode,
  format: string,
  draft: boolean,
  quality = 95,
  includeMetadata = false,
): Promise<ExportSnapshot> {
  if (
    !["png", "jpg", "psd", "clean", "json", "english", "bilingual"].includes(
      format,
    )
  )
    throw new WorkflowError("Unknown export format");
  if (!Number.isInteger(quality) || quality < 1 || quality > 100)
    throw new WorkflowError("JPG quality must be 1–100");
  const imgs = await listImages(episode.id);
  for (const img of imgs) await preparePage(series, episode, img);
  const snapshot = readExportSnapshot(series, episode, format, draft, quality, includeMetadata, true);
  const storyWidth = Math.max(0, ...snapshot.pages.filter(page => page.image.role === 'page').map(page => page.image.width));
  for (const page of snapshot.pages.filter(page => page.image.id.startsWith('series-credit:'))) {
    if (!storyWidth || storyWidth === page.image.width) continue;
    const bytes = await sharp(await readAsset(page.source.original!)).resize({ width: storyWidth }).png().toBuffer();
    const hash = await storeAsset(bytes);
    const meta = await sharp(bytes).metadata();
    page.image.width = storyWidth;
    page.image.height = meta.height!;
    page.source = { original: hash, prepared: hash, cleanBase: hash, cleaned: hash };
  }
  return snapshot;
}

/** Read saved metadata without preparing pages, writing jobs, or touching artwork. */
export function captureExportMetadata(series: Series, episode: Episode): ExportSnapshot {
  return readExportSnapshot(series, episode, 'json', true, 95, true, false);
}

function readExportSnapshot(series: Series, episode: Episode, format: string, draft: boolean, quality: number, includeMetadata: boolean, requirePrepared: boolean): ExportSnapshot {
  return sqlite.transaction(() => {
    const currentImages = db
      .select()
      .from(images)
      .where(eq(images.episodeId, episode.id))
      .orderBy(asc(images.sortOrder), asc(images.createdAt), asc(images.id))
      .all()
      .map(toImage);
    const lns = db
      .select()
      .from(lines)
      .where(eq(lines.episodeId, episode.id))
      .orderBy(asc(lines.sortOrder))
      .all()
      .map(toLine);
    const currentEpisode = toEpisode(
      db.select().from(episodes).where(eq(episodes.id, episode.id)).get()!,
    );
    const currentSeries = toSeries(
      db.select().from(seriesTable).where(eq(seriesTable.id, series.id)).get()!,
    );
    const issues = readiness(currentSeries, currentEpisode, currentImages, lns);
    const unfinished = issues.filter((issue) => issue.code === "step-complete");
    if (exportRequiresCompletion(format, draft) && unfinished.length)
      throw new WorkflowError(
        `Mark every page complete in Translate, Review, Clean, and Typeset (${unfinished.length} left).`,
        422,
        issues,
      );
    if (exportRequiresCompletion(format, draft) && exportBlockers(issues).length)
      throw new WorkflowError(
        "Resolve export readiness issues or choose a labelled draft export",
        422,
        issues,
      );
    if (
      requirePrepared && currentImages.some((image) => {
        const p = getDoc<PageData>(`page:${image.id}`, {}).data;
        return !p.prepared || p.preparedAt !== image.updatedAt;
      })
    )
      throw new WorkflowError(
        "A prepared page changed while capturing the export. Retry.",
        409,
      );
    const prefs = preferences(episode.id, series.id);
    const pages: ExportPage[] = currentImages.map((image) => {
      const doc = getDoc<PageData>(`page:${image.id}`, {});
      const source = doc.data;
      return {
        image,
        source,
        sourceRevision: doc.revision,
        dpi: effectiveDpi(source, image, prefs),
        regions: lns
          .filter((l) => l.imageId === image.id)
          .map((line) => {
            const doc = getDoc<RegionData>(`region:${line.id}`, {});
            return { line, data: doc.data, revision: doc.revision };
          }),
      };
    });
    let addedDefault = false;
    for (const kind of ['pre', 'post'] as const) {
      const credit = currentSeries.credits[kind];
      if (!credit || pages.some(page => page.image.role === creditRole(kind))) continue;
      const image: ImageRow = {
        id: `series-credit:${kind}:${episode.id}`, episodeId: episode.id,
        filename: credit.filename, originalName: credit.originalName,
        width: credit.width, height: credit.height, sortOrder: kind === 'pre' ? -1 : pages.length,
        pageNumber: null, dpi: 72, caption: '', role: creditRole(kind),
        createdAt: currentSeries.createdAt, updatedAt: currentSeries.updatedAt,
      };
      const source: PageData = { original: credit.hash, prepared: credit.hash, cleanBase: credit.hash, cleaned: credit.hash };
      const page: ExportPage = { image, source, sourceRevision: 0, dpi: 72, regions: [] };
      if (kind === 'pre') pages.unshift(page);
      else pages.push(page);
      addedDefault = true;
    }
    if (addedDefault) pages.forEach((page, index) => { page.image = { ...page.image, pageNumber: index + 1 }; });
    return {
      schemaVersion: 1 as const,
      revision: currentEpisode.revision ?? 0,
      createdAt: Date.now(),
      series: currentSeries,
      episode: currentEpisode,
      lines: lns,
      speakers: Object.fromEntries(loadSpeakerAssignments(episode.id)),
      draft,
      format,
      quality,
      includeMetadata,
      issues,
      defaults: {
        chapter: getDoc(`chapter:${episode.id}`, {}),
        series: getDoc(`series:${series.id}`, {}),
      },
      pages,
    };
  })();
}
export async function buildExport(
  snapshot: ExportSnapshot,
  onPage: (id: string) => void = () => {},
) {
  const zip = new JSZip();
  for (const [i, page] of snapshot.pages.entries()) {
    const stem = String(snapshot.draft ? i + 1 : page.image.pageNumber);
    if (snapshot.format === "clean")
      zip.file(
        `${stem}.png`,
        await readAsset(page.source.cleaned || page.source.cleanBase || page.source.prepared!),
      );
    else if (["png", "jpg", "psd"].includes(snapshot.format)) {
      if (
        snapshot.format === "psd" &&
        (page.image.width > 30000 ||
          page.image.height > 30000 ||
          page.image.width * page.image.height > 80_000_000)
      )
        throw new WorkflowError(
          `Page ${stem}: exceeds PSD size limits. Export PNG or split the page.`,
          422,
        );
      const r = await renderPage(page);
      const bytes =
        snapshot.format === "psd"
          ? await finishedPsd(page, r)
          : snapshot.format === "jpg"
            ? await sharp(r.composite)
                .jpeg({ quality: snapshot.quality, chromaSubsampling: "4:4:4" })
                .withMetadata({ density: page.dpi })
                .toBuffer()
            : r.composite;
      zip.file(`${stem}.${snapshot.format}`, bytes);
    }
    onPage(page.image.id);
  }
  if (snapshot.includeMetadata)
    zip.file('font-manifest.json', exportDocument([snapshot], 'font-manifest.json').text);
  if (snapshot.includeMetadata || snapshot.format === "json")
    zip.file('chapter.json', exportDocument([snapshot], 'chapter.json').text);
  if (snapshot.includeMetadata || snapshot.format === "english")
    zip.file('english.txt', exportDocument([snapshot], 'english.txt').text);
  if (snapshot.includeMetadata || snapshot.format === "bilingual")
    zip.file('bilingual.txt', exportDocument([snapshot], 'bilingual.txt').text);
  if (snapshot.draft && snapshot.includeMetadata)
    zip.file('DRAFT.txt', exportDocument([snapshot], 'DRAFT.txt').text);
  const credit = workCredit(snapshot.series.title);
  if (credit) zip.file("attribution.txt", credit.text);
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 3 },
  });
}
const exportRuntime = globalThis as typeof globalThis & {
  __scanExportQueue?: Promise<void>;
  __scanActiveExports?: Set<string>;
  __scanExportSnapshots?: Map<string, ExportSnapshot>;
};
exportRuntime.__scanActiveExports ??= new Set<string>();
exportRuntime.__scanExportSnapshots ??= new Map<string, ExportSnapshot>();

/** Snapshot for a retry during this server process. It is not written into the job row. */
export function recallExport(id: string): ExportSnapshot | undefined {
  return exportRuntime.__scanExportSnapshots!.get(id);
}

export function startExport(snapshot: ExportSnapshot, retryId?: string) {
  if (retryId && exportRuntime.__scanActiveExports!.has(retryId))
    throw new WorkflowError(
      "The previous export is still stopping. Retry once it has stopped.",
      409,
    );
  const fields = exportJobPayload(snapshot);
  const id = retryId ?? createJob(snapshot.episode.id, "export", fields);
  if (retryId)
    sqlite.prepare("UPDATE workflow_jobs SET payload=? WHERE id=?").run(JSON.stringify(fields), id);
  exportRuntime.__scanExportSnapshots!.set(id, snapshot);
  exportRuntime.__scanActiveExports!.add(id);
  updateJob(id, "queued", {});
  exportRuntime.__scanExportQueue = (
    exportRuntime.__scanExportQueue ?? Promise.resolve()
  )
    .catch(() => {})
    .then(async () => {
      try {
        const queued = sqlite
          .prepare("SELECT state FROM workflow_jobs WHERE id=?")
          .get(id) as { state: string };
        if (queued.state === "cancelled") return;
        updateJob(id, "running", {});
        const zip = await buildExport(snapshot, (imageId) => {
          const state = (
            sqlite
              .prepare("SELECT state FROM workflow_jobs WHERE id=?")
              .get(id) as { state: string }
          ).state;
          if (state === "cancelled") throw new Error("Cancelled");
          pageResult(id, imageId, "completed");
        });
        const state = (
          sqlite
            .prepare("SELECT state FROM workflow_jobs WHERE id=?")
            .get(id) as { state: string }
        ).state;
        if (state === "cancelled") return;
        const artifact = await storeAsset(zip);
        updateJob(id, "completed", {
          artifact,
          filename: `${snapshot.draft ? "DRAFT-" : ""}${snapshot.episode.slug}-${snapshot.format}.zip`,
          revision: snapshot.revision,
        });
        const removed = pruneExportJobs(sqlite, { episodeId: snapshot.episode.id, keepJobId: id });
        for (const dropped of removed.jobIds) exportRuntime.__scanExportSnapshots!.delete(dropped);
        unlinkAssetFiles(unreferencedAssets(sqlite, removed.hashes.filter((hash) => hash !== artifact)));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        updateJob(
          id,
          message === "Cancelled" ? "cancelled" : "failed",
          {},
          message,
        );
      } finally {
        exportRuntime.__scanActiveExports!.delete(id);
      }
    });
  return id;
}

/**
 * Photoshop character runs for a layout: one run per styled piece of each row, with the row
 * break carried by the piece that ends the row. Per-character opacity has no PSD equivalent
 * and stays in the pixels.
 */
function psdStyleRuns(layout: FittedLayout, base: Record<string, unknown>) {
  const rows = layout.rows;
  const text = rows.map((row) => row.text).join("\r");
  if (!layout.charStyles || !rows.some((row) => row.pieces)) return [{ length: text.length, style: base }];
  const runs: { length: number; style: Record<string, unknown> }[] = [];
  rows.forEach((row, i) => {
    const pieces = row.pieces ?? [{ text: row.text, style: 0 }];
    pieces.forEach((piece, k) => {
      const c = layout.charStyles![piece.style] ?? { postscriptName: layout.font.postscriptName };
      const style = {
        ...base,
        font: { name: c.postscriptName },
        fontSize: layout.size * ((c.size ?? 100) / 100),
        ...(c.fill ? { fillColor: rgb(c.fill) } : {}),
        ...(c.outline ? { strokeColor: rgb(c.outline) } : {}),
        ...(c.emphasis ? { fauxBold: c.emphasis === "bold", fauxItalic: c.emphasis === "italic" } : {}),
        tracking: (layout.style.tracking ?? 0) + (c.tracking ?? 0),
        baselineShift: c.baselineShift ?? 0,
        horizontalScale: (c.horizontalScale ?? 100) / 100,
        verticalScale: (c.verticalScale ?? 100) / 100,
      };
      const length = piece.text.length + (k === pieces.length - 1 && i < rows.length - 1 ? 1 : 0);
      const last = runs.at(-1);
      if (last && JSON.stringify(last.style) === JSON.stringify(style)) last.length += length;
      else runs.push({ length, style });
    });
  });
  return runs;
}

/**
 * A text path for the PSD: the curve our layout follows as cubic segments in text space
 * (page points), starting where the fitted line starts, since Photoshop sets path type from
 * the path's beginning.
 */
export function psdTextPath(path: TextPath, start: number, width: number, height: number, units: number) {
  const px = path.points.map((p) => ({ x: p.x * width, y: p.y * height }));
  const segments = trimBeziers(textPathBeziers(px, !!path.flip), Math.max(0, start)).map((seg) =>
    seg.map((p) => [p.x * units, p.y * units] as [number, number]),
  );
  const xs = segments.flat().map((p) => p[0]);
  const ys = segments.flat().map((p) => p[1]);
  return {
    segments,
    bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as [number, number, number, number],
  };
}

function txt2Run(run: { length: number; style: Record<string, unknown> }): Txt2Run {
  const s = run.style as {
    font: { name: string };
    fontSize: number;
    leading: number;
    fauxBold: boolean;
    fauxItalic: boolean;
    horizontalScale: number;
    verticalScale: number;
    tracking?: number;
    baselineShift?: number;
    fillColor: { r: number; g: number; b: number };
    strokeColor: { r: number; g: number; b: number };
  };
  return {
    length: run.length,
    font: s.font.name,
    size: s.fontSize,
    leading: s.leading,
    fauxBold: s.fauxBold,
    fauxItalic: s.fauxItalic,
    horizontalScale: s.horizontalScale,
    verticalScale: s.verticalScale,
    tracking: s.tracking ?? 0,
    baselineShift: s.baselineShift ?? 0,
    fill: s.fillColor,
    stroke: s.strokeColor,
  };
}

/** Layouts that mark their outline and effects (see fitText), so the glyphs can be drawn alone. */
const isMarked = (svg: string) => svg.includes("<!--outline-->");

/**
 * A type layer's own pixels, cropped to its region's layer box: the glyphs without the
 * outline and effects Photoshop draws from them (its Stroke and layer styles), and for a
 * path layout just one row.
 */
async function layerPixels(
  svg: string,
  row: number | undefined,
  image: ImageRow,
  box: { left: number; top: number; width: number; height: number },
  textMask?: string,
) {
  const only = svg
    .replace(/<!--row:(\d+)-->[\s\S]*?<!--\/row:\1-->/g, (m, k) => (row === undefined || Number(k) === row ? m : ""))
    .replace(/<!--fx-->[\s\S]*?<!--\/fx-->/g, "")
    .replace(/<!--outline-->[\s\S]*?<!--\/outline-->/g, "")
    .replace(/ filter="url\(#fx-int\)"/g, "")
    .replace(
      `width="${image.width}" height="${image.height}" viewBox="0 0 ${image.width} ${image.height}"`,
      `width="${box.width}" height="${box.height}" viewBox="${box.left} ${box.top} ${box.width} ${box.height}"`,
    );
  let bytes = await sharp(Buffer.from(only)).png().toBuffer();
  if (textMask) bytes = await applyTextMaskToLayer(bytes, await readAsset(textMask), box.left, box.top, box.width, box.height);
  return bytes;
}
