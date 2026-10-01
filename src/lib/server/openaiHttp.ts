import type { RequestPreset } from '../managedModels';
import { acquireModelUse } from './modelUsage';
import { ensureManagedModel, managedNeedsStart } from './managedModels';
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendJobLog, jobContext, sanitizeLlmMessages, summarizeModelOutput } from './jobs';

export type HttpProfile = 'llamacpp' | 'openai';

export type AssistantHttpConfig = {
	baseUrl: string;
	apiKey: string;
	model: string;
	profile: HttpProfile;
	rowId?: string;
	apiKeyEnv?: string;
	requestPreset?: RequestPreset;
	requireApiKey?: boolean;
	managed?: boolean;
};

const store = new AsyncLocalStorage<AssistantHttpConfig | undefined>();

/** OpenAI SDK treats `https://api.deepseek.com` as having `/v1`; our fetch path does not. */
export function openaiCompatibleBaseUrl(raw: string, fallback = 'https://api.openai.com/v1'): string {
	let url = (raw || '').trim().replace(/\/+$/, '');
	if (!url) url = fallback.replace(/\/+$/, '');
	if (!/\/v\d+$/i.test(url)) url = `${url}/v1`;
	return url;
}

export function missingApiKeyMessage(envName: string): string {
	return `${envName} is not set. Put the secret in .env; Admin stores the variable name only.`;
}

const JSON_OBJECT_FORMAT = { type: 'json_object' } as const;

/** DeepSeek and many clones reject OpenAI `json_schema`; they accept `json_object`. llama.cpp keeps the schema. */
export function compatResponseFormat(schema: unknown, profile: HttpProfile): unknown | undefined {
	if (schema == null) return undefined;
	if (profile === 'llamacpp') return schema;
	if (typeof schema === 'object' && schema && (schema as { type?: string }).type === 'json_schema') {
		return JSON_OBJECT_FORMAT;
	}
	return schema;
}

export function responseFormatRejected(status: number, body: string): boolean {
	if (status !== 400) return false;
	return /response_format/i.test(body) || /unavailable now/i.test(body);
}

export function isDeepSeekHost(baseUrl: string): boolean {
	try {
		return /deepseek/i.test(new URL(baseUrl).hostname);
	} catch {
		return /deepseek/i.test(baseUrl);
	}
}

/** DeepSeek JSON + max_tokens 8192 never returns; 4096 returns. Do not raise this. */
export const DEEPSEEK_MAX_OUTPUT_TOKENS = 4096;

export function openaiMaxTokens(baseUrl: string, requested?: number): number {
	const n = requested ?? 8192;
	if (!isDeepSeekHost(baseUrl)) return n;
	return Math.min(n, DEEPSEEK_MAX_OUTPUT_TOKENS);
}
export function openaiThinking(
	baseUrl: string,
	jsonMode: boolean,
	thinking: boolean,
	imageRequest = false,
): { type: 'enabled' | 'disabled' } | undefined {
	if (!isDeepSeekHost(baseUrl)) return undefined;
	// Flash defaults thinking ON when the field is omitted. Hidden CoT shares max_tokens
	// with the visible reading, so a balloon review comes back as a few leftover words.
	if (imageRequest || jsonMode || !thinking) return { type: 'disabled' };
	return { type: 'enabled' };
}

type ChatContent =
	| string
	| Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: ChatContent };

export function messagesHaveImages(messages: ChatMessage[]): boolean {
	return messages.some(
		(m) =>
			Array.isArray(m.content) &&
			m.content.some((part) => part.type === 'image_url' && Boolean(part.image_url?.url)),
	);
}

function textFromContent(content: ChatMessage['content']): string {
	if (typeof content === 'string') return content.trim();
	return content
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('\n')
		.trim();
}

/** DeepSeek vision accepts images on user turns only. Official examples omit a system role. */
export function deepSeekVisionMessages(messages: ChatMessage[]): ChatMessage[] {
	if (!messagesHaveImages(messages)) return messages;
	const system = messages
		.filter((m) => m.role === 'system')
		.map((m) => textFromContent(m.content))
		.filter(Boolean)
		.join('\n\n');
	const out: ChatMessage[] = [];
	let prepended = false;
	for (const message of messages) {
		if (message.role === 'system') continue;
		if (message.role === 'user' && system && !prepended) {
			prepended = true;
			if (Array.isArray(message.content)) {
				const parts = message.content.map((part) => ({ ...part }));
				const textIdx = parts.findIndex((part) => part.type === 'text');
				const textPart = parts[textIdx];
				if (textPart?.type === 'text') {
					const current = textPart.text ?? '';
					parts[textIdx] = { type: 'text', text: `${system}\n\n${current}`.trim() };
				} else {
					parts.unshift({ type: 'text', text: system });
				}
				out.push({ role: 'user', content: parts });
				continue;
			}
			out.push({ role: 'user', content: `${system}\n\n${message.content}`.trim() });
			continue;
		}
		out.push(message);
	}
	return out;
}

function assistantText(message: {
	content?: string | Array<{ text?: string }>;
	reasoning_content?: string;
} | undefined): string {
	const content = message?.content;
	const asText =
		typeof content === 'string'
			? content
			: Array.isArray(content)
				? content.map((c) => c.text || '').join('\n')
				: '';
	return asText.trim();
}

