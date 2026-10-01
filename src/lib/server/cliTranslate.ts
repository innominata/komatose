import { DEFAULT_CHAT_MODEL_ID } from '../modelDefaults';
import { CliAdapterRegistry } from './cliAdapters/registry';
import { createCodexAdapter } from './cliAdapters/codex';
import { createGrokAdapter } from './cliAdapters/grok';
import { createCursorAdapter } from './cliAdapters/cursor';
import type { AdvisoryRequest, TranslationOptions as CliJobOpts } from './cliAdapters/types';
import { buildCodexCleanPrompt } from '../codexCleanPrompt';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
	cliReadiness,
	codexExecutable,
	cursorExecutable,
	discoverCli,
	executablePath,
	grokExecutable,
	isCliToolId,
	spawnProcessEnv,
	type CliToolId
} from './cliDiscovery';
import {
	TRANSLATE_ENGINE_LABELS,
	TRANSLATE_ENGINES,
	type LineType,
	type OcrLang,
	type TranslateEngine,
	type TranslateEngineInfo
} from '../types';
import type { CliProviderId } from '../providerCatalog';
import {
	compactSceneNotesPrompt,
	COMPACT_NOTES_SYSTEM,
	DESCRIBE_SYSTEM,
	DESCRIBE_USER,
	extractJsonObject,
	parseReadPayload,
	reviewFromModelText,
	parseTranslations,
	parseProofreadTranslations,
	applyTranslationHits,
	readBubbleCopy,
	alternativesPrompt,
	alternativesSystemPrompt,
	proofreadPrompt,
	proofreadSystemPrompt,
	reviewPrompt,
	reviewSystemPrompt,
	translatePrompt,
	translateSystemPrompt,
	type DetectedBox,
	type ProofreadItem
} from './llm';
import { sanitizeModelId } from '../aiTasks';
import { isProofreaderProvider } from '../providerCatalog';
import { proofreadServiceConfigured } from './proofreadService';
import { sfxTranslateHit, withSfxGlossary } from '../sfx';
import { komatoseGpuEnabled } from './gpuMode';
import { appendJobLog, jobContext, summarizeModelOutput } from './jobs';
import { cursorAuthError, parseCodexDebugModelsText, parseCursorModelList, parseGrokModelList, parseOpenAiModelList } from '../cliModelLists';

const CLI_TIMEOUT_MS = 10 * 60 * 1000;

const OUTPUT_SCHEMA = {
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
} as const;

const DESCRIBE_OUTPUT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['caption'],
	properties: {
		caption: { type: 'string' }
	}
} as const;

// OpenAI structured outputs reject `"` inside schema string literals, so this
// cannot enum our dialogue token `""`. parseReadPayload normalizes free text.
export const READ_OUTPUT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['source', 'lineType'],
	properties: {
		source: { type: 'string' },
		lineType: { type: 'string' }
	}
} as const;

function cliSystemPrompt(lang?: OcrLang, override?: string): string {
	return `${override || translateSystemPrompt(lang)} Do not use tools.`;
}

function env(name: string): string {
	return (process.env[name] || '').trim();
}

export function grokBin(): string | null {
	return grokExecutable();
}

export function codexBin(): string | null {
	return codexExecutable();
}

export function parseTranslateEngine(raw: unknown): string {
	const value = String(raw ?? '').trim();
	if (!value) throw Object.assign(new Error('Choose a valid engine and model'), { status: 400 });
	return value;
}

export function cursorBin(): string | null {
	return cursorExecutable();
}

function requireCli(id: CliToolId): string {
	const result = discoverCli(id);
	const bin = executablePath(result);
	if (!bin) throw new Error(result.reason);
	return bin;
}

export function listTranslateEngines(): TranslateEngineInfo[] {
	const configured = proofreadServiceConfigured();
	return TRANSLATE_ENGINES.filter((id) => !isProofreaderProvider(id) || configured).map((id) => {
		let available = true;
		let reason: string | undefined;
		if (id !== 'qwen' && !isProofreaderProvider(id)) {
			try {
				if (isCliToolId(id)) {
					const cli = cliReadiness(id);
					available = cli.available;
					reason = cli.reason;
				} else if (cliAdapters.has(id)) {
					const adapter = cliAdapters.get(id);
					available = Boolean(adapter.executable());
					reason = available ? undefined : `${adapter.label} CLI not found`;
				} else {
					available = false;
					reason = 'Engine unavailable';
				}
			} catch {
				available = false;
				reason = 'CLI discovery failed; set the matching *_BIN override to a runnable executable.';
			}
		}
		return {
			id,
			label: id === 'qwen' && komatoseGpuEnabled() ? 'Local HTTP · GPU' : TRANSLATE_ENGINE_LABELS[id],
			available,
			reason,
			pageImageOnly: isProofreaderProvider(id),
		};
	});
}

export function pickCliModel(engine: string, requested?: string): string {
	const asked = sanitizeModelId(requested);
	if (asked) return asked;
	if (cliAdapters.has(engine)) return cliAdapters.get(engine).defaultModel();
	if (isProofreaderProvider(engine)) return '';
	return env('LLAMASWAP_MODEL');
}

function spawnEnv(): NodeJS.ProcessEnv {
	return spawnProcessEnv();
}

function workHasImage(work: string): boolean {
	if (!existsSync(work)) return false;
	try {
		if (readdirSync(work).some((name) => /\.(jpe?g|png|webp|gif)$/i.test(name))) return true;
		const jsonPath = join(work, 'prompt.json');
		if (!existsSync(jsonPath)) return false;
		const acp = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
			content?: Array<{ type?: string }>;
		};
		return (acp.content ?? []).some((part) => part.type === 'image');
	} catch {
		return false;
	}
}

