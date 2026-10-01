import { listRegistryRows, findRegistryRow } from './modelRegistryStore';
import { rowHasOperation } from '../modelRegistry';
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { ROOT } from "./paths";
import { automaticRegionPolygon } from "../regionGeometry";
import type { Point } from "../workflow";
import { cleaningDeviceLabel, localOperation } from "./localWorker";
import {
  DETECTORS,
  type Detector,
  type DetectorInfo,
  DETECTOR_LABELS,
  type OcrLang,
} from "../types";
import {
  bubbleFromNorm,
  findSpeechBubbles,
  type SpeechBubble,
} from "./bubbles";
import { detectRegionsPy, parsePoly, type WorkerRegion } from "./ocr";
import { clampDetectConf, type DetectorSetupConfig } from "../detectorSetup";

export type { Detector };

export function listDetectors(): DetectorInfo[] {
  return [{ id: 'heuristic', label: 'Geometric bubbles' }, ...listRegistryRows().filter(row => !row.disabled && rowHasOperation(row, 'detect')).map(row => ({ id: row.id, label: row.name }))];
}

export type DetectedRegion = {
  /** Tight box around the text — what gets cropped for recognition. */
  ocr: SpeechBubble;
  /** Editable source bounds; bubble-interior geometry is stored separately. */
  place: SpeechBubble;
  /**
   * `free` means the detector positively identified text outside a bubble
   * (likely SFX). `unknown` means the backend does not distinguish, so
   * callers should not infer a line type from it.
   */
  kind: "bubble" | "free" | "unknown";
  score: number;
  polygon?: Point[];
  geometryConfidence?: number;
  provenance?: { crop?: number[]; truncated?: boolean; backend?: string };
  bubble?: SpeechBubble;
};

const TEXT_CLASSES = new Set(["text", "text_bubble", "text_free"]);

/** A detector box thinner than this on either axis is not saved as a region. */
export const MIN_AUTO_REGION_PX = 30;

type Box = [number, number, number, number];

type Candidate = {
  polygon?: Point[];
  provenance?: { crop?: number[]; truncated?: boolean; backend?: string };
  box: Box;
  kind: DetectedRegion["kind"];
  score: number;
  /** False for bubble outlines kept only as a fallback OCR target. */
  text: boolean;
};

export function parseDetector(value: unknown): Detector {
  const raw = String(value ?? "").toLowerCase();
  if (raw === 'heuristic' || findRegistryRow(raw)) return raw;
  const env = String(process.env.SCAN_DETECTOR ?? "").toLowerCase();
  if (env === 'heuristic' || findRegistryRow(env)) return env;
  return "rtdetr";
}

