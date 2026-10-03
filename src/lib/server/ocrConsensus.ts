import { compareOcrReadings, failedOcrConsensus, ocrComparableKey, type OcrConsensus, type OcrReading } from '../ocrConsensus';
import { classifyRegionLineType, sfxClassificationSource, type RegionTypeHints } from '../sfx';
import { collapseSuggestions } from '../regionAi';
import { normalizeTranslation } from '../translationText';
import { DEFAULT_TRANSCRIPTION_MODEL_IDS, resolveAssistant, visionEligible } from '../modelRegistry';
import type { LineRow, OcrLang } from '../types';
import { sqlite } from './db';
import { broadcast } from './realtime';
import { toLine } from './queries';
import { db } from './db';
import { lines } from './db/schema';
import { eq } from 'drizzle-orm';
import { installedLocalReviewModels, imageMessage, localChat, localTranscription, withLocalReview } from './localReview';
import { qwen3VlReviewId } from '../qwenModels';
import { ocrSourceAttribution, ocrTranslatorLabel, translateOcrSource } from './ocrReview';
import { getDoc, suggest, WorkflowError } from './workflowStore';
import { resolveLiveAssistant } from './assistantRoute';
import { isOcrSpecialist } from '../modelRegistry';
import { runVisionRead, type VisionReadHandlers } from './visionRead';
import { readBubbleWithCli } from './cliTranslate';
import { extractJsonObject, parseReadPayload, readBubble, readBubbleCopy, READ_SCHEMA } from './llm';
import { listRegistryRows } from './modelRegistryStore';

const OCR_CONCURRENCY = 3;
/** One model reading one region. A hung remote call must not hold the chapter. */
export const TRANSCRIPTION_READ_MS = 30_000;

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

export type TranscriptionReader = (
  id: string,
  crop: Buffer,
  abort: AbortSignal,
  lang?: OcrLang,
) => Promise<string>;

function selectableTranscriptionId(id: string, rows = listRegistryRows()) {
  try {
    return visionEligible(resolveAssistant(id, '', rows).row);
  } catch {
    return false;
  }
}

/** Saved ids that are still enabled and allowed to read text. Disabled or deleted models are omitted. */
export function transcriptionModelIds(value?: string[] | null): string[] {
  const ids = Array.isArray(value) && value.length ? value : [...DEFAULT_TRANSCRIPTION_MODEL_IDS];
  const unique = [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))];
  const rows = listRegistryRows();
  const live = unique.filter((id) => selectableTranscriptionId(id, rows));
  return live.length ? live : unique;
}

export function assertOcrConsensusInstalled(modelIds?: string[]) {
  const ids = transcriptionModelIds(modelIds);
  if (!ids.length) throw new WorkflowError('Choose at least one transcription model in AI model settings.', 400);
  const rows = listRegistryRows();
  const missing = ids.filter(id => {
    try {
      const row = resolveAssistant(id, '', rows).row;
      return row.disabled || (row.implementedTasks != null && !row.implementedTasks.includes('vision'));
    }
    catch { return true; }
  });
  if (missing.length === ids.length)
    throw new WorkflowError(`Transcription models are not available: ${missing.join(', ')}`, 503);
}

function labelFor(id: string) {
  try {
    return resolveAssistant(id, '', listRegistryRows()).row.name;
  } catch {
    return id;
  }
}

export function ocrSuggestionReason(reading: OcrReading, translatorLabel: string) {
  const label = labelFor(reading.model);
  if (reading.error) return `${label}: ${reading.error}`;
  if (!reading.source) return label;
  return ocrSourceAttribution(label, reading.translation ? translatorLabel : '');
}

export async function defaultTranscriptionRead(
  id: string,
  crop: Buffer,
  abort: AbortSignal,
  lang?: OcrLang,
): Promise<string> {
  const resolved = resolveLiveAssistant(id);
  const read = await runVisionRead(resolved.row.id, {
    jpeg: crop,
    lang,
    model: resolved.slug,
    abort,
  }, visionReadHandlers);
  return read.source.trim();
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...await Promise.all(items.slice(i, i + limit).map(fn)));
  }
  return out;
}

