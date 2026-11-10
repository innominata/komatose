import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { IMAGES_DIR } from './paths';

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const EXT: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp',
	'image/gif': 'gif'
};

export function episodeDir(seriesSlug: string, episodeSlug: string): string {
	for (const slug of [seriesSlug, episodeSlug]) {
		if (!slug || slug === '.' || slug === '..' || slug.includes('/') || slug.includes('\\')) {
			throw new Error('Invalid image folder slug');
		}
	}
	return join(IMAGES_DIR, seriesSlug, episodeSlug);
}

export async function saveImageFile(opts: {
	seriesSlug: string;
	episodeSlug: string;
	sortOrder: number;
	originalName: string;
	bytes: Buffer;
	mime: string;
}): Promise<{ filename: string; width: number; height: number; dpi: number }> {
	if (!ALLOWED.has(opts.mime)) {
		throw new Error(`Unsupported image type: ${opts.mime}`);
	}
	const ext = EXT[opts.mime] || 'jpg';
	const safeBase = opts.originalName.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '') || 'image';
	const dir = episodeDir(opts.seriesSlug, opts.episodeSlug);
	await mkdir(dir, { recursive: true });
	const base = `${String(opts.sortOrder + 1).padStart(2, '0')}-${safeBase.replace(/\.[^.]+$/, '')}`;
	let filename = `${base}.${ext}`;
	let n = 2;
	while (existsSync(join(dir, filename))) {
		filename = `${base}-${n}.${ext}`;
		n += 1;
	}
	const path = join(dir, filename);
	await writeFile(path, opts.bytes);
	const orig = origImagePath(opts.seriesSlug, opts.episodeSlug, filename);
	if (!existsSync(orig)) await writeFile(orig, opts.bytes);
	const meta = await sharp(opts.bytes).metadata();
	return {
		filename,
		width: meta.width || 0,
		dpi: meta.density && meta.density >= 10 && meta.density <= 2400 ? meta.density : 72,
		height: meta.height || 0
	};
}

export function imagePath(seriesSlug: string, episodeSlug: string, filename: string): string {
	return join(episodeDir(seriesSlug, episodeSlug), filename);
}

/** Immutable upload; never written after the first save. */
export function origImagePath(seriesSlug: string, episodeSlug: string, filename: string): string {
	return imagePath(seriesSlug, episodeSlug, filename) + '.orig';
}

/** Working file, or the `.orig` sidecar if the working copy is gone. */
export async function readWorkingOrOrig(
	seriesSlug: string,
	episodeSlug: string,
	filename: string
): Promise<Buffer | null> {
	const working = imagePath(seriesSlug, episodeSlug, filename);
	const orig = origImagePath(seriesSlug, episodeSlug, filename);
	if (existsSync(working)) return readFile(working);
	if (existsSync(orig)) return readFile(orig);
	return null;
}

/** Snapshot the original if this page predates sidecar originals. */
export async function ensureOriginal(
	seriesSlug: string,
	episodeSlug: string,
	filename: string
): Promise<string> {
	const orig = origImagePath(seriesSlug, episodeSlug, filename);
	if (existsSync(orig)) return orig;
	const backups = await listImageBackups(seriesSlug, episodeSlug, filename);
	const working = imagePath(seriesSlug, episodeSlug, filename);
	const source = backups[0] && existsSync(backups[0]) ? backups[0] : working;
	if (existsSync(source)) await copyFile(source, orig);
	return orig;
}

export async function moveSeriesDir(fromSlug: string, toSlug: string) {
	if (fromSlug === toSlug) return;
	const from = join(IMAGES_DIR, fromSlug);
	const to = join(IMAGES_DIR, toSlug);
	if (!existsSync(from)) return;
	if (existsSync(to)) throw new Error(`A series folder named "${toSlug}" already exists`);
	await rename(from, to);
}

export async function moveEpisodeDir(seriesSlug: string, fromSlug: string, toSlug: string) {
	if (fromSlug === toSlug) return;
	const from = episodeDir(seriesSlug, fromSlug);
	const to = episodeDir(seriesSlug, toSlug);
	if (!existsSync(from)) return;
	if (existsSync(to)) throw new Error(`A chapter folder named "${toSlug}" already exists`);
	await rename(from, to);
}

export async function removeImageFile(seriesSlug: string, episodeSlug: string, filename: string) {
	try {
		await unlink(imagePath(seriesSlug, episodeSlug, filename));
	} catch {
		// already gone
	}
	try {
		await unlink(origImagePath(seriesSlug, episodeSlug, filename));
	} catch {
		// no sidecar
	}
	for (const bak of await listImageBackups(seriesSlug, episodeSlug, filename)) {
		try {
			await unlink(bak);
		} catch {
			// no backup
		}
	}
}

/**
 * Clean-undo backups for an image, oldest first. Numbered `{file}.bak.N`
 * entries stack; a plain `{file}.bak` from the single-undo era counts as
 * the oldest.
 */
export async function listImageBackups(
	seriesSlug: string,
	episodeSlug: string,
	filename: string
): Promise<string[]> {
	const dir = episodeDir(seriesSlug, episodeSlug);
	let names: string[] = [];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const prefix = `${filename}.bak.`;
	const numbered = names
		.filter((n) => n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length)))
		.sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
	const legacy = names.includes(`${filename}.bak`) ? [`${filename}.bak`] : [];
	return [...legacy, ...numbered].map((n) => join(dir, n));
}

/** Path for the next clean backup (one higher than the current top). */
export async function nextImageBackupPath(
	seriesSlug: string,
	episodeSlug: string,
	filename: string
): Promise<string> {
	const backups = await listImageBackups(seriesSlug, episodeSlug, filename);
	const last = backups[backups.length - 1];
	const m = last?.match(/\.bak\.(\d+)$/);
	const next = m ? Number(m[1]) + 1 : 1;
	return imagePath(seriesSlug, episodeSlug, filename) + `.bak.${next}`;
}

export function sniffMime(name: string, fallback?: string | null): string {
	const lower = name.toLowerCase();
	if (lower.endsWith('.png')) return 'image/png';
	if (lower.endsWith('.webp')) return 'image/webp';
	if (lower.endsWith('.gif')) return 'image/gif';
	if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
	return fallback || 'application/octet-stream';
}

/** Tallest strip Reslice strips produces. */
export const STITCH_TARGET_H = 16000;
