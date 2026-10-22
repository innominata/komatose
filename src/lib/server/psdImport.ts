import type { Layer, Psd } from "ag-psd";
import sharp, { type OverlayOptions } from "sharp";
import type { Episode, ImageRow, LineRow, Series } from "../types";
import { pageArtwork, type PageData, type RegionData, type TextStyle } from "../workflow";
import { effectiveTextRotation } from "../textRotation";
import { MAX_SKEW } from "../textTransform";
import { sqlite } from "./db";
import { broadcast } from "./realtime";
import { listImages, listLines } from "./queries";
import { readLayeredPsd } from "./replaceImage";
import { listFonts, validateStyle } from "./typesetting";
import { transformPlacedText } from "./placedText";
import { fitRegion, resolveStyle } from "./workflowService";
import { getDoc, putDoc, readAsset, storeAsset, withPreviousArtwork, WorkflowError } from "./workflowStore";
import { captureGeometry, restoreGeometry, type GeometrySnapshot } from "./pageGeometry";
import { pushUndo } from "./pageUndo";

/**
 * Import a page PSD written by finishedPsd back into its regions. Text layers are matched
 * by the region id in their name ("Bubble N · <id>"); the "Cleaned artwork" layer, with any
 * visible raster layers painted above it, becomes the page artwork. Every change is
 * compared with what the export would write now, so an untouched PSD changes nothing.
 */

const SOURCE_LAYERS = new Set(["Original upload", "Prepared source"]);
const ARTWORK_LAYER = "Cleaned artwork";
const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const angleGap = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
const hex = (c?: { r: number; g: number; b: number }) =>
  c ? `#${[c.r, c.g, c.b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}` : undefined;
const words = (s: string) => s.replace(/\s+/g, " ").trim();

export type PsdRegionChange = {
  lineId: string;
  layer: string;
  body?: string;
  style: Partial<TextStyle>;
  /** Region translation in page pixels. */
  move?: { dx: number; dy: number };
  rotation?: number;
  skewX?: number;
  skewY?: number;
  renderEnabled?: boolean;
  describe: string[];
};
export type PsdImportPlan = {
  imageId: string;
  regions: PsdRegionChange[];
  artwork?: Buffer;
  warnings: string[];
};

/**
 * Split a page-pixel matrix into the export's R(rotation) · skewX · skewY times a uniform
 * scale. Two decompositions exist; the one nearest the current transform wins.
 */
export function decomposeTextMatrix(
  m: readonly [number, number, number, number],
  current: { rotation: number; skewX: number; skewY: number },
) {
  const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  if (!(scale > 1e-6)) return null;
  const [a, b, c, d] = m.map((v) => v / scale);
  const kx0 = Math.sqrt(Math.max(0, c * c + d * d - 1));
  const candidates = [kx0, -kx0].map((kx) => {
    const rotation = deg(Math.atan2(d, c) - Math.atan2(1, kx));
    const ky = (a * c + b * d - kx) / (kx * kx + 1);
    return {
      rotation: ((rotation + 540) % 360) - 180,
      skewX: deg(Math.atan(kx)),
      skewY: deg(Math.atan(ky)),
      scale,
    };
  });
  const distance = (x: (typeof candidates)[number]) =>
    angleGap(x.rotation, current.rotation) + Math.abs(x.skewX - current.skewX) + Math.abs(x.skewY - current.skewY);
  return candidates.sort((x, y) => distance(x) - distance(y))[0];
}

/**
 * Rebuild the region's English from the layer text, or undefined when it was not edited.
 * The export writes one paragraph per
 * fitted row, so rows are joined back into the original paragraphs where the row count
 * still matches; otherwise every row break is treated as a wrapped line.
 */
