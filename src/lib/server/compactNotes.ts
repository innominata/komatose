import { executeModelTask } from './modelTaskRunner';
import { resolveLiveAssistant } from './assistantRoute';
import { type CliTranslationEngine } from './translationTask';
import { proofreaderOnlyMessage } from '../proofreaders';
import { WorkflowError } from './workflowStore';

export type CompactNotesRow = { i: number; caption: string };
export type CompactNotesResult = { chapter: string; pages: CompactNotesRow[] };
export type CompactNotesOpts = { abort?: AbortSignal; model?: string };

/** Injected so tests can swap CLI and local compaction without importing runtimes. */
export type CompactNotesHandlers = {
	cli(
		engine: CliTranslationEngine,
		rows: CompactNotesRow[],
		opts: CompactNotesOpts,
	): Promise<CompactNotesResult>;
	local(rows: CompactNotesRow[], opts: CompactNotesOpts): Promise<CompactNotesResult>;
};

export async function runCompactSceneNotes(
	engine: string,
	rows: CompactNotesRow[],
	opts: CompactNotesOpts,
	handlers?: CompactNotesHandlers,
): Promise<CompactNotesResult> {
	const row = resolveLiveAssistant(engine, opts.model).row;
	if (row.access === 'proofreader') throw new WorkflowError(proofreaderOnlyMessage(row.id, 'scene-note compaction'));
	opts.abort?.throwIfAborted();
	if (handlers) return row.access === 'cli'
		? handlers.cli((row.cliAdapter || engine) as CliTranslationEngine, rows, opts)
		: handlers.local(rows, opts);
	return executeModelTask(row, 'compactNotes', { ...opts, rows }, { abort: opts.abort });
}
