import { executeModelTask } from './modelTaskRunner';
import { resolveLiveAssistant } from './assistantRoute';
import type { DetectedBox, TranslateScriptOpts } from './llm';
import { CLI_PROVIDER_IDS, isCliProvider, type CliProviderId } from '../providerCatalog';
import { routeAssistant, httpConfigFor } from './assistantRoute';
import { withAssistantHttp } from './openaiHttp';

export type CliTranslationEngine = CliProviderId;
export const CLI_TRANSLATION_ENGINES = CLI_PROVIDER_IDS;

export type TranslationTaskOptions = TranslateScriptOpts & {
	jpeg?: Buffer;
	/** A capability probe may run a row that is still disabled. */
	diagnostic?: boolean;
	/** Fill missing English for one transcription instead of translating a chapter script. */
	ocrSource?: boolean;
};

export type TranslationTaskRequest = TranslationTaskOptions & {
	engine: string;
	boxes: DetectedBox[];
};

/** @deprecated Adapter fixtures should exercise the package boundary. */
export type TranslationTaskHandlers = {
	cli(
		engine: CliTranslationEngine,
		boxes: DetectedBox[],
		opts: TranslationTaskOptions,
	): Promise<DetectedBox[]>;
	local(boxes: DetectedBox[], opts: TranslateScriptOpts): Promise<DetectedBox[]>;
};

/** One task interface above CLI adapters and local/specialist translation. */
export async function runTranslationTask(
	request: TranslationTaskRequest,
	_legacyHandlers?: TranslationTaskHandlers,
): Promise<DetectedBox[]> {
	const { engine, ...input } = request;
 const row = resolveLiveAssistant(engine, request.model).row;
 return executeModelTask(row, 'translate', input, { abort: request.abort, diagnostic: request.diagnostic });
}

export { isCliProvider };
