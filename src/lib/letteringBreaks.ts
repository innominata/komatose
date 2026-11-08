/**
 * Quick lettering clean-up for the Typeset English box.
 *
 * `formatLettering` breaks the line after every , . ? ! (after the last mark of a run such
 * as "?!" or "..."), strips double quotes, and trims each line. A mark only breaks when a
 * space or the end follows it, so "3.5", "1,000" and "U.S." stay whole.
 */

const QUOTES = /["“”„‟]/g;
/** A run of sentence punctuation followed by spaces: the spaces become one line break. */
const BREAK_AFTER = /([,.?!…]+)[ \t]+/g;

export function formatLettering(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(QUOTES, "")
    .replace(BREAK_AFTER, "$1\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Ctrl-click on a space: the run of spaces at the caret becomes one line break, so neither
 * line keeps a trailing or leading space. Returns null when the caret is not on a space.
 */
export function breakAtSpace(text: string, caret: number): { text: string; caret: number } | null {
  let start = caret, end = caret;
  while (start > 0 && text[start - 1] === " ") start--;
  while (end < text.length && text[end] === " ") end++;
  if (start === end) return null;
  // A space at the very start or end of a line only needs removing, not a new empty line.
  const before = text.slice(0, start), after = text.slice(end);
  const edge = !before || before.endsWith("\n") || !after || after.startsWith("\n");
  return { text: before + (edge ? "" : "\n") + after, caret: start + (edge ? 0 : 1) };
}

/** Sentence-ending punctuation (not the last dot of i.e. or U.S.), any closing quotes or brackets, then the space before the next sentence. */
const SENTENCE_START = /(^|(?<!\.\p{L})[.?!…]+["'”’)\]]*\s+)(["'“‘(\[*-]*)(\p{L})/gu;
/** A lone "i" (also in i'm, i'll, i'd, i've), but not the "i" of "i.e.". */
const LONE_I = /(?<![\p{L}\p{N}'’])i(?![\p{L}\p{N}])(?!\.\p{L})/gu;

/**
 * Re-case shouted lettering (models often suggest ALL CAPS for caseless sources such as
 * Korean): everything lowercase except the start of each sentence and the word "I".
 * A comma line break does not start a sentence; ". ? ! …" followed by a space or new line does.
 * `names` (see `glossaryNames`) get their own capitals back wherever they appear as whole words.
 */
export function sentenceCase(text: string, names: string[] = []): string {
  let out = text
    .toLowerCase()
    .replace(SENTENCE_START, (_, end: string, open: string, letter: string) => end + open + letter.toUpperCase())
    .replace(LONE_I, "I");
  // Names keep the glossary's own capitals ("Ji-woo", "McAllen"); longer names go first so
  // "Min-jun Park" wins over "Min-jun".
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "giu");
    out = out.replace(pattern, () => name);
  }
  return out;
}

/** Glossary English written with capitals (characters, places): the forms sentence case restores. */
export function glossaryNames(terms: { translation?: string; aliases?: string[] }[]): string[] {
  const names = new Set<string>();
  for (const term of terms)
    for (const form of [term.translation ?? "", ...(term.aliases ?? [])]) {
      const name = form.trim();
      if (name && /\p{Lu}/u.test(name)) names.add(name);
    }
  return [...names];
}
