import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './paths';

let cache: { path: string; mtime: number; values: Record<string, string> } | null = null;

/** Parse KEY=VALUE lines. Never log values. */
export function parseEnvFile(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of text.split(/\r?\n/)) {
		const trimmed = raw.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const body = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
		const eq = body.indexOf('=');
		if (eq <= 0) continue;
		const key = body.slice(0, eq).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		let value = body.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
			(value.startsWith("'") && value.endsWith("'") && value.length >= 2)
		) {
			value = value.slice(1, -1);
		}
		out[key] = value;
	}
	return out;
}

export function invalidateEnvFileCache() {
	cache = null;
}

function envFilePath() {
	return join(process.env.SCAN_ROOT || ROOT, '.env');
}

function envFileValues(): Record<string, string> {
	const path = envFilePath();
	try {
		const mtime = statSync(path).mtimeMs;
		if (cache?.path === path && cache.mtime === mtime) return cache.values;
		const values = parseEnvFile(readFileSync(path, 'utf8'));
		cache = { path, mtime, values };
		return values;
	} catch {
		return cache?.path === path ? cache.values : {};
	}
}

/** Live process env, then `.env` (so Admin Test sees keys added after startup). */
export function envVar(name: string): string {
	const live = (process.env[name] || '').trim();
	if (live) return live;
	return (envFileValues()[name] || '').trim();
}
