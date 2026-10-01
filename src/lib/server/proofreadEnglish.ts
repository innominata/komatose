import { executeModelTask } from './modelTaskRunner';
import { resolveLiveAssistant } from './assistantRoute';
import type { OcrLang } from '../types';
import type { ProofreadItem } from './llm';
import { type CliTranslationEngine } from './translationTask';
import { proofreaderOnlyMessage } from '../proofreaders';
import { WorkflowError } from './workflowStore';

export type ProofreadEnglishOpts = {
	seriesNotes: string;
	seriesGlossary: string;
	prior: string;
	pages: string;
	settled: string;
	abort?: AbortSignal;
	lang?: OcrLang;
	model?: string;
};

export type ProofreadEnglishHit = { translation: string; reasoning: string };

/** Injected so tests can swap CLI and local proofreading without importing runtimes. */
export type ProofreadEnglishHandlers = {
	cli(
		engine: CliTranslationEngine,
		items: ProofreadItem[],
		opts: ProofreadEnglishOpts,
	): Promise<Map<number, ProofreadEnglishHit>>;
	local(
		items: ProofreadItem[],
		opts: ProofreadEnglishOpts,
	): Promise<Map<number, ProofreadEnglishHit>>;
};

export async function runProofreadEnglish(
	engine: string,
	items: ProofreadItem[],
	opts: ProofreadEnglishOpts,
	handlers?: ProofreadEnglishHandlers,
): Promise<Map<number, ProofreadEnglishHit>> {
	const row = resolveLiveAssistant(engine, opts.model).row;
	if (row.access === 'proofreader') throw new WorkflowError(proofreaderOnlyMessage(row.id, 'Proofread edited English'));
	opts.abort?.throwIfAborted();
	if (handlers) return row.access === 'cli' ? handlers.cli((row.cliAdapter || engine) as CliTranslationEngine, items, opts) : handlers.local(items, opts);
	const result = await executeModelTask(row, 'proofreadEnglish', { ...opts, items }, { abort: opts.abort });
	return result instanceof Map ? result : new Map(Object.entries(result).map(([key, value]) => [Number(key), value as ProofreadEnglishHit]));
}