export function withAssistantHttp<T>(cfg: AssistantHttpConfig | undefined, fn: () => T): T {
	const run = (): T => {
		const release = cfg?.rowId ? acquireModelUse(cfg.rowId, jobContext()?.jobId, cfg.managed) : () => {};
		try {
			const result = store.run(cfg, fn);
			if (result && typeof (result as unknown as Promise<unknown>).then === 'function') return Promise.resolve(result).finally(release) as T;
			release();
			return result;
		} catch (error) { release(); throw error; }
	};
	if (cfg?.managed && cfg.rowId && managedNeedsStart(cfg.rowId)) return ensureManagedModel(cfg.rowId).then(run) as T;
	return run();
}

export function currentAssistantHttp(): AssistantHttpConfig | undefined {
	return store.getStore();
}

export async function openaiChatCompletions(
	messages: ChatMessage[],
	opts: {
		config: AssistantHttpConfig;
		abort?: AbortSignal;
		schema?: unknown;
		temperature?: number;
		maxTokens?: number;
		thinking?: boolean;
		timeoutMs?: number;
	},
): Promise<string> {
	const cfg = opts.config;
	if (cfg.requireApiKey !== false && !cfg.apiKey) throw new Error(missingApiKeyMessage(cfg.apiKeyEnv || 'API key'));
	const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
	const thinking = opts.thinking !== false;
	const imageRequest = messagesHaveImages(messages);
	const outgoing =
		isDeepSeekHost(cfg.baseUrl) && imageRequest ? deepSeekVisionMessages(messages) : messages;
	let format = compatResponseFormat(opts.schema, cfg.profile);
	let droppedFormat = false;

	const request = sanitizeLlmMessages(outgoing);
	const started = Date.now();
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10 * 60 * 1000);
	const onAbort = () => ctrl.abort();
	try {
		if (opts.abort?.aborted) throw new Error('Cancelled');
		opts.abort?.addEventListener('abort', onAbort, { once: true });
		for (;;) {
			if (opts.abort?.aborted) throw new Error('Cancelled');
			const body: Record<string, unknown> = {
				model: cfg.model,
				messages: outgoing,
				temperature: opts.temperature ?? 0.3,
				max_tokens: openaiMaxTokens(cfg.baseUrl, opts.maxTokens),
			};
			if (cfg.profile === 'llamacpp') {
				body.cache_prompt = true;
				if (cfg.requestPreset === 'qwen-thinking') body.chat_template_kwargs = {
					enable_thinking: thinking,
					reasoning_effort: thinking ? 'medium' : 'none',
				};
			}
			const jsonMode =
				!!format &&
				typeof format === 'object' &&
				(format as { type?: string }).type === 'json_object';
			const think = openaiThinking(cfg.baseUrl, jsonMode || !!opts.schema, thinking, imageRequest);
			if (think) body.thinking = think;
			if (format) body.response_format = format;
			const res = await fetch(url, {
				method: 'POST',
				headers: {
					...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
					'content-type': 'application/json',
				},
				body: JSON.stringify(body),
				signal: ctrl.signal,
			});
			const text = await res.text();
			if (
				!res.ok &&
				!droppedFormat &&
				cfg.profile === 'openai' &&
				format &&
				responseFormatRejected(res.status, text)
			) {
				format = undefined;
				droppedFormat = true;
				continue;
			}
			if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
			const json = JSON.parse(text) as {
				choices?: Array<{
					finish_reason?: string;
					message?: { content?: string | Array<{ text?: string }>; reasoning_content?: string };
				}>;
			};
			const choice = json.choices?.[0];
			if (choice?.finish_reason === 'length') {
				const cap = openaiMaxTokens(cfg.baseUrl, opts.maxTokens);
				throw new Error(
					isDeepSeekHost(cfg.baseUrl)
						? `DeepSeek reached its ${cap}-token output limit before finishing. The partial reading was discarded; retry this region.`
						: `Model reached its output limit (finish_reason=length). Retry with a smaller region.`,
				);
			}
			const out = assistantText(choice?.message);
			if (!out) {
				const finish = choice?.finish_reason || 'unknown';
				throw new Error(
					isDeepSeekHost(cfg.baseUrl)
						? `DeepSeek returned empty content (finish_reason=${finish}). Thinking is disabled for JSON requests; retry Test if this was a blank JSON-mode reply.`
						: `Model returned empty content (finish_reason=${finish})`,
				);
			}
			const ctx = jobContext();
			if (ctx) {
				const summary = summarizeModelOutput(text, Date.now() - started);
				appendJobLog(ctx.jobId, {
					engine: cfg.rowId || cfg.model,
					model: cfg.model,
					request,
					response: summary.response,
					usage: summary.usage,
				});
			}
			return out;
		}
	} finally {
		clearTimeout(timer);
		opts.abort?.removeEventListener('abort', onAbort);
	}
}

export async function openaiListModels(baseUrl: string, apiKey: string, abort?: AbortSignal) {
	const url = `${baseUrl.replace(/\/$/, '')}/models`;
	const res = await fetch(url, {
		headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
		signal: abort ?? AbortSignal.timeout(5000),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}
