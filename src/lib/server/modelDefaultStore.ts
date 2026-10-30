import { RETIRED_INPAINT_MODEL_IDS, rowHasOperation } from '../modelRegistry';
import { taskLabel, type ModelTaskId } from '../modelTasks';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomicJson } from './modelPackJournal';
import { DATA_DIR } from './paths';
import { findRegistryRow, listRegistryRows } from './modelRegistryStore';
import type { ProviderOperation } from '../providerCatalog';

/**
 * Operator-chosen default model per job, stored beside the other machine-local
 * admin settings. Nothing is built in: an unset job has no default model.
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

/** The model the operator chose as this job's default. */
export function isDefaultModelForTask(row: { id: string }, task: ModelTaskId): boolean {
	return modelDefaultFor(task) === row.id;
}

/** Transcribe defaults are proven by the Read Text test. */
const testFor = (job: DefaultJob): ModelTaskId => job === 'transcribe' ? 'vision' : job;

/**
 * The stored default for a job, else the first enabled model whose test for
 * that job passed, else ''. Nothing is built in.
 */
export function effectiveDefault(job: DefaultJob): string {
	// The admin page sets Transcribe through its Read Text column.
	const stored = modelDefaultFor(job) || (job === 'transcribe' ? modelDefaultFor('vision') : undefined);
	// Preserve an explicit choice. Execution explains stale evidence or unavailable service.
	if (stored) return stored;
	return listRegistryRows().find(row => !row.disabled && rowHasOperation(row, testFor(job)))?.id ?? '';
}

/** Why a job has no model, logged so the operator sees it beside the failed run. */
export function noModelError(job: DefaultJob): Error & { status: number } {
	const label = taskLabel(testFor(job));
	const message = `No model can run ${label}: none is set as its default and no enabled model has passed the ${label} test. Install one or run its test under Admin → Models.`;
	console.error(`[models] ${message}`);
	return Object.assign(new Error(message), { status: 503 });
}

/** effectiveDefault, or a logged error when no model can run the job. */
export function requireDefault(job: DefaultJob): string {
	const id = effectiveDefault(job);
	if (!id) throw noModelError(job);
	return id;
}

export function defaultsFileExists(): boolean {
	return existsSync(defaultsPath());
}
