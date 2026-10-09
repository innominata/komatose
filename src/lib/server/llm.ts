import { defaultLocalConnection } from './modelConnection';
import { normalizeTranslation } from "../translationText";
import { assertGeneralModel, translationModel } from '../translationModels';
import { sfxTranslateHit, withSfxGlossary } from '../sfx';
import { translateWithSpecialist } from './specialistTranslation';
import { LINE_TYPES, LINE_TYPE_LABELS, type LineType, type OcrLang } from '../types';
import { appendJobLog, jobContext, sanitizeLlmMessages, summarizeModelOutput } from './jobs';
import { currentAssistantHttp, openaiChatCompletions } from './openaiHttp';

const TILE_TIMEOUT_MS = 10 * 60 * 1000;
const SWAP_RETRY_MS = 8000;
const SWAP_RETRY_LIMIT = 90;

export type DetectedBox = {
  speaker?: string;
	id?: string;
	ocrConfidence?: number;
	x: number;
	y: number;
	w: number;
	h: number;
	lineType: LineType;
	source: string;
	literal: string;
	translation: string;
	reasoning: string;
};

type ChatContent =
	| string
	| Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: ChatContent };

const DETECT_SCHEMA = {
	type: 'json_schema',
	json_schema: {
		name: 'scan_detect',
		strict: true,
		schema: {
			type: 'object',
			additionalProperties: false,
			required: ['boxes'],
			properties: {
				boxes: {
					type: 'array',
					items: {
						type: 'object',
						additionalProperties: false,
						required: ['x', 'y', 'w', 'h', 'lineType', 'source'],
						properties: {
							x: { type: 'number' },
							y: { type: 'number' },
							w: { type: 'number' },
							h: { type: 'number' },
							lineType: { type: 'string', enum: [...LINE_TYPES] },
							source: { type: 'string' }
						}
					}
				}
			}
		}
	}
} as const;

const TRANSLATE_SCHEMA = {
	type: 'json_schema',
	json_schema: {
		name: 'scan_translate',
		strict: true,
		schema: {
			type: 'object',
			additionalProperties: false,
			required: ['items'],
			properties: {
				items: {
					type: 'array',
					items: {
						type: 'object',
						additionalProperties: false,
						required: ['i', 'literal', 'translation', 'reasoning'],
						properties: {
							i: { type: 'integer' },
							literal: { type: 'string' },
							translation: { type: 'string' },
							reasoning: { type: 'string' }
						}
					}
				}
			}
		}
	}
} as const;

export const REVIEW_SCHEMA = {
	type: 'json_schema',
	json_schema: {
		name: 'scan_review',
		strict: true,
		schema: {
			type: 'object',
			additionalProperties: false,
			required: ['summary', 'issues', 'questions', 'notes'],
			properties: {
				summary: { type: 'string' },
				issues: {
					type: 'array',
					items: {
						type: 'object',
						additionalProperties: false,
						required: ['page', 'severity', 'text'],
						properties: {
							page: { type: 'string' },
							line: { type: 'integer' },
							severity: { type: 'string', enum: ['info', 'warn', 'error'] },
							text: { type: 'string' }
						}
					}
				},
				questions: {
					type: 'array',
					items: {
						type: 'object',
						additionalProperties: false,
						required: ['page', 'text'],
						properties: {
							page: { type: 'string' },
							text: { type: 'string' }
						}
					}
				},
				notes: { type: 'string' }
			}
		}
	}
} as const;

export const READ_SCHEMA = {
	type: 'json_schema',
	json_schema: {
		name: 'scan_read',
		strict: true,
		schema: {
			type: 'object',
			additionalProperties: false,
			required: ['source', 'lineType'],
			properties: {
				source: { type: 'string' },
				lineType: { type: 'string', enum: [...LINE_TYPES] }
			}
		}
	}
} as const;

function env(name: string): string {
	return (process.env[name] || '').trim();
}

export const llmConfig = defaultLocalConnection;

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

function isLoadingStatus(status: number, body: string): boolean {
	if (status === 503 || status === 409) return true;
	const lower = body.toLowerCase();
	return (
		lower.includes('loading') ||
		lower.includes('not ready') ||
		lower.includes('no slot') ||
		lower.includes('model is')
	);
}

function stripModelFences(text: string): string {
	return text
		.replace(/<think>[\s\S]*?<\/think>/gi, '')
		.replace(/```(?:json)?/gi, '')
		.replace(/```/g, '')
		.trim();
}

function jsonValueEnd(s: string, start: number): number {
	const open = s[start];
	if (open !== '{' && open !== '[') return -1;
	const stack: string[] = [];
	let inStr = false;
	let esc = false;
	for (let i = start; i < s.length; i++) {
		const c = s[i];
		if (inStr) {
			if (esc) {
				esc = false;
				continue;
			}
			if (c === '\\') {
				esc = true;
				continue;
			}
			if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') {
			inStr = true;
			continue;
		}
		if (c === '{' || c === '[') stack.push(c);
		else if (c === '}' || c === ']') {
			const expect = c === '}' ? '{' : '[';
			if (stack.pop() !== expect) return -1;
			if (!stack.length) return i + 1;
		}
	}
	return -1;
}

function collectJsonValues(text: string): unknown[] {
	const s = stripModelFences(text);
	const out: unknown[] = [];
	for (let i = 0; i < s.length; i++) {
		if (s[i] !== '{' && s[i] !== '[') continue;
		const end = jsonValueEnd(s, i);
		if (end < 0) continue;
		try {
			out.push(JSON.parse(s.slice(i, end)));
		} catch {
			/* skip this candidate */
		}
		i = end - 1;
	}
	return out;
}

function asJsonRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function unwrapModelJson(value: unknown): unknown[] {
	const rec = asJsonRecord(value);
	if (!rec) return [value];
	const out: unknown[] = [value];
	for (const key of ['result', 'response', 'text', 'message', 'content', 'review', 'output']) {
		const val = rec[key];
		if (typeof val === 'string' && val.trim()) out.push(...collectJsonValues(val));
		else if (val && typeof val === 'object') out.push(val);
	}
	return out;
}