export function parseDetectConf(value: unknown): number | undefined {
  return clampDetectConf(value);
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function boxToBubble(
  W: number,
  H: number,
  box: [number, number, number, number],
  pad: number,
): SpeechBubble {
  const x0 = Math.max(0, box[0] - pad);
  const y0 = Math.max(0, box[1] - pad);
  const x1 = Math.min(W, box[2] + pad);
  const y1 = Math.min(H, box[3] + pad);
  return bubbleFromNorm(W, H, x0 / W, y0 / H, (x1 - x0) / W, (y1 - y0) / H);
}

function clippedSpan(box: Box, W: number, H: number): [number, number] {
  const x0 = Math.min(W, Math.max(0, box[0]));
  const y0 = Math.min(H, Math.max(0, box[1]));
  const x1 = Math.min(W, Math.max(0, box[2]));
  const y1 = Math.min(H, Math.max(0, box[3]));
  return [x1 - x0, y1 - y0];
}

function areaOf(b: [number, number, number, number]): number {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

/** Fraction of `inner` that lies inside `outer`. */
function coverage(
  inner: [number, number, number, number],
  outer: [number, number, number, number],
): number {
  const ix = Math.max(
    0,
    Math.min(inner[2], outer[2]) - Math.max(inner[0], outer[0]),
  );
  const iy = Math.max(
    0,
    Math.min(inner[3], outer[3]) - Math.max(inner[1], outer[1]),
  );
  const a = areaOf(inner);
  return a <= 0 ? 0 : (ix * iy) / a;
}

/** Symmetric overlap: high when either box is mostly inside the other. */
function overlapFrac(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  return Math.max(coverage(a, b), coverage(b, a));
}

async function detectHeuristic(bytes: Buffer): Promise<DetectedRegion[]> {
  const bubbles = await findSpeechBubbles(bytes);
  return bubbles.map((b) => ({
    ocr: b,
    place: b,
    kind: "bubble" as const,
    score: 1,
  }));
}

export type DetectStep = { step: string; model: string; engine?: string };
export type TextMask = { engine: string; model: string; backend: string };

const DETECT_ENGINES: Record<string, string> = {
  "RT-DETR": "rtdetr",
  "Comic Text Detector": "ctd",
  PaddleOCR: "paddle",
};

export async function detectRegions(
  page: { path: string; bytes: Buffer; width: number; height: number },
  opts: {
    geometry?: boolean;
    /** Box detector plus add-ons. Without it, `detector` alone runs, with COO beside RT-DETR when installed. */
    setup?: DetectorSetupConfig;
    detector?: Detector;
    conf?: number;
    tile?: number;
    lang?: OcrLang;
    abort?: AbortSignal;
    onStep?: (update: DetectStep) => void;
    onTextMask?: (mask: Buffer, meta: TextMask) => void;
  } = {},
): Promise<DetectedRegion[]> {
  const base = opts.detector ?? parseDetector(undefined);
  const setup = opts.setup ?? { base, coo: base === "rtdetr" && cooEnabled(), koharu: false };
  const detector = setup.base;

  // Detection and OCR must see the same working image, including page edits.
  const dir = await mkdtemp(join(tmpdir(), "scan-detect-"));
  try {
    const path = join(dir, "page.png");
    await writeFile(path, page.bytes);
    if (detector !== "heuristic") {
      opts.onStep?.({
        step: "Detecting regions",
        model: detectorModelName(detector),
        engine: detector,
      });
    }
    const detection =
      detector === "heuristic"
        ? null
        : await detectRegionsPy(path, {
            backend: detector,
            conf: opts.conf ?? envNumber("SCAN_DETECT_CONF"),
            tile: opts.tile ?? envNumber("SCAN_DETECT_TILE"),
            lang: opts.lang,
            abort: opts.abort,
            onProgress: (update) => opts.onStep?.({
              step: update.step || "Detecting regions",
              model: update.model,
              engine: DETECT_ENGINES[update.model] || update.model,
            }),
          });
    if (detection && setup.coo) {
      // The workflow environment already owns torch/torchvision. Keep the OCR
      // environment and its persistent Paddle process independent of COO.
      opts.onStep?.({ step: "Detecting sound effects", model: COO_MODEL, engine: "coo" });
      const sfx = await localOperation({ cmd: "detect-sfx", path,
        confidence: envNumber("SCAN_COO_CONF") ?? .6 }, opts.abort);
      detection.regions.push(...parseSfxRegions(sfx.regions));
    }
    if (detection && setup.koharu) {
      // Say where it really runs: the cleaner's device, not the GPU-mode flag.
      const koharuDevice = cleaningDeviceLabel();
      opts.onStep?.({
        step: "Detecting text regions",
        model: `${KOHARU_MODEL} · ${koharuDevice}`,
        engine: "koharu",
      });
      const out = join(dir, "koharu-mask.png");
      const found = await localOperation({
        cmd: "detect-text", path, out, maskExpansion: 3,
      }, opts.abort);
      detection.regions = supplementTextRegions(detection.regions, parseKoharuRegions(found.regions));
      const mask = typeof found.mask === "string" && found.mask.includes(",")
        ? Buffer.from(found.mask.split(",")[1], "base64")
        : await readFile(out);
      opts.onTextMask?.(mask, {
        engine: String(found.engine || "koharu"),
        model: String(found.model || KOHARU_MODEL),
        backend: String(found.backend || ""),
      });
    }
    const detected = (
      detection
        ? regionsFromDetection(
            detection.regions,
            detection.width || page.width,
            detection.height || page.height,
          )
        : await detectHeuristic(page.bytes)
    ).filter(
      (region) =>
        region.place.width >= MIN_AUTO_REGION_PX &&
        region.place.height >= MIN_AUTO_REGION_PX,
    );
    if (opts.geometry && detected.length) {
      opts.onStep?.({ step: "Fitting bubble geometry", model: "OpenCV", engine: "opencv" });
      let result: Record<string, any> = {};
      try {
        result = await localOperation(
          {
            cmd: "geometry-batch",
            path,
            method: "opencv",
            regions: detected.map((r) => ({
              box: [r.place.x, r.place.y, r.place.w, r.place.h],
              kind: r.kind,
            })),
          },
          opts.abort,
        );
      } catch (error) {
        opts.abort?.throwIfAborted();
        console.warn(
          "[detect] Bubble geometry unavailable; using region bounds:",
          error instanceof Error ? error.message : error,
        );
      }
      for (const [i, region] of detected.entries()) {
        if (region.polygon) continue; // Preserve COO's source text contour.
        const found = result.regions?.[i];
        region.polygon = automaticRegionPolygon(region.place, found?.polygon);
        region.geometryConfidence =
          region.polygon === found?.polygon ? found.confidence : 0;
      }
    }
    return detected;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Text boxes stay tight; bubble interiors are a separate cleaning/typesetting record. */
export function regionsFromDetection(
  regions: WorkerRegion[],
  W: number,
  H: number,
): DetectedRegion[] {
  const bubbles = regions.filter((r) => r.cls === "bubble");
  const texts = regions.filter((r) => TEXT_CLASSES.has(r.cls));

  // Text regions first, best score first; a bubble whose text the detector
  // missed is a weaker fallback but still worth reading, since the recogniser
  // gets the final say on whether a region holds text.
  const candidates: Candidate[] = [
    ...texts
      .map((t) => ({
        box: t.box,
        polygon: t.polygon,
        provenance: { crop: t.crop, truncated: t.truncated, backend: t.backend },
        // Only rtdetr separates in-bubble text from free-floating text;
        // `text` from the other backends carries no such claim.
        kind: (t.cls === "text_free"
          ? "free"
          : t.cls === "text_bubble"
            ? "bubble"
            : "unknown") as DetectedRegion["kind"],
        score: t.score,
        text: true,
      }))
      .sort((a, b) => b.score - a.score),
    ...bubbles
      .map((b) => ({
        box: b.box,
        kind: "bubble" as const,
        score: b.score,
        text: false,
      }))
      .sort((a, b) => b.score - a.score),
  ];

  const out: DetectedRegion[] = [];
  const taken: [number, number, number, number][] = [];
  for (const c of candidates) {
    const [spanW, spanH] = clippedSpan(c.box, W, H);
    if (spanW < MIN_AUTO_REGION_PX || spanH < MIN_AUTO_REGION_PX) continue;
    // Bubble and text boxes for the same balloon overlap heavily; keeping
    // both would OCR and translate the same line twice.
    if (
      taken.some(
        (t) =>
          overlapFrac(c.box, t) > 0.5 &&
          (!c.text ||
            Math.min(areaOf(c.box), areaOf(t)) /
              Math.max(areaOf(c.box), areaOf(t)) >
              0.5),
      )
    )
      continue;
    taken.push(c.box);
    out.push({
      // A little margin keeps ascenders and punctuation from being clipped.
      ocr: boxToBubble(W, H, c.box, c.text ? 4 : 0),
      place: boxToBubble(W, H, c.box, c.text ? 2 : 0),
      kind: c.kind,
      score: c.score,
      polygon: c.polygon,
      geometryConfidence: c.polygon ? c.score : undefined,
      provenance: c.provenance,
      bubble: (() => {
        const enclosing = bubbles.filter(b => coverage(c.box, b.box) > .8)
          .sort((a, b) => areaOf(a.box) - areaOf(b.box))[0];
        return enclosing ? boxToBubble(W, H, enclosing.box, 0) : undefined;
      })(),
    });
  }

  out.sort((a, b) => a.place.y - b.place.y || a.place.x - b.place.x);
  return out;
}

export function cooEnabled(): boolean {
  const mode = (process.env.SCAN_COO ?? "auto").toLowerCase();
  if (["0", "off", "false"].includes(mode)) return false;
  return mode !== "auto" || existsSync(process.env.SCAN_COO_MODEL ||
    join(ROOT, "data/models/coo/dbnetpp-coo.pt"));
}

export const KOHARU_MODEL = "Koharu SAM-TS-L";
export const CTD_MODEL = "Comic Text Detector";
export const COO_MODEL = "COO DBNet++";
const HI_SAM_REVISION = "69009434d4dba5541f228d8f5acb0754c333d417";

export function detectorModelName(detector: Detector): string {
  if (detector === "ctd") return CTD_MODEL;
  if (detector === "paddle") return "PaddleOCR";
  if (detector === "heuristic") return "Geometric bubbles";
  return "RT-DETR";
}

export function jobStepMessage(page: number, pages: number, step: string, model: string) {
  const where = page > 0 && pages > 0 ? `Page ${page}/${pages} · ` : "";
  return `${where}${step} · ${model}`;
}

export function koharuInstalled(): boolean {
  const weights = process.env.SCAN_KOHARU_WEIGHTS ||
    join(ROOT, "data/models/koharu-text-sam-ts-l/model.safetensors");
  const source = process.env.SCAN_KOHARU_HISAM_ROOT ||
    join(ROOT, `data/models/hi-sam-${HI_SAM_REVISION}`);
  return existsSync(weights) && existsSync(join(source, "hi_sam/modeling/build.py"));
}

/** `off` skips Koharu. `on` requires it. `auto` uses it when the weights are installed. */
export function koharuDetectionMode(): "off" | "on" | "auto" {
  const flag = (process.env.SCAN_KOHARU_DETECT ?? "auto").toLowerCase();
  if (["0", "off", "false"].includes(flag)) return "off";
  if (["1", "on", "true", "koharu"].includes(flag)) return "on";
  const mask = (process.env.SCAN_MASK_ENGINE ?? "auto").toLowerCase();
  if (["ctd", "comic-text-detector"].includes(mask)) return "off";
  if (["koharu", "koharu-sam-ts-l", "sam-ts-l"].includes(mask)) return "on";
  return "auto";
}

export function maskModelName(engine?: string): string {
  const mode = String(engine || process.env.SCAN_MASK_ENGINE || "auto").toLowerCase();
  if (["ctd", "comic-text-detector"].includes(mode)) return CTD_MODEL;
  if (["koharu", "koharu-sam-ts-l", "sam-ts-l"].includes(mode)) return KOHARU_MODEL;
  return koharuInstalled() ? KOHARU_MODEL : CTD_MODEL;
}

function unionBox(a: Box, b: Box): Box {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/**
 * Keep detector boxes, grow one when Koharu shows the same text continuing
 * outside it, and add a region for text no detector boxed.
 */
export function supplementTextRegions(existing: WorkerRegion[], extra: WorkerRegion[]): WorkerRegion[] {
  const out = existing.map((r) => ({ ...r, box: [...r.box] as Box }));
  const texts = () => out.filter((r) => TEXT_CLASSES.has(r.cls));
  for (const candidate of extra) {
    const box = candidate.box;
    if (![box[0], box[1], box[2], box[3]].every(Number.isFinite) || box[2] <= box[0] || box[3] <= box[1])
      continue;
    const expandable = texts().filter((region) => !region.polygon);
    const grow = expandable
      .map((region) => ({ region, cover: coverage(box, region.box), united: unionBox(region.box, box) }))
      .filter((item) => item.cover >= 0.45 && areaOf(item.united) <= areaOf(item.region.box) * 1.8)
      .sort((a, b) => b.cover - a.cover)[0];
    if (grow) {
      grow.region.box = grow.united;
      continue;
    }
    if (texts().some((region) => coverage(box, region.box) >= 0.75)) continue;
    const host = expandable
      .map((region) => ({ region, inside: coverage(region.box, box) }))
      .filter((item) => item.inside >= 0.75)
      .sort((a, b) => areaOf(a.region.box) - areaOf(b.region.box))[0];
    if (host && areaOf(unionBox(host.region.box, box)) <= areaOf(host.region.box) * 3) {
      host.region.box = unionBox(host.region.box, box);
      continue;
    }
    out.push({ ...candidate, cls: candidate.cls || "text", backend: candidate.backend || "koharu", box: [...box] });
  }
  return out;
}

export function parseKoharuRegions(raw: unknown): WorkerRegion[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((region) => {
    if (!region || !Array.isArray(region.box) || region.box.length !== 4 ||
      !region.box.every((n: unknown) => typeof n === "number" && Number.isFinite(n))) return [];
    const box = region.box as Box;
    if (box[2] <= box[0] || box[3] <= box[1]) return [];
    const score = Number(region.score);
    return [{
      cls: "text",
      backend: "koharu",
      score: Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0.8,
      box,
    }];
  });
}

/** Reject malformed sidecar results before they become saved editable regions. */
export function parseSfxRegions(raw: unknown): WorkerRegion[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    if (!r || !Array.isArray(r.box) || r.box.length !== 4 ||
      !r.box.every(Number.isFinite) || r.box[2] <= r.box[0] || r.box[3] <= r.box[1] ||
      !Number.isFinite(r.score) || r.score < 0 || r.score > 1 ||
      !Array.isArray(r.polygon) || r.polygon.some((p: Point) => !p ||
        !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)) return [];
    const polygon = parsePoly(r.polygon);
    if (!polygon) return [];
    return [{ cls: "text_free", backend: String(r.backend || "coo-dbnetpp"),
      score: r.score, box: r.box as Box, polygon,
      crop: Array.isArray(r.crop) && r.crop.length === 4 && r.crop.every(Number.isFinite) ? r.crop : undefined,
      truncated: r.truncated === true }];
  });
}
