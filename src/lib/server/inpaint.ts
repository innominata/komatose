import { copyFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import type { ImageRow, PublicUser } from '../types';
import { logActivity } from './activity';
import { jobSnapshot } from './aiTranslate';
import { db } from './db';
import { images } from './db/schema';
import { now } from './ids';
import { inpaintBox, parsePoly } from './ocr';
import { listImages, toImage } from './queries';
import { broadcast } from './realtime';
import { ensureOriginal, imagePath, listImageBackups, nextImageBackupPath } from './storage';
import type { Episode, Series } from '../types';

export class InpaintError extends Error {
	status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

async function touchImage(id: string): Promise<ImageRow> {
	const t = now();
	await db.update(images).set({ updatedAt: t }).where(eq(images.id, id));
	const row = await db.select().from(images).where(eq(images.id, id)).get();
	if (!row) throw new InpaintError('Image not found', 404);
	return toImage({ ...row, updatedAt: t });
}

export async function inpaintRegion(opts: {
	series: Series;
	episode: Episode;
	user: PublicUser;
	imageId: string;
	x: number;
	y: number;
	w: number;
	h: number;
	poly?: { x: number; y: number }[];
	mode?: 'auto' | 'flat' | 'bubble';
	px?: number;
	py?: number;
}): Promise<{ image: ImageRow; method: string; canUndo: true }> {
	if (jobSnapshot(opts.episode.id)?.running) {
		throw new InpaintError('AI translate is already running on this chapter', 409);
	}
	const poly = opts.poly && opts.poly.length >= 3 ? opts.poly : undefined;
	if (opts.mode === 'bubble') {
		if (![opts.px, opts.py].every(Number.isFinite)) throw new InpaintError('Invalid point');
	} else if (!poly) {
		if (![opts.x, opts.y, opts.w, opts.h].every(Number.isFinite)) {
			throw new InpaintError('Invalid selection');
		}
		if (opts.w < 0.004 || opts.h < 0.002) throw new InpaintError('Selection is too small');
	}

	const imgs = await listImages(opts.episode.id);
	const img = imgs.find((i) => i.id === opts.imageId);
	if (!img) throw new InpaintError('Image not found', 404);

	const path = imagePath(opts.series.slug, opts.episode.slug, img.filename);
	if (!existsSync(path)) throw new InpaintError('Image file missing', 404);
	await ensureOriginal(opts.series.slug, opts.episode.slug, img.filename);
	const bak = await nextImageBackupPath(opts.series.slug, opts.episode.slug, img.filename);
	await copyFile(path, bak);

	const result = await inpaintBox(path, {
		x: opts.x,
		y: opts.y,
		w: opts.w,
		h: opts.h,
		poly,
		mode: opts.mode,
		px: opts.px,
		py: opts.py
	});
	const image = await touchImage(img.id);
	broadcast(opts.episode.id, { type: 'image:upsert', image });
	void logActivity({
		seriesId: opts.series.id,
		episodeId: opts.episode.id,
		userId: opts.user.id,
		action: 'cleaned_text',
		payload: { imageId: img.id, method: result.method }
	}).then((entry) => broadcast(opts.episode.id, { type: 'activity', entry }));
	return { image, method: result.method, canUndo: true };
}

export async function undoInpaint(opts: {
	series: Series;
	episode: Episode;
	user: PublicUser;
	imageId: string;
}): Promise<{ image: ImageRow; canUndo: boolean }> {
	if (jobSnapshot(opts.episode.id)?.running) {
		throw new InpaintError('AI translate is already running on this chapter', 409);
	}
	const imgs = await listImages(opts.episode.id);
	const img = imgs.find((i) => i.id === opts.imageId);
	if (!img) throw new InpaintError('Image not found', 404);

	const path = imagePath(opts.series.slug, opts.episode.slug, img.filename);
	const backups = await listImageBackups(opts.series.slug, opts.episode.slug, img.filename);
	const bak = backups[backups.length - 1];
	if (!bak) throw new InpaintError('Nothing to undo');
	await copyFile(bak, path);
	await unlink(bak).catch(() => {});
	const meta = await sharp(path).metadata();
	const t = now();
	await db
		.update(images)
		.set({
			width: meta.width || img.width,
			height: meta.height || img.height,
			updatedAt: t
		})
		.where(eq(images.id, img.id));
	const row = await db.select().from(images).where(eq(images.id, img.id)).get();
	if (!row) throw new InpaintError('Image not found', 404);
	const image = toImage(row);
	broadcast(opts.episode.id, { type: 'image:upsert', image });
	void logActivity({
		seriesId: opts.series.id,
		episodeId: opts.episode.id,
		userId: opts.user.id,
		action: 'undid_clean',
		payload: { imageId: img.id }
	}).then((entry) => broadcast(opts.episode.id, { type: 'activity', entry }));
	return { image, canUndo: backups.length > 1 };
}