import { activeRegionKinds, type RegionKind } from "./regionCatalog";
import { LINE_TYPES, type OcrLang, type Detector } from "./types";

export function isBlankRegion(line: { source?: string | null; body: string }): boolean {
  return !line.source?.trim() && !line.body.trim();
}

/** Delete without asking only when the region has neither source nor English. Unsaved field text counts. */
export function deleteRegionNeedsConfirm(
  line: { source?: string | null; body?: string | null },
  opts?: { draft?: Record<string, unknown> | null; pendingSource?: boolean },
): boolean {
  if (opts?.pendingSource) return true;
  const draft = opts?.draft;
  const source = typeof draft?.source === "string" ? draft.source : (line.source ?? "");
  const body = typeof draft?.body === "string" ? draft.body : (line.body ?? "");
  return !isBlankRegion({ source, body });
}

export function isIgnoredLine(line: { sourceState?: string | null }): boolean {
  return line.sourceState === "ignored";
}

export function usesSourceArtwork(
  step: string,
  compare: boolean,
  hasTypesetCopy: boolean,
) {
  return (
    compare ||
    ["Prepare", "Translate"].includes(step) ||
    (step === "Review" && !hasTypesetCopy)
  );
}

export type Point = { x: number; y: number };
export type TextStyle = {
  fontId: string;
  size: number;
  minSize: number;
  leading: number;
  padding: number;
  align: "left" | "center" | "right";
  fill: string;
  autoContrast?: boolean;
  outline: string;
  outlineWidth: number;
  rotation: number;
  /** Horizontal skew in degrees (Photoshop Free Transform "H"), applied to the whole layer. */
  skewX: number;
  /** Vertical skew in degrees (Photoshop Free Transform "V"), applied to the whole layer. */
  skewY: number;
  /** Photoshop Type → Warp Text style. Type on a Path is not writable in PSD export. */
  warpStyle: TextWarpStyle;
  /** Photoshop Warp Text Bend, −100 to 100. */
  warpBend: number;
  emphasis: "normal" | "bold" | "italic";
};
export const TEXT_WARP_STYLES = [
  "none",
  "arc",
  "arcLower",
  "arcUpper",
  "arch",
  "bulge",
] as const;
export type TextWarpStyle = (typeof TEXT_WARP_STYLES)[number];
export const TEXT_WARP_STYLE_LABELS: Record<TextWarpStyle, string> = {
  none: "None",
  arc: "Arc",
  arcLower: "Arc Lower",
  arcUpper: "Arc Upper",
  arch: "Arch",
  bulge: "Bulge",
};
export const MIN_STYLE_SIZE = 1;
export const DEFAULT_STYLE: TextStyle = {
  fontId: "",
  size: 10,
  minSize: 6,
  leading: 1.15,
  padding: 4,
  align: "center",
  fill: "#000000",
  autoContrast: true,
  outline: "#ffffff",
  outlineWidth: 0,
  rotation: 0,
  skewX: 0,
  skewY: 0,
  warpStyle: "none",
  warpBend: 0,
  emphasis: "normal",
};
export type Preferences = {
  regionAi?: import("./regionAi").RegionAiSettings;
  lang: OcrLang;
  direction: "rtl" | "ltr";
  dpi: number | null;
  aliases: string;
  translationPreferences: string;
  chapterSummary: string;
  /** Chapters saved before detector setups; read only to keep their old detector. */
  detector?: Detector;
  /** A detector setup id such as `ctd+koharu`. Unset follows Admin → Models → Jobs & defaults. */
  detectorSetup?: string;
  /** RT-DETR/CTD/Paddle score cutoff. Higher = fewer false boxes (flames, empty art). Unset follows the admin default. */
  detectConf?: number;
  /** Create regions for lettering that is already English. Off unless the chapter turns it on. */
  transcribeEnglish?: boolean;
  style?: Partial<TextStyle>;
  /** Keyed by line type id; series-added region type ids are valid keys too. */
  styles: Partial<Record<string, Partial<TextStyle>>>;
  /** When set, this series uses these region types instead of the built-in list. */
  regionKinds?: RegionKind[];
};
export const DEFAULT_PREFERENCES: Preferences = {
  lang: "japanese",
  direction: "rtl",
  dpi: null,
  aliases: "",
  translationPreferences: "",
  chapterSummary: "",
  transcribeEnglish: false,
  styles: {},
};
export const STYLE_KEYS = [
  "fontId",
  "size",
  "minSize",
  "leading",
  "padding",
  "align",
  "fill",
  "autoContrast",
  "outline",
  "outlineWidth",
  "rotation",
  "skewX",
  "skewY",
  "warpStyle",
  "warpBend",
  "emphasis",
] as const satisfies readonly (keyof TextStyle)[];

