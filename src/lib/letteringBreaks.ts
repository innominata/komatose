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
