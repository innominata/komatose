import sharp from 'sharp';
import type { Episode, OcrLang, Series } from '../types';
import type { TaskEngine } from '../aiTasks';
import { isProofreaderId, proofreaderLabel, type ProofreaderId } from '../proofreaders';
import {
  proofreadAttach,
  unwrapProofreadCritique,
  type ProofreadCursor,
  type PageProofreadSnapshot,
} from '../pageProofread';
import { regionAiSettings } from '../regionAi';
import { rowHasOperation } from '../modelRegistry';
import { resolveLiveAssistant } from './assistantRoute';
import { preferences } from './workflowService';
import { advisoryModel, validateModel } from './regionAi';
import { proofreaderStatus } from './proofreadService';
import { proofreadWithService } from './proofreadService';
import { capturePageImages } from './pageImages';
import { createJob, updateJob, runWithJob, listJobs, pageResult } from './jobs';
import { directorAsset, directorContext, directorEvent } from './directorAudit';
import { readAsset, storeAsset, WorkflowError, getDoc } from './workflowStore';
import { loadChapterPack, formatChapterScript } from './proofread';
import { listImages, listLines, listComments } from './queries';
import { pageStepStamp, type PageData, type RegionData } from '../workflow';

export const PAGE_PROOFREAD_SYSTEM = `You are a Japanese/Korean scanlation proofreader and lettering editor. Compare two images of the SAME page: image 1 is the raw source lettering; image 2 is the current English typeset version. Critique translation accuracy, missing or invented meaning, omitted text/SFX, speaker/reading order, character voice, English grammar and punctuation, and visible typesetting problems (fit, clipping, line breaks, font choice, contrast, placement, cleaning remnants). Identify issues by panel/bubble position and quote the relevant text when legible. Distinguish clear errors from uncertain readings and stylistic preferences. Give practical corrections and priorities. Do not claim unreadable details as facts. The editor will make changes manually; do not edit files or use tools. Return JSON with one critique string, using readable paragraphs and bullets.`;
export const PAGE_PROOFREAD_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['critique'],
  properties: { critique: { type: 'string' } },
};
export const PAGE_PROOFREAD_FOLLOWUP_SYSTEM = `You are a Japanese/Korean scanlation proofreader and lettering editor continuing a conversation about the same page. The editor is asking a follow-up. Answer the follow-up directly. Quote the relevant lettering when you refer to it. Do not edit files or use tools. Return JSON with one critique string, using readable paragraphs and bullets.`;
export function rawProofreadSystem(lang: OcrLang): string {
  const language = lang === 'korean' ? 'Korean' : 'Japanese';
  return `You are a ${language} scanlation proofreader. Read the raw page image and give BOTH the exact original ${language} source and your complete recommended English translation for EVERY bubble, caption, sign, sound effect, ellipsis and punctuation region, in reading order. Include supplied region IDs when available and describe their positions. Do not omit silent bubbles or stylized sound effects. Note uncertain readings and speakers when clear. Refer to panel and bubble positions. Do not claim unreadable details as facts. The editor will use your reply manually. Return JSON with one critique string, using readable paragraphs and bullets.`;
}

const runtime = globalThis as typeof globalThis & {
  __scanPageProofreads?: Map<string, AbortController>;
  __scanProofreadCursor?: ProofreadCursor;
  __scanProofreadCursors?: Partial<Record<ProofreaderId, ProofreadCursor>>;
};
const active = runtime.__scanPageProofreads ??= new Map();
const cursors = runtime.__scanProofreadCursors ??= {};
const activeBatches = new Map<string, { abort: AbortController; childId?: string }>();

export function cancelPageProofread(jobId: string) { active.get(jobId)?.abort(); }
export function cancelChapterRawProofread(jobId: string) {
  const batch = activeBatches.get(jobId);
  batch?.abort.abort();
  if (batch?.childId) cancelPageProofread(batch.childId);
}

export function proofreadCursor() {
  return runtime.__scanProofreadCursor ?? cursors['proofreader-a'];
}

export function proofreaderCursor(engine: string) {
  return isProofreaderId(engine) ? cursors[engine] : undefined;
}

export function rememberProofread(engine: ProofreaderId, imageId: string, conversation = "") {
  const cursor = { imageId, conversation };
  cursors[engine] = cursor;
  if (engine === 'proofreader-a') runtime.__scanProofreadCursor = cursor;
}

export function resetProofreadCursor() {
  runtime.__scanProofreadCursor = undefined;
  delete cursors['proofreader-a'];
}