function readWorkPrompt(work: string, stdin?: string): string {
	if (stdin?.trim()) return stdin.trim();
	const txt = join(work, 'prompt.txt');
	if (existsSync(txt)) {
		try {
			const body = readFileSync(txt, 'utf8').trim();
			if (body) return body;
		} catch {
			/* ignore */
		}
	}
	const jsonPath = join(work, 'prompt.json');
	if (existsSync(jsonPath)) {
		try {
			const acp = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
				content?: Array<{ type?: string; text?: string }>;
			};
			const text = (acp.content ?? [])
				.filter((part) => part.type === 'text' && part.text)
				.map((part) => part.text)
				.join('\n\n')
				.trim();
			if (text) return text;
		} catch {
			/* ignore */
		}
	}
	return '';
}

function readWorkOutput(work: string, stdout: string, stderr: string): string {
	const last = join(work, 'last.txt');
	if (existsSync(last)) {
		try {
			const body = readFileSync(last, 'utf8').trim();
			if (body) return body;
		} catch {
			/* ignore */
		}
	}
	return [stdout, stderr].filter((s) => s.trim()).join('\n').trim();
}

function runCommand(opts: {
	bin: string;
	args: string[];
	cwd: string;
	stdin?: string;
	abort?: AbortSignal;
	timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; code: number }> {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		if (opts.abort?.aborted) {
			reject(new Error('Cancelled'));
			return;
		}
		const child = spawn(opts.bin, opts.args, {
			cwd: opts.cwd,
			env: spawnEnv(),
			stdio: [opts.stdin != null ? 'pipe' : 'ignore', 'pipe', 'pipe']
		});
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		const timeoutMs = opts.timeoutMs ?? CLI_TIMEOUT_MS;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGTERM');
		}, timeoutMs);
		const onAbort = () => child.kill('SIGTERM');
		opts.abort?.addEventListener('abort', onAbort, { once: true });
		child.stdout?.on('data', (chunk: Buffer) => {
			stdout += chunk.toString('utf8');
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8');
		});
		const finish = (err?: unknown, result?: { stdout: string; stderr: string; code: number }) => {
			const ctx = jobContext();
			if (ctx) {
				const elapsed = Date.now() - started;
				let request = readWorkPrompt(opts.cwd, opts.stdin);
				if (workHasImage(opts.cwd) && request && !request.includes('[image attached]'))
					request = `${request}\n[image attached]`;
				if (!request) request = `[CLI ${basename(opts.bin)}]`;
				const raw = result ? readWorkOutput(opts.cwd, result.stdout, result.stderr) : '';
				const summary = summarizeModelOutput(raw, elapsed);
				appendJobLog(ctx.jobId, {
					request,
					response: summary.response,
					usage: summary.usage,
					error: err ? String(err) : result && result.code !== 0 ? cliOutput(result) : undefined
				});
			}
			if (err) reject(err instanceof Error ? err : new Error(String(err)));
			else resolve(result!);
		};
		child.on('error', (err) => {
			clearTimeout(timer);
			opts.abort?.removeEventListener('abort', onAbort);
			finish(err);
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			opts.abort?.removeEventListener('abort', onAbort);
			if (opts.abort?.aborted) {
				finish(new Error('Cancelled'));
				return;
			}
			if (timedOut) {
				finish(new Error(`${basename(opts.bin)} timed out`));
				return;
			}
			finish(undefined, { stdout, stderr, code: code ?? 1 });
		});
		if (opts.stdin != null) child.stdin?.end(opts.stdin);
	});
}

function cliOutput(result: { stdout: string; stderr: string }): string {
	return [result.stderr, result.stdout].filter((s) => s.trim()).join('\n').trim();
}

function cliFail(
	name: string,
	result: { code: number; stdout: string; stderr: string }
): never {
	throw new Error(`${name} exited ${result.code}: ${cliOutput(result)}`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseCliJson(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) throw new Error('CLI returned no output');
	const tryExtract = (raw: string) => {
		try {
			return extractJsonObject(raw);
		} catch {
			return null;
		}
	};
	const direct = tryExtract(trimmed);
	const fromObj = (obj: unknown): unknown => {
		const rec = asRecord(obj);
		if (!rec) return obj;
		if (Array.isArray(rec.items)) return rec;
		for (const key of ['result', 'response', 'text', 'message', 'content', 'output']) {
			const val = rec[key];
			if (typeof val === 'string' && val.trim()) {
				const inner = tryExtract(val);
				if (inner) return inner;
			}
			if (val && typeof val === 'object') {
				const nested = asRecord(val);
				if (nested && Array.isArray(nested.items)) return nested;
			}
		}
		return rec;
	};
	if (direct) {
		const rec = asRecord(direct);
		if (rec && Array.isArray(rec.items)) return rec;
		const unwrapped = fromObj(direct);
		if (asRecord(unwrapped) && Array.isArray(asRecord(unwrapped)!.items)) return unwrapped;
	}
	const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i--) {
		const obj = tryExtract(lines[i]);
		if (!obj) continue;
		const rec = asRecord(fromObj(obj));
		if (rec && Array.isArray(rec.items)) return rec;
	}
	if (direct) return fromObj(direct);
	throw new Error('CLI did not return translation JSON');
}



function translationLines(boxes: DetectedBox[], opts: CliJobOpts) {
	return (opts.lineIndexes ?? boxes.map((_, i) => i)).map((i) => ({
		i,
		lineType: boxes[i].lineType,
		source: boxes[i].source,
	}));
}

export type CliEngine = CliProviderId;

/** Structured advisory responses, with explicitly selected image attachments. */
export async function advisoryWithCli(engine: string, opts: AdvisoryRequest): Promise<unknown> {
  return cliAdapters.advisory(engine, { ...opts, model: pickCliModel(engine, opts.model) });
}

export function isCliEngine(engine: string): boolean {
	return cliAdapters.has(engine);
}

