import { decisionThreshold, DECIDER_MIN_PROBABILITY, DECIDER_MIN_MARGIN } from '$lib/decider';
import { imageWorkflowModel, imageWorkflowChoices, runImageTaskFiles } from '$lib/server/modelImageWorkflow';
import { DEFAULT_CHAT_MODEL_ID } from '$lib/modelDefaults';
import { assignCharacter } from '$lib/server/characters';
import { parseReviseCouncil, validateModel } from "$lib/server/regionAi";
import { rowHasOperation } from '$lib/modelRegistry';
import type { ProviderOperation } from '$lib/providerCatalog';
import { MAX_SOURCE_REVIEWERS } from '$lib/localReviewModels';
import { MAX_TRANSCRIPTION_MODELS, normalizeTranscriptionModels } from '$lib/regionAi';
import { transcriptionModelIds } from '$lib/server/ocrConsensus';
import { resolveLiveAssistant } from '$lib/server/assistantRoute';
import { maskInputs } from "$lib/maskDiagnostics";
import { automaticRegionPolygon, bubbleFitPoints } from "$lib/regionGeometry";
import { transformPlacedText } from "$lib/server/placedText";
import { assertEngineReady } from "$lib/server/engineReadiness";
import { json } from "@sveltejs/kit";
import { readFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, sqlite } from "$lib/server/db";
import { logActivity } from "$lib/server/activity";
import { lines, images } from "$lib/server/db/schema";
import {
  requireUser,
  assertEpisodeIdle,
  requireEpisodeAccess,
  requireEdit,
  requireClean,
  requireStickies,
  requireUpload,
  fail,
  statusOf,
  messageOf,
} from "$lib/server/http";
import { canClean, canEditTranslations, canUpload } from "$lib/server/access";
import {
  getDoc,
  putDoc,
  storeAsset,
  readAsset,
  assetPath,
  previousSavedArtwork,
  withPreviousArtwork,
  WorkflowError,
} from "$lib/server/workflowStore";
import {
  acceptTranslationSuggestions,
  applyCleaning,
  approveAllGeometry,
  approveAllTranslations,
  approveEverything,
  saveSeriesReadingPreferences,
  keepCurrentLayouts,
  typesetRegions,
  acceptedRegionKind,
  workflowState,
  fitRegion,
  readiness,
  preparePage,
  renumberPages,
  removeBlankRegions,
  removePageRegions,
  resetRegionStyles,
  saveSeriesRegionAi,
  saveSeriesRegionKinds,
  saveSeriesTypeSettings,
} from "$lib/server/workflowService";
import { appendJobLog, createJob, listJobs, jobPollStamp, updateJob, pageResult, clearFinishedJobs, clearAllJobs, runWithJob, type JobPayload } from "$lib/server/jobs";
import { cleaningDeviceLabel, localOperation, probeBackend } from "$lib/server/localWorker";
import { gpuClientStatus } from "$lib/server/gpuMode";
import { presentGpuStatus } from "$lib/server/computeDevices";
import { cleanWithCodex, probeCodexCleaning } from "$lib/server/codexClean";
import { cleanWithQwenImage } from "$lib/server/qwenImageClean";
import { probeImageEditCleaning } from "$lib/server/imageEdit";
import { IMAGE_EDIT_MODELS, imageEditModelForMethod, normalizeImageEditPrompt } from "$lib/imageEdit";
import { normalizeCodexCleanPrompt } from "$lib/codexCleanPrompt";
import { captureExport, isExportSnapshot, recallExport, startExport } from "$lib/server/finishedExport";
import { completeOutstandingPages, forgetPageHistory } from "$lib/server/stepUndo";
import { PAGE_STEPS, type PageStep } from "$lib/workflow";
import { listImages, listLines, toLine } from "$lib/server/queries";
import { uploadFont } from "$lib/server/typesetting";
import { DATA_DIR } from "$lib/server/paths";
import { broadcast } from "$lib/server/realtime";
import { nid, now } from "$lib/server/ids";
import {
  startAiTranslate,
  startAiTranscribe,
  startAiProofread,
  startAiReview,
  cancelAiTranslate,
  cancelRegionQueue,
  cancelRereadBatch,
  cancelSuggestAlternatives,
  enqueueRegionTranslate,
  startSuggestAlternatives,
  acceptRegionSuggestion,
  startSourceRetranslation,
  cancelSourceRetranslation,
  startRegionOcr,
  cancelRegionOcr,
  startFillMissing,
  cancelFillMissing,
} from "$lib/server/aiTranslate";
import {
  startGlossaryMine,
  cancelGlossaryMine,
  decideGlossaryMineTerms,
} from "$lib/server/glossaryMine";
import { cancelDescribePages, startDescribePages } from "$lib/server/pageEdit";
import { cancelReslice, startReslice } from "$lib/server/reslice";
import { cancelPageProofread, startPageProofread, startPageProofreadFollowUp } from '$lib/server/pageProofread';
import { KOHARU_MODEL, maskModelName, parseDetectConf } from "$lib/server/detect";
import { detectorSetupId, parseDetectorSetup } from "$lib/detectorSetup";
import { komatoseGpuEnabled } from "$lib/server/gpuMode";
import { CLEAN_INPAINT_MODELS } from "$lib/cleanMethods";
import { isAdmin } from "$lib/server/access";
import { normalizeRegionKinds } from "$lib/regionCatalog";
import { DETECTORS, type Episode, type PublicUser, type Series } from "$lib/types";
import { pickStyle, pageArtwork, pageRawArtwork, MASK_GROW_MAX, MASK_GROW_MIN, type PageData, type RegionData, type Point, type Preferences, type WorkflowDoc } from "$lib/workflow";
import { saveRegionTextMask } from "$lib/server/textMask";
import { saveCleaningSample } from "$lib/server/cleaningSamples";
import type { RequestHandler } from "./$types";

const aborts = new Map<string, AbortController>();

/**
 * Replay a stored job payload into the starter that created it.
 *
 * Retry reuses exactly the fields the starter saved, so the payload already
 * matches its parameter shape — but that shape is per-kind and not tracked in the
 * type system. Required members are checked here so a corrupt row fails with a
 * clear error rather than dispatching a half-formed job.
 */
function replayArgs<T extends object>(
  payload: JobPayload,
  ctx: { series: Series; episode: Episode; user: PublicUser },
  required: string[],
): T {
  for (const key of required) {
    if (payload[key] === undefined || payload[key] === null)
      throw new WorkflowError(
        `This job cannot be retried: its saved ${key} is missing. Start a new job instead.`,
        409,
      );
  }
  return { ...payload, ...ctx } as T;
}

