import { activeRegionKinds, type RegionKind } from "./regionCatalog";
import { LINE_TYPES, type OcrLang, type Detector } from "./types";
import { effectiveTextRotation } from "./textRotation";

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
  /** Fill opacity, 0–100. */
  fillOpacity: number;
  autoContrast?: boolean;
  outline: string;
  /** Outline opacity, 0–100. */
  outlineOpacity: number;
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
  /** Warp Text Horizontal Distortion, −100 to 100. */
  warpHorizontal?: number;
  /** Warp Text Vertical Distortion, −100 to 100. */
  warpVertical?: number;
  /** Warp Text orientation: the bend runs across (horizontal) or down (vertical) the text. */
  warpOrientation?: "horizontal" | "vertical";
  /** Letter spacing in thousandths of an em, like Photoshop's tracking. */
  tracking?: number;
  emphasis: "normal" | "bold" | "italic";
  /** Photoshop layer styles on the whole region (the outline is its Stroke). */
  effects?: import("./textEffects").TextEffects;
};
/**
 * Character overrides on part of a region's text, like Photoshop's Character panel. Unset
 * fields follow the region's style. `size` is a percentage of the fitted size, so autofit
 * still shrinks the whole region together.
 */
export type CharStyle = {
  fontId?: string;
  size?: number;
  fill?: string;
  fillOpacity?: number;
  outline?: string;
  outlineOpacity?: number;
  outlineWidth?: number;
  emphasis?: "normal" | "bold" | "italic";
  /** Thousandths of an em, added to the region's tracking. */
  tracking?: number;
  /** Points; positive raises the characters. */
  baselineShift?: number;
  /** Percent. */
  horizontalScale?: number;
  /** Percent. */
  verticalScale?: number;
};
export const CHAR_STYLE_KEYS = [
  "fontId",
  "size",
  "fill",
  "fillOpacity",
  "outline",
  "outlineOpacity",
  "outlineWidth",
  "emphasis",
  "tracking",
  "baselineShift",
  "horizontalScale",
  "verticalScale",
] as const satisfies readonly (keyof CharStyle)[];
/** Character style over the half-open range [start, end) of the region body. */
export type CharRun = { start: number; end: number; style: CharStyle };
/**
 * Type on a path: the text runs along a smooth curve through `points` (page fractions)
 * instead of filling the region polygon. `offset` is where the text starts along the path,
 * as a fraction of its length, before alignment; `flip` runs it from the last point,
 * upside down on the other side of the curve.
 */
export type TextPath = { points: Point[]; offset?: number; flip?: boolean };
/** Photoshop's Warp Text styles in its menu order. */
export const TEXT_WARP_STYLES = [
  "none",
  "arc",
  "arcLower",
  "arcUpper",
  "arch",
  "bulge",
  "shellLower",
  "shellUpper",
  "flag",
  "wave",
  "fish",
  "rise",
  "fisheye",
  "inflate",
  "squeeze",
  "twist",
] as const;
export type TextWarpStyle = (typeof TEXT_WARP_STYLES)[number];
export const TEXT_WARP_STYLE_LABELS: Record<TextWarpStyle, string> = {
  none: "None",
  arc: "Arc",
  arcLower: "Arc Lower",
  arcUpper: "Arc Upper",
  arch: "Arch",
  bulge: "Bulge",
  shellLower: "Shell Lower",
  shellUpper: "Shell Upper",
  flag: "Flag",
  wave: "Wave",
  fish: "Fish",
  rise: "Rise",
  fisheye: "Fisheye",
  inflate: "Inflate",
  squeeze: "Squeeze",
  twist: "Twist",
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
  fillOpacity: 100,
  autoContrast: true,
  outline: "#ffffff",
  outlineOpacity: 100,
  outlineWidth: 0,
  rotation: 0,
  skewX: 0,
  skewY: 0,
  warpStyle: "none",
  warpBend: 0,
  warpHorizontal: 0,
  warpVertical: 0,
  warpOrientation: "horizontal",
  tracking: 0,
  emphasis: "normal",
};
export type Preferences = {
  regionAi?: import("./regionAi").RegionAiSettings;
  /** Series settings; legacy chapter overrides are ignored. */
  lang: OcrLang;
  direction: "rtl" | "ltr";
  pageMode: "pages" | "strip";
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
  /**
   * Lettering that is only punctuation (a lone "?" or "!!" drawn as a sound
   * effect): `replace` cleans it and letters it again, `keep` leaves the
   * original drawing and neither cleans nor letters it.
   */
  punctuationOnly?: PunctuationOnly;
  style?: Partial<TextStyle>;
  /** Keyed by line type id; series-added region type ids are valid keys too. */
  styles: Partial<Record<string, Partial<TextStyle>>>;
  /** When set, this series uses these region types instead of the built-in list. */
  regionKinds?: RegionKind[];
};
export type PunctuationOnly = "replace" | "keep";

/** Marks and symbols only, such as "?", "!!" or "…": no letters or digits. */
export function punctuationOnlyText(source: string | null | undefined): boolean {
  const text = (source ?? "").normalize("NFKC").replace(/\s+/g, "");
  return text.length > 0 && /^[\p{P}\p{S}]+$/u.test(text);
}

