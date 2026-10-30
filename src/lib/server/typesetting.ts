import * as fontkit from "fontkit";
import Hypher from "hypher";
import english from "hyphenation.en-us";
import type { LineRow, ImageRow } from "../types";
import {
  DEFAULT_STYLE,
  MIN_STYLE_SIZE,
  type TextStyle,
  type Point,
  type RegionData,
  type FittedLayout,
  type FontAsset,
  type CharStyle,
} from "../workflow";
import { glyphToPage, isTextWarpStyle, layoutWarpBox, textWarpMap, warpFontPath } from "../textWarp";
import { remapCharRuns } from "../charStyles";
import { activeEffects, effectFilters, effectsReach, normalizeEffects } from "../textEffects";
import { pathFrame, regionTextPaths } from "../textPath";
import { effectiveTextRotation } from "../textRotation";
import { sqlite } from "./db";
import { readAsset, storeAsset, hash, WorkflowError } from "./workflowStore";
import { unlinkAssetFiles, unreferencedAssets } from "./exportRetention";
import { isFontCategory, normalizeFontCategory } from "../fontCategories";
export {
  MAX_SKEW,
  type Matrix2,
  mulMatrix,
  textMatrix,
  inverseTextMatrix,
  applyMatrixAbout,
  textTransformSvg,
} from "../textTransform";
import {
  MAX_SKEW,
  inverseTextMatrix,
  applyMatrixAbout,
  textTransformSvg,
} from "../textTransform";

const hypher = new Hypher(english);
const fontCache = new Map<string, fontkit.Font>();
export async function loadFont(id: string) {
  const row = sqlite
    .prepare(
      "SELECT hash,metadata FROM font_assets WHERE id=? UNION ALL SELECT hash,metadata FROM global_font_assets WHERE id=?",
    )
    .get(id, id) as { hash: string; metadata: string } | undefined;
  if (!row)
    throw new WorkflowError("Upload and select the referenced font", 422);
  let font = fontCache.get(row.hash);
  if (!font) {
    font = fontkit.create(await readAsset(row.hash)) as fontkit.Font;
    if (!("layout" in font))
      throw new WorkflowError("Font collections are unsupported");
    if (fontCache.size > 32) fontCache.clear();
    fontCache.set(row.hash, font);
  }
  return {
    font,
    metadata: { ...JSON.parse(row.metadata), id, hash: row.hash } as FontAsset,
  };
}
export async function uploadFont(
  seriesId: string | null,
  filename: string,
  bytes: Buffer,
  category?: unknown,
) {
  if (!/\.(ttf|otf)$/i.test(filename) || bytes.length > 30 * 1024 * 1024)
    throw new WorkflowError("Choose a TTF or OTF font up to 30 MB");
  const signature = bytes.subarray(0, 4).toString("hex");
  if (!["00010000", "4f54544f", "74727565"].includes(signature))
    throw new WorkflowError("The file is not a TTF or OTF font");
  const f = fontkit.create(bytes) as fontkit.Font;
  if (!f.postscriptName || !f.layout)
    throw new WorkflowError("A font with a PostScript name is required");
  const digest = await storeAsset(bytes);
  const metadata = {
    familyName: f.familyName,
    subfamilyName: f.subfamilyName,
    postscriptName: f.postscriptName,
    format: /otf$/i.test(filename) ? "OTF" : "TTF",
    category: normalizeFontCategory(category),
  };
  const id = hash(`${seriesId}:${digest}`);
  const table = seriesId === null ? "global_font_assets" : "font_assets";
  const duplicate = !!sqlite
    .prepare(`SELECT 1 FROM ${table} WHERE id=?`)
    .get(id);
  if (seriesId === null)
    sqlite
      .prepare("INSERT OR IGNORE INTO global_font_assets VALUES(?,?,?,?,?)")
      .run(id, digest, filename, JSON.stringify(metadata), Date.now());
  else
    sqlite
      .prepare("INSERT OR IGNORE INTO font_assets VALUES(?,?,?,?,?,?)")
      .run(
        id,
        seriesId,
        digest,
        filename,
        JSON.stringify(metadata),
        Date.now(),
      );
  return { font: { ...metadata, id, hash: digest, filename }, duplicate };
}
export function listFonts(seriesId: string | null): FontAsset[] {
  return (
    sqlite
      .prepare(
        "SELECT id,hash,filename,metadata,created_at,0 AS shared FROM font_assets WHERE series_id=? UNION ALL SELECT id,hash,filename,metadata,created_at,1 AS shared FROM global_font_assets ORDER BY created_at",
      )
      .all(seriesId) as {
      id: string;
      hash: string;
      filename: string;
      metadata: string;
      shared: number;
    }[]
  ).map((r) => {
    const meta = JSON.parse(r.metadata);
    return {
      ...meta,
      category: normalizeFontCategory(meta.category),
      id: r.id,
      hash: r.hash,
      filename: r.filename,
      shared: !!r.shared,
    };
  });
}