function grokHeadlessArgs(work: string): string[] {
	return [
		'--output-format',
		'json',
		'--disable-web-search',
		'--no-memory',
		'--no-plan',
		'--no-subagents',
		'--always-approve',
		'--permission-mode',
		'dontAsk',
		'--max-turns',
		'1',
		'--cwd',
		work,
		'--verbatim'
	];
}

/** Grok parses ACP JSON from --prompt-file, keeping image bytes out of argv
 * (base64 images otherwise hit the OS argument limit and spawn throws E2BIG). */
async function grokImagePromptArgs(work: string, text: string, images: Buffer[]): Promise<string[]> {
	const path = join(work, 'prompt.json');
	await writeFile(path, JSON.stringify({
		type: 'acp',
		content: [
			{ type: 'text', text },
			...images.map(bytes => ({ type: 'image', mimeType: 'image/jpeg', data: bytes.toString('base64') }))
		]
	}), { mode: 0o600 });
	return ['--prompt-file', path];
}

function applyTranslations(boxes: DetectedBox[], payload: unknown, opts: CliJobOpts): DetectedBox[] {
	if (opts.proofreadItems) {
		const parsed = parseProofreadTranslations(payload, opts.proofreadItems);
		return boxes.map((box, i) => {
			const hit = parsed.get(opts.proofreadItems![i].i);
			if (!hit) return { ...box };
			return { ...box, literal: hit.literal, translation: hit.translation, reasoning: hit.reasoning };
		});
	}
	return applyTranslationHits(boxes, parseTranslations(payload), opts);
}

