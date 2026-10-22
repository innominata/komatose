import { DEFAULT_CHAT_MODEL_ID, DEFAULT_REVIEW_MODEL_ID } from './modelDefaults';
import type { ReviewIssue, ReviewQuestion, ReviewReport, TranslateEngine } from './types';
import { hydrateTaskEngine, sanitizeModelSlug } from './modelRegistry';

export type { ReviewIssue, ReviewQuestion, ReviewReport };

export type AiTask = 'translate' | 'describe' | 'proofread' | 'review';

export type TaskEngine = {
	engine: string;
	model: string;
};

export type TaskEngineMap = Record<AiTask, TaskEngine>;

export const AI_TASKS: AiTask[] = ['translate', 'describe', 'proofread', 'review'];

export const AI_TASK_LABELS: Record<AiTask, string> = {
	translate: 'Translate',
	describe: 'Describe',
	proofread: 'Proofread',
	review: 'Review'
};

export const AI_TASK_HINTS: Record<AiTask, string> = {
	translate: 'Full chapter, one page, and selection translate',
	describe: 'Scene notes on pages',
	proofread: 'Rewrites lettering for consistency',
	review: 'Read-only notes, issues, and questions'
};

export const DEFAULT_ENGINE_MODELS: Record<string, string> = {
	qwen: '',
	grok: '',
	codex: '',
	cursor: '',
	'proofreader-a': '',
	'proofreader-b': ''
};

export function sanitizeModelId(raw: unknown): string {
	return sanitizeModelSlug(raw);
}

export function defaultTaskEngines(): TaskEngineMap {
	return {
		translate: { engine: DEFAULT_CHAT_MODEL_ID, model: '' },
		describe: { engine: DEFAULT_CHAT_MODEL_ID, model: '' },
		proofread: { engine: DEFAULT_CHAT_MODEL_ID, model: '' },
		review: { engine: DEFAULT_REVIEW_MODEL_ID, model: '' }
	};
}

export function parseTaskEngine(raw: unknown, fallback: string = DEFAULT_CHAT_MODEL_ID): string {
	if (typeof raw === 'string' && raw.trim()) return raw.trim();
	return fallback;
}

export type EngineModelOption = { id: string; label: string; available?: boolean; reason?: string };

export const FALLBACK_ENGINE_MODELS: Record<string, EngineModelOption[]> = {
	// CLI model lists come from discovery; none are built in.
	qwen: [],
	grok: [],
	codex: [],
	cursor: [],
	'proofreader-a': [],
	'proofreader-b': []
};

export function hydrateTaskEngines(stored: unknown, legacyEngine?: string | null): TaskEngineMap {
	const next = defaultTaskEngines();
	if (
		legacyEngine === 'qwen' ||
		legacyEngine === 'grok' ||
		legacyEngine === 'codex' ||
		legacyEngine === 'cursor'
	) {
		for (const task of ['translate', 'describe', 'proofread'] as AiTask[]) {
			next[task] = hydrateTaskEngine({
				engine: legacyEngine,
				model: DEFAULT_ENGINE_MODELS[legacyEngine as TranslateEngine],
			});
		}
	}
	if (!stored || typeof stored !== 'object') return next;
	const rec = stored as Record<string, unknown>;
	for (const task of AI_TASKS) {
		const row = rec[task];
		if (!row || typeof row !== 'object') continue;
		next[task] = hydrateTaskEngine(row);
	}
	return next;
}