export const DEFAULT_PREFERENCES: Preferences = {
  lang: "japanese",
  direction: "rtl",
  pageMode: "pages",
  dpi: null,
  aliases: "",
  translationPreferences: "",
  chapterSummary: "",
  transcribeEnglish: false,
  punctuationOnly: "replace",
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
  "fillOpacity",
  "autoContrast",
  "outline",
  "outlineOpacity",
  "outlineWidth",
  "rotation",
  "skewX",
  "skewY",
  "warpStyle",
  "warpBend",
  "warpHorizontal",
  "warpVertical",
  "warpOrientation",
  "tracking",
  "emphasis",
  "effects",
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

/** A region owns its style once every field is stored on it, not filled in from the series default. */
export function styleIsOwned(style: Partial<TextStyle> | undefined): boolean {
  // A layer style is optional: absent means none.
  return !!style && STYLE_KEYS.every((key) => key === "effects" || style[key] !== undefined);
}

/**
 * What the style panel shows. An owned style stays put when the series default
 * changes. The default is copied onto a region when it is created, when Reset
 * to Default is clicked, or when that type is refit in the chapter.
 */
export function regionPanelStyle(
  inherited: TextStyle,
  data: { style?: Partial<TextStyle>; layout?: { style?: Partial<TextStyle> }; geometryRotation?: number } | undefined,
): TextStyle {
  if (data?.style && styleIsOwned(data.style)) return { ...DEFAULT_STYLE, ...data.style };
  if (data?.layout?.style) return { ...DEFAULT_STYLE, ...data.layout.style,
    rotation: effectiveTextRotation(-(data.geometryRotation ?? 0), data.layout.style.rotation ?? 0), ...data.style };
  return { ...inherited, ...data?.style };
}
export type FittedRow = {
  text: string;
  x: number;
  baseline: number;
  width: number;
  /**
   * The row cut where its character style changes: `text` of each piece, and the index of
   * its style in `FittedLayout.charStyles`. Absent when the whole layout has one style.
   */
  pieces?: { text: string; style: number }[];
  /** Path text: the index in `RegionData.textPaths` this row runs along; `x` is its start along it. */
  path?: number;
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
  /** Resolved character styles used by `rows[].pieces`, with each one's font. */
  charStyles?: (CharStyle & { postscriptName: string })[];
  /** Laid out along `RegionData.textPaths`, one row per path, which PSD Warp Text cannot represent. */
  onPath?: boolean;
};
export type RegionData = {
  /** Retain the region and its text while suppressing its English lettering. */
  renderEnabled?: boolean;
  directorRenderingReview?: {runId:string;duplicateOf:string;evidence:string;reviewed?:boolean};
  /** Machine exclusions stay distinguishable from a later human ignore/edit. */
  directorDetectionReview?: {
    runId: string;
    lineRevision: number;
    verdict: "non-text" | "duplicate";
    duplicateOf: string;
    evidence: string;
  };
  speaker?: import('./characters').CharacterAssignment;
  sourceDecision?: import('./decider').TranscriptionDecision;
  detectionProvenance?: { crop?: number[]; truncated?: boolean; backend?: string; sources?: string[] };
  bubbleBounds?: { x: number; y: number; w: number; h: number };
  detectionKind?: "bubble" | "free" | "unknown";
  /** Visual evidence is valid only for this raw image and geometry. */
  directorPresentation?: {
    raw: string;
    box: string;
    source: string;
    enclosure: "bubble" | "box" | "none" | "uncertain";
    handwritten: boolean;
    role: "speech" | "thought" | "narration" | "sfx" | "uncertain";
    reason: string;
  };
  /** Detection found a black rectangular border around this region. */
  boxed?: boolean;
  polygon?: Point[];
  /** Rotation inherited by lettering from the geometry handle; style.rotation is the text-only offset. */
  geometryRotation?: number;
  /** Signature of a polygon in an old page frame; changing the shape invalidates it. */
  resliceStalePolygon?: string;
  geometryApproved?: boolean;
  geometryConfidence?: number;
  style?: Partial<TextStyle>;
  /** Character overrides, valid for the body `charRunsBody`; see `remapCharRuns`. */
  charRuns?: CharRun[];
  charRunsBody?: string;
  /** Type on a path: the text flows along these paths in order, one line each. */
  textPaths?: TextPath[];
  /** A single path saved before regions held several; read through `regionTextPaths`. */
  textPath?: TextPath;
  /** A category refit keeps only placement overrides; avoid copying the resolved default on chapter load. */
  styleFromSeries?: boolean;
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
  /** Newly detected regions still needing removal from the working artwork. */
  pendingCleanRegions?: string[];
  /** Verified regional cleaning survives retries while source/artwork/geometry match. */
  directorCleaning?: {raw:string;artwork:string;regions:Record<string,{geometry:string;method:string;bubbleToolsOnly?:boolean}>};
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
  /** The last image-editor clean's saved answer, so its post-processing can change later. */
  cleanFinish?: import("./postprocess").CleanFinish;
  cleanDurationMs?: number;
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
          ...(data.renderEnabled===false||data.directorRenderingReview ? [data.renderEnabled===false?"render-off":"render-on",data.directorRenderingReview?.reviewed?"render-reviewed":"render-unreviewed"]:[]),
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
