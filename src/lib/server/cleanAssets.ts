import sharp, { type OverlayOptions } from "sharp";
import { randomUUID } from "node:crypto";
import type { CleanAsset, PlacedAsset } from "../cleanAssets";
import type { PageData } from "../workflow";
import {
  getDoc,
  peekUndo,
  putDoc,
  readAsset,
  storeAsset,
  WorkflowError,
} from "./workflowStore";

export function cleanAssetLibrary(seriesId: string) {
  const doc = getDoc<{ cleanAssets?: CleanAsset[] }>(`series:${seriesId}`, {});
  return { assets: doc.data.cleanAssets ?? [], revision: doc.revision };
}
/** Retain authority for a placement queued just before its library entry was replaced. */
export function seriesAssetHashes(seriesId: string) {
  const id = `series:${seriesId}`;
  return new Set(
    [
      getDoc<{ cleanAssets?: CleanAsset[] }>(id, {}).data,
      ...peekUndo<{ cleanAssets?: CleanAsset[] }>(id),
    ].flatMap((data) => (data.cleanAssets ?? []).map((a) => a.hash)),
  );
}
export async function saveCleanAsset(
  seriesId: string,
  name: string,
  bytes: Buffer,
  expectedRevision: number,
  replaceId?: string,
) {
  if (bytes.length > 100 * 1024 * 1024)
    throw new WorkflowError("Choose a PNG smaller than 100 MB");
  const meta = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
  if (
    meta.format !== "png" ||
    !meta.width ||
    !meta.height ||
    (meta.pages && meta.pages > 1)
  )
    throw new WorkflowError("Choose a single PNG image");
  const normalized = await sharp(bytes).ensureAlpha().png().toBuffer();
  const hash = await storeAsset(normalized);
  const doc = getDoc<{ cleanAssets?: CleanAsset[] }>(`series:${seriesId}`, {});
  const assets = [...(doc.data.cleanAssets ?? [])];
  const index = replaceId ? assets.findIndex((a) => a.id === replaceId) : -1;
  if (replaceId && index < 0) throw new WorkflowError("Asset not found", 404);
  const asset: CleanAsset = {
    id: replaceId || randomUUID(),
    name: name.slice(0, 200) || "Graphic.png",
    hash,
    width: meta.width,
    height: meta.height,
  };
  if (index < 0) assets.push(asset);
  else assets[index] = asset;
  putDoc(null, doc.id, { ...doc.data, cleanAssets: assets }, expectedRevision);
  return cleanAssetLibrary(seriesId);
}
export function deleteCleanAsset(
  seriesId: string,
  id: string,
  expectedRevision: number,
) {
  const doc = getDoc<{ cleanAssets?: CleanAsset[] }>(`series:${seriesId}`, {});
  if (!doc.data.cleanAssets?.some((a) => a.id === id))
    throw new WorkflowError("Asset not found", 404);
  putDoc(
    null,
    doc.id,
    {
      ...doc.data,
      cleanAssets: doc.data.cleanAssets.filter((a) => a.id !== id),
    },
    expectedRevision,
  );
  return cleanAssetLibrary(seriesId);
}
export function validatePlacements(value: unknown): PlacedAsset[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new WorkflowError("Keep at most 100 graphics on one page");
  const ids = new Set<string>();
  return value.map((g) => {
    if (
      !g ||
      typeof g.id !== "string" ||
      g.id.length > 100 ||
      ids.has(g.id) ||
      typeof g.assetId !== "string" ||
      !/^[a-f0-9]{64}$/.test(g.hash) ||
      ![g.x, g.y, g.width, g.height, g.rotation, g.opacity].every(
        Number.isFinite,
      ) ||
      g.width < 1 ||
      g.height < 1 ||
      g.width > 30000 ||
      g.height > 30000 ||
      g.width * g.height > 40_000_000 ||
      Math.abs(g.x) > 100000 ||
      Math.abs(g.y) > 100000 ||
      Math.abs(g.rotation) > 36000 ||
      g.opacity < 0 ||
      g.opacity > 1
    )
      throw new WorkflowError("Invalid graphic placement");
    ids.add(g.id);
    return {
      id: g.id,
      assetId: g.assetId,
      name: String(g.name || "Graphic").slice(0, 200),
      hash: g.hash,
      x: g.x,
      y: g.y,
      width: g.width,
      height: g.height,
      rotation: g.rotation % 360,
      opacity: g.opacity,
    };
  });
}
export async function graphicSprite(g: PlacedAsset) {
  let bytes = await sharp(await readAsset(g.hash))
    .resize(
      Math.max(1, Math.round(g.width)),
      Math.max(1, Math.round(g.height)),
      { fit: "fill" },
    )
    .ensureAlpha()
    .png()
    .toBuffer();
  if (g.opacity < 1) {
    const { data, info } = await sharp(bytes)
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let i = 3; i < data.length; i += 4)
      data[i] = Math.round(data[i] * g.opacity);
    bytes = await sharp(data, {
      raw: { width: info.width, height: info.height, channels: 4 },
    })
      .png()
      .toBuffer();
  }
  if (g.rotation)
    bytes = await sharp(bytes)
      .rotate(g.rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
  const meta = await sharp(bytes).metadata();
  return {
    bytes,
    width: meta.width!,
    height: meta.height!,
    left: Math.round(g.x - meta.width! / 2),
    top: Math.round(g.y - meta.height! / 2),
  };
}
export async function compositePageAssets(
  base: Buffer,
  page: Pick<PageData, "placedAssets">,
) {
  if (!page.placedAssets?.length) return base;
  const meta = await sharp(base).metadata(),
    layers: OverlayOptions[] = [];
  for (const g of page.placedAssets) {
    const s = await graphicSprite(g);
    const left = Math.max(0, s.left),
      top = Math.max(0, s.top),
      right = Math.min(meta.width!, s.left + s.width),
      bottom = Math.min(meta.height!, s.top + s.height);
    if (right <= left || bottom <= top) continue;
    layers.push({
      input: await sharp(s.bytes)
        .extract({
          left: left - s.left,
          top: top - s.top,
          width: right - left,
          height: bottom - top,
        })
        .png()
        .toBuffer(),
      left,
      top,
    });
  }
  return layers.length ? sharp(base).composite(layers).png().toBuffer() : base;
}

