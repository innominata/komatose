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
} from "../workflow";
import { hasTextWarp, isTextWarpStyle, layoutWarpBox, warpFontPath } from "../textWarp";
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
    ["rotation", -180, 180],
    ["skewX", -MAX_SKEW, MAX_SKEW],
    ["skewY", -MAX_SKEW, MAX_SKEW],
    ["warpBend", -100, 100],
  ] as const) {
    const n = Number(s[key]);
    s[key] = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : DEFAULT_STYLE[key];
  }
  s.autoContrast = s.autoContrast !== false;
  if (s.minSize > s.size) s.minSize = s.size;
  if (!/^#[a-f\d]{6}$/i.test(s.fill)) s.fill = DEFAULT_STYLE.fill;
  if (!/^#[a-f\d]{6}$/i.test(s.outline)) s.outline = DEFAULT_STYLE.outline;
  if (!["left", "center", "right"].includes(s.align)) s.align = DEFAULT_STYLE.align;
  if (!["normal", "bold", "italic"].includes(s.emphasis)) s.emphasis = DEFAULT_STYLE.emphasis;
  if (!isTextWarpStyle(s.warpStyle)) s.warpStyle = DEFAULT_STYLE.warpStyle;
  if (typeof s.fontId !== "string") s.fontId = "";
  return s;
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
  const s = validateStyle(style);
  return hash(
    JSON.stringify({
      body: line.body,
      x: line.x,
      y: line.y,
      w: line.w,
      h: line.h,
      poly: region.polygon,
      style: s,
      dpi,
      width: page.width,
      height: page.height,
      outlineFormat: 3,
    }),
  );
}
type Token = { text: string; alone?: boolean; breakBefore?: boolean };
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
export async function fitText(
  line: LineRow,
  region: RegionData,
  page: ImageRow,
  input: Partial<TextStyle>,
  dpi: number,
): Promise<FittedLayout> {
  const style = validateStyle(input);
  if (!Number.isFinite(dpi) || dpi < 10 || dpi > 2400)
    throw new WorkflowError("DPI must be between 10 and 2400");
  if (line.body.length > 12000)
    throw new WorkflowError("Region text is too long to fit");
  const { font, metadata } = await loadFont(style.fontId);
  const missingGlyphs = [
    ...new Set(
      [...line.body].filter(
        (c) => !/\s/.test(c) && !font.hasGlyphForCodePoint(c.codePointAt(0)!),
      ),
    ),
  ];
  let poly = regionPolygon(line, region, page);
  const cx =
    (Math.min(...poly.map((p) => p.x)) + Math.max(...poly.map((p) => p.x))) / 2;
  const cy =
    (Math.min(...poly.map((p) => p.y)) + Math.max(...poly.map((p) => p.y))) / 2;
  // Wrap in un-rotated, un-skewed text space; the SVG re-applies the transform about the same centre.
  const inverse = inverseTextMatrix(style);
  const centre = { x: cx, y: cy };
  poly = poly.map((p) => applyMatrixAbout(inverse, p, centre));
  const minY = Math.min(...poly.map((p) => p.y)),
    maxY = Math.max(...poly.map((p) => p.y));
  const px = dpi / 72,
    padding = (style.padding + style.outlineWidth) * px;
  const unitWidths = new Map<string, number>();
  const measure = (text: string, size: number) => {
    if (!unitWidths.has(text)) {
      const r = font.layout(text);
      unitWidths.set(
        text,
        r.positions.reduce((sum, p) => sum + p.xAdvance, 0),
      );
    }
    return (
      (unitWidths.get(text)! * size * px) / font.unitsPerEm +
      (style.emphasis === "italic" ? size * px * 0.22 : 0) +
      (style.emphasis === "bold" ? size * px * 0.04 : 0)
    );
  };
  const minHeight =
    ((font.ascent - font.descent) / font.unitsPerEm) * style.minSize * px;
  let maxWidthAtMin = 0;
  for (
    let y = minY + padding + 0.01;
    y + minHeight < maxY - padding;
    y += Math.max(1, minHeight / 8)
  ) {
    const span = availableSpan(poly, y, y + minHeight, padding);
    if (span) maxWidthAtMin = Math.max(maxWidthAtMin, span[1] - span[0]);
  }
  let hyphenated = false;
  const tokens: Token[] = [];
  for (const [i, paragraph] of line.body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .entries()) {
    const words = paragraph.trim().split(/\s+/);
    for (const [w, word] of words.entries()) {
      const parts =
        measure(word, style.minSize) > maxWidthAtMin && maxWidthAtMin > 0
          ? dictionaryFragments(word, maxWidthAtMin, (s) =>
              measure(s, style.minSize),
            )
          : null;
      if (parts) {
        hyphenated = true;
        for (const part of parts)
          tokens.push({ text: part, alone: true, breakBefore: true });
      } else
        tokens.push({
          text: word,
          breakBefore: i > 0 && w === 0,
          alone: !word,
        });
    }
  }
  let rows: FittedLayout["rows"] = [];
  let chosen = style.minSize;
  let found = false;
  const sizes: number[] = [];
  for (let s = style.size; s > style.minSize; s -= 0.25) sizes.push(s);
  sizes.push(style.minSize);
  for (const size of sizes) {
    const scale = (size * px) / font.unitsPerEm;
    const glyphHeight = (font.ascent - font.descent) * scale;
    const lineHeight = Math.max(glyphHeight, size * px * style.leading);
    const maxLines = Math.min(
      tokens.length,
      150,
      Math.floor(
        (maxY - minY - padding * 2 + lineHeight - glyphHeight) / lineHeight,
      ),
    );
    let best: { cost: number; rows: FittedLayout["rows"] } | null = null;
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
      const memo = new Map<
        string,
        { cost: number; rows: FittedLayout["rows"] } | null
      >();
      const solve = (
        at: number,
        row: number,
      ): { cost: number; rows: FittedLayout["rows"] } | null => {
        if (row === count)
          return at === tokens.length ? { cost: 0, rows: [] } : null;
        if (at >= tokens.length) return null;
        const key = `${at}:${row}`;
        if (memo.has(key)) return memo.get(key)!;
        const [left, right] = spans[row]!;
        const width = right - left;
        let winner: ReturnType<typeof solve> = null;
        let text = "";
        for (let end = at; end < tokens.length; end++) {
          if (
            end > at &&
            (tokens[end].breakBefore || tokens[end].alone || tokens[at].alone)
          )
            break;
          text += (end > at ? " " : "") + tokens[end].text;
          const actual = measure(text, size);
          if (actual > width) break;
          const tail = solve(end + 1, row + 1);
          if (!tail) continue;
          const cost = tail.cost + ((width - actual) / width) ** 2;
          if (!winner || cost < winner.cost)
            winner = {
              cost,
              rows: [
                {
                  text,
                  width: actual,
                  x:
                    style.align === "left"
                      ? left
                      : style.align === "right"
                        ? right - actual
                        : (left + right - actual) / 2,
                  baseline: top + row * lineHeight + font.ascent * scale,
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
  const scale = (chosen * px) / font.unitsPerEm;
  const box = layoutWarpBox(rows, chosen * px);
  const warped = !!(box && hasTextWarp(style));
  const italic = style.emphasis === "italic";
  const paths: string[] = [];
  for (const row of rows) {
    const run = font.layout(row.text);
    let x = row.x;
    for (let i = 0; i < run.glyphs.length; i++) {
      const p = run.positions[i];
      const originX = x + p.xOffset * scale;
      const originY = row.baseline - p.yOffset * scale;
      if (warped && box) {
        const d = warpFontPath(
          run.glyphs[i].path.commands,
          originX,
          originY,
          scale,
          italic,
          box,
          style,
        );
        if (d) paths.push(`<path d="${d}"/>`);
      } else {
        const path = run.glyphs[i].path.toSVG();
        paths.push(
          `<path d="${path}" transform="translate(${originX} ${originY}) scale(${scale} ${-scale})${italic ? " skewX(12)" : ""}"/>`,
        );
      }
      x += p.xAdvance * scale;
    }
  }
  const bold = style.emphasis === "bold" ? chosen * px * 0.035 : 0;
  const glyphs = paths.join("");
  const outlineStroke = style.outlineWidth * px * 2 + bold;
  const stroke = warped ? outlineStroke : outlineStroke / scale;
  const fillStroke = warped ? bold : bold / scale;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}" height="${page.height}" viewBox="0 0 ${page.width} ${page.height}"><defs><g id="lettering">${glyphs}</g></defs><g transform="${textTransformSvg(style, cx, cy)}">${style.outlineWidth ? `<g fill="${style.outline}" stroke="${style.outline}" stroke-width="${stroke}" stroke-linejoin="round"><use href="#lettering"/></g>` : ""}<g fill="${style.fill}" stroke="${style.fill}" stroke-width="${fillStroke}" stroke-linejoin="round"><use href="#lettering"/></g></g></svg>`;
  return {
    key: layoutKey(line, region, page, style, dpi),
    rows,
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
  };
}
