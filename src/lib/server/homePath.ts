import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ManagedLaunch } from '../managedModels';

/**
 * Launch recipes and presets are stored and shown as `~/…` so neither the
 * saved rows nor anything rendered from them ever carries this machine's home
 * directory (the repo must never read `/home/<user>/…` in a recipe). Paths are
 * expanded back to absolute only server-side, right before a filesystem check
 * or `spawn`.
 */
export function toHomePath(value: string): string {
	if (!value) return value;
	const home = homedir();
	if (value === home) return '~';
	return value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value;
}

export function expandHomePath(value: string): string {
	if (!value) return value;
	return value === '~' || value.startsWith('~/') ? join(homedir(), value.slice(1)) : value;
}

const LAUNCH_PATH_FIELDS = ['executable', 'modelPath', 'projectorPath', 'templatePath'] as const;

/** Recipe as stored and served: home-relative paths rewritten to `~/…`. */
export function toHomeLaunch<T extends ManagedLaunch>(launch: T): T {
	const next: ManagedLaunch = { ...launch };
	for (const field of LAUNCH_PATH_FIELDS) next[field] = toHomePath(next[field] || '');
	return next as T;
}

/** Recipe as used by the launcher: `~/…` expanded to this machine's home. */
export function expandHomeLaunch<T extends ManagedLaunch>(launch: T): T {
	const next: ManagedLaunch = { ...launch };
	for (const field of LAUNCH_PATH_FIELDS) next[field] = expandHomePath(next[field] || '');
	return next as T;
}
