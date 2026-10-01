import { executeModelTask } from './modelTaskRunner';
import { resolveLiveAssistant } from './assistantRoute';
import type { LineType, OcrLang } from '../types';
import { CLI_TRANSLATION_ENGINES, type CliTranslationEngine } from './translationTask';
import { httpConfigFor, routeAssistant } from './assistantRoute';
import { withAssistantHttp } from './openaiHttp';

export type VisionReadResult = { source: string; lineType: LineType };
export type VisionReadOpts = {
	jpeg: Buffer;
	lang?: OcrLang;
	model?: string;
	abort?: AbortSignal;
	diagnostic?: boolean;
};

/** @deprecated Adapter fixtures should exercise the package boundary. */
export type VisionReadHandlers = {
	cli(engine: CliTranslationEngine, opts: VisionReadOpts): Promise<VisionReadResult>;
	local(opts: VisionReadOpts): Promise<VisionReadResult>;
	qwen3vl?(opts: VisionReadOpts): Promise<VisionReadResult>;
	ocr?(id: string, opts: VisionReadOpts): Promise<VisionReadResult>;
};

export async function runVisionRead(
	engine: string,
	opts: VisionReadOpts,
	_legacyHandlers?: VisionReadHandlers,
): Promise<VisionReadResult> {
	return executeModelTask(resolveLiveAssistant(engine, opts.model).row, 'vision', opts, { abort: opts.abort, diagnostic: opts.diagnostic });
}

export { CLI_TRANSLATION_ENGINES };
