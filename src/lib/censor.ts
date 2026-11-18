/**
 * Censor boxes: solid black rectangles drawn in Translate/Review. They are burned into
 * the raw and typeset page images sent to proofreader models, and into exports when
 * the export asks for a censored copy. The artwork itself is never changed.
 *
 * Boxes live in their own `censor:<imageId>` document so Clean's page undo history
 * never removes them. Coordinates are fractions of the page (0–1), like regions.
 */
export type CensorRect = { id: string; x: number; y: number; w: number; h: number };
export type CensorData = { rects?: CensorRect[] };

export const censorDocId = (imageId: string) => `censor:${imageId}`;
export const MAX_CENSOR_RECTS = 200;

/** Clamp to the page and drop slivers; throws on malformed input. */
export function validateCensorRects(input: unknown): CensorRect[] {
  if (!Array.isArray(input)) throw new Error("Censor boxes must be a list");
  if (input.length > MAX_CENSOR_RECTS) throw new Error(`At most ${MAX_CENSOR_RECTS} censor boxes per page`);
  const out: CensorRect[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const r = item as Partial<CensorRect>;
    const id = typeof r?.id === "string" ? r.id.slice(0, 64) : "";
    if (!id || seen.has(id)) throw new Error("Each censor box needs a unique id");
    const nums = [r.x, r.y, r.w, r.h];
    if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) throw new Error("Censor box coordinates must be numbers");
    const x = Math.min(1, Math.max(0, r.x!)), y = Math.min(1, Math.max(0, r.y!));
    const w = Math.min(1, Math.max(0, r.x! + r.w!)) - x, h = Math.min(1, Math.max(0, r.y! + r.h!)) - y;
    if (w <= 0 || h <= 0) continue;
    seen.add(id);
    out.push({ id, x, y, w, h });
  }
  return out;
}

/** Whole-pixel boxes covering every touched pixel of a width×height image. */
export function censorPixelBoxes(rects: readonly CensorRect[] | undefined, width: number, height: number) {
  return (rects ?? []).flatMap((r) => {
    const left = Math.max(0, Math.floor(r.x * width)), top = Math.max(0, Math.floor(r.y * height));
    const right = Math.min(width, Math.ceil((r.x + r.w) * width)), bottom = Math.min(height, Math.ceil((r.y + r.h) * height));
    return right > left && bottom > top ? [{ left, top, width: right - left, height: bottom - top }] : [];
  });
}