export async function readOcrConsensus(crop: Buffer, abort: AbortSignal,
  read: TranscriptionReader = defaultTranscriptionRead,
  translate: (source: string, abort: AbortSignal, lang?: OcrLang) => Promise<string>
    = (source, signal, lang) => translateOcrSource(source, signal, { lang }),
  lang?: OcrLang,
  modelIds?: string[],
  hooks?: { onTranslate?: () => void }): Promise<OcrConsensus> {
  const ids = transcriptionModelIds(modelIds);
  const run = async (signal: AbortSignal) => {
    const readings: OcrReading[] = await mapPool(ids, OCR_CONCURRENCY, async (id) => {
      signal.throwIfAborted();
      const timeout = AbortSignal.timeout(TRANSCRIPTION_READ_MS);
      const readSignal = AbortSignal.any([signal, timeout]);
      try { return { model: id, source: (await read(id, crop, readSignal, lang)).trim() }; }
      catch (error) {
        signal.throwIfAborted();
        const message = timeout.aborted
          ? `Timed out after ${Math.round(TRANSCRIPTION_READ_MS / 1000)}s`
          : (error instanceof Error ? error.message : String(error));
        return { model: id, source: '', error: message };
      }
    });
    const result = compareOcrReadings(readings);
    const translations = new Map<string, string>();
    let announced = false;
    for (const reading of result.readings) {
      if (!reading.source || reading.error) continue;
      signal.throwIfAborted();
      if (!announced) {
        announced = true;
        hooks?.onTranslate?.();
      }
      try {
        if (!translations.has(reading.source)) translations.set(reading.source, await translate(reading.source, signal, lang));
        reading.translation = translations.get(reading.source);
      } catch (error) {
        signal.throwIfAborted();
        if (!result.agreed) throw error;
        reading.translation = '';
      }
    }
    return result;
  };
  return run(abort);
}

function lettered(source: string) {
  return /[\p{L}\p{N}]/u.test(ocrComparableKey(source));
}

export function winnerEnglish(result: OcrConsensus): string {
  if (!result.source.trim()) return '';
  const exact = result.readings.find((reading) => reading.source.trim() === result.source.trim() && reading.translation?.trim());
  if (exact?.translation) return exact.translation.trim();
  const key = ocrComparableKey(result.source);
  return result.readings.find((reading) => !reading.error && ocrComparableKey(reading.source) === key && reading.translation?.trim())?.translation?.trim() ?? '';
}

/** Dissenters when the plurality was saved; every reading when it was not. */
export function ocrReadingsToSuggest(result: OcrConsensus, applied: boolean): OcrReading[] {
  if (!applied) return result.readings;
  const key = ocrComparableKey(result.source);
  return result.readings.filter((reading) => {
    if (reading.error || !lettered(reading.source)) return false;
    return ocrComparableKey(reading.source) !== key;
  });
}

/**
 * Dialogue, aside and SFX are the only types detection assigns. A dictionary hit
 * promotes dialogue to SFX. A free-text box whose reading is speech is demoted to an
 * aside, unless a person already chose the type.
 */
export function correctedRegionLineType(
  current: string,
  updatedBy: string | null,
  source: string,
  hints: RegionTypeHints = {},
): string | null {
  if (current !== '""' && current !== '::' && current !== '//') return null;
  if (!source.trim()) return null;
  const kind = hints.kind ?? (current === '""' ? 'bubble' : 'free');
  const next = classifyRegionLineType(kind, source, hints);
  if (next === current) return null;
  if (next !== '::' && updatedBy !== 'ai-ocr') return null;
  return next;
}

/** Whether the sound-effect detector, not just the box detector, found this region. */
function sfxHints(lineId: string): RegionTypeHints {
  const data = getDoc<{ detectionKind?: string; detectionProvenance?: { backend?: string } }>(`region:${lineId}`, {}).data;
  const backend = data.detectionProvenance?.backend;
  const kind = data.detectionKind;
  return {
    sfxDetector: typeof backend === 'string' && backend.startsWith('coo'),
    ...(kind === 'bubble' || kind === 'free' || kind === 'unknown' ? { kind } : {}),
  };
}

/**
 * One pending source suggestion on an empty line is the reading. Write it into
 * whichever of source and English is still empty, then drop the suggestion.
 */
