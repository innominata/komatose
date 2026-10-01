/** Revised Romanization of Korean, with vowel liaison across ㅇ onsets. */
const CHO = [
  "g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h",
];
const JUNG = [
  "a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i",
];
const JONG = [
  "", "k", "k", "ks", "n", "nj", "nh", "t", "l", "lk", "lm", "lb", "ls", "lt", "lp", "lh", "m", "p", "ps", "t", "t", "ng", "t", "t", "k", "t", "p", "t",
];
const JONG_LIAISON = [
  "", "g", "kk", "ks", "n", "nj", "nh", "d", "r", "lg", "lm", "lb", "ls", "lt", "lp", "lh", "m", "b", "ps", "s", "ss", "ng", "j", "ch", "k", "t", "p", "h",
];

function syllable(ch: string) {
  const code = ch.codePointAt(0)! - 0xac00;
  if (code < 0 || code > 11171) return null;
  return {
    cho: Math.floor(code / 588),
    jung: Math.floor((code % 588) / 28),
    jong: code % 28,
  };
}

export function romanizeKorean(text: string) {
  const chars = [...text];
  let out = "";
  let onset = "";
  for (let i = 0; i < chars.length; i++) {
    const parts = syllable(chars[i]);
    if (!parts) {
      out += onset + chars[i];
      onset = "";
      continue;
    }
    const next = i + 1 < chars.length ? syllable(chars[i + 1]) : null;
    const liaise = parts.jong > 0 && next?.cho === 11;
    out += onset + CHO[parts.cho] + JUNG[parts.jung];
    if (liaise) {
      onset = JONG_LIAISON[parts.jong];
    } else {
      out += JONG[parts.jong];
      onset = "";
    }
  }
  return out + onset;
}
