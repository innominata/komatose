import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { Episode, ImageRow, LineRow, Series } from "../types";
import type { PageData, Point, RegionData } from "../workflow";
import { bubbleFromNorm, cropBubble, type SpeechBubble } from "./bubbles";
import { getDoc, readAsset, WorkflowError } from "./workflowStore";
import { localOperation } from "./localWorker";
import { imagePath } from "./storage";
import { maskRegion } from "../maskRegions";
import { regionRectangle } from "../regionGeometry";


const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export async function regionSource(
  series: Series,
  episode: Episode,
  line: LineRow,
  page?: ImageRow,
) {
  if (
    !page ||
    [line.x, line.y, line.w, line.h].some(
      (n) => n == null || !Number.isFinite(n),
    ) ||
    line.w! <= 0 ||
    line.h! <= 0
  )
    throw new WorkflowError("Region needs image bounds");
  const raw = await readFile(
    imagePath(series.slug, episode.slug, page.filename),
  );
  const meta = await sharp(raw).metadata();
  const bubble = bubbleFromNorm(
    meta.width!,
    meta.height!,
    line.x!,
    line.y!,
    line.w!,
    line.h!,
  );
  return { raw, bubble, width: meta.width!, height: meta.height! };
}

export async function applyLetteringMask(
  crop: Buffer,
  maskPng: Buffer,
  opts?: { empty?: "error" | "keep" },
) {
  const image = await sharp(crop).removeAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  const mask = await sharp(maskPng).removeAlpha().greyscale().raw().toBuffer({
    resolveWithObject: true,
  });
  if (mask.info.width !== image.info.width || mask.info.height !== image.info.height)
    throw new WorkflowError("Review mask does not match the region crop");
  const pixels = Buffer.from(image.data);
  const channels = image.info.channels;
  let kept = 0;
  for (let i = 0; i < mask.data.length; i++) {
    if (mask.data[i] > 127) {
      kept++;
      continue;
    }
    const o = i * channels;
    pixels[o] = 255;
    if (channels > 1) pixels[o + 1] = 255;
    if (channels > 2) pixels[o + 2] = 255;
  }
  if (!kept) {
    if (opts?.empty === "keep") return crop;
    throw new WorkflowError("Paint or detect lettering before sending a masked crop");
  }
  return sharp(pixels, {
    raw: { width: image.info.width, height: image.info.height, channels },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

export function parseReviewMaskPng(value: unknown) {
  if (typeof value !== "string" || !value.trim())
    throw new WorkflowError("Choose a lettering mask for this crop");
  if (value.length > 16_000_000) throw new WorkflowError("Review mask is too large");
  const comma = value.indexOf(",");
  const encoded = value.startsWith("data:") && comma >= 0 ? value.slice(comma + 1) : value;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, "base64");
  } catch {
    throw new WorkflowError("Review mask is not a valid image");
  }
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_MAGIC))
    throw new WorkflowError("Review mask must be a PNG");
  return bytes;
}

export async function croppedPageMask(
  page: ImageRow,
  line: LineRow,
  series: Series,
  episode: Episode,
) {
  const { bubble, width, height } = await regionSource(series, episode, line, page);
  const empty = () =>
    sharp({
      create: {
        width: bubble.width,
        height: bubble.height,
        channels: 3,
        background: "black",
      },
    })
      .greyscale()
      .png()
      .toBuffer();
  const doc = getDoc<PageData>(`page:${page.id}`, {});
  if (!doc.data.mask) return empty();
  const mask = await readAsset(doc.data.mask);
  const meta = await sharp(mask).metadata();
  if (meta.width !== width || meta.height !== height) return empty();
  return sharp(mask)
    .extract({
      left: bubble.left,
      top: bubble.top,
      width: bubble.width,
      height: bubble.height,
    })
    .greyscale()
    .png()
    .toBuffer();
}

export async function detectReviewMask(
  series: Series,
  episode: Episode,
  line: LineRow,
  page: ImageRow,
  expansion: unknown,
  abort?: AbortSignal,
  run: typeof localOperation = localOperation,
) {
  const src = await regionSource(series, episode, line, page);
  const polygon = maskRegion(line, getDoc<RegionData>(`region:${line.id}`, {}).data);
  const mask = await detectLetteringMask(src.raw, [polygon], expansion, abort, run);
  return cropLetteringMask(mask, src.bubble);
}

/** Detect once on the source page; reuse the result for every recognition crop. */
export async function detectLetteringMask(
  raw: Buffer,
  regions: Point[][],
  expansion: unknown = 3,
  abort?: AbortSignal,
  run: typeof localOperation = localOperation,
) {
  abort?.throwIfAborted();
  const expansionPx = Math.round(Number(expansion ?? 3));
  if (!Number.isInteger(expansionPx) || expansionPx < 0 || expansionPx > 20)
    throw new WorkflowError("Mask expansion must be 0–20 pixels");
  if (!regions.length || regions.some(polygon => polygon.length < 3))
    throw new WorkflowError("Define a region before detecting a removal mask");
  const dir = await mkdtemp(join(tmpdir(), "scan-review-mask-"));
  const path = join(dir, "source.png");
  const out = join(dir, "mask.png");
  try {
    // Detect on exactly the pixels being read, never a cleaned layer with lettering removed.
    await writeFile(path, raw);
    abort?.throwIfAborted();
    await run(
      {
        cmd: "mask",
        path,
        out,
        detect: true,
        expansion: expansionPx,
        maskEngine: "auto",
        regions,
        strokes: [],
      },
      abort,
    );
    abort?.throwIfAborted();
    const mask = await readFile(out);
    const [sourceInfo, maskInfo] = await Promise.all([sharp(raw).metadata(), sharp(mask).metadata()]);
    if (sourceInfo.width !== maskInfo.width || sourceInfo.height !== maskInfo.height)
      throw new WorkflowError("Detected lettering mask does not match the source page");
    return mask;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function cropLetteringMask(mask: Buffer, bubble: SpeechBubble) {
  return sharp(mask).extract({ left: bubble.left, top: bubble.top, width: bubble.width, height: bubble.height })
    .greyscale().png().toBuffer();
}

export async function maskedBubbleCrop(
  raw: Buffer,
  bubble: SpeechBubble,
  abort?: AbortSignal,
  pageMask?: Buffer,
) {
  abort?.throwIfAborted();
  const mask = pageMask ?? await detectLetteringMask(raw, [regionRectangle(bubble)], 3, abort);
  const crop = await cropBubble(raw, bubble);
  const masked = await applyLetteringMask(
    crop,
    await cropLetteringMask(mask, bubble),
    { empty: "keep" },
  );
  abort?.throwIfAborted();
  return masked;
}

/** Chapter transcribe crop: a failed or empty lettering mask still yields a region image. */
export async function transcribeBubbleCrop(
  raw: Buffer,
  bubble: SpeechBubble,
  abort?: AbortSignal,
  pageMask?: Buffer,
) {
  abort?.throwIfAborted();
  if (pageMask) {
    try {
      return await maskedBubbleCrop(raw, bubble, abort, pageMask);
    } catch (e) {
      if (abort?.aborted) throw e;
    }
  }
  return cropBubble(raw, bubble);
}

export async function regionReviewCrop(
  series: Series,
  episode: Episode,
  line: LineRow,
  page: ImageRow | undefined,
  maskPng?: Buffer,
) {
  const { raw, bubble } = await regionSource(series, episode, line, page);
  const crop = await cropBubble(raw, bubble);
  return maskPng ? applyLetteringMask(crop, maskPng) : crop;
}
