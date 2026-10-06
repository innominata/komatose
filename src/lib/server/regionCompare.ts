import sharp from "sharp";
import { randomUUID } from "node:crypto";
import type { Episode, ImageRow, LineRow, Series } from "../types";
import { pageArtwork, type PageData } from "../workflow";
import { bubbleFromNorm, type SpeechBubble } from "./bubbles";
import { readWorkingOrOrig } from "./storage";
import { getDoc, readAsset, WorkflowError } from "./workflowStore";
import { encodeApng } from "./apng";

export type ComparisonFormat = "apng" | "gif";

// Temporary examples live outside page history, expire after two hours, and are bounded.
const examples = new Map<string, { scope: string; hash: string; label: string; expires: number }>();
function exampleScope(episode: Episode, line: LineRow, page: ImageRow, data: PageData) {
  return JSON.stringify([episode.id, page.id, line.id, data.prepared || data.original, line.x, line.y, line.w, line.h]);
}
function cleanLabel(data: PageData) {
  return `${data.cleanMethod || "Cleaned"}${data.cleanDurationMs == null ? "" : ` · ${(data.cleanDurationMs / 1000).toFixed(2)} s`}`;
}
export function saveCleanExample(episode: Episode, line: LineRow, page: ImageRow | undefined) {
  if (!page) throw new WorkflowError("Region has no page image");
  const data = getDoc<PageData>(`page:${page.id}`, {}).data;
  const hash = pageArtwork(data);
  if (!hash || hash === (data.prepared || data.original)) throw new WorkflowError("Clean this page before saving an example");
  for (const [id, value] of examples) if (value.expires < Date.now()) examples.delete(id);
  while (examples.size >= 100) examples.delete(examples.keys().next().value!);
  const token = randomUUID();
  examples.set(token, { scope: exampleScope(episode, line, page, data), hash, label: cleanLabel(data), expires: Date.now() + 2 * 60 * 60_000 });
  return { token };
}
async function labelFrame(frame: Frame, label: string): Promise<Frame> {
  const escaped = label.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
  const overlay = Buffer.from(`<svg width="${frame.width}" height="${frame.height}"><rect x="0.5" y="0.5" width="${Math.min(frame.width - 1, Math.ceil(label.length * 10 + 12))}" height="25" fill="#111111" fill-opacity="0.9" stroke="white" stroke-width="1"/><text x="5" y="19" font-family="sans-serif" font-size="16" font-weight="700" fill="white" stroke="black" stroke-width="1" paint-order="stroke fill">${escaped}</text></svg>`);
  const data = await sharp(frame.data, { raw: { width: frame.width, height: frame.height, channels: frame.channels as 3 } }).composite([{ input: overlay }]).removeAlpha().raw().toBuffer();
  return { ...frame, data, channels: 3 };
}

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
  exampleTokens: string[] = [],
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
  const scope = exampleScope(episode, line, page, doc.data);
  const saved = exampleTokens.slice(0, 10).map((token) => {
    const example = examples.get(token);
    if (!example || example.scope !== scope || example.expires < Date.now())
      throw new WorkflowError("Saved example expired or region changed. Clear examples and save again.");
    return example;
  });
  const variants = saved.filter((example, index) => saved.findIndex((other) => other.hash === example.hash && other.label === example.label) === index);
  if (!variants.some((example) => example.hash === cleanHash && example.label === cleanLabel(doc.data))) variants.push({ scope, hash: cleanHash, label: cleanLabel(doc.data), expires: 0 });
  const labeledRaw = await labelFrame(rawFrame, "Raw");
  const frames: Frame[] = [];
  for (const variant of variants) {
    const crop = variant.hash === cleanHash ? cleanFrame : await cropFrame(await readAsset(variant.hash), bubble);
    frames.push(labeledRaw, await labelFrame(crop, variant.label));
  }
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