function isUsefulModelJson(value: unknown): boolean {
	const rec = asJsonRecord(value);
	if (!rec) return false;
	return (
		Array.isArray(rec.items) ||
		'summary' in rec ||
		'source' in rec ||
		'caption' in rec ||
		'issues' in rec ||
		'questions' in rec
	);
}

export function extractJsonObject(text: string): unknown {
	const values = collectJsonValues(text).flatMap(unwrapModelJson);
	if (!values.length) throw new Error('Model did not return JSON');
	return values.find(isUsefulModelJson) ?? values[0];
}

function clamp01(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.min(1, Math.max(0, n));
}

function num(v: unknown): number {
	if (typeof v === 'number') return v;
	if (typeof v === 'string' && v.trim()) return Number(v);
	return NaN;
}

/** Map model coords (0-1, 0-100, 0-1000, or pixels) into 0-1 of the crop. */
export function normalizeRect(
	rawX: number,
	rawY: number,
	rawW: number,
	rawH: number,
	imgW: number,
	imgH: number
): { x: number; y: number; w: number; h: number } {
	let x = rawX;
	let y = rawY;
	let w = Number.isFinite(rawW) ? rawW : 0.4;
	let h = Number.isFinite(rawH) ? rawH : 0.04;
	const max = Math.max(x, y, Math.abs(w), Math.abs(h), x + w, y + h);
	if (max > 1.5) {
		if (max <= 100.5) {
			x /= 100;
			y /= 100;
			w /= 100;
			h /= 100;
		} else if (max <= 1000.5) {
			x /= 1000;
			y /= 1000;
			w /= 1000;
			h /= 1000;
		} else {
			x /= imgW || 1;
			w /= imgW || 1;
			y /= imgH || 1;
			h /= imgH || 1;
		}
	}
	// x2,y2 rather than width/height
	if (w > x && h > y && w <= 1.0001 && h <= 1.0001 && x + w > 1.02) {
		w = w - x;
		h = h - y;
	}
	x = clamp01(x);
	y = clamp01(y);
	w = Math.min(1 - x, Math.max(0.04, clamp01(w) || 0.4));
	h = Math.min(1 - y, Math.max(0.012, clamp01(h) || 0.04));
	return { x, y, w, h };
}

export function normalizeLineType(raw: string | undefined): LineType {
	const v = (raw || '').trim();
	if ((LINE_TYPES as string[]).includes(v)) return v as LineType;
	const lower = v.toLowerCase();
	if (lower.includes('sfx') || lower.includes('sound')) return '::';
	if (lower.includes('thought')) return '()';
	if (lower.includes('system')) return '<>';
	if (lower.includes('box') || lower.includes('narrat')) return '[]';
	if (lower.includes('aside')) return '//';
	if (lower === 'note' || lower.includes('note')) return 'note';
	if (lower === 'ot' || lower.includes('title')) return 'OT';
	if (lower === 'st' || lower.includes('subtitle')) return 'ST';
	if (lower.includes('dialog')) return '""';
	return 'plain';
}

export function parseBoxes(
	payload: unknown,
	imgW = 1,
	imgH = 1
): DetectedBox[] {
	const root = payload && typeof payload === 'object' ? (payload as { boxes?: unknown }) : {};
	const list = Array.isArray(root.boxes) ? root.boxes : Array.isArray(payload) ? payload : [];
	const out: DetectedBox[] = [];
	for (const item of list) {
		if (!item || typeof item !== 'object') continue;
		const row = item as Record<string, unknown>;
		const source = String(row.source || '').trim();
		if (!source) continue;
		const bbox = row.bbox ?? row.box ?? row.rect;
		let rawX = num(row.x);
		let rawY = num(row.y);
		let rawW = num(row.w ?? row.width);
		let rawH = num(row.h ?? row.height);
		if (Array.isArray(bbox) && bbox.length >= 4) {
			rawX = num(bbox[0]);
			rawY = num(bbox[1]);
			rawW = num(bbox[2]);
			rawH = num(bbox[3]);
			if (rawW > rawX && rawH > rawY) {
				rawW = rawW - rawX;
				rawH = rawH - rawY;
			}
		} else if (Number.isFinite(num(row.x2)) && Number.isFinite(num(row.y2))) {
			rawW = num(row.x2) - rawX;
			rawH = num(row.y2) - rawY;
		}
		const rect = normalizeRect(rawX, rawY, rawW, rawH, imgW, imgH);
		out.push({
			...rect,
			lineType: normalizeLineType(String(row.lineType || '')),
			source,
			literal: String(row.literal || '').trim(),
			translation: normalizeTranslation(String(row.translation || '').trim()),
			reasoning: String(row.reasoning || '').trim()
		});
	}
	return out;
}

export function isDrawnSfx(box: DetectedBox): boolean {
	if (box.lineType === '::') return true;
	const hasScript = /[\u3000-\u9fff\uac00-\ud7af]/.test(box.source);
	if (hasScript) return false;
	if (['""', '[]', '<>', '()', 'OT', 'ST', 'note'].includes(box.lineType)) return false;
	return true;
}

export function parseTranslations(
	payload: unknown
): Map<number, { literal: string; translation: string; reasoning: string }> {
	const root = payload && typeof payload === 'object' ? (payload as { items?: unknown }) : {};
	const list = Array.isArray(root.items) ? root.items : Array.isArray(payload) ? payload : [];
	const out = new Map<number, { literal: string; translation: string; reasoning: string }>();
	list.forEach((item, idx) => {
		if (!item || typeof item !== 'object') return;
		const row = item as Record<string, unknown>;
		const translation = normalizeTranslation(String(row.translation || '').trim());
		if (!translation) return;
		const i = Number.isInteger(row.i) ? (row.i as number) : Number.isInteger(Number(row.i)) ? Number(row.i) : idx;
		if (out.has(i)) return;
		out.set(i, {
			literal: String(row.literal || '').trim(),
			translation,
			reasoning: String(row.reasoning || '').trim()
		});
	});
	return out;
}

