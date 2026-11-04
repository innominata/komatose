/**
 * Text dragged from a proofreader reply onto a region. The source is always Japanese or
 * Korean, so the writing system decides which field it replaces: kana, hangul or CJK
 * ideographs mean source lettering, Latin letters mean English.
 */

export type DropField = "source" | "english";

const SOURCE_CHAR = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\p{Script=Hangul}]/u;
const LATIN_CHAR = /\p{Script=Latin}/u;

/** Outer pairs a reply wraps quoted lettering in; never part of the lettering itself. */
const WRAPPERS: [string, string][] = [
  ['"', '"'], ["“", "”"], ["'", "'"], ["‘", "’"], ["「", "」"], ["『", "』"], ["**", "**"], ["*", "*"], ["`", "`"],
];

/** Trim, and peel quotes or markdown emphasis wrapping the whole selection. */
export function cleanDroppedText(text: string): string {
  let out = text.replace(/\r\n?/g, "\n").trim();
  for (let changed = true; changed; ) {
    changed = false;
    for (const [open, close] of WRAPPERS) {
      if (out.length > open.length + close.length && out.startsWith(open) && out.endsWith(close)) {
        const inner = out.slice(open.length, out.length - close.length);
        // Only a true wrapper: `"A" and "B"` keeps its quotes.
        if (inner.includes(open) || inner.includes(close)) continue;
        out = inner.trim();
        changed = true;
      }
    }
  }
  return out;
}

/** Which field a selection belongs to, by its letters; null when it has none of either. */
export function dropFieldFor(text: string): DropField | null {
  let source = 0, latin = 0;
  for (const char of text) {
    if (SOURCE_CHAR.test(char)) source++;
    else if (LATIN_CHAR.test(char)) latin++;
  }
  if (!source && !latin) return null;
  // One Japanese character outweighs several Latin ones (a kana word is short, English long),
  // so mixed text such as "Matte (待って)" stays with the majority by characters weighted 3:1.
  return source * 3 >= latin ? "source" : "english";
}

type Box = { id: string; x?: number | null; y?: number | null; w?: number | null; h?: number | null };

/** The region under a page point (fractions); the smallest box wins where regions overlap. */
export function regionAtPoint<T extends Box>(lines: readonly T[], point: { x: number; y: number }): T | undefined {
  let best: T | undefined, area = Infinity;
  for (const line of lines) {
    if (line.x == null || line.y == null || line.w == null || line.h == null) continue;
    if (point.x < line.x || point.x > line.x + line.w || point.y < line.y || point.y > line.y + line.h) continue;
    const size = line.w * line.h;
    if (size < area) { best = line; area = size; }
  }
  return best;
}
