import type { Layer, Psd } from "ag-psd";
import sharp, { type OverlayOptions } from "sharp";
import type { Episode, ImageRow, Series } from "../types";
import { activeRegionKinds, normalizeRegionKinds } from "../regionCatalog";
import type { CharRun, CharStyle, PageData, Point, Preferences, RegionData, TextPath, TextStyle } from "../workflow";
import { normalizeCharRuns } from "../charStyles";
import { effectsFromPsd } from "../textEffects";
import { sqlite } from "./db";
import { nid } from "./ids";
import { broadcast } from "./realtime";
import { listLines } from "./queries";
import { listFonts } from "./typesetting";
import { effectiveDpi, fitRegion, preferences } from "./workflowService";
import { getDoc, putDoc } from "./workflowStore";
import { META_LAYER } from "./psdMeta";
import { get as engineGet, parseEngineData, type EValue } from "./engineData";

/**
 * PSD text layers as new regions: for layers an import can't match to a region, and for
 * every text layer of a PSD uploaded as a page. Each becomes an "Imported" region at the
 * layer's place, with its text, size, font, colours and (for type on a path) its path.
 */

export const IMPORTED_KIND = { id: "imported", label: "Imported", color: "#b388ff" };

/** Adds the series' "Imported" region type the first time it is needed. */
export function ensureImportedKind(seriesId: string) {
  const doc = getDoc<Partial<Preferences>>(`series:${seriesId}`, {});
  const kinds = activeRegionKinds(doc.data.regionKinds);
  if (kinds.some((k) => k.id === IMPORTED_KIND.id)) return;
  putDoc(null, doc.id, { ...doc.data, regionKinds: normalizeRegionKinds([...kinds, IMPORTED_KIND]) }, doc.revision);
}

export type NewRegion = {
  layer: string;
  body: string;
  bounds: { x: number; y: number; w: number; h: number };
  polygon: Point[];
  style: Partial<TextStyle>;
  charRuns?: CharRun[];
  textPaths?: TextPath[];
  hidden: boolean;
};

const hex = (c?: { r: number; g: number; b: number }) =>
  c && Number.isFinite(c.r) ? `#${[c.r, c.g, c.b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}` : undefined;
const num = (v: EValue | undefined) => (v && (v.t === "int" || v.t === "real") ? v.v : undefined);
const rad2deg = (r: number) => (r * 180) / Math.PI;

export function psdTxt2(psd: Psd): EValue | undefined {
  if (!psd.engineData) return;
  try {
    return parseEngineData(Buffer.from(psd.engineData, "base64"));
  } catch {
    return undefined;
  }
}

/**
 * A type-on-a-path layer's curve as page points (anchors and each segment's midpoint), from
 * its Txt2 frame: frame space → text space by the frame matrix, then page pixels by the
 * layer transform. Undefined for other layers.
 */
export function layerPath(layer: Layer, txt2: EValue | undefined, page: { width: number; height: number }) {
  const index = layer.text?.index;
  if (!txt2 || index === undefined) return;
  const frameNo = num(engineGet(txt2, "1", "1", String(index), "1", "0", "0", "0"));
  if (frameNo === undefined) return;
  const frame = engineGet(txt2, "0", "8", "0", String(frameNo), "0");
  if (num(engineGet(frame, "2", "0")) !== 2) return;
  const raw = engineGet(frame, "1", "0");
  const values = raw?.t === "array" ? raw.v.map(num) : [];
  if (!values.length || values.length % 8 || values.some((v) => v === undefined)) return;
  const m = engineGet(frame, "2", "2");
  const [fa, fb, fc, fd, fe, ff] = m?.t === "array" && m.v.length === 6 ? m.v.map((v) => num(v) ?? 0) : [1, 0, 0, 1, 0, 0];
  const [ta, tb, tc, td, te, tf] = layer.text?.transform?.length === 6 ? layer.text.transform : [1, 0, 0, 1, 0, 0];
  const text: [number, number][] = [];
  for (let i = 0; i < values.length; i += 2) {
    const x = values[i]!, y = values[i + 1]!;
    text.push([fa * x + fc * y + fe, fb * x + fd * y + ff]);
  }
  const segments = Array.from({ length: text.length / 4 }, (_, k) => text.slice(k * 4, k * 4 + 4));
  const toPage = ([x, y]: [number, number]) => ({ x: (ta * x + tc * y + te) / page.width, y: (tb * x + td * y + tf) / page.height });
  const at = (s: [number, number][], t: number): [number, number] => {
    const u = 1 - t;
    return [0, 1].map((k) => u * u * u * s[0][k] + 3 * u * u * t * s[1][k] + 3 * u * t * t * s[2][k] + t * t * t * s[3][k]) as [number, number];
  };
  const points = [toPage(segments[0][0]), ...segments.flatMap((s) => [toPage(at(s, 0.5)), toPage(s[3])])];
  return { points, segments };
}

