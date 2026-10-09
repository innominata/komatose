import sharp from 'sharp';
import type { Episode, Series } from '../types';
import type { TaskEngine } from '../aiTasks';
import { isProofreaderId, proofreaderLabel, type ProofreaderId } from '../proofreaders';
import {
  proofreadAttach,
  unwrapProofreadCritique,
  type ProofreadCursor,
  type PageProofreadSnapshot,
} from '../pageProofread';
import { regionAiSettings } from '../regionAi';
import { preferences } from './workflowService';
import { advisoryModel, validateModel } from './regionAi';
import { proofreaderStatus } from './proofreadService';
import { proofreadWithService } from './proofreadService';
import { capturePageImages } from './pageImages';
import { createJob, updateJob, runWithJob, listJobs } from './jobs';
import { readAsset, storeAsset, WorkflowError } from './workflowStore';
import { loadChapterPack, formatChapterScript } from './proofread';

export const PAGE_PROOFREAD_SYSTEM = `You are a Japanese/Korean scanlation proofreader and lettering editor. Compare two images of the SAME page: image 1 is the raw source lettering; image 2 is the current English typeset version. Critique translation accuracy, missing or invented meaning, omitted text/SFX, speaker/reading order, character voice, English grammar and punctuation, and visible typesetting problems (fit, clipping, line breaks, font choice, contrast, placement, cleaning remnants). Identify issues by panel/bubble position and quote the relevant text when legible. Distinguish clear errors from uncertain readings and stylistic preferences. Give practical corrections and priorities. Do not claim unreadable details as facts. The editor will make changes manually; do not edit files or use tools. Return JSON with one critique string, using readable paragraphs and bullets.`;
export const PAGE_PROOFREAD_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['critique'],
  properties: { critique: { type: 'string' } },
};
export const PAGE_PROOFREAD_FOLLOWUP_SYSTEM = `You are a Japanese/Korean scanlation proofreader and lettering editor continuing a conversation about the same page. The editor is asking a follow-up. Answer the follow-up directly. Quote the relevant lettering when you refer to it. Do not edit files or use tools. Return JSON with one critique string, using readable paragraphs and bullets.`;

const runtime = globalThis as typeof globalThis & {
  __scanPageProofreads?: Map<string, AbortController>;
  __scanProofreadCursor?: ProofreadCursor;
  __scanProofreadCursors?: Partial<Record<ProofreaderId, ProofreadCursor>>;
};
const active = runtime.__scanPageProofreads ??= new Map();
const cursors = runtime.__scanProofreadCursors ??= {};

export function cancelPageProofread(jobId: string) { active.get(jobId)?.abort(); }

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
}) {
  return proofreadWithService({
    proofreader: opts.proofreader,
    images: opts.images,
    prompt: opts.prompt,
    followUp: opts.followUp,
    abort: opts.signal,
  });
}

export function startPageProofread(opts: { series: Series; episode: Episode; imageId: string;
  model?: TaskEngine; snapshot?: PageProofreadSnapshot }) {
  const model = validateModel(opts.model ?? regionAiSettings(preferences(opts.episode.id, opts.series.id).regionAi).proofread);
  if (!opts.imageId) throw new WorkflowError('Select a page');
  if (runningProofread(opts.episode.id, opts.imageId))
    throw new WorkflowError('This page is already being proofread. Open its job to view progress.', 409);
  const { id, abort, signal } = beginJob(opts.episode.id, { imageId: opts.imageId, ...model });
  updateJob(id, 'running', { message: 'Capturing raw and typeset images…' });
  void runWithJob({ jobId: id, imageId: opts.imageId, step: 'page-proofread', ...model }, async () => {
    try {
      let snapshot = opts.snapshot;
      if (!snapshot) {
        const capture = await capturePageImages(opts.series, opts.episode, opts.imageId);
        signal.throwIfAborted();
        const [raw, typeset] = await Promise.all([storeAsset(capture.raw), storeAsset(capture.typeset!)]);
        snapshot = { raw, typeset, capturedAt: capture.capturedAt, imageId: opts.imageId,
          pageLabel: `Page ${capture.page.image.pageNumber ?? capture.page.image.sortOrder + 1}` };
      }
      const images = await jpegBuffers([snapshot.raw, snapshot.typeset]);
      signal.throwIfAborted();
      const site = isProofreaderId(model.engine) ? model.engine : null;
      const conversation = site
        ? (await proofreaderStatus(site)).context
        : '';
      const attach = site
        ? proofreadAttach(opts.imageId, conversation, proofreaderCursor(site))
        : 'both';
      const followUp = attach === 'typeset';
      updateJob(id, 'running', { snapshot, followUp, message: site
        ? followUp
          ? `Sending updated typeset as a ${proofreaderLabel(site)} follow-up…`
          : `Waiting on ${proofreaderLabel(site)}…`
        : 'Proofreader is comparing both images…' });
      const pack = await loadChapterPack({ seriesId: opts.series.id, episodeId: opts.episode.id });
      const pageScript = formatChapterScript(pack.items.filter((_, i) => pack.targets[i].imageId === opts.imageId));
      const apiPrompt = `${snapshot.pageLabel}. ${followUp ? 'The attached image is the updated WORKING TYPESET English; compare with the earlier RAW source in this conversation.' : 'Image 1: RAW source. Image 2: WORKING TYPESET English.'} Critique this captured version.\n\nCanonical series names and terms:\n${pack.seriesGlossary}\n\nSaved page script with human-assigned speakers (speaker is not necessarily the person addressed):\n${pageScript}`;
      const result = (site
        ? await runServiceProofread({
            proofreader: site,
            images: followUp ? [images[1]] : images,
            followUp,
            prompt: `${PAGE_PROOFREAD_SYSTEM}\n\n${apiPrompt}`,
            signal,
          })
        : await advisoryModel(model, PAGE_PROOFREAD_SYSTEM, apiPrompt, images, signal, PAGE_PROOFREAD_SCHEMA)
      ) as { critique?: unknown };
      signal.throwIfAborted();
      const critique = unwrapProofreadCritique(String(result?.critique || ''));
      if (!critique) throw new WorkflowError('The proofreader returned no critique. Retry from Jobs.');
      if (site) rememberProofread(site, opts.imageId, conversation);
      updateJob(id, 'completed', { critique, message: 'Critique saved · open it again from Jobs' });
    } catch (error) {
      updateJob(id, abort.signal.aborted ? 'cancelled' : 'failed', { message: abort.signal.aborted ? 'Cancelled' : 'Proofreading failed' },
        error instanceof Error ? error.message : String(error));
    } finally { active.delete(id); }
  });
  return { jobId: id };
}


export function startPageProofreadFollowUp(opts: {
  series: Series;
  episode: Episode;
  parentJobId: string;
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
    imageId, ...model, followUpOf: opts.parentJobId, prompt,
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
      updateJob(id, 'running', { message: site
        ? `Waiting on ${proofreaderLabel(site)}…`
        : 'Proofreader is answering the follow-up…' });
      const result = (site
        ? await runServiceProofread({
            proofreader: site,
            images: pastedJpeg,
            prompt: prompt || undefined,
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
              ...(parentSnapshot ? await jpegBuffers([parentSnapshot.raw, parentSnapshot.typeset]) : []),
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
