import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Parse `--flag value` or `--flag=value` from a process argv. */
export function flagValue(args: string[], flags: string[]): string {
	for (const flag of flags) {
		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			if (arg === flag && args[i + 1]) return args[i + 1];
			if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
		}
	}
	return '';
}

export function pidsOnPort(port: number): number[] {
	try {
		const out = execFileSync('ss', ['-lptn', `sport = :${port}`], {
			encoding: 'utf8',
			timeout: 2000,
		});
		return [...new Set([...out.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])))].filter(
			(pid) => pid > 0,
		);
	} catch {
		return [];
	}
}

export function processArgs(pid: number): string[] {
	try {
		return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
	} catch {
		return [];
	}
}

export type PortOccupant = { pid: number; alias: string; token: string };

/** llama-server `--alias`/`-a`, or Hayai's review worker script. */
export function aliasFromArgs(args: string[]): string {
	const alias = flagValue(args, ['--alias', '-a']);
	if (alias) return alias;
	if (args.some((arg) => arg.includes('hayai_review.py'))) return 'hayai-ocr-v2';
	if (args.some((arg) => arg.includes('manga_ocr_review.py'))) return 'manga-ocr';
	return '';
}

export function occupantOnPort(port: number): PortOccupant | undefined {
	for (const pid of pidsOnPort(port)) {
		const args = processArgs(pid);
		return {
			pid,
			alias: aliasFromArgs(args),
			token: flagValue(args, ['--api-key', '--token']),
		};
	}
}

/** API key/token of a llama-server or Hayai process already bound to this port. */
export function inferenceTokenFromPort(port: number): string {
	return occupantOnPort(port)?.token || '';
}

function tokenDir() {
	const dir = join(process.env.SCAN_ROOT || process.cwd(), 'data/run');
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function readSavedToken(id: string): string {
	const path = join(tokenDir(), `${id}.token`);
	if (!existsSync(path)) return '';
	try {
		return readFileSync(path, 'utf8').trim();
	} catch {
		return '';
	}
}

export function writeSavedToken(id: string, token: string) {
	if (!token) return;
	writeFileSync(join(tokenDir(), `${id}.token`), token, { mode: 0o600 });
}

export function clearSavedToken(id: string) {
	try {
		unlinkSync(join(tokenDir(), `${id}.token`));
	} catch {
		/* absent */
	}
}

export async function inferenceHealthy(
	baseUrl: string,
	token: string,
	abort?: AbortSignal,
): Promise<'ready' | 'loading' | 'down'> {
	try {
		const response = await fetch(`${baseUrl.replace(/\/$/, '')}/health`, {
			headers: token ? { authorization: `Bearer ${token}` } : {},
			signal: AbortSignal.any([...(abort ? [abort] : []), AbortSignal.timeout(2000)]),
		});
		if (response.ok) return 'ready';
		if (response.status === 503 || response.status === 409) return 'loading';
		return 'down';
	} catch {
		return 'down';
	}
}

export type ReviewVerdict = 'ready' | 'loading' | 'unauthorized' | 'mismatch' | 'down';

/** Python review workers expose model identity on `/health`; llama-server uses `/v1/models`. */
const HEALTH_IDENTITY_REVIEW_MODELS = new Set(['hayai-ocr-v2', 'manga-ocr']);

/**
 * llama-server `/health` is unauthenticated, so a chat model on a review port
 * looks healthy. Identity comes from `/v1/models` (or Python review `/health`).
 */
export async function reviewServiceVerdict(
	id: string,
	baseUrl: string,
	token: string,
	abort?: AbortSignal,
	timeoutMs = 2000,
): Promise<{ verdict: ReviewVerdict; served?: string; status?: number }> {
	const url = baseUrl.replace(/\/$/, '');
	const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
	const timed = () =>
		AbortSignal.any([...(abort ? [abort] : []), AbortSignal.timeout(timeoutMs)]);
	try {
		if (HEALTH_IDENTITY_REVIEW_MODELS.has(id)) {
			const response = await fetch(`${url}/health`, { headers, signal: timed() });
			if (response.status === 401) return { verdict: 'unauthorized', status: 401 };
			if (response.status === 503 || response.status === 409)
				return { verdict: 'loading', status: response.status };
			if (!response.ok) return { verdict: 'down', status: response.status };
			const body = (await response.json().catch(() => ({}))) as { model?: string };
			const served = typeof body.model === 'string' ? body.model : '';
			if (served && served !== id) return { verdict: 'mismatch', served, status: response.status };
			return { verdict: 'ready', served: served || id, status: response.status };
		}
		const health = await fetch(`${url}/health`, { headers, signal: timed() });
		if (health.status === 401) return { verdict: 'unauthorized', status: 401 };
		if (health.status === 503 || health.status === 409)
			return { verdict: 'loading', status: health.status };
		if (!health.ok) return { verdict: 'down', status: health.status };
		const models = await fetch(`${url}/v1/models`, { headers, signal: timed() });
		if (models.status === 401) return { verdict: 'unauthorized', status: 401 };
		if (!models.ok) return { verdict: 'down', status: models.status };
		const body = (await models.json().catch(() => ({}))) as { data?: { id?: string }[] };
		const ids = (body.data || []).map((row) => row.id).filter((value): value is string => !!value);
		const served = ids[0] || '';
		if (!ids.includes(id)) return { verdict: 'mismatch', served: served || undefined, status: models.status };
		return { verdict: 'ready', served: id, status: models.status };
	} catch {
		return { verdict: 'down' };
	}
}
