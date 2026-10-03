import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './paths';
import { OCR_LANGS, type OcrLang } from '../types';

const READY_MS = 8 * 60 * 1000;
const OCR_MS = 45_000;
const DETECT_MS = 10 * 60 * 1000;
const INPAINT_MS = 120_000;

type WorkerMessage = Record<string, unknown>;

type DetectProgress = { model: string; step: string };

type Pending = {
	resolve: (msg: WorkerMessage) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	onProgress?: (update: DetectProgress) => void;
};

type WorkerState = {
	proc: ChildProcessWithoutNullStreams;
	buf: string;
	seq: number;
	pending: Map<string, Pending>;
	ready: Promise<void>;
};

const g = globalThis as typeof globalThis & { __scanOcr?: WorkerState | null };
let starting: Promise<WorkerState> | null = null;

function pythonBin(): string {
	return process.env.PADDLEOCR_PYTHON || join(ROOT, '.venv-ocr/bin/python');
}

function workerPath(): string {
	return process.env.PADDLEOCR_WORKER || join(ROOT, 'ocr/worker.py');
}

function failAll(state: WorkerState, err: Error) {
	for (const p of state.pending.values()) {
		clearTimeout(p.timer);
		p.reject(err);
	}
	state.pending.clear();
}

function handleLine(state: WorkerState, line: string) {
	let msg: WorkerMessage;
	try {
		msg = JSON.parse(line) as WorkerMessage;
	} catch {
		return;
	}
	const id = String(msg.id || '');
	const pending = state.pending.get(id);
	if (!pending) return;
	if (msg.progress === true) {
		pending.onProgress?.({ model: String(msg.model ?? ''), step: String(msg.step ?? '') });
		return;
	}
	state.pending.delete(id);
	clearTimeout(pending.timer);
	if (msg.ok === false) pending.reject(new Error(String(msg.error || 'ocr worker failed')));
	else pending.resolve(msg);
}

function spawnWorker(): WorkerState {
	const py = pythonBin();
	const script = workerPath();
	if (!existsSync(py)) throw new Error(`OCR python missing: ${py}`);
	if (!existsSync(script)) throw new Error(`OCR worker missing: ${script}`);

	const proc = spawn(py, ['-u', script], {
		cwd: ROOT,
		env: { ...process.env, PYTHONUNBUFFERED: '1' },
		stdio: ['pipe', 'pipe', 'pipe']
	});

	const state: WorkerState = {
		proc,
		buf: '',
		seq: 0,
		pending: new Map(),
		ready: Promise.resolve()
	};

	let resolveReady: () => void;
	let rejectReady: (err: Error) => void;
	state.ready = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	const readyTimer = setTimeout(() => {
		rejectReady(new Error('OCR worker timed out while loading'));
		proc.kill('SIGKILL');
	}, READY_MS);

	proc.stdout.setEncoding('utf8');
	proc.stdout.on('data', (chunk: string) => {
		state.buf += chunk;
		let nl: number;
		while ((nl = state.buf.indexOf('\n')) >= 0) {
			const line = state.buf.slice(0, nl).trim();
			state.buf = state.buf.slice(nl + 1);
			if (!line) continue;
			if (line.startsWith('{"ready"')) {
				clearTimeout(readyTimer);
				try {
					const msg = JSON.parse(line) as { ready?: boolean; error?: string };
					if (msg.ready) resolveReady();
					else rejectReady(new Error(msg.error || 'OCR worker failed to start'));
				} catch {
					rejectReady(new Error(`OCR ready handshake: ${line}`));
				}
				continue;
			}
			handleLine(state, line);
		}
	});
	proc.stderr.setEncoding('utf8');
	proc.stderr.on('data', (chunk: string) => {
		const text = chunk.trim();
		if (text) console.error(`[ocr] ${text}`);
	});
	proc.on('error', error => { clearTimeout(readyTimer); failAll(state, error); rejectReady(error); });
	proc.on('exit', (code, signal) => {
		clearTimeout(readyTimer);
		const err = new Error(`OCR worker exited (${code ?? signal ?? 'unknown'})`);
		if (g.__scanOcr === state) g.__scanOcr = null;
		failAll(state, err);
		rejectReady(err);
	});
	return state;
}

function workerAlive(state: WorkerState | null | undefined): state is WorkerState {
	return !!state && state.proc.exitCode == null && state.proc.signalCode == null;
}

async function ensureWorker(): Promise<WorkerState> {
	if (workerAlive(g.__scanOcr)) {
		await g.__scanOcr.ready;
		return g.__scanOcr;
	}
	if (!starting) {
		starting = (async () => {
			const state = spawnWorker();
			g.__scanOcr = state;
			await state.ready;
			return state;
		})().finally(() => {
			starting = null;
		});
	}
	return starting;
}