export function pickStyle(input: unknown): Partial<TextStyle> {
  if (!input || typeof input !== "object") return {};
  const rec = input as Record<string, unknown>;
  const out: Partial<TextStyle> = {};
  for (const key of STYLE_KEYS) {
    if (rec[key] !== undefined) (out as Record<string, unknown>)[key] = rec[key];
  }
  return out;
}

export function typeStyle(
  prefs: Partial<Preferences> | undefined,
  lineType: string,
): TextStyle {
  return {
    ...DEFAULT_STYLE,
    ...prefs?.style,
    ...prefs?.styles?.[lineType],
  };
}

/**
 * Every style the editor should offer: the built-in types, the series' added
 * region types, and any id that already has a saved style (so a removed type
 * with saved work still loads).
 */
export function styleKeys(prefs: Partial<Preferences> | undefined): string[] {
  const kinds = activeRegionKinds(prefs?.regionKinds).map((kind) => kind.id);
  const saved = Object.keys(prefs?.styles ?? {});
  return [...new Set([...LINE_TYPES, ...kinds, ...saved])];
}

export function allTypeStyles(
  prefs: Partial<Preferences> | undefined,
): Record<string, TextStyle> {
  return Object.fromEntries(
    styleKeys(prefs).map((type) => [type, typeStyle(prefs, type)]),
  );
}

export function styleDiff(
  inherited: TextStyle,
  next: Partial<TextStyle>,
): Partial<TextStyle> {
  const out: Partial<TextStyle> = {};
  for (const key of STYLE_KEYS) {
    if (next[key] !== undefined && next[key] !== inherited[key]) {
      (out as Record<string, unknown>)[key] = next[key];
    }
  }
  return out;
}
export type FittedRow = {
  text: string;
  x: number;
  baseline: number;
  width: number;
};
export type FittedLayout = {
  key: string;
  rows: FittedRow[];
  size: number;
  dpi: number;
  width: number;
  height: number;
  svg: string;
  overflow: boolean;
  missingGlyphs: string[];
  hyphenated: boolean;
  style: TextStyle;
  font: { id: string; hash: string; postscriptName: string };
};
export type RegionData = {
  detectionProvenance?: { crop?: number[]; truncated?: boolean; backend?: string; sources?: string[] };
  bubbleBounds?: { x: number; y: number; w: number; h: number };
  detectionKind?: "bubble" | "free" | "unknown";
  polygon?: Point[];
  geometryApproved?: boolean;
  geometryConfidence?: number;
  style?: Partial<TextStyle>;
  layout?: FittedLayout;
  locked?: boolean;
  /** Page-sized grayscale PNG. White reveals typeset text; black conceals it (Photoshop layer-mask convention). */
  textMask?: string;
};
export type MaskStroke = { points: Point[]; radius: number; erase?: boolean };
/** Grow mask tool: click a mask island to dilate it by this many pixels. */
export const MASK_GROW_MIN = 1;
export const MASK_GROW_MAX = 50;
export const MASK_GROW_DEFAULT = 10;
export type PageData = {
  prepared?: string;
  original?: string;
  preparedAt?: number;
  /** Small sidebar preview stored during prepare/upload. */
  thumbnail?: string;
  thumbnailAt?: number;
  cleaned?: string;
  cleanBase?: string; // Applied cleaning passes; prepared/original remain unchanged.
  /** Artwork the restore brush paints from; pinned across restore strokes after an inpaint. */
  previousArtwork?: string;
  mask?: string;
  maskDiagnostics?: {
    mask: string;
    source: string;
    regions: string;
    version: string;
    engine?: string;
    backend?: string;
    entries: { region: number; regionNumber?: number; lineId?: string; pixels: number; reasons: string[] }[];
  };
  strokes?: MaskStroke[];
  expansion?: number;
  maskApproved?: boolean;
  cleanApproved?: boolean;
  cleanMethod?: string;
  backend?: string;
  dpi?: number;
  /** Stamp of the page when that step was marked complete. A later edit no longer matches. */
  completed?: Partial<Record<PageStep, string>>;
};

export const PAGE_STEPS = ["translate", "review", "clean", "typeset"] as const;
export type PageStep = (typeof PAGE_STEPS)[number];

type StampLine = {
  id: string;
  source?: string | null;
  body?: string | null;
  sourceState?: string | null;
  status?: string | null;
  ignoreReason?: string | null;
};
type StampComment = {
  id: string;
  lineId: string;
  body?: string | null;
  correction?: boolean | null;
};
type StampRegion = { id: string; data?: RegionData | null };