/** Missing items keep existing English. Never copy source into the translation field. */
export function applyTranslationHits(
	boxes: DetectedBox[],
	parsed: Map<number, { literal: string; translation: string; reasoning: string }>,
	opts?: { requireTranslation?: boolean }
): DetectedBox[] {
	return boxes.map((box, i) => {
		const hit = parsed.get(i);
		if (!hit && opts?.requireTranslation)
			throw new Error('Model returned no translation for the corrected source. Previous English was preserved.');
		if (!hit) return { ...box };
		return { ...box, literal: hit.literal, translation: hit.translation, reasoning: hit.reasoning };
	});
}

export function missingTranslationIndexes(
	boxes: DetectedBox[],
	parsed: Map<number, unknown>
): number[] {
	return boxes.map((_, i) => i).filter((i) => !parsed.has(i));
}

export async function chatCompletions(
	messages: ChatMessage[],
	opts: {
		abort?: AbortSignal;
		schema?: unknown;
		temperature?: number;
		maxTokens?: number;
		thinking?: boolean;
		model?: string;
	}
): Promise<string> {
	assertGeneralModel(opts.model);
	const override = currentAssistantHttp();
	if (override?.profile === 'openai') {
		return openaiChatCompletions(messages, {
			config: { ...override, model: opts.model || override.model },
			abort: opts.abort,
			schema: opts.schema,
			temperature: opts.temperature,
			maxTokens: opts.maxTokens,
			thinking: opts.thinking,
		});
	}
	const cfg = override?.profile === 'llamacpp'
		? { url: override.baseUrl, apiKey: override.apiKey, model: override.model }
		: llmConfig();
	const url = `${cfg.url.replace(/\/$/, '')}/chat/completions`;
	const thinking = opts.thinking !== false;
	const body: Record<string, unknown> = {
		model: opts.model || cfg.model,
		messages,
		temperature: opts.temperature ?? 0.3,
		max_tokens: opts.maxTokens ?? 8192,
		cache_prompt: true,

	};
	if (override?.requestPreset === 'qwen-thinking') body.chat_template_kwargs = { enable_thinking: thinking, reasoning_effort: thinking ? 'medium' : 'none' };
	if (opts.schema) body.response_format = opts.schema;

	const request = sanitizeLlmMessages(messages);
	const started = Date.now();
	const trace = (raw?: string, error?: string) => {
		const ctx = jobContext();
		if (!ctx) return;
		const summary = summarizeModelOutput(raw, Date.now() - started);
		appendJobLog(ctx.jobId, {
			engine: override?.rowId || cfg.model,
			model: opts.model || cfg.model,
			request,
			response: summary.response,
			usage: summary.usage,
			error,
		});
	};

	for (let attempt = 0; attempt <= SWAP_RETRY_LIMIT; attempt++) {
		if (opts.abort?.aborted) throw new Error('Cancelled');
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), TILE_TIMEOUT_MS);
		const onAbort = () => ctrl.abort();
		opts.abort?.addEventListener('abort', onAbort, { once: true });
		try {
			const headers: Record<string, string> = { 'content-type': 'application/json' };
			if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
			const res = await fetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: ctrl.signal
			});
			const text = await res.text();
			if (res.ok) {
				const json = JSON.parse(text) as {
					choices?: Array<{ message?: { content?: string | Array<{ text?: string }>; reasoning_content?: string } }>;
				};
				const msg = json.choices?.[0]?.message;
				const content = msg?.content;
				const asText =
					typeof content === 'string'
						? content
						: Array.isArray(content)
							? content.map((c) => c.text || '').join('\n')
							: '';
				const out = asText.trim() || String(msg?.reasoning_content || '').trim();
				trace(text);
				return out;
			}
			if (attempt < SWAP_RETRY_LIMIT && isLoadingStatus(res.status, text)) {
				await sleep(SWAP_RETRY_MS);
				continue;
			}
			throw new Error(`llama-swap ${res.status}: ${text}`);
		} catch (e) {
			if (opts.abort?.aborted) throw new Error('Cancelled');
			const message = e instanceof Error ? e.message : String(e);
			const swapping = /ECONNREFUSED|fetch failed|network|socket/i.test(message);
			if (attempt < SWAP_RETRY_LIMIT && swapping) {
				await sleep(SWAP_RETRY_MS);
				continue;
			}
			trace(undefined, message);
			throw e instanceof Error ? e : new Error(message);
		} finally {
			clearTimeout(timer);
			opts.abort?.removeEventListener('abort', onAbort);
		}
	}
	throw new Error('llama-swap timed out while loading the model');
}

export function detectPrompt(opts: {
	pageLabel: string;
	width: number;
	height: number;
	lang?: OcrLang;
}): string {
	const types = LINE_TYPES.map((t) => `${JSON.stringify(t)} = ${LINE_TYPE_LABELS[t]}`).join(', ');
	const japanese = opts.lang === 'japanese';
	const medium = japanese ? 'manga/webtoon' : 'webtoon/manhwa';
	const glyphs = japanese ? 'Japanese/Chinese/etc' : 'Korean/Chinese/etc';
	const sfx = japanese ? 'big ドン, バン, ゴゴゴ, ザワ, cracks, etc.' : 'big 쿵, 쨍, 덥석, 탈, cracks, etc.';
	return `You are locating text on a ${medium} crop (${opts.width}×${opts.height} px).

Box ONLY:
- speech bubbles, thought bubbles, narration boxes, titles, system/UI windows, signs, credits
- screams or short cries that are inside a bubble

Do NOT box:
- drawn onomatopoeia / SFX that is part of the artwork (${sfx})
- pure illustration with no glyphs

For each region:
- x,y = top-left of the bubble (0-1 fractions of THIS crop; not pixels; not 0-1000)
- w,h = size as 0-1 fractions
- source = the ORIGINAL glyphs as written (${glyphs}). NEVER translate here. NEVER rewrite into English.
- lineType: one of ${types}. Tag drawn SFX as "::" if you accidentally include one.

Return ONLY JSON {"boxes":[...]} . Empty crop → {"boxes":[]}.

Page: ${opts.pageLabel}`;
}