export function resetProofreadCursorFor(engine?: ProofreaderId) {
  if (!engine) {
    runtime.__scanProofreadCursor = undefined;
    for (const key of Object.keys(cursors) as ProofreaderId[]) delete cursors[key];
    return;
  }
  delete cursors[engine];
  if (engine === 'proofreader-a') runtime.__scanProofreadCursor = undefined;
}

function runningProofread(episodeId: string, imageId: string) {
  return listJobs(episodeId).some(j => j.kind === 'page-proofread' && j.payload.imageId === imageId &&
    ['running', 'queued', 'cancelling'].includes(j.state));
}

async function pageProofreadApiPrompt(seriesId: string, episodeId: string, imageId: string, pageLabel: string, mode: 'raw' | 'critique' = 'critique') {
  if (mode === 'raw') {
    const regions=(await listLines(episodeId)).filter(line=>line.imageId===imageId && line.sourceState!=='ignored').map(line=>({id:line.id,box:[line.x,line.y,line.w,line.h]}));
    return `${pageLabel}. Image 1: RAW source. Give the exact original-language source AND a complete recommended English translation for every text region, including SFX, ellipses and punctuation. Use these IDs and normalized page boxes where they match; also identify any lettering outside them. Read the image, not an old draft.\nRegions: ${JSON.stringify(regions)}`;
  }
  const pack = await loadChapterPack({ seriesId, episodeId });
  const pageScript = formatChapterScript(pack.items.filter((_, i) => pack.targets[i].imageId === imageId));
  return `${pageLabel}. Image 1: RAW source. Image 2: WORKING TYPESET English. Critique this captured version.\n\nCanonical series names and terms:\n${pack.seriesGlossary}\n\nSaved page script with human-assigned speakers (speaker is not necessarily the person addressed):\n${pageScript}`;
}

async function jpegBuffers(hashes: string[]) {
  return Promise.all(hashes.map(async hash =>
    sharp(await readAsset(hash)).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer()));
}

async function storeJpegs(buffers: Buffer[]) {
  return Promise.all(buffers.map(async bytes =>
    storeAsset(await sharp(bytes).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer())));
}

function beginJob(episodeId: string, payload: Record<string, unknown>) {
  const id = createJob(episodeId, 'page-proofread', payload);
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15 * 60_000)]);
  active.set(id, abort);
  return { id, abort, signal };
}

async function runServiceProofread(opts: {
  proofreader: ProofreaderId;
  images: Buffer[];
  prompt?: string;
  followUp?: boolean;
  signal: AbortSignal;
  mode?: 'raw' | 'critique';
}) {
  return proofreadWithService({
    proofreader: opts.proofreader,
    mode: opts.mode ?? 'critique',
    images: opts.images,
    prompt: opts.prompt,
    followUp: opts.followUp,
    abort: opts.signal,
  });
}

