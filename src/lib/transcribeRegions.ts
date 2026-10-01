import { ocrComparableKey } from "./ocrConsensus";

export type TranscriptRegion = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Agreed source, or the fullest reading when the models did not agree. */
  source: string;
  /** Every letter in the reading is Latin. Digits and source-script text are not. */
  english?: boolean;
};

const SOURCE_SCRIPT = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;

function visible(source: string): string {
  return source.normalize("NFKC").replace(/<[^>\s]{1,40}>/g, "");
}

/** Latin lettering with no Japanese or Korean script, at least two letters. */
export function isAlreadyEnglish(source: string): boolean {
  const letters = [...visible(source)].filter((ch) => /\p{L}/u.test(ch));
  if (letters.length < 2) return false;
  if (letters.some((ch) => SOURCE_SCRIPT.test(ch))) return false;
  const latin = letters.filter((ch) => /\p{Script=Latin}/u.test(ch)).length;
  return latin / letters.length >= 0.8;
}

export function transcriptionOverlapSource(agreed: string, readings: string[]): string {
  const agreedText = agreed.trim();
  if (hasReading(agreedText)) return agreedText;
  const ranked = readings
    .map((source) => source.trim())
    .filter(hasReading)
    .sort((a, b) => readingKey(b).length - readingKey(a).length);
  return ranked[0] || "";
}

/** True when every lettered reading is already English. */
export function transcriptionIsEnglish(agreed: string, readings: string[]): boolean {
  const samples = [agreed, ...readings].map((source) => source.trim()).filter((source) =>
    /\p{L}/u.test(readingKey(source)),
  );
  return samples.length > 0 && samples.every(isAlreadyEnglish);
}

function readingKey(source: string): string {
  return ocrComparableKey(visible(source));
}

function hasReading(source: string): boolean {
  return /[\p{L}\p{N}]/u.test(readingKey(source));
}

function area(region: TranscriptRegion): number {
  return Math.max(0, region.w) * Math.max(0, region.h);
}

/** Fraction of `inner` that lies inside `outer`. */
function coverage(inner: TranscriptRegion, outer: TranscriptRegion): number {
  const width = Math.max(0, Math.min(inner.x + inner.w, outer.x + outer.w) - Math.max(inner.x, outer.x));
  const height = Math.max(0, Math.min(inner.y + inner.h, outer.y + outer.h) - Math.max(inner.y, outer.y));
  const innerArea = area(inner);
  return innerArea <= 0 ? 0 : (width * height) / innerArea;
}

/** How much of `parent` is spelled by `parts`, longest part first. */
function coveredFraction(parent: string, parts: string[]): number {
  let rest = parent;
  for (const part of [...parts].sort((a, b) => b.length - a.length)) {
    const at = rest.indexOf(part);
    if (at >= 0) rest = rest.slice(0, at) + rest.slice(at + part.length);
  }
  return parent.length ? (parent.length - rest.length) / parent.length : 0;
}

/**
 * Regions transcription should not save.
 *
 * A box nested in another is dropped when its text is already in that box.
 * The outer box is dropped instead when two or more inner boxes already
 * account for its text, so separate balloons stay separate. English lettering
 * is dropped unless the chapter asked for it. An empty box sitting on
 * lettering that was kept, or on English that was skipped, is dropped too.
 */
export function dropRedundantTranscriptions(
  regions: TranscriptRegion[],
  opts?: { includeEnglish?: boolean },
): Set<string> {
  const drop = new Set<string>();
  const includeEnglish = opts?.includeEnglish === true;
  if (!includeEnglish) {
    for (const region of regions) if (region.english) drop.add(region.id);
  }

  const live = () => regions.filter((region) => !drop.has(region.id) && hasReading(region.source));

  for (const region of live()) {
    if (drop.has(region.id)) continue;
    for (const other of live()) {
      if (other.id === region.id || drop.has(other.id) || drop.has(region.id)) continue;
      if (readingKey(region.source) !== readingKey(other.source)) continue;
      if (Math.max(coverage(region, other), coverage(other, region)) < 0.65) continue;
      drop.add(area(region) <= area(other) ? other.id : region.id);
    }
  }

  const parents = live().slice().sort((a, b) => area(b) - area(a));
  for (const parent of parents) {
    if (drop.has(parent.id)) continue;
    const parentKey = readingKey(parent.source);
    const nested = live().filter((child) => {
      if (child.id === parent.id || drop.has(child.id)) return false;
      if (!(area(child) < area(parent) * 0.85)) return false;
      if (coverage(child, parent) < 0.65) return false;
      const childKey = readingKey(child.source);
      return Boolean(childKey) && parentKey.includes(childKey);
    });
    if (!nested.length) continue;
    const identical = nested.filter((child) => readingKey(child.source) === parentKey);
    if (identical.length === nested.length) {
      drop.add(parent.id);
      continue;
    }
    const parts = nested.filter((child) => readingKey(child.source) !== parentKey);
    if (parts.length >= 2 && coveredFraction(parentKey, parts.map((part) => readingKey(part.source))) >= 0.8)
      drop.add(parent.id);
    else
      for (const child of nested) drop.add(child.id);
  }

  const keptText = regions.filter((region) => !drop.has(region.id) && hasReading(region.source));
  const skippedEnglish = includeEnglish ? [] : regions.filter((region) => region.english);
  for (const region of regions) {
    if (drop.has(region.id) || hasReading(region.source)) continue;
    const onKept = keptText.some((other) => coverage(region, other) >= 0.65);
    const onEnglish = skippedEnglish.some((other) => coverage(region, other) >= 0.65);
    if (onKept || onEnglish) drop.add(region.id);
  }
  return drop;
}