export function sourceLangLabel(lang?: OcrLang): string {
	return lang === 'japanese' ? 'Japanese' : 'Korean';
}

export function readBubbleCopy(lang?: OcrLang): { system: string; user: string } {
	const glyphs = lang === 'japanese' ? 'Japanese kana/kanji' : 'Korean Hangul';
	return {
		system: `You read ${lang === 'japanese' ? 'manga' : 'webtoon'} lettering. Copy the original ${glyphs} exactly. Never translate. Return JSON {source, lineType}. Empty or non-text → source "".`,
		user: `This crop is one speech bubble or sound effect. Copy the original text as written (${glyphs}). Do not translate. Do not add English. lineType: "" = dialogue, () = thought, [] = narration, :: = SFX, note = note, OT/ST/plain as appropriate. If there is no readable text, source must be empty.`
	};
}

export function parseReadPayload(payload: unknown): { source: string; lineType: LineType } {
	const rec = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
	return {
		source: String(rec.source || rec.text || rec.ocr || '').trim(),
		lineType: normalizeLineType(String(rec.lineType || rec.type || '""'))
	};
}

export function translateSystemPrompt(lang?: OcrLang): string {
	const kind = lang === 'japanese' ? 'manga' : 'webtoon';
	return `You translate ${kind} scripts from ${sourceLangLabel(lang)} into English. Return a single JSON object with an items array. Same i as the script. No markdown.`;
}

export function translatePrompt(opts: {
	seriesNotes: string;
	prior: string;
	pageLabel: string;
	lines: { i: number; lineType: LineType; source: string; speaker?: string }[];
	lang?: OcrLang;
	pageCaption?: string;
	seriesGlossary?: string;
}): string {
	const script = opts.lines.map((l) => `[${l.i}] (${l.lineType})${l.speaker ? ` Speaker: ${l.speaker}\nSource:` : ''} ${l.source}`).join('\n');
	const lang = opts.lang === 'japanese' ? 'japanese' : 'korean';
	const faithful =
		lang === 'japanese'
			? '- Faithful to the SOURCE TEXT, not to a guessed scene. Recover omitted subjects from neighboring lines when Japanese drops them. Honorifics and speech-level should land as natural English voice, not word-for-word.'
			: '- Faithful to the SOURCE TEXT, not to a guessed scene. 꺼 = off/turn off, 켜 = on/turn on. Do not invert meaning.';
	const sourceHint =
		lang === 'japanese'
			? '- source is Japanese (or mixed kana/kanji/English). If a line looks like English already, it may be bad OCR — use neighboring lines to recover the intended meaning.'
			: '- source may be Korean (or mixed). If a line looks like English already, it may be bad OCR — use neighboring lines to recover the intended meaning.';
	const medium = lang === 'japanese' ? 'manga' : 'webtoon';
	return `You are a professional scanlation translator. Translate this ${medium} script in reading order.

Rules:
${faithful}
- Natural publishable English, character voice, consistent names.
- Honor supplied speaker labels and canonical name spellings. Speakers are not necessarily the people addressed. Do not invent unassigned speakers or add speaker labels to the translated lettering.
- Use only regular ASCII hyphens (-), never em dashes, en dashes, or other Unicode dash variants in English.
${sourceHint}
- Keep the same item count and the same i values.

Write for each item:
- literal: word-for-word English
- translation: the line to letter
- reasoning: one short sentence on tone or uncertainty

Page: ${opts.pageLabel}
${opts.pageCaption ? `Page scene:\n${opts.pageCaption}\n` : ''}${opts.seriesNotes ? `Series notes:\n${opts.seriesNotes}\n` : ''}${opts.seriesGlossary ? `Series names/terms (keep these):\n${opts.seriesGlossary}\n` : ''}${opts.prior ? `Preceding translations from this chapter (keep names consistent):\n${opts.prior}\n` : ''}
Script:
${script}`;
}

export async function detectTileBoxes(
	jpeg: Buffer,
	prompt: string,
	abort?: AbortSignal,
	size?: { width: number; height: number }
): Promise<DetectedBox[]> {
	const dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
	const imgW = size?.width || 1;
	const imgH = size?.height || 1;
	const messages: ChatMessage[] = [
		{
			role: 'system',
			content:
				'You locate webtoon text and copy original glyphs. Return a single JSON object with a boxes array. Coordinates are 0-1 of the crop. No translation. No markdown.'
		},
		{
			role: 'user',
			content: [
				{ type: 'text', text: prompt },
				{ type: 'image_url', image_url: { url: dataUrl } }
			]
		}
	];
	try {
		const text = await chatCompletions(messages, {
			abort,
			schema: DETECT_SCHEMA,
			temperature: 0.1,
			maxTokens: 4096,
			thinking: false
		});
		return parseBoxes(extractJsonObject(text), imgW, imgH);
	} catch (e) {
		if (abort?.aborted) throw new Error('Cancelled');
		const message = e instanceof Error ? e.message : String(e);
		const retryBare =
			message.includes('llama-swap') || /json/i.test(message) || /response_format/i.test(message);
		if (!retryBare) throw e;
		const text = await chatCompletions(messages, {
			abort,
			temperature: 0.1,
			maxTokens: 4096,
			thinking: false
		});
		return parseBoxes(extractJsonObject(text), imgW, imgH);
	}
}

export async function readBubble(
	jpeg: Buffer,
	abort?: AbortSignal,
	model?: string,
	lang?: OcrLang
): Promise<{ source: string; lineType: LineType }> {
	const dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
	const copy = readBubbleCopy(lang);
	const messages: ChatMessage[] = [
		{ role: 'system', content: copy.system },
		{
			role: 'user',
			content: [
				{ type: 'text', text: copy.user },
				{ type: 'image_url', image_url: { url: dataUrl } }
			]
		}
	];
	const parse = (text: string) => parseReadPayload(extractJsonObject(text));
	try {
		const text = await chatCompletions(messages, {
			abort,
			schema: READ_SCHEMA,
			temperature: 0,
			maxTokens: 512,
			thinking: false,
			model
		});
		return parse(text);
	} catch (e) {
		if (abort?.aborted) throw new Error('Cancelled');
		const message = e instanceof Error ? e.message : String(e);
		if (!message.includes('llama-swap') && !/json/i.test(message)) throw e;
		const text = await chatCompletions(messages, {
			abort,
			temperature: 0,
			maxTokens: 512,
			thinking: false,
			model
		});
		return parse(text);
	}
}