export function runPageProofread(opts: { series: Series; episode: Episode; imageId: string;
  model?: TaskEngine; snapshot?: PageProofreadSnapshot; mode?: 'raw' | 'critique' }) {
  const model = validateModel(opts.model ?? regionAiSettings(preferences(opts.episode.id, opts.series.id).regionAi).proofread);
  const mode = opts.mode === 'raw' ? 'raw' : 'critique';
  if (mode === 'raw' && !isProofreaderId(model.engine)) {
    const row = resolveLiveAssistant(model.engine, model.model).row;
    if (!rowHasOperation(row, 'vision') || !rowHasOperation(row, 'proofreadEnglish'))
      throw new WorkflowError('Proofread Raw needs a vision model that can proofread English.');
  }
  if (!opts.imageId) throw new WorkflowError('Select a page');
  if (runningProofread(opts.episode.id, opts.imageId))
    throw new WorkflowError('This page is already being proofread. Open its job to view progress.', 409);
  const { id, abort, signal } = beginJob(opts.episode.id, { imageId: opts.imageId, ...model, mode });
  updateJob(id, 'running', { message: mode === 'raw' ? 'Capturing raw image…' : 'Capturing raw and typeset images…' });
  const completion = runWithJob({ jobId: id, imageId: opts.imageId, step: 'page-proofread', ...model }, async () => {
    try {
      let snapshot = opts.snapshot;
      if (!snapshot) {
        const capture = await capturePageImages(opts.series, opts.episode, opts.imageId, mode !== 'raw');
        signal.throwIfAborted();
        const [raw, typeset] = await Promise.all([storeAsset(capture.raw), capture.typeset ? storeAsset(capture.typeset) : undefined]);
        snapshot = { raw, typeset, capturedAt: capture.capturedAt, imageId: opts.imageId,
          script:capture.page.regions.filter(r=>r.line.sourceState!=='ignored'&&r.data.renderEnabled!==false).map(r=>({id:r.line.id,source:r.line.source||'',english:r.line.body})),
          pageLabel: `Page ${capture.page.image.pageNumber ?? capture.page.image.sortOrder + 1}` };
      }
      const images = await jpegBuffers(mode === 'raw' ? [snapshot.raw] : [snapshot.raw, snapshot.typeset!]);
      const director = directorContext();
      signal.throwIfAborted();
      const site = isProofreaderId(model.engine) ? model.engine : null;
      const conversation = site
        ? (await proofreaderStatus(site)).context
        : '';
      const attach = site && mode === 'critique'
        ? proofreadAttach(opts.imageId, conversation, proofreaderCursor(site))
        : 'both';
      const followUp = mode === 'critique' && attach === 'typeset';
      if (director) {
        const sent = await Promise.all((followUp ? [images[1]] : images).map(storeAsset));
        for (const hash of sent) directorAsset(director.runId, hash);
        for (const hash of [snapshot.raw, ...(mode === 'raw' ? [] : [snapshot.typeset!])]) directorAsset(director.runId, hash);
        directorEvent(director.runId, director.episodeId, opts.imageId, 'proofreader:images', {
          mode, raw: snapshot.raw, typeset: mode === 'raw' ? undefined : snapshot.typeset,
          sent, capturedAt: snapshot.capturedAt, followUp,
        });
      }
      updateJob(id, 'running', { snapshot, followUp, message: site
        ? followUp
          ? `Sending updated typeset as a ${proofreaderLabel(site)} follow-up…`
          : `Waiting on ${proofreaderLabel(site)}…`
        : mode === 'raw' ? 'Proofreader is reading the raw image…' : 'Proofreader is comparing both images…' });
      // Raw reading includes region IDs so the answer can be applied directly.
      // Rendered critique keeps the proofreading service's usual image workflow.
      const result = (site
        ? await runServiceProofread({
            proofreader: site,
            images: followUp ? [images[1]] : images,
            followUp,
            mode,
            ...(mode==='raw' ? {prompt:await pageProofreadApiPrompt(opts.series.id,opts.episode.id,opts.imageId,snapshot.pageLabel,mode)} : {}),
            signal,
          })
        : await advisoryModel(model, mode === 'raw'
            ? rawProofreadSystem(preferences(opts.episode.id, opts.series.id).lang)
            : PAGE_PROOFREAD_SYSTEM,
            await pageProofreadApiPrompt(opts.series.id, opts.episode.id, opts.imageId, snapshot.pageLabel, mode), images, signal, PAGE_PROOFREAD_SCHEMA)
      ) as { critique?: unknown };
      signal.throwIfAborted();
      const critique = unwrapProofreadCritique(String(result?.critique || ''));
      if (!critique) throw new WorkflowError('The proofreader returned no critique. Retry from Jobs.');
      if (site && mode === 'critique') rememberProofread(site, opts.imageId, conversation);
      updateJob(id, 'completed', { critique, message: 'Critique saved · open it again from Jobs' });
    } catch (error) {
      updateJob(id, abort.signal.aborted ? 'cancelled' : 'failed', { message: abort.signal.aborted ? 'Cancelled' : 'Proofreading failed' },
        error instanceof Error ? error.message : String(error));
    } finally { active.delete(id); }
  });
  return { jobId: id, completion };
}

export function startPageProofread(opts: Parameters<typeof runPageProofread>[0]) {
  return { jobId: runPageProofread(opts).jobId };
}

export async function chapterRawProofreadPages(episodeId: string): Promise<string[]> {
  const [images, lines, comments] = await Promise.all([
    listImages(episodeId), listLines(episodeId), listComments(episodeId),
  ]);
  return images.filter(image => {
    const pageLines = lines.filter(line => line.imageId === image.id);
    if (!pageLines.length) return false;
    const page = getDoc<PageData>(`page:${image.id}`, {}).data;
    const lineIds = new Set(pageLines.map(line => line.id));
    const regions = pageLines.map(line => ({ id: line.id, data: getDoc<RegionData>(`region:${line.id}`, {}).data }));
    return page.completed?.review !== pageStepStamp('review', page, pageLines,
      comments.filter(comment => lineIds.has(comment.lineId)), regions);
  }).map(image => image.id);
}