export function pageStepStamp(
  step: PageStep,
  page: PageData,
  lines: StampLine[],
  comments: StampComment[],
  regions: StampRegion[],
) {
  if (step === "clean")
    return [
      page.prepared ?? "",
      page.preparedAt ?? "",
      page.cleaned ?? "",
      page.cleanBase ?? "",
      page.mask ?? "",
      page.maskApproved ? "1" : "0",
      page.cleanApproved ? "1" : "0",
    ].join("\t");
  if (step === "typeset") {
    return [...regions]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((region) => {
        const data = region.data ?? {};
        const style = data.style ?? {};
        const styleText = Object.keys(style)
          .sort()
          .map((key) => `${key}=${JSON.stringify(style[key as keyof typeof style])}`)
          .join(",");
        return [
          region.id,
          data.geometryApproved ? "1" : "0",
          JSON.stringify(data.polygon ?? []),
          data.layout?.key ?? "",
          styleText,
          data.textMask ?? "",
          data.locked ? "1" : "0",
        ].join("\t");
      })
      .join("\n");
  }
  const text = [...lines]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((line) =>
      [
        line.id,
        line.sourceState ?? "",
        line.ignoreReason ?? "",
        line.source ?? "",
        line.body ?? "",
        step === "review" ? line.status ?? "" : "",
      ].join("\t"),
    )
    .join("\n");
  if (step === "translate") return text;
  const notes = [...comments]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((comment) =>
      [comment.lineId, comment.id, comment.correction ? "1" : "0", comment.body ?? ""].join("\t"),
    )
    .join("\n");
  return `${text}\n${notes}`;
}

export function pageStepLabel(step: PageStep) {
  return { translate: "Translate", review: "Review", clean: "Clean", typeset: "Typeset" }[step];
}
/** Working cleaned pixels, else the applied pass, else the prepared source. */
export function pageArtwork(data: Pick<PageData, "cleaned" | "cleanBase" | "prepared">) {
  return data.cleaned || data.cleanBase || data.prepared;
}
/** Uncleaned prepared source the raw brush paints from, when it differs from the working copy. */
export function pageRawArtwork(data: Pick<PageData, "cleaned" | "cleanBase" | "prepared">) {
  if (data.prepared && data.prepared !== pageArtwork(data)) return data.prepared;
}
export type WorkflowDoc<T = Record<string, unknown>> = {
  id: string;
  revision: number;
  data: T;
  canUndo: boolean;
  canRedo: boolean;
};
export type FontAsset = {
  id: string;
  hash: string;
  filename: string;
  familyName: string;
  subfamilyName: string;
  postscriptName: string;
  format: string;
  /** A FontCategoryId; absent on fonts uploaded before categories existed, which read as "other". */
  category?: string;
  /** True for fonts from the shared library, which a series can use but not edit or remove. */
  shared?: boolean;
};
export type ReadinessIssue = {
  code: string;
  message: string;
  imageId?: string;
  lineId?: string;
  pageLabel?: string;
  regionLabel?: string;
  severity?: "error" | "warning";
};

export const SCRIPT_EXPORT_FORMATS = ["json", "english", "bilingual"] as const;

/** Finished image/PSD packages stay gated. Drafts and script/JSON handoffs do not. */
export function exportRequiresCompletion(format: string, draft: boolean) {
  if (draft) return false;
  return !(SCRIPT_EXPORT_FORMATS as readonly string[]).includes(format);
}

export function exportBlockers(issues: ReadinessIssue[]) {
  return issues.filter((issue) => (issue.severity ?? "error") !== "warning");
}

export type GroupedReadinessIssue = {
  key: string;
  code: string;
  message: string;
  severity: "error" | "warning";
  count: number;
  pageLabel?: string;
  regionLabels: string[];
  first: ReadinessIssue;
};

export function groupReadinessIssues(issues: ReadinessIssue[]): GroupedReadinessIssue[] {
  const groups = new Map<string, GroupedReadinessIssue>();
  for (const issue of issues) {
    const key = `${issue.imageId || ""}:${issue.code}:${issue.message}`;
    const existing = groups.get(key);
    const region = issue.regionLabel;
    if (existing) {
      existing.count += 1;
      if (region && !existing.regionLabels.includes(region)) existing.regionLabels.push(region);
      continue;
    }
    groups.set(key, {
      key,
      code: issue.code,
      message: issue.message,
      severity: issue.severity ?? "error",
      count: 1,
      pageLabel: issue.pageLabel,
      regionLabels: region ? [region] : [],
      first: issue,
    });
  }
  return [...groups.values()];
}

/** True when finished export is waiting only on page completion marks. */
export function onlyStepCompleteBlockers(issues: ReadinessIssue[]) {
  const blockers = exportBlockers(issues);
  return blockers.length > 0 && blockers.every((issue) => issue.code === "step-complete");
}