/** Font rows live in one of two tables; a series font is only ever touched through its own series. */
const fontTable = (seriesId: string | null) =>
  seriesId === null ? "global_font_assets" : "font_assets";

function ownFontRow(seriesId: string | null, id: string) {
  const row = (
    seriesId === null
      ? sqlite.prepare("SELECT id,hash,filename,metadata FROM global_font_assets WHERE id=?").get(id)
      : sqlite
          .prepare("SELECT id,hash,filename,metadata FROM font_assets WHERE id=? AND series_id=?")
          .get(id, seriesId)
  ) as { id: string; hash: string; filename: string; metadata: string } | undefined;
  if (!row) throw new WorkflowError("Font not found", 404);
  return row;
}

/** Files the given fonts under a category. Unknown categories are rejected rather than filed as "other". */
export function setFontCategory(
  seriesId: string | null,
  ids: string[],
  category: unknown,
) {
  if (!isFontCategory(category)) throw new WorkflowError("Choose a valid font category");
  if (!ids.length) throw new WorkflowError("Choose at least one font");
  const table = fontTable(seriesId);
  const update = sqlite.prepare(`UPDATE ${table} SET metadata=? WHERE id=?`);
  sqlite.transaction(() => {
    for (const id of new Set(ids)) {
      const row = ownFontRow(seriesId, id);
      update.run(JSON.stringify({ ...JSON.parse(row.metadata), category }), id);
    }
  })();
  return listFonts(seriesId);
}

