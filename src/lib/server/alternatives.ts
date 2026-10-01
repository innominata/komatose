import { executeModelTask } from './modelTaskRunner';
import { resolveLiveAssistant } from './assistantRoute';
import type { LineType, OcrLang } from '../types';
import { type CliTranslationEngine } from './translationTask';
import { proofreaderOnlyMessage } from '../proofreaders';
import { WorkflowError } from './workflowStore';

export type AlternativesOpts = {
	seriesNotes: string;
	seriesGlossary: string;
	prior: string;
	pages: string;
	script: string;
	source: string;
	current: string;
	fresh: string;
	lineType: LineType;
	page: string;
	abort?: AbortSignal;
	lang?: OcrLang;
	model?: string;
};

export type AlternativesHit = { translation: string; reasoning: string };

/** Injected so tests can swap CLI and local alternative phrasing without importing runtimes. */
export type AlternativesHandlers = {
	cli(engine: CliTranslationEngine, opts: AlternativesOpts): Promise<AlternativesHit[]>;
	local(opts: AlternativesOpts): Promise<AlternativesHit[]>;
};

export async function runAlternatives(
	engine: string,
	opts: AlternativesOpts,
	handlers?: AlternativesHandlers,
): Promise<AlternativesHit[]> {
	const row = resolveLiveAssistant(engine, opts.model).row;
	if (row.access === 'proofreader') throw new WorkflowError(proofreaderOnlyMessage(row.id, 'alternative translations'));
	opts.abort?.throwIfAborted();
	if (handlers) return row.access === 'cli' ? handlers.cli((row.cliAdapter || engine) as CliTranslationEngine, opts) : handlers.local(opts);
	return executeModelTask(row, 'alternatives', opts, { abort: opts.abort });
}
