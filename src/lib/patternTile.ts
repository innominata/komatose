/**
 * Finds a tile that repeats seamlessly inside a sampled patch of screentone.
 *
 * A screentone is a lattice: shifting it by a lattice vector maps it onto itself. Each axis is
 * analysed alone: the correlation of the patch with itself shifted `s` px across (or down)
 * peaks at the repeat distance. A 45° dot screen of pitch p repeats every p·√2 px along each
 * axis, so axis-aligned tiles exist for rotated screens too. The repeat is rarely a whole
 * number of pixels, so the tile spans the fewest repeats that land within a fraction of a
 * pixel of a whole number, and the seam is checked at that exact size.
 *
 * Pure (grayscale pixels in, rectangle out) so it can be tested without images.
 */

export type AxisRepeat =
  | { kind: "uniform" }
  | { kind: "periodic"; period: number; length: number; score: number }
  | { kind: "none"; reason: string };

export type TileResult =
  | { ok: true; x: number; y: number; width: number; height: number; across: AxisRepeat; down: AxisRepeat }
  | { ok: false; reason: string; across: AxisRepeat; down: AxisRepeat };

/** Largest repeat looked for, in px. Screentones repeat every few to a few dozen pixels. */
const MAX_PERIOD = 200;
/** Analysis looks at most this many pixels along each axis, from the middle of the patch. */
const WINDOW = 480;
/** A peak must correlate at least this well for the patch to count as repeating. */
const MIN_PEAK = 0.5;
/** A seam must match at least this well. */
const MIN_SEAM = 0.75;
/** Correlation everywhere above this: the patch does not change along the axis. */
const UNIFORM = 0.95;
/** Tile length used along an axis the patch does not change along. */
const UNIFORM_LENGTH = 16;

type Gray = { data: ArrayLike<number>; width: number; height: number };

/** Pearson correlation of the patch with itself shifted by (dx, dy), over the overlap. */
export function shiftCorrelation(img: Gray, dx: number, dy: number): number {
  const { data, width, height } = img;
  const w = width - dx, h = height - dy;
  if (w <= 0 || h <= 0) return 0;
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = 0; y < h; y++) {
    let ia = y * width, ib = (y + dy) * width + dx;
    for (let x = 0; x < w; x++, ia++, ib++) {
      const a = data[ia], b = data[ib];
      sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
    }
  }
  const n = w * h;
  const va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
  // A flat overlap matches any shift of itself.
  if (va < 1e-6 * n && vb < 1e-6 * n) return 1;
  if (va < 1e-6 * n || vb < 1e-6 * n) return 0;
  return (sab - (sa * sb) / n) / Math.sqrt(va * vb);
}

/** The middle `WINDOW`-sized part of the patch, which keeps the analysis fast on big samples. */
function window(img: Gray): Gray {
  const w = Math.min(img.width, WINDOW), h = Math.min(img.height, WINDOW);
  if (w === img.width && h === img.height) return img;
  const x0 = Math.floor((img.width - w) / 2), y0 = Math.floor((img.height - h) / 2);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = img.data[(y + y0) * img.width + x + x0];
  return { data: out, width: w, height: h };
}

/** The repeat along one axis (`across`: x, else y) of a patch `size` px long on that axis. */
export function axisRepeat(img: Gray, across: boolean): AxisRepeat {
  const view = window(img);
  const size = across ? view.width : view.height;
  const full = across ? img.width : img.height;
  const max = Math.min(MAX_PERIOD, Math.floor(size / 2));
  if (max < 2) return { kind: "none", reason: "the selection is too small" };
  const c = [1];
  for (let s = 1; s <= max; s++) c.push(across ? shiftCorrelation(view, s, 0) : shiftCorrelation(view, 0, s));
  if (Math.min(...c) >= UNIFORM) return { kind: "uniform" };
  // Skip the slope out of zero shift (neighbouring pixels always look alike), then take peaks.
  let s0 = 1;
  while (s0 < max && c[s0 + 1] <= c[s0]) s0++;
  const peaks: number[] = [];
  for (let s = Math.max(2, s0); s < max; s++) if (c[s] >= c[s - 1] && c[s] >= c[s + 1] && c[s] > c[s0]) peaks.push(s);
  if (!peaks.length) return { kind: "none", reason: `no repeat up to ${max} px (select at least two repeats of the tone)` };
  const best = Math.max(...peaks.map((s) => c[s]));
  if (best < MIN_PEAK) return { kind: "none", reason: "the texture does not repeat regularly" };
  // The first peak nearly as strong as the best is the repeat; later ones are its multiples.
  const s = peaks.find((p) => c[p] >= best - 0.08)!;
  const a = c[s - 1], b = c[s], d = c[s + 1];
  const bend = a - 2 * b + d;
  const period = s + (Math.abs(bend) > 1e-9 ? Math.max(-0.5, Math.min(0.5, (a - d) / (2 * bend))) : 0);
  // The fewest repeats that land on whole pixels, leaving room in the patch to check the seam.
  const room = full - Math.max(8, Math.ceil(period));
  let choice: { length: number; off: number } | null = null;
  for (let k = 1; k * period <= room; k++) {
    const length = Math.round(k * period), off = Math.abs(k * period - length);
    if (!choice || off < choice.off) choice = { length, off };
    if (off <= 0.15) break;
  }
  if (!choice) return { kind: "none", reason: `the tone repeats every ${period.toFixed(1)} px; select a larger area` };
  const score = across ? shiftCorrelation(img, choice.length, 0) : shiftCorrelation(img, 0, choice.length);
  if (score < MIN_SEAM || score < best - 0.2)
    return { kind: "none", reason: `a ${choice.length} px tile does not meet itself cleanly; select a larger or more even area` };
  return { kind: "periodic", period, length: choice.length, score };
}

/** The tile to cut from the patch, centred in it, or why none repeats cleanly. */
export function findTile(img: Gray): TileResult {
  const across = axisRepeat(img, true);
  const down = axisRepeat(img, false);
  const fail = [across, down].find((r): r is Extract<AxisRepeat, { kind: "none" }> => r.kind === "none");
  if (fail) {
    const which = across.kind === "none" && down.kind === "none" ? "" : across.kind === "none" ? "Across: " : "Down: ";
    return { ok: false, reason: which + fail.reason, across, down };
  }
  const len = (r: AxisRepeat, full: number) => (r.kind === "periodic" ? r.length : Math.min(full, UNIFORM_LENGTH));
  const width = len(across, img.width), height = len(down, img.height);
  return {
    ok: true,
    x: Math.floor((img.width - width) / 2),
    y: Math.floor((img.height - height) / 2),
    width,
    height,
    across,
    down,
  };
}
