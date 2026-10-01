import Kuroshiro from "kuroshiro";
import KuromojiAnalyzer from "kuroshiro-analyzer-kuromoji";
import { romanizeKorean } from "../romanizeKorean";
import { displayRomanization, needsRomanization, scriptRuns } from "../romanizeText";

type Ctor<T> = new () => T;
function ctor<T>(mod: unknown): Ctor<T> {
  const value = mod as { default?: Ctor<T> } | Ctor<T>;
  return typeof value === "function" ? value : (value as { default: Ctor<T> }).default;
}

const KuroshiroClass = ctor<Kuroshiro>(Kuroshiro);
const AnalyzerClass = ctor<KuromojiAnalyzer>(KuromojiAnalyzer);

let japanese: Promise<Kuroshiro> | undefined;

function kuroshiro() {
  japanese ??= (async () => {
    const converter = new KuroshiroClass();
    await converter.init(new AnalyzerClass());
    return converter;
  })();
  return japanese;
}

async function romanizeJapanese(text: string) {
  return (await kuroshiro()).convert(text, {
    to: "romaji",
    mode: "spaced",
    romajiSystem: "hepburn",
  });
}

export async function romanizePhrase(text: string) {
  const source = text.normalize("NFC");
  if (!needsRomanization(source)) return "";
  let out = "";
  for (const run of scriptRuns(source)) {
    if (run.script === "ko") out += romanizeKorean(run.text);
    else if (run.script === "jp") out += await romanizeJapanese(run.text);
    else out += run.text;
  }
  return displayRomanization(source, out);
}

export async function romanizePhrases(texts: string[]) {
  const unique = [...new Set(texts.map((text) => text.normalize("NFC")))];
  const converted = new Map<string, string>();
  for (const text of unique) converted.set(text, await romanizePhrase(text));
  return texts.map((text) => converted.get(text.normalize("NFC")) ?? "");
}