/** One text layer as a new region on a page of `page.width × page.height` pixels at `dpi`. */
export function layerToRegion(
  layer: Layer,
  page: { width: number; height: number },
  dpi: number,
  fonts: { id: string; postscriptName?: string }[],
  txt2: EValue | undefined,
  warnings: string[],
): NewRegion | null {
  const text = layer.text;
  const body = (text?.text ?? "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  if (!text || !body.trim()) return null;
  const name = layer.name || "Text layer";
  const [a, b, c, d, e, f] = text.transform?.length === 6 ? text.transform : [1, 0, 0, 1, layer.left ?? 0, layer.top ?? 0];
  const toPage = (x: number, y: number) => ({ x: a * x + c * y + e, y: b * x + d * y + f });
  // Uniform scale, rotation and skew of the layer matrix (text space → page pixels).
  const scale = Math.sqrt(Math.abs(a * d - b * c)) || 1;
  const rotation = Math.round(rad2deg(Math.atan2(b, a)) * 10) / 10;
  // ag-psd's layer-wide `style` can be the engine defaults; the first run is the text's own.
  const style = { ...text.style, ...text.styleRuns?.[0]?.style };
  const fontSize = style.fontSize ?? 12;
  const sizePt = Math.round(((fontSize * scale * 72) / dpi) * 10) / 10;

  const out: Partial<TextStyle> = {
    size: sizePt,
    minSize: Math.max(1, Math.round(sizePt * 0.6 * 10) / 10),
    ...(Math.abs(rotation) > 0.05 ? { rotation } : {}),
  };
  const font = style.font?.name;
  const match = font ? fonts.find((x) => x.postscriptName === font) : undefined;
  if (match) out.fontId = match.id;
  else if (font) warnings.push(`${name}: font “${font}” is not uploaded to this series, so the region uses the Imported type's font.`);
  const fill = hex(style.fillColor as { r: number; g: number; b: number } | undefined);
  if (fill) {
    out.fill = fill;
    out.autoContrast = false;
  }
  out.emphasis = style.fauxBold ? "bold" : style.fauxItalic ? "italic" : "normal";
  if (style.leading && !style.autoLeading && fontSize) out.leading = Math.min(3, Math.max(1, Math.round((style.leading / fontSize) * 100) / 100));
  if (style.tracking) out.tracking = style.tracking;
  const align = text.paragraphStyle?.justification;
  if (align === "left" || align === "center" || align === "right") out.align = align;
  if (layer.fillOpacity !== undefined && layer.fillOpacity < 1) out.fillOpacity = Math.round(layer.fillOpacity * 100);
  const stroke = layer.effects?.stroke?.find((s) => s.enabled !== false);
  if (stroke?.size?.value) {
    out.outlineWidth = Math.round(((stroke.size.value * 72) / dpi) * 10) / 10;
    const outline = hex(stroke.color as { r: number; g: number; b: number } | undefined);
    if (outline) out.outline = outline;
    out.outlineOpacity = Math.round((stroke.opacity ?? 1) * 100);
  } else out.outlineWidth = 0;
  const effects = effectsFromPsd(layer.effects as Record<string, unknown> | undefined, dpi);
  if (effects) out.effects = effects;

  // Where the text sits: a path's curve, a text box's rectangle, or the type's own bounds.
  const path = layerPath(layer, txt2, page);
  let corners: { x: number; y: number }[];
  if (path) {
    const pad = (fontSize * scale) / Math.max(page.width, page.height);
    const xs = path.points.map((p) => p.x), ys = path.points.map((p) => p.y);
    const [x0, x1, y0, y1] = [Math.min(...xs) - pad, Math.max(...xs) + pad, Math.min(...ys) - pad * 1.5, Math.max(...ys) + pad];
    corners = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }].map((p) => ({ x: p.x * page.width, y: p.y * page.height }));
    delete out.rotation;
  } else if (text.shapeType === "box" && text.boxBounds?.length === 4) {
    const [l, t, r, bt] = text.boxBounds;
    corners = [toPage(l, t), toPage(r, t), toPage(r, bt), toPage(l, bt)];
  } else if (text.boundingBox) {
    const bb = text.boundingBox;
    const padX = (bb.right.value - bb.left.value) * 0.1 + fontSize * 0.2, padY = fontSize * 0.25;
    const [l, t, r, bt] = [bb.left.value - padX, bb.top.value - padY, bb.right.value + padX, bb.bottom.value + padY];
    corners = [toPage(l, t), toPage(r, t), toPage(r, bt), toPage(l, bt)];
  } else if (layer.right !== undefined && layer.bottom !== undefined) {
    corners = [
      { x: layer.left ?? 0, y: layer.top ?? 0 }, { x: layer.right, y: layer.top ?? 0 },
      { x: layer.right, y: layer.bottom }, { x: layer.left ?? 0, y: layer.bottom },
    ];
  } else {
    warnings.push(`${name}: the layer has no position, so it was skipped.`);
    return null;
  }
  const polygon = corners.map((p) => ({
    x: Math.min(1, Math.max(0, p.x / page.width)),
    y: Math.min(1, Math.max(0, p.y / page.height)),
  }));
  const xs = polygon.map((p) => p.x), ys = polygon.map((p) => p.y);
  const bounds = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  if (bounds.w < 1e-4 || bounds.h < 1e-4) {
    warnings.push(`${name}: the layer has no area on the page, so it was skipped.`);
    return null;
  }

  // Character runs that differ from the layer's first style become character styles.
  const runs: CharRun[] = [];
  let at = 0;
  for (const run of text.styleRuns ?? []) {
    const s = run.style;
    const char: CharStyle = {};
    const runFont = s.font?.name && s.font.name !== font ? fonts.find((x) => x.postscriptName === s.font!.name) : undefined;
    if (runFont) char.fontId = runFont.id;
    if (s.fontSize && fontSize && Math.abs(s.fontSize / fontSize - 1) > 0.01) char.size = Math.round((s.fontSize / fontSize) * 100);
    const runFill = hex(s.fillColor as { r: number; g: number; b: number } | undefined);
    if (runFill && runFill !== fill) char.fill = runFill;
    const emphasis = s.fauxBold ? "bold" : s.fauxItalic ? "italic" : "normal";
    if (emphasis !== out.emphasis) char.emphasis = emphasis;
    if (s.tracking && s.tracking !== style.tracking) char.tracking = s.tracking - (style.tracking ?? 0);
    if (s.baselineShift) char.baselineShift = Math.round(((s.baselineShift * scale * 72) / dpi) * 10) / 10;
    if (s.horizontalScale && Math.abs(s.horizontalScale - 1) > 0.01) char.horizontalScale = Math.round(s.horizontalScale * 100);
    if (s.verticalScale && Math.abs(s.verticalScale - 1) > 0.01) char.verticalScale = Math.round(s.verticalScale * 100);
    if (Object.keys(char).length) runs.push({ start: at, end: at + run.length, style: char });
    at += run.length;
  }
  const charRuns = normalizeCharRuns(runs, body.length);
  return {
    layer: name,
    body,
    bounds,
    polygon,
    style: out,
    ...(charRuns.length ? { charRuns } : {}),
    ...(path ? { textPaths: [{ points: path.points.slice(0, 64) }] } : {}),
    hidden: !!layer.hidden,
  };
}

