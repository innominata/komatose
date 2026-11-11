import sharp from "sharp";
import type { PatternAsset } from "../workflow";
import type { FxPattern } from "../textEffects";
import { sqlite } from "./db";
import { readAsset, storeAsset, hash, WorkflowError } from "./workflowStore";
import { unlinkAssetFiles, unreferencedAssets } from "./exportRetention";

/**
 * The shared pattern library: screentones and other tiles for the Pattern Overlay layer
 * style. A pattern's pixels are embedded in every layout that uses it (the preview is an SVG
 * image, which loads nothing from outside), so uploads are re-encoded and kept modest.
 */

const MAX_UPLOAD = 40 * 1024 * 1024;
/** Longest side kept. Screentone tiles are usually 1–3k px; larger scans are scaled down. */
const MAX_SIDE = 4096;
/** Encoded size kept; a bigger tile is halved until it fits. */
const MAX_STORED = 4 * 1024 * 1024;

type Row = { id: string; hash: string; filename: string; metadata: string; created_at: number };

const toAsset = (r: Row): PatternAsset => ({ ...JSON.parse(r.metadata), id: r.id, hash: r.hash, filename: r.filename });

export function listPatterns(): PatternAsset[] {
  return (sqlite.prepare("SELECT id,hash,filename,metadata,created_at FROM global_pattern_assets ORDER BY created_at").all() as Row[]).map(toAsset);
}

export function getPattern(id: string): PatternAsset | undefined {
  const row = sqlite.prepare("SELECT id,hash,filename,metadata,created_at FROM global_pattern_assets WHERE id=?").get(id) as Row | undefined;
  return row ? toAsset(row) : undefined;
}

const nameOf = (filename: string) => filename.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() || "Pattern";

/** Photographic tiles stay JPEG; anything with flat tones or transparency is PNG. */
async function encode(bytes: Buffer) {
  const image = sharp(bytes, { animated: false, limitInputPixels: 20000 * 20000 }).rotate();
  const meta = await image.metadata();
  if (!meta.width || !meta.height) throw new WorkflowError("The file is not an image");
  const jpeg = meta.format === "jpeg";
  let side = Math.min(MAX_SIDE, Math.max(meta.width, meta.height));
  for (;;) {
    const resized = image.clone().resize({ width: side, height: side, fit: "inside", withoutEnlargement: true });
    const out = jpeg
      ? await resized.flatten({ background: "#ffffff" }).jpeg({ quality: 90, mozjpeg: true }).toBuffer({ resolveWithObject: true })
      : await resized.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer({ resolveWithObject: true });
    if (out.data.length <= MAX_STORED || side <= 256)
      return { data: out.data, width: out.info.width, height: out.info.height, mime: (jpeg ? "image/jpeg" : "image/png") as PatternAsset["mime"] };
    side = Math.round(side / 2);
  }
}

export async function uploadPattern(filename: string, bytes: Buffer) {
  if (!/\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(filename) || bytes.length > MAX_UPLOAD)
    throw new WorkflowError("Choose a PNG, JPEG, GIF or WebP image up to 40 MB");
  let encoded;
  try {
    encoded = await encode(bytes);
  } catch (e) {
    if (e instanceof WorkflowError) throw e;
    throw new WorkflowError(`${filename} could not be read as an image`);
  }
  const digest = await storeAsset(encoded.data);
  const id = hash(`pattern:${digest}`).slice(0, 32);
  const duplicate = !!sqlite.prepare("SELECT 1 FROM global_pattern_assets WHERE id=?").get(id);
  const metadata = { name: nameOf(filename), width: encoded.width, height: encoded.height, mime: encoded.mime };
  sqlite
    .prepare("INSERT OR IGNORE INTO global_pattern_assets VALUES(?,?,?,?,?)")
    .run(id, digest, filename, JSON.stringify(metadata), Date.now());
  return { pattern: getPattern(id)!, duplicate };
}

export function renamePattern(id: string, name: string) {
  const pattern = getPattern(id);
  if (!pattern) throw new WorkflowError("Pattern not found", 404);
  const clean = name.trim().slice(0, 120);
  if (!clean) throw new WorkflowError("Give the pattern a name");
  const { id: _id, hash: _hash, filename: _filename, ...meta } = pattern;
  sqlite.prepare("UPDATE global_pattern_assets SET metadata=? WHERE id=?").run(JSON.stringify({ ...meta, name: clean }), id);
  return listPatterns();
}

/** Styles (series defaults, chapter and region styles) whose pattern overlay uses the pattern. */
export function patternUsage(id: string) {
  const rows = sqlite.prepare("SELECT id FROM workflow_docs WHERE instr(data,?)>0").all(`"patternId":"${id}"`) as { id: string }[];
  const byKind: Record<string, number> = {};
  for (const { id: docId } of rows) {
    const kind = docId.split(":")[0];
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  return { total: rows.length, byKind };
}

/**
 * Removes a pattern. One still chosen by a style is refused unless `force` is set, which
 * clears the choice; the overlay then draws nothing until another pattern is picked.
 */
export function deletePattern(id: string, force = false) {
  const pattern = getPattern(id);
  if (!pattern) throw new WorkflowError("Pattern not found", 404);
  const usage = patternUsage(id);
  if (usage.total && !force) {
    const parts = Object.entries(usage.byKind).map(([k, n]) => `${n} ${k}`);
    throw new WorkflowError(
      `This pattern is used by ${usage.total} style setting${usage.total === 1 ? "" : "s"} (${parts.join(", ")})`,
      409,
      { usage },
    );
  }
  sqlite.transaction(() => {
    if (usage.total)
      sqlite
        .prepare("UPDATE workflow_docs SET data=replace(data,?,?), revision=revision+1, updated_at=? WHERE instr(data,?)>0")
        .run(`"patternId":"${id}"`, `"patternId":""`, Date.now(), `"patternId":"${id}"`);
    sqlite.prepare("DELETE FROM global_pattern_assets WHERE id=?").run(id);
  })();
  uriCache.delete(id);
  unlinkAssetFiles(unreferencedAssets(sqlite, [pattern.hash]));
  return { removed: id, cleared: usage.total };
}

const uriCache = new Map<string, FxPattern>();
/** The tile as layouts embed it, or undefined when the pattern is gone or unreadable. */
export async function patternTile(id: string): Promise<FxPattern | undefined> {
  if (!id) return;
  const hit = uriCache.get(id);
  if (hit) return hit;
  const pattern = getPattern(id);
  if (!pattern) return;
  const bytes = await readAsset(pattern.hash).catch(() => null);
  if (!bytes) return;
  const tile = { uri: `data:${pattern.mime};base64,${bytes.toString("base64")}`, width: pattern.width, height: pattern.height };
  if (uriCache.size > 16) uriCache.clear();
  uriCache.set(id, tile);
  return tile;
}

/** RGBA pixels of a pattern for a PSD's pattern resource (Photoshop limits patterns to 30000 px a side). */
export async function patternPixels(id: string) {
  const pattern = getPattern(id);
  if (!pattern) return;
  const bytes = await readAsset(pattern.hash).catch(() => null);
  if (!bytes) return;
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { pattern, width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) };
}
