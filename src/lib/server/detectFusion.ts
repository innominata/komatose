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
  /** Bubble boxes at least this sure are walls: lettering in two balloons never merges. */
  wallScore: 0.5,
  /**
   * Lettering pixels no box claimed become their own region. Inside a balloon the
   * box detectors are near complete; outside they silently miss captions, titles
   * and stylised effects that the pixel mask still marks.
   */
  adoptLettering: true,
  /** An unclaimed block overlapping a region less than this is not that region's text. */
  claimedInside: 0.3,
  /** A box that covers at least this much of a block, but not all of it, has clipped it and grows. */
  clipInside: 0.5,
  /** A clipped box grows at most to this multiple of its own area. */
  clipGrowth: 2,
  /** Adopted blocks this close, as a share of the larger block's short side, are one piece of lettering. */
  reachShare: 0.5,
  /** And never further apart than this, in page pixels. */
  reachMax: 96,
  /** Score of a region only the lettering mask found. */
  adoptedScore: 0.5,
  /** A block the mask fills more than this is a shape, not lettering (lettering stays under a third). */
  solidFill: 0.6,
  /** Nor is one whose strokes are this share of its short side. */
  solidStroke: 0.4,
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

type Balloon = { box: Box; score: number };

function centre(b: Box): [number, number] {
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

/** The smallest sure balloon holding the box's centre, if any. */
function balloonOf(b: Box, balloons: Balloon[]): Balloon | undefined {
  const [x, y] = centre(b);
  return balloons
    .filter((w) => x >= w.box[0] && x <= w.box[2] && y >= w.box[1] && y <= w.box[3])
    .sort((a, c) => area(a.box) - area(c.box))[0];
}

/** Two boxes in different balloons are different lettering, however much they overlap. */
function walled(a: Box, b: Box, balloons: Balloon[]) {
  const wa = balloonOf(a, balloons), wb = balloonOf(b, balloons);
  return !!wa && !!wb && wa !== wb;
}

function gap(a: Box, b: Box) {
  const dx = Math.max(0, Math.max(a[0], b[0]) - Math.min(a[2], b[2]));
  const dy = Math.max(0, Math.max(a[1], b[1]) - Math.min(a[3], b[3]));
  return Math.hypot(dx, dy);
}

function union(a: Box, b: Box): Box {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** `c` repeats the lettering `seed` already describes. */
function repeats(c: Candidate, seed: Candidate, balloons: Balloon[] = []) {
  if (walled(c.box, seed.box, balloons)) return false;
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
    /** Smallest side, in page pixels, of a region only the lettering mask found. */
    minAdoptPx?: number;
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
  const balloons: Balloon[] = passthrough
    .filter((r) => r.cls === "bubble" && r.score >= FUSION.wallScore)
    .map((r) => ({ box: r.box as Box, score: r.score }));
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
    const homes = seeds.filter((s) => repeats(c, s.lead, balloons));
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

  if (FUSION.adoptLettering && !koharuOnly) adoptLettering(seeds, text, balloons, opts.minAdoptPx ?? 0);

  const fused: FusedRegion[] = seeds.map(({ lead, members }) => {
    // Only RT-DETR and COO say whether lettering sits in a bubble.
    const classed = members.find((m) => m.source === "rtdetr" || m.source === "coo");
    const sources = new Set<DetectorSource>(members.map((m) => m.source));
    for (const d of text) if (!sources.has(d.source) && members.some((m) => secondOpinion(m, d))) sources.add(d.source);
    const { source: _source, ...rest } = lead;
    return {
      ...rest,
      cls: classed && classed.cls !== "text" ? classed.cls : lead.cls,
      // The mask's blocks carry a fixed score; lettering only it found ranks below a confident box.
      score: members.every((m) => m.source === "koharu")
        ? FUSION.adoptedScore
        : Math.max(...members.filter((m) => m.source !== "koharu").map((m) => m.score)),
      sources: [...sources].sort((a, b) => PRIORITY.indexOf(a) - PRIORITY.indexOf(b)),
    };
  });
  return [...passthrough, ...fused];
}

/**
 * Pixel-first pass over the lettering mask's blocks, after the box detectors
 * have been merged. A block a box cut short grows that box. A block no box
 * claimed is still lettering: it becomes a region of its own, labelled inside
 * or outside a balloon by the bubble boxes, and blocks within one glyph of
 * each other in the same place are joined so a sound effect the boxes cut in
 * pieces is one region. Recognition later drops any that hold no text.
 *
 * Adapted from Manga Cleaner's text groups (github.com/k-omiq/Bear), with the
 * author's permission.
 */
function adoptLettering(seeds: { lead: Candidate; members: Candidate[] }[], text: Candidate[], balloons: Balloon[], minPx: number) {
  const blocks = text.filter((c) => c.source === "koharu");
  const boxed = seeds.filter((s) => s.lead.source !== "koharu");
  const loose: Candidate[] = [];
  // A box holding most of a block, but not all, cut the lettering short.
  const clipped = (s: { lead: Candidate }, block: Candidate) =>
    inside(block.box, s.lead.box) >= FUSION.clipInside && inside(block.box, s.lead.box) < 1 &&
    area(union(s.lead.box, block.box)) <= area(s.lead.box) * FUSION.clipGrowth;
  for (const block of blocks) {
    const home = boxed.find((s) => s.members.includes(block));
    if (home) {
      if (clipped(home, block)) home.lead = { ...home.lead, box: union(home.lead.box, block.box) };
      continue;
    }
    if (seeds.some((s) => s.members.includes(block))) continue;
    const near = boxed.filter((s) => !walled(block.box, s.lead.box, balloons));
    const claimed = near.filter((s) => inside(block.box, s.lead.box) >= FUSION.claimedInside);
    if (claimed.length) {
      const clip = claimed.find((s) => clipped(s, block));
      if (clip) {
        clip.lead = { ...clip.lead, box: union(clip.lead.box, block.box) };
        clip.members.push(block);
      }
      continue;
    }
    // A solid shape (a white bar, a highlight) fills its box with strokes as thick as the box.
    const side = Math.min(block.box[2] - block.box[0], block.box[3] - block.box[1]);
    if ((block.fill ?? 0) > FUSION.solidFill || (block.stroke ?? 0) > side * FUSION.solidStroke) continue;
    // A block spanning several regions is a line-grouping artefact.
    if (boxed.filter((s) => inside(s.lead.box, block.box) >= FUSION.fragmentInside).length >= FUSION.containerHolds) continue;
    loose.push(block);
  }
  // Join loose blocks within reach of each other in the same place.
  const parent = loose.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  for (let i = 0; i < loose.length; i++)
    for (let j = i + 1; j < loose.length; j++) {
      const a = loose[i].box, b = loose[j].box;
      if (balloonOf(a, balloons) !== balloonOf(b, balloons)) continue;
      const glyph = Math.max(Math.min(a[2] - a[0], a[3] - a[1]), Math.min(b[2] - b[0], b[3] - b[1]));
      if (gap(a, b) <= Math.min(FUSION.reachMax, glyph * FUSION.reachShare)) parent[root(j)] = root(i);
    }
  const groups = new Map<number, Candidate[]>();
  loose.forEach((block, i) => groups.set(root(i), [...(groups.get(root(i)) ?? []), block]));
  for (const members of groups.values()) {
    const box = members.map((m) => m.box).reduce(union);
    if (Math.min(box[2] - box[0], box[3] - box[1]) < minPx) continue;
    seeds.push({
      lead: { ...members[0], box, cls: balloonOf(box, balloons) ? "text_bubble" : "text_free" },
      members,
    });
  }
}
