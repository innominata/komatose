/** Font-safe English dash variants; source-language punctuation is left alone. */
export const TRANSLATION_DASHES = ["\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\u2015", "\u2212", "\ufe58", "\ufe63", "\uff0d"];
export function normalizeTranslation(text: string): string {
  return text.replace(/[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g, "-");
}