export function importedBody(psdText: string, body: string, rows: string[]) {
  const imported = psdText.split(/\r\n?|\n/);
  // Unedited when the layer still holds the rows the export wrote, even if the layout is stale.
  if (words(imported.join(" ")) === words(rows.join(" ")) || words(imported.join(" ")) === words(body)) return undefined;
  const paragraphs = body.replace(/\r\n?/g, "\n").split("\n");
  const groups: number[] = [];
  let row = 0;
  for (const paragraph of paragraphs) {
    let count = 0, joined = "";
    while (row + count < rows.length && words(joined) !== words(paragraph))
      joined += `${count++ ? " " : ""}${rows[row + count - 1]}`;
    if (words(joined) !== words(paragraph)) return imported.map(words).join(" ");
    groups.push(Math.max(1, count));
    row += count;
  }
  if (row !== rows.length || imported.length !== rows.length) return imported.map(words).join(" ");
  let at = 0;
  return groups.map((n) => imported.slice(at, (at += n)).map(words).join(" ")).join("\n");
}

function layerPixels(layer: Layer) {
  const px = layer.imageData;
  if (!px?.width || !px.height) return null;
  return sharp(Buffer.from(px.data.buffer, px.data.byteOffset, px.data.byteLength), {
    raw: { width: px.width, height: px.height, channels: 4 },
  });
}

/** The artwork layer with every visible raster layer painted above it, or null if absent. */
async function importedArtwork(psd: Psd, warnings: string[]) {
  const layers = (psd.children ?? []).flatMap(function flat(layer: Layer): Layer[] {
    return layer.children ? layer.children.flatMap(flat) : [layer];
  });
  const base = layers.findIndex((layer) => layer.name === ARTWORK_LAYER);
  if (base < 0) {
    warnings.push(`No “${ARTWORK_LAYER}” layer, so the page artwork is unchanged.`);
    return null;
  }
  const overlays: OverlayOptions[] = [];
  for (const layer of layers.slice(base)) {
    if (layer.text || SOURCE_LAYERS.has(layer.name ?? "") || (layer.hidden && layer.name !== ARTWORK_LAYER)) continue;
    const pixels = layerPixels(layer);
    if (!pixels) continue;
    const left = layer.left ?? 0, top = layer.top ?? 0, { width, height } = layer.imageData!;
    const x0 = Math.max(0, -left), y0 = Math.max(0, -top);
    const x1 = Math.min(width, psd.width - left), y1 = Math.min(height, psd.height - top);
    if (x1 <= x0 || y1 <= y0) continue;
    const piece = await pixels.extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }).png().toBuffer();
    overlays.push({ input: piece, left: left + x0, top: top + y0 });
    if (layer.name !== ARTWORK_LAYER) warnings.push(`Merged raster layer “${layer.name}” into the page artwork.`);
  }
  return sharp({ create: { width: psd.width, height: psd.height, channels: 3, background: "#ffffff" } })
    .composite(overlays)
    .png()
    .toBuffer();
}

