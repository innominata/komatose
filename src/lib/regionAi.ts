import { decisionThreshold, DECIDER_MIN_PROBABILITY, DECIDER_MIN_MARGIN } from './decider';
import { DEFAULT_CHAT_MODEL_ID } from './modelDefaults';
import type { TaskEngine } from "./aiTasks";
import { selectProvidersForOperation, singleAvailableEngineFor, type LiveProviderEngine, type ProviderOperation, type ProviderSelectionOption } from "./providerCatalog";
import {
  DEFAULT_TRANSCRIPTION_MODEL_IDS,
  hydrateTaskEngine,
  resolveAssistant,
} from "./modelRegistry";
import { isProofreaderId } from "./proofreaders";
import { translationModel } from "./translationModels";
import { normalizeTranslation } from "./translationText";

export const MAX_TRANSCRIPTION_MODELS = 8;
/** Text translators that form the Revise English council. */
export const MAX_REVISE_MODELS = 5;

export type RegionAiSettings = {
  translate: TaskEngine;
  describe: TaskEngine;
  vision: TaskEngine;
  proofread: TaskEngine;
  enquire: TaskEngine;
  reviewers: TaskEngine[];
  /** Saved Revise English council. Empty means Translation plus Proofreading. */
  reviseModels: TaskEngine[];
  transcriptionModels: string[];
  /** Unset follows the installed default; null explicitly disables deciding. */
  transcriptionDecider?: TaskEngine | null;
  deciderMinProbability?: number;
  deciderMinMargin?: number;
};

export function regionAiSettings(
  raw?: Partial<RegionAiSettings>,
  fallback: TaskEngine = { engine: DEFAULT_CHAT_MODEL_ID, model: "" },
): RegionAiSettings {
  const base = hydrateTaskEngine(fallback);
  return {
    translate: hydrateTaskEngine(raw?.translate ?? base),
    describe: hydrateTaskEngine(raw?.describe ?? base),
    vision: hydrateTaskEngine(raw?.vision ?? base),
    proofread: hydrateTaskEngine(raw?.proofread ?? base),
    enquire: hydrateTaskEngine(raw?.enquire ?? base),
    reviewers: Array.isArray(raw?.reviewers)
      ? raw!.reviewers.map((item) => hydrateTaskEngine(item))
      : [],
    reviseModels: Array.isArray(raw?.reviseModels)
      ? raw.reviseModels.map((item) => hydrateTaskEngine(item)).slice(0, MAX_REVISE_MODELS)
      : [],
    transcriptionModels: normalizeTranscriptionModels(raw?.transcriptionModels),
    ...(raw?.transcriptionDecider !== undefined ? { transcriptionDecider: raw.transcriptionDecider === null ? null : hydrateTaskEngine(raw.transcriptionDecider) } : {}),
    ...(raw?.deciderMinProbability !== undefined ? { deciderMinProbability: decisionThreshold(raw.deciderMinProbability, DECIDER_MIN_PROBABILITY) } : {}),
    ...(raw?.deciderMinMargin !== undefined ? { deciderMinMargin: decisionThreshold(raw.deciderMinMargin, DECIDER_MIN_MARGIN) } : {}),
  };
}

export function normalizeTranscriptionModels(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length) return [...DEFAULT_TRANSCRIPTION_MODEL_IDS];
  const ids = value.map((item) => String(item || "").trim()).filter(Boolean);
  const unique = [...new Set(ids)].slice(0, MAX_TRANSCRIPTION_MODELS);
  return unique.length ? unique : [...DEFAULT_TRANSCRIPTION_MODEL_IDS];
}

/**
 * The shipped default translate model is the local chat model, which a fresh
 * install may not have installed or running yet. When exactly one available
 * model supports translate, make it the default so Translate works as soon as
 * any single model can do the job. The choice is derived, never saved, so an
 * explicit selection takes over again as soon as it is available.
 */