export async function startChapterRawProofread(opts: { series: Series; episode: Episode; model?: TaskEngine;
  imageIds?: string[]; completedIds?: string[] }) {
  const eligible = await chapterRawProofreadPages(opts.episode.id);
  const requested = opts.imageIds ? new Set(opts.imageIds) : null;
  const completed = new Set(opts.completedIds ?? []);
  const imageIds = eligible.filter(id => (!requested || requested.has(id)) && !completed.has(id));
  if (!imageIds.length) throw new WorkflowError('No unfinished Review pages with regions to proofread.', 400);
  const model = validateModel(opts.model ?? regionAiSettings(preferences(opts.episode.id, opts.series.id).regionAi).proofread);
  if (!isProofreaderId(model.engine)) {
    const row = resolveLiveAssistant(model.engine, model.model).row;
    if (!rowHasOperation(row, 'vision') || !rowHasOperation(row, 'proofreadEnglish'))
      throw new WorkflowError('Proofread Raw needs a vision model that can proofread English.');
  }
  if (listJobs(opts.episode.id).some(job => job.kind === 'page-proofread-batch' &&
    ['running', 'queued', 'cancelling'].includes(job.state)))
    throw new WorkflowError('A chapter Raw proofreading batch is already running.', 409);
  const jobId = createJob(opts.episode.id, 'page-proofread-batch', { imageIds, ...model, mode: 'raw' });
  const batch = { abort: new AbortController(), childId: undefined as string | undefined };
  activeBatches.set(jobId, batch);
  for (const imageId of imageIds) pageResult(jobId, imageId, 'queued');
  updateJob(jobId, 'running', { completed: 0, total: imageIds.length, message: 'Waiting to proofread first page…' });
  void runWithJob({ jobId, step: 'page-proofread-batch', ...model }, async () => {
    let done = 0;
    let currentImageId = '';
    try {
      for (const imageId of imageIds) {
        if (batch.abort.signal.aborted) break;
        currentImageId = imageId;
        pageResult(jobId, imageId, 'running');
        updateJob(jobId, 'running', { completed: done, total: imageIds.length,
          message: `Waiting for page ${done + 1} of ${imageIds.length}…` });
        const child = runPageProofread({ series: opts.series, episode: opts.episode, imageId, model, mode: 'raw' });
        batch.childId = child.jobId;
        await child.completion;
        batch.childId = undefined;
        const result = listJobs(opts.episode.id).find(job => job.id === child.jobId);
        if (result?.state !== 'completed') {
          pageResult(jobId, imageId, result?.state || 'failed', result?.error || null);
          if (batch.abort.signal.aborted) break;
          throw new WorkflowError(result?.error || 'Page proofreading failed. Retry unfinished work from Jobs.');
        }
        pageResult(jobId, imageId, 'completed');
        currentImageId = '';
        done++;
        updateJob(jobId, 'running', { completed: done, total: imageIds.length,
          message: `${done} of ${imageIds.length} replies saved` });
      }
      updateJob(jobId, batch.abort.signal.aborted ? 'cancelled' : 'completed', {
        completed: done, total: imageIds.length,
        message: `${done} of ${imageIds.length} replies saved`,
      });
    } catch (error) {
      if (currentImageId) pageResult(jobId, currentImageId,
        batch.abort.signal.aborted ? 'cancelled' : 'failed', error instanceof Error ? error.message : String(error));
      updateJob(jobId, batch.abort.signal.aborted ? 'cancelled' : 'failed', {
        completed: done, total: imageIds.length,
        message: `${done} of ${imageIds.length} replies saved`,
      }, error instanceof Error ? error.message : String(error));
    } finally { activeBatches.delete(jobId); }
  });
  return { jobId, total: imageIds.length };
}


