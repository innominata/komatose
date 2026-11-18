import { sqlite } from "./db";
import { nid } from "./ids";
import { getDoc } from "./workflowStore";
import type { DetectedRegion } from "./detect";
import type { WorkerRegion } from "./ocr";
import type { RegionData } from "../workflow";

/**
 * A record of what text detection found on each page, kept however the regions are edited
 * afterwards. A region deleted or ignored by hand is a false positive of the detectors that
 * found it, so a series can see which detectors, scores and kinds of box it should stop
 * trusting. Each page's raw detector output is kept too, so the fusion rules can be replayed
 * against the regions people actually kept (scripts/tune-detection.ts).
 */

/** How a detected region was first saved. */
export type DetectionOutcome = "saved" | "auto-ignored" | "dropped";

export function recordDetectionRun(opts: {
  seriesId: string;
  episodeId: string;
  imageId: string;
  setup: string;
  conf?: number;
  width: number;
  height: number;
  outputs: Record<string, WorkerRegion[]>;
}): string {
  const id = nid();
  // Contours are geometry, not evidence: replaying fusion needs boxes, scores and classes.
  const outputs = Object.fromEntries(
    Object.entries(opts.outputs).map(([part, regions]) => [part, regions.map(({ polygon: _p, ...r }) => r)]),
  );
  const prior = (sqlite.prepare("SELECT id FROM lines WHERE episode_id=? AND image_id=?").all(opts.episodeId, opts.imageId) as { id: string }[])
    .map((r) => r.id);
  sqlite.prepare(
    "INSERT INTO detection_runs(id,series_id,episode_id,image_id,setup,conf,width,height,outputs,prior_lines,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  ).run(id, opts.seriesId, opts.episodeId, opts.imageId, opts.setup, opts.conf ?? null, opts.width, opts.height,
    JSON.stringify(outputs), JSON.stringify(prior), Date.now());
  return id;
}

