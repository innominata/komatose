import { CHAR_STYLE_KEYS, type CharRun, type CharStyle } from "./workflow";

const NUMERIC: Record<string, [number, number]> = {
  size: [10, 400],
  fillOpacity: [0, 100],
  outlineOpacity: [0, 100],
  outlineWidth: [0, 20],
  tracking: [-500, 2000],
  baselineShift: [-200, 200],
  horizontalScale: [10, 400],
  verticalScale: [10, 400],
};

/** The valid fields of a character style; anything malformed is dropped rather than clamped to a guess. */
export function pickCharStyle(input: unknown): CharStyle {
  if (!input || typeof input !== "object") return {};
  const rec = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of CHAR_STYLE_KEYS) {
    const v = rec[key];
    if (v === undefined || v === null || v === "") continue;
    if (key in NUMERIC) {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      const [min, max] = NUMERIC[key];
      out[key] = Math.min(max, Math.max(min, n));
    } else if (key === "fill" || key === "outline") {
      if (typeof v === "string" && /^#[a-f\d]{6}$/i.test(v)) out[key] = v.toLowerCase();
    } else if (key === "emphasis") {
      if (v === "normal" || v === "bold" || v === "italic") out[key] = v;
    } else if (key === "fontId") {
      if (typeof v === "string") out[key] = v;
    }
  }
  return out as CharStyle;
}

const sameStyle = (a: CharStyle, b: CharStyle) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k as keyof CharStyle] === b[k as keyof CharStyle]);
};

/** Style of every character of a `length`-long body; later runs win where runs overlap. */
function perChar(runs: CharRun[] | undefined, length: number): CharStyle[] {
  const out: CharStyle[] = Array.from({ length }, () => ({}));
  for (const run of runs ?? []) {
    const start = Math.max(0, Math.floor(run.start));
    const end = Math.min(length, Math.floor(run.end));
    const style = pickCharStyle(run.style);
    for (let i = start; i < end; i++) out[i] = { ...out[i], ...style };
  }
  return out;
}

function toRuns(chars: CharStyle[]): CharRun[] {
  const runs: CharRun[] = [];
  for (let i = 0; i < chars.length; i++) {
    const style = chars[i];
    if (!Object.keys(style).length) continue;
    const last = runs.at(-1);
    if (last && last.end === i && sameStyle(last.style, style)) last.end = i + 1;
    else runs.push({ start: i, end: i + 1, style });
  }
  return runs;
}

/** Sorted, non-overlapping, merged runs inside a body of `length` characters. */
export function normalizeCharRuns(runs: unknown, length: number): CharRun[] {
  if (!Array.isArray(runs)) return [];
  const valid = runs.filter(
    (r): r is CharRun =>
      !!r && typeof r === "object" && Number.isFinite((r as CharRun).start) && Number.isFinite((r as CharRun).end),
  );
  return toRuns(perChar(valid, length));
}

/**
 * Applies `patch` to [start, end). A key set to `undefined` (or `null`) in the patch clears
 * that override so the characters follow the region style again.
 */
export function applyCharStyle(
  runs: CharRun[] | undefined,
  length: number,
  start: number,
  end: number,
  patch: Record<string, unknown>,
): CharRun[] {
  const chars = perChar(runs, length);
  const set = pickCharStyle(patch);
  const clear = Object.keys(patch).filter((k) => patch[k] === undefined || patch[k] === null);
  for (let i = Math.max(0, start); i < Math.min(length, end); i++) {
    const next: Record<string, unknown> = { ...chars[i], ...set };
    for (const k of clear) delete next[k];
    chars[i] = next as CharStyle;
  }
  return toRuns(chars);
}

/** The overrides shared by every character of [start, end), for showing a selection's style. */
export function commonCharStyle(runs: CharRun[] | undefined, length: number, start: number, end: number): CharStyle {
  const chars = perChar(runs, length).slice(Math.max(0, start), Math.max(start + 1, end));
  if (!chars.length) return {};
  const out: Record<string, unknown> = { ...chars[0] };
  for (const c of chars.slice(1))
    for (const k of Object.keys(out)) if (out[k] !== c[k as keyof CharStyle]) delete out[k];
  return out as CharStyle;
}

/**
 * Carries runs written for body `from` over to body `to` by their common prefix and suffix.
 * Text typed into the changed span takes the style of the character before it, as in
 * Photoshop; deleted characters take their style with them.
 */
export function remapCharRuns(runs: CharRun[] | undefined, from: string | undefined, to: string): CharRun[] {
  if (!runs?.length) return [];
  if (from === undefined || from === to) return normalizeCharRuns(runs, to.length);
  const chars = perChar(runs, from.length);
  let pre = 0;
  while (pre < from.length && pre < to.length && from[pre] === to[pre]) pre++;
  let suf = 0;
  while (
    suf < from.length - pre &&
    suf < to.length - pre &&
    from[from.length - 1 - suf] === to[to.length - 1 - suf]
  )
    suf++;
  const inserted = to.length - pre - suf;
  const fill = pre > 0 ? chars[pre - 1] : (chars[from.length - suf] ?? {});
  const next = [
    ...chars.slice(0, pre),
    ...Array.from({ length: inserted }, () => ({ ...fill })),
    ...chars.slice(from.length - suf),
  ];
  return toRuns(next);
}

/** Every run's font id, for checking they all belong to the series. */
export function charRunFonts(runs: CharRun[] | undefined): string[] {
  return [...new Set((runs ?? []).map((r) => r.style.fontId).filter((f): f is string => !!f))];
}
