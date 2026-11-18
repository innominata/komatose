import sharp from "sharp";
import { censorDocId, censorPixelBoxes, type CensorData, type CensorRect } from "../censor";
import { getDoc } from "./workflowStore";

export function pageCensors(imageId: string): CensorRect[] {
  return getDoc<CensorData>(censorDocId(imageId), {}).data.rects ?? [];
}

/** Paint the page's censor boxes solid black over an image of that page. Returns PNG. */
export async function applyCensors(image: Buffer, rects: readonly CensorRect[] | undefined): Promise<Buffer> {
  if (!rects?.length) return image;
  const meta = await sharp(image).metadata();
  const boxes = censorPixelBoxes(rects, meta.width ?? 0, meta.height ?? 0);
  if (!boxes.length) return image;
  return sharp(image)
    .composite(boxes.map((b) => ({
      input: { create: { width: b.width, height: b.height, channels: 4 as const, background: { r: 0, g: 0, b: 0, alpha: 1 } } },
      left: b.left,
      top: b.top,
    })))
    .withMetadata()
    .png()
    .toBuffer();
}

/** Move boxes through a crop/rotate/resize that maps old page pixels to new ones. */
export function transformCensors(
  rects: readonly CensorRect[] | undefined,
  oldSize: { width: number; height: number },
  t: { sx: number; sy: number; dx: number; dy: number; width: number; height: number; crop?: { x: number; y: number; w: number; h: number } },
): CensorRect[] {
  // `crop` is in scaled source pixels, before translation; anything outside it is dropped.
  const clipX = (v: number) => t.crop ? Math.min(t.crop.x + t.crop.w, Math.max(t.crop.x, v)) : v;
  const clipY = (v: number) => t.crop ? Math.min(t.crop.y + t.crop.h, Math.max(t.crop.y, v)) : v;
  return (rects ?? []).flatMap((r) => {
    const ax = clipX(r.x * oldSize.width * t.sx) + t.dx, bx = clipX((r.x + r.w) * oldSize.width * t.sx) + t.dx;
    const ay = clipY(r.y * oldSize.height * t.sy) + t.dy, by = clipY((r.y + r.h) * oldSize.height * t.sy) + t.dy;
    const left = Math.max(0, Math.min(ax, bx)), right = Math.min(t.width, Math.max(ax, bx));
    const top = Math.max(0, Math.min(ay, by)), bottom = Math.min(t.height, Math.max(ay, by));
    return right > left && bottom > top
      ? [{ ...r, x: left / t.width, y: top / t.height, w: (right - left) / t.width, h: (bottom - top) / t.height }]
      : [];
  });
}

type Rect = { x: number; y: number; width: number; height: number };
/** Boxes for a page assembled from pieces of other pages (split, merge, moved boundary). */
export function projectCensors(
  out: { width: number; height: number; placements: { imageId: string; rect: Rect; x: number; y: number }[] },
  sources: { id: string; width: number; height: number; rects: readonly CensorRect[] }[],
): CensorRect[] {
  return out.placements.flatMap((p) => {
    const s = sources.find((source) => source.id === p.imageId);
    if (!s) return [];
    return s.rects.flatMap((r) => {
      const left = Math.max(r.x * s.width, p.rect.x), right = Math.min((r.x + r.w) * s.width, p.rect.x + p.rect.width);
      const top = Math.max(r.y * s.height, p.rect.y), bottom = Math.min((r.y + r.h) * s.height, p.rect.y + p.rect.height);
      if (right <= left || bottom <= top) return [];
      const ox = p.x - p.rect.x, oy = p.y - p.rect.y;
      return [{
        id: `${r.id}:${p.imageId.slice(0, 8)}`.slice(0, 64),
        x: (left + ox) / out.width, y: (top + oy) / out.height,
        w: (right - left) / out.width, h: (bottom - top) / out.height,
      }];
    });
  });
}