export function effectiveTranslateModel(
  saved: TaskEngine | null | undefined,
  engines: readonly LiveProviderEngine[],
): TaskEngine {
  if (saved) return saved;
  const base = { engine: DEFAULT_CHAT_MODEL_ID, model: "" };
  const single = singleAvailableEngineFor(engines, "translate");
  if (single && single !== base.engine) return { engine: single, model: "" };
  return base;
}

/** A request's engine/model pair wins; saved task settings are defaults only. */
export function resolveTaskModel(
  settings: Partial<RegionAiSettings> | undefined,
  task: "translate" | "vision",
  requested: Partial<TaskEngine> = {},
): TaskEngine {
  if (requested.engine)
    return { engine: requested.engine, model: requested.model ?? "" };
  const saved = regionAiSettings(settings)[task];
  return { ...saved, model: requested.model ?? saved.model };
}

export const CONTEXT_OPTIONS = [
  ["regionImage", "Region Image"],
  ["pageImage", "Page Image"],
  ["pageSummary", "Page Summary"],
  ["chapterSummaries", "Chapter Summaries"],
  ["region", "Region"],
  ["seriesSummary", "Series Summary"],
] as const;
export type EnquiryContext = Record<
  (typeof CONTEXT_OPTIONS)[number][0],
  boolean
>;
export const DEFAULT_ENQUIRY_CONTEXT: EnquiryContext = {
  regionImage: false,
  pageImage: false,
  pageSummary: true,
  chapterSummaries: false,
  region: true,
  seriesSummary: true,
};
export type EnquiryMessage = { role: "user" | "assistant"; content: string };
export type AiActionCard = {
  id: string;
  target: "source" | "body";
  body: string;
  translation?: string;
  reason: string;
};
export const FAST_REVISE_SAMPLES = 3;

export function isSourceSuggestion(kind: string): boolean {
  return kind === "source-review" || kind === "source-enquiry";
}

/** Hyphens, dashes, periods, and ellipses do not make two readings different. */
export function suggestionComparableKey(value: string): string {
  return normalizeTranslation(value)
    .normalize("NFKC")
    .replace(/[\p{Pd}.…．｡]/gu, "");
}

export function suggestionsComparable(
  a: { kind: string; body: string; translation?: string | null },
  b: { kind: string; body: string; translation?: string | null },
): boolean {
  const sourceA = isSourceSuggestion(a.kind);
  const sourceB = isSourceSuggestion(b.kind);
  if (sourceA !== sourceB) return false;
  if (!sourceA && a.kind !== b.kind) return false;
  if (suggestionComparableKey(a.body) !== suggestionComparableKey(b.body)) return false;
  if (!sourceA) return true;
  return suggestionComparableKey(a.translation ?? "") === suggestionComparableKey(b.translation ?? "");
}

export function collapseSuggestions<
  T extends { id: string; kind: string; body: string; translation?: string | null; reason?: string | null },
>(items: T[]): Array<T & { mergedIds: string[] }> {
  const out: Array<T & { mergedIds: string[] }> = [];
  for (const item of items) {
    const match = out.find((prev) => suggestionsComparable(prev, item));
    if (!match) {
      out.push({ ...item, mergedIds: [item.id] });
      continue;
    }
    const reasons = [match.reason, item.reason].map((reason) => reason?.trim()).filter((reason): reason is string => !!reason);
    match.reason = [...new Set(reasons)].join("\n");
    match.mergedIds.push(item.id);
  }
  return out;
}

/** True when accepting the suggestion would not change the region's source or English. */
export function suggestionMatchesLine(
  suggestion: { kind: string; body: string; translation?: string | null },
  line: { source?: string | null; body?: string | null },
): boolean {
  const currentSource = suggestionComparableKey(line.source ?? "");
  const currentEnglish = suggestionComparableKey(line.body ?? "");
  if (isSourceSuggestion(suggestion.kind)) {
    if (suggestionComparableKey(suggestion.body) !== currentSource) return false;
    const offered = suggestionComparableKey(suggestion.translation ?? "");
    return !offered || offered === currentEnglish;
  }
  return suggestionComparableKey(suggestion.body) === currentEnglish;
}