async function call(
	payload: Record<string, unknown>,
	opts: { timeoutMs: number; abort?: AbortSignal; onProgress?: (update: DetectProgress) => void }
): Promise<WorkerMessage> {
	opts.abort?.throwIfAborted();
	const state = await ensureWorker();
	opts.abort?.throwIfAborted();
	const id = String(++state.seq);
	const line = JSON.stringify({ ...payload, id }) + '\n';
	return new Promise<WorkerMessage>((resolve, reject) => {
		const onAbort = () => {
			state.pending.delete(id);
			clearTimeout(timer);
			state.proc.kill('SIGKILL');
			reject(opts.abort?.reason || new DOMException('Cancelled', 'AbortError'));
		};
		const timer = setTimeout(() => {
			state.pending.delete(id);
			opts.abort?.removeEventListener('abort', onAbort);
			state.proc.kill('SIGKILL');
			reject(new Error(`OCR worker timed out (${String(payload.cmd || 'ocr')})`));
		}, opts.timeoutMs);
		state.pending.set(id, {
			resolve: (msg) => {
				opts.abort?.removeEventListener('abort', onAbort);
				resolve(msg);
			},
			reject: (err) => {
				opts.abort?.removeEventListener('abort', onAbort);
				reject(err);
			},
			onProgress: opts.onProgress,
			timer
		});
		opts.abort?.addEventListener('abort', onAbort, { once: true });
		try {
			state.proc.stdin.write(line);
		} catch (e) {
			state.pending.delete(id);
			clearTimeout(timer);
			opts.abort?.removeEventListener('abort', onAbort);
			reject(e instanceof Error ? e : new Error(String(e)));
		}
	});
}

export async function startOcrWorker(abort?: AbortSignal) {
	await call({ cmd: 'ping' }, { timeoutMs: READY_MS, abort });
}

export function ocrWorkerRunning() {
	return Boolean(g.__scanOcr && !g.__scanOcr.proc.killed && g.__scanOcr.proc.exitCode === null);
}

/** Load the detector and the recogniser up front so the first page is not slow. */
export function warmupOcr(targets: ('detect' | 'ocr')[] = ['detect', 'ocr']) {
	void (async () => {
		for (const what of targets) {
			await call({ cmd: 'warmup', what }, { timeoutMs: READY_MS });
		}
	})().catch((e) => console.error('[ocr]', e instanceof Error ? e.message : e));
}

export function parseOcrLang(value: unknown): OcrLang {
	const raw = String(value ?? '')
		.toLowerCase()
		.trim();
	if (raw === 'japanese' || raw === 'japan' || raw === 'ja' || raw === 'jp' || raw === 'jpn') {
		return 'japanese';
	}
	if (raw === 'korean' || raw === 'ko' || raw === 'kr' || raw === 'kor') return 'korean';
	const env = String(process.env.SCAN_OCR_LANG ?? '')
		.toLowerCase()
		.trim();
	if (env === 'japanese' || env === 'japan' || env === 'ja' || env === 'jp' || env === 'jpn') {
		return 'japanese';
	}
	if (env === 'korean' || env === 'ko') return 'korean';
	if ((OCR_LANGS as string[]).includes(raw)) return raw as OcrLang;
	return 'japanese';
}

/** Block until the recogniser for `lang` is loaded (downloads weights on first use). */
export async function ensureOcrReady(lang: OcrLang, abort?: AbortSignal) {
	await call({ cmd: 'warmup', what: 'ocr', lang }, { timeoutMs: READY_MS, abort });
}

export function stopWorker() {
	const state = g.__scanOcr;
	if (!state) return;
	try {
		state.proc.stdin.end();
	} catch {
		/* ignore */
	}
	state.proc.kill('SIGTERM');
	g.__scanOcr = null;
}

process.once('exit', stopWorker);

export async function readBubbleOcr(
	jpeg: Buffer,
	abort?: AbortSignal,
	opts: { upscale?: number | 'auto'; lang?: OcrLang } = {}
): Promise<{ source: string; score: number }> {
	const msg = await call(
		{
			cmd: 'ocr',
			b64: jpeg.toString('base64'),
			upscale: opts.upscale ?? null,
			lang: opts.lang ?? parseOcrLang(undefined)
		},
		{ timeoutMs: OCR_MS, abort }
	);
	return { source: String(msg.text || '').trim(), score: Number(msg.score || 0) };
}

const CJK_OR_HANGUL = /[\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u4e00-\u9fff\uac00-\ud7af]/;

/**
 * Reject reads that are almost certainly picked-up artwork rather than script:
 * stray latin letters and punctuation, or a lone glyph the recogniser was not
 * confident about. A single Hangul syllable at decent confidence is kept — SFX
 * are frequently one character.
 */
export function isMeaningfulSource(text: string, score: number): boolean {
	const t = text.trim();
	if (!t) return false;
	if (CJK_OR_HANGUL.test(t)) {
		if ([...t].length <= 1 && score < 0.5) return false;
		return true;
	}
	// The Chinese server rec dumps LaTeX (`$\\t$`, `\frac`) on manga SFX.
	if (/[\\$]/.test(t)) return false;
	// Latin SFX only: mostly letters, at least 3 of them.
	const compact = t.replace(/\s/g, '');
	const letters = compact.replace(/[^A-Za-z]/g, '');
	if (letters.length >= 3 && letters.length / compact.length >= 0.7 && score >= 0.55) return true;
	return false;
}

