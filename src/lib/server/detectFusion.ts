import type { WorkerRegion } from "./ocr";

/**
 * Cross-checking text detectors.
 *
 * No single detector is right on every page: RT-DETR knows bubbles from free
 * lettering but invents low-confidence boxes on artwork, Comic Text Detector is
 * tight but misses stylised and tiny text, PaddleOCR only reports lines it can
 * actually read, COO finds sound effects, and Koharu segments lettering pixels.
 * A box that several of them agree on is almost always text, so agreement is
 * what lets a weak single-detector box through. Everything else needs a score
 * high enough to stand alone.
 */

export type DetectorSource = "rtdetr" | "ctd" | "paddle" | "coo" | "koharu";

type Box = [number, number, number, number];

export const FUSION = {
  /** A lone box needs at least this score. Anything weaker needs a second detector. */
  alone: { rtdetrBubble: 0.5, rtdetrFree: 0.6, ctd: 0.6 },
  /** Two boxes with this intersection-over-union are one piece of lettering. */
  sameIou: 0.4,
  /** Boxes this alike are one piece of lettering even when the detectors disagree on its class. */
  sameAnyClassIou: 0.6,
  /** A smaller box this far inside a larger one is a fragment of it (one column of a bubble). */
  fragmentInside: 0.8,
  /** A seed this far inside a slightly larger box is that box drawn tighter. */
  looseRatio: 0.3,
  /** Weaker overlap that still counts as a second opinion. */
  voteInside: 0.6,
  voteRatio: 0.15,
  /** A block that swallows this many other regions is a line-grouping artefact. */
  containerHolds: 2,
};

const TEXT = new Set(["text", "text_bubble", "text_free"]);
const PRIORITY: DetectorSource[] = ["coo", "rtdetr", "ctd", "paddle", "koharu"];

export function detectorSource(region: Pick<WorkerRegion, "backend">): DetectorSource | undefined {
  const backend = String(region.backend ?? "").toLowerCase();
  if (backend.startsWith("coo")) return "coo";
  if (backend === "rtdetr" || backend === "ctd" || backend === "paddle" || backend === "koharu") return backend;
  return undefined;
}