export type TranslateScriptOpts = {
	requireTranslation?: boolean;
	seriesNotes: string;
	prior: string;
	pageLabel: string;
	abort?: AbortSignal;
	model?: string;
	lang?: OcrLang;
	pageCaption?: string;
	seriesGlossary?: string;
	/** Specialist sampling override. Hy-MT defaults to 0.15 when unset. */
	temperature?: number;
};

async function requestTranslationMap(
	boxes: DetectedBox[],
	indexes: number[],
	opts: TranslateScriptOpts
): Promise<Map<number, { literal: string; translation: string; reasoning: string }>> {
	if (!indexes.length) return new Map();
	const prompt = translatePrompt({
		seriesNotes: opts.seriesNotes,
		prior: opts.prior,
		pageLabel: opts.pageLabel,
		lines: indexes.map((i) => ({ i, lineType: boxes[i].lineType, source: boxes[i].source, speaker: boxes[i].speaker })),
		lang: opts.lang,
		pageCaption: opts.pageCaption,
		seriesGlossary: opts.seriesGlossary
	});
	const messages: ChatMessage[] = [
		{
			role: 'system',
			content: translateSystemPrompt(opts.lang)
		},
		{ role: 'user', content: prompt }
	];
	try {
		const text = await chatCompletions(messages, {
			abort: opts.abort,
			schema: TRANSLATE_SCHEMA,
			temperature: 0.3,
			maxTokens: 8192,
			thinking: true,
			model: opts.model
		});
		return parseTranslations(extractJsonObject(text));
	} catch (e) {
		if (opts.abort?.aborted) throw new Error('Cancelled');
		const message = e instanceof Error ? e.message : String(e);
		const retryBare =
			message.includes('llama-swap') || /json/i.test(message) || /response_format/i.test(message);
		if (!retryBare) throw e;
		const text = await chatCompletions(messages, {
			abort: opts.abort,
			temperature: 0.3,
			maxTokens: 8192,
			thinking: true,
			model: opts.model
		});
		return parseTranslations(extractJsonObject(text));
	}
}

export async function translateScript(
	boxes: DetectedBox[],
	opts: TranslateScriptOpts
): Promise<DetectedBox[]> {
	if (!boxes.length) return boxes;
	const specialist = translationModel(opts.model);
	if (specialist) return translateWithSpecialist(specialist, boxes, opts);
	const nextOpts = { ...opts, seriesGlossary: withSfxGlossary(opts.seriesGlossary, boxes.map((box) => box.source)) };
	const parsed = new Map<number, { literal: string; translation: string; reasoning: string }>();
	const need: number[] = [];
	for (let i = 0; i < boxes.length; i++) {
		const sfx = sfxTranslateHit(boxes[i].source);
		if (sfx) parsed.set(i, sfx);
		else need.push(i);
	}
	if (need.length) {
		let modelHits = await requestTranslationMap(boxes, need, nextOpts);
		for (const [i, hit] of modelHits) parsed.set(i, hit);
		let missing = need.filter((i) => !parsed.has(i));
		if (missing.length && !opts.requireTranslation) {
			try {
				const retry = await requestTranslationMap(boxes, missing, nextOpts);
				for (const [i, hit] of retry) {
					if (!parsed.has(i)) parsed.set(i, hit);
				}
			} catch (e) {
				if (opts.abort?.aborted) throw e instanceof Error ? e : new Error(String(e));
			}
			missing = need.filter((i) => !parsed.has(i));
		}
		if (missing.length && !opts.requireTranslation) {
			console.warn(
				`[translate] omitted ${missing.length} of ${boxes.length} lines (${missing.join(', ')})`
			);
		}
	}
	return applyTranslationHits(boxes, parsed, nextOpts);
}

export type ProofreadItem = {
  speaker?: string;
	i: number;
	page: string;
	lineType: LineType;
	source: string;
	literal: string;
	current: string;
	notes: string;
};

export function proofreadSystemPrompt(): string {
	return 'You are a scanlation editor and English proofreader. Check every line for spelling, grammar, punctuation, and awkward phrasing, then correct it into natural, publishable lettering while preserving meaning and character voice. Return a single JSON object with an items array. Same i as the rewrite list. No markdown.';
}

export function proofreadPrompt(opts: {
	seriesNotes: string;
	seriesGlossary: string;
	prior: string;
	pages: string;
	settled: string;
	items: ProofreadItem[];
	lang?: OcrLang;
}): string {
	const lang = opts.lang === 'japanese' ? 'Japanese' : 'Korean';
	const script = opts.items
		.map((l) => {
			const bits = [`[${l.i}] (${l.lineType}) ${l.page}`];
			if (l.speaker) bits.push(`speaker: ${l.speaker}`);
			if (l.source) bits.push(`source: ${l.source}`);
			if (l.literal) bits.push(`literal: ${l.literal}`);
			bits.push(`current: ${l.current || '(empty)'}`);
			if (l.notes) bits.push(`notes: ${l.notes}`);
			return bits.join('\n');
		})
		.join('\n\n');
	return `You are editing an already-translated ${lang} ${opts.lang === 'japanese' ? 'manga' : 'webtoon'} chapter.

Proofread the current English in every rewrite item. The supplied scene notes, source text, first-pass literals, and earlier lettering are context; the rewrite list may cover only part of the chapter.

Rules:
- First check every current line for misspelled words, typos, missing or repeated words, grammar, and punctuation. Correct obvious English errors even when source text or a literal is missing.
- Then check phrasing: fix unnatural word order, clumsy expressions, and overly literal wording. A line can convey the right meaning and still need an English edit.
- Keep the SOURCE meaning. Do not invent plot, speakers, or jokes that are not in the source or scene notes.
- When source is absent, preserve the current English meaning. Preserve intentional slang, dialect, stutters, and character voice; do not treat glossary names or stylized SFX as spelling errors.
- Prefer natural lettering over word-for-word English. Compress, rephrase, and drop crib artifacts.
- The Literal line is a crib only. Do not copy it unless it already letters well.
- Keep glossary names/terms exactly.
- Honor human-assigned speakers and canonical character-name spellings. Speaker labels identify who speaks, not who is addressed. Do not guess unassigned speakers or change name hyphenation.
- Same character should sound like the same person across pages.
- Pronouns, tense, and facts must not contradict scene notes or earlier lines.
- SFX stay short and punchy. Thoughts stay interior. Narration stays narration.
- Return a line unchanged only after checking both correctness and natural phrasing. Do not rewrite clean dialogue just for variety.
- Same item count and the same i values. Do not add or drop lines.

Write for each rewrite item:
- literal: copy the given literal (or a short crib if it was empty)
- translation: the line to letter
- reasoning: one short sentence on what you changed, or "kept"

${opts.seriesNotes ? `Series notes:\n${opts.seriesNotes}\n\n` : ''}${opts.seriesGlossary ? `Series names/terms (keep these):\n${opts.seriesGlossary}\n\n` : ''}${opts.prior ? `Preceding translations from this chapter (keep names consistent):\n${opts.prior}\n\n` : ''}${opts.pages ? `Scene notes by page:\n${opts.pages}\n\n` : ''}${opts.settled ? `Already settled (do not return these):\n${opts.settled}\n\n` : ''}Rewrite these:
${script}`;
}

