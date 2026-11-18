import { sqlite } from "./db";
import { composeDetections } from "./detect";
import { FUSION, type DetectorSource } from "./detectFusion";
import { getDoc } from "./workflowStore";
import type { WorkerRegion } from "./ocr";
import type { PageData } from "../workflow";

/**
 * Replays a series' recorded detector output through the fusion rules with different
 * thresholds, and scores each variant against the regions people kept. Detection is
 * deterministic given each detector's raw boxes, so this needs no models and runs in
 * seconds. A threshold can only be tightened this way: boxes below the confidence a
 * detector ran at were never recorded.
 */

type Box = { x: number; y: number; w: number; h: number };

export type TuningPage = {
  imageId: string;
  episodeId: string;
  width: number;
  height: number;
  outputs: Partial<Record<DetectorSource, WorkerRegion[]>>;
  /** The regions people kept: the answer key. */
  truth: Box[];
  /** Detections the reader dropped or found blank: filtered again, so neither right nor wrong. */
  filtered: Box[];
};

/** A page counts once someone has marked it done in any step, unless every page is asked for. */
export function tuningPages(seriesId: string, opts: { all?: boolean; episodeId?: string } = {}): TuningPage[] {
  // The newest run per page: the one its current regions came from.
  const runs = sqlite.prepare(
    `SELECT r.id, r.image_id, r.episode_id, r.width, r.height, r.outputs FROM detection_runs r
     JOIN images i ON i.id = r.image_id
     WHERE r.series_id=? ${opts.episodeId ? "AND r.episode_id=?" : ""}
       AND r.created_at = (SELECT MAX(created_at) FROM detection_runs q WHERE q.image_id = r.image_id)`,
  ).all(...(opts.episodeId ? [seriesId, opts.episodeId] : [seriesId])) as
    { id: string; image_id: string; episode_id: string; width: number; height: number; outputs: string }[];
  const truthOf = sqlite.prepare("SELECT x,y,w,h FROM lines WHERE image_id=? AND source_state != 'ignored' AND x IS NOT NULL");
  const filteredOf = sqlite.prepare("SELECT x,y,w,h FROM detection_regions WHERE run_id=? AND outcome IN ('dropped','auto-ignored')");
  return runs
    .filter((run) => opts.all || Object.keys(getDoc<PageData>(`page:${run.image_id}`, {}).data.completed ?? {}).length > 0)
    .map((run) => ({
      imageId: run.image_id,
      episodeId: run.episode_id,
      width: run.width,
      height: run.height,
      outputs: JSON.parse(run.outputs),
      truth: truthOf.all(run.image_id) as Box[],
      filtered: filteredOf.all(run.id) as Box[],
    }));
}

function overlap(a: Box, b: Box) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return ix * iy;
}
const iou = (a: Box, b: Box) => {
  const i = overlap(a, b);
  return i / (a.w * a.h + b.w * b.h - i || 1);
};
/** A detection finds a kept region when they overlap well, or one mostly holds the other (regions get reshaped). */
function matches(found: Box, kept: Box) {
  const i = overlap(found, kept);
  return iou(found, kept) >= 0.3 || i >= 0.6 * Math.min(found.w * found.h, kept.w * kept.h);
}

export type TuningScore = { found: number; falsePositives: number; missed: number; filtered: number; precision: number; recall: number };

export function scorePages(pages: TuningPage[]): TuningScore {
  let found = 0, falsePositives = 0, missed = 0, filtered = 0;
  for (const page of pages) {
    const regions = composeDetections(page.outputs, page.width, page.height).map((r) => r.place);
    const used = new Set<number>();
    for (const r of regions) {
      const k = page.truth.findIndex((t, j) => !used.has(j) && matches(r, t));
      if (k >= 0) {
        used.add(k);
        found += 1;
      } else if (page.filtered.some((f) => iou(r, f) >= 0.7)) filtered += 1;
      else falsePositives += 1;
    }
    missed += page.truth.length - used.size;
  }
  return {
    found, falsePositives, missed, filtered,
    precision: found + falsePositives ? found / (found + falsePositives) : 0,
    recall: found + missed ? found / (found + missed) : 0,
  };
}

/** The fusion settings a variant changes. */
export type FusionVariant = { label: string; alone?: Partial<typeof FUSION.alone>; adoptLettering?: boolean; adoptedScore?: number };

export function withFusion<T>(variant: FusionVariant, run: () => T): T {
  const saved = { alone: { ...FUSION.alone }, adoptLettering: FUSION.adoptLettering, adoptedScore: FUSION.adoptedScore };
  Object.assign(FUSION.alone, variant.alone ?? {});
  if (variant.adoptLettering !== undefined) FUSION.adoptLettering = variant.adoptLettering;
  if (variant.adoptedScore !== undefined) FUSION.adoptedScore = variant.adoptedScore;
  try {
    return run();
  } finally {
    Object.assign(FUSION.alone, saved.alone);
    FUSION.adoptLettering = saved.adoptLettering;
    FUSION.adoptedScore = saved.adoptedScore;
  }
}

/** One threshold at a time, then the best of each together. */
export function fusionVariants(): FusionVariant[] {
  const steps = [0.5, 0.6, 0.7, 0.8, 0.9];
  const out: FusionVariant[] = [];
  for (const key of ["ctd", "rtdetrBubble", "rtdetrFree"] as const)
    for (const v of steps) if (v > FUSION.alone[key]) out.push({ label: `${key} alone ≥ ${v}`, alone: { [key]: v } });
  out.push({ label: "No regions from the lettering mask alone", adoptLettering: false });
  return out;
}

export type TuningResult = { variant: FusionVariant; score: TuningScore };

export function tuneFusion(pages: TuningPage[]): { baseline: TuningScore; results: TuningResult[]; combined?: TuningResult } {
  const baseline = scorePages(pages);
  const results = fusionVariants().map((variant) => ({ variant, score: withFusion(variant, () => scorePages(pages)) }));
  // Keep a change when it removes more false positives than the regions it loses.
  const worth = (r: TuningResult) => (baseline.falsePositives - r.score.falsePositives) - 2 * (baseline.found - r.score.found);
  const best = new Map<string, TuningResult>();
  for (const r of results) {
    const key = r.variant.alone ? Object.keys(r.variant.alone)[0] : "adopt";
    if (worth(r) > 0 && (!best.get(key) || worth(r) > worth(best.get(key)!))) best.set(key, r);
  }
  let combined: TuningResult | undefined;
  if (best.size > 1) {
    const variant: FusionVariant = {
      label: [...best.values()].map((r) => r.variant.label).join(" + "),
      alone: Object.assign({}, ...[...best.values()].map((r) => r.variant.alone ?? {})),
      ...([...best.values()].some((r) => r.variant.adoptLettering === false) ? { adoptLettering: false } : {}),
    };
    combined = { variant, score: withFusion(variant, () => scorePages(pages)) };
  }
  return { baseline, results: results.sort((a, b) => worth(b) - worth(a)), combined };
}
