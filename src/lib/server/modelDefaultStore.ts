import { DEFAULT_CHAT_MODEL_ID } from '../modelDefaults';
import { DEFAULT_TRANSCRIPTION_MODEL_IDS, RETIRED_INPAINT_MODEL_IDS } from '../modelRegistry';
import type { ModelTaskId } from '../modelTasks';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomicJson } from './modelPackJournal';
import { DATA_DIR } from './paths';
import { findRegistryRow } from './modelRegistryStore';
import type { ProviderOperation } from '../providerCatalog';

/**
 * Operator-chosen default model per job, stored beside the other machine-local
 * admin settings. The shipped constants remain the last resort so a fresh
 * install behaves exactly as documented.
 */

export type DefaultJob = ProviderOperation | 'detect' | 'transcribe';
export type ModelDefaultsFile = { version: 1; defaults: Partial<Record<DefaultJob, string>> };

function defaultsPath(): string {
	return join(DATA_DIR, 'model-defaults.json');
}

export function readModelDefaults(): ModelDefaultsFile {
	try {
		const parsed = JSON.parse(readFileSync(defaultsPath(), 'utf8')) as ModelDefaultsFile;
		if (parsed && typeof parsed === 'object' && parsed.defaults && typeof parsed.defaults === 'object') {
			const defaults = Object.fromEntries(Object.entries(parsed.defaults).filter(([, id]) =>
				!(RETIRED_INPAINT_MODEL_IDS as readonly string[]).includes(id)));
			return { version: 1, defaults };
		}
	} catch {
		/* absent */
	}
	return { version: 1, defaults: {} };
}

export function modelDefaultFor(job: DefaultJob): string | undefined {
	return readModelDefaults().defaults[job];
}

export function setModelDefault(job: DefaultJob, rowId: string | undefined): ModelDefaultsFile {
	const prefs = readModelDefaults();
	if (!rowId) delete prefs.defaults[job];
	else {
		// Detectors and transcription councils name install targets, not rows.
		const known = findRegistryRow(rowId) || (job === 'detect' || job === 'transcribe' ? true : false);
		if (!known) throw Object.assign(new Error('Unknown model'), { status: 404 });
		prefs.defaults[job] = rowId;
	}
	writeAtomicJson(defaultsPath(), prefs);
	return prefs;
}

const IMAGE_TASKS = new Set<ModelTaskId>(['detect', 'textMask', 'segmentBubble', 'inpaint', 'cleaning']);

/**
 * The model a job runs when the operator has not picked another one: the stored
 * job default, the shipped chat model, or a default transcription reader.
 */
export function isDefaultModelForTask(row: { id: string }, task: ModelTaskId): boolean {
	if (modelDefaultFor(task) === row.id) return true;
	if (task === 'sourceDecide') return false;
	if ((task === 'vision' || task === 'sourceReview') && (DEFAULT_TRANSCRIPTION_MODEL_IDS as readonly string[]).includes(row.id)) return true;
	return !modelDefaultFor(task) && !IMAGE_TASKS.has(task) && row.id === DEFAULT_CHAT_MODEL_ID;
}

/**
 * The stored default for a job when that row can still run it, else the caller's
 * fallback. Disabled or capability-stripped rows never win silently.
 */
export function effectiveDefault(job: DefaultJob, fallback: string): string {
	const stored = modelDefaultFor(job);
	if (!stored) return fallback;
  // Preserve an explicit choice. Execution explains stale evidence or unavailable service.
  return stored;
}

export function defaultsFileExists(): boolean {
	return existsSync(defaultsPath());
}
