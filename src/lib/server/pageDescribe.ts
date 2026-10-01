import { executeModelTask } from './modelTaskRunner';
import { resolveLiveAssistant } from './assistantRoute';
import { CLI_TRANSLATION_ENGINES, type CliTranslationEngine } from './translationTask';
import { proofreaderOnlyMessage } from '../proofreaders';
import { WorkflowError } from './workflowStore';

export type DescribePageOpts = {
	jpeg: Buffer;
	model?: string;
	abort?: AbortSignal;
};

/** Injected so tests can swap CLI, local, and Qwen3-VL describe paths. */
export type DescribePageHandlers = {
	cli(engine: CliTranslationEngine, opts: DescribePageOpts): Promise<string>;
	local(opts: DescribePageOpts): Promise<string>;
	qwen3vl(opts: DescribePageOpts): Promise<string>;
};

export async function runDescribePage(
	engine: string,
	opts: DescribePageOpts,
	handlers?: DescribePageHandlers,
): Promise<string> {
	const row = resolveLiveAssistant(engine, opts.model).row;
	if (row.access === 'proofreader') throw new WorkflowError(proofreaderOnlyMessage(row.id, 'page description'));
	opts.abort?.throwIfAborted();
	if (handlers) {
		if (row.access === 'cli') return handlers.cli((row.cliAdapter || engine) as CliTranslationEngine, opts);
		if (row.runtime === 'qwen3vl') return handlers.qwen3vl(opts);
		return handlers.local(opts);
	}
	return executeModelTask(row, 'describe', opts, { abort: opts.abort });
}

export { CLI_TRANSLATION_ENGINES };
