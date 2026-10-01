import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

/** Repo root. Prefer cwd (vite + systemd WorkingDirectory, or SCAN_ROOT). */
export const ROOT = process.env.SCAN_ROOT || process.cwd();

export const DATA_DIR = process.env.SCAN_DATA_DIR || join(ROOT, 'data');
export const IMAGES_DIR = join(DATA_DIR, 'images');

const dbUrl = process.env.DATABASE_URL || 'data/scan.db';
export const DB_PATH = isAbsolute(dbUrl) ? dbUrl : join(ROOT, dbUrl);

export function ensureDataDirs() {
	mkdirSync(IMAGES_DIR, { recursive: true });
	mkdirSync(dirname(DB_PATH), { recursive: true });
}