export function startPageProofreadFollowUp(opts: {
  series: Series;
  episode: Episode;
  parentJobId: string;
  includeParentContext?: boolean;
  prompt: string;
  images?: Buffer[];
}) {
  const parent = listJobs(opts.episode.id).find((job) => job.id === opts.parentJobId);
  if (!parent || parent.kind !== 'page-proofread') throw new WorkflowError('Critique not found', 404);
  const imageId = String(parent.payload?.imageId || '');
  if (!imageId) throw new WorkflowError('Select a page');
  const prompt = opts.prompt.trim();
  const pasted = opts.images || [];
  if (!prompt && !pasted.length) throw new WorkflowError('Enter a follow-up or paste an image.');
  if (runningProofread(opts.episode.id, imageId))
    throw new WorkflowError('This page is already being proofread. Open its job to view progress.', 409);
  const model = validateModel({
    engine: String(parent.payload?.engine || ''),
    model: String(parent.payload?.model || ''),
  });
  const parentSnapshot = parent.progress?.snapshot as PageProofreadSnapshot | undefined;
  const { id, abort, signal } = beginJob(opts.episode.id, {
    imageId, ...model, mode:parent.payload.mode==='raw'?'raw':'critique', followUpOf: opts.parentJobId, prompt,
  });
  updateJob(id, 'running', { prompt, message: 'Sending follow-up…' });
  void runWithJob({ jobId: id, imageId, step: 'page-proofread-followup', ...model }, async () => {
    try {
      const followUpHashes = await storeJpegs(pasted);
      const snapshot: PageProofreadSnapshot | undefined = parentSnapshot
        ? { ...parentSnapshot, followUpImages: followUpHashes, capturedAt: Date.now() }
        : followUpHashes.length
          ? { raw: followUpHashes[0], typeset: followUpHashes[0], capturedAt: Date.now(), imageId, pageLabel: 'Follow-up', followUpImages: followUpHashes }
          : undefined;
      if (snapshot) updateJob(id, 'running', { snapshot, prompt });
      const site = isProofreaderId(model.engine) ? model.engine : null;
      const pastedJpeg = await jpegBuffers(followUpHashes);
      const serviceImages=opts.includeParentContext && parentSnapshot
        ? [...await jpegBuffers([parentSnapshot.raw]),...pastedJpeg] : pastedJpeg;
      const servicePrompt=opts.includeParentContext
        ? `This question follows your Proofread Raw of the same page. Image 1 is that whole raw page; subsequent images are the requested regions.\n\nYour prior raw reading:\n${String(parent.progress.critique||'')}\n\n${prompt}` : prompt;
      const director=directorContext();
      if(director) {
        const sent=await Promise.all((site?serviceImages:[...(parentSnapshot ? await jpegBuffers([parentSnapshot.raw,...(parentSnapshot.typeset?[parentSnapshot.typeset]:[])]) : []),...pastedJpeg]).map(storeAsset));
        for(const hash of sent) directorAsset(director.runId,hash);
        directorEvent(director.runId,director.episodeId,imageId,'proofreader:images',{mode:'raw-follow-up',parentJobId:opts.parentJobId,sent});
      }
      updateJob(id, 'running', { message: site
        ? `Waiting on ${proofreaderLabel(site)}…`
        : 'Proofreader is answering the follow-up…' });
      const result = (site
        ? await runServiceProofread({
            proofreader: site,
            images: serviceImages,
            mode: parent.payload.mode==='raw'?'raw':'critique',
            prompt: servicePrompt || undefined,
            followUp: true,
            signal,
          })
        : await advisoryModel(
            model,
            PAGE_PROOFREAD_FOLLOWUP_SYSTEM,
            [
              parentSnapshot?.pageLabel ? `${parentSnapshot.pageLabel}.` : '',
              typeof parent.progress?.critique === 'string' && parent.progress.critique.trim()
                ? `Previous critique:\n${parent.progress.critique.trim()}`
                : '',
              `Editor follow-up:\n${prompt || '(see attached images)'}`,
            ].filter(Boolean).join('\n\n'),
            [
              ...(parentSnapshot ? await jpegBuffers([parentSnapshot.raw, ...(parentSnapshot.typeset ? [parentSnapshot.typeset] : [])]) : []),
              ...pastedJpeg,
            ],
            signal,
            PAGE_PROOFREAD_SCHEMA,
          )
      ) as { critique?: unknown };
      signal.throwIfAborted();
      const critique = unwrapProofreadCritique(String(result?.critique || ''));
      if (!critique) throw new WorkflowError('The proofreader returned no critique. Retry from Jobs.');
      updateJob(id, 'completed', { critique, prompt, message: 'Follow-up saved · open it again from Jobs' });
    } catch (error) {
      updateJob(id, abort.signal.aborted ? 'cancelled' : 'failed', { message: abort.signal.aborted ? 'Cancelled' : 'Follow-up failed' },
        error instanceof Error ? error.message : String(error));
    } finally { active.delete(id); }
  });
  return { jobId: id };
}