async function translateWithGrok(boxes: DetectedBox[], opts: CliJobOpts): Promise<DetectedBox[]> {
	const bin = requireCli('grok');
	const work = await mkdtemp(join(tmpdir(), 'scan-grok-'));
	const promptPath = join(work, 'prompt.txt');
	const prompt =
		opts.userPrompt ||
		(opts.jpeg ? 'An image of the lettering is attached. Prefer the image if the script disagrees.\n\n' : '') +
			translatePrompt({
				seriesNotes: opts.seriesNotes,
				prior: opts.prior,
				pageLabel: opts.pageLabel,
				lines: translationLines(boxes, opts),
				lang: opts.lang,
				pageCaption: opts.pageCaption,
				seriesGlossary: opts.seriesGlossary
			});
	try {
		const args = [
			'--json-schema',
			JSON.stringify(OUTPUT_SCHEMA),
			'--system-prompt-override',
			cliSystemPrompt(opts.lang, opts.systemPrompt),
			...grokHeadlessArgs(work)
		];
		if (opts.jpeg) {
			args.unshift(...await grokImagePromptArgs(work, prompt, [opts.jpeg]));
		} else {
			await writeFile(promptPath, prompt, 'utf8');
			args.unshift('--prompt-file', promptPath);
		}
		const model = pickCliModel('grok', opts.model);
		if (model) args.push('-m', model);
		const result = await runCommand({ bin, args, cwd: work, abort: opts.abort });
		if (result.code !== 0) {
			cliFail('Grok CLI', result);
		}
		return applyTranslations(boxes, parseCliJson(result.stdout || result.stderr), opts);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

export async function generateCleaningImageWithCodex(opts: {
	image: Buffer;
	mask: Buffer;
	abort?: AbortSignal;
	prompt?: string;
	model?: string;
}): Promise<Buffer> {
	return cliAdapters.clean('codex', opts.image, {
		mask: opts.mask,
		abort: opts.abort,
		model: opts.model || pickCliModel('codex'),
		prompt: opts.prompt,
	});
}

async function cleanImageWithCodex(
	image: Buffer,
	opts: { mask: Buffer; abort?: AbortSignal; model?: string; prompt?: string }
): Promise<Buffer> {
	const bin = requireCli('codex');
	const work = await mkdtemp(join(tmpdir(), 'scan-codex-clean-'));
	const imagePath = join(work, 'artwork.png');
	const maskPath = join(work, 'mask.png');
	const outputPath = join(work, 'cleaned.png');
	const schemaPath = join(work, 'schema.json');
	const lastPath = join(work, 'last.txt');
	const prompt = buildCodexCleanPrompt({
		imagePath,
		maskPath,
		outputPath,
		prompt: opts.prompt,
	});
	try {
		await Promise.all([
			writeFile(imagePath, image),
			writeFile(maskPath, opts.mask),
			writeFile(join(work, 'prompt.txt'), prompt),
			writeFile(schemaPath, JSON.stringify({ type: 'object', additionalProperties: false,
				required: ['error'], properties: { error: { type: 'string' } } }))
		]);
		const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config',
			'--sandbox', 'workspace-write', '--color', 'never', '--enable', 'image_generation',
			'--disable', 'multi_agent', '--disable', 'apps', '--disable', 'plugins',
			'--disable', 'browser_use', '--disable', 'computer_use',
			'-c', 'web_search="disabled"', '-c', 'approval_policy="never"',
			'--output-schema', schemaPath, '-o', lastPath, '-C', work];
		const model = pickCliModel('codex', opts.model);
		if (model) args.push('-m', model);
		args.push('-i', imagePath, maskPath, '--', prompt);
		const result = await runCommand({ bin, args, cwd: work, abort: opts.abort });
		if (result.code !== 0) cliFail('Codex image generation', result);
		const last = existsSync(lastPath) ? await readFile(lastPath, 'utf8') : '';
		const response = asRecord(parseCliJson(last || result.stdout));
		if (response?.error) throw new Error(`Codex image generation: ${response.error}`);
		const file = await lstat(outputPath).catch(() => null);
		if (!file?.isFile() || file.size === 0 || file.size > 50 * 1024 * 1024)
			throw new Error('Codex did not produce a valid cleaned image. Check image generation access in Codex.');
		return await readFile(outputPath);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

async function translateWithCodex(boxes: DetectedBox[], opts: CliJobOpts): Promise<DetectedBox[]> {
	const bin = requireCli('codex');
	const work = await mkdtemp(join(tmpdir(), 'scan-codex-'));
	const schemaPath = join(work, 'schema.json');
	const lastPath = join(work, 'last.txt');
	const cropPath = join(work, 'crop.jpg');
	const prompt =
		`${cliSystemPrompt(opts.lang, opts.systemPrompt)}\n\n` +
		(opts.userPrompt ||
			(opts.jpeg ? 'An image of the lettering is attached. Prefer the image if the script disagrees.\n\n' : '') +
				translatePrompt({
					seriesNotes: opts.seriesNotes,
					prior: opts.prior,
					pageLabel: opts.pageLabel,
					lines: translationLines(boxes, opts),
					lang: opts.lang,
					pageCaption: opts.pageCaption,
					seriesGlossary: opts.seriesGlossary
				}));
	try {
		await writeFile(schemaPath, JSON.stringify(OUTPUT_SCHEMA), 'utf8');
		if (opts.jpeg) await writeFile(cropPath, opts.jpeg);
		const args = [
			'exec',
			'--skip-git-repo-check',
			'--ephemeral',
			'--sandbox',
			'read-only',
			'--color',
			'never',
			'--output-schema',
			schemaPath,
			'-o',
			lastPath,
			'-C',
			work,
			'-c',
			'approval_policy="never"'
		];
		const model = pickCliModel('codex', opts.model);
		if (model) args.push('-m', model);
		// `-i` is variadic and will swallow the next arg as another file
		// unless the prompt is separated with `--`.
		if (opts.jpeg) args.push('-i', cropPath);
		args.push('--', '-');
		const result = await runCommand({ bin, args, cwd: work, stdin: prompt, abort: opts.abort });
		if (result.code !== 0) {
			cliFail('Codex CLI', result);
		}
		const last = existsSync(lastPath) ? await readFile(lastPath, 'utf8') : '';
		return applyTranslations(boxes, parseCliJson(last || result.stdout || result.stderr), opts);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

function parseReadJson(text: string): { source: string; lineType: LineType } {
	const payload = parseCliJson(text);
	return parseReadPayload(payload);
}

function cursorResultText(rec: Record<string, unknown> | null): string | null {
	if (!rec) return null;
	for (const key of ['result', 'response', 'text', 'message', 'content']) {
		const val = rec[key];
		if (typeof val === 'string' && val.trim()) return val.trim();
		if (val && typeof val === 'object') return JSON.stringify(val);
	}
	return null;
}

function parseCursorPrint(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) throw new Error('Cursor CLI returned no output');
	const tryObj = (raw: string): Record<string, unknown> | null => {
		try {
			const v = JSON.parse(raw) as unknown;
			return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
		} catch {
			return null;
		}
	};
	const chunks = [trimmed, ...trimmed.split('\n').map((l) => l.trim()).filter(Boolean)];
	let fallback: string | null = null;
	for (let i = chunks.length - 1; i >= 0; i--) {
		const rec = tryObj(chunks[i]);
		const extracted = cursorResultText(rec);
		if (!extracted) continue;
		if (rec?.type === 'result' || rec?.subtype === 'success') return extracted;
		if (!fallback) fallback = extracted;
	}
	return fallback || trimmed.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

async function runCursorPrompt(opts: {
	prompt: string;
	images?: Buffer[];
	jpeg?: Buffer;
	model?: string;
	abort?: AbortSignal;
}): Promise<string> {
	const bin = requireCli('cursor');
	const work = await mkdtemp(join(tmpdir(), 'scan-cursor-'));
	try {
		await writeFile(join(work, 'prompt.txt'), opts.prompt, 'utf8');
		if (opts.jpeg) await writeFile(join(work, 'image.jpg'), opts.jpeg);
		for (const [i, bytes] of (opts.images ?? []).entries()) await writeFile(join(work, `image-${i + 1}.jpg`), bytes);
		const hint = opts.jpeg
			? 'Follow prompt.txt. The page/crop is image.jpg. Reply with JSON only. Do not edit files.'
			: 'Follow prompt.txt. Reply with JSON only. Do not edit files.';
		const args = [
			'-p',
			'--output-format',
			'json',
			'--mode',
			'ask',
			'--trust',
			'--sandbox',
			'disabled',
			'--workspace',
			work
		];
		const model = pickCliModel('cursor', opts.model);
		if (model) args.push('--model', model);
		args.push(opts.images?.length ? `Follow prompt.txt. Attached images in order: ${opts.images.map((_, i) => `image-${i + 1}.jpg`).join(', ')}. Reply with JSON only. Do not edit files.` : hint);
		const result = await runCommand({ bin, args, cwd: work, abort: opts.abort });
		if (result.code !== 0) {
			cliFail('Cursor CLI', result);
		}
		return parseCursorPrint(result.stdout || result.stderr);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

/** Vision read: send the crop to a named CLI when PaddleOCR cannot. */
async function readWithCursor(
	jpeg: Buffer,
	opts: { lang?: OcrLang; abort?: AbortSignal; model?: string }
): Promise<{ source: string; lineType: LineType }> {
	const copy = readBubbleCopy(opts.lang);
	const text = await runCursorPrompt({
		prompt: `${copy.system}\n\n${copy.user}\nReturn JSON {source, lineType}.`,
		jpeg,
		model: opts.model,
		abort: opts.abort
	});
	return parseReadJson(text);
}

async function readWithGrok(
	jpeg: Buffer,
	opts: { lang?: OcrLang; abort?: AbortSignal; model?: string }
): Promise<{ source: string; lineType: LineType }> {
	const copy = readBubbleCopy(opts.lang);
	const bin = requireCli('grok');
	const work = await mkdtemp(join(tmpdir(), 'scan-grok-read-'));
	try {
		const args = [
			...await grokImagePromptArgs(work, `${copy.system}\n\n${copy.user}`, [jpeg]),
			'--json-schema',
			JSON.stringify(READ_OUTPUT_SCHEMA),
			'--system-prompt-override',
			`${copy.system} Do not use tools.`,
			...grokHeadlessArgs(work)
		];
		const model = pickCliModel('grok', opts.model);
		if (model) args.push('-m', model);
		const result = await runCommand({ bin, args, cwd: work, abort: opts.abort });
		if (result.code !== 0) {
			cliFail('Grok CLI', result);
		}
		return parseReadJson(result.stdout || result.stderr);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

async function readWithCodex(
	jpeg: Buffer,
	opts: { lang?: OcrLang; abort?: AbortSignal; model?: string }
): Promise<{ source: string; lineType: LineType }> {
	const copy = readBubbleCopy(opts.lang);
	const bin = requireCli('codex');
	const work = await mkdtemp(join(tmpdir(), 'scan-codex-read-'));
	const schemaPath = join(work, 'schema.json');
	const lastPath = join(work, 'last.txt');
	const cropPath = join(work, 'crop.jpg');
	try {
		await writeFile(schemaPath, JSON.stringify(READ_OUTPUT_SCHEMA), 'utf8');
		await writeFile(cropPath, jpeg);
		const args = [
			'exec',
			'--skip-git-repo-check',
			'--ephemeral',
			'--sandbox',
			'read-only',
			'--color',
			'never',
			'--output-schema',
			schemaPath,
			'-o',
			lastPath,
			'-C',
			work,
			'-c',
			'approval_policy="never"',
			'-i',
			cropPath
		];
		const model = pickCliModel('codex', opts.model);
		if (model) args.push('-m', model);
		args.push('--', '-');
		const result = await runCommand({
			bin,
			args,
			cwd: work,
			stdin: `${copy.system}\n\n${copy.user}`,
			abort: opts.abort
		});
		if (result.code !== 0) {
			cliFail('Codex CLI', result);
		}
		const last = existsSync(lastPath) ? await readFile(lastPath, 'utf8') : '';
		return parseReadJson(last || result.stdout || result.stderr);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

export async function readBubbleWithCli(
	engine: string,
	jpeg: Buffer,
	opts: { lang?: OcrLang; abort?: AbortSignal; model?: string } = {}
): Promise<{ source: string; lineType: LineType }> {
	return cliAdapters.read(engine, jpeg, { ...opts, model: pickCliModel(engine, opts.model) });
}

async function translateWithCursor(boxes: DetectedBox[], opts: CliJobOpts): Promise<DetectedBox[]> {
	const prompt =
		opts.userPrompt ||
		translatePrompt({
			seriesNotes: opts.seriesNotes,
			prior: opts.prior,
			pageLabel: opts.pageLabel,
			lines: translationLines(boxes, opts),
			lang: opts.lang,
			pageCaption: opts.pageCaption,
			seriesGlossary: opts.seriesGlossary
		});
	const text = await runCursorPrompt({
		prompt: `${opts.systemPrompt || translateSystemPrompt(opts.lang)}\n\n${prompt}\nReturn JSON {items:[{i,literal,translation,reasoning}]}.`,
		jpeg: opts.jpeg,
		model: opts.model,
		abort: opts.abort
	});
	return applyTranslations(boxes, parseCliJson(text), opts);
}

async function translateScriptWithCliOnce(
  engine: string,
  boxes: DetectedBox[],
  opts: CliJobOpts
): Promise<DetectedBox[]> {
  return cliAdapters.translate(engine, boxes, { ...opts, model: pickCliModel(engine, opts.model) });
}

export async function translateScriptWithCli(
	engine: string,
	boxes: DetectedBox[],
	opts: CliJobOpts
): Promise<DetectedBox[]> {
	cliAdapters.requireTranslation(engine);
	opts.abort?.throwIfAborted();
	if (!boxes.length) return boxes;
	const nextOpts = opts.proofreadItems
		? opts
		: { ...opts, seriesGlossary: withSfxGlossary(opts.seriesGlossary, boxes.map((box) => box.source)) };
	const sfxHits = new Map<number, ReturnType<typeof sfxTranslateHit>>();
	if (!opts.proofreadItems) {
		for (let i = 0; i < boxes.length; i++) {
			const hit = sfxTranslateHit(boxes[i].source);
			if (hit) sfxHits.set(i, hit);
		}
	}
	const need = (nextOpts.lineIndexes ?? boxes.map((_, i) => i)).filter((i) => !sfxHits.has(i));
	const out = need.length
		? await translateScriptWithCliOnce(engine, boxes, { ...nextOpts, lineIndexes: need })
		: boxes.map((box, i) => {
			const hit = sfxHits.get(i);
			return hit ? { ...box, ...hit } : { ...box };
		});
	const merged = boxes.map((box, i) => {
		const hit = sfxHits.get(i);
		return hit ? { ...box, ...hit } : out[i];
	});
	if (opts.proofreadItems || opts.requireTranslation) return merged;
	const missing = merged.map((box, i) => i).filter((i) => !merged[i].translation);
	if (!missing.length) return merged;
	try {
		const retry = await translateScriptWithCliOnce(engine, boxes, { ...nextOpts, lineIndexes: missing });
		return boxes.map((_, i) => (retry[i].translation ? retry[i] : merged[i]));
	} catch (e) {
		if (opts.abort?.aborted) throw e instanceof Error ? e : new Error(String(e));
		return merged;
	}
}

export async function proofreadScriptWithCli(
	engine: string,
	items: ProofreadItem[],
	opts: {
		seriesNotes: string;
		seriesGlossary: string;
		prior: string;
		pages: string;
		settled: string;
		abort?: AbortSignal;
		lang?: OcrLang;
		model?: string;
	}
): Promise<Map<number, { translation: string; reasoning: string }>> {
	if (!items.length) return new Map();
	const boxes: DetectedBox[] = items.map((item) => ({
		x: 0,
		y: 0,
		w: 0,
		h: 0,
		lineType: item.lineType,
		source: item.source,
		literal: item.literal,
		translation: item.current,
		reasoning: ''
	}));
	const translated = await translateScriptWithCli(engine, boxes, {
		proofreadItems: items,
		seriesNotes: opts.seriesNotes,
		prior: opts.prior,
		pageLabel: 'chapter proofread',
		abort: opts.abort,
		lang: opts.lang,
		seriesGlossary: opts.seriesGlossary,
		model: opts.model,
		systemPrompt: proofreadSystemPrompt(),
		userPrompt: proofreadPrompt({
			seriesNotes: opts.seriesNotes,
			seriesGlossary: opts.seriesGlossary,
			prior: opts.prior,
			pages: opts.pages,
			settled: opts.settled,
			items,
			lang: opts.lang
		})
	});
	const out = new Map<number, { translation: string; reasoning: string }>();
	translated.forEach((box, idx) => {
		const i = items[idx]?.i ?? idx;
		if (box.translation) out.set(i, { translation: box.translation, reasoning: box.reasoning });
	});
	return out;
}

export async function suggestAlternativesWithCli(
	engine: string,
	opts: {
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
	},
): Promise<{ translation: string; reasoning: string }[]> {
	const boxes: DetectedBox[] = [
		{
			x: 0,
			y: 0,
			w: 0,
			h: 0,
			lineType: opts.lineType,
			source: opts.source,
			literal: '',
			translation: opts.fresh || opts.current,
			reasoning: '',
		},
	];
	const translated = await translateScriptWithCli(engine, boxes, {
		seriesNotes: opts.seriesNotes,
		prior: opts.prior,
		pageLabel: 'alternative phrasing',
		abort: opts.abort,
		lang: opts.lang,
		seriesGlossary: opts.seriesGlossary,
		model: opts.model,
		systemPrompt: alternativesSystemPrompt(),
		userPrompt: alternativesPrompt(opts),
	});
	return translated
		.filter((box) => box.translation.trim())
		.map((box) => ({ translation: box.translation, reasoning: box.reasoning }));
}

function parseCaption(text: string): string {
	try {
		const payload = parseCliJson(text);
		if (payload && typeof payload === 'object') {
			const caption = (payload as { caption?: unknown }).caption;
			if (typeof caption === 'string' && caption.trim()) return caption.trim();
		}
	} catch {
		/* fall through to raw text */
	}
	return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^["'\s]+|["'\s]+$/g, '').trim();
}

/** Vision scene note via Grok or Codex when local Qwen is down. */
export async function describePageWithCli(
	engine: string,
	jpeg: Buffer,
	opts: { abort?: AbortSignal; model?: string } = {}
): Promise<string> {
	return cliAdapters.describe(engine, jpeg, { ...opts, model: pickCliModel(engine, opts.model) });
}

async function describeWithCursor(
	jpeg: Buffer,
	opts: { abort?: AbortSignal; model?: string }
): Promise<string> {
	const prompt = `${DESCRIBE_SYSTEM}\n\n${DESCRIBE_USER}`;
	const text = await runCursorPrompt({
		prompt: `${prompt}\nReturn JSON {caption}.`,
		jpeg,
		model: opts.model,
		abort: opts.abort
	});
	const caption = parseCaption(text);
	if (!caption) throw new Error('Cursor returned an empty scene note');
	return caption;
}

async function describeWithGrok(
	jpeg: Buffer,
	opts: { abort?: AbortSignal; model?: string }
): Promise<string> {
	const prompt = `${DESCRIBE_SYSTEM}\n\n${DESCRIBE_USER}`;
	const bin = requireCli('grok');
	const work = await mkdtemp(join(tmpdir(), 'scan-grok-describe-'));
	try {
		const args = [
			...await grokImagePromptArgs(work, prompt, [jpeg]),
			'--json-schema',
			JSON.stringify(DESCRIBE_OUTPUT_SCHEMA),
			'--system-prompt-override',
			`${DESCRIBE_SYSTEM} Do not use tools.`,
			...grokHeadlessArgs(work)
		];
		const model = pickCliModel('grok', opts.model);
		if (model) args.push('-m', model);
		const result = await runCommand({ bin, args, cwd: work, abort: opts.abort });
		if (result.code !== 0) {
			cliFail('Grok CLI', result);
		}
		const caption = parseCaption(result.stdout || result.stderr);
		if (!caption) throw new Error('Grok returned an empty scene note');
		return caption;
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

async function describeWithCodex(
	jpeg: Buffer,
	opts: { abort?: AbortSignal; model?: string }
): Promise<string> {
	const prompt = `${DESCRIBE_SYSTEM}\n\n${DESCRIBE_USER}`;
	const bin = requireCli('codex');
	const work = await mkdtemp(join(tmpdir(), 'scan-codex-describe-'));
	const schemaPath = join(work, 'schema.json');
	const lastPath = join(work, 'last.txt');
	const pagePath = join(work, 'page.jpg');
	try {
		await writeFile(schemaPath, JSON.stringify(DESCRIBE_OUTPUT_SCHEMA), 'utf8');
		await writeFile(pagePath, jpeg);
		const args = [
			'exec',
			'--skip-git-repo-check',
			'--ephemeral',
			'--sandbox',
			'read-only',
			'--color',
			'never',
			'--output-schema',
			schemaPath,
			'-o',
			lastPath,
			'-C',
			work,
			'-c',
			'approval_policy="never"',
			'-i',
			pagePath
		];
		const model = pickCliModel('codex', opts.model);
		if (model) args.push('-m', model);
		args.push('--', '-');
		const result = await runCommand({ bin, args, cwd: work, stdin: prompt, abort: opts.abort });
		if (result.code !== 0) {
			cliFail('Codex CLI', result);
		}
		const last = existsSync(lastPath) ? await readFile(lastPath, 'utf8') : '';
		const caption = parseCaption(last || result.stdout || result.stderr);
		if (!caption) throw new Error('Codex returned an empty scene note');
		return caption;
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

const COMPACT_OUTPUT_SCHEMA = {
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
				properties: { i: { type: 'integer' }, caption: { type: 'string' } }
			}
		}
	}
};

export async function compactSceneNotesWithCli(
	engine: string,
	captions: { i: number; caption: string }[],
	opts: { abort?: AbortSignal; model?: string } = {}
): Promise<{ chapter: string; pages: { i: number; caption: string }[] }> {
	if (!captions.length) return { chapter: '', pages: [] };
	const rec = asRecord(
		await advisoryWithCli(engine, {
			system: COMPACT_NOTES_SYSTEM,
			prompt: compactSceneNotesPrompt(captions),
			images: [],
			schema: COMPACT_OUTPUT_SCHEMA,
			model: opts.model,
			abort: opts.abort
		})
	);
	const chapter = typeof rec?.chapter === 'string' ? rec.chapter.trim() : '';
	const byI = new Map<number, string>();
	const pages = Array.isArray(rec?.pages) ? rec.pages : [];
	for (const row of pages) {
		const item = asRecord(row);
		const i = Number(item?.i);
		if (!Number.isInteger(i) || typeof item?.caption !== 'string') continue;
		byI.set(i, item.caption.trim());
	}
	return {
		chapter,
		pages: captions.map((row) => ({ i: row.i, caption: byI.get(row.i) || row.caption }))
	};
}

export async function reviewChapterWithCli(
	engine: string,
	opts: {
		seriesNotes: string;
		seriesGlossary: string;
		prior: string;
		pages: string;
		script: string;
		abort?: AbortSignal;
		lang?: OcrLang;
		model?: string;
	}
) {
	return cliAdapters.review(engine, { ...opts, model: pickCliModel(engine, opts.model) });
}

async function reviewWithCursor(opts: {
	seriesNotes: string;
	seriesGlossary: string;
	prior: string;
	pages: string;
	script: string;
	abort?: AbortSignal;
	lang?: OcrLang;
	model?: string;
}) {
	const user = reviewPrompt(opts);
	const system = reviewSystemPrompt();
	const text = await runCursorPrompt({
		prompt: `${system}\n\n${user}\nReturn JSON {summary, issues:[{page,line,severity,text}], questions:[{page,text}], notes}.`,
		model: opts.model,
		abort: opts.abort
	});
	return reviewFromModelText(text);
}

async function reviewWithGrok(opts: {
	seriesNotes: string;
	seriesGlossary: string;
	prior: string;
	pages: string;
	script: string;
	abort?: AbortSignal;
	lang?: OcrLang;
	model?: string;
}) {
	const user = reviewPrompt(opts);
	const system = reviewSystemPrompt();
	const bin = requireCli('grok');
	const work = await mkdtemp(join(tmpdir(), 'scan-grok-review-'));
	try {
		const args = [
			'--json-schema',
			JSON.stringify({
				type: 'object',
				additionalProperties: false,
				required: ['summary', 'issues', 'questions', 'notes'],
				properties: {
					summary: { type: 'string' },
					issues: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								page: { type: 'string' },
								line: { type: 'integer' },
								severity: { type: 'string' },
								text: { type: 'string' }
							}
						}
					},
					questions: {
						type: 'array',
						items: { type: 'object', properties: { page: { type: 'string' }, text: { type: 'string' } } }
					},
					notes: { type: 'string' }
				}
			}),
			'--system-prompt-override',
			`${system} Do not use tools.`,
			...grokHeadlessArgs(work)
		];
		const model = pickCliModel('grok', opts.model);
		if (model) args.push('-m', model);
		await writeFile(join(work, 'prompt.txt'), user, 'utf8');
		args.unshift('--prompt-file', join(work, 'prompt.txt'));
		const result = await runCommand({ bin, args, cwd: work, abort: opts.abort });
		if (result.code !== 0) {
			cliFail('Grok CLI', result);
		}
		return reviewFromModelText(result.stdout || result.stderr);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

async function reviewWithCodex(opts: {
	seriesNotes: string;
	seriesGlossary: string;
	prior: string;
	pages: string;
	script: string;
	abort?: AbortSignal;
	lang?: OcrLang;
	model?: string;
}) {
	const user = reviewPrompt(opts);
	const system = reviewSystemPrompt();
	const bin = requireCli('codex');
	const work = await mkdtemp(join(tmpdir(), 'scan-codex-review-'));
	const lastPath = join(work, 'last.txt');
	try {
		const args = [
			'exec',
			'--skip-git-repo-check',
			'--ephemeral',
			'--sandbox',
			'read-only',
			'--color',
			'never',
			'-o',
			lastPath,
			'-C',
			work,
			'-c',
			'approval_policy="never"'
		];
		const model = pickCliModel('codex', opts.model);
		if (model) args.push('-m', model);
		args.push('--', '-');
		const result = await runCommand({
			bin,
			args,
			cwd: work,
			stdin: `${system}\n\n${user}`,
			abort: opts.abort
		});
		if (result.code !== 0) {
			cliFail('Codex CLI', result);
		}
		const last = existsSync(lastPath) ? await readFile(lastPath, 'utf8') : '';
		return reviewFromModelText(last || result.stdout || result.stderr);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

export type EngineModel = { id: string; label: string };

const CODEX_MODELS: EngineModel[] = [
	{ id: 'gpt-5.4', label: 'GPT-5.4' },
	{ id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
	{ id: 'gpt-5.3', label: 'GPT-5.3' },
	{ id: 'gpt-5.2', label: 'GPT-5.2' },
	{ id: 'o3', label: 'o3' },
	{ id: 'o4-mini', label: 'o4-mini' }
];

const CURSOR_FALLBACK: EngineModel[] = [
	{ id: 'composer-2.5', label: 'Composer 2.5' },
	{ id: 'composer-2.5-fast', label: 'Composer 2.5 Fast' },
	{ id: 'auto', label: 'Auto' }
];

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
	return Promise.race([
		p,
		new Promise<T>((resolve) => {
			setTimeout(() => resolve(fallback), ms);
		})
	]);
}

async function listLocalModels(): Promise<EngineModel[]> {
 const { modelHttpConfig } = await import('./modelConnection');
 const { resolveLiveAssistant } = await import('./assistantRoute');
 const cfg = modelHttpConfig(resolveLiveAssistant(DEFAULT_CHAT_MODEL_ID).row)!;
 const res = await fetch(`${cfg.baseUrl}/models`, {
  headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}, signal: AbortSignal.timeout(2500),
 });
 if (!res.ok) throw new Error(`Local model catalog returned HTTP ${res.status}`);
 return parseOpenAiModelList(await res.json());
}
/** Compatibility export for callers of the old local-host catalog. */
const listQwenModels = listLocalModels;

async function listGrokModels(): Promise<EngineModel[]> {
	const fallback: EngineModel[] = [
		{ id: 'grok-4.6', label: 'Grok 4.6' },
		{ id: 'grok-4.5', label: 'Grok 4.5' }
	];
	const gbin = grokBin();
	if (!gbin) return fallback;
	try {
		const result = await withTimeout(runCommand({ bin: gbin, args: ['models'], cwd: tmpdir() }), 4000, {
			stdout: '',
			stderr: '',
			code: 1
		});
		const found = parseGrokModelList(`${result.stdout}\n${result.stderr}`);
		return found.length ? found : fallback;
	} catch {
		return fallback;
	}
}

async function listCursorModels(): Promise<EngineModel[]> {
	const cbin = cursorBin();
	if (!cbin) return CURSOR_FALLBACK;
	try {
		const result = await withTimeout(runCommand({ bin: cbin, args: ['--list-models'], cwd: tmpdir() }), 15000, {
			stdout: '',
			stderr: '',
			code: 1
		});
		const text = `${result.stdout}\n${result.stderr}`;
		const auth = cursorAuthError(text);
		if (auth) throw new Error(auth);
		const found = parseCursorModelList(text);
		if (!found.length) return CURSOR_FALLBACK;
		for (const extra of CURSOR_FALLBACK) {
			if (!found.some((m) => m.id === extra.id)) found.push(extra);
		}
		return found;
	} catch (error) {
		if (error instanceof Error && /not signed in on this server/i.test(error.message)) throw error;
		return CURSOR_FALLBACK;
	}
}

async function listCodexModels(): Promise<EngineModel[]> {
	const fallback = CODEX_MODELS;
	const bin = codexBin();
	if (!bin) return fallback;
	try {
		const result = await withTimeout(runCommand({ bin, args: ['debug', 'models'], cwd: tmpdir() }), 15000, {
			stdout: '',
			stderr: '',
			code: 1
		});
		const found = parseCodexDebugModelsText(result.stdout || result.stderr);
		return found.length ? found : fallback;
	} catch {
		return fallback;
	}
}

export { listLocalModels, listQwenModels, listGrokModels, listCursorModels, listCodexModels };

export function listRegisteredCliModels(id: string) {
	return cliAdapters.get(id).listModels();
}

export function hasRegisteredCliAdapter(id: string): boolean {
	return cliAdapters.has(id);
}

export function registeredCliExecutable(id: string): string | null {
	return cliAdapters.get(id).executable();
}

/** Built-ins retain their saved IDs. Runtime helpers are injected to avoid import cycles. */
const cliAdapters = new CliAdapterRegistry([
  createGrokAdapter({
    translate: translateWithGrok, read: readWithGrok, review: reviewWithGrok, describe: describeWithGrok, executable: grokBin, defaultModel: () => env('GROK_MODEL'), listModels: listGrokModels,
  }, { run: runCommand, parse: parseCliJson, headlessArgs: grokHeadlessArgs, imagePromptArgs: grokImagePromptArgs }),
  createCodexAdapter({
    translate: translateWithCodex, read: readWithCodex, review: reviewWithCodex, describe: describeWithCodex, clean: cleanImageWithCodex, executable: codexBin, defaultModel: () => env('CODEX_MODEL'), listModels: listCodexModels,
  }, { run: runCommand, parse: parseCliJson }),
  createCursorAdapter({
    translate: translateWithCursor, read: readWithCursor, review: reviewWithCursor, describe: describeWithCursor, executable: cursorBin, defaultModel: () => env('CURSOR_MODEL') || 'composer-2.5', listModels: listCursorModels,
  }, { prompt: runCursorPrompt, parse: extractJsonObject }),
]);

export async function listEngineModels(): Promise<Record<TranslateEngine, EngineModel[]>> {
  const result: Record<string, EngineModel[]> = { qwen: [], grok: [], codex: [], cursor: [], 'proofreader-a': [], 'proofreader-b': [] };
  await Promise.all([
    listQwenModels().then(models => { result.qwen = models; }),
    ...cliAdapters.list().map(async adapter => {
      try {
        result[adapter.id as CliEngine] = await adapter.listModels();
      } catch {
        result[adapter.id as CliEngine] = [];
      }
    }),
  ]);
  return result;
}
