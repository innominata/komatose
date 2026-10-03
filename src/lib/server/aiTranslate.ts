import { rowHasOperation, isTranslationSpecialist } from '../modelRegistry';
import { DEFAULT_CHAT_MODEL_ID } from '../modelDefaults';
import { effectiveDefault } from './modelDefaultStore';
import { normalizeTranslation } from "../translationText";
import { assertTranslationLanguage, translationModel } from '../translationModels';
import { regionAiSettings, resolveTaskModel } from "../regionAi";
import { singleAvailableEngineFor } from "../providerCatalog";
import { registryPickerRows } from "./registryPicker";
import { regionRectangle, sameDetectedTextBox } from "../regionGeometry";
import { assertOcrConsensusInstalled, defaultTranscriptionRead, readOcrConsensus, saveOcrConsensus, transcriptionModelIds } from "./ocrConsensus";
import {
  collectFillMissingWork,
  needsFillEnglish,
  saveFillMissingSource,
  writeFillMissingEnglish,
  writeFillMissingSuggestionTranslation,
} from "./fillMissing";
import { ocrTranslatorLabel, translateOcrSource } from "./ocrReview";
import { assertTranslationModelReady } from "./translationRuntime";
import { imageMessage, localChat, localTranscription, withLocalReview } from "./localReview";
import { qwen3VlReviewId } from "../qwenModels";
import { liveAssistantName, resolveLiveAssistant } from "./assistantRoute";
import { failedOcrConsensus, type OcrConsensus } from "../ocrConsensus";
import {
  dropRedundantTranscriptions,
  transcriptionIsEnglish,
  transcriptionOverlapSource,
} from "../transcribeRegions";
import { detectLetteringMask, maskedBubbleCrop, transcribeBubbleCrop } from "./reviewMask";
import { describePages, isDescribeRunning } from "./pageEdit";
import { isResliceRunning } from "./reslice";
import { acceptSuggestion, preferences } from "./workflowService";
import { assertEngineReady } from "./engineReadiness";
import { orderRegions } from "../readingOrder";
import { appendJobLog, createJob, updateJob, pageResult, listJobs, runWithJob } from "./jobs";
import { suggest, getDoc, putDoc } from "./workflowStore";
import { readFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import type {
  CommentRow,
  Episode,
  LineRow,
  OcrLang,
  PublicUser,
  ReviewReport,
  Series,
  TranslateEngine,
} from "../types";
import { logActivity } from "./activity";
import { db, sqlite } from "./db";
import { comments, episodes, lines } from "./db/schema";
import { nid, now } from "./ids";
import { bubbleFromNorm } from "./bubbles";
import { komatoseGpuEnabled } from "./gpuMode";
import {
  detectRegions,
  jobStepMessage,
  KOHARU_MODEL,
  maskModelName,
} from "./detect";
import { resolveDetector, type ResolvedDetector } from "./detectorConfig";
import { detectorSetupId, detectorSetupLabel, type DetectorSetupConfig } from "../detectorSetup";
import { extractJsonObject, parseReadPayload, readBubble, readBubbleCopy, translateScript, suggestAlternativesScript, READ_SCHEMA, type DetectedBox } from "./llm";
import {
  readBubbleWithCli,
  translateScriptWithCli,
  suggestAlternativesWithCli,
} from "./cliTranslate";
import { runTranslationTask, type TranslationTaskHandlers } from "./translationTask";
import { runVisionRead, type VisionReadHandlers } from "./visionRead";
import { runAlternatives, type AlternativesHandlers } from "./alternatives";
import { formatChapterScript, loadChapterPack, sceneNotesForPage } from "./proofread";
import {
  parseOcrLang,
} from "./ocr";
import { shouldInvertText } from "./stickyInvert";
import { glossaryPrompt } from "../glossary";
import { classifyRegionLineType, lookupStandaloneSfx, sfxClassificationSource } from "../sfx";
import {
  getEpisode,
  getSeries,
  listImages,
  listLines,
  toLine,
} from "./queries";
import { broadcast } from "./realtime";
import { imagePath, readWorkingOrOrig } from "./storage";
import { ensureAiUser } from "./aiUser";
import { proofreadChapter } from "./proofread";
import { reviewChapter } from "./review";

export type AiJobKind = "transcribe" | "translate" | "proofread" | "review";

export type AiJobSnapshot = {
  episodeId: string;
  running: boolean;
  imageIndex: number;
  imageCount: number;
  message: string;
  error?: string;
  engine?: TranslateEngine;
  /** Detector setup id, such as `ctd+koharu`; transcription only. */
  detector?: string;
  detectConf?: number;
  lang?: OcrLang;
  kind?: AiJobKind;
  model?: string;
  report?: ReviewReport;
};

type Job = AiJobSnapshot & {
  modelSelections?: Array<{ engine: string; model: string }>;
  id?: string;
  abort: AbortController;
  user: PublicUser;
  engine: TranslateEngine;
  detection?: ResolvedDetector;
  lang: OcrLang;
  kind: AiJobKind;
  model?: string;
  imageIds?: string[];
};

const g = globalThis as typeof globalThis & {
  __scanAiJobs?: Map<string, Job>;
  __scanRegionQ?: Map<string, RegionQueue>;
};
if (!g.__scanAiJobs) g.__scanAiJobs = new Map();
if (!g.__scanRegionQ) g.__scanRegionQ = new Map();
const jobs = g.__scanAiJobs;
const regionQueues = g.__scanRegionQ;

type RegionItem = {
  id: string;
  jobId: string;
  imageId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  engine?: TranslateEngine;
  lang?: OcrLang;
  model?: string;
  forceVision?: boolean;
  lineId?: string;
  expectedRevision?: number;
  user: PublicUser;
};

type RegionQueue = {
  episodeId: string;
  series: Series;
  episode: Episode;
  items: RegionItem[];
  running: boolean;
  message: string;
  total: number;
  completed: number;
  abort?: AbortController;
};

export class AiJobError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function isFullAiRunning(episodeId: string): boolean {
  return Boolean(jobs.get(episodeId)?.running);
}

export function assertEpisodeIdle(episodeId: string) {
  if (
    isFullAiRunning(episodeId) ||
    rereadBatches.has(episodeId) ||
    fillMissingBatches.has(episodeId) ||
    suggestBatches.has(episodeId) ||
    isDescribeRunning(episodeId) ||
    isResliceRunning(episodeId)
  ) {
    throw new AiJobError("Chapter is locked while AI is running", 409);
  }
}

export function isRegionQueueBusy(episodeId: string): boolean {
  const q = regionQueues.get(episodeId);
  return rereadBatches.has(episodeId) || fillMissingBatches.has(episodeId) ||
    suggestBatches.has(episodeId) || Boolean(q && (q.running || q.items.length));
}

export function regionQueueSnapshot(episodeId: string) {
  const q = regionQueues.get(episodeId);
  if (!q) return { pending: 0, running: false, message: "" };
  return {
    pending: q.items.length + (q.running ? 1 : 0),
    running: q.running,
    message: q.message,
  };
}

function emitRegion(episodeId: string) {
  const snap = regionQueueSnapshot(episodeId);
  broadcast(episodeId, { type: "region:queue", ...snap });
}

async function loadTranslateContext(
  seriesId: string,
  episodeId: string,
  imageId?: string,
) {
  const s = await getSeries(seriesId);
  const ep = await getEpisode(episodeId);
  const imgs = await listImages(episodeId);
  const img = imageId ? imgs.find((i) => i.id === imageId) : null;
  const idx = img ? imgs.findIndex((i) => i.id === img.id) : -1;
  const prefs = preferences(episodeId, seriesId);
  return {
    seriesNotes: [s?.notes, prefs.aliases, prefs.translationPreferences]
      .filter(Boolean)
      .join("\n"),
    prior: "",
    seriesGlossary: glossaryPrompt(s?.glossary || [], 80),
    pageCaption: sceneNotesForPage(imgs, imageId, prefs.chapterSummary),
    pageLabel: img
      ? `${ep?.title || ""} · page ${idx + 1}/${imgs.length}`
      : `${ep?.title || ""} · selection`,
  };
}

function chapterTranslator(
  seriesId: string,
  episodeId: string,
  requested?: { engine?: TranslateEngine; model?: string },
) {
  return resolveTaskModel(preferences(episodeId, seriesId).regionAi, "translate", requested);
}

function transcriptionIdsFor(seriesId: string, episodeId: string) {
  return transcriptionModelIds(regionAiSettings(preferences(episodeId, seriesId).regionAi).transcriptionModels);
}

function assertTranslatorTask(selected: { engine: TranslateEngine | string; model: string }, _lang?: OcrLang) {
  const { row } = resolveLiveAssistant(String(selected.engine || ''), selected.model);
  if (row.disabled) throw new AiJobError(`${row.name} is disabled`);
  if (row.implementedTasks && !row.implementedTasks.includes('translate'))
    throw new AiJobError(`${row.name} does not implement Translate.`);
}

async function bindOcrTranslator(
  seriesId: string,
  episodeId: string,
  selected: { engine: TranslateEngine; model: string },
  lang?: OcrLang,
) {
  const ctx = await loadTranslateContext(seriesId, episodeId);
  const opts = {
    engine: selected.engine,
    model: selected.model,
    lang,
    seriesGlossary: ctx.seriesGlossary,
    seriesNotes: ctx.seriesNotes,
  };
  return {
    label: ocrTranslatorLabel(selected.engine, selected.model),
    translate: (source: string, abort: AbortSignal, sourceLang?: OcrLang) =>
      translateOcrSource(source, abort, { ...opts, lang: sourceLang ?? lang }),
  };
}

export function jobSnapshot(episodeId: string): AiJobSnapshot | null {
  const job = jobs.get(episodeId);
  if (!job) {
    const last = listJobs(episodeId).find((j) =>
      ["translate", "proofread", "review"].includes(j.kind),
    );
    return last
      ? {
          ...last.progress,
          imageIndex: Number(last.progress.imageIndex || 0),
          imageCount: Number(last.progress.imageCount || 0),
          episodeId,
          running: false,
          message:
            last.state === "interrupted"
              ? "Interrupted by restart — retry available in workflow"
              : last.progress.message,
          error: last.error ?? undefined,
        }
      : null;
  }
  return {
    episodeId: job.episodeId,
    running: job.running,
    imageIndex: job.imageIndex,
    imageCount: job.imageCount,
    message: job.message,
    error: job.error,
    engine: job.engine,
    detector: job.detector,
    detectConf: job.detectConf,
    lang: job.lang,
    kind: job.kind,
    model: job.model,
    report: job.report,
  };
}

function emit(job: Job) {
  if (!job.id)
    job.id = createJob(job.episodeId, job.kind, {
      engine: job.engine,
      modelSelections: job.modelSelections,
      detector: job.detector,
      detectConf: job.detectConf,
      lang: job.lang,
      model: job.model,
      imageIds: job.imageIds,
    });
  updateJob(
    job.id,
    job.running
      ? "running"
      : job.abort.signal.aborted
        ? "cancelled"
        : job.error
          ? "failed"
          : "completed",
    { ...jobSnapshot(job.episodeId), id: job.id },
    job.error ?? null,
  );
  broadcast(job.episodeId, {
    type: "ai:progress",
    running: job.running,
    imageIndex: job.imageIndex,
    imageCount: job.imageCount,
    message: job.message,
    error: job.error,
    engine: job.engine,
    detector: job.detector,
    detectConf: job.detectConf,
    lang: job.lang,
    kind: job.kind,
    model: job.model,
    report: job.report,
  });
}

function reportStep(job: Job, update: { step: string; model: string; engine?: string }) {
  const message = jobStepMessage(job.imageIndex, job.imageCount, update.step, update.model);
  if (job.message === message) return;
  job.message = message;
  job.model = update.model;
  if (update.engine) job.engine = update.engine;
  emit(job);
  if (job.id) appendJobLog(job.id, {
    step: update.step,
    engine: update.engine || update.model,
    model: update.model,
    request: message,
  });
}

function glossaryOf(pairs: { source: string; translation: string }[]): string {
  return pairs
    .filter((p) => p.source)
    .slice(-80)
    .map((p) => `${p.source} → ${p.translation}`)
    .join("\n");
}

const translationTaskHandlers: TranslationTaskHandlers = {
  cli: translateScriptWithCli,
  local: translateScript,
};

const visionReadHandlers: VisionReadHandlers = {
  cli: (engine, opts) => readBubbleWithCli(engine, opts.jpeg, { lang: opts.lang, model: opts.model, abort: opts.abort }),
  ocr: async (id, opts) => {
    if (!opts.abort) throw new Error('OCR needs a cancellation signal');
    const source = await localTranscription(id as import('./localReview').TranscriptionModelId, opts.jpeg, opts.abort, opts.lang);
    return { source: source.trim(), lineType: '""' as const };
  },
  qwen3vl: async (opts) => {
    const copy = readBubbleCopy(opts.lang);
    const text = await withLocalReview(
      (signal) => localChat(
        qwen3VlReviewId(opts.model),
        [
          { role: 'system', content: copy.system },
          imageMessage(opts.jpeg, copy.user),
        ],
        signal,
        READ_SCHEMA.json_schema.schema,
      ),
      opts.abort,
    );
    return parseReadPayload(extractJsonObject(text));
  },
  local: (opts) => readBubble(opts.jpeg, opts.abort, opts.model, opts.lang),
};

/** The real alternatives handlers — exported so model probes run the very same path. */
export const alternativesHandlers: AlternativesHandlers = {
  cli: suggestAlternativesWithCli,
  local: suggestAlternativesScript,
};

async function runTranslate(
  engine: TranslateEngine,
  boxes: DetectedBox[],
  opts: {
    requireTranslation?: boolean;
    seriesNotes: string;
    prior: string;
    pageLabel: string;
    abort?: AbortSignal;
    lang?: OcrLang;
    jpeg?: Buffer;
    pageCaption?: string;
    seriesGlossary?: string;
    model?: string;
  },
): Promise<DetectedBox[]> {
  return runTranslationTask({ engine, boxes, ...opts }, translationTaskHandlers);
}

const sourceTranslations = new Map<string, AbortController>();
const regionOcrs = new Map<string, AbortController>();

export function cancelSourceRetranslation(jobId: string) {
  sourceTranslations.get(jobId)?.abort();
}

export function cancelRegionOcr(jobId: string) {
  regionOcrs.get(jobId)?.abort();
}

/** Hayai + PaddleOCR-VL on an existing drawn region; same consensus path as chapter transcribe. */
export function startRegionOcr(opts: {
  series: Series;
  episode: Episode;
  user: PublicUser;
  lineId: string;
  expectedRevision?: number;
  lang?: OcrLang;
}) {
  const ocrIds = transcriptionIdsFor(opts.series.id, opts.episode.id);
  assertOcrConsensusInstalled(ocrIds);
  if (isFullAiRunning(opts.episode.id))
    throw new AiJobError("Chapter is locked while AI is running", 409);
  const row = db.select().from(lines).where(and(eq(lines.id, opts.lineId), eq(lines.episodeId, opts.episode.id))).get();
  if (!row) throw new AiJobError("Region not found", 404);
  if (opts.expectedRevision != null && row.revision !== opts.expectedRevision)
    throw new AiJobError("Region changed. Reload it before transcribing.", 409);
  const line = toLine(row);
  if (!line.imageId || line.x == null || line.y == null || line.w == null || line.h == null)
    throw new AiJobError("Region needs image bounds");
  if (line.sourceState === "ignored")
    throw new AiJobError("Ignored regions are not transcribed");
  const lang = opts.lang || parseOcrLang(preferences(opts.episode.id, opts.series.id).lang);
  const translator = chapterTranslator(opts.series.id, opts.episode.id);
  assertTranslatorTask(translator, lang);
  const jobId = createJob(opts.episode.id, "region-ocr", {
    lineId: line.id, expectedRevision: line.revision, imageId: line.imageId, lang,
  });
  const abort = new AbortController();
  regionOcrs.set(jobId, abort);
  const ocrNames = ocrIds.map((id) => liveAssistantName(id)).join(" + ") || "transcription";
  const maskName = maskModelName();
  const maskModel = maskName === KOHARU_MODEL
    ? `${maskName} · ${komatoseGpuEnabled() ? "GPU" : "CPU"}`
    : maskName;
  const progress = {
    lineId: line.id,
    message: `Detecting lettering mask · ${maskModel}`,
    engine: "mask",
    model: maskModel,
  };
  updateJob(jobId, "running", progress);
  appendJobLog(jobId, { step: "Detecting lettering mask", engine: "mask", model: maskModel, request: progress.message });
  void (async () => {
    try {
      const imgs = await listImages(opts.episode.id);
      const img = imgs.find((item) => item.id === line.imageId);
      if (!img) throw new AiJobError("Page not found", 404);
      const raw = await readWorkingOrOrig(opts.series.slug, opts.episode.slug, img.filename);
      if (!raw) throw new AiJobError(`Missing image file for ${img.originalName}`, 404);
      const meta = await sharp(raw).metadata();
      const width = meta.width || img.width || 1;
      const height = meta.height || img.height || 1;
      const bubble = bubbleFromNorm(width, height, line.x ?? 0, line.y ?? 0, line.w ?? 0.2, line.h ?? 0.1);
      if (bubble.width < 12 || bubble.height < 12)
        throw new AiJobError("Selection is too small");
      const jpeg = await maskedBubbleCrop(raw, bubble, abort.signal);
      abort.signal.throwIfAborted();
      const ocr = await bindOcrTranslator(opts.series.id, opts.episode.id, translator, lang);
      progress.message = `Reading text · ${ocrNames}`;
      progress.model = ocrNames;
      progress.engine = ocrIds[0] || "ocr";
      updateJob(jobId, "running", progress);
      appendJobLog(jobId, { step: "Reading text", engine: progress.engine, model: ocrNames, request: progress.message });
      const consensus = await readOcrConsensus(jpeg, abort.signal, defaultTranscriptionRead, ocr.translate, lang, ocrIds, {
        onTranslate: () => {
          progress.message = `Translating transcription · ${ocr.label}`;
          progress.model = ocr.label;
          progress.engine = "translate";
          updateJob(jobId, "running", progress);
          appendJobLog(jobId, { step: "Translating transcription", engine: "translate", model: ocr.label, request: progress.message });
        },
      });
      abort.signal.throwIfAborted();
      const current = db.select().from(lines).where(eq(lines.id, line.id)).get();
      if (!current || current.episodeId !== opts.episode.id)
        throw new AiJobError("Region not found", 404);
      const saved = saveOcrConsensus(opts.episode.id, toLine(current), consensus, ocr.label);
      let message = saved?.source?.trim()
        ? (saved.body?.trim()
          ? "Region transcribed and translated"
          : "Region transcribed · matching source is ready to translate")
        : "Transcription models disagreed · readings saved as suggestions";
      if (
        consensus.agreed &&
        saved?.source?.trim() &&
        saved.sourceState === "read" &&
        // The write below is compare-and-set on this revision.
        typeof saved.revision === "number"
      ) {
        try {
          progress.message = `Translating transcription · ${ocr.label}`;
          progress.model = ocr.label;
          progress.engine = "translate";
          updateJob(jobId, "running", progress);
          appendJobLog(jobId, { step: "Translating transcription", engine: "translate", model: ocr.label, request: progress.message });
          abort.signal.throwIfAborted();
          await assertEngineReady(translator.engine, translator.model);
          abort.signal.throwIfAborted();
          const ctx = await loadTranslateContext(opts.series.id, opts.episode.id, saved.imageId ?? undefined);
          const translated = await runTranslate(translator.engine, [{
            x: saved.x ?? 0, y: saved.y ?? 0, w: saved.w ?? 0.2, h: saved.h ?? 0.1,
            lineType: saved.lineType, source: saved.source, literal: "", translation: "", reasoning: "",
          }], {
            ...ctx, lang, model: translator.model, abort: abort.signal,
            requireTranslation: true, pageLabel: `${opts.episode.title} · region`,
          });
          abort.signal.throwIfAborted();
          const body = translated[0]?.translation.trim();
          if (!body) throw new AiJobError("Translation was empty.");
          const written = db.update(lines).set({
            body, status: "needs_work", updatedBy: opts.user.id, updatedAt: now(),
          }).where(and(
            eq(lines.id, saved.id), eq(lines.episodeId, opts.episode.id), eq(lines.revision, saved.revision),
          )).run();
          if (written.changes) {
            broadcast(opts.episode.id, {
              type: "line:upsert",
              line: toLine(db.select().from(lines).where(eq(lines.id, saved.id)).get()!),
            });
            message = "Region transcribed and translated";
          } else {
            message = "Region transcribed · translation skipped because the region changed";
          }
        } catch (e) {
          if (abort.signal.aborted) throw e;
          message = saved.body?.trim()
            ? "Region transcribed and translated"
            : `Region transcribed · translation failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      updateJob(jobId, "completed", { ...progress, message });
    } catch (e) {
      updateJob(jobId, abort.signal.aborted ? "cancelled" : "failed", progress,
        e instanceof Error ? e.message : String(e));
    } finally {
      regionOcrs.delete(jobId);
    }
  })();
  return { jobId };
}

export function acceptRegionSuggestion(opts: {
  series: Series; episode: Episode; user: PublicUser;
  id: string; decision: string; force?: boolean;
  engine?: TranslateEngine; model?: string; lang?: OcrLang;
}): { jobId?: string } {
  const changed = acceptSuggestion(opts.episode.id, opts.id, opts.user.id, opts.decision, opts.force);
  return changed ? startSourceRetranslation({ ...opts, ...changed }) : {};
}

/** Translate the accepted transcription directly; rereading the crop would undo it. */
export function startSourceRetranslation(opts: {
  series: Series; episode: Episode; user: PublicUser;
  lineId: string; expectedRevision: number;
  engine?: TranslateEngine; model?: string; lang?: OcrLang;
}) {
  const row = db.select().from(lines).where(and(eq(lines.id, opts.lineId), eq(lines.episodeId, opts.episode.id))).get();
  if (!row) throw new AiJobError("Region not found", 404);
  if (row.revision !== opts.expectedRevision)
    throw new AiJobError("Region changed since this source correction. Request a new translation for the current text.", 409);
  const line = toLine(row);
  const model = regionAiSettings(preferences(opts.episode.id, opts.series.id).regionAi,
    { engine: opts.engine || effectiveDefault('translate', DEFAULT_CHAT_MODEL_ID), model: opts.model || "" }).translate;
  const lang = opts.lang || parseOcrLang(undefined);
  const jobId = createJob(opts.episode.id, "source-translation", {
    lineId: line.id, expectedRevision: line.revision, ...model, lang,
  });
  const abort = new AbortController();
  sourceTranslations.set(jobId, abort);
  const progress = { lineId: line.id, message: "Translating corrected source…" };
  updateJob(jobId, "running", progress);
  void (async () => {
    try {
      await assertEngineReady(model.engine, model.model);
      abort.signal.throwIfAborted();
      const ctx = await loadTranslateContext(opts.series.id, opts.episode.id, line.imageId ?? undefined);
      const translated = await runTranslate(model.engine, [{
        x: line.x ?? 0, y: line.y ?? 0, w: line.w ?? 0.2, h: line.h ?? 0.1,
        lineType: line.lineType, source: line.source || "",
        literal: "", translation: "", reasoning: "",
      }], { ...ctx, lang, model: model.model, abort: abort.signal, requireTranslation: true });
      abort.signal.throwIfAborted();
      const body = translated[0]?.translation.trim();
      if (!body) throw new AiJobError("Translation was empty. Previous English was preserved; retry the translation.");
      // Use the revision captured at acceptance, never a revision fetched after
      // the model responds: a concurrent source OR English edit must survive.
      const result = db.update(lines).set({ body, status: "needs_work", updatedBy: opts.user.id, updatedAt: now() })
        .where(and(eq(lines.id, line.id), eq(lines.episodeId, opts.episode.id), eq(lines.revision, opts.expectedRevision))).run();
      if (!result.changes) {
        const exists = db.select().from(lines).where(eq(lines.id, line.id)).get();
        if (exists) suggest(opts.episode.id, line.id, opts.expectedRevision, body,
          `Translation of corrected source: ${line.source}. Region changed during translation.`, "translation");
        throw new AiJobError("Region changed during translation. Your edits were preserved; the translation is available as a suggestion.", 409);
      }
      const saved = toLine(db.select().from(lines).where(eq(lines.id, line.id)).get()!);
      broadcast(opts.episode.id, { type: "line:upsert", line: saved });
      updateJob(jobId, "completed", { ...progress, message: "Corrected source translated · ready for review" });
    } catch (e) {
      updateJob(jobId, abort.signal.aborted ? "cancelled" : "failed", progress,
        e instanceof Error ? e.message : String(e));
    } finally {
      sourceTranslations.delete(jobId);
    }
  })();
  return { jobId };
}

export async function insertSticky(opts: {
  episodeId: string;
  imageId: string;
  box: DetectedBox;
  sortOrder: number;
  invert?: boolean | null;
  /** Fill or refresh source on overlapping regions; leave English empty. */
  fillSource?: boolean;
}): Promise<LineRow> {
  const matches = (await listLines(opts.episodeId)).filter(
    (l) => l.imageId === opts.imageId,
  );
  let same = matches.find((l) => {
    const b = opts.box;
    if (l.sourceState !== "ignored") return sameDetectedTextBox(l, b, l.source, b.source);
    const overlap =
      Math.max(
        0,
        Math.min((l.x ?? 0) + (l.w ?? 0), b.x + b.w) - Math.max(l.x ?? 0, b.x),
      ) *
      Math.max(
        0,
        Math.min((l.y ?? 0) + (l.h ?? 0), b.y + b.h) - Math.max(l.y ?? 0, b.y),
      );
    return (
      overlap /
        Math.max(0.000001, Math.min((l.w ?? 0) * (l.h ?? 0), b.w * b.h)) >
      0.7
    );
  });
  if (same) {
    if (same.sourceState === "ignored") return same;
    const geometry = getDoc<{ polygon?: unknown; layout?: unknown }>(
      `region:${same.id}`,
      {},
    ).data;
    if (
      same.updatedBy === "ai-ocr" &&
      same.status !== "approved" &&
      !geometry.polygon &&
      !geometry.layout &&
      ["x", "y", "w", "h"].some((k) => same![k as "x"] !== opts.box[k as "x"])
    ) {
      await db
        .update(lines)
        .set({
          x: opts.box.x,
          y: opts.box.y,
          w: opts.box.w,
          h: opts.box.h,
          updatedAt: now(),
        })
        .where(
          and(eq(lines.id, same.id), eq(lines.revision, same.revision ?? 0)),
        );
      const current = await db
        .select()
        .from(lines)
        .where(eq(lines.id, same.id))
        .get();
      if (!current)
        throw new AiJobError("Region was deleted during detection", 409);
      same = toLine(current);
      broadcast(opts.episodeId, { type: "line:upsert", line: same });
    }
    if (
      opts.fillSource &&
      opts.box.source &&
      same.status !== "approved" &&
      (same.updatedBy === "ai-ocr" ||
        !(same.source || "").trim() ||
        same.sourceState === "unreadable") &&
      opts.box.source !== same.source
    ) {
      await db
        .update(lines)
        .set({
          source: opts.box.source,
          sourceState: "read",
          ocrConfidence: opts.box.ocrConfidence ?? same.ocrConfidence,
          lineType: opts.box.lineType || same.lineType,
          updatedAt: now(),
        })
        .where(
          and(eq(lines.id, same.id), eq(lines.revision, same.revision ?? 0)),
        );
      const updated = await db
        .select()
        .from(lines)
        .where(eq(lines.id, same.id))
        .get();
      if (updated) {
        const out = toLine(updated);
        broadcast(opts.episodeId, { type: "line:upsert", line: out });
        return out;
      }
    }
    if (opts.fillSource) return same;
    if (
      !same.body.trim() &&
      same.updatedBy === "ai-ocr" &&
      same.status !== "approved" &&
      same.sourceState !== "ignored" &&
      opts.box.translation
    ) {
      await db
        .update(lines)
        .set({ body: opts.box.translation,
          source: opts.box.source || same.source,
          sourceState: opts.box.source ? "read" : same.sourceState,
          ocrConfidence: opts.box.ocrConfidence ?? null,
          status: "needs_work", updatedAt: now() })
        .where(
          and(eq(lines.id, same.id), eq(lines.revision, same.revision ?? 0)),
        );
      const updated = await db
        .select()
        .from(lines)
        .where(eq(lines.id, same.id))
        .get();
      if (updated) {
        const out = toLine(updated);
        broadcast(opts.episodeId, { type: "line:upsert", line: out });
        return out;
      }
    }
    if (opts.box.translation && opts.box.translation !== same.body)
      suggest(
        opts.episodeId,
        same.id,
        same.revision ?? 0,
        opts.box.translation,
        [`Image source: ${opts.box.source}`, opts.box.reasoning].filter(Boolean).join("\n"),
        "translation",
      );
    return same;
  }
  const ai = await ensureAiUser();
  const t = now();
  const row = {
    id: nid(),
    episodeId: opts.episodeId,
    imageId: opts.imageId,
    body: opts.box.translation,
    source: opts.box.source,
    sourceState: opts.box.source ? "read" : "unreadable",
    ocrConfidence: opts.box.ocrConfidence ?? null,
    lineType: opts.box.lineType,
    status: opts.box.source ? "none" : "needs_work",
    placed: true,
    invert: opts.invert ?? null,
    x: opts.box.x,
    y: opts.box.y,
    w: opts.box.w,
    h: opts.box.h,
    sidebarX: null as number | null,
    sidebarY: null as number | null,
    sidebarW: 0.9,
    sidebarH: 0.1,
    sortOrder: opts.sortOrder,
    createdBy: ai.id,
    updatedBy: ai.id,
    updatedAt: t,
  };
  await db.insert(lines).values(row);
  const line = toLine(row);
  broadcast(opts.episodeId, { type: "line:upsert", line });
  const notes: { body: string; at: number }[] = [];
  if (opts.box.source)
    notes.push({ body: `Source: ${opts.box.source}`, at: t });
  if (opts.box.reasoning)
    notes.push({ body: `Note: ${opts.box.reasoning}`, at: t + 1 });
  if (opts.box.literal)
    notes.push({ body: `Literal: ${opts.box.literal}`, at: t + 2 });
  for (const note of notes) {
    const cRow = {
      id: nid(),
      lineId: line.id,
      userId: ai.id,
      body: note.body,
      correction: false,
      createdAt: note.at,
    };
    await db.insert(comments).values(cRow);
    const comment: CommentRow = { ...cRow, username: ai.username };
    broadcast(opts.episodeId, { type: "comment:add", comment });
  }
  return line;
}

/** Attach a chapter translation to the region that was sent, never by box overlap. */
export function applyLineTranslation(opts: {
  episodeId: string;
  lineId: string;
  expectedRevision: number;
  expectedSource: string;
  translation: string;
  reasoning?: string;
  userId?: string;
}): LineRow | undefined {
  const english = normalizeTranslation(opts.translation.trim());
  if (!english) return;
  const row = db.select().from(lines).where(and(eq(lines.id, opts.lineId), eq(lines.episodeId, opts.episodeId))).get();
  if (!row || row.sourceState === "ignored") return;
  const line = toLine(row);
  const reason = [`Translation of: ${opts.expectedSource}`, opts.reasoning].filter(Boolean).join("\n");
  const sameInput =
    (line.revision ?? 0) === opts.expectedRevision && (line.source || "") === opts.expectedSource;
  if (sameInput && !line.body.trim() && line.status !== "approved") {
    const result = db
      .update(lines)
      .set({
        body: english,
        status: "needs_work",
        updatedBy: opts.userId ?? null,
        updatedAt: now(),
      })
      .where(
        and(
          eq(lines.id, opts.lineId),
          eq(lines.episodeId, opts.episodeId),
          eq(lines.revision, opts.expectedRevision),
        ),
      )
      .run();
    if (result.changes) {
      const saved = toLine(db.select().from(lines).where(eq(lines.id, opts.lineId)).get()!);
      broadcast(opts.episodeId, { type: "line:upsert", line: saved });
      return saved;
    }
  }
  if (english !== line.body.trim()) {
    suggest(opts.episodeId, opts.lineId, opts.expectedRevision, english, reason, "translation");
    broadcast(opts.episodeId, { type: "suggestion:changed", lineId: opts.lineId });
  }
  return line;
}

async function markTranslating(job: Job, episode: Episode) {
  if (episode.status !== "raws") return;
  const updatedAt = now();
  await db
    .update(episodes)
    .set({ status: "translating", updatedAt })
    .where(eq(episodes.id, job.episodeId));
  broadcast(job.episodeId, {
    type: "episode:status",
    status: "translating",
    updatedAt,
  });
}

function pageJobError(job: Job, img: { id: string; originalName: string }, i: number, total: number, e: unknown) {
  pageResult(job.id!, img.id, "failed", e instanceof Error ? e.message : String(e));
  const rawMsg = e instanceof Error ? e.message : String(e);
  const message = /ENOENT|no such file/i.test(rawMsg)
    ? "missing image"
    : rawMsg.replace(/\/[^\s:]+/g, "").trim().slice(0, 140);
  console.warn(`[ai-${job.kind}] skip page ${i + 1} (${img.originalName}): ${rawMsg.slice(0, 200)}`);
  job.message = `Page ${i + 1}/${total} · skipped (${message || "error"})`;
  emit(job);
}

function finishAiJob(job: Job, opts: { series: Series; episode: Episode }, ok: string, partial: string, pagesDone: number, total: number) {
  job.running = false;
  job.message = pagesDone === total ? ok : partial;
  if (pagesDone !== total) job.error = "Some pages failed";
  emit(job);
  void logActivity({
    seriesId: opts.series.id,
    episodeId: job.episodeId,
    userId: job.user.id,
    action: `ai_${job.kind}_finished`,
    payload: {
      pages: total,
      engine: job.engine,
      detector: job.detector,
      lang: job.lang,
      ...(job.imageIds?.length ? { imageIds: job.imageIds } : {}),
    },
  }).then((entry) => broadcast(job.episodeId, { type: "activity", entry }));
}

function failAiJob(job: Job, opts: { series: Series; episode: Episode }, e: unknown, fallback: string) {
  job.running = false;
  job.error = e instanceof Error ? e.message : fallback;
  job.message = job.abort.signal.aborted ? "Cancelled" : job.error;
  emit(job);
  if (!job.abort.signal.aborted) {
    void logActivity({
      seriesId: opts.series.id,
      episodeId: job.episodeId,
      userId: job.user.id,
      action: `ai_${job.kind}_failed`,
      payload: { error: job.error },
    }).then((entry) => broadcast(job.episodeId, { type: "activity", entry }));
  }
}

function releaseAiJob(job: Job) {
  setTimeout(() => {
    const cur = jobs.get(job.episodeId);
    if (cur === job && !cur.running) jobs.delete(job.episodeId);
  }, 60_000).unref();
}

async function runTranscribeJob(
  job: Job,
  opts: { series: Series; episode: Episode },
) {
  try {
    job.message = "Preparing pages…";
    emit(job);
    await markTranslating(job, opts.episode);

    const allImgs = await listImages(job.episodeId);
    const imgs = job.imageIds?.length
      ? allImgs.filter((img) => job.imageIds!.includes(img.id))
      : allImgs;
    job.imageCount = imgs.length;
    if (job.imageIds?.length && !imgs.length)
      throw new AiJobError("Page not found", 404);
    if (!imgs.length)
      throw new AiJobError("Upload raws before running transcription");
    if (job.id && job.detection) {
      const label = detectorSetupLabel(job.detection.setup);
      const skipped = job.detection.skipped.length ? ` · skipped: ${job.detection.skipped.join("; ")}` : "";
      appendJobLog(job.id, {
        step: "Text detection setup",
        engine: "detect",
        model: label,
        request: `${label} · confidence ${job.detection.conf} · from ${job.detection.source}${skipped}`,
      });
    }

    const existingLines = await listLines(job.episodeId);
    const occupied = new Set(
      existingLines
        .filter((l) => l.imageId && l.sourceState !== "ignored")
        .map((l) => l.imageId as string),
    );
    const pageScoped = Boolean(job.imageIds?.length);
    let sortOrder = existingLines.reduce((max, line) => Math.max(max, line.sortOrder), -1) + 1;
    let pagesDone = 0;
    let scanned = 0;
    let disagreements = 0;
    const ocrIds = transcriptionIdsFor(opts.series.id, opts.episode.id);
    const ocrNames = ocrIds.map((id) => liveAssistantName(id)).join(" + ") || "transcription";
    const ocr = await bindOcrTranslator(opts.series.id, opts.episode.id, chapterTranslator(opts.series.id, opts.episode.id), job.lang);

    for (let i = 0; i < imgs.length; i++) {
      if (job.abort.signal.aborted) throw new Error("Cancelled");
      const img = imgs[i];
      job.imageIndex = i + 1;
      if (!pageScoped && occupied.has(img.id)) {
        pageResult(job.id!, img.id, "completed");
        pagesDone += 1;
        job.message = `Page ${i + 1}/${imgs.length} · already transcribed`;
        emit(job);
        continue;
      }
      try {
        const path = imagePath(opts.series.slug, opts.episode.slug, img.filename);
        const raw = await readWorkingOrOrig(
          opts.series.slug,
          opts.episode.slug,
          img.filename,
        );
        if (!raw) {
          if (pageScoped) {
            throw new AiJobError(`Missing image file for ${img.originalName}`, 404);
          }
          pageResult(job.id!, img.id, "failed", "Missing image");
          job.message = `Page ${i + 1}/${imgs.length} · skipped (missing image)`;
          emit(job);
          continue;
        }
        const meta = await sharp(raw).metadata();
        const width = meta.width || img.width || 1;
        const height = meta.height || img.height || 1;
        let pageMask: Buffer | undefined;
        let maskModel = maskModelName();
        const regions = orderRegions(
          await detectRegions(
            { path, bytes: raw, width, height },
            {
              geometry: true,
              setup: job.detection?.setup,
              conf: job.detection?.conf,
              lang: job.lang,
              abort: job.abort.signal,
              onStep: (update) => reportStep(job, update),
              onTextMask: (mask, info) => {
                pageMask = mask;
                const name = info.model || maskModelName(info.engine);
                maskModel = info.backend ? `${name} · ${info.backend}` : name;
              },
            },
          ),
          (r) => r.place,
          preferences(job.episodeId, opts.series.id).direction,
        );
        const includeEnglish = preferences(job.episodeId, opts.series.id).transcribeEnglish === true;
        job.message = `Page ${i + 1}/${imgs.length} · Reading ${regions.length} regions`;
        emit(job);
        scanned += 1;
        let mask: Buffer | undefined = pageMask;
        if (regions.length && !mask) {
          reportStep(job, { step: "Masking lettering", model: maskModel, engine: "mask" });
          try {
            mask = await detectLetteringMask(
              raw,
              regions.map((region) => region.polygon ?? regionRectangle(region.ocr)),
              3,
              job.abort.signal,
            );
          } catch (e) {
            if (job.abort.signal.aborted) throw e;
            console.warn(
              `[ai-transcribe] page mask failed on ${img.originalName}: ${e instanceof Error ? e.message : e}`,
            );
          }
        } else if (regions.length && mask) {
          reportStep(job, { step: "Applying text mask", model: maskModel, engine: "koharu" });
        }
        const reads: { region: (typeof regions)[number]; consensus: OcrConsensus }[] = [];
        for (const [k, region] of regions.entries()) {
          job.abort.signal.throwIfAborted();
          reportStep(job, {
            step: `Reading region ${k + 1}/${regions.length}`,
            model: ocrNames,
            engine: ocrIds[0] || "ocr",
          });
          let consensus: OcrConsensus;
          try {
            const jpeg = await transcribeBubbleCrop(raw, region.ocr, job.abort.signal, mask);
            consensus = await readOcrConsensus(
              jpeg,
              job.abort.signal,
              defaultTranscriptionRead,
              ocr.translate,
              job.lang,
              ocrIds,
              { onTranslate: () => reportStep(job, {
                step: "Translating transcription",
                model: ocr.label,
                engine: "translate",
              }) },
            );
          } catch (e) {
            if (job.abort.signal.aborted) throw e;
            const message = e instanceof Error ? e.message : String(e);
            console.warn(`[ai-transcribe] OCR failed on ${img.originalName}: ${message}`);
            consensus = failedOcrConsensus(message, ocrIds);
          }
          reads.push({ region, consensus });
        }
        const sources = reads.map((item) => item.consensus.readings.map((reading) => reading.source));
        const drop = dropRedundantTranscriptions(reads.map((item, index) => ({
          id: String(index),
          x: item.region.place.x,
          y: item.region.place.y,
          w: item.region.place.w,
          h: item.region.place.h,
          source: transcriptionOverlapSource(item.consensus.source, sources[index]),
          english: transcriptionIsEnglish(item.consensus.source, sources[index]),
        })), { includeEnglish });
        const kept = reads.filter((_, index) => !drop.has(String(index)));
        job.message = `Page ${i + 1}/${imgs.length} · Saving ${kept.length} regions`;
        emit(job);
        for (const item of kept) {
          job.abort.signal.throwIfAborted();
          const place = item.region.place;
          let invert: boolean | undefined;
          try {
            invert = await shouldInvertText(raw, place.x, place.y, place.w, place.h);
          } catch {
            invert = undefined;
          }
          const line = await insertSticky({
            episodeId: job.episodeId,
            imageId: img.id,
            sortOrder: sortOrder++,
            fillSource: true,
            invert,
            box: {
              x: place.x,
              y: place.y,
              w: place.w,
              h: place.h,
              lineType: classifyRegionLineType(
                item.region.kind,
                sfxClassificationSource(item.consensus.source, item.consensus.readings),
                { sfxDetector: item.region.provenance?.backend?.startsWith("coo") },
              ),
              source: "",
              literal: "",
              translation: "",
              reasoning: "",
            },
          });
          if (line.sourceState === "ignored") continue;
          if (item.region.polygon) {
            const doc = getDoc(`region:${line.id}`, {});
            putDoc(job.episodeId, doc.id, {
              ...doc.data, polygon: item.region.polygon,
              detectionKind: item.region.kind,
              detectionProvenance: item.region.provenance,
              bubbleBounds: item.region.bubble,
              geometryConfidence: item.region.geometryConfidence, geometryApproved: false,
            }, doc.revision);
          }
          if (!item.consensus.agreed) disagreements += 1;
          saveOcrConsensus(job.episodeId, line, item.consensus, ocr.label);
        }
        pageResult(job.id!, img.id, "completed");
        pagesDone += 1;
        job.message = `Page ${i + 1}/${imgs.length} · transcribed ${kept.length} regions`;
        emit(job);
      } catch (e) {
        if (job.abort.signal.aborted) throw new Error("Cancelled");
        pageJobError(job, img, i, imgs.length, e);
      }
    }

    if (!pagesDone)
      throw new AiJobError("No readable page images on this chapter");

    job.model = ocrNames;
    job.engine = ocrIds[0] || job.engine;
    finishAiJob(
      job,
      opts,
      scanned
        ? `Transcription complete · ${disagreements} regions need a source choice; agreed readings include English`
        : "Transcription complete · pages already have regions",
      `Transcribed ${pagesDone}/${imgs.length} pages; retry failed pages in workflow`,
      pagesDone,
      imgs.length,
    );
  } catch (e) {
    failAiJob(job, opts, e, "AI transcribe failed");
  } finally {
    releaseAiJob(job);
  }
}

async function runTranslateJob(
  job: Job,
  opts: { series: Series; episode: Episode },
) {
  try {
    job.message = "Preparing pages…";
    emit(job);
    await markTranslating(job, opts.episode);

    const allImgs = await listImages(job.episodeId);
    const imgs = job.imageIds?.length
      ? allImgs.filter((img) => job.imageIds!.includes(img.id))
      : allImgs;
    job.imageCount = imgs.length;
    if (job.imageIds?.length && !imgs.length)
      throw new AiJobError("Page not found", 404);
    if (!imgs.length)
      throw new AiJobError("Upload raws before running AI translate");

    const existing = await listLines(job.episodeId);
    const story: { source: string; translation: string }[] = [];
    let pagesDone = 0;
    let translatedAny = false;
    let omitted = 0;

    for (let i = 0; i < imgs.length; i++) {
      if (job.abort.signal.aborted) throw new Error("Cancelled");
      const img = imgs[i];
      job.imageIndex = i + 1;
      try {
        const pageLines = existing.filter(
          (l) =>
            l.imageId === img.id &&
            l.sourceState !== "ignored" &&
            (l.source || "").trim(),
        );
        if (!pageLines.length) {
          pageResult(job.id!, img.id, "completed");
          pagesDone += 1;
          job.message = `Page ${i + 1}/${imgs.length} · no source to translate`;
          emit(job);
          continue;
        }
        const batch = pageLines.map((line) => ({
          lineId: line.id,
          revision: line.revision ?? 0,
          source: line.source || "",
          box: {
            id: line.id,
            x: line.x ?? 0,
            y: line.y ?? 0,
            w: line.w ?? 0.2,
            h: line.h ?? 0.1,
            lineType: line.lineType,
            source: line.source || "",
            ocrConfidence: line.ocrConfidence ?? undefined,
            literal: "",
            translation: "",
            reasoning: "",
          } satisfies DetectedBox,
        }));
        job.message = `Page ${i + 1}/${imgs.length} · ${job.engine} · translating ${batch.length} lines`;
        emit(job);
        const ctx = await loadTranslateContext(
          opts.series.id,
          job.episodeId,
          img.id,
        );
        const translated = await runTranslate(job.engine, batch.map((item) => item.box), {
          ...ctx,
          prior: [ctx.prior, glossaryOf(story)].filter(Boolean).join("\n"),
          abort: job.abort.signal,
          lang: job.lang,
          model: job.model,
        });
        for (let n = 0; n < batch.length; n++) {
          if (job.abort.signal.aborted) throw new Error("Cancelled");
          const result = translated[n];
          const english = result?.translation || "";
          applyLineTranslation({
            episodeId: job.episodeId,
            lineId: batch[n].lineId,
            expectedRevision: batch[n].revision,
            expectedSource: batch[n].source,
            translation: english,
            reasoning: result?.reasoning,
            userId: job.user.id,
          });
          if (english) {
            story.push({ source: batch[n].source, translation: english });
            translatedAny = true;
          } else {
            omitted += 1;
          }
        }
        pageResult(job.id!, img.id, "completed");
        pagesDone += 1;
      } catch (e) {
        if (job.abort.signal.aborted) throw new Error("Cancelled");
        pageJobError(job, img, i, imgs.length, e);
      }
    }
    if (!pagesDone)
      throw new AiJobError("No readable page images on this chapter");
    if (!translatedAny && !existing.some((l) => (l.source || "").trim() && l.sourceState !== "ignored"))
      throw new AiJobError("No source text to translate. Run Transcribe first.");

    finishAiJob(
      job,
      opts,
      omitted
        ? `Translation complete · ${omitted} lines had no English and were left blank`
        : "Translation complete · drafts ready for review",
      `Translated ${pagesDone}/${imgs.length} pages; retry failed pages in workflow`,
      pagesDone,
      imgs.length,
    );
  } catch (e) {
    failAiJob(job, opts, e, "AI translate failed");
  } finally {
    releaseAiJob(job);
  }
}

function beginAiJob(
  opts: {
    series: Series;
    episode: Episode;
    user: PublicUser;
    engine?: TranslateEngine;
    /** Overrides the chapter's setup for this run; normally left unset. */
    detectorSetup?: DetectorSetupConfig;
    detectConf?: number;
    lang?: OcrLang;
    model?: string;
    imageIds?: string[];
  },
  kind: "transcribe" | "translate",
  message: string,
): Job {
  const existing = jobs.get(opts.episode.id);
  if (existing?.running)
    throw new AiJobError("AI is already running on this chapter", 409);
  if (isRegionQueueBusy(opts.episode.id)) {
    throw new AiJobError(
      "Cancel queued selection translates before running full-chapter AI",
      409,
    );
  }
  const selected = resolveTaskModel(
    preferences(opts.episode.id, opts.series.id).regionAi,
    kind === "transcribe" ? "vision" : "translate",
    { engine: opts.engine, model: opts.model },
  );
  const ocrIds = kind === "transcribe" ? transcriptionIdsFor(opts.series.id, opts.episode.id) : [];
  const detection = kind === "transcribe"
    ? resolveDetector(opts.episode.id, { setup: opts.detectorSetup, conf: opts.detectConf })
    : undefined;
  const job: Job = {
    modelSelections: kind === 'transcribe'
      ? [...ocrIds.map(engine => ({ engine, model: '' })), chapterTranslator(opts.series.id, opts.episode.id)]
      : [selected],
    episodeId: opts.episode.id,
    running: true,
    imageIndex: 0,
    imageCount: 0,
    message,
    abort: new AbortController(),
    user: opts.user,
    engine: kind === "transcribe" ? (ocrIds[0] || "hayai-ocr-v2") : selected.engine,
    detection,
    detector: detection && detectorSetupId(detection.setup),
    detectConf: detection?.conf,
    lang: opts.lang || parseOcrLang(undefined),
    kind,
    model: kind === "transcribe"
      ? ocrIds.map((id) => liveAssistantName(id)).join(" + ")
      : selected.model,
    imageIds: opts.imageIds?.length ? [...new Set(opts.imageIds)] : undefined,
  };
  jobs.set(opts.episode.id, job);
  emit(job);
  void logActivity({
    seriesId: opts.series.id,
    episodeId: opts.episode.id,
    userId: opts.user.id,
    action: `ai_${kind}_started`,
    payload: {
      engine: job.engine,
      detector: job.detector,
      detectConf: job.detectConf,
      lang: job.lang,
    },
  }).then((entry) => broadcast(opts.episode.id, { type: "activity", entry }));
  return job;
}

export function startAiTranscribe(opts: {
  series: Series;
  episode: Episode;
  user: PublicUser;
  engine?: TranslateEngine;
  detectorSetup?: DetectorSetupConfig;
  detectConf?: number;
  lang?: OcrLang;
  model?: string;
  imageIds?: string[];
}): AiJobSnapshot {
  const ocrIds = transcriptionIdsFor(opts.series.id, opts.episode.id);
  assertOcrConsensusInstalled(ocrIds);
  const lang = opts.lang || parseOcrLang(preferences(opts.episode.id, opts.series.id).lang);
  assertTranslatorTask(
    chapterTranslator(opts.series.id, opts.episode.id, { engine: opts.engine, model: opts.model }),
    lang,
  );
  const ocrNames = ocrIds.map((id) => liveAssistantName(id)).join(" + ");
  const job = beginAiJob(opts, "transcribe", `Starting transcription · ${ocrNames || "transcription models"}`);
  void runWithJob(
    { jobId: job.id!, step: "transcribe", engine: job.engine, model: job.model },
    () => runTranscribeJob(job, opts),
  );
  return jobSnapshot(opts.episode.id)!;
}

export function startAiTranslate(opts: {
  series: Series;
  episode: Episode;
  user: PublicUser;
  replace: boolean;
  engine?: TranslateEngine;
  lang?: OcrLang;
  model?: string;
  imageIds?: string[];
}): AiJobSnapshot {
  const job = beginAiJob(opts, "translate", "Starting translation…");
  void runWithJob(
    { jobId: job.id!, step: "translate", engine: job.engine, model: job.model },
    () => runTranslateJob(job, opts),
  );
  return jobSnapshot(opts.episode.id)!;
}

export function startAiProofread(opts: {
  series: Series;
  episode: Episode;
  user: PublicUser;
  engine?: TranslateEngine;
  lang?: OcrLang;
  model?: string;
  imageIds?: string[];
}): AiJobSnapshot {
  const existing = jobs.get(opts.episode.id);
  if (existing?.running)
    throw new AiJobError("AI is already running on this chapter", 409);
  if (isRegionQueueBusy(opts.episode.id)) {
    throw new AiJobError(
      "Cancel queued selection translates before running AI proofread",
      409,
    );
  }
  const job: Job = {
    episodeId: opts.episode.id,
    running: true,
    imageIndex: 0,
    imageCount: 0,
    message: "Starting proofread…",
    abort: new AbortController(),
    user: opts.user,
    engine: opts.engine || effectiveDefault('proofreadEnglish', DEFAULT_CHAT_MODEL_ID),
    lang: opts.lang || parseOcrLang(undefined),
    kind: "proofread",
    imageIds: opts.imageIds,
    model: opts.model,
  };
  jobs.set(opts.episode.id, job);
  emit(job);
  void logActivity({
    seriesId: opts.series.id,
    episodeId: opts.episode.id,
    userId: opts.user.id,
    action: "ai_proofread_started",
    payload: { engine: job.engine, lang: job.lang },
  }).then((entry) => broadcast(opts.episode.id, { type: "activity", entry }));
  void runWithJob(
    { jobId: job.id!, step: "proofread", engine: job.engine, model: job.model },
    () => runProofreadJob(job, opts),
  );
  return jobSnapshot(opts.episode.id)!;
}

async function runProofreadJob(
  job: Job,
  opts: { series: Series; episode: Episode },
) {
  try {
    const result = await proofreadChapter({
      seriesId: opts.series.id,
      episodeId: job.episodeId,
      engine: job.engine,
      model: job.model,
      lang: job.lang,
      abort: job.abort.signal,
      imageIds: job.imageIds,
      onPage: (id, state, error) => pageResult(job.id!, id, state, error),
      onProgress: (p) => {
        job.message = p.message;
        job.imageIndex = p.imageIndex;
        job.imageCount = p.imageCount;
        emit(job);
      },
    });
    job.running = false;
    job.message = result.changed
      ? `Proofread ${result.changed} of ${result.total} lines`
      : `Proofread checked ${result.total} lines · no changes`;
    emit(job);
    const entry = await logActivity({
      seriesId: opts.series.id,
      episodeId: job.episodeId,
      userId: job.user.id,
      action: "ai_proofread_finished",
      payload: { ...result, engine: job.engine, lang: job.lang },
    });
    broadcast(job.episodeId, { type: "activity", entry });
  } catch (e) {
    job.running = false;
    job.error = e instanceof Error ? e.message : "AI proofread failed";
    job.message = job.abort.signal.aborted ? "Cancelled" : job.error;
    emit(job);
    if (!job.abort.signal.aborted) {
      const entry = await logActivity({
        seriesId: opts.series.id,
        episodeId: job.episodeId,
        userId: job.user.id,
        action: "ai_proofread_failed",
        payload: { error: job.error },
      });
      broadcast(job.episodeId, { type: "activity", entry });
    }
  } finally {
    setTimeout(() => {
      const cur = jobs.get(job.episodeId);
      if (cur === job && !cur.running) jobs.delete(job.episodeId);
    }, 60_000);
  }
}

/**
 * The chapter review fallback: with exactly one review-capable model available,
 * it is the default review model — matching the setup report — otherwise the
 * shipped chat-model default stands.
 */
async function defaultReviewEngine(): Promise<string> {
  const fallback = effectiveDefault('chapterReview', DEFAULT_CHAT_MODEL_ID);
  try {
    const rows = await registryPickerRows(undefined, 'chapterReview');
    return singleAvailableEngineFor(rows, 'chapterReview') || fallback;
  } catch {
    return fallback;
  }
}

export async function startAiReview(opts: {
  series: Series;
  episode: Episode;
  user: PublicUser;
  engine?: TranslateEngine;
  lang?: OcrLang;
  model?: string;
}): Promise<AiJobSnapshot> {
  const existing = jobs.get(opts.episode.id);
  if (existing?.running)
    throw new AiJobError("AI is already running on this chapter", 409);
  if (isRegionQueueBusy(opts.episode.id)) {
    throw new AiJobError(
      "Cancel queued selection translates before running AI review",
      409,
    );
  }
  const job: Job = {
    episodeId: opts.episode.id,
    running: true,
    imageIndex: 0,
    imageCount: 1,
    message: "Starting review…",
    abort: new AbortController(),
    user: opts.user,
    engine: opts.engine || await defaultReviewEngine(),
    lang: opts.lang || parseOcrLang(undefined),
    kind: "review",
    model: opts.model,
  };
  jobs.set(opts.episode.id, job);
  emit(job);
  void logActivity({
    seriesId: opts.series.id,
    episodeId: opts.episode.id,
    userId: opts.user.id,
    action: "ai_review_started",
    payload: { engine: job.engine, model: job.model, lang: job.lang },
  }).then((entry) => broadcast(opts.episode.id, { type: "activity", entry }));
  void runWithJob(
    { jobId: job.id!, step: "review", engine: job.engine, model: job.model },
    () => runReviewJob(job, opts),
  );
  return jobSnapshot(opts.episode.id)!;
}

async function runReviewJob(
  job: Job,
  opts: { series: Series; episode: Episode },
) {
  try {
    const report = await reviewChapter({
      seriesId: opts.series.id,
      episodeId: job.episodeId,
      engine: job.engine,
      model: job.model,
      lang: job.lang,
      abort: job.abort.signal,
      onProgress: (message) => {
        job.message = message;
        emit(job);
      },
    });
    job.running = false;
    job.report = report;
    job.message = report.issues.length
      ? `Review found ${report.issues.length} issue${report.issues.length === 1 ? "" : "s"}`
      : "Review finished · no issues";
    emit(job);
    broadcast(job.episodeId, { type: "review:ready", report });
    const entry = await logActivity({
      seriesId: opts.series.id,
      episodeId: job.episodeId,
      userId: job.user.id,
      action: "ai_review_finished",
      payload: {
        issues: report.issues.length,
        questions: report.questions.length,
        engine: job.engine,
      },
    });
    broadcast(job.episodeId, { type: "activity", entry });
  } catch (e) {
    job.running = false;
    job.error = e instanceof Error ? e.message : "AI review failed";
    job.message = job.abort.signal.aborted ? "Cancelled" : job.error;
    if (!job.abort.signal.aborted) {
      job.report = {
        summary: job.error,
        issues: [],
        questions: [],
        notes: "",
        engine: job.engine,
        model: job.model || "",
        createdAt: Date.now(),
      };
    }
    emit(job);
    if (job.report)
      broadcast(job.episodeId, { type: "review:ready", report: job.report });
    if (!job.abort.signal.aborted) {
      const entry = await logActivity({
        seriesId: opts.series.id,
        episodeId: job.episodeId,
        userId: job.user.id,
        action: "ai_review_failed",
        payload: { error: job.error },
      });
      broadcast(job.episodeId, { type: "activity", entry });
    }
  } finally {
    setTimeout(() => {
      const cur = jobs.get(job.episodeId);
      if (cur === job && !cur.running) jobs.delete(job.episodeId);
    }, 60_000);
  }
}

export function cancelAiTranslate(episodeId: string): AiJobSnapshot | null {
  const job = jobs.get(episodeId);
  if (!job?.running) return jobSnapshot(episodeId);
  job.abort.abort();
  job.message = "Cancelling…";
  emit(job);
  return jobSnapshot(episodeId);
}

export async function translateRegion(opts: {
  series: Series;
  episode: Episode;
  user: PublicUser;
  imageId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  engine?: TranslateEngine;
  lang?: OcrLang;
  model?: string;
  abort?: AbortSignal;
  forceVision?: boolean;
  lineId?: string;
  expectedRevision?: number;
}): Promise<LineRow> {
  if (jobs.get(opts.episode.id)?.running) {
    throw new AiJobError(
      "AI translate is already running on this chapter",
      409,
    );
  }
  if (![opts.x, opts.y, opts.w, opts.h].every(Number.isFinite)) {
    throw new AiJobError("Invalid selection");
  }
  const imgs = await listImages(opts.episode.id);
  const img = imgs.find((i) => i.id === opts.imageId);
  if (!img) throw new AiJobError("Image not found", 404);

  const raw = await readFile(
    imagePath(opts.series.slug, opts.episode.slug, img.filename),
  );
  const meta = await sharp(raw).metadata();
  const width = meta.width || img.width || 1;
  const height = meta.height || img.height || 1;
  const bubble = bubbleFromNorm(width, height, opts.x, opts.y, opts.w, opts.h);
  if (bubble.width < 12 || bubble.height < 12)
    throw new AiJobError("Selection is too small");

  const lang = opts.lang || parseOcrLang(undefined);
  const engine = opts.engine || effectiveDefault('vision', DEFAULT_CHAT_MODEL_ID);
  const models = regionAiSettings(preferences(opts.episode.id, opts.series.id).regionAi, { engine, model: opts.model || "" });
  const target = opts.lineId
    ? (await listLines(opts.episode.id)).find(
        (l) => l.id === opts.lineId && l.imageId === img.id,
      )
    : undefined;
  if (opts.lineId && (!target || target.revision !== opts.expectedRevision))
    throw new AiJobError("Region changed. Reload it before rereading.", 409);
  if (!img.caption.trim())
    await describePages(
      { series: opts.series, episode: opts.episode, user: opts.user },
      [img.id],
      false,
      models.describe.engine,
      models.describe.model,
      opts.abort,
    );
  // A drawn region or text category is not evidence of bubble containment.
  // Manual selections always use vision; only detector-classified bubbles use OCR.
  const jpeg = await maskedBubbleCrop(raw, bubble, opts.abort);
  const read = await runVisionRead(engine, {
    jpeg, lang, model: opts.model, abort: opts.abort,
  }, visionReadHandlers);


  const readType = read.lineType === '::' || read.lineType === '""' || read.lineType === 'plain'
    ? classifyRegionLineType(read.lineType === '::' ? 'free' : 'bubble', read.source)
    : read.lineType;
  const located: DetectedBox[] = [
    {
      x: bubble.x,
      y: bubble.y,
      w: bubble.w,
      h: bubble.h,
      lineType: readType,
      source: read.source,
      ocrConfidence:
        "ocrConfidence" in read ? (read.ocrConfidence as number) : undefined,
      literal: "",
      translation: "",
      reasoning: "",
    },
  ];
  const existing = await listLines(opts.episode.id);
  const draft =
    target ??
    (await insertSticky({
      episodeId: opts.episode.id,
      imageId: img.id,
      box: located[0],
      sortOrder: existing.length,
    }));
  if (!read.source) {
    if (target)
      throw new AiJobError(
        "Image model could not read this region. Existing text was preserved.",
      );
    return draft;
  }
  const ctx = await loadTranslateContext(
    opts.series.id,
    opts.episode.id,
    img.id,
  );
  const translated = await runTranslate(models.translate.engine, located, {
    ...ctx,
    abort: opts.abort,
    pageLabel: `${opts.episode.title} · selection`,
    lang,
    model: models.translate.model,
  });
  const box = translated[0];
  if (opts.abort?.aborted) throw new Error("Cancelled");
  if (target) {
    if (!box.translation?.trim())
      throw new AiJobError(
        "Translation was empty. Existing text was preserved.",
      );
    const result = await db
      .update(lines)
      .set({
        source: read.source,
        sourceState: "read",
        ocrConfidence: null,
        body: box.translation,
        status: "needs_work",
        updatedBy: opts.user.id,
        updatedAt: now(),
      })
      .where(
        and(
          eq(lines.id, target.id),
          eq(lines.revision, opts.expectedRevision!),
        ),
      );
    if (!result.changes) {
      suggest(
        opts.episode.id,
        target.id,
        target.revision ?? 0,
        box.translation,
        `Image-model source: ${read.source}`,
        "translation",
      );
      throw new AiJobError(
        "Region changed during rereading. Result retained as a suggestion.",
        409,
      );
    }
    const saved = toLine(
      (await db.select().from(lines).where(eq(lines.id, target.id)).get())!,
    );
    broadcast(opts.episode.id, { type: "line:upsert", line: saved });
    return saved;
  }
  return insertSticky({
    episodeId: opts.episode.id,
    imageId: img.id,
    box,
    sortOrder: existing.length,
    invert: await shouldInvertText(raw, box.x, box.y, box.w, box.h),
  });
}

export function enqueueRegionTranslate(opts: {
  series: Series;
  episode: Episode;
  user: PublicUser;
  imageId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  engine?: TranslateEngine;
  lang?: OcrLang;
  model?: string;
  forceVision?: boolean;
  lineId?: string;
  expectedRevision?: number;
}): { queued: true; id: string; pending: number } {
  const selections = regionAiSettings(preferences(opts.episode.id, opts.series.id).regionAi);
  opts = { ...opts, ...resolveTaskModel(selections, 'translate', { engine: opts.engine, model: opts.model }) };
  assertEpisodeIdle(opts.episode.id);
  if (![opts.x, opts.y, opts.w, opts.h].every(Number.isFinite)) {
    throw new AiJobError("Invalid selection");
  }
  let q = regionQueues.get(opts.episode.id);
  if (!q) {
    q = {
      episodeId: opts.episode.id,
      series: opts.series,
      episode: opts.episode,
      items: [],
      running: false,
      message: "",
      total: 0,
      completed: 0,
    };
    regionQueues.set(opts.episode.id, q);
  }
  if (q.items.length + (q.running ? 1 : 0) >= 20)
    throw new AiJobError("Translate queue is full", 429);
  if (!q.running && !q.items.length) {
    q.total = 0;
    q.completed = 0;
  }
  q.total += 1;
  if (q.running) q.message = `Translating ${q.completed + 1} of ${q.total}`;
  const id = nid();
  const jobId = createJob(opts.episode.id, "selection", {
    modelSelections: [selections.vision, selections.describe, selections.proofread],
    imageId: opts.imageId,
    x: opts.x,
    y: opts.y,
    w: opts.w,
    h: opts.h,
    engine: opts.engine,
    lang: opts.lang,
    model: opts.model,
    forceVision: opts.forceVision,
    lineId: opts.lineId,
    expectedRevision: opts.expectedRevision,
  });
  updateJob(jobId, "queued", {});
  q.items.push({
    id,
    jobId,
    imageId: opts.imageId,
    x: opts.x,
    y: opts.y,
    w: opts.w,
    h: opts.h,
    engine: opts.engine,
    lang: opts.lang,
    model: opts.model,
    forceVision: opts.forceVision,
    lineId: opts.lineId,
    expectedRevision: opts.expectedRevision,
    user: opts.user,
  });
  emitRegion(opts.episode.id);
  void drainRegionQueue(q);
  return {
    queued: true,
    id,
    pending: regionQueueSnapshot(opts.episode.id).pending,
  };
}

export function cancelRegionQueue(episodeId: string) {
  const q = regionQueues.get(episodeId);
  if (!q) return regionQueueSnapshot(episodeId);
  for (const item of q.items) updateJob(item.jobId, "cancelled", {
    message: q.total ? `Cancelled · ${q.completed}/${q.total}` : "Cancelled",
  });
  q.abort?.abort();
  q.items = [];
  q.total = q.running ? q.completed + 1 : 0;
  q.message = q.running ? "Finishing current box…" : "";
  emitRegion(episodeId);
  return regionQueueSnapshot(episodeId);
}

async function drainRegionQueue(q: RegionQueue) {
  if (q.running) return;
  q.running = true;
  while (q.items.length) {
    const item = q.items.shift()!;
    q.abort = new AbortController();
    updateJob(item.jobId, "running", {});
    q.message = `Translating ${q.completed + 1} of ${q.total}`;
    emitRegion(q.episodeId);
    try {
      await translateRegion({
        series: q.series,
        episode: q.episode,
        user: item.user,
        imageId: item.imageId,
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
        engine: item.engine,
        lang: item.lang,
        model: item.model,
        forceVision: item.forceVision,
        lineId: item.lineId,
        expectedRevision: item.expectedRevision,
        abort: q.abort.signal,
      });
      updateJob(item.jobId, "completed", {});
      q.completed += 1;
    } catch (e) {
      q.completed += 1;
      q.message = e instanceof Error ? e.message : "Selection translate failed";
      updateJob(
        item.jobId,
        q.abort?.signal.aborted ? "cancelled" : "failed",
        {},
        q.message,
      );
      emitRegion(q.episodeId);
    }
  }
  q.running = false;
  q.message = "";
  emitRegion(q.episodeId);
  if (!q.items.length && !q.running) regionQueues.delete(q.episodeId);
}

const rereadBatches = new Map<string, AbortController>();
const fillMissingBatches = new Map<string, AbortController>();
const suggestBatches = new Map<string, AbortController>();

export function cancelRereadBatch(episodeId: string) {
  rereadBatches.get(episodeId)?.abort();
}

export function cancelFillMissing(episodeId: string) {
  fillMissingBatches.get(episodeId)?.abort();
}

export function cancelSuggestAlternatives(episodeId: string) {
  suggestBatches.get(episodeId)?.abort();
}

export async function startSuggestAlternatives(opts: {
  series: Series;
  episode: Episode;
  user: PublicUser;
  lineId: string;
  expectedRevision?: number;
  engine?: TranslateEngine;
  lang?: OcrLang;
  model?: string;
}) {
  const line = (await listLines(opts.episode.id)).find((l) => l.id === opts.lineId);
  if (!line) throw new AiJobError("Region not found", 404);
  if (line.sourceState === "ignored")
    throw new AiJobError("This region is ignored");
  if (
    opts.expectedRevision != null &&
    line.revision !== opts.expectedRevision
  )
    throw new AiJobError(
      "Region changed. Reload it before requesting alternatives.",
      409,
    );
  const placed =
    line.placed &&
    line.imageId &&
    [line.x, line.y, line.w, line.h].every(
      (v) => typeof v === "number" && Number.isFinite(v),
    );
  if (!line.source?.trim() && !placed)
    throw new AiJobError("Need source text or a placed region");
  assertEpisodeIdle(opts.episode.id);
  if (isRegionQueueBusy(opts.episode.id) && !suggestBatches.has(opts.episode.id))
    throw new AiJobError("Wait for or cancel queued work first", 409);
  const abort = new AbortController();
  suggestBatches.set(opts.episode.id, abort);
  const engine = opts.engine || effectiveDefault('alternatives', DEFAULT_CHAT_MODEL_ID);
  const lang = opts.lang || parseOcrLang(undefined);
  const jobId = createJob(opts.episode.id, "suggest", {
    action: "suggest-alternatives",
    lineId: line.id,
    expectedRevision: line.revision,
    imageId: line.imageId,
    engine,
    lang,
    model: opts.model,
  });
  const progress = { message: "Re-translating this region…", lineId: line.id };
  updateJob(jobId, "running", progress);
  void runWithJob({ jobId, step: "suggest", engine, model: opts.model }, async () => {
    try {
      await suggestLineAlternatives({
        ...opts,
        line,
        engine,
        lang,
        abort: abort.signal,
        onProgress: (message) => {
          progress.message = message;
          updateJob(jobId, "running", progress);
        },
      });
      updateJob(
        jobId,
        abort.signal.aborted ? "cancelled" : "completed",
        { ...progress, message: abort.signal.aborted ? "Cancelled" : "Alternatives ready for review" },
      );
    } catch (e) {
      updateJob(
        jobId,
        abort.signal.aborted ? "cancelled" : "failed",
        progress,
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      suggestBatches.delete(opts.episode.id);
    }
  });
  return { jobId };
}

async function suggestLineAlternatives(opts: {
  series: Series;
  episode: Episode;
  user: PublicUser;
  line: LineRow;
  engine: TranslateEngine;
  lang: OcrLang;
  model?: string;
  abort: AbortSignal;
  onProgress: (message: string) => void;
}) {
  const models = regionAiSettings(preferences(opts.episode.id, opts.series.id).regionAi, { engine: opts.engine, model: opts.model || "" });
  let source = opts.line.source?.trim() || "";
  if (!source) {
    opts.onProgress("Reading this region with the image model…");
    const imgs = await listImages(opts.episode.id);
    const img = imgs.find((i) => i.id === opts.line.imageId);
    if (!img) throw new AiJobError("Page not found", 404);
    if (!img.caption.trim())
      await describePages(
        { series: opts.series, episode: opts.episode, user: opts.user },
        [img.id],
        false,
        models.describe.engine,
        models.describe.model,
        opts.abort,
      );
    const raw = await readFile(
      imagePath(opts.series.slug, opts.episode.slug, img.filename),
    );
    const meta = await sharp(raw).metadata();
    const width = meta.width || img.width || 1;
    const height = meta.height || img.height || 1;
    const bubble = bubbleFromNorm(width, height, opts.line.x!, opts.line.y!, opts.line.w!, opts.line.h!);
    if (bubble.width < 12 || bubble.height < 12)
      throw new AiJobError("Selection is too small");
    const jpeg = await maskedBubbleCrop(raw, bubble, opts.abort);
    const read = await runVisionRead(models.vision.engine, {
      jpeg, lang: opts.lang, model: models.vision.model, abort: opts.abort,
    }, visionReadHandlers);
    source = read.source.trim();
    if (!source)
      throw new AiJobError(
        "Image model could not read this region. Existing text was preserved.",
      );
  }
  opts.abort.throwIfAborted();
  opts.onProgress("Re-translating with chapter context…");
  const pack = await loadChapterPack({
    seriesId: opts.series.id,
    episodeId: opts.episode.id,
    lang: opts.lang,
  });
  const ctx = await loadTranslateContext(
    opts.series.id,
    opts.episode.id,
    opts.line.imageId ?? undefined,
  );
  const index = pack.targets.findIndex((l) => l.id === opts.line.id);
  const nearby = pack.items
    .filter((_, i) => index < 0 || (i !== index && Math.abs(i - index) <= 8))
    .map((l) => `${l.page} (${l.lineType}) ${l.source} → ${l.current}`)
    .join("\n");
  const boxes: DetectedBox[] = [
    {
      x: opts.line.x ?? 0,
      y: opts.line.y ?? 0,
      w: opts.line.w ?? 0.2,
      h: opts.line.h ?? 0.1,
      lineType: opts.line.lineType,
      source,
      literal: "",
      translation: "",
      reasoning: "",
    },
  ];
  const translated = await runTranslate(opts.engine, boxes, {
    ...ctx,
    pageCaption: [ctx.pageCaption, nearby && `Nearby lines:\n${nearby}`]
      .filter(Boolean)
      .join("\n\n"),
    abort: opts.abort,
    lang: opts.lang,
    model: opts.model,
  });
  const fresh = translated[0]?.translation.trim() || "";
  if (!fresh) throw new AiJobError("Translation was empty. Existing text was preserved.");
  const current = opts.line.body.trim();
  let latest = (await listLines(opts.episode.id)).find((l) => l.id === opts.line.id);
  if (!latest) throw new AiJobError("Region not found", 404);
  let revision = latest.revision ?? 0;
  if (!current) {
    const result = await db
      .update(lines)
      .set({
        source,
        sourceState: "read",
        body: fresh,
        status: "needs_work",
        updatedBy: opts.user.id,
        updatedAt: now(),
      })
      .where(and(eq(lines.id, latest.id), eq(lines.revision, latest.revision ?? 0)));
    if (result.changes) {
      const saved = toLine(
        (await db.select().from(lines).where(eq(lines.id, latest.id)).get())!,
      );
      broadcast(opts.episode.id, { type: "line:upsert", line: saved });
      latest = saved;
      revision = saved.revision ?? revision;
    } else {
      suggest(opts.episode.id, latest.id, revision, fresh, "Fresh translation", "translation");
    }
  } else {
    if (source && source !== (latest.source?.trim() || "")) {
      const result = await db
        .update(lines)
        .set({
          source,
          sourceState: "read",
          updatedBy: opts.user.id,
          updatedAt: now(),
        })
        .where(and(eq(lines.id, latest.id), eq(lines.revision, latest.revision ?? 0)));
      if (result.changes) {
        const saved = toLine(
          (await db.select().from(lines).where(eq(lines.id, latest.id)).get())!,
        );
        broadcast(opts.episode.id, { type: "line:upsert", line: saved });
        latest = saved;
        revision = saved.revision ?? revision;
      }
    }
    if (fresh !== current) {
      suggest(
        opts.episode.id,
        latest.id,
        revision,
        fresh,
        translated[0]?.reasoning || "Fresh translation with chapter context",
        "translation",
      );
    }
  }
  opts.abort.throwIfAborted();
  const sfx = lookupStandaloneSfx(source);
  if (sfx) {
    const seen = new Set([current, fresh].map((t) => t.toLowerCase()).filter(Boolean));
    const latestAfter = (await listLines(opts.episode.id)).find((l) => l.id === opts.line.id);
    const altRevision = latestAfter?.revision ?? revision;
    for (const meaning of sfx.meanings) {
      const body = meaning.trim();
      if (!body || seen.has(body.toLowerCase())) continue;
      seen.add(body.toLowerCase());
      suggest(
        opts.episode.id,
        opts.line.id,
        altRevision,
        body,
        `SFX dictionary: ${sfx.source}`,
        "alternative",
      );
    }
    return;
  }
  // An optional second task requires its own current evidence. One-line translators
  // cannot do it: alternatives go to the Enquire model, which can think and return structured options.
  const savedEnquire = preferences(opts.episode.id, opts.series.id).regionAi?.enquire;
  const enquire = savedEnquire?.engine
    ? { engine: savedEnquire.engine, model: savedEnquire.model || "" }
    : { engine: opts.engine, model: opts.model || "" };
  let enquireRow;
  try {
    enquireRow = resolveLiveAssistant(String(enquire.engine), enquire.model).row;
  } catch (error) {
    throw new AiJobError(error instanceof Error ? error.message : String(error));
  }
  if (!rowHasOperation(enquireRow, 'alternatives') && isTranslationSpecialist(enquireRow))
    throw new AiJobError(`${enquireRow.name} only returns one line. Set Enquire to a chat model — that is what suggests alternatives.`);
  opts.onProgress("Suggesting localized English alternatives…");
  const item = index >= 0 ? pack.items[index] : undefined;
  const scriptItems = pack.items.map((entry, i) =>
    pack.targets[i]?.id === opts.line.id
      ? { ...entry, source, current: current || fresh }
      : entry,
  );
  const altOpts = {
    seriesNotes: pack.seriesNotes,
    seriesGlossary: pack.seriesGlossary,
    prior: pack.prior,
    pages: ctx.pageCaption || pack.pages,
    script: formatChapterScript(scriptItems, 4000),
    source,
    current: current || fresh,
    fresh,
    lineType: opts.line.lineType,
    page: item?.page || ctx.pageLabel,
    abort: opts.abort,
    lang: opts.lang,
    model: opts.model,
  };
  const alternatives = await runAlternatives(String(enquire.engine), { ...altOpts, model: enquire.model || undefined });
  const seen = new Set(
    [current, fresh].map((t) => t.toLowerCase()).filter(Boolean),
  );
  const latestAfter = (await listLines(opts.episode.id)).find((l) => l.id === opts.line.id);
  const altRevision = latestAfter?.revision ?? revision;
  for (const alt of alternatives) {
    const body = alt.translation.trim();
    if (!body || seen.has(body.toLowerCase())) continue;
    seen.add(body.toLowerCase());
    suggest(
      opts.episode.id,
      opts.line.id,
      altRevision,
      body,
      alt.reasoning || "Alternative English phrasing",
      "alternative",
    );
  }
}

export function needsReread(line: LineRow) {
  return line.sourceState !== "ignored" &&
    (!line.source?.trim() || !line.body.trim() ||
      (line.ocrConfidence != null && line.ocrConfidence < 0.95));
}

export async function startRereadBatch(opts: {
  series: Series; episode: Episode; user: PublicUser;
  engine?: TranslateEngine; lang?: OcrLang; model?: string; imageId?: string;
}) {
  const all = (await listLines(opts.episode.id)).filter(l =>
    (opts.imageId === undefined || l.imageId === opts.imageId) && needsReread(l));
  const imageIds = new Set((await listImages(opts.episode.id)).map(p => p.id));
  if (opts.imageId !== undefined && !imageIds.has(opts.imageId))
    throw new AiJobError("Page not found", 404);
  const targets = all.filter(l => l.placed && imageIds.has(l.imageId!) &&
    [l.x, l.y, l.w, l.h].every(v => typeof v === "number" && Number.isFinite(v)) &&
    l.w! > 0 && l.h! > 0);
  assertEpisodeIdle(opts.episode.id);
  if (isRegionQueueBusy(opts.episode.id))
    throw new AiJobError("Wait for or cancel queued rereads first", 409);
  if (!targets.length) throw new AiJobError("No eligible segments with image bounds need rereading");
  const abort = new AbortController();
  rereadBatches.set(opts.episode.id, abort);
  const jobId = createJob(opts.episode.id, "reread", { engine: opts.engine, imageId: opts.imageId });
  const progress = { completed: 0, failed: 0, skipped: all.length - targets.length,
    total: targets.length, message: "", errors: [] as string[] };
  const report = () => {
    progress.message = `${progress.completed} of ${progress.total} segments processed · ${progress.failed} failed · ${progress.skipped} unplaced skipped`;
    updateJob(jobId, "running", progress);
  };
  report();
  void runWithJob({ jobId, step: "reread", engine: opts.engine, model: opts.model }, async () => {
    try {
      for (const line of targets) {
        if (abort.signal.aborted) break;
        try {
          await translateRegion({ ...opts, imageId: line.imageId!, lineId: line.id,
            expectedRevision: line.revision, x: line.x!, y: line.y!, w: line.w!, h: line.h!,
            forceVision: true, abort: abort.signal });
        } catch (e) {
          if (abort.signal.aborted) break;
          progress.failed++;
          progress.errors.push(`${line.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
        progress.completed++;
        if (!abort.signal.aborted) report();
      }
      updateJob(jobId, abort.signal.aborted ? "cancelled" : progress.failed ? "failed" : "completed",
        progress, progress.errors.join("\n") || undefined);
    } finally {
      rereadBatches.delete(opts.episode.id);
    }
  });
  return { jobId, total: targets.length, skipped: progress.skipped };
}

export type FillMissingHooks = {
  ocrLine?: (line: LineRow, abort: AbortSignal) => Promise<OcrConsensus>;
  translateLines?: (
    pageLines: LineRow[],
    imageId: string | null,
    abort: AbortSignal,
  ) => Promise<Map<string, string>>;
  translateSuggestion?: (source: string, abort: AbortSignal) => Promise<string>;
};

/** Transcribe empty sources and fill empty English on regions and suggestions. Never overwrites existing text. */
export async function startFillMissing(opts: {
  series: Series;
  episode: Episode;
  user: PublicUser;
  engine?: TranslateEngine;
  lang?: OcrLang;
  model?: string;
  imageId?: string;
} & FillMissingHooks) {
  const imageIds = new Set((await listImages(opts.episode.id)).map((p) => p.id));
  if (opts.imageId !== undefined && !imageIds.has(opts.imageId))
    throw new AiJobError("Page not found", 404);
  const work = collectFillMissingWork(opts.episode.id, opts.imageId);
  if (!work.sourceLines.length && !work.englishLines.length && !work.suggestions.length)
    throw new AiJobError("Nothing to fill. Every sourced region and pending source suggestion already has English, and every placed region already has source.");
  const testing = Boolean(opts.ocrLine || opts.translateLines || opts.translateSuggestion);
  if (work.sourceLines.length && !testing) assertOcrConsensusInstalled(transcriptionIdsFor(opts.series.id, opts.episode.id));
  const selected = resolveTaskModel(
    preferences(opts.episode.id, opts.series.id).regionAi,
    "translate",
    { engine: opts.engine, model: opts.model },
  );
  if (!testing) await assertEngineReady(selected.engine, selected.model);
  const ocr = await bindOcrTranslator(opts.series.id, opts.episode.id, selected, opts.lang);
  assertEpisodeIdle(opts.episode.id);
  if (isRegionQueueBusy(opts.episode.id))
    throw new AiJobError("Wait for or cancel queued work first", 409);
  const abort = new AbortController();
  fillMissingBatches.set(opts.episode.id, abort);
  const jobId = createJob(opts.episode.id, "fill-missing", {
    engine: selected.engine, model: selected.model, lang: opts.lang, imageId: opts.imageId,
  });
  const progress = {
    completed: 0, failed: 0, total: 0, message: "", errors: [] as string[],
    sourceFilled: 0, englishFilled: 0, suggestionsFilled: 0,
  };
  const tick = (message: string) => {
    progress.message = message;
    updateJob(jobId, "running", progress);
  };
  const failItem = (id: string, e: unknown) => {
    progress.failed++;
    progress.errors.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
  };
  const ocrLine = opts.ocrLine ?? (async (line, signal) => {
    const imgs = await listImages(opts.episode.id);
    const img = imgs.find((item) => item.id === line.imageId);
    if (!img) throw new AiJobError("Page not found", 404);
    const raw = await readWorkingOrOrig(opts.series.slug, opts.episode.slug, img.filename);
    if (!raw) throw new AiJobError(`Missing image file for ${img.originalName}`, 404);
    const meta = await sharp(raw).metadata();
    const width = meta.width || img.width || 1;
    const height = meta.height || img.height || 1;
    const bubble = bubbleFromNorm(width, height, line.x ?? 0, line.y ?? 0, line.w ?? 0.2, line.h ?? 0.1);
    if (bubble.width < 12 || bubble.height < 12) throw new AiJobError("Selection is too small");
    const jpeg = await maskedBubbleCrop(raw, bubble, signal);
    signal.throwIfAborted();
    return readOcrConsensus(jpeg, signal, defaultTranscriptionRead, ocr.translate, opts.lang, transcriptionIdsFor(opts.series.id, opts.episode.id));
  });
  const translateLines = opts.translateLines ?? (async (pageLines, imageId, signal) => {
    const ctx = await loadTranslateContext(opts.series.id, opts.episode.id, imageId ?? undefined);
    const boxes = pageLines.map((line) => ({
      x: line.x ?? 0, y: line.y ?? 0, w: line.w ?? 0.2, h: line.h ?? 0.1,
      lineType: line.lineType, source: line.source || "",
      literal: "", translation: "", reasoning: "",
    }));
    const translated = await runTranslate(selected.engine, boxes, {
      ...ctx, lang: opts.lang, model: selected.model, abort: signal, requireTranslation: true,
    });
    const out = new Map<string, string>();
    pageLines.forEach((line, i) => {
      const body = translated[i]?.translation.trim();
      if (body) out.set(line.id, body);
    });
    return out;
  });
  const translateSuggestion = opts.translateSuggestion ?? ((source, abort) => ocr.translate(source, abort, opts.lang));
  void runWithJob({ jobId, step: "fill-missing", engine: selected.engine, model: selected.model }, async () => {
    try {
      progress.total = work.sourceLines.length + work.englishLines.length + work.suggestions.length;
      tick(`Filling missing text · ${progress.total} items`);
      for (const line of work.sourceLines) {
        if (abort.signal.aborted) break;
        try {
          const consensus = await ocrLine(line, abort.signal);
          abort.signal.throwIfAborted();
          const saved = saveFillMissingSource(opts.episode.id, line, consensus, ocr.label);
          if (saved && !(line.source || "").trim() && (saved.source || "").trim()) progress.sourceFilled++;
        } catch (e) {
          if (abort.signal.aborted) break;
          failItem(line.id, e);
        }
        progress.completed++;
        if (!abort.signal.aborted) tick(`Source ${progress.sourceFilled} filled · ${progress.completed} of ${progress.total}`);
      }
      const englishTargets = (await listLines(opts.episode.id)).filter((line) =>
        (opts.imageId === undefined || line.imageId === opts.imageId) && needsFillEnglish(line));
      progress.total = work.sourceLines.length + englishTargets.length + work.suggestions.length;
      const byPage = new Map<string | null, LineRow[]>();
      for (const line of englishTargets) {
        const key = line.imageId ?? null;
        const group = byPage.get(key) ?? [];
        group.push(line);
        byPage.set(key, group);
      }
      for (const [imageId, pageLines] of byPage) {
        if (abort.signal.aborted) break;
        try {
          const translated = await translateLines(pageLines, imageId, abort.signal);
          abort.signal.throwIfAborted();
          for (const line of pageLines) {
            const body = translated.get(line.id);
            if (body && writeFillMissingEnglish(opts.episode.id, line.id, body, opts.user.id))
              progress.englishFilled++;
            progress.completed++;
          }
        } catch (e) {
          if (abort.signal.aborted) break;
          for (const line of pageLines) {
            failItem(line.id, e);
            progress.completed++;
          }
        }
        if (!abort.signal.aborted)
          tick(`English ${progress.englishFilled} filled · ${progress.completed} of ${progress.total}`);
      }
      const leftover = collectFillMissingWork(opts.episode.id, opts.imageId).suggestions;
      progress.total = work.sourceLines.length + englishTargets.length + leftover.length;
      for (const suggestion of leftover) {
        if (abort.signal.aborted) break;
        try {
          const english = await translateSuggestion(suggestion.body, abort.signal);
          abort.signal.throwIfAborted();
          if (writeFillMissingSuggestionTranslation(opts.episode.id, suggestion.id, english))
            progress.suggestionsFilled++;
        } catch (e) {
          if (abort.signal.aborted) break;
          failItem(suggestion.id, e);
        }
        progress.completed++;
        if (!abort.signal.aborted)
          tick(`Suggestions ${progress.suggestionsFilled} filled · ${progress.completed} of ${progress.total}`);
      }
      progress.message = abort.signal.aborted
        ? "Cancelled"
        : `Filled ${progress.sourceFilled} sources, ${progress.englishFilled} English drafts, ${progress.suggestionsFilled} suggestion translations`;
      updateJob(jobId, abort.signal.aborted ? "cancelled" : progress.failed ? "failed" : "completed",
        progress, progress.errors.join("\n") || undefined);
    } finally {
      fillMissingBatches.delete(opts.episode.id);
    }
  });
  return {
    jobId,
    total: work.sourceLines.length + work.englishLines.length + work.suggestions.length,
    sources: work.sourceLines.length,
    english: work.englishLines.length,
    suggestions: work.suggestions.length,
  };
}