export type WorkerRegion = {
	/** Optional normalized source-page polygon from a shape detector. */
	polygon?: { x: number; y: number }[];
	backend?: string;
	crop?: number[];
	truncated?: boolean;
	cls: string;
	score: number;
	box: [number, number, number, number];
};

/** Run a Python-side detector over a whole page. Paths avoid base64-ing a
 *  multi-megabyte long-strip image across the pipe. */
export async function rawDetectRegionsPy(
	path: string,
	opts: {
		backend: string;
		conf?: number;
		tile?: number;
		overlap?: number;
		/** RT-DETR also runs Comic Text Detector by default. False when the caller cross-checks with it separately. */
		supplement?: boolean;
		lang?: OcrLang;
		abort?: AbortSignal;
		onProgress?: (update: DetectProgress) => void;
	}
): Promise<{ regions: WorkerRegion[]; width: number; height: number }> {
	const msg = await call(
		{
			cmd: 'detect',
			path,
			backend: opts.backend,
			conf: opts.conf ?? null,
			tile: opts.tile ?? null,
			overlap: opts.overlap ?? null,
			supplement: opts.supplement ?? true,
			lang: opts.lang ?? parseOcrLang(undefined)
		},
		{ timeoutMs: DETECT_MS, abort: opts.abort, onProgress: opts.onProgress }
	);
	const raw = Array.isArray(msg.regions) ? msg.regions : [];
	const regions: WorkerRegion[] = [];
	for (const r of raw as Record<string, unknown>[]) {
		const box = Array.isArray(r.box) ? (r.box as number[]) : null;
		if (!box || box.length !== 4) continue;
		regions.push({
			cls: String(r.cls || 'text'),
			backend: typeof r.backend === 'string' ? r.backend : undefined,
			crop: Array.isArray(r.crop) && r.crop.length === 4 && r.crop.every(Number.isFinite) ? r.crop as number[] : undefined,
			truncated: r.truncated === true,
			score: Number(r.score || 0),
			box: [box[0], box[1], box[2], box[3]]
		});
	}
	return { regions, width: Number(msg.width || 0), height: Number(msg.height || 0) };
}

export function parsePoly(raw: unknown): { x: number; y: number }[] | undefined {
	if (!Array.isArray(raw) || raw.length < 3) return undefined;
	const pts: { x: number; y: number }[] = [];
	for (const p of raw.slice(0, 400)) {
		let x = NaN;
		let y = NaN;
		if (Array.isArray(p) && p.length >= 2) {
			x = Number(p[0]);
			y = Number(p[1]);
		} else if (p && typeof p === 'object') {
			x = Number((p as { x?: unknown }).x);
			y = Number((p as { y?: unknown }).y);
		}
		if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
		pts.push({ x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) });
	}
	return pts.length >= 3 ? pts : undefined;
}

export async function inpaintBox(
	path: string,
	box: {
		x: number;
		y: number;
		w: number;
		h: number;
		poly?: { x: number; y: number }[];
		mode?: 'auto' | 'flat' | 'bubble';
		px?: number;
		py?: number;
	},
	opts: { out?: string; abort?: AbortSignal } = {}
): Promise<{ width: number; height: number; method: string }> {
	const msg = await call(
		{
			cmd: 'inpaint',
			path,
			out: opts.out || path,
			x: box.x,
			y: box.y,
			w: box.w,
			h: box.h,
			poly: box.poly ?? null,
			mode: box.mode ?? 'auto',
			px: box.px ?? null,
			py: box.py ?? null
		},
		{ timeoutMs: INPAINT_MS, abort: opts.abort }
	);
	return {
		width: Number(msg.width || 0),
		height: Number(msg.height || 0),
		method: String(msg.method || 'inpaint')
	};
}

/** Production detector calls share the task probe adapter path. */
export async function detectRegionsPy(path: string, opts: Parameters<typeof rawDetectRegionsPy>[1]): Promise<Awaited<ReturnType<typeof rawDetectRegionsPy>>> {
 const { findRegistryRow } = await import('./modelRegistryStore');
 const { executeModelTask } = await import('./modelTaskRunner');
 const { readFile } = await import('node:fs/promises');
 const sharp = (await import('sharp')).default;
 const row = findRegistryRow(opts.backend);
 if (!row) throw new Error(`Unknown detector model: ${opts.backend}`);
 const jpeg = await readFile(path);
 const { width = 1, height = 1 } = await sharp(jpeg).metadata();
 const result = await executeModelTask(row, 'detect', { ...opts, jpeg }, { abort: opts.abort });
 return { width, height, regions: result.regions.map((r: any) => ({
  cls: r.cls || 'text', score: r.score ?? 1, backend: row.id,
  box: [r.x * width, r.y * height, (r.x + r.w) * width, (r.y + r.h) * height],
  polygon: Array.isArray(r.polygon) && r.polygon.length >= 3
    ? r.polygon.map((point: { x: number; y: number }) => ({ x: point.x, y: point.y })) : undefined,
 })) };
}
