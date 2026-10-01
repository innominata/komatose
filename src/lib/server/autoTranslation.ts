import type { DetectedRegion } from "./detect";
import type { DetectedBox, ProofreadItem } from "./llm";
import { isMeaningfulSource } from "./ocr";

type Reading = { source: string; lineType: DetectedBox["lineType"]; ocrConfidence?: number };

/** Unknown regions are deliberately treated as image-model work, never OCR. */
export async function recognizeRegion(
  kind: DetectedRegion["kind"],
  readers: {
    ocr: () => Promise<{ source: string; score: number }>;
    vision: () => Promise<Reading>;
    abort?: AbortSignal;
  },
): Promise<Reading> {
  readers.abort?.throwIfAborted();
  if (kind === "bubble") {
    try {
      const read = await readers.ocr();
      if (read.score >= 0.95 && isMeaningfulSource(read.source, read.score))
        return { source: read.source, lineType: '""', ocrConfidence: read.score };
    } catch (error) {
      readers.abort?.throwIfAborted();
      // An unavailable OCR worker also falls back to the image model.
    }
  }
  readers.abort?.throwIfAborted();
  const read = await readers.vision();
  readers.abort?.throwIfAborted();
  return { source: isMeaningfulSource(read.source, 1) ? read.source : "", lineType: read.lineType };
}

/** Polish before publishing so a fresh translation needs only one human review. */
export async function polishTranslation(
  boxes: DetectedBox[],
  proofread: (items: ProofreadItem[]) => Promise<Map<number, { translation: string; reasoning: string }>>,
  abort?: AbortSignal,
): Promise<DetectedBox[]> {
  const result = boxes.map(box => ({ ...box }));
  for (let start = 0; start < boxes.length; start += 32) {
    abort?.throwIfAborted();
    const items = boxes.slice(start, start + 32).map((box, offset) => ({
      i: start + offset, page: "Current page", lineType: box.lineType,
      source: box.source, literal: box.literal, current: box.translation, notes: box.reasoning,
    }));
    const corrections = await proofread(items);
    abort?.throwIfAborted();
    for (const item of items) {
      const correction = corrections.get(item.i);
      if (!correction?.translation.trim()) continue;
      result[item.i].translation = correction.translation.trim();
      if (correction.reasoning) result[item.i].reasoning =
        [result[item.i].reasoning, `Proofread: ${correction.reasoning}`].filter(Boolean).join("\n");
    }
  }
  return result;
}
