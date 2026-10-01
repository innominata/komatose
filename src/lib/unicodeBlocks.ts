/** The Unicode blocks the font inspector groups glyphs by. Not exhaustive: anything else reads "Other". */
const BLOCKS: [name: string, from: number, to: number][] = [
  ["Basic Latin", 0x0000, 0x007f],
  ["Latin-1 Supplement", 0x0080, 0x00ff],
  ["Latin Extended-A", 0x0100, 0x017f],
  ["Latin Extended-B", 0x0180, 0x024f],
  ["IPA Extensions", 0x0250, 0x02af],
  ["Spacing Modifier Letters", 0x02b0, 0x02ff],
  ["Combining Diacritical Marks", 0x0300, 0x036f],
  ["Greek and Coptic", 0x0370, 0x03ff],
  ["Cyrillic", 0x0400, 0x04ff],
  ["Cyrillic Supplement", 0x0500, 0x052f],
  ["Hebrew", 0x0590, 0x05ff],
  ["Arabic", 0x0600, 0x06ff],
  ["Thai", 0x0e00, 0x0e7f],
  ["Hangul Jamo", 0x1100, 0x11ff],
  ["Latin Extended Additional", 0x1e00, 0x1eff],
  ["Greek Extended", 0x1f00, 0x1fff],
  ["General Punctuation", 0x2000, 0x206f],
  ["Superscripts and Subscripts", 0x2070, 0x209f],
  ["Currency Symbols", 0x20a0, 0x20cf],
  ["Letterlike Symbols", 0x2100, 0x214f],
  ["Number Forms", 0x2150, 0x218f],
  ["Arrows", 0x2190, 0x21ff],
  ["Mathematical Operators", 0x2200, 0x22ff],
  ["Miscellaneous Technical", 0x2300, 0x23ff],
  ["Box Drawing", 0x2500, 0x257f],
  ["Block Elements", 0x2580, 0x259f],
  ["Geometric Shapes", 0x25a0, 0x25ff],
  ["Miscellaneous Symbols", 0x2600, 0x26ff],
  ["Dingbats", 0x2700, 0x27bf],
  ["CJK Symbols and Punctuation", 0x3000, 0x303f],
  ["Hiragana", 0x3040, 0x309f],
  ["Katakana", 0x30a0, 0x30ff],
  ["CJK Unified Ideographs", 0x4e00, 0x9fff],
  ["Hangul Syllables", 0xac00, 0xd7af],
  ["Private Use Area", 0xe000, 0xf8ff],
  ["Alphabetic Presentation Forms", 0xfb00, 0xfb4f],
  ["Halfwidth and Fullwidth Forms", 0xff00, 0xffef],
  ["Specials", 0xfff0, 0xffff],
  ["Symbols and Pictographs", 0x1f000, 0x1faff],
];

export function unicodeBlockOf(codepoint: number): string {
  for (const [name, from, to] of BLOCKS) if (codepoint >= from && codepoint <= to) return name;
  return "Other";
}

/** Blocks present in a font with how many characters each holds, in code point order. */
export function blocksIn(codepoints: number[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const cp of codepoints) {
    const name = unicodeBlockOf(cp);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const order = new Map(BLOCKS.map(([name], i) => [name, i]));
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => (order.get(a.name) ?? 999) - (order.get(b.name) ?? 999));
}

export const codepointLabel = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
