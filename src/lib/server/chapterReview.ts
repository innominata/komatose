import { executeModelTask } from './modelTaskRunner';
import { resolveLiveAssistant } from './assistantRoute';
import type { OcrLang } from '../types';
import { type CliTranslationEngine } from './translationTask';
import { proofreaderOnlyMessage } from '../proofreaders';
import { WorkflowError } from './workflowStore';

export type ChapterReviewOpts = {
	seriesNotes: string;
	seriesGlossary: string;
	prior: string;
	pages: string;
	script: string;
	abort?: AbortSignal;
	lang?: OcrLang;
	model?: string;
};

export type ChapterReviewResult = {
	summary: string;
	issues: { page: string; line?: number; severity: 'info' | 'warn' | 'error'; text: string }[];
	questions: { page: string; text: string }[];
	notes: string;
};

/** Injected so tests can swap CLI and local chapter review without importing runtimes. */
export type ChapterReviewHandlers = {
	cli(engine: CliTranslationEngine, opts: ChapterReviewOpts): Promise<ChapterReviewResult>;
	local(opts: ChapterReviewOpts): Promise<ChapterReviewResult>;
};

export async function runChapterReview(
	engine: string,
	opts: ChapterReviewOpts,
	handlers?: ChapterReviewHandlers,
): Promise<ChapterReviewResult> {
	const row = resolveLiveAssistant(engine, opts.model).row;
	if (row.access === 'proofreader') throw new WorkflowError(proofreaderOnlyMessage(row.id, 'chapter review'));
	opts.abort?.throwIfAborted();
	if (handlers) return row.access === 'cli' ? handlers.cli((row.cliAdapter || engine) as CliTranslationEngine, opts) : handlers.local(opts);
	return executeModelTask(row, 'chapterReview', opts, { abort: opts.abort });
}