/** Every text layer of `psd`, top level and in groups, in Photoshop's bottom-to-top order. */
export function psdTextLayers(psd: Psd): Layer[] {
  return (psd.children ?? []).flatMap(function flat(layer: Layer): Layer[] {
    return layer.children ? layer.children.flatMap(flat) : layer.text && layer.name !== META_LAYER ? [layer] : [];
  });
}

/**
 * Inserts the regions on `image` as "Imported" regions and fits their text. Returns the new
 * region ids; fitting failures (a missing font, say) are listed but keep the region.
 */
export async function createImportedRegions(
  series: Series,
  episode: Episode,
  userId: string,
  image: ImageRow,
  regions: NewRegion[],
) {
  if (!regions.length) return { ids: [] as string[], failed: [] as string[] };
  ensureImportedKind(series.id);
  const existing = await listLines(episode.id);
  let order = existing.length;
  const ids: string[] = [];
  sqlite.transaction(() => {
    for (const r of regions) {
      const id = nid();
      ids.push(id);
      sqlite
        .prepare(
          `INSERT INTO lines(id,episode_id,image_id,body,line_type,status,placed,x,y,w,h,sort_order,updated_at,updated_by,created_by,source,source_state)
           VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,'','unreadable')`,
        )
        .run(id, episode.id, image.id, r.body, IMPORTED_KIND.id, "none", r.bounds.x, r.bounds.y, r.bounds.w, r.bounds.h, order++, Date.now(), userId, userId);
      const data: RegionData = {
        polygon: r.polygon,
        geometryApproved: true,
        style: r.style,
        ...(r.charRuns ? { charRuns: r.charRuns, charRunsBody: r.body } : {}),
        ...(r.textPaths ? { textPaths: r.textPaths } : {}),
        ...(r.hidden ? { renderEnabled: false } : {}),
      };
      const doc = getDoc<RegionData>(`region:${id}`, {});
      putDoc(episode.id, doc.id, data, doc.revision);
    }
  })();
  const failed: string[] = [];
  for (const [k, id] of ids.entries()) {
    try {
      await fitRegion(series, episode, id, getDoc<RegionData>(`region:${id}`, {}).revision, { preserveStyle: true });
    } catch (e) {
      failed.push(`${regions[k].layer}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const line of (await listLines(episode.id)).filter((l) => ids.includes(l.id)))
    broadcast(episode.id, { type: "line:upsert", line });
  return { ids, failed };
}

/** Removes regions an import created (undoing it). */
export function deleteImportedRegions(episodeId: string, ids: string[]) {
  sqlite.transaction(() => {
    for (const id of ids) {
      sqlite.prepare("DELETE FROM lines WHERE id=? AND episode_id=?").run(id, episodeId);
      sqlite.prepare("DELETE FROM workflow_docs WHERE id=?").run(`region:${id}`);
    }
  })();
  for (const id of ids) broadcast(episodeId, { type: "line:delete", id });
}

// ── PSDs uploaded as pages ─────────────────────────────────────────────

const pixelsOf = (layer: { imageData?: { width: number; height: number; data: ArrayLike<number> } }) => {
  const px = layer.imageData;
  if (!px?.width || !px.height) return null;
  const data = px.data as Uint8ClampedArray;
  return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width: px.width, height: px.height, channels: 4 } });
};

/** Visible raster layers (not text) composited over white, as Photoshop stacks them. */
async function flatten(psd: Psd, layers: Layer[]) {
  const overlays: OverlayOptions[] = [];
  for (const layer of layers) {
    const img = pixelsOf(layer);
    if (!img) continue;
    let left = layer.left ?? 0, top = layer.top ?? 0;
    const w = layer.imageData!.width, h = layer.imageData!.height;
    const x0 = Math.max(0, -left), y0 = Math.max(0, -top);
    const x1 = Math.min(w, psd.width - left), y1 = Math.min(h, psd.height - top);
    if (x1 <= x0 || y1 <= y0) continue;
    const piece = x0 || y0 || x1 !== w || y1 !== h ? img.extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }) : img;
    left += x0;
    top += y0;
    overlays.push({ input: await piece.png().toBuffer(), left, top });
  }
  if (!overlays.length) return null;
  return sharp({ create: { width: psd.width, height: psd.height, channels: 4, background: "#ffffff" } })
    .composite(overlays)
    .flatten({ background: "#ffffff" })
    .png()
    .toBuffer();
}

function visibleLeaves(psd: Psd) {
  const out: Layer[] = [];
  const visit = (layers: Layer[] | undefined, hidden: boolean) => {
    for (const layer of layers ?? []) {
      const off = hidden || !!layer.hidden;
      if (layer.children) visit(layer.children, off);
      else if (!off) out.push(layer);
    }
  };
  visit(psd.children, false);
  return out;
}

/**
 * A PSD's parts as a page. A PSD exported from Komatose gives its "Original upload" layer as
 * the raw page (when it is page-sized; else "Prepared source") and "Cleaned artwork" with any
 * painted layers above it as the working image. Any other PSD is its whole visible image
 * as the raw page and, when it has text layers, the image without them as the working image.
 */
export async function psdPageParts(psd: Psd, composite: () => Promise<Buffer>) {
  const top = psd.children ?? [];
  const named = (name: string) => top.find((l) => l.name === name && !l.children);
  const pageSized = (l?: Layer) => !!l?.imageData && l.imageData.width === psd.width && l.imageData.height === psd.height && !(l.left ?? 0) && !(l.top ?? 0);
  const original = named("Original upload");
  const prepared = named("Prepared source");
  const cleaned = named("Cleaned artwork");
  const notes: string[] = [];
  let raw: Buffer;
  const rawLayer = pageSized(original) ? original : pageSized(prepared) ? prepared : undefined;
  if (original && !pageSized(original)) notes.push("The PSD's original upload is not the page's size, so its prepared source is the raw page.");
  if (rawLayer) raw = await pixelsOf(rawLayer)!.flatten({ background: "#ffffff" }).png().toBuffer();
  else raw = await composite();
  let artwork: Buffer | null = null;
  if (cleaned) {
    const stack = top.filter((l) => !l.children && !l.text);
    const from = stack.indexOf(cleaned);
    artwork = await flatten(psd, stack.slice(from).filter((l, i) => i === 0 || !l.hidden));
  } else if (psdTextLayers(psd).length) {
    artwork = await flatten(psd, visibleLeaves(psd).filter((l) => !l.text));
  }
  return { raw, artwork, notes };
}

/** Saves an uploaded PSD's working image on its new page (after the page is prepared). */
export function setUploadedArtwork(episodeId: string, imageId: string, artwork: string) {
  const doc = getDoc<PageData>(`page:${imageId}`, {});
  putDoc(episodeId, doc.id, { ...doc.data, cleanBase: artwork, cleaned: undefined, cleanMethod: "psd-import", cleanApproved: false }, doc.revision);
}

export function pageDpi(episodeId: string, seriesId: string, image: ImageRow) {
  return effectiveDpi(getDoc<PageData>(`page:${image.id}`, {}).data, image, preferences(episodeId, seriesId));
}

export { listFonts };