/** Missing output is a failed check, never evidence that a line needs no changes. */
export function parseProofreadTranslations(payload: unknown, items: ProofreadItem[]) {
	const root = payload && typeof payload === 'object' ? payload as { items?: unknown } : {};
	const rows = Array.isArray(root.items) ? root.items : Array.isArray(payload) ? payload : [];
	const expected = new Set(items.map(item => item.i));
	const seen = new Set<number>();
	for (const row of rows) {
		const i = row?.i;
		if (!Number.isInteger(i) || !expected.has(i) || seen.has(i))
			throw new Error('Proofreading returned invalid or duplicate line IDs. Retry proofreading.');
		seen.add(i);
	}
	const parsed = parseTranslations(payload);
	const missing = items.filter(item => !parsed.has(item.i));
	if (missing.length)
		throw new Error(`Proofreading returned no text for ${missing.length} of ${items.length} lines. Retry proofreading.`);
	return parsed;
}

export async function proofreadScript(
	items: ProofreadItem[],
	opts: {
		seriesNotes: string;
		seriesGlossary: string;
		prior: string;
		pages: string;
		settled: string;
		abort?: AbortSignal;
		model?: string;
		lang?: OcrLang;
	}
): Promise<Map<number, { translation: string; reasoning: string }>> {
	if (!items.length) return new Map();
	const messages: ChatMessage[] = [
		{ role: 'system', content: proofreadSystemPrompt() },
		{
			role: 'user',
			content: proofreadPrompt({
				seriesNotes: opts.seriesNotes,
				seriesGlossary: opts.seriesGlossary,
				prior: opts.prior,
				pages: opts.pages,
				settled: opts.settled,
				items,
				lang: opts.lang
			})
		}
	];
	const parse = (text: string) => {
		const parsed = parseProofreadTranslations(extractJsonObject(text), items);
		const out = new Map<number, { translation: string; reasoning: string }>();
		for (const [i, hit] of parsed) out.set(i, { translation: hit.translation, reasoning: hit.reasoning });
		return out;
	};
	try {
		const text = await chatCompletions(messages, {
			abort: opts.abort,
			schema: TRANSLATE_SCHEMA,
			temperature: 0.4,
			maxTokens: 8192,
			thinking: true,
			model: opts.model
		});
		return parse(text);
	} catch (e) {
		if (opts.abort?.aborted) throw new Error('Cancelled');
		const message = e instanceof Error ? e.message : String(e);
		const retryBare =
			message.includes('llama-swap') || /json/i.test(message) || /response_format/i.test(message);
		if (!retryBare) throw e;
		const text = await chatCompletions(messages, {
			abort: opts.abort,
			temperature: 0.4,
			maxTokens: 8192,
			thinking: true,
			model: opts.model
		});
		return parse(text);
	}
}

export function alternativesSystemPrompt(): string {
	return 'You are a scanlation localizer. Propose alternative English letterings for one line. Return a single JSON object with an items array. No markdown.';
}

export function alternativesPrompt(opts: {
	seriesNotes: string;
	seriesGlossary: string;
	prior: string;
	pages: string;
	script: string;
	source: string;
	current: string;
	fresh: string;
	lineType: string;
	page: string;
	lang?: OcrLang;
}): string {
	const lang = opts.lang === 'japanese' ? 'Japanese' : 'Korean';
	return `Propose at least 4 different English letterings for this one ${lang} line. Read the scene, then decide how this moment should sound in a published English edition.

Most suggestions must be localized: natural English a character would actually say, or narration a reader would actually read. A dictionary gloss is not the goal. "I shall commence" is a gloss; "I'll start" and "Let's get going" are localized. Offer that kind of spread: one tighter and more specific, one more spoken, one shorter if the balloon is small. They must not be four wordings of the same sentence.

Include exactly one close literal reading so the editor can see the source meaning. Start that item's reasoning with "Literal reading."

Rules:
- Use the transcription, the current English, and the scene description. The current English may be too literal. Do not treat it as correct.
- Do not invent plot, speakers, or jokes that the transcription and scene do not support.
- Do not repeat the current English.
- Keep glossary names and terms exactly.
- Use only regular ASCII hyphens (-), never em dashes or en dashes.
- The same character should still sound like the same person.
- SFX stay short. Thoughts stay interior. Narration stays narration.
- Return at least 4 items, i starting at 0. More is fine when the readings are genuinely different.

Write for each item:
- literal: a short crib of the source (the same crib on every item is fine)
- translation: the English lettering
- reasoning: one short sentence on how this take fits the scene, or "Literal reading."

${opts.seriesNotes ? `Series notes:\n${opts.seriesNotes}\n\n` : ''}${opts.seriesGlossary ? `Series names/terms (keep these):\n${opts.seriesGlossary}\n\n` : ''}${opts.prior ? `Preceding translations from this chapter (keep names consistent):\n${opts.prior}\n\n` : ''}${opts.script ? `Nearby chapter script (do not rewrite these):\n${opts.script}\n\n` : ''}This line (${opts.lineType}) ${opts.page}:
transcription: ${opts.source || '(empty)'}
current English: ${opts.current || '(empty)'}
scene description:
${opts.pages || '(none)'}`;
}