export function recordDetectedRegion(opts: {
  runId: string;
  seriesId: string;
  episodeId: string;
  imageId: string;
  lineId?: string;
  region: DetectedRegion;
  outcome: DetectionOutcome;
  reason?: string;
}) {
  const p = opts.region.provenance ?? {};
  const place = opts.region.place;
  // A detector that reports no source of its own (the geometric fallback) is the run's base.
  const sources = p.sources?.length ? p.sources : p.backend ? [p.backend]
    : [((sqlite.prepare("SELECT setup FROM detection_runs WHERE id=?").get(opts.runId) as { setup?: string } | undefined)?.setup ?? "").split("+")[0]].filter(Boolean);
  sqlite.prepare(
    `INSERT INTO detection_regions(id,run_id,series_id,episode_id,image_id,line_id,x,y,w,h,kind,cls,score,sources,scores,outcome,reason,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(nid(), opts.runId, opts.seriesId, opts.episodeId, opts.imageId, opts.lineId ?? null,
    place.x, place.y, place.w, place.h, opts.region.kind, p.cls ?? "", Math.round(opts.region.score * 1000) / 1000,
    JSON.stringify(sources), JSON.stringify(p.scores ?? {}),
    opts.outcome, opts.reason ?? "", Date.now());
}

/** Notes how detected regions left a chapter: a single delete is a rejection, a page clear is not. */
export function markDetectedRegionsRemoved(lineIds: string[], via: string) {
  if (!lineIds.length) return;
  const marks = lineIds.map(() => "?").join(",");
  sqlite.prepare(`UPDATE detection_regions SET removed_via=?, removed_at=? WHERE removed_at IS NULL AND line_id IN (${marks})`)
    .run(via, Date.now(), ...lineIds);
}

/** A deletion undone: the regions are back, and a later delete is recorded afresh. */
export function unmarkDetectedRegionsRemoved(lineIds: string[]) {
  if (!lineIds.length) return;
  const marks = lineIds.map(() => "?").join(",");
  sqlite.prepare(`UPDATE detection_regions SET removed_via=NULL, removed_at=NULL WHERE line_id IN (${marks})`).run(...lineIds);
}

// ── Report ────────────────────────────────────────────────────────────────

/**
 * Where a detected region ended up.
 * - kept / reshaped: still there (reshaped: its box was moved or resized well away from the detection).
 * - removed: deleted on its own, or with Remove blank regions. A false positive.
 * - ignored: marked ignored by hand. A false positive.
 * - auto-removed: ignored by the Director, or deleted by automation (duplicates, imports).
 * - cleared: deleted with the rest of its page (as before detecting again). Not counted.
 * - auto-ignored: the reader found no text when it was saved, so it was never shown.
 * - dropped: the reader dropped it before saving (a repeat of another region, or mask-only lettering it could not read).
 */
export type FinalOutcome = "kept" | "reshaped" | "removed" | "ignored" | "auto-removed" | "cleared" | "auto-ignored" | "dropped";

export type DetectionRow = {
  id: string;
  episodeId: string;
  imageId: string;
  x: number; y: number; w: number; h: number;
  kind: string;
  score: number;
  sources: string[];
  scores: Record<string, number>;
  outcome: FinalOutcome;
  reason: string;
};

export type OutcomeCounts = Record<FinalOutcome, number> & {
  total: number;
  /** Regions people saw: kept, reshaped and the false positives. */
  shown: number;
  /** Removed, ignored or removed automatically. */
  rejected: number;
};

export type DetectionGroup = OutcomeCounts & { key: string; label: string };

export type DetectionReport = {
  runs: number;
  pages: number;
  setups: { setup: string; pages: number }[];
  totals: OutcomeCounts;
  /** Regions drawn by hand on detected pages: what detection missed. */
  addedByHand: number;
  bySources: DetectionGroup[];
  byScore: DetectionGroup[];
  byKind: DetectionGroup[];
  /** Detector combination × score band with the most rejections, worst first. */
  hotspots: DetectionGroup[];
  byEpisode: (DetectionGroup & { addedByHand: number })[];
  /** Recent false positives, newest first, for a look at what they are. */
  rejectedSamples: DetectionRow[];
};

const OUTCOMES: FinalOutcome[] = ["kept", "reshaped", "removed", "ignored", "auto-removed", "cleared", "auto-ignored", "dropped"];

function emptyCounts(): OutcomeCounts {
  return { ...(Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<FinalOutcome, number>), total: 0, shown: 0, rejected: 0 };
}

function add(c: OutcomeCounts, outcome: FinalOutcome) {
  c[outcome] += 1;
  c.total += 1;
  if (outcome === "removed" || outcome === "ignored" || outcome === "auto-removed") c.rejected += 1;
  if (["kept", "reshaped", "removed", "ignored", "auto-removed"].includes(outcome)) c.shown += 1;
}

function iou(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** A reshaped region's box overlaps its detection less than this. */
const RESHAPED_IOU = 0.6;

export const SCORE_BANDS = [0, 0.2, 0.4, 0.6, 0.8, 1.0001];
export function scoreBand(score: number) {
  const i = SCORE_BANDS.findIndex((edge, k) => score >= edge && score < SCORE_BANDS[k + 1]);
  const lo = SCORE_BANDS[Math.max(0, i)];
  const hi = Math.min(1, SCORE_BANDS[Math.max(0, i) + 1]);
  return `${lo.toFixed(1)}–${hi.toFixed(1)}`;
}

export const SOURCE_LABELS: Record<string, string> = {
  rtdetr: "RT-DETR",
  ctd: "Comic Text Detector",
  paddle: "PaddleOCR",
  coo: "COO (sound effects)",
  "sam-ts-l": "SAM-TS-L mask",
  heuristic: "Geometric bubbles",
};
export function sourcesLabel(sources: string[]) {
  if (!sources.length) return "Unknown detector";
  const names = sources.map((s) => SOURCE_LABELS[s] ?? s);
  return sources.length === 1 ? `${names[0]} alone` : names.join(" + ");
}

type Raw = {
  id: string; episode_id: string; image_id: string; line_id: string | null;
  x: number; y: number; w: number; h: number; kind: string; score: number;
  sources: string; scores: string; outcome: DetectionOutcome; reason: string; removed_via: string | null; created_at: number;
};

/** The final outcome of every detected region in a series whose page still exists. */
export function detectionRows(seriesId: string, episodeId?: string): (DetectionRow & { createdAt: number })[] {
  const rows = sqlite.prepare(
    `SELECT d.* FROM detection_regions d JOIN images i ON i.id = d.image_id
     WHERE d.series_id=? ${episodeId ? "AND d.episode_id=?" : ""} ORDER BY d.created_at`,
  ).all(...(episodeId ? [seriesId, episodeId] : [seriesId])) as Raw[];
  const lineIds = [...new Set(rows.map((r) => r.line_id).filter(Boolean))] as string[];
  const lines = new Map<string, { source_state: string; x: number; y: number; w: number; h: number }>();
  for (let i = 0; i < lineIds.length; i += 500) {
    const chunk = lineIds.slice(i, i + 500);
    for (const l of sqlite.prepare(`SELECT id,source_state,x,y,w,h FROM lines WHERE id IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as
      { id: string; source_state: string; x: number; y: number; w: number; h: number }[]) lines.set(l.id, l);
  }
  return rows.map((r) => {
    let outcome: FinalOutcome;
    const line = r.line_id ? lines.get(r.line_id) : undefined;
    if (r.outcome === "dropped") outcome = "dropped";
    else if (line) {
      if (line.source_state === "ignored") {
        if (r.outcome === "auto-ignored") outcome = "auto-ignored";
        else outcome = getDoc<RegionData>(`region:${r.line_id}`, {}).data.directorDetectionReview ? "auto-removed" : "ignored";
      } else outcome = iou(line, r) < RESHAPED_IOU ? "reshaped" : "kept";
    } else if (r.outcome === "auto-ignored" && !r.removed_via) outcome = "auto-ignored";
    else if (r.removed_via === "Delete region" || r.removed_via === "Remove blank regions") outcome = "removed";
    else if (r.removed_via === "Remove page regions" || r.removed_via === "Remove regions on selected pages") outcome = "cleared";
    else outcome = r.outcome === "auto-ignored" ? "auto-ignored" : "auto-removed";
    return {
      id: r.id, episodeId: r.episode_id, imageId: r.image_id,
      x: r.x, y: r.y, w: r.w, h: r.h, kind: r.kind, score: r.score,
      sources: JSON.parse(r.sources), scores: JSON.parse(r.scores), outcome, reason: r.reason, createdAt: r.created_at,
    };
  });
}

