/**
 * Page breaks of a long-strip chapter, as positions on the continuous strip.
 *
 * The strip is every story page stacked top to bottom (narrower pages centred), exactly as
 * the server stitches it. A "break" is the y position where one page ends and the next
 * begins. Editing breaks and applying them is how a webtoon chapter is re-paginated: only
 * the pages around a changed break are reframed, so the rest keep their ids and work.
 */

export type StripPage = { id: string; top: number; width: number; height: number };
export type StripRange = { top: number; bottom: number };
export type StripSlice = StripRange;
export type StripPlacement = {
  imageId: string;
  rect: { x: number; y: number; width: number; height: number };
  x: number;
  y: number;
};
export type StripOutput = {
  id: string;
  width: number;
  height: number;
  placements: StripPlacement[];
  originalName?: string;
};
/** A run of consecutive page indices, inclusive, that a break edit reframes. */
export type StripRun = { start: number; end: number };

export function stripHeight(pages: readonly StripPage[]) {
  const last = pages.at(-1);
  return last ? last.top + last.height : 0;
}

/** The breaks the chapter has now: every page top except the first. */
export function currentBreaks(pages: readonly StripPage[]): number[] {
  return pages.slice(1).map((p) => p.top);
}

/** Whole, unique, sorted positions strictly inside the strip. */
export function normalizeBreaks(breaks: readonly number[], height: number): number[] {
  return [...new Set(breaks.map((b) => Math.round(b)))]
    .filter((b) => Number.isFinite(b) && b > 0 && b < height)
    .sort((a, b) => a - b);
}

export function sameBreaks(a: readonly number[], b: readonly number[]) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Added and removed positions, compared with the pages as they are. */
export function breakChanges(pages: readonly StripPage[], breaks: readonly number[]) {
  const now = new Set(currentBreaks(pages)), next = new Set(breaks);
  return {
    added: breaks.filter((b) => !now.has(b)),
    removed: [...now].filter((b) => !next.has(b)),
  };
}

function pageAt(pages: readonly StripPage[], y: number) {
  let lo = 0, hi = pages.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pages[mid].top <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The page runs a break edit touches. A new break reframes the page it falls in; removing a
 * page's top joins it with the page above. Touched pages that are next to each other form one
 * run, so each run is one consecutive reframe and pages between runs are left alone.
 */
export function breakRuns(pages: readonly StripPage[], breaks: readonly number[]): StripRun[] {
  const { added, removed } = breakChanges(pages, breaks);
  const touched = new Set<number>();
  for (const y of added) touched.add(pageAt(pages, y));
  for (const y of removed) {
    const i = pageAt(pages, y);
    touched.add(i);
    touched.add(i - 1);
  }
  const sorted = [...touched].filter((i) => i >= 0 && i < pages.length).sort((a, b) => a - b);
  const runs: StripRun[] = [];
  for (const i of sorted) {
    const last = runs.at(-1);
    if (last && i === last.end + 1) last.end = i;
    else runs.push({ start: i, end: i });
  }
  return runs;
}

/** The pages a run produces, top to bottom. */
export function runSlices(pages: readonly StripPage[], run: StripRun, breaks: readonly number[]): StripSlice[] {
  const top = pages[run.start].top, bottom = pages[run.end].top + pages[run.end].height;
  const bounds = [top, ...breaks.filter((b) => b > top && b < bottom), bottom];
  return bounds.slice(1).map((b, i) => ({ top: bounds[i], bottom: b }));
}

/** Slices taller than this need another break. */
export function oversizedSlices(height: number, breaks: readonly number[], allowed: number): StripSlice[] {
  const bounds = [0, ...breaks, height];
  return bounds.slice(1).flatMap((bottom, i) =>
    bottom - bounds[i] > allowed ? [{ top: bounds[i], bottom }] : []);
}

export function insideRange(y: number, ranges: readonly StripRange[]) {
  return ranges.find((r) => y > r.top && y < r.bottom);
}

/**
 * Reframe outputs for slices of the strip. Each output is as wide as the widest page it takes
 * pixels from (or `width` when given), with every source part centred, matching the stitch.
 *
 * With `reuseIds`, an output keeps the id of the source page it starts at, else of the source it
 * overlaps most, so a moved break keeps both pages (and their links, comments and history) and
 * only a genuinely new page gets a new id.
 */
export function sliceOutputs(
  sources: readonly (StripPage & { name: string })[],
  slices: readonly StripSlice[],
  opts: { newId: () => string; reuseIds?: boolean; width?: number },
): StripOutput[] {
  const counters = new Map<string, number>();
  const outputs = slices.map((slice) => {
    const parts = sources.filter((s) => s.top < slice.bottom && s.top + s.height > slice.top);
    const width = opts.width ?? Math.max(...parts.map((s) => s.width));
    const first = parts[0];
    const n = (counters.get(first.id) ?? 0) + 1;
    counters.set(first.id, n);
    return {
      id: "",
      width,
      height: slice.bottom - slice.top,
      originalName: `${first.name}-${n}.png`,
      placements: parts.map((s) => {
        const top = Math.max(s.top, slice.top), bottom = Math.min(s.top + s.height, slice.bottom);
        return {
          imageId: s.id,
          rect: { x: 0, y: top - s.top, width: s.width, height: bottom - top },
          x: Math.floor((width - s.width) / 2),
          y: top - slice.top,
        };
      }),
    } as StripOutput;
  });
  if (opts.reuseIds) {
    const used = new Set<string>();
    outputs.forEach((out, i) => {
      const start = sources.find((s) => s.top === slices[i].top);
      if (start && !used.has(start.id)) { out.id = start.id; used.add(start.id); }
    });
    outputs.forEach((out) => {
      if (out.id) return;
      const best = [...out.placements].sort((a, b) => b.rect.height - a.rect.height)
        .find((p) => !used.has(p.imageId));
      if (best) { out.id = best.imageId; used.add(best.imageId); }
    });
  }
  for (const out of outputs) {
    if (opts.reuseIds && out.id) delete out.originalName;
    if (!out.id) out.id = opts.newId();
  }
  return outputs;
}