export async function suggestAlternativesScript(
	opts: {
		seriesNotes: string;
		seriesGlossary: string;
		prior: string;
		pages: string;
		script: string;
		source: string;
		current: string;
		fresh: string;
		lineType: string;
		page: string;
		abort?: AbortSignal;
		model?: string;
		lang?: OcrLang;
	},
): Promise<{ translation: string; reasoning: string }[]> {
	const messages: ChatMessage[] = [
		{ role: 'system', content: alternativesSystemPrompt() },
		{ role: 'user', content: alternativesPrompt(opts) },
	];
	const parse = (text: string) =>
		[...parseTranslations(extractJsonObject(text)).values()].map((hit) => ({
			translation: hit.translation,
			reasoning: hit.reasoning,
		}));
	try {
		const text = await chatCompletions(messages, {
			abort: opts.abort,
			schema: TRANSLATE_SCHEMA,
			temperature: 0.8,
			maxTokens: 4096,
			thinking: true,
			model: opts.model,
		});
		return parse(text);
	} catch (e) {
		if (opts.abort?.aborted) throw new Error('Cancelled');
		const message = e instanceof Error ? e.message : String(e);
		const retryBare =
			message.includes('llama-swap') || /json/i.test(message) || /response_format/i.test(message);
		if (!retryBare) throw e;
		const text = await chatCompletions(messages, {
			abort: opts.abort,
			temperature: 0.8,
			maxTokens: 4096,
			thinking: true,
			model: opts.model,
		});
		return parse(text);
	}
}

export function reviewSystemPrompt(): string {
	return 'You are a scanlation editor reviewing an already-translated chapter. Do not rewrite lettering. Return a single JSON object with summary, issues, questions, and notes. No markdown.';
}

export function reviewPrompt(opts: {
	seriesNotes: string;
	seriesGlossary: string;
	prior: string;
	pages: string;
	script: string;
	lang?: OcrLang;
}): string {
	const lang = opts.lang === 'japanese' ? 'Japanese' : 'Korean';
	return `You are reviewing a ${lang} ${opts.lang === 'japanese' ? 'manga' : 'webtoon'} scanlation. This is read-only. Do not produce new lettering.

Look at scene notes, source text, literals, and current English together.

Report:
- summary: 2–5 sentences on overall consistency, voice, and meaning
- issues: real problems only — name drift, pronoun/plot contradictions, source meaning flipped, tone that does not match the scene, missing or leftover crib artifacts. Include page and line index when you can. severity info/warn/error.
- questions: things a human should decide (ambiguous speakers, jokes, honorifics, whether a line should stay odd)
- notes: your reasoning. What you checked. What looked fine.

If the chapter is solid, say so and return empty issues/questions.
Do not invent problems. Do not "fix" by rewriting.

${opts.seriesNotes ? `Series notes:\n${opts.seriesNotes}\n\n` : ''}${opts.seriesGlossary ? `Series names/terms (keep these):\n${opts.seriesGlossary}\n\n` : ''}${opts.prior ? `Preceding translations from this chapter (keep names consistent):\n${opts.prior}\n\n` : ''}${opts.pages ? `Scene notes by page:\n${opts.pages}\n\n` : ''}The script below is the full chapter unless a [truncated] marker appears. Do not claim later pages are missing unless that marker is present.

Script:
${opts.script}`;
}

export function parseReviewPayload(payload: unknown): {
	summary: string;
	issues: { page: string; line?: number; severity: 'info' | 'warn' | 'error'; text: string }[];
	questions: { page: string; text: string }[];
	notes: string;
} {
	let rec = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
	if (!rec.summary && rec.review && typeof rec.review === 'object') {
		rec = rec.review as Record<string, unknown>;
	}
	const sev = (v: unknown): 'info' | 'warn' | 'error' =>
		v === 'error' || v === 'warn' || v === 'info' ? v : 'info';
	const issues = Array.isArray(rec.issues)
		? rec.issues.flatMap((item) => {
				if (typeof item === 'string' && item.trim()) {
					return [{ page: 'chapter', severity: 'info' as const, text: item.trim() }];
				}
				if (!item || typeof item !== 'object') return [];
				const row = item as Record<string, unknown>;
				const text = String(row.text || row.message || row.issue || '').trim();
				if (!text) return [];
				const line = Number(row.line);
				return [
					{
						page: String(row.page || '').trim() || 'chapter',
						...(Number.isFinite(line) ? { line } : {}),
						severity: sev(row.severity),
						text
					}
				];
			})
		: [];
	const questions = Array.isArray(rec.questions)
		? rec.questions.flatMap((item) => {
				if (typeof item === 'string' && item.trim()) {
					return [{ page: 'chapter', text: item.trim() }];
				}
				if (!item || typeof item !== 'object') return [];
				const row = item as Record<string, unknown>;
				const text = String(row.text || row.question || '').trim();
				if (!text) return [];
				return [{ page: String(row.page || '').trim() || 'chapter', text }];
			})
		: [];
	return {
		summary: String(rec.summary || '').trim(),
		issues,
		questions,
		notes: String(rec.notes || rec.thinking || rec.reasoning || rec.commentary || '').trim()
	};
}

export function reviewFromModelText(text: string): ReturnType<typeof parseReviewPayload> {
	try {
		const parsed = parseReviewPayload(extractJsonObject(text));
		if (parsed.summary || parsed.notes || parsed.issues.length || parsed.questions.length) return parsed;
	} catch {
		/* keep the raw reply so the editor can show it */
	}
	return {
		summary: '',
		issues: [],
		questions: [],
		notes: stripModelFences(text).slice(0, 16000)
	};
}