/** Workflow documents (series defaults, chapter and region styles) that still point at a font. */
export function fontUsage(id: string) {
  const rows = sqlite
    .prepare("SELECT id FROM workflow_docs WHERE instr(data,?)>0")
    .all(id) as { id: string }[];
  const byKind: Record<string, number> = {};
  for (const { id: docId } of rows) {
    const kind = docId.split(":")[0];
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  return { total: rows.length, byKind };
}

/**
 * Removes a font and frees its file when nothing else uses the bytes. A font still chosen by a
 * style is refused unless `force` is set, which clears that choice so the style falls back to
 * "no font selected" (typesetting then asks for one) instead of pointing at a missing face.
 */
export function deleteFont(seriesId: string | null, id: string, force = false) {
  const row = ownFontRow(seriesId, id);
  const usage = fontUsage(id);
  if (usage.total && !force) {
    const parts = Object.entries(usage.byKind).map(([k, n]) => `${n} ${k}`);
    throw new WorkflowError(
      `This font is used by ${usage.total} style setting${usage.total === 1 ? "" : "s"} (${parts.join(", ")})`,
      409,
      { usage },
    );
  }
  sqlite.transaction(() => {
    if (usage.total)
      sqlite
        .prepare(
          `UPDATE workflow_docs SET data=replace(data,?,?), revision=revision+1, updated_at=?
           WHERE instr(data,?)>0`,
        )
        .run(`"fontId":"${id}"`, `"fontId":""`, Date.now(), id);
    sqlite.prepare(`DELETE FROM ${fontTable(seriesId)} WHERE id=?`).run(id);
  })();
  fontCache.delete(row.hash);
  unlinkAssetFiles(unreferencedAssets(sqlite, [row.hash]));
  return { removed: id, cleared: usage.total };
}

/** Every character a font maps, plus what the inspector shows about the file. */
export async function fontGlyphs(seriesId: string | null, id: string) {
  // A series sees its own fonts and the shared ones; a shared lookup only sees shared fonts.
  const known = listFonts(seriesId).find((f) => f.id === id);
  if (!known) throw new WorkflowError("Font not found", 404);
  const bytes = await readAsset(known.hash);
  const font = fontkit.create(bytes) as fontkit.Font;
  if (!("layout" in font)) throw new WorkflowError("Font collections are unsupported");
  const info = font as unknown as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const number = (value: unknown) => (typeof value === "number" ? value : null);
  const codepoints = [...(font.characterSet ?? [])].sort((a, b) => a - b);
  return {
    font: known,
    codepoints,
    info: {
      glyphCount: number(info.numGlyphs) ?? codepoints.length,
      unitsPerEm: number(info.unitsPerEm),
      version: text(info.version),
      copyright: text(info.copyright),
      license: text(info.license),
      fileSize: bytes.length,
    },
  };
}
export function validateStyle(input: Partial<TextStyle> | undefined): TextStyle {
  const s = { ...DEFAULT_STYLE, ...input };
  for (const [key, min, max] of [
    ["size", MIN_STYLE_SIZE, 300],
    ["minSize", MIN_STYLE_SIZE, 300],
    ["leading", 1, 3],
    ["padding", 0, 100],
    ["outlineWidth", 0, 20],
    ["fillOpacity", 0, 100],
    ["outlineOpacity", 0, 100],
    ["rotation", -180, 180],
    ["skewX", -MAX_SKEW, MAX_SKEW],
    ["skewY", -MAX_SKEW, MAX_SKEW],
    ["warpBend", -100, 100],
    ["warpHorizontal", -100, 100],
    ["warpVertical", -100, 100],
    ["tracking", -500, 2000],
  ] as const) {
    const n = Number(s[key]);
    s[key] = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : DEFAULT_STYLE[key]!;
  }
  if (s.warpOrientation !== "vertical") s.warpOrientation = "horizontal";
  const effects = normalizeEffects(s.effects);
  if (effects) s.effects = effects;
  else delete s.effects;
  s.autoContrast = s.autoContrast !== false;
  if (s.minSize > s.size) s.minSize = s.size;
  s.fillOpacity = Math.round(s.fillOpacity);
  s.outlineOpacity = Math.round(s.outlineOpacity);
  if (!/^#[a-f\d]{6}$/i.test(s.fill)) s.fill = DEFAULT_STYLE.fill;
  if (!/^#[a-f\d]{6}$/i.test(s.outline)) s.outline = DEFAULT_STYLE.outline;
  if (!["left", "center", "right"].includes(s.align)) s.align = DEFAULT_STYLE.align;
  if (!["normal", "bold", "italic"].includes(s.emphasis)) s.emphasis = DEFAULT_STYLE.emphasis;
  if (!isTextWarpStyle(s.warpStyle)) s.warpStyle = DEFAULT_STYLE.warpStyle;
  if (typeof s.fontId !== "string") s.fontId = "";
  return s;
}
export function effectiveLayoutStyle(region: RegionData, style: TextStyle): TextStyle {
  return { ...style, rotation: effectiveTextRotation(region.geometryRotation, style.rotation) };
}
export function regionPolygon(
  line: LineRow,
  region: RegionData,
  page: ImageRow,
): Point[] {
  const x = line.x ?? 0,
    y = line.y ?? 0,
    w = line.w ?? 0.2,
    h = line.h ?? 0.1;
  return (
    region.polygon?.length
      ? region.polygon
      : [
          { x, y },
          { x: x + w, y },
          { x: x + w, y: y + h },
          { x, y: y + h },
        ]
  ).map((p) => ({ x: p.x * page.width, y: p.y * page.height }));
}
/** Intersection of scanline intervals over the entire glyph height, including every polygon vertex. */
export function availableSpan(
  poly: Point[],
  top: number,
  bottom: number,
  padding: number,
): [number, number] | null {
  const samples = [
    top,
    bottom,
    ...poly
      .filter((p) => p.y > top && p.y < bottom)
      .flatMap((p) => [p.y - 0.001, p.y + 0.001]),
  ];
  let intervals: [number, number][] = [[-Infinity, Infinity]];
  for (const y of samples) {
    const xs: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i],
        b = poly[(i + 1) % poly.length];
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y))
        xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    xs.sort((a, b) => a - b);
    const next: [number, number][] = [];
    for (let i = 0; i + 1 < xs.length; i += 2)
      for (const old of intervals) {
        const l = Math.max(old[0], xs[i] + padding),
          r = Math.min(old[1], xs[i + 1] - padding);
        if (r > l) next.push([l, r]);
      }
    intervals = next;
  }
  return intervals.sort((a, b) => b[1] - b[0] - (a[1] - a[0]))[0] ?? null;
}
export function layoutKey(
  line: LineRow,
  region: RegionData,
  page: ImageRow,
  style: TextStyle,
  dpi: number,
) {
  const s: Partial<TextStyle> = validateStyle(style);
  // Fields added after layouts were first keyed only count once they leave their defaults,
  // so existing layouts stay current.
  for (const key of ["warpHorizontal", "warpVertical", "tracking", "warpOrientation"] as const)
    if (s[key] === DEFAULT_STYLE[key]) delete s[key];
  return hash(
    JSON.stringify({
      body: line.body,
      x: line.x,
      y: line.y,
      w: line.w,
      h: line.h,
      poly: region.polygon,
      style: s,
      ...(region.charRuns?.length ? { charRuns: region.charRuns, charRunsBody: region.charRunsBody } : {}),
      ...(regionTextPaths(region).length ? { textPaths: regionTextPaths(region) } : {}),
      dpi,
      width: page.width,
      height: page.height,
      outlineFormat: 3,
      // Layouts skewed before horizontal skew stopped affecting the fit are stale.
      ...(s.skewX ? { skewFormat: "layer" } : {}),
    }),
  );
}
/** `gap` is the whitespace before the word, kept when both words land on the same row. */
type Token = {
  text: string;
  gap?: string;
  alone?: boolean;
  breakBefore?: boolean;
  /** `text` and `gap` with the body index of each character, for character styles. */
  chars?: { text: string; src: number[] };
  gapChars?: { text: string; src: number[] };
};
export function dictionaryFragments(
  word: string,
  width: number,
  measure: (s: string) => number,
): string[] | null {
  const parts = hypher.hyphenate(word);
  if (parts.length < 2) return null;
  const out: string[] = [];
  let current = "";
  for (let i = 0; i < parts.length; i++) {
    const suffix = i < parts.length - 1 ? "-" : "";
    if (measure(current + parts[i] + suffix) <= width) {
      current += parts[i];
      continue;
    }
    if (!current || measure(current + "-") > width) return null;
    out.push(current + "-");
    current = parts[i];
    if (measure(current + suffix) > width) return null;
  }
  if (current) out.push(current);
  return out;
}
/** One resolved character style of a layout: its font and every paint and spacing value. */
type LayoutStyle = {
  font: fontkit.Font;
  metadata: FontAsset;
  char: CharStyle;
  factor: number;
  fill: string;
  fillOpacity: number;
  outline: string;
  outlineOpacity: number;
  outlineWidth: number;
  emphasis: TextStyle["emphasis"];
  /** Thousandths of an em after each character. */
  tracking: number;
  /** Points. */
  baselineShift: number;
  hs: number;
  vs: number;
};
/** Text with the source body index of each of its characters (hyphens and expanded tabs repeat one). */
type Chars = { text: string; src: number[] };
const joinChars = (...parts: Chars[]): Chars => ({
  text: parts.map((p) => p.text).join(""),
  src: parts.flatMap((p) => p.src),
});