export function isProofreaderTranslator(model: TaskEngine): boolean {
  if (isProofreaderId(model.engine) || isProofreaderId(model.engine)) return true;
  try {
    return resolveAssistant(model.engine, model.model, undefined, false).row.access === "proofreader";
  } catch {
    return false;
  }
}

export function sameReviseModel(a: TaskEngine, b: TaskEngine): boolean {
  return a.engine === b.engine && (a.model || "") === (b.model || "");
}

export function reviseSampleCount(_model: TaskEngine): number {
  return 1;
}

export function defaultReviseModels(translate: TaskEngine, proofread: TaskEngine): TaskEngine[] {
  const out = [translate];
  if (sameReviseModel(translate, proofread)) return out;
  return [...out, proofread];
}

/** Saved council, or Translation plus Proofreading when none has been saved. */
export function reviseCouncil(
  settings: Pick<RegionAiSettings, "translate" | "proofread" | "reviseModels">,
): TaskEngine[] {
  const saved: TaskEngine[] = [];
  for (const model of settings.reviseModels ?? []) {
    if (!model?.engine) continue;
    if (saved.some((item) => sameReviseModel(item, model))) continue;
    saved.push({ engine: model.engine, model: model.model || "" });
    if (saved.length >= MAX_REVISE_MODELS) break;
  }
  return saved.length ? saved : defaultReviseModels(settings.translate, settings.proofread);
}

type ReviewerRuntime = {
  id: string;
  access?: string;
  autoRun?: boolean;
  cliAdapter?: string;
  slug?: string;
};

function reviewerRuntime(model: TaskEngine | undefined, live: readonly ReviewerRuntime[]) {
  if (!model?.engine) return undefined;
  const row = live.find(row => row.id === model.engine)
    ?? live.find(row => row.access === 'cli' && row.cliAdapter === model.engine && row.slug === (model.model || ''));
  if (row?.access) return row;
  try {
    return resolveAssistant(model.engine, model.model, undefined, false).row;
  } catch {
    return { access: 'unknown', autoRun: false };
  }
}

/** Non-local models retain a Run button even when Autorun is enabled. */
export function isNonLocalReviewer(model: TaskEngine | undefined, live: readonly ReviewerRuntime[] = []): boolean {
  const row = reviewerRuntime(model, live);
  return !!row && row.access !== 'local_http';
}

/** Non-local reviews require Run unless an administrator opted the model into Autorun. */
export function isOnDemandReviewer(model: TaskEngine | undefined, live: readonly ReviewerRuntime[] = []): boolean {
  const row = reviewerRuntime(model, live);
  // A saved preference authorizes this row's model, not an arbitrary slug override.
  const registeredTarget = !model?.model || (row && 'slug' in row && row.slug === model.model);
  return !!row && row.access !== 'local_http' && (row.autoRun !== true || !registeredTarget);
}

/** Region AI settings fields mapped to catalog operations they actually run. */
export const REGION_AI_FIELD_OPERATIONS = {
  translate: "translate",
  describe: "describe",
  vision: "vision",
  proofread: ["proofreadEnglish", "pageImageProofread"],
  enquire: "advisory",
  reviewers: "sourceReview",
  transcriptionDecider: "sourceDecide",
} as const satisfies Record<string, ProviderOperation | readonly ProviderOperation[]>;

export type RegionAiField = keyof typeof REGION_AI_FIELD_OPERATIONS;

/** Models whose Jobs-panel test passed for this field. A saved miss stays visible but unavailable. */
export function enginesForRegionAiField(
  field: RegionAiField,
  engines: readonly LiveProviderEngine[],
  savedId?: string,
  extras: readonly LiveProviderEngine[] = [],
): ProviderSelectionOption[] {
  return selectProvidersForOperation(
    engines,
    REGION_AI_FIELD_OPERATIONS[field],
    savedId,
    extras,
  );
}
