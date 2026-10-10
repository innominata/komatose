import type { GlossaryTerm } from './types';

export type HangulKey = { glyph: string; reading: string };
const keys = (glyphs: string, readings: string): HangulKey[] =>
  glyphs.split(' ').map((glyph, i) => ({ glyph, reading: readings.split(' ')[i] }));

// Unicode modern Hangul composition order. Final readings describe their usual
// syllable-final sound; compound spellings are shown to aid visual matching.
export const HANGUL_INITIALS = keys(
  'ㄱ ㄲ ㄴ ㄷ ㄸ ㄹ ㅁ ㅂ ㅃ ㅅ ㅆ ㅇ ㅈ ㅉ ㅊ ㅋ ㅌ ㅍ ㅎ',
  'g/k kk n d/t tt r/l m b/p pp s ss silent j jj ch k t p h',
);
export const HANGUL_VOWELS = keys(
  'ㅏ ㅐ ㅑ ㅒ ㅓ ㅔ ㅕ ㅖ ㅗ ㅘ ㅙ ㅚ ㅛ ㅜ ㅝ ㅞ ㅟ ㅠ ㅡ ㅢ ㅣ',
  'a ae ya yae eo e yeo ye o wa wae oe yo u wo we wi yu eu ui i',
);
export const HANGUL_FINALS: HangulKey[] = [
  { glyph: '', reading: 'None' },
  ...keys('ㄱ ㄲ ㄳ ㄴ ㄵ ㄶ ㄷ ㄹ ㄺ ㄻ ㄼ ㄽ ㄾ ㄿ ㅀ ㅁ ㅂ ㅄ ㅅ ㅆ ㅇ ㅈ ㅊ ㅋ ㅌ ㅍ ㅎ',
    'k k g+s n n+j n+h t l l+g l+m l+b l+s l+t l+p l+h m p b+s t t ng t t k t p t'),
];

export function composeHangul(initial: number, vowel: number, final = 0): string {
  if (!Number.isInteger(initial) || initial < 0 || initial >= 19 ||
      !Number.isInteger(vowel) || vowel < 0 || vowel >= 21 ||
      !Number.isInteger(final) || final < 0 || final >= 28) return '';
  return String.fromCodePoint(0xac00 + (initial * 21 + vowel) * 28 + final);
}

export function isCharacterEntryLang(lang?: string | null) {
  return lang === 'japanese' || lang === 'korean';
}

export function koreanGlossaryTerms(terms: GlossaryTerm[]): GlossaryTerm[] {
  const found = new Map<string, GlossaryTerm>();
  for (const term of terms) {
    const source = term.source.trim();
    if (!/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3]/u.test(source)) continue;
    const existing = found.get(source);
    if (!existing || (term.edited && !existing.edited)) {
      found.set(source, { ...term, source, translation: term.translation.trim() || existing?.translation || '' });
    }
  }
  return [...found.values()];
}

export function replaceEntrySelection(text: string, start: number, end: number, inserted: string) {
  return { text: text.slice(0, start) + inserted + text.slice(end), caret: start + inserted.length };
}

export function deleteEntrySelection(text: string, start: number, end: number) {
  const from = start === end ? start - ([...text.slice(0, start)].at(-1)?.length ?? 0) : start;
  return replaceEntrySelection(text, from, end, '');
}