export async function fitText(
  line: LineRow,
  region: RegionData,
  page: ImageRow,
  input: Partial<TextStyle>,
  dpi: number,
): Promise<FittedLayout> {
  const style = effectiveLayoutStyle(region, validateStyle(input));
  if (!Number.isFinite(dpi) || dpi < 10 || dpi > 2400)
    throw new WorkflowError("DPI must be between 10 and 2400");
  if (line.body.length > 12000)
    throw new WorkflowError("Region text is too long to fit");
  const body = line.body.replace(/\r\n?/g, "\n");
  const runs = remapCharRuns(region.charRuns, region.charRunsBody?.replace(/\r\n?/g, "\n"), body);
  const base = await loadFont(style.fontId);
  const { font, metadata } = base;

  // ── Character styles ────────────────────────────────────────────────
  const styles: LayoutStyle[] = [];
  const styleKeys = new Map<string, number>();
  const resolve = async (char: CharStyle) => {
    const key = JSON.stringify(char);
    if (styleKeys.has(key)) return styleKeys.get(key)!;
    // A character font removed since it was chosen falls back to the region's font.
    const f = char.fontId && char.fontId !== style.fontId ? await loadFont(char.fontId).catch(() => base) : base;
    styles.push({
      font: f.font,
      metadata: f.metadata,
      char,
      factor: (char.size ?? 100) / 100,
      fill: char.fill ?? style.fill,
      fillOpacity: char.fillOpacity ?? style.fillOpacity,
      outline: char.outline ?? style.outline,
      outlineOpacity: char.outlineOpacity ?? style.outlineOpacity,
      outlineWidth: char.outlineWidth ?? style.outlineWidth,
      emphasis: char.emphasis ?? style.emphasis,
      tracking: (style.tracking ?? 0) + (char.tracking ?? 0),
      baselineShift: char.baselineShift ?? 0,
      hs: (char.horizontalScale ?? 100) / 100,
      vs: (char.verticalScale ?? 100) / 100,
    });
    styleKeys.set(key, styles.length - 1);
    return styles.length - 1;
  };
  await resolve({});
  const charStyle = new Array<number>(body.length).fill(0);
  for (const run of runs) {
    const idx = await resolve(run.style);
    for (let i = run.start; i < run.end; i++) charStyle[i] = idx;
  }
  const styleOf = (src: number) => (src >= 0 && src < charStyle.length ? charStyle[src] : 0);
  const used = [...new Set(charStyle.filter((_, i) => !/\s/.test(body[i])))];
  if (!used.length) used.push(0);

  const missing = new Set<string>();
  for (let i = 0; i < body.length; i++) {
    const cp = body.codePointAt(i)!;
    const c = String.fromCodePoint(cp);
    if (!/\s/.test(c) && !styles[styleOf(i)].font.hasGlyphForCodePoint(cp)) missing.add(c);
    if (cp > 0xffff) i++;
  }
  const missingGlyphs = [...missing];

  let poly = regionPolygon(line, region, page);
  const cx =
    (Math.min(...poly.map((p) => p.x)) + Math.max(...poly.map((p) => p.x))) / 2;
  const cy =
    (Math.min(...poly.map((p) => p.y)) + Math.max(...poly.map((p) => p.y))) / 2;
  // Wrap in un-rotated text space; the SVG re-applies the whole-layer transform about the same
  // centre, exactly as the PSD text layer's matrix does. Like a Photoshop paragraph, lines are
  // laid out before horizontal skew, so skew slants their common centre line with the glyphs
  // and never changes breaks or positions.
  const inverse = inverseTextMatrix({ ...style, skewX: 0 });
  const centre = { x: cx, y: cy };
  poly = poly.map((p) => applyMatrixAbout(inverse, p, centre));
  const minY = Math.min(...poly.map((p) => p.y)),
    maxY = Math.max(...poly.map((p) => p.y));
  const px = dpi / 72,
    padding = (style.padding + style.outlineWidth) * px;

  /** Chars cut into pieces of one style each. */
  const pieces = (c: Chars) => {
    const out: { text: string; style: number; src: number[] }[] = [];
    for (let i = 0; i < c.text.length; i++) {
      const st = styleOf(c.src[i]);
      const last = out.at(-1);
      if (last && last.style === st) {
        last.text += c.text[i];
        last.src.push(c.src[i]);
      } else out.push({ text: c.text[i], style: st, src: [c.src[i]] });
    }
    return out;
  };
  const unitWidths = new Map<string, number>();
  const unitWidth = (text: string, st: number) => {
    const key = `${st}\u0000${text}`;
    if (!unitWidths.has(key)) {
      const r = styles[st].font.layout(text);
      unitWidths.set(key, r.positions.reduce((sum, p) => sum + p.xAdvance, 0));
    }
    return unitWidths.get(key)!;
  };
  const measure = (c: Chars, size: number) => {
    const parts = pieces(c);
    let width = 0;
    for (const part of parts) {
      const st = styles[part.style];
      const em = size * st.factor * px;
      width += (unitWidth(part.text, part.style) * em * st.hs) / st.font.unitsPerEm;
      width += (st.tracking / 1000) * em * [...part.text].length;
    }
    const last = styles[parts.at(-1)?.style ?? 0];
    const em = size * last.factor * px;
    return width + (last.emphasis === "italic" ? em * 0.22 : 0) + (last.emphasis === "bold" ? em * 0.04 : 0);
  };
  /** Ascent and descent in pixels per point of size, over every style the text uses. */
  const ascentPerPt = Math.max(...used.map((i) => (styles[i].font.ascent / styles[i].font.unitsPerEm) * styles[i].factor * styles[i].vs * px + Math.max(0, styles[i].baselineShift) / (style.size || 1) * px));
  const descentPerPt = Math.max(...used.map((i) => (-styles[i].font.descent / styles[i].font.unitsPerEm) * styles[i].factor * styles[i].vs * px + Math.max(0, -styles[i].baselineShift) / (style.size || 1) * px));

  // ── Tokens ──────────────────────────────────────────────────────────
  let hyphenated = false;
  const tokens: Token[] = [];
  const minHeight = (ascentPerPt + descentPerPt) * style.minSize;
  let maxWidthAtMin = 0;
  for (
    let y = minY + padding + 0.01;
    y + minHeight < maxY - padding;
    y += Math.max(1, minHeight / 8)
  ) {
    const span = availableSpan(poly, y, y + minHeight, padding);
    if (span) maxWidthAtMin = Math.max(maxWidthAtMin, span[1] - span[0]);
  }
  const expand = (gap: string, at: number): Chars => {
    const out: Chars = { text: "", src: [] };
    for (let k = 0; k < gap.length; k++) {
      const n = gap[k] === "\t" ? 4 : 1;
      out.text += " ".repeat(n);
      for (let j = 0; j < n; j++) out.src.push(at + k);
    }
    return out;
  };
  const textPaths = regionTextPaths(region);
  const onPath = textPaths.length > 0;
  let offset = 0;
  for (const [i, paragraph] of body.split("\n").entries()) {
    // Keep runs of spaces between words, and before a paragraph's first word so spaces can
    // nudge a line sideways; only wrapped line breaks swallow them.
    const words = [...paragraph.trimEnd().matchAll(/(\s*)(\S+)/g)].map((m, w) => {
      const gapAt = offset + m.index!;
      const wordAt = gapAt + m[1].length;
      const spaces = expand(m[1], gapAt);
      const word = { text: m[2], src: Array.from({ length: m[2].length }, (_, k) => wordAt + k) };
      return w === 0 ? { word: joinChars(spaces, word), gap: { text: "", src: [] } } : { word, gap: spaces };
    });
    if (!words.length) words.push({ word: { text: "", src: [] }, gap: { text: "", src: [] } });
    for (const [w, { word, gap }] of words.entries()) {
      // Fragments are measured in the word's opening style; each keeps its own characters'.
      const parts =
        !onPath && measure(word, style.minSize) > maxWidthAtMin && maxWidthAtMin > 0
          ? dictionaryFragments(word.text, maxWidthAtMin, (t) =>
              measure({ text: t, src: new Array<number>(t.length).fill(word.src[0] ?? 0) }, style.minSize),
            )
          : null;
      if (parts) {
        hyphenated = true;
        let at = 0;
        for (const [k, part] of parts.entries()) {
          const plain = k < parts.length - 1 ? part.slice(0, -1) : part;
          const src = word.src.slice(at, at + plain.length);
          const chars = plain === part ? { text: part, src } : { text: part, src: [...src, src.at(-1) ?? 0] };
          tokens.push({ text: chars.text, chars, gap: gap.text, gapChars: gap, alone: true, breakBefore: true });
          at += plain.length;
        }
      } else
        tokens.push({
          text: word.text,
          chars: word,
          gap: gap.text,
          gapChars: gap,
          breakBefore: i > 0 && w === 0,
          alone: !word.text,
        });
    }
    offset += paragraph.length + 1;
  }
  const gapOf = (t: Token, prev: Token): Chars =>
    t.gapChars?.text ? t.gapChars : { text: " ", src: [prev.chars!.src.at(-1) ?? t.chars!.src[0] ?? 0] };

  let rows: { chars: Chars; width: number; x: number; baseline: number; path?: number }[] = [];
  let chosen = style.minSize;
  let found = false;
  const sizes: number[] = [];
  for (let s = style.size; s > style.minSize; s -= 0.25) sizes.push(s);
  sizes.push(style.minSize);
  const frames = textPaths.map((p) => pathFrame(p.points.map((q) => ({ x: q.x * page.width, y: q.y * page.height })), !!p.flip));
  if (onPath) {
    // Type on paths: the words fill each path in turn, like lines of a paragraph, at one size
    // shrunk until every word has a place. A new paragraph starts a new path, and an empty one
    // leaves its path blank, so text can skip a ruled line.
    const place = (size: number) => {
      const out: typeof rows = [];
      let at = 0;
      let fits = true;
      for (const [pi, frame] of frames.entries()) {
        if (at >= tokens.length) break;
        if (!frame) continue;
        const start = (textPaths[pi].offset ?? 0) * frame.length;
        const available = Math.max(0, frame.length - start);
        let chars: Chars | null = null;
        while (at < tokens.length) {
          const t = tokens[at];
          if (!t.text) {
            if (!chars && t.breakBefore) at++;
            if (!chars && !t.breakBefore) { at++; continue; }
            break;
          }
          if (chars && t.breakBefore) break;
          const next: Chars = chars ? joinChars(chars, gapOf(t, tokens[at - 1]), t.chars!) : t.chars!;
          if (chars && measure(next, size) > available) break;
          chars = next;
          at++;
        }
        if (!chars) continue;
        const width = measure(chars, size);
        if (width > available) fits = false;
        const x = width > available || style.align === "left" ? start : style.align === "right" ? start + available - width : start + (available - width) / 2;
        out.push({ chars, width, x, baseline: 0, path: pi });
      }
      if (at < tokens.length) {
        fits = false;
        // What did not fit runs on past the end of the last path (hidden there; whole in the PSD).
        const rest = tokens.slice(at).filter((t) => t.text);
        const lastPath = frames.length - 1;
        let last = out.at(-1)?.path === lastPath ? out.pop() : undefined;
        let chars = last?.chars ?? null;
        for (const t of rest) chars = chars ? joinChars(chars, { text: " ", src: [t.chars!.src[0] ?? 0] }, t.chars!) : t.chars!;
        const start = (textPaths[lastPath]?.offset ?? 0) * (frames[lastPath]?.length ?? 0);
        if (chars && frames[lastPath]) out.push({ chars, width: measure(chars, size), x: last?.x ?? start, baseline: 0, path: lastPath });
      }
      return { rows: out, fits };
    };
    for (const size of sizes) {
      const fit = place(size);
      chosen = size;
      rows = fit.rows;
      if (fit.fits) { found = true; break; }
    }
  } else
  for (const size of sizes) {
    const glyphHeight = (ascentPerPt + descentPerPt) * size;
    const lineHeight = Math.max(glyphHeight, size * px * style.leading);
    const maxLines = Math.min(
      tokens.length,
      150,
      Math.floor(
        (maxY - minY - padding * 2 + lineHeight - glyphHeight) / lineHeight,
      ),
    );
    type Fit = { cost: number; rows: typeof rows };
    let best: Fit | null = null;
    for (let count = 1; count <= maxLines; count++) {
      const top = cy - ((count - 1) * lineHeight + glyphHeight) / 2;
      if (
        top < minY + padding ||
        top + (count - 1) * lineHeight + glyphHeight >= maxY - padding
      )
        continue;
      const spans = Array.from({ length: count }, (_, i) =>
        availableSpan(
          poly,
          top + i * lineHeight,
          top + i * lineHeight + glyphHeight,
          padding,
        ),
      );
      if (spans.some((s) => !s)) continue;
      const memo = new Map<string, Fit | null>();
      const solve = (at: number, row: number): Fit | null => {
        if (row === count)
          return at === tokens.length ? { cost: 0, rows: [] } : null;
        if (at >= tokens.length) return null;
        const key = `${at}:${row}`;
        if (memo.has(key)) return memo.get(key)!;
        const [left, right] = spans[row]!;
        const width = right - left;
        let winner: Fit | null = null;
        let chars: Chars = { text: "", src: [] };
        for (let end = at; end < tokens.length; end++) {
          if (
            end > at &&
            (tokens[end].breakBefore || tokens[end].alone || tokens[at].alone)
          )
            break;
          chars = end > at ? joinChars(chars, gapOf(tokens[end], tokens[end - 1]), tokens[end].chars!) : tokens[end].chars!;
          const actual = measure(chars, size);
          if (actual > width) break;
          const tail = solve(end + 1, row + 1);
          if (!tail) continue;
          const cost = tail.cost + ((width - actual) / width) ** 2;
          if (!winner || cost < winner.cost)
            winner = {
              cost,
              rows: [
                {
                  chars,
                  width: actual,
                  x:
                    style.align === "left"
                      ? left
                      : style.align === "right"
                        ? right - actual
                        : (left + right - actual) / 2,
                  baseline: top + row * lineHeight + ascentPerPt * size,
                },
                ...tail.rows,
              ],
            };
        }
        memo.set(key, winner);
        return winner;
      };
      const fit = solve(0, 0);
      if (fit && (!best || fit.cost < best.cost)) best = fit;
    }
    if (best) {
      rows = best.rows;
      chosen = size;
      found = true;
      break;
    }
  }

  // ── Glyphs ──────────────────────────────────────────────────────────
  const fittedRows: FittedLayout["rows"] = rows.map((r) => ({
    text: r.chars.text,
    width: r.width,
    x: r.x,
    baseline: r.baseline,
    ...(r.path !== undefined ? { path: r.path } : {}),
  }));
  const box = onPath ? undefined : layoutWarpBox(fittedRows, chosen * px);
  const warp = box ? textWarpMap(box, style) : undefined;
  type Glyph = { d?: string; transform?: string; style: number; unit: number; row: number };
  const glyphs: Glyph[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    const frame = row.path !== undefined ? frames[row.path] : undefined;
    let x = row.x;
    for (const part of pieces(row.chars)) {
      const st = styles[part.style];
      const em = chosen * st.factor * px;
      const scale = em / st.font.unitsPerEm;
      const italic = st.emphasis === "italic";
      const shift = st.baselineShift * px * (chosen / (style.size || chosen));
      const run = st.font.layout(part.text);
      const track = (st.tracking / 1000) * em;
      for (let i = 0; i < run.glyphs.length; i++) {
        const p = run.positions[i];
        const advance = p.xAdvance * scale * st.hs + track;
        const commands = run.glyphs[i].path.commands;
        if (frame) {
          const placed = frame.frame(x + (p.xAdvance * scale * st.hs) / 2);
          if (placed) {
            // Glyph-local origin sits half an advance before the point on the path.
            const ox = -(p.xAdvance * scale * st.hs) / 2 + p.xOffset * scale * st.hs;
            const oy = -p.yOffset * scale * st.vs - shift;
            glyphs.push({
              transform: `matrix(${placed.join(" ")}) translate(${ox} ${oy}) scale(${scale * st.hs} ${-scale * st.vs})${italic ? " skewX(12)" : ""}`,
              d: run.glyphs[i].path.toSVG(),
              style: part.style,
              unit: scale * Math.sqrt(st.hs * st.vs),
              row: rowIndex,
            });
          }
        } else {
          const originX = x + p.xOffset * scale * st.hs;
          const originY = row.baseline - p.yOffset * scale * st.vs - shift;
          if (warp) {
            const d = warpFontPath(commands, glyphToPage(originX, originY, scale, italic, st.hs, st.vs), warp);
            if (d) glyphs.push({ d, style: part.style, unit: 1, row: rowIndex });
          } else
            glyphs.push({
              d: run.glyphs[i].path.toSVG(),
              transform: `translate(${originX} ${originY}) scale(${scale * st.hs} ${-scale * st.vs})${italic ? " skewX(12)" : ""}`,
              style: part.style,
              unit: scale * Math.sqrt(st.hs * st.vs),
              row: rowIndex,
            });
        }
        x += advance;
      }
    }
  }
  const paint = (opacity: number) => {
    const value = Math.round(opacity) / 100;
    return ` fill-opacity="${value}" stroke-opacity="${value}"`;
  };
  const num = (n: number) => String(Math.round(n * 1e4) / 1e4);
  /** Consecutive glyphs of one style share a group; each path carries its own stroke width. */
  const pass = (outline: boolean, row?: number) => {
    let out = "";
    let open = -1;
    for (const g of glyphs) {
      if (row !== undefined && g.row !== row) continue;
      const st = styles[g.style];
      if (outline && !st.outlineWidth) continue;
      if (g.style !== open) {
        if (open >= 0) out += "</g>";
        const color = outline ? st.outline : st.fill;
        out += `<g fill="${color}" stroke="${color}"${paint(outline ? st.outlineOpacity : st.fillOpacity)} stroke-linejoin="round">`;
        open = g.style;
      }
      const em = chosen * st.factor * px;
      const bold = st.emphasis === "bold" ? em * 0.035 : 0;
      const width = (outline ? st.outlineWidth * px * 2 + bold : bold) / g.unit;
      out += `<path d="${g.d}"${g.transform ? ` transform="${g.transform}"` : ""} stroke-width="${num(width)}"/>`;
    }
    return open >= 0 ? out + "</g>" : out;
  };
  // Path rows are marked so PSD export can give each path its own layer pixels, and the
  // outline and layer effects are marked so a PSD layer can hold the glyphs alone (Photoshop
  // draws its stroke and effects itself).
  const byRow = (outline: boolean) =>
    onPath ? rows.map((_, k) => `<!--row:${k}-->${pass(outline, k)}<!--/row:${k}-->`).join("") : pass(outline);
  const wrap = (content: string) => (onPath ? `<g>${content}</g>` : `<g transform="${textTransformSvg(style, cx, cy)}">${content}</g>`);
  const outlinePart = byRow(true), fillPart = byRow(false);
  const effects = activeEffects(style.effects);
  let drawn: string;
  if (Object.keys(effects).length) {
    // Effects work in page space, so a shadow's angle stays put when the text rotates.
    const pagePoly = onPath
      ? frames.flatMap((fr) => (fr ? [fr.at(0), fr.at(fr.length / 2), fr.at(fr.length)] : []))
      : regionPolygon(line, region, page);
    const xs = pagePoly.map((p) => p.x), ys = pagePoly.map((p) => p.y);
    const glyphPad = chosen * px * 1.5 + style.outlineWidth * px;
    const bounds = { x: Math.min(...xs) - glyphPad / 2, y: Math.min(...ys) - glyphPad / 2, width: Math.max(...xs) - Math.min(...xs) + glyphPad, height: Math.max(...ys) - Math.min(...ys) + glyphPad };
    const reach = effectsReach(effects) * px + glyphPad;
    const rect = { x: bounds.x - reach, y: bounds.y - reach, width: bounds.width + reach * 2, height: bounds.height + reach * 2 };
    const fx = effectFilters(effects, px, rect, bounds);
    drawn =
      `<defs>${fx.defs}<g id="tx-o">${wrap(outlinePart)}</g><g id="tx-f">${wrap(fillPart)}</g></defs>` +
      (fx.exterior ? `<!--fx--><g filter="url(#fx-ext)"><use href="#tx-o"/><use href="#tx-f"/></g><!--/fx-->` : "") +
      `<!--outline--><use href="#tx-o"/><!--/outline-->` +
      `<g${fx.interior ? ` filter="url(#fx-int)"` : ""}><use href="#tx-f"/>${fx.overlay ? `<!--fx-->${fx.overlay}<!--/fx-->` : ""}</g>`;
  } else drawn = `<!--outline-->${wrap(outlinePart)}<!--/outline-->${wrap(fillPart)}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}" height="${page.height}" viewBox="0 0 ${page.width} ${page.height}">${drawn}</svg>`;

  const multi = styles.length > 1 && rows.some((r) => pieces(r.chars).some((p) => p.style !== 0));
  if (multi)
    rows.forEach((r, i) => {
      fittedRows[i].pieces = pieces(r.chars).map((p) => ({ text: p.text, style: p.style }));
    });
  return {
    key: layoutKey(line, region, page, style, dpi),
    rows: fittedRows,
    size: chosen,
    dpi,
    width: page.width,
    height: page.height,
    svg,
    overflow: !found,
    missingGlyphs,
    hyphenated,
    style,
    font: {
      id: metadata.id,
      hash: metadata.hash,
      postscriptName: metadata.postscriptName,
    },
    ...(multi ? { charStyles: styles.map((st) => ({ ...st.char, postscriptName: st.metadata.postscriptName })) } : {}),
    ...(onPath ? { onPath: true } : {}),
  };
}