function workflowRunStatus(action: string, method: string, detect: boolean, maskEngine?: string) {
  if (action === "mask") {
    const model = maskModelName(maskEngine);
    const running = model === KOHARU_MODEL ? `${model} · ${komatoseGpuEnabled() ? "GPU" : "CPU"}` : model;
    return detect
      ? { step: "Detecting lettering mask", model: running, engine: maskEngine || "auto" }
      : { step: "Painting lettering mask", model: "Brush", engine: "mask" };
  }
  if (action === "geometry") {
    const model = method === "sam" ? "SAM 2" : "OpenCV";
    return { step: "Fitting region geometry", model, engine: method || "opencv" };
  }
  const known = CLEAN_INPAINT_MODELS.find((item) => item.id === method);
  const model = known?.label || (method === "sam" ? "SAM 2" : method || "Auto");
  return { step: "Cleaning artwork", model, engine: method || "auto" };
}
function clickPoint(body: { px?: unknown; py?: unknown }): { px: number; py: number } {
  const px = Number(body.px);
  const py = Number(body.py);
  if (!Number.isFinite(px) || !Number.isFinite(py) || px < 0 || px > 1 || py < 0 || py > 1)
    throw new WorkflowError("Click a point on the page");
  return { px, py };
}
async function runWorkflowPng(payload: Record<string, unknown>) {
  const output = join(DATA_DIR, "workflow", `${randomUUID()}.png`);
  try {
    await mkdir(join(DATA_DIR, "workflow"), { recursive: true });
    const started = Date.now();
    const result = (await localOperation({ ...payload, out: output })) as Record<string, any>;
    result.cleanDurationMs = Date.now() - started;
    return { result, artifact: await storeAsset(await readFile(output)) };
  } finally {
    await unlink(output).catch(() => {});
  }
}
function brushStrokes(value: unknown, empty: string) {
  const strokes = (Array.isArray(value) ? value : []).map((s: any) => {
    if (!Number.isFinite(s.radius) || s.radius < 1 || s.radius > 200)
      throw new WorkflowError("Invalid brush size");
    return { points: points(s.points), radius: s.radius };
  });
  if (!strokes.length) throw new WorkflowError(empty);
  if (strokes.length > 1000) throw new WorkflowError("Too many brush strokes");
  return strokes;
}
function saveCleanPixels(
  episodeId: string,
  doc: WorkflowDoc<PageData>,
  artifact: string,
  result: { method?: string; backend?: string; cleanDurationMs?: number },
  mode: "keep" | "replace",
) {
  return putDoc(
    episodeId,
    doc.id,
    withPreviousArtwork(
      doc.id,
      doc.data,
      {
        ...doc.data,
        cleanBase: artifact,
        cleaned: undefined,
        cleanMethod: result.method,
        cleanDurationMs: result.cleanDurationMs,
        backend: result.backend,
        cleanApproved: false,
      },
      mode,
    ),
    doc.revision,
  );
}
function points(value: unknown): Point[] {
  if (
    !Array.isArray(value) ||
    value.length > 10000 ||
    value.some(
      (p) =>
        !p ||
        !Number.isFinite(p.x) ||
        !Number.isFinite(p.y) ||
        p.x < 0 ||
        p.x > 1 ||
        p.y < 0 ||
        p.y > 1,
    )
  )
    throw new WorkflowError("Invalid points");
  return value.map((p) => ({ x: p.x, y: p.y }));
}
function assertPassedTask(
  model: { engine: string; model: string },
  operation: ProviderOperation | readonly ProviderOperation[],
  label: string,
) {
  let name = model.engine;
  try {
    const row = resolveLiveAssistant(model.engine, model.model).row;
    name = row.name;
    if (rowHasOperation(row, operation)) return;
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError("Choose a valid engine and model");
  }
  throw new WorkflowError(`${name} has not passed its ${label} test. Run it under Admin → Models → Jobs.`);
}
function parseRegionAi(ai: any): NonNullable<Preferences["regionAi"]> {
  if (!Array.isArray(ai?.reviewers) || ai.reviewers.length > MAX_SOURCE_REVIEWERS)
    throw new WorkflowError("Choose up to five reviewers");
  const transcriptionModels = transcriptionModelIds(normalizeTranscriptionModels(ai.transcriptionModels));
  if (!transcriptionModels.length) throw new WorkflowError('Choose a transcription model');
  const regionAi = {
    translate: validateModel(ai.translate),
    describe: validateModel(ai.describe),
    vision: validateModel(ai.vision),
    proofread: validateModel(ai.proofread),
    enquire: validateModel(ai.enquire),
    reviewers: ai.reviewers.map(validateModel),
    reviseModels: parseReviseCouncil(ai.reviseModels),
    transcriptionModels,
    ...(ai.transcriptionDecider !== undefined ? { transcriptionDecider: ai.transcriptionDecider === null ? null : validateModel(ai.transcriptionDecider) } : {}),
    ...(ai.deciderMinProbability !== undefined ? { deciderMinProbability: decisionThreshold(ai.deciderMinProbability, DECIDER_MIN_PROBABILITY) } : {}),
    ...(ai.deciderMinMargin !== undefined ? { deciderMinMargin: decisionThreshold(ai.deciderMinMargin, DECIDER_MIN_MARGIN) } : {}),
  };
  if (regionAi.transcriptionModels.length > MAX_TRANSCRIPTION_MODELS)
    throw new WorkflowError(`Choose up to ${MAX_TRANSCRIPTION_MODELS} transcription models`);
  if (new Set(regionAi.reviewers.map((m: { engine: string; model: string }) => `${m.engine}:${m.model}`)).size !== regionAi.reviewers.length)
    throw new WorkflowError("Choose different reviewer models");
  return regionAi;
}
export const GET: RequestHandler = async ({ locals, params, url }) => {
  try {
    const user = requireUser(locals.user);
    const { series, episode } = await requireEpisodeAccess(user, params.eid);
    if (url.searchParams.has("backend")) {
      const [backend, codex, ...editors] = await Promise.all([
        probeBackend(), probeCodexCleaning(),
        ...IMAGE_EDIT_MODELS.map((model) => probeImageEditCleaning(model.id)),
      ]);
      // One readiness entry per editor, keyed by the clean-method id the picker uses.
      const imageEdit = Object.fromEntries(
        IMAGE_EDIT_MODELS.map((model, index) => [model.method, editors[index]]),
      );
      return json({ ...backend, models: imageWorkflowChoices(), codex, imageEdit, gpu: presentGpuStatus(gpuClientStatus(cleaningDeviceLabel())) });
    }
    if (url.searchParams.has("history")) {
      return json({
        history: sqlite
          .prepare(
            "SELECT * FROM workflow_revisions WHERE episode_id=? AND entity_id=? ORDER BY id DESC LIMIT 100",
          )
          .all(episode.id, url.searchParams.get("history")),
      });
    }
    const stamp = jobPollStamp(episode.id);
    if (url.searchParams.has("jobs")) {
      const revision = Number(url.searchParams.get("revision"));
      const jobsAt = Number(url.searchParams.get("jobsAt"));
      if (revision === stamp.revision && jobsAt === stamp.jobsAt)
        return json({ unchanged: true, ...stamp });
      return json({ ...stamp, jobs: listJobs(episode.id, "summary") });
    }
    return json({
      ...(await workflowState(series, episode)),
      ...stamp,
      jobs: listJobs(episode.id, "summary"),
    });
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};
export const POST: RequestHandler = async ({ locals, params, request }) => {
  try {
    const user = requireUser(locals.user);
    const { series, episode } = await requireEpisodeAccess(user, params.eid);
    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      requireClean(user);
      const form = await request.formData();
      const files = form
        .getAll("font")
        .filter((f): f is File => f instanceof File && f.size > 0);
      if (!files.length) throw new WorkflowError("Choose a font file");
      const results = [];
      for (const file of files) {
        results.push(
          await uploadFont(
            series.id,
            file.name,
            Buffer.from(await file.arrayBuffer()),
          ),
        );
      }
      // Single-file uploads keep the original shape for existing clients/tests.
      if (results.length === 1) return json(results[0]);
      return json({
        fonts: results.map((r) => r.font),
        results,
        font: results[results.length - 1]!.font,
        duplicate: results.every((r) => r.duplicate),
      });
    }
    let b = await request.json();
    let action = String(b.action);
    if (action === "mark-all-complete") {
      const step = b.step === undefined ? undefined : String(b.step) as PageStep;
      if (step !== undefined && !PAGE_STEPS.includes(step)) throw new WorkflowError("Unknown workflow step");
      if (!step || step === "translate" || step === "review") requireEdit(user);
      if (!step || step === "clean" || step === "typeset") requireClean(user);
      assertEpisodeIdle(episode.id);
      if (listJobs(episode.id).some(j => ["running", "queued", "cancelling"].includes(j.state)))
        throw new WorkflowError("Wait for chapter jobs to finish before marking pages done", 409);
      return json(completeOutstandingPages(episode.id, step));
    }
    if (action === "approve-everything") {
      requireEdit(user);
      requireClean(user);
      assertEpisodeIdle(episode.id);
      if (listJobs(episode.id).some(j => ["running", "queued", "cancelling"].includes(j.state)))
        throw new WorkflowError("Wait for chapter jobs to finish before approving everything", 409);
      return json(approveEverything(episode.id, user.id));
    }
    if (action === "forget-page-history") {
      const stepName = String(b.step || "");
      if (stepName === "clean" || stepName === "typeset") requireClean(user);
      else if (stepName === "translate" || stepName === "review") requireEdit(user);
      else throw new WorkflowError("Unknown workflow step");
      if (stepName === 'clean' && listJobs(episode.id).some(j =>
        ['mask', 'clean'].includes(j.kind) && ['running', 'queued', 'cancelling'].includes(j.state) &&
        (j.payload?.request?.imageId === b.imageId || j.payload?.imageId === b.imageId)))
        throw new WorkflowError('Wait for this page’s mask or cleaning job to finish before marking it done.', 409);
      return json(forgetPageHistory(episode.id, String(b.imageId || ""), stepName));
    }
    if (action === "export") {
      const snapshot = await captureExport(
        series,
        episode,
        b.format,
        !!b.draft,
        b.quality ?? 95,
        b.includeMetadata === true,
      );
      return json({ jobId: startExport(snapshot) }, { status: 202 });
    }
    if (action === "clear-finished") {
      return json({ ok: true, removed: clearFinishedJobs(episode.id) });
    }
    if (action === "clear-all") {
      return json({ ok: true, removed: clearAllJobs(episode.id) });
    }
    if (action === "cancel" || action === "retry") {
      const job = listJobs(episode.id).find((j) => j.id === b.jobId);
      if (!job) throw new WorkflowError("Job not found", 404);
      if (job.kind === "export") {
        if (action === "cancel") updateJob(job.id, "cancelled", job.progress);
        else {
          if (job.state === "running")
            throw new WorkflowError("Job is already running", 409);
          const remembered = recallExport(job.id);
          const snapshot = remembered
            ?? (isExportSnapshot(job.payload)
              ? job.payload
              : await captureExport(
                  series,
                  episode,
                  job.payload?.format || "png",
                  !!job.payload?.draft,
                  job.payload?.quality ?? 95,
                  job.payload?.includeMetadata === true,
                ));
          startExport(snapshot, job.id);
        }
        return json({ ok: true });
      }
      if (["describe", "reslice"].includes(job.kind)) requireUpload(user);
      else if (["transcribe", "translate", "proofread", "page-proofread", "review", "selection", "reread", "fill-missing", "suggest", "source-translation", "region-ocr", "glossary-mine"].includes(job.kind))
        requireEdit(user);
      else requireClean(user);
      if (
        action === "retry" &&
        !["failed", "interrupted", "cancelled"].includes(job.state)
      )
        throw new WorkflowError("Only unfinished jobs can be retried", 409);
      if (action === "cancel") {
        if (["transcribe", "translate", "proofread", "review"].includes(job.kind))
          cancelAiTranslate(episode.id);
        if (job.kind === "selection") cancelRegionQueue(episode.id);
        if (job.kind === "reread") cancelRereadBatch(episode.id);
        if (job.kind === "fill-missing") cancelFillMissing(episode.id);
        if (job.kind === "suggest") cancelSuggestAlternatives(episode.id);
        if (job.kind === "source-translation") cancelSourceRetranslation(job.id);
        if (job.kind === "region-ocr") cancelRegionOcr(job.id);
        if (job.kind === "glossary-mine") cancelGlossaryMine(job.id);
        if (job.kind === 'page-proofread') cancelPageProofread(job.id);
        if (job.kind === "describe") cancelDescribePages(episode.id);
        if (job.kind === "reslice") cancelReslice(episode.id);
        aborts.get(job.id)?.abort();
        updateJob(job.id, "cancelled", {
          ...(job.progress || {}),
          message: job.progress?.total != null
            ? `Cancelled · ${job.progress.completed ?? 0}/${job.progress.total}`
            : "Cancelled",
        });
        return json({ ok: true });
      }
      if (job.kind === "describe")
        return json(
          startDescribePages(
            { series, episode, user },
            job.payload.imageIds,
            Boolean(job.payload.overwrite),
            job.payload.engine || DEFAULT_CHAT_MODEL_ID,
            job.payload.model,
          ),
          { status: 202 },
        );
      if (job.kind === "reslice")
        return json(startReslice({ series, episode, user }, job.payload), { status: 202 });
      if (job.kind === 'page-proofread') {
        if (job.payload.followUpOf) {
          const hashes = Array.isArray(job.progress?.snapshot?.followUpImages)
            ? job.progress.snapshot.followUpImages.filter((hash: unknown) => typeof hash === 'string')
            : [];
          const images = await Promise.all(hashes.map((hash: string) => readAsset(hash)));
          return json(startPageProofreadFollowUp({
            series,
            episode,
            parentJobId: String(job.payload.followUpOf),
            prompt: String(job.payload.prompt || job.progress?.prompt || ''),
            images,
          }), { status: 202 });
        }
        const savedImageId = job.payload.imageId;
        if (!savedImageId)
          throw new WorkflowError(
            "This page-proofread job has no saved page. Start a new proofread instead.",
            409,
          );
        return json(startPageProofread({
          series,
          episode,
          imageId: savedImageId,
          model: {
            engine: job.payload.engine || DEFAULT_CHAT_MODEL_ID,
            model: job.payload.model || '',
          },
          snapshot: job.progress.snapshot,
        }), { status: 202 });
      }
      if (["translate", "proofread", "review", "selection", "reread", "suggest", "glossary-mine"].includes(job.kind))
        await assertEngineReady(job.payload.engine || DEFAULT_CHAT_MODEL_ID, job.payload.model);
      if (job.kind === "source-translation")
        return json(
          startSourceRetranslation(
            replayArgs<Parameters<typeof startSourceRetranslation>[0]>(
              job.payload,
              { series, episode, user },
              ["lineId", "expectedRevision"],
            ),
          ),
          { status: 202 },
        );
      if (job.kind === "region-ocr")
        return json(
          startRegionOcr(
            replayArgs<Parameters<typeof startRegionOcr>[0]>(
              job.payload,
              { series, episode, user },
              ["lineId"],
            ),
          ),
          { status: 202 },
        );
      if (job.kind === "glossary-mine")
        return json(
          await startGlossaryMine(
            replayArgs<Parameters<typeof startGlossaryMine>[0]>(
              job.payload,
              { series, episode, user },
              [],
            ),
          ),
          { status: 202 },
        );
      if (job.kind === "fill-missing")
        return json(
          await startFillMissing(
            replayArgs<Parameters<typeof startFillMissing>[0]>(
              job.payload,
              { series, episode, user },
              [],
            ),
          ),
          { status: 202 },
        );
      if (job.kind === "suggest")
        return json(
          await startSuggestAlternatives(
            replayArgs<Parameters<typeof startSuggestAlternatives>[0]>(
              job.payload,
              { series, episode, user },
              ["lineId"],
            ),
          ),
          { status: 202 },
        );
      if (job.kind === "selection")
        return json(
          enqueueRegionTranslate(
            replayArgs<Parameters<typeof enqueueRegionTranslate>[0]>(
              job.payload,
              { series, episode, user },
              ["imageId", "x", "y", "w", "h"],
            ),
          ),
          { status: 202 },
        );
      if (job.kind === "review")
        return json(
          {
            job: await startAiReview(
              replayArgs<Parameters<typeof startAiReview>[0]>(
                job.payload,
                { series, episode, user },
                [],
              ),
            ),
          },
          { status: 202 },
        );
      if (job.kind === "transcribe" || job.kind === "translate" || job.kind === "proofread") {
        if (job.kind === "transcribe" || job.kind === "translate") requireUpload(user);
        const completed = new Set(
          job.pages
            .filter((p: any) => p.state === "completed")
            .map((p: any) => p.image_id),
        );
        const ids = [
          ...(await listImages(episode.id)),
          ...(job.kind === "proofread" ? [{ id: "unplaced" }] : []),
        ]
          .filter(
            (p) =>
              !completed.has(p.id) &&
              (!job.payload.imageIds?.length ||
                job.payload.imageIds.includes(p.id)),
          )
          .map((p) => p.id);
        if (!ids.length)
          throw new WorkflowError("All requested pages completed");
        const common = { ...job.payload, imageIds: ids };
        const next =
          job.kind === "transcribe"
            ? startAiTranscribe(
                replayArgs<Parameters<typeof startAiTranscribe>[0]>(
                  common,
                  { series, episode, user },
                  ["imageIds"],
                ),
              )
            : job.kind === "translate"
              ? startAiTranslate(
                  replayArgs<Parameters<typeof startAiTranslate>[0]>(
                    { ...common, replace: false },
                    { series, episode, user },
                    ["imageIds"],
                  ),
                )
              : startAiProofread(
                  replayArgs<Parameters<typeof startAiProofread>[0]>(
                    common,
                    { series, episode, user },
                    ["imageIds"],
                  ),
                );
        return json({ job: next }, { status: 202 });
      }
      if (
        ["mask", "clean", "geometry"].includes(job.kind) &&
        job.payload.request
      ) {
        if (job.state === "running" || job.state === "queued")
          throw new WorkflowError("Job is already running", 409);
        b = job.payload.request;
        action = String(b.action);
      } else
        throw new WorkflowError(
          "This older job has no resumable request. Start the operation again.",
        );
    }
    if (action === "transform-text") {
      requireStickies(user);
      if (b.rotation !== undefined) requireClean(user);
      if (b.skewX !== undefined || b.skewY !== undefined) requireClean(user);
      const line = (await listLines(episode.id)).find(l => l.id === b.id);
      if (!line) throw new WorkflowError("Region not found", 404);
      const page = (await listImages(episode.id)).find(p => p.id === line.imageId);
      if (!page) throw new WorkflowError("Page not found", 404);
      const x = b.x ?? line.x, y = b.y ?? line.y;
      if (![x, y].every(v => Number.isFinite(v) && v >= 0 && v <= 1))
        throw new WorkflowError("Invalid position");
      if (b.rotation !== undefined && (!Number.isFinite(b.rotation) || Math.abs(b.rotation) > 180))
        throw new WorkflowError("Invalid rotation");
      if (b.skewX !== undefined && (!Number.isFinite(b.skewX) || Math.abs(b.skewX) > 75))
        throw new WorkflowError("Invalid horizontal skew");
      if (b.skewY !== undefined && (!Number.isFinite(b.skewY) || Math.abs(b.skewY) > 75))
        throw new WorkflowError("Invalid vertical skew");
      const doc = sqlite.transaction(() => {
        const region = getDoc<RegionData>(`region:${line.id}`, {});
        if (region.revision !== b.expectedRegionRevision || line.revision !== b.expectedRevision)
          throw new WorkflowError("Region changed; refresh before moving text", 409);
        if (region.data.locked) throw new WorkflowError("Unlock this layout first");
        const data = transformPlacedText(line, region.data, page, x, y, b.rotation, b.skewX, b.skewY);
        const changed = sqlite.prepare("UPDATE lines SET x=?,y=?,updated_by=?,updated_at=? WHERE id=? AND episode_id=? AND revision=?")
          .run(x, y, user.id, Date.now(), line.id, episode.id, b.expectedRevision);
        if (!changed.changes) throw new WorkflowError("Region changed", 409);
        return putDoc(episode.id, region.id, data, region.revision);
      })();
      const updated = (await listLines(episode.id)).find(l => l.id === line.id)!;
      broadcast(episode.id, { type: "line:upsert", line: updated });
      return json({ doc, line: updated });
    }
    if (action === "remove-page-regions" || action === "remove-selected-page-regions") {
      requireEdit(user);
      assertEpisodeIdle(episode.id);
      const input = action === "remove-page-regions" ? [String(b.imageId || "")] : b.imageIds;
      if (!Array.isArray(input) || !input.length || input.some(id => typeof id !== "string" || !id))
        throw new WorkflowError("Select at least one page");
      const imageIds = [...new Set<string>(input)];
      const pages = new Set((await listImages(episode.id)).map(img => img.id));
      if (imageIds.some(id => !pages.has(id)))
        throw new WorkflowError("Page not found", 404);
      const ids = removePageRegions(episode.id, imageIds);
      if (ids.length) {
        const entry = await logActivity({
          seriesId: series.id,
          episodeId: episode.id,
          userId: user.id,
          action: "deleted_page_regions",
          payload: action === "remove-page-regions" ? { imageId: imageIds[0], ids } : { imageIds, ids },
        });
        broadcast(episode.id, { type: "activity", entry });
      }
      return json({ removed: ids.length, ids });
    }
    if (action === "remove-blank-regions") {
      requireEdit(user);
      assertEpisodeIdle(episode.id);
      const ids = removeBlankRegions(episode.id);
      if (ids.length) {
        const entry = await logActivity({
          seriesId: series.id, episodeId: episode.id, userId: user.id,
          action: "deleted_blank_regions", payload: { ids },
        });
        broadcast(episode.id, { type: "activity", entry });
      }
      return json({ removed: ids.length });
    }
    if (action === "renumber") {
      requireUpload(user);
      renumberPages(episode.id);
      return json({ images: await listImages(episode.id) });
    }
    if (action === "accept-translation-suggestions") {
      requireEdit(user);
      if (b.imageId !== undefined && typeof b.imageId !== "string")
        return fail(400, "Invalid page");
      return json(acceptTranslationSuggestions(episode.id, user.id, b.imageId, b.force === true));
    }
    if (action === "glossary-mine") {
      requireEdit(user);
      const model = b.engine ? validateModel({ engine: b.engine, model: b.model || "" }) : undefined;
      return json(await startGlossaryMine({ series, episode, user, engine: model?.engine, model: model?.model }), { status: 202 });
    }
    if (action === "glossary-decide") {
      requireEdit(user);
      if (!b.jobId || !Array.isArray(b.decisions)) throw new WorkflowError("Choose terms to accept or reject");
      return json(await decideGlossaryMineTerms({
        series, episode, user, jobId: String(b.jobId),
        decisions: b.decisions.map((d: { source?: string; decision?: string }) => ({
          source: String(d?.source || ""),
          decision: d?.decision === "reject" ? "reject" : "accept",
        })),
      }));
    }
    if (action === "suggestion") {
      requireEdit(user);
      if (!["accept", "reject"].includes(b.decision))
        throw new WorkflowError("Invalid decision");
      const model = b.translationModel === undefined ? undefined : validateModel(b.translationModel);
      const result = acceptRegionSuggestion({ series, episode, user, id: b.id,
        decision: b.decision, force: !!b.force, engine: model?.engine, model: model?.model });
      return json({ ok: true, ...result });
    }
    if (action === 'assign-character') {
      requireEdit(user);
      assertEpisodeIdle(episode.id);
      return json({ doc: assignCharacter(episode.id, series.id, String(b.id || ''), b.characterId, b.expectedRevision) });
    }
    if (action === "preferences") {
      if (b.scope === "series" && b.data && "regionKinds" in b.data) {
        if (!isAdmin(user) && series.createdBy !== user.id)
          throw new WorkflowError("Only the series owner can change region types", 403);
        let kinds = null;
        if (b.data.regionKinds != null) {
          try {
            kinds = normalizeRegionKinds(b.data.regionKinds);
          } catch (e) {
            throw new WorkflowError(e instanceof Error ? e.message : "Invalid region types");
          }
        }
        return json({
          doc: saveSeriesRegionKinds(series.id, Number(b.expectedRevision), kinds),
        });
      }
      if (b.scope === "series") {
        if (b.data && ("lang" in b.data || "direction" in b.data)) {
          requireEdit(user);
          return json({ doc: saveSeriesReadingPreferences(series.id, b.expectedRevision, b.data) });
        }
        if (b.data?.regionAi) {
          requireEdit(user);
          return json({
            doc: saveSeriesRegionAi(series.id, b.expectedRevision, parseRegionAi(b.data.regionAi)),
          });
        }
        if (!canUpload(user) && !canClean(user))
          throw new WorkflowError("Forbidden", 403);
        return json({
          doc: saveSeriesTypeSettings(series.id, b.expectedRevision, {
            style: b.data?.style,
            styles: b.data?.styles,
          }),
        });
      }
      requireEdit(user);
      if (b.data && ("lang" in b.data || "direction" in b.data))
        throw new WorkflowError("Language and reading direction belong to the series. Save them in Series settings.");
      if (b.data && ('styles' in b.data || 'style' in b.data))
        throw new WorkflowError('Category styles belong to the series. Save them in Series type settings.');
      const id = `chapter:${episode.id}`;
      const current = getDoc<Partial<Preferences>>(id, {});
      const data = { ...current.data, ...b.data };
      delete data.lang;
      delete data.direction;
      if (b.data && "detector" in b.data) {
        if (!(DETECTORS as string[]).includes(String(b.data.detector)))
          throw new WorkflowError("Invalid detector");
      }
      if (b.data && "detectorSetup" in b.data) {
        // Any setup choice replaces a pre-setup detector, including "use the default".
        delete data.detector;
        if (b.data.detectorSetup == null || b.data.detectorSetup === "") delete data.detectorSetup;
        else {
          const setup = parseDetectorSetup(b.data.detectorSetup);
          if (!setup) throw new WorkflowError("Invalid detector setup");
          data.detectorSetup = detectorSetupId(setup);
        }
      }
      if (b.data && "detectConf" in b.data) {
        if (b.data.detectConf == null || b.data.detectConf === "") delete data.detectConf;
        else {
          const conf = parseDetectConf(b.data.detectConf);
          if (conf == null) throw new WorkflowError("Invalid detection confidence");
          data.detectConf = conf;
        }
      }
      if (b.data && "transcribeEnglish" in b.data)
        data.transcribeEnglish = b.data.transcribeEnglish === true;
      if (
        data.dpi != null &&
        (!Number.isFinite(data.dpi) || data.dpi < 10 || data.dpi > 2400)
      )
        throw new WorkflowError("Invalid DPI");
      if (b.data?.regionAi) {
        data.regionAi = parseRegionAi(b.data.regionAi);
      }
      return json({
        doc: putDoc(episode.id, id, data, b.expectedRevision),
      });
    }
    if (action === "approve-all-geometry") {
      requireClean(user);
      return json({ approved: approveAllGeometry(episode.id) });
    }
    if (action === "approve-all-translations") {
      requireEdit(user);
      return json({ approved: approveAllTranslations(episode.id, user.id) });
    }
    if (action === "keep-current-layouts") {
      requireClean(user);
      return json({ kept: keepCurrentLayouts(episode.id) });
    }
    if (action === "save-cleaning-sample") {
      requireClean(user);
      const img = (await listImages(episode.id)).find((p) => p.id === b.imageId);
      if (!img) throw new WorkflowError("Page not found", 404);
      return json(await saveCleaningSample(series, episode, img));
    }
    if (action === "reset-styles") {
      requireClean(user);
      if (!["page", "chapter"].includes(b.scope))
        throw new WorkflowError("Choose page or chapter");
      if (b.scope === "page" && typeof b.imageId !== "string")
        throw new WorkflowError("Choose a page");
      return json({
        ok: true,
        ...resetRegionStyles(episode.id, {
          imageId: b.scope === "page" ? b.imageId : undefined,
          clearChapter: b.scope === "chapter",
        }),
      });
    }
    if (action === "text-mask") {
      requireClean(user);
      const line = (await listLines(episode.id)).find((l) => l.id === b.id);
      if (!line?.imageId) throw new WorkflowError("Region not found", 404);
      const img = (await listImages(episode.id)).find((p) => p.id === line.imageId);
      if (!img) throw new WorkflowError("Page not found", 404);
      const strokes = (b.strokes ?? []).map((s: { points?: unknown; radius?: number; erase?: boolean }) => {
        if (!Number.isFinite(s.radius) || (s.radius ?? 0) < 1 || (s.radius ?? 0) > 200)
          throw new WorkflowError("Invalid brush size");
        return { points: points(s.points), radius: s.radius as number, erase: !!s.erase };
      });
      if (strokes.length > 1000) throw new WorkflowError("Too many mask strokes");
      return json({
        doc: await saveRegionTextMask(episode.id, line, img, b.expectedRevision, {
          strokes,
          knockout: !!b.knockout,
          clear: !!b.clear,
        }),
      });
    }
    if (action === "fit") {
      if (!canClean(user) && !canEditTranslations(user)) requireClean(user);
      if ("style" in b) requireClean(user);
      const line = (await listLines(episode.id)).find((l) => l.id === b.id);
      if (!line) throw new WorkflowError("Region not found", 404);
      return json({
        doc: await fitRegion(series, episode, line.id, b.expectedRevision, {
          resetStyle: b.resetStyle === true,
          ...("style" in b ? { style: pickStyle(b.style) } : {}),
        }),
      });
    }
    if (
      action === "region" ||
      action === "split" ||
      action === "merge"
    ) {
      requireClean(user);
      const line = (await listLines(episode.id)).find((l) => l.id === b.id);
      if (!line) throw new WorkflowError("Region not found", 404);
      const doc = getDoc<RegionData>(`region:${line.id}`, {});
      if (action === "region") {
        let data: RegionData = { ...doc.data };
        if ("polygon" in b.data) data.polygon = points(b.data.polygon);
        if (data.polygon?.length && data.polygon.length < 3)
          throw new WorkflowError("A polygon needs at least three points");
        if ("style" in b.data) {
          const style = pickStyle(b.data.style);
          if (Object.keys(style).length) data.style = style;
          else delete data.style;
        }
        if ("locked" in b.data) data.locked = !!b.data.locked;
        if ("geometryApproved" in b.data)
          data.geometryApproved = !!b.data.geometryApproved;
        const saved = putDoc(
          episode.id,
          doc.id,
          data,
          b.expectedRevision,
          b.history || "save",
        );
        if (
          "polygon" in b.data &&
          !saved.data.locked &&
          line.body?.trim() &&
          (doc.data.layout || b.data.geometryApproved)
        ) {
          try {
            return json({
              doc: await fitRegion(series, episode, line.id, saved.revision),
            });
          } catch {
            /* Keep the new polygon; missing fonts or empty text skip the refit. */
          }
        }
        return json({ doc: saved });
      }
      requireEdit(user);
      if (b.expectedRevision !== line.revision)
        throw new WorkflowError("Region text changed", 409);
      if (action === "split") {
        if (!Number.isInteger(b.at) || b.at < 1 || b.at >= line.body.length)
          throw new WorkflowError(
            "Choose the English character position to split",
          );
        const row = {
          ...line,
          id: nid(),
          body: line.body.slice(b.at).trim(),
          source: "",
          sourceState: "unreadable",
          status: "needs_work",
          revision: 0,
          y: (line.y ?? 0) + (line.h ?? 0.1) / 2,
          h: (line.h ?? 0.1) / 2,
          sortOrder: line.sortOrder + 0.5,
          createdBy: user.id,
          updatedBy: user.id,
          updatedAt: now(),
        };
        db.transaction((tx) => {
          tx.update(lines)
            .set({
              body: line.body.slice(0, b.at).trim(),
              h: (line.h ?? 0.1) / 2,
              status: "needs_work",
              updatedAt: now(),
            })
            .where(eq(lines.id, line.id))
            .run();
          tx.insert(lines).values(row).run();
        });
      } else {
        const other = (await listLines(episode.id)).find(
          (l) =>
            l.id === b.otherId &&
            l.imageId === line.imageId &&
            l.id !== line.id,
        );
        if (!other || other.revision !== b.otherRevision)
          throw new WorkflowError("Choose a current region on the same page");
        const x = Math.min(line.x ?? 0, other.x ?? 0),
          y = Math.min(line.y ?? 0, other.y ?? 0);
        db.transaction((tx) => {
          tx.update(lines)
            .set({
              body: `${line.body}\n${other.body}`,
              source: `${line.source}\n${other.source}`,
              x,
              y,
              w:
                Math.max(
                  (line.x ?? 0) + (line.w ?? 0),
                  (other.x ?? 0) + (other.w ?? 0),
                ) - x,
              h:
                Math.max(
                  (line.y ?? 0) + (line.h ?? 0),
                  (other.y ?? 0) + (other.h ?? 0),
                ) - y,
              status: "needs_work",
              updatedAt: now(),
            })
            .where(eq(lines.id, line.id))
            .run();
          tx.update(lines)
            .set({
              sourceState: "ignored",
              ignoreReason: `Merged into ${line.id}`,
              updatedAt: now(),
            })
            .where(eq(lines.id, other.id))
            .run();
        });
      }
      putDoc(
        episode.id,
        doc.id,
        { ...doc.data, polygon: undefined, geometryApproved: false },
        doc.revision,
      );
      broadcast(episode.id, {
        type: "workflow:changed",
        id: doc.id,
        revision: doc.revision + 1,
      });
      return json({ ok: true });
    }
    if (action === "typeset-all") {
      requireClean(user);
      if (!["page", "chapter"].includes(b.scope))
        throw new WorkflowError("Choose page or chapter");
      const savedStyle = b.savedStyle === true;
      if (savedStyle && (b.scope !== 'chapter' || typeof b.lineType !== 'string' || !acceptedRegionKind(series.id, b.lineType)))
        throw new WorkflowError('Choose a chapter region type to refit from its saved series style.');
      if (
        listJobs(episode.id).some(
          (j) =>
            j.kind === "typeset-all" && ["running", "queued"].includes(j.state),
        )
      )
        throw new WorkflowError(
          "Automatic typesetting is already running",
          409,
        );
      const pages = (await listImages(episode.id)).filter(
        (p) => b.scope === "chapter" || p.id === b.imageId,
      );
      if (!pages.length) throw new WorkflowError("Page not found", 404);
      const targets = (await listLines(episode.id)).filter(
        (l) =>
          pages.some((p) => p.id === l.imageId) &&
          l.placed &&
          l.sourceState !== "ignored" &&
          l.body.trim(),
      );
      const selectedTargets = savedStyle ? targets.filter(l => l.lineType === b.lineType) : targets;
      const jobId = createJob(episode.id, "typeset-all", { request: b });
      const abort = new AbortController();
      aborts.set(jobId, abort);
      void (async () => {
        const errors: string[] = [];
        let completed = 0,
          skipped = 0;
        try {
          await typesetRegions(
            series,
            episode,
            pages,
            selectedTargets,
            abort.signal,
            (progress) => {
              completed = progress.completed;
              skipped = progress.skipped;
              errors.splice(0, errors.length, ...progress.errors);
              updateJob(jobId, "running", progress);
            },
            undefined,
            { savedStyle },
          );
          updateJob(jobId, abort.signal.aborted ? "cancelled" : "completed", {
            completed,
            skipped,
            total: selectedTargets.length,
            errors,
          });
        } catch (e) {
          updateJob(
            jobId,
            abort.signal.aborted ? "cancelled" : "failed",
            { completed, skipped, errors },
            messageOf(e),
          );
        } finally {
          aborts.delete(jobId);
        }
      })();
      return json({ jobId }, { status: 202 });
    }
    const img = (await listImages(episode.id)).find((i) => i.id === b.imageId);
    if (!img) throw new WorkflowError("Page not found", 404);
    requireClean(user);
    if (action === "prepare")
      return json({ doc: await preparePage(series, episode, img) });
    const doc = getDoc<PageData>(`page:${img.id}`, {});
    if (action === "page" && ["undo", "redo"].includes(b.history)) {
      return json({
        doc: putDoc(
          episode.id,
          doc.id,
          doc.data,
          b.expectedRevision,
          b.history,
        ),
      });
    }
    if (!doc.data.prepared || doc.data.preparedAt !== img.updatedAt)
      throw new WorkflowError("Prepare this page before cleaning");
    if (doc.revision !== b.expectedRevision)
      throw new WorkflowError(
        "Page changed. Reload the current version.",
        409,
        doc,
      );
    if (action === "apply-clean")
      return json({
        doc: applyCleaning(episode.id, img.id, b.expectedRevision),
      });
    if (action === "bubble-fill") {
      const { px, py } = clickPoint(b);
      const source = pageArtwork(doc.data)!;
      const { result, artifact } = await runWorkflowPng({
        cmd: "bubble-fill",
        path: assetPath(source),
        px,
        py,
      });
      return json({
        doc: saveCleanPixels(episode.id, doc, artifact, result, "keep"),
      });
    }
    if (action === "clone-brush") {
      const dx = Number(b.offset?.[0]);
      const dy = Number(b.offset?.[1]);
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 1.5 || Math.abs(dy) > 1.5)
        throw new WorkflowError("Clone stamp needs a source-to-destination offset");
      const cloneStrokes = brushStrokes(b.strokes, "Paint with the clone stamp after setting a source");
      const source = pageArtwork(doc.data)!;
      const { result, artifact } = await runWorkflowPng({
        cmd: "clone-brush",
        path: assetPath(source),
        offset: [dx, dy],
        strokes: cloneStrokes,
      });
      return json({
        doc: saveCleanPixels(episode.id, doc, artifact, result, "keep"),
      });
    }
    if (action === "blur-brush") {
      const blurStrokes = brushStrokes(b.strokes, "Paint with the blur brush");
      const source = pageArtwork(doc.data)!;
      const { result, artifact } = await runWorkflowPng({
        cmd: "blur-brush",
        path: assetPath(source),
        strokes: blurStrokes,
      });
      return json({
        doc: saveCleanPixels(episode.id, doc, artifact, result, "keep"),
      });
    }
    if (action === "restore-brush") {
      const restoreStrokes = brushStrokes(b.strokes, "Paint with the restore brush");
      const source = pageArtwork(doc.data)!;
      const previous = previousSavedArtwork(doc.id, doc.data);
      if (!previous || previous === source)
        throw new WorkflowError("Nothing to restore. Save a cleaning pass first.");
      const { result, artifact } = await runWorkflowPng({
        cmd: "restore-brush",
        path: assetPath(source),
        previous: assetPath(previous),
        strokes: restoreStrokes,
      });
      return json({
        doc: saveCleanPixels(episode.id, doc, artifact, result, "keep"),
      });
    }
    if (action === "raw-brush") {
      const rawStrokes = brushStrokes(b.strokes, "Paint with the raw brush");
      const source = pageArtwork(doc.data)!;
      const raw = pageRawArtwork(doc.data);
      if (!raw)
        throw new WorkflowError("Nothing to paint from the raw page. The working copy already is the source.");
      const { result, artifact } = await runWorkflowPng({
        cmd: "raw-brush",
        path: assetPath(source),
        raw: assetPath(raw),
        strokes: rawStrokes,
      });
      return json({
        doc: saveCleanPixels(episode.id, doc, artifact, result, "keep"),
      });
    }
    if (action === "page") {
      const data = { ...doc.data };
      if ("cleanApproved" in b.data)
        data.cleanApproved = !!b.data.cleanApproved;
      if ("maskApproved" in b.data) data.maskApproved = !!b.data.maskApproved;
      if ("dpi" in b.data) {
        if (
          !Number.isFinite(b.data.dpi) ||
          b.data.dpi < 10 ||
          b.data.dpi > 2400
        )
          throw new WorkflowError("Invalid DPI");
        data.dpi = b.data.dpi;
      }
      return json({
        doc: putDoc(
          episode.id,
          doc.id,
          data,
          doc.revision,
          b.history || "save",
        ),
      });
    }
    if (!["mask", "geometry", "clean"].includes(action))
      throw new WorkflowError("Unknown workflow action");
    if (action === "clean" && (!doc.data.maskApproved || !doc.data.mask))
      throw new WorkflowError("Review and approve a removal mask first");
    if (
      b.expansion != null &&
      (!Number.isInteger(b.expansion) || b.expansion < 0 || b.expansion > 20)
    )
      throw new WorkflowError("Mask expansion must be 0–20 pixels");
    const strokes = (b.strokes ?? []).map((s: any) => {
      if (!Number.isFinite(s.radius) || s.radius < 1 || s.radius > 200)
        throw new WorkflowError("Invalid brush size");
      return { points: points(s.points), radius: s.radius, erase: !!s.erase };
    });
    if (strokes.length > 1000) throw new WorkflowError("Too many mask strokes");
    if (action === "mask" && b.grow) {
      if (b.detect)
        throw new WorkflowError("Grow applies to the current mask, not a new detection");
      if (!doc.data.mask && !strokes.length)
        throw new WorkflowError("Paint or detect a mask first");
      const growPx = b.grow === true ? 1 : Number(b.grow);
      if (!Number.isInteger(growPx) || growPx < MASK_GROW_MIN || growPx > MASK_GROW_MAX)
        throw new WorkflowError(`Grow amount must be ${MASK_GROW_MIN}–${MASK_GROW_MAX} pixels`);
      const { px, py } = clickPoint(b);
      const { artifact } = await runWorkflowPng({
        cmd: "mask",
        path: assetPath(doc.data.cleanBase || doc.data.prepared!),
        mask: doc.data.mask ? assetPath(doc.data.mask) : undefined,
        strokes,
        grow: growPx,
        px,
        py,
      });
      return json({
        doc: putDoc(
          episode.id,
          doc.id,
          {
            ...doc.data,
            mask: artifact,
            maskApproved: true,
            cleanApproved: false,
            cleaned: undefined,
          },
          doc.revision,
        ),
      });
    }
    const detectingMask = action === "mask" && !!b.detect;
    if (detectingMask && b.maskEngine != null) {
      const engine = String(b.maskEngine);
      if (!["auto", "ctd"].includes(engine) && !imageWorkflowModel(engine))
        throw new WorkflowError("Invalid mask engine");
    }
    const readMaskInputs = async () => maskInputs(
      (await listLines(episode.id)).filter(line => line.imageId === img.id),
      id => getDoc<RegionData>(`region:${id}`, {}),
    );
    const maskInput = detectingMask ? await readMaskInputs() : undefined;
    const maskRegions = maskInput?.map(row => row.polygon);
    if (detectingMask && !maskRegions?.length)
      throw new WorkflowError("Define a region before detecting a removal mask");
    let region = null;
    let line = null;
    let neighbors: number[][] = [];
    if (action === "geometry") {
      line = (await listLines(episode.id)).find(
        (l) => l.id === b.lineId && l.imageId === img.id,
      );
      if (!line) throw new WorkflowError("Select a region");
      neighbors = (await listLines(episode.id)).filter((other) => other.imageId === img.id && other.id !== line!.id).flatMap((other) => other.x != null && other.y != null && other.w != null && other.h != null ? [[other.x, other.y, other.w, other.h]] : []);
      region = getDoc<RegionData>(`region:${line.id}`, {});
    }
    const method = String(
      b.method || (action === "geometry" ? "opencv" : "auto"),
    );
    if (
      ![
        "auto",
        "flat",
        "lama",
        "big-lama",
        "aot",
        "telea",
        "clone",
        "codex",
        ...IMAGE_EDIT_MODELS.map((model) => model.method),
        "opencv",
        "sam",
      ].includes(method) && !imageWorkflowModel(method)
    )
      throw new WorkflowError("Invalid method");
    const imageModel = imageWorkflowModel(method);
    const imageTask = imageModel && rowHasOperation(imageModel, 'inpaint') ? 'inpaint' : 'cleaning';
    if (action === 'clean' && imageModel && imageModel.implementedTasks && !imageModel.implementedTasks.includes(imageTask))
      throw new WorkflowError(`${imageModel.name} does not implement ${imageTask}`);
    const cleanPrompt = action === 'clean' && imageModel ? normalizeImageEditPrompt(b.prompt) : undefined;
    const jobId = createJob(episode.id, action, {
      imageId: img.id,
      revision: doc.revision,
      method,
      request: { ...b, strokes, ...(cleanPrompt ? { prompt: cleanPrompt } : {}) },
      prepared: doc.data.prepared,
    });
    const abort = new AbortController();
    aborts.set(jobId, abort);
    const status = workflowRunStatus(
      action,
      method,
      detectingMask,
      detectingMask ? String(b.maskEngine || "auto") : undefined,
    );
    updateJob(jobId, "running", {
      message: `${status.step} · ${status.model}`,
      step: status.step,
      engine: status.engine,
      model: status.model,
    });
    appendJobLog(jobId, {
      step: status.step,
      engine: status.engine,
      model: status.model,
      request: `${status.step} · ${status.model}`,
    });
    void (async () => {
      const output = join(DATA_DIR, "workflow", `${randomUUID()}.png`);
      try {
        await mkdir(join(DATA_DIR, "workflow"), { recursive: true });
        const reconstruction = () => ({
          path: assetPath(doc.data.cleanBase || doc.data.prepared!),
          mask: assetPath(doc.data.mask!),
          out: output,
          prompt: cleanPrompt,
        });
        const cleanStarted = Date.now();
        const result: Record<string, any> = action === 'clean' && imageModel
          ? await runWithJob({ jobId, imageId: img.id, step: 'clean', engine: imageModel.id },
              () => runImageTaskFiles(imageModel, imageTask, reconstruction(), abort.signal))
          : await localOperation(
          {
            cmd: action,
            path: assetPath(
              action === "geometry"
                ? doc.data.prepared!
                : doc.data.cleanBase || doc.data.prepared!,
            ),
            out: output,
            mask: doc.data.mask ? assetPath(doc.data.mask) : undefined,
            strokes: action === "mask" ? strokes : [],
            expansion: action === "mask" && b.detect ? (b.expansion ?? 5) : 0,
            detect: action === "mask" && !!b.detect,
            maskEngine:
              action === "mask" && b.detect
                ? String(b.maskEngine || "auto")
                : undefined,
            regions: maskRegions,
            method,
            points: action === "geometry" && method === "sam"
              ? points(Array.isArray(b.points) && b.points.length ? b.points : bubbleFitPoints(line!))
              : b.points ? points(b.points) : undefined,
            box: line ? [line.x, line.y, line.w, line.h] : undefined,
            neighbors,
            kind: method === "sam" ? undefined : region?.data.detectionKind,
            offset: b.offset,
            device: b.device,
          },
          abort.signal,
        );
        const cleanDurationMs = Date.now() - cleanStarted;
        if (abort.signal.aborted) throw new Error("Cancelled");
        const latest = (await listImages(episode.id)).find(
          (p) => p.id === img.id,
        );
        if (latest?.updatedAt !== img.updatedAt)
          throw new WorkflowError(
            "Prepared source changed; rerun on the current page",
            409,
          );
        if (action === "geometry") {
          const polygon = automaticRegionPolygon(line!, result.polygon);
          const saved = putDoc(
            episode.id,
            region!.id,
            {
              ...region!.data,
              polygon,
              geometryConfidence: polygon === result.polygon ? result.confidence : 0,
              geometryApproved: false,
            },
            region!.revision,
          );
          try {
            if (!saved.data.locked)
              await fitRegion(series, episode, line!.id, saved.revision);
          } catch {
            /* Geometry is kept; missing fonts or empty text skip the refit. */
          }
        } else {
          const artifact = await storeAsset(await readFile(output));
          if (detectingMask && JSON.stringify(await readMaskInputs()) !== JSON.stringify(maskInput))
            throw new WorkflowError("Regions changed; rerun mask detection on the current regions", 409);
          const data =
            action === "mask"
              ? {
                  ...doc.data,
                  mask: artifact,
                  maskDiagnostics: detectingMask ? {
                    mask: artifact,
                    source: doc.data.cleanBase || doc.data.prepared!,
                    regions: JSON.stringify(maskInput),
                    version: String(result.maskVersion || "unknown"),
                    engine: String(result.maskEngine || "unknown"),
                    backend: String(result.backend || "unknown"),
                    entries: (result.maskDiagnostics || []).map((entry: { region: number; pixels: number; reasons: string[] }) => ({
                      ...entry, lineId: maskInput?.[entry.region]?.id, regionNumber: maskInput?.[entry.region]?.number,
                    })),
                  } : undefined,
                  // Committing manual edits is the user's approval of this mask.
                  // Automatic detection still produces a proposal to inspect.
                  maskApproved: !b.detect,
                  cleanApproved: false,
                  cleaned: undefined,
                }
              : withPreviousArtwork(doc.id, doc.data, {
                  ...doc.data,
                  cleaned: artifact,
                  cleanMethod: result.method || method,
                  cleanDurationMs,
                  backend: result.backend,
                  cleanApproved: false,
                }, "replace");
          putDoc(episode.id, doc.id, data, doc.revision);
        }
        pageResult(jobId, img.id, "completed");
        const finishedModel = action === "mask" && detectingMask
          ? maskModelName(String(result.maskEngine || status.engine))
          : status.model;
        const finished = action === "mask"
          ? (detectingMask ? "Lettering mask ready" : "Lettering mask saved")
          : action === "geometry" ? "Region geometry ready" : "Artwork cleaned";
        updateJob(jobId, "completed", {
          ...result,
          message: `${finished} · ${finishedModel}`,
          engine: String(result.maskEngine || result.method || status.engine),
          model: finishedModel,
          step: status.step,
        });
      } catch (e) {
        pageResult(jobId, img.id, "failed", messageOf(e));
        updateJob(
          jobId,
          abort.signal.aborted ? "cancelled" : "failed",
          {
            message: abort.signal.aborted ? "Cancelled" : messageOf(e),
            step: status.step,
            model: status.model,
            engine: status.engine,
          },
          messageOf(e),
        );
      } finally {
        aborts.delete(jobId);
        await unlink(output).catch(() => {});
      }
    })();
    return json({ jobId }, { status: 202 });
  } catch (e) {
    return fail(
      statusOf(e),
      messageOf(e),
      e instanceof WorkflowError ? { current: e.current } : undefined,
    );
  }
};
