import sharp from "sharp";
import type { Episode, ImageRow, LineRow, Series } from "../types";
import { pageArtwork, type PageData } from "../workflow";
import { bubbleFromNorm, type SpeechBubble } from "./bubbles";
import { readWorkingOrOrig } from "./storage";
import { getDoc, readAsset, WorkflowError } from "./workflowStore";
import { encodeApng } from "./apng";

export type ComparisonFormat = "apng" | "gif";

/** Both frames hold for this long, so the crop flips raw → cleaned → raw every 0.5s. */
export const COMPARISON_DELAY_MS = 500;

export function parseComparisonFormat(value: unknown): ComparisonFormat {
  return value === "gif" ? "gif" : "apng";
}

type Frame = { data: Buffer; channels: number; width: number; height: number };

/** The region's pixels from one page layer, straight (never inverted, never masked). */
async function cropFrame(source: Buffer, bubble: SpeechBubble): Promise<Frame> {
  const { data, info } = await sharp(source)
    .extract({ left: bubble.left, top: bubble.top, width: bubble.width, height: bubble.height })
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, channels: info.channels, width: info.width, height: info.height };
}

async function animatedGif(frames: Frame[], delayMs: number): Promise<Buffer> {
  const stills = await Promise.all(
    frames.map((frame) =>
      sharp(frame.data, {
        raw: { width: frame.width, height: frame.height, channels: frame.channels as 3 },
      })
        .png()
        .toBuffer(),
    ),
  );
  return sharp(stills, { join: { animated: true } })
    .gif({ delay: frames.map(() => delayMs), loop: 0 })
    .toBuffer();
}

/** Raw artwork beside the cleaned artwork for one region, as a single animated image. */
export async function regionComparison(
  series: Series,
  episode: Episode,
  line: LineRow,
  page: ImageRow | undefined,
  format: ComparisonFormat = "apng",
  delayMs = COMPARISON_DELAY_MS,
) {
  if (!page) throw new WorkflowError("Region has no page image");
  if (
    [line.x, line.y, line.w, line.h].some((n) => n == null || !Number.isFinite(n)) ||
    line.w! <= 0 ||
    line.h! <= 0
  )
    throw new WorkflowError("Region needs image bounds");
  const doc = getDoc<PageData>(`page:${page.id}`, {});
  const rawHash = doc.data.prepared || doc.data.original;
  const cleanHash = pageArtwork(doc.data);
  if (!cleanHash || cleanHash === rawHash)
    throw new WorkflowError("Clean this page before comparing the raw and cleaned region");

  const rawSource =
    (rawHash ? await readAsset(rawHash) : null) ??
    (await readWorkingOrOrig(series.slug, episode.slug, page.filename));
  if (!rawSource) throw new WorkflowError("Missing page image", 404);
  const cleanSource = await readAsset(cleanHash);

  const [rawMeta, cleanMeta] = await Promise.all([
    sharp(rawSource).metadata(),
    sharp(cleanSource).metadata(),
  ]);
  if (!rawMeta.width || !rawMeta.height)
    throw new WorkflowError("Raw page has no pixels to compare");
  if (rawMeta.width !== cleanMeta.width || rawMeta.height !== cleanMeta.height)
    throw new WorkflowError("Raw and cleaned page sizes differ. Re-prepare this page.");

  const bubble = bubbleFromNorm(
    rawMeta.width,
    rawMeta.height,
    line.x!,
    line.y!,
    line.w!,
    line.h!,
  );
  const [rawFrame, cleanFrame] = await Promise.all([
    cropFrame(rawSource, bubble),
    cropFrame(cleanSource, bubble),
  ]);
  const frames = [rawFrame, cleanFrame];
  const body =
    format === "gif"
      ? await animatedGif(frames, delayMs)
      : encodeApng(
          frames.map((frame) => frame.data),
          {
            width: rawFrame.width,
            height: rawFrame.height,
            channels: rawFrame.channels === 4 ? 4 : 3,
            delayMs,
          },
        );
  return {
    body,
    contentType: format === "gif" ? "image/gif" : "image/apng",
    filename: `raw-vs-clean.${format === "gif" ? "gif" : "png"}`,
    format,
    delayMs,
    width: rawFrame.width,
    height: rawFrame.height,
  };
}