/** Move whole graphics, or split their rendered pixels when a page cut crosses one. */
export async function projectPageAssets(
  items: PlacedAsset[] | undefined,
  rect: { x: number; y: number; width: number; height: number },
  dx: number,
  dy: number,
): Promise<PlacedAsset[]> {
  const result: PlacedAsset[] = [];
  for (const g of items ?? []) {
    const s = await graphicSprite(g),
      left = Math.max(rect.x, s.left),
      top = Math.max(rect.y, s.top),
      right = Math.min(rect.x + rect.width, s.left + s.width),
      bottom = Math.min(rect.y + rect.height, s.top + s.height);
    if (right <= left || bottom <= top) continue;
    if (
      s.left >= rect.x &&
      s.top >= rect.y &&
      s.left + s.width <= rect.x + rect.width &&
      s.top + s.height <= rect.y + rect.height
    )
      result.push({ ...g, x: g.x + dx, y: g.y + dy });
    else {
      const bytes = await sharp(s.bytes)
        .extract({
          left: left - s.left,
          top: top - s.top,
          width: right - left,
          height: bottom - top,
        })
        .png()
        .toBuffer();
      result.push({
        ...g,
        id: `${g.id.split(":")[0]}:${randomUUID()}`,
        hash: await storeAsset(bytes),
        x: (left + right) / 2 + dx,
        y: (top + bottom) / 2 + dy,
        width: right - left,
        height: bottom - top,
        rotation: 0,
        opacity: 1,
      });
    }
  }
  return result;
}
export async function transformPageAssets(
  items: PlacedAsset[] | undefined,
  t: { sx: number; sy: number; dx: number; dy: number },
): Promise<PlacedAsset[] | undefined> {
  if (!items) return undefined;
  return Promise.all(
    items.map(async (g) => {
      if (Math.abs(t.sx - t.sy) < 0.00001 || !g.rotation)
        return {
          ...g,
          x: g.x * t.sx + t.dx,
          y: g.y * t.sy + t.dy,
          width: g.width * t.sx,
          height: g.height * t.sy,
        };
      const s = await graphicSprite(g);
      return {
        ...g,
        hash: await storeAsset(s.bytes),
        x: g.x * t.sx + t.dx,
        y: g.y * t.sy + t.dy,
        width: s.width * t.sx,
        height: s.height * t.sy,
        rotation: 0,
        opacity: 1,
      };
    }),
  );
}