export function applyLonePendingSource(episodeId: string, lineId: string): boolean {
  const row = db.select().from(lines).where(eq(lines.id, lineId)).get();
  if (!row || row.episodeId !== episodeId || row.sourceState === 'ignored') return false;
  if ((row.source || '').trim()) return false;
  const machine = row.updatedBy === 'ai-ocr' && row.status !== 'approved';
  const blank = !(row.body || '').trim();
  if (!machine && !blank) return false;
  const pending = sqlite.prepare(
    `SELECT id, kind, body, translation, reason FROM suggestions
     WHERE episode_id=? AND line_id=? AND state='pending' AND kind IN ('source-review','source-enquiry')`,
  ).all(episodeId, lineId) as { id: string; kind: string; body: string; translation: string | null; reason: string | null }[];
  const cards = collapseSuggestions(pending.filter((item) => item.body.trim()));
  if (cards.length !== 1) return false;
  const card = cards[0];
  const english = !(row.body || '').trim() && card.translation?.trim() ? normalizeTranslation(card.translation.trim()) : (row.body || '');
  const status = english.trim() ? ((row.body || '').trim() ? row.status : 'needs_work') : 'none';
  const lineType = correctedRegionLineType(row.lineType, row.updatedBy, card.body.trim(), sfxHints(lineId));
  const written = sqlite.prepare(
    `UPDATE lines SET source=?,source_state='read',body=?,status=?,ocr_confidence=NULL,line_type=COALESCE(?, line_type),updated_at=?
     WHERE id=? AND episode_id=? AND source_state!='ignored' AND (source IS NULL OR TRIM(source)='')`,
  ).run(card.body.trim(), english, status, lineType, Date.now(), lineId, episodeId);
  if (!written.changes) return false;
  sqlite.prepare(`UPDATE suggestions SET state='rejected' WHERE id IN (${card.mergedIds.map(() => '?').join(',')}) AND state='pending'`)
    .run(...card.mergedIds);
  return true;
}

/** Save both independent readings without replacing a person's edits or running a council. */
export function saveOcrConsensus(
  episodeId: string,
  line: LineRow,
  result: OcrConsensus,
  translatorLabel = ocrTranslatorLabel(),
) {
  return sqlite.transaction(() => {
    const row = db.select().from(lines).where(eq(lines.id, line.id)).get();
    if (!row || row.episodeId !== episodeId || row.sourceState === 'ignored') return;
    const editable = row.revision === (line.revision ?? 0) && row.status !== 'approved' &&
      (row.updatedBy === 'ai-ocr' || (!row.source?.trim() && !row.body.trim()));
    const english = normalizeTranslation(winnerEnglish(result));
    if (editable) {
      const sameSource = (row.source || '') === result.source;
      const body = result.agreed ? (english || (sameSource ? (row.body || '') : '')) : '';
      const status = result.agreed
        ? (english ? 'needs_work' : (sameSource && (row.body || '').trim() ? (row.status || 'none') : 'none'))
        : 'needs_work';
      const lineType = correctedRegionLineType(
        row.lineType,
        row.updatedBy,
        sfxClassificationSource(result.source, result.readings),
        sfxHints(row.id),
      );
      sqlite.prepare(`UPDATE lines SET source=?,source_state=?,body=?,ocr_confidence=NULL,status=?,line_type=COALESCE(?, line_type),updated_at=?
        WHERE id=? AND episode_id=? AND revision=?`).run(result.source, result.agreed ? 'read' : 'unreadable',
        body, status, lineType, Date.now(), row.id, episodeId, row.revision);
    }
    let saved = toLine(db.select().from(lines).where(eq(lines.id, line.id)).get()!);
    const winnerSaved = result.agreed && !!result.source.trim() && (saved.source || '') === result.source;
    const suggestionIds: string[] = [];
    const suggestReadings = winnerSaved
      ? ocrReadingsToSuggest(result, true)
      : result.readings;
    for (const reading of suggestReadings) {
      suggestionIds.push(suggest(episodeId, saved.id, saved.revision ?? 0, reading.source,
        ocrSuggestionReason(reading, translatorLabel), 'source-review',
        reading.translation ?? ''));
    }
    const labels = result.readings.map((reading) => `${labelFor(reading.model)}%`);
    sqlite.prepare(`UPDATE suggestions SET state='rejected' WHERE episode_id=? AND line_id=? AND state='pending'
      AND kind='source-review' AND (${labels.map(() => 'reason LIKE ?').join(' OR ') || '0'})
      ${suggestionIds.length ? `AND id NOT IN (${suggestionIds.map(() => '?').join(',')})` : ''}`)
      .run(episodeId, saved.id, ...labels, ...suggestionIds);
    if (applyLonePendingSource(episodeId, saved.id))
      saved = toLine(db.select().from(lines).where(eq(lines.id, line.id)).get()!);
    broadcast(episodeId, { type: 'line:upsert', line: saved });
    broadcast(episodeId, { type: 'suggestion:changed', lineId: saved.id });
    return saved;
  })();
}
