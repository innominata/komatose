import JSZip from "jszip";
import sharp from "sharp";
import { writePsdBuffer, type Layer, type PixelData, type Psd } from "ag-psd";
import type { Episode, ImageRow, LineRow, Series } from "../types";
import { exportBlockers, exportRequiresCompletion, type FittedLayout, type PageData, type RegionData } from "../workflow";
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
import { applyTextMaskToLayer, cropTextMask, maskPixelData } from "./textMask";
import { db, sqlite } from "./db";
import { images, lines, episodes, series as seriesTable } from "./db/schema";
import { and, asc, eq } from "drizzle-orm";
import { toImage, toLine, toSeries, toEpisode } from "./queries";
import { readWorkingOrOrig } from "./storage";
import { workCredit } from "../workCredit";

export type ExportPage = {
  image: ImageRow;
  source: PageData;
  sourceRevision: number;
  regions: { line: LineRow; data: RegionData; revision: number }[];
  dpi: number;
};
export type ExportSnapshot = {
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
    const points = data.polygon?.length
      ? data.polygon
      : [
          { x: line.x ?? 0, y: line.y ?? 0 },
          {
            x: (line.x ?? 0) + (line.w ?? 0.2),
            y: (line.y ?? 0) + (line.h ?? 0.1),
          },
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
        warpPad(l.style, regionW, regionH),
    );
    const left = Math.max(
      0,
      Math.floor(Math.min(...points.map((p) => p.x)) * page.image.width) -
        margin,
    );
    const top = Math.max(
      0,
      Math.floor(Math.min(...points.map((p) => p.y)) * page.image.height) -
        margin,
    );
    const width = Math.max(
      1,
      Math.min(
        page.image.width,
        Math.ceil(Math.max(...points.map((p) => p.x)) * page.image.width) +
          margin,
      ) - left,
    );
    const height = Math.max(
      1,
      Math.min(
        page.image.height,
        Math.ceil(Math.max(...points.map((p) => p.y)) * page.image.height) +
          margin,
      ) - top,
    );
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
  for (const [i, layout] of r.layouts.entries()) {
    const s = layout.style;
    const rows = layout.rows;
    if (!rows.length) continue;
    const text = rows.map((row) => row.text).join("\r");
    const minX = Math.min(...rows.map((row) => row.x)),
      maxX = Math.max(...rows.map((row) => row.x + row.width));
    const top = rows[0].baseline - (layout.size * page.dpi) / 72;
    const bottom =
      rows.at(-1)!.baseline + ((layout.size * page.dpi) / 72) * 0.3;
    // Same whole-layer map as the SVG preview: rotation · skewX · skewY, in matrix(a b c d) order.
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
    // Paragraph indents preserve each fitted line's placement within the one editable box.
    const layerLeft = r.layers[i].left;
    const layerTop = r.layers[i].top;
    const layerWidth = r.layers[i].width;
    const layerHeight = r.layers[i].height;
    children.push({
      name: `Bubble ${i + 1} · ${region.line.id}`,
      left: layerLeft,
      top: layerTop,
      right: layerLeft + layerWidth,
      bottom: layerTop + layerHeight,
      imageData: await pixels(r.layers[i].bytes),
      mask: region.data.textMask
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
        : undefined,
      text: {
        text,
        shapeType: "box",
        boxBounds: [
          minX * units,
          top * units,
          maxX * units + 0.5,
          bottom * units,
        ],
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
        styleRuns: [{ length: text.length, style: textStyle }],
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
      effects:
        s.outlineWidth > 0
          ? {
              stroke: [
                {
                  enabled: true,
                  position: "outside",
                  fillType: "color",
                  color: rgb(s.outline),
                  size: {
                    units: "Pixels",
                    value: (s.outlineWidth * page.dpi) / 72,
                  },
                  opacity: 1,
                  blendMode: "normal",
                },
              ],
            }
          : undefined,
    });
  }
  const psd: Psd = {
    width,
    height,
    children,
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
      currentImages.some((image) => {
        const p = getDoc<PageData>(`page:${image.id}`, {}).data;
        return !p.prepared || p.preparedAt !== image.updatedAt;
      })
    )
      throw new WorkflowError(
        "A prepared page changed while capturing the export. Retry.",
        409,
      );
    const prefs = preferences(episode.id, series.id);
    return {
      schemaVersion: 1 as const,
      revision: currentEpisode.revision ?? 0,
      createdAt: Date.now(),
      series: currentSeries,
      episode: currentEpisode,
      lines: lns,
      draft,
      format,
      quality,
      includeMetadata,
      issues,
      defaults: {
        chapter: getDoc(`chapter:${episode.id}`, {}),
        series: getDoc(`series:${series.id}`, {}),
      },
      pages: currentImages.map((image) => {
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
      }),
    };
  })();
}
export async function buildExport(
  snapshot: ExportSnapshot,
  onPage: (id: string) => void = () => {},
) {
  const zip = new JSZip();
  const manifest = new Map<string, FittedLayout["font"]>();
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
    if (snapshot.includeMetadata)
      for (const region of page.regions)
        if (region.data.layout)
          manifest.set(region.data.layout.font.id, region.data.layout.font);
    onPage(page.image.id);
  }
  if (snapshot.includeMetadata)
    zip.file(
      "font-manifest.json",
      JSON.stringify(
        {
          fonts: [...manifest.values()],
          note: "Install these exact font versions to edit without substitution. Raster appearance is embedded. Target-editor reflow must be checked.",
        },
        null,
        2,
      ),
    );
  if (snapshot.includeMetadata || snapshot.format === "json")
    zip.file("chapter.json", JSON.stringify(snapshot, null, 2));
  const ordered = snapshot.pages.flatMap((p) =>
    [...p.regions]
      .sort((a, b) => a.line.sortOrder - b.line.sortOrder)
      .map((r) => ({ ...r.line, page: p.image.pageNumber })),
  );
  if (snapshot.includeMetadata || snapshot.format === "english")
    zip.file(
      "english.txt",
      ordered
        .map((l) => `Page ${l.page} · ${l.sortOrder + 1}\n${l.body}`)
        .join("\n\n"),
    );
  if (snapshot.includeMetadata || snapshot.format === "bilingual")
    zip.file(
      "bilingual.txt",
      ordered
        .map(
          (l) =>
            `Page ${l.page} · ${l.sortOrder + 1}\n${l.source || "[unreadable]"}\n${l.body}\n[${l.sourceState === "ignored" ? `ignored: ${l.ignoreReason}` : l.status}]`,
        )
        .join("\n\n"),
    );
  if (snapshot.draft && snapshot.includeMetadata)
    zip.file(
      "DRAFT.txt",
      `Draft export from revision ${snapshot.revision}.\n${JSON.stringify(snapshot.issues, null, 2)}`,
    );
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
