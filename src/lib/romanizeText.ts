const HANGUL = /[\uac00-\ud7af]/;
const JAPANESE = /[\u3040-\u30ff\u4e00-\u9fff\uff66-\uff9d\u3005]/;

export function hasHangul(text: string) {
  return HANGUL.test(text);
}

export function hasJapanese(text: string) {
  return JAPANESE.test(text);
}

export function needsRomanization(text: string) {
  return hasHangul(text) || hasJapanese(text);
}

export function isHangulChar(ch: string) {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0xac00 && code <= 0xd7af;
}

export function isJapaneseChar(ch: string) {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xff66 && code <= 0xff9d) ||
    code === 0x3005
  );
}

export type ScriptRun = { script: "ko" | "jp" | "other"; text: string };

export function scriptRuns(text: string): ScriptRun[] {
  const runs: ScriptRun[] = [];
  for (const ch of text) {
    const script: ScriptRun["script"] = isHangulChar(ch)
      ? "ko"
      : isJapaneseChar(ch)
        ? "jp"
        : "other";
    const last = runs.at(-1);
    if (last?.script === script) last.text += ch;
    else runs.push({ script, text: ch });
  }
  return runs;
}

export function displayRomanization(source: string, romanized: string) {
  const shown = romanized.replace(/[ \t]+/g, " ").trim();
  if (!shown) return "";
  if (shown.localeCompare(source.trim(), undefined, { sensitivity: "accent" }) === 0)
    return "";
  return shown;
}