async function sameArtwork(imported: Buffer, current: Buffer | null) {
  if (!current) return false;
  const decode = (bytes: Buffer) =>
    sharp(bytes).flatten({ background: "#ffffff" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const [a, b] = await Promise.all([decode(imported), decode(current)]);
  return a.info.width === b.info.width && a.info.height === b.info.height && a.data.equals(b.data);
}

function regionCentre(line: LineRow, region: RegionData, page: ImageRow) {
  const pts = region.polygon ?? [
    { x: line.x ?? 0, y: line.y ?? 0 },
    { x: (line.x ?? 0) + (line.w ?? 0.2), y: (line.y ?? 0) + (line.h ?? 0.1) },
  ];
  return {
    x: ((Math.min(...pts.map((p) => p.x)) + Math.max(...pts.map((p) => p.x))) / 2) * page.width,
    y: ((Math.min(...pts.map((p) => p.y)) + Math.max(...pts.map((p) => p.y))) / 2) * page.height,
  };
}

/** Compare one exported text layer with its region and list what was edited in Photoshop. */
function regionChange(
  layer: Layer,
  lineId: string,
  line: LineRow,
  region: RegionData,
  page: ImageRow,
  current: TextStyle,
  fonts: { id: string; postscriptName?: string }[],
  warnings: string[],
): PsdRegionChange | null {
  const layout = region.layout!;
  const text = layer.text!;
  const units = 72 / layout.dpi;
  const describe: string[] = [];
  const change: PsdRegionChange = { lineId, layer: layer.name ?? lineId, style: {}, describe };
  const was = layout.style;

  const body = importedBody(text.text ?? "", line.body ?? "", layout.rows.map((row) => row.text));
  if (body !== undefined) {
    change.body = body;
    describe.push("English text");
  }

  // Position, rotation and skew come back from the layer matrix (see finishedPsd).
  let scale = 1;
  if (text.transform?.length === 6) {
    const [xx, xy, yx, yy, tx, ty] = text.transform;
    const m = [xx * units, xy * units, yx * units, yy * units] as const;
    const parts = decomposeTextMatrix(m, { rotation: was.rotation, skewX: was.skewX ?? 0, skewY: was.skewY ?? 0 });
    if (parts) {
      scale = parts.scale;
      const c = regionCentre(line, region, page);
      const dx = m[0] * c.x + m[2] * c.y + tx - c.x, dy = m[1] * c.x + m[3] * c.y + ty - c.y;
      if (Math.hypot(dx, dy) > 0.5) {
        change.move = { dx, dy };
        describe.push(`moved ${Math.round(dx)}, ${Math.round(dy)} px`);
      }
      if (angleGap(parts.rotation, was.rotation) > 0.05) {
        change.rotation = Math.round(effectiveTextRotation(-(region.geometryRotation ?? 0), parts.rotation) * 10) / 10;
        describe.push(`rotation ${Math.round(parts.rotation * 10) / 10}°`);
      }
      for (const axis of ["skewX", "skewY"] as const) {
        if (Math.abs(parts[axis] - (was[axis] ?? 0)) <= 0.05) continue;
        const value = Math.round(Math.max(-MAX_SKEW, Math.min(MAX_SKEW, parts[axis])) * 10) / 10;
        if (Math.abs(parts[axis]) > MAX_SKEW) warnings.push(`${change.layer}: skew limited to ${MAX_SKEW}°.`);
        change[axis] = value;
        describe.push(`${axis === "skewX" ? "horizontal" : "vertical"} skew ${value}°`);
      }
    }
  }

  const style = text.style ?? {};
  const size = (style.fontSize ?? layout.size) * scale;
  if (Math.abs(size - layout.size) > 0.05) {
    change.style.size = Math.round(size * 10) / 10;
    if (change.style.size < current.minSize) change.style.minSize = change.style.size;
    describe.push(`size ${change.style.size} pt`);
  }
  const font = style.font?.name;
  if (font && font !== layout.font.postscriptName) {
    const match = fonts.find((f) => f.postscriptName === font);
    if (match) {
      change.style.fontId = match.id;
      describe.push(`font ${font}`);
    } else warnings.push(`${change.layer}: font “${font}” is not uploaded to this series, so the font is unchanged.`);
  }
  const fill = hex(style.fillColor as { r: number; g: number; b: number } | undefined);
  if (fill && fill !== was.fill.toLowerCase()) {
    change.style.fill = fill;
    // An explicit colour from Photoshop must survive the refit.
    change.style.autoContrast = false;
    describe.push(`fill ${fill}`);
  }
  const emphasis = style.fauxBold ? "bold" : style.fauxItalic ? "italic" : "normal";
  if (emphasis !== was.emphasis) {
    change.style.emphasis = emphasis;
    describe.push(emphasis === "normal" ? "plain text" : emphasis);
  }
  const rows = layout.rows;
  const exportedLeading = rows.length > 1 ? (rows[1].baseline - rows[0].baseline) * units : layout.size * was.leading;
  if (style.leading && !style.autoLeading && Math.abs(style.leading * scale - exportedLeading) > 0.05) {
    change.style.leading = Math.round(((style.leading * scale) / size) * 100) / 100;
    describe.push(`leading ${change.style.leading}`);
  }
  const align = text.paragraphStyle?.justification;
  if ((align === "left" || align === "center" || align === "right") && align !== was.align) {
    change.style.align = align;
    describe.push(`${align} aligned`);
  }
  const fillOpacity = Math.round((layer.fillOpacity ?? 1) * 100);
  if (fillOpacity !== (was.fillOpacity ?? 100)) {
    change.style.fillOpacity = fillOpacity;
    describe.push(`fill opacity ${fillOpacity}%`);
  }
  const stroke = layer.effects?.stroke?.find((s) => s.enabled !== false);
  const outlineWidth = stroke?.size?.value ? Math.round(((stroke.size.value * 72) / layout.dpi) * 10) / 10 : 0;
  if (Math.abs(outlineWidth - was.outlineWidth) > 0.05) {
    change.style.outlineWidth = outlineWidth;
    describe.push(outlineWidth ? `outline ${outlineWidth} pt` : "no outline");
  }
  if (stroke) {
    const outline = hex(stroke.color as { r: number; g: number; b: number } | undefined);
    if (outline && outline !== was.outline.toLowerCase()) {
      change.style.outline = outline;
      describe.push(`outline ${outline}`);
    }
    const outlineOpacity = Math.round((stroke.opacity ?? 1) * 100);
    if (outlineOpacity !== (was.outlineOpacity ?? 100)) {
      change.style.outlineOpacity = outlineOpacity;
      describe.push(`outline opacity ${outlineOpacity}%`);
    }
  }
  const visible = !layer.hidden;
  if (visible !== (region.renderEnabled !== false)) {
    change.renderEnabled = visible;
    describe.push(visible ? "shown" : "hidden");
  }
  return describe.length ? change : null;
}

export async function planPsdImport(series: Series, episode: Episode, imageId: string, bytes: Buffer): Promise<PsdImportPlan> {
  const page = (await listImages(episode.id)).find((p) => p.id === imageId);
  if (!page) throw new WorkflowError("Page not found", 404);
  const psd = readLayeredPsd(bytes);
  if (psd.width !== page.width || psd.height !== page.height)
    throw new WorkflowError(`This PSD is ${psd.width} × ${psd.height}, but the page is ${page.width} × ${page.height}. Import a PSD exported from this page.`);
  const warnings: string[] = [];
  const lines = new Map((await listLines(episode.id)).map((l) => [l.id, l]));
  const fonts = listFonts(series.id);
  const regions: PsdRegionChange[] = [];
  const seen = new Set<string>();
  const textLayers = (psd.children ?? []).flatMap(function flat(layer: Layer): Layer[] {
    return layer.children ? layer.children.flatMap(flat) : layer.text ? [layer] : [];
  });
  for (const layer of textLayers) {
    const id = layer.name?.match(/·\s*(\S+)\s*$/)?.[1];
    const line = id ? lines.get(id) : undefined;
    if (!id || !line || line.imageId !== imageId) {
      warnings.push(`Text layer “${layer.name}” does not match a region on this page, so it was skipped.`);
      continue;
    }
    if (seen.has(id)) {
      warnings.push(`Text layer “${layer.name}” repeats a region already imported, so it was skipped.`);
      continue;
    }
    seen.add(id);
    const region = getDoc<RegionData>(`region:${id}`, {}).data;
    if (!region.layout) {
      warnings.push(`${layer.name}: the region has no fitted text to compare, so it was skipped.`);
      continue;
    }
    const change = regionChange(layer, id, line, region, page, resolveStyle(line, region, episode.id, series.id), fonts, warnings);
    if (!change) continue;
    if (region.locked) {
      warnings.push(`${change.layer}: the layout is locked, so its changes were skipped.`);
      continue;
    }
    regions.push(change);
  }
  const doc = getDoc<PageData>(`page:${imageId}`, {});
  const current = pageArtwork(doc.data);
  const artwork = await importedArtwork(psd, warnings);
  const changedArtwork = artwork && !(await sameArtwork(artwork, current ? await readAsset(current) : null)) ? artwork : undefined;
  return { imageId, regions, artwork: changedArtwork, warnings };
}

/** Apply a plan as one page undo step. Text refits with the imported style; artwork is saved like a paint edit. */
export async function applyPsdImport(series: Series, episode: Episode, userId: string, plan: PsdImportPlan) {
  if (!plan.regions.length && !plan.artwork) throw new WorkflowError("The PSD has no changes to import");
  const page = (await listImages(episode.id)).find((p) => p.id === plan.imageId)!;
  const lines = new Map((await listLines(episode.id)).map((l) => [l.id, l]));
  const geometry = await captureGeometry(episode.id, page.id);
  const artifact = plan.artwork ? await storeAsset(plan.artwork) : undefined;
  const bodies = plan.regions.filter((r) => r.body !== undefined).map((r) => ({ id: r.lineId, body: lines.get(r.lineId)!.body ?? "" }));
  sqlite.transaction(() => {
    if (artifact) {
      const doc = getDoc<PageData>(`page:${page.id}`, {});
      putDoc(episode.id, doc.id, withPreviousArtwork(doc.id, doc.data, {
        ...doc.data, cleanBase: artifact, cleaned: undefined, cleanMethod: "psd-import", cleanApproved: false,
      }, "keep"), doc.revision);
    }
    for (const change of plan.regions) {
      const line = lines.get(change.lineId)!;
      if (change.body !== undefined)
        sqlite.prepare("UPDATE lines SET body=?,revision=revision+1,updated_by=?,updated_at=? WHERE id=? AND episode_id=?")
          .run(change.body, userId, Date.now(), line.id, episode.id);
      const doc = getDoc<RegionData>(`region:${line.id}`, {});
      let data: RegionData = doc.data;
      if (Object.keys(change.style).length)
        data = { ...data, style: validateStyle({ ...resolveStyle(line, data, episode.id, series.id), ...change.style }), styleFromSeries: false };
      if (change.renderEnabled !== undefined) data = { ...data, renderEnabled: change.renderEnabled };
      const x = (line.x ?? 0) + (change.move?.dx ?? 0) / page.width;
      const y = (line.y ?? 0) + (change.move?.dy ?? 0) / page.height;
      if (change.move || change.rotation !== undefined || change.skewX !== undefined || change.skewY !== undefined) {
        data = transformPlacedText(line, data, page, x, y, change.rotation, change.skewX, change.skewY);
        sqlite.prepare("UPDATE lines SET x=?,y=?,updated_by=?,updated_at=? WHERE id=? AND episode_id=?")
          .run(x, y, userId, Date.now(), line.id, episode.id);
      }
      putDoc(episode.id, doc.id, data, doc.revision);
    }
  })();
  await pushUndo(series.slug, episode.slug, {
    type: "psd-import", imageId: page.id, geometry, bodies, description: "Import edits from PSD",
  });
  const failed: string[] = [];
  for (const change of plan.regions) {
    const line = (await listLines(episode.id)).find((l) => l.id === change.lineId);
    if (!line?.body?.trim()) continue;
    try {
      await fitRegion(series, episode, line.id, getDoc<RegionData>(`region:${line.id}`, {}).revision, { preserveStyle: true });
    } catch (e) {
      failed.push(`${change.layer}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const line of (await listLines(episode.id)).filter((l) => l.imageId === page.id))
    broadcast(episode.id, { type: "line:upsert", line });
  return { failed };
}

/** Undo an import: put the page, its regions and their English back as they were. */
export async function undoPsdImport(episodeId: string, image: ImageRow, op: { geometry: GeometrySnapshot; bodies: { id: string; body: string }[] }) {
  sqlite.transaction(() => {
    for (const { id, body } of op.bodies)
      sqlite.prepare("UPDATE lines SET body=?,revision=revision+1,updated_at=? WHERE id=? AND episode_id=?")
        .run(body, Date.now(), id, episodeId);
  })();
  await restoreGeometry(episodeId, image, op.geometry);
}
