import { executeModelTask } from './modelTaskRunner';
import { resolveLiveAssistant } from './assistantRoute';
import { proofreaderToolbarOnlyMessage, PROOFREADER_IDS } from '../proofreaders';
import type { AdvisoryRequest } from './cliAdapters/types';
import type { CliTranslationEngine } from './translationTask';
import { WorkflowError } from './workflowStore';

export type AdvisoryOpts = AdvisoryRequest;

/** Proofreaders are page-image proofread only and cannot answer advisory prompts. */
export const ADVISORY_PROOFREADER_MESSAGE = proofreaderToolbarOnlyMessage(PROOFREADER_IDS[0]);

/** Injected so tests can swap CLI and local advisory without importing runtimes. */
export type AdvisoryHandlers = {
	cli(engine: CliTranslationEngine, opts: AdvisoryOpts): Promise<unknown>;
	local(opts: AdvisoryOpts, engine?: string): Promise<unknown>;
};

export async function runAdvisory(
	engine: string,
	opts: AdvisoryOpts,
	handlers?: AdvisoryHandlers,
): Promise<unknown> {
	const row = resolveLiveAssistant(engine, opts.model).row;
	if (row.access === 'proofreader') throw new WorkflowError(ADVISORY_PROOFREADER_MESSAGE);
	opts.abort?.throwIfAborted();
	if (handlers) return row.access === 'cli' ? handlers.cli((row.cliAdapter || engine) as CliTranslationEngine, opts) : handlers.local(opts, engine);
	return executeModelTask(row, 'advisory', opts, { abort: opts.abort });
}