/** Regions on detected pages that no detection made and that were not there before it ran. */
function handAdded(seriesId: string) {
  const runs = sqlite.prepare(
    "SELECT r.episode_id, r.image_id, r.prior_lines FROM detection_runs r JOIN images i ON i.id = r.image_id WHERE r.series_id=?",
  ).all(seriesId) as { episode_id: string; image_id: string; prior_lines: string }[];
  const pages = new Map<string, { episodeId: string; prior: Set<string> }>();
  for (const run of runs) {
    const page = pages.get(run.image_id) ?? { episodeId: run.episode_id, prior: new Set<string>() };
    for (const id of JSON.parse(run.prior_lines) as string[]) page.prior.add(id);
    pages.set(run.image_id, page);
  }
  const logged = new Set((sqlite.prepare("SELECT line_id FROM detection_regions WHERE series_id=? AND line_id IS NOT NULL").all(seriesId) as { line_id: string }[]).map((r) => r.line_id));
  const perEpisode = new Map<string, number>();
  const select = sqlite.prepare("SELECT id FROM lines WHERE image_id=? AND source_state != 'ignored'");
  for (const [imageId, page] of pages)
    for (const { id } of select.all(imageId) as { id: string }[])
      if (!logged.has(id) && !page.prior.has(id)) perEpisode.set(page.episodeId, (perEpisode.get(page.episodeId) ?? 0) + 1);
  return perEpisode;
}

function grouped(rows: DetectionRow[], keyOf: (r: DetectionRow) => string, labelOf: (key: string) => string) {
  const groups = new Map<string, DetectionGroup>();
  for (const r of rows) {
    const key = keyOf(r);
    const g = groups.get(key) ?? { ...emptyCounts(), key, label: labelOf(key) };
    add(g, r.outcome);
    groups.set(key, g);
  }
  return [...groups.values()];
}

export function seriesDetectionReport(seriesId: string, episodeTitles: Map<string, string> = new Map()): DetectionReport {
  const rows = detectionRows(seriesId);
  const totals = emptyCounts();
  for (const r of rows) add(totals, r.outcome);
  const runs = sqlite.prepare(
    "SELECT r.setup, r.image_id FROM detection_runs r JOIN images i ON i.id = r.image_id WHERE r.series_id=?",
  ).all(seriesId) as { setup: string; image_id: string }[];
  const setups = new Map<string, Set<string>>();
  for (const run of runs) setups.set(run.setup, (setups.get(run.setup) ?? new Set()).add(run.image_id));
  const hand = handAdded(seriesId);
  const sourcesKey = (r: DetectionRow) => r.sources.join("+") || "unknown";
  const byRejection = (a: DetectionGroup, b: DetectionGroup) => b.rejected - a.rejected || b.total - a.total;
  return {
    runs: runs.length,
    pages: new Set(runs.map((r) => r.image_id)).size,
    setups: [...setups].map(([setup, pages]) => ({ setup, pages: pages.size })).sort((a, b) => b.pages - a.pages),
    totals,
    addedByHand: [...hand.values()].reduce((a, b) => a + b, 0),
    bySources: grouped(rows, sourcesKey, (k) => sourcesLabel(k === "unknown" ? [] : k.split("+"))).sort(byRejection),
    byScore: grouped(rows, (r) => scoreBand(r.score), (k) => `Score ${k}`).sort((a, b) => a.key.localeCompare(b.key)),
    byKind: grouped(rows, (r) => r.kind, (k) => ({ bubble: "In a bubble", free: "Free lettering / SFX", unknown: "Not classified" })[k] ?? k).sort(byRejection),
    hotspots: grouped(rows, (r) => `${sourcesKey(r)}|${scoreBand(r.score)}`, (k) => {
      const [sources, band] = k.split("|");
      return `${sourcesLabel(sources === "unknown" ? [] : sources.split("+"))} · score ${band}`;
    }).filter((g) => g.rejected > 0).sort((a, b) => b.rejected / Math.max(1, b.shown) - a.rejected / Math.max(1, a.shown) || b.rejected - a.rejected).slice(0, 12),
    byEpisode: grouped(rows, (r) => r.episodeId, (k) => episodeTitles.get(k) ?? k).map((g) => ({ ...g, addedByHand: hand.get(g.key) ?? 0 })),
    rejectedSamples: rows.filter((r) => r.outcome === "removed" || r.outcome === "ignored").reverse().slice(0, 240),
  };
}