export async function reviewChapterScript(
	opts: {
		seriesNotes: string;
		seriesGlossary: string;
		prior: string;
		pages: string;
		script: string;
		abort?: AbortSignal;
		model?: string;
		lang?: OcrLang;
	}
): Promise<ReturnType<typeof parseReviewPayload>> {
	const messages: ChatMessage[] = [
		{ role: 'system', content: reviewSystemPrompt() },
		{ role: 'user', content: reviewPrompt(opts) }
	];
	try {
		const text = await chatCompletions(messages, {
			abort: opts.abort,
			schema: REVIEW_SCHEMA,
			temperature: 0.3,
			maxTokens: 8192,
			thinking: true,
			model: opts.model
		});
		return reviewFromModelText(text);
	} catch (e) {
		if (opts.abort?.aborted) throw new Error('Cancelled');
		const message = e instanceof Error ? e.message : String(e);
		const retryBare =
			message.includes('llama-swap') || /json/i.test(message) || /response_format/i.test(message);
		if (!retryBare) throw e;
		const text = await chatCompletions(messages, {
			abort: opts.abort,
			temperature: 0.3,
			maxTokens: 8192,
			thinking: true,
			model: opts.model
		});
		return reviewFromModelText(text);
	}
}

export const DESCRIBE_SYSTEM =
	'You write a short scanlation scene note for a translator. 2–4 sentences: who is visible, where they are, what is happening, and the mood. Never quote, transcribe, or paraphrase lettering — no dialogue, thoughts, SFX, signs, or captions. OCR captures text separately. No markdown.';
export const DESCRIBE_USER =
	'Describe this manga/webtoon page for a translator. Visuals and action only. Do not mention any written words.';

export const COMPACT_NOTES_SYSTEM =
	'You edit scanlation scene notes so a translator gets setting once, then only new action per page. Never quote or paraphrase lettering. Return a single JSON object. No markdown.';

const COMPACT_NOTES_SCHEMA = {
	type: 'json_schema',
	json_schema: {
		name: 'compact_scene_notes',
		strict: true,
		schema: {
			type: 'object',
			additionalProperties: false,
			required: ['chapter', 'pages'],
			properties: {
				chapter: { type: 'string' },
				pages: {
					type: 'array',
					items: {
						type: 'object',
						additionalProperties: false,
						required: ['i', 'caption'],
						properties: {
							i: { type: 'integer' },
							caption: { type: 'string' }
						}
					}
				}
			}
		}
	}
};

export function compactSceneNotesPrompt(captions: { i: number; caption: string }[]): string {
	const listed = captions
		.map((row) => `[${row.i}]\n${row.caption}`)
		.join('\n\n');
	return `These page scene notes repeat the same setting and may mention dialogue. Rewrite them for a translator.

Rules:
- chapter: 1–3 sentences of standing setting and cast that would otherwise be repeated on every page.
- pages: same i values. Each caption is only what is NEW on that page (arrivals, actions, mood shifts, visual details).
- Do not repeat the chapter setting on each page.
- Do not quote, transcribe, or paraphrase any lettering.

Page notes:
${listed}`;
}

export async function compactSceneNotes(
	captions: { i: number; caption: string }[],
	opts?: { abort?: AbortSignal; model?: string }
): Promise<{ chapter: string; pages: { i: number; caption: string }[] }> {
	if (!captions.length) return { chapter: '', pages: [] };
	const messages: ChatMessage[] = [
		{ role: 'system', content: COMPACT_NOTES_SYSTEM },
		{ role: 'user', content: compactSceneNotesPrompt(captions) }
	];
	const parse = (text: string) => {
		const rec = extractJsonObject(text) as {
			chapter?: unknown;
			pages?: Array<{ i?: unknown; caption?: unknown }>;
		};
		const chapter = typeof rec.chapter === 'string' ? rec.chapter.trim() : '';
		const byI = new Map<number, string>();
		for (const row of rec.pages ?? []) {
			const i = Number(row.i);
			if (!Number.isInteger(i) || typeof row.caption !== 'string') continue;
			byI.set(i, row.caption.trim());
		}
		return {
			chapter,
			pages: captions.map((row) => ({
				i: row.i,
				caption: byI.get(row.i) || row.caption
			}))
		};
	};
	try {
		const text = await chatCompletions(messages, {
			abort: opts?.abort,
			schema: COMPACT_NOTES_SCHEMA,
			temperature: 0.2,
			maxTokens: 2048,
			thinking: false,
			model: opts?.model
		});
		return parse(text);
	} catch (e) {
		if (opts?.abort?.aborted) throw new Error('Cancelled');
		const message = e instanceof Error ? e.message : String(e);
		if (!message.includes('llama-swap') && !/json/i.test(message)) throw e;
		const text = await chatCompletions(messages, {
			abort: opts?.abort,
			temperature: 0.2,
			maxTokens: 2048,
			thinking: false,
			model: opts?.model
		});
		return parse(text);
	}
}

export async function llmReachable(): Promise<boolean> {
	const cfg = llmConfig();
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 1500);
	try {
		const headers: Record<string, string> = {};
		if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
		const res = await fetch(`${cfg.url.replace(/\/$/, '')}/models`, {
			headers,
			signal: ctrl.signal
		});
		return res.ok || res.status === 503 || res.status === 409;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

export async function describePage(
	jpeg: Buffer,
	opts?: { abort?: AbortSignal; model?: string }
): Promise<string> {
	const dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
	const messages: ChatMessage[] = [
		{ role: 'system', content: DESCRIBE_SYSTEM },
		{
			role: 'user',
			content: [
				{ type: 'text', text: DESCRIBE_USER },
				{ type: 'image_url', image_url: { url: dataUrl } }
			]
		}
	];
	const text = await chatCompletions(messages, {
		abort: opts?.abort,
		model: opts?.model,
		temperature: 0.2,
		maxTokens: 256,
		thinking: false
	});
	return text.replace(/^["'\s]+|["'\s]+$/g, '').trim();
}
