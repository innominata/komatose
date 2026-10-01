import sharp from "sharp";
import type { ImageRow, LineRow } from "../types";
import { maskRegion } from "../maskRegions";
import type { MaskStroke, Point, RegionData, WorkflowDoc } from "../workflow";
import { getDoc, putDoc, readAsset, storeAsset, WorkflowError } from "./workflowStore";
import { listLines } from "./queries";
import type { PixelData } from "ag-psd";

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export function boundsOverlap(
  a: Pick<LineRow, "x" | "y" | "w" | "h">,
  b: Pick<LineRow, "x" | "y" | "w" | "h">,
) {
  const ax = a.x ?? 0,
    ay = a.y ?? 0,
    aw = a.w ?? 0.2,
    ah = a.h ?? 0.1;
  const bx = b.x ?? 0,
    by = b.y ?? 0,
    bw = b.w ?? 0.2,
    bh = b.h ?? 0.1;
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

export function overlappingHoles(
  target: LineRow,
  others: LineRow[],
  regions: Map<string, RegionData>,
): Point[][] {
  const holes: Point[][] = [];
  for (const other of others) {
    if (other.id === target.id || other.sourceState === "ignored") continue;
    if (!boundsOverlap(target, other)) continue;
    const poly = maskRegion(other, regions.get(other.id));
    if (poly.length >= 3) holes.push(poly);
  }
  return holes;
}

export async function blankTextMask(width: number, height: number) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .greyscale()
    .png()
    .toBuffer();
}

export async function normalizeTextMask(bytes: Buffer, width: number, height: number) {
  const meta = await sharp(bytes).metadata();
  if (meta.width === width && meta.height === height)
    return sharp(bytes).greyscale().png().toBuffer();
  return sharp(bytes)
    .resize(width, height, { fit: "fill" })
    .greyscale()
    .png()
    .toBuffer();
}

function maskOverlaySvg(
  width: number,
  height: number,
  strokes: MaskStroke[],
  holes: Point[][],
) {
  const parts: string[] = [];
  for (const hole of holes) {
    const pts = hole
      .map((p) => `${p.x * width},${p.y * height}`)
      .join(" ");
    parts.push(
      `<polygon points="${pts}" fill="black" stroke="black" stroke-width="4" stroke-linejoin="round"/>`,
    );
  }
  for (const stroke of strokes) {
    const color = stroke.erase ? "white" : "black";
    const r = Math.max(1, Math.floor(stroke.radius));
    const pts = stroke.points.map((p) => {
      const x = clamp(Math.floor(p.x * width), 0, width - 1);
      const y = clamp(Math.floor(p.y * height), 0, height - 1);
      return `${x},${y}`;
    });
    if (pts.length > 1)
      parts.push(
        `<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="${r * 2}" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
    for (const pt of pts) {
      const [x, y] = pt.split(",");
      parts.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="${color}"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join("")}</svg>`;
}

export async function applyTextMaskEdits(opts: {
  width: number;
  height: number;
  existing?: Buffer;
  strokes?: MaskStroke[];
  holes?: Point[][];
}) {
  const { width, height } = opts;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new WorkflowError("Page size is required to save a text mask");
  const strokes = opts.strokes ?? [];
  const holes = opts.holes ?? [];
  if (!strokes.length && !holes.length && !opts.existing)
    throw new WorkflowError("Paint a mask or knock out overlapping regions");
  const base = opts.existing
    ? await normalizeTextMask(opts.existing, width, height)
    : await blankTextMask(width, height);
  if (!strokes.length && !holes.length) return base;
  return sharp(base)
    .composite([{ input: Buffer.from(maskOverlaySvg(width, height, strokes, holes)) }])
    .greyscale()
    .png()
    .toBuffer();
}

export async function cropTextMask(
  pageMask: Buffer,
  left: number,
  top: number,
  width: number,
  height: number,
) {
  const meta = await sharp(pageMask).metadata();
  const srcW = meta.width ?? 1;
  const srcH = meta.height ?? 1;
  const x = clamp(left, 0, Math.max(0, srcW - 1));
  const y = clamp(top, 0, Math.max(0, srcH - 1));
  const w = clamp(width, 1, srcW - x);
  const h = clamp(height, 1, srcH - y);
  const cropped = await sharp(pageMask).extract({ left: x, top: y, width: w, height: h }).png().toBuffer();
  const got = await sharp(cropped).metadata();
  if (got.width === width && got.height === height) return cropped;
  return sharp(cropped).resize(width, height, { fit: "fill" }).png().toBuffer();
}

export async function applyTextMaskToLayer(
  layerPng: Buffer,
  pageMask: Buffer,
  left: number,
  top: number,
  width: number,
  height: number,
) {
  const cropped = await cropTextMask(pageMask, left, top, width, height);
  const mask = await sharp(cropped)
    .greyscale()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const layer = await sharp(layerPng)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (mask.info.width !== layer.info.width || mask.info.height !== layer.info.height)
    throw new WorkflowError("Text mask crop does not match the typeset layer");
  const out = Buffer.from(layer.data);
  for (let i = 0; i < mask.data.length; i++)
    out[i * 4 + 3] = Math.round((out[i * 4 + 3] * mask.data[i]) / 255);
  return sharp(out, {
    raw: { width: layer.info.width, height: layer.info.height, channels: 4 },
  })
    .png()
    .toBuffer();
}

export async function maskPixelData(png: Buffer): Promise<PixelData> {
  const { data, info } = await sharp(png)
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data),
  };
}

export async function saveRegionTextMask(
  episodeId: string,
  line: LineRow,
  image: ImageRow,
  expectedRevision: number,
  edit: { strokes?: MaskStroke[]; knockout?: boolean; clear?: boolean },
): Promise<WorkflowDoc<RegionData>> {
  const doc = getDoc<RegionData>(`region:${line.id}`, {});
  if (edit.clear) {
    const data = { ...doc.data };
    delete data.textMask;
    return putDoc(episodeId, doc.id, data, expectedRevision);
  }
  const pageLines = (await listLines(episodeId)).filter((row) => row.imageId === image.id);
  const holes = edit.knockout
    ? overlappingHoles(
        line,
        pageLines,
        new Map(
          pageLines.map((row) => [row.id, getDoc<RegionData>(`region:${row.id}`, {}).data]),
        ),
      )
    : [];
  if (edit.knockout && !holes.length && !edit.strokes?.length)
    throw new WorkflowError("No overlapping regions to knock out");
  if (!edit.strokes?.length && !holes.length)
    throw new WorkflowError("Paint a mask or knock out overlapping regions");
  const existing = doc.data.textMask ? await readAsset(doc.data.textMask) : undefined;
  const png = await applyTextMaskEdits({
    width: image.width,
    height: image.height,
    existing,
    strokes: edit.strokes,
    holes,
  });
  return putDoc(episodeId, doc.id, { ...doc.data, textMask: await storeAsset(png) }, expectedRevision);
}
