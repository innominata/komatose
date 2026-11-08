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

/**
 * What `.env` held when the process started, so we can tell which `process.env`
 * values were copied from it by `tsx --env-file=.env` (Node exposes no such
 * flag). Shared on `globalThis` because `server.ts` records it before the
 * bundled handler loads its own copy of this module, possibly much later.
 */
type StartupEnv = { values: Record<string, string>; env: Record<string, string | undefined> };
const STARTUP_KEY = Symbol.for('komatose.startupEnvFile');

function readEnvFileOnce(): Record<string, string> {
	try {
		return parseEnvFile(readFileSync(envFilePath(), 'utf8'));
	} catch {
		return {};
	}
}

/** Call once at process start, before anything edits `process.env`. Idempotent. */
export function recordStartupEnvFile(): void {
	const g = globalThis as Record<symbol, StartupEnv | undefined>;
	if (g[STARTUP_KEY]) return;
	g[STARTUP_KEY] = { values: readEnvFileOnce(), env: { ...process.env } };
}

function startupEnv(): StartupEnv {
	recordStartupEnvFile();
	return (globalThis as Record<symbol, StartupEnv>)[STARTUP_KEY];
}

/** True when `process.env[name]` is still exactly what `--env-file` copied from `.env` at startup. */
function cameFromEnvFile(name: string, live: string | undefined): boolean {
	const start = startupEnv();
	return (
		live !== undefined &&
		live === start.env[name] &&
		Object.hasOwn(start.values, name) &&
		start.values[name] === live
	);
}

/**
 * Resolve a setting so `.env` edits apply without a restart.
 *
 * - Values loaded from `.env` at startup follow the current file: edits and
 *   removals take effect immediately.
 * - Values from the real shell, or set by code at runtime, still win over the file.
 * - Names absent from `process.env` fall back to the current file (keys added later).
 */
export function envVar(name: string): string {
	const raw = process.env[name];
	if (cameFromEnvFile(name, raw)) return (envFileValues()[name] || '').trim();
	const live = (raw || '').trim();
	if (live) return live;
	return (envFileValues()[name] || '').trim();
}

recordStartupEnvFile();