function area(b: Box) {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

function intersection(a: Box, b: Box) {
  return (
    Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  );
}

function iou(a: Box, b: Box) {
  const i = intersection(a, b);
  const u = area(a) + area(b) - i;
  return u > 0 ? i / u : 0;
}

/** Fraction of `inner` that lies inside `outer`. */
function inside(inner: Box, outer: Box) {
  const a = area(inner);
  return a > 0 ? intersection(inner, outer) / a : 0;
}

function ratio(a: Box, b: Box) {
  const large = Math.max(area(a), area(b));
  return large > 0 ? Math.min(area(a), area(b)) / large : 0;
}

type Candidate = WorkerRegion & { source: DetectorSource };

/** Bubble text and free lettering are different things even when one sits inside the other. */
function classesCompatible(a: string, b: string) {
  return a === b || a === "text" || b === "text";
}

/** `c` repeats the lettering `seed` already describes. */
function repeats(c: Candidate, seed: Candidate) {
  if (iou(c.box, seed.box) >= FUSION.sameAnyClassIou) return true;
  if (!classesCompatible(c.cls, seed.cls)) return false;
  if (iou(c.box, seed.box) >= FUSION.sameIou) return true;
  // A smaller box inside the seed is a fragment of it: one column, one line.
  if (area(c.box) < area(seed.box)) return inside(c.box, seed.box) >= FUSION.fragmentInside;
  // A box only a little larger than the seed is the same lettering with a looser margin.
  return inside(seed.box, c.box) >= FUSION.fragmentInside && ratio(c.box, seed.box) >= FUSION.looseRatio;
}

function secondOpinion(a: Candidate, b: Candidate) {
  if (a.source === b.source) return false;
  if (iou(a.box, b.box) >= FUSION.sameAnyClassIou) return true;
  if (!classesCompatible(a.cls, b.cls)) return false;
  if (iou(a.box, b.box) >= FUSION.sameIou) return true;
  return (
    ratio(a.box, b.box) >= FUSION.voteRatio &&
    Math.max(inside(a.box, b.box), inside(b.box, a.box)) >= FUSION.voteInside
  );
}

function standsAlone(c: Candidate) {
  switch (c.source) {
    case "coo":
      return true;
    case "paddle":
      // Reported only for lines the recogniser could read.
      return true;
    case "rtdetr":
      return c.score >= (c.cls === "text_free" ? FUSION.alone.rtdetrFree : FUSION.alone.rtdetrBubble);
    case "ctd":
      return c.score >= FUSION.alone.ctd;
    case "koharu":
      // A pixel mask is evidence, not a region proposal.
      return false;
  }
}

export type FusedRegion = WorkerRegion & {
  /** Detectors that reported this lettering, best first. */
  sources: DetectorSource[];
};

/**
 * Merge raw detector output into one list of text regions, one per piece of
 * lettering. `bubble` regions pass through untouched for grouping and cleaning.
 * Regions without a recognisable `backend` are kept as-is, so a custom detector
 * still works.
 */
export function fuseDetections(
  regions: WorkerRegion[],
  opts: {
    /** Detectors that ran, even if they found nothing. Fewer than two text detectors means no cross-check. */
    ran?: DetectorSource[];
  } = {},
): FusedRegion[] {
  const passthrough: FusedRegion[] = [];
  const text: Candidate[] = [];
  for (const region of regions) {
    const source = TEXT.has(region.cls) ? detectorSource(region) : undefined;
    if (source) text.push({ ...region, source });
    else passthrough.push({ ...region, sources: [] });
  }

  const rank = (source: DetectorSource) => PRIORITY.indexOf(source);
  // A lone text detector has nobody to check it, so its own threshold stands.
  const detectors = new Set<DetectorSource>(
    [...(opts.ran ?? text.map((c) => c.source))].filter((s) => s === "rtdetr" || s === "ctd" || s === "paddle"),
  );
  const crossChecked = detectors.size > 1;
  // With no box detector at all, Koharu's segments are the only proposals there are.
  const koharuOnly = detectors.size === 0;
  const backed = text
    .filter((c) => {
      if (c.source === "koharu") return koharuOnly || text.some((d) => secondOpinion(c, d));
      return !crossChecked || standsAlone(c) || text.some((d) => secondOpinion(c, d));
    })
    .sort((a, b) => rank(a.source) - rank(b.source) || b.score - a.score);

  // Seeds in priority order. A later box either repeats a seed or starts one.
  // Comparing against seeds only, never members, keeps one oversized box from
  // chaining separate pieces of lettering together.
  const seeds: { lead: Candidate; members: Candidate[] }[] = [];
  for (const c of backed) {
    // CTD can group dialogue from two joined balloons into one block. It is
    // corroborating evidence for those seeds, not a third geometry seed.
    // Check before repeats: the block can also resemble just one of its lobes.
    if (c.source === "ctd") {
      const held = seeds.filter((s) => s.lead.source !== "coo" &&
        inside(s.lead.box, c.box) >= FUSION.voteInside &&
        area(s.lead.box) < area(c.box) * 0.7);
      if (held.length >= FUSION.containerHolds) continue;
    }
    const homes = seeds.filter((s) => repeats(c, s.lead));
    if (homes.length) {
      const best = homes.sort((a, b) => iou(c.box, b.lead.box) - iou(c.box, a.lead.box) || area(a.lead.box) - area(b.lead.box))[0];
      best.members.push(c);
      continue;
    }
    // A line-grouped block spanning several seeds is not lettering of its own.
    if (c.source === "paddle" || c.source === "koharu") {
      // Sound effects drawn beside a line of dialogue do not make its block an artefact.
      const held = seeds.filter((s) => s.lead.source !== "coo" && inside(s.lead.box, c.box) >= FUSION.fragmentInside && area(s.lead.box) < area(c.box) * 0.7);
      if (held.length >= FUSION.containerHolds) {
        continue;
      }
    }
    seeds.push({ lead: c, members: [c] });
  }

  const fused: FusedRegion[] = seeds.map(({ lead, members }) => {
    // Only RT-DETR and COO say whether lettering sits in a bubble.
    const classed = members.find((m) => m.source === "rtdetr" || m.source === "coo");
    const sources = new Set<DetectorSource>(members.map((m) => m.source));
    for (const d of text) if (!sources.has(d.source) && members.some((m) => secondOpinion(m, d))) sources.add(d.source);
    const { source: _source, ...rest } = lead;
    return {
      ...rest,
      cls: classed && classed.cls !== "text" ? classed.cls : lead.cls,
      score: Math.max(...members.map((m) => m.score)),
      sources: [...sources].sort((a, b) => PRIORITY.indexOf(a) - PRIORITY.indexOf(b)),
    };
  });
  return [...passthrough, ...fused];
}
