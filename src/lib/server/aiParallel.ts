import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './paths';

/**
 * How many AI requests a chapter job keeps in flight (Admin → Hardware & services).
 *
 * 1 keeps every job strictly one request at a time. Higher values let Transcribe detect
 * the next page while the current one is read, read and translate several regions of a
 * page at once, and translate a page's regions together. The owned translation server
 * starts with this many slots sharing one KV cache, so batching costs little extra memory.
 * `SCAN_AI_PARALLEL` in the environment pins it.
 */
export const MAX_AI_PARALLEL = 8;
const FILE = () => join(DATA_DIR, 'ai-parallel.json');
let cache: { path: string; mtime: number; requests: number } | null = null;

const clamp = (value: unknown) => {
	const n = Math.round(Number(value));
	return Number.isFinite(n) ? Math.max(1, Math.min(MAX_AI_PARALLEL, n)) : 1;
};

export function aiParallelRequests(): number {
	const env = process.env.SCAN_AI_PARALLEL;
	if (env !== undefined && env.trim()) return clamp(env);
	const path = FILE();
	let mtime = -1;
	try {
		mtime = statSync(path).mtimeMs;
	} catch {
		return 1;
	}
	if (cache && cache.path === path && cache.mtime === mtime) return cache.requests;
	let requests = 1;
	try {
		requests = clamp((JSON.parse(readFileSync(path, 'utf8')) as { requests?: unknown }).requests);
	} catch {
		requests = 1;
	}
	cache = { path, mtime, requests };
	return requests;
}

export function aiParallelState(): { requests: number; max: number; pinned: boolean } {
	const env = process.env.SCAN_AI_PARALLEL;
	return { requests: aiParallelRequests(), max: MAX_AI_PARALLEL, pinned: env !== undefined && Boolean(env.trim()) };
}

export function setAiParallelRequests(value: unknown) {
	if (aiParallelState().pinned) return aiParallelState();
	mkdirSync(DATA_DIR, { recursive: true });
	const path = FILE();
	writeFileSync(`${path}.tmp`, `${JSON.stringify({ version: 1, requests: clamp(value) }, null, 2)}\n`);
	renameSync(`${path}.tmp`, path);
	cache = null;
	return aiParallelState();
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping results in input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	let failed = false;
	const worker = async () => {
		while (!failed && next < items.length) {
			const i = next++;
			try {
				out[i] = await fn(items[i], i);
			} catch (error) {
				failed = true;
				throw error;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
	return out;
}
