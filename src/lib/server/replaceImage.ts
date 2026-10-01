import { copyFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { initializeCanvas, readPsd, type Layer, type Psd } from 'ag-psd';
import { eq } from 'drizzle-orm';
import sharp, { type OverlayOptions, type Sharp } from 'sharp';
import type { Episode, ImageRow, PublicUser, Series } from '../types';
import { logActivity } from './activity';
import { jobSnapshot } from './aiTranslate';
import { db } from './db';
import { images } from './db/schema';
import { now } from './ids';
import { toImage } from './queries';
import { broadcast } from './realtime';
import { ensureOriginal, imagePath, nextImageBackupPath } from './storage';

export class ReplaceError extends Error {
	status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

/** PSD canvas hard limit; anything larger is PSB, which ag-psd cannot read. */
const MAX_DIM = 30000;

// ag-psd decodes pixels into ImageData objects even in `useImageData` mode.
// A plain buffer-backed object is all it needs; there is no real canvas here.
initializeCanvas(
	() => {
		throw new ReplaceError('PSD contains data that needs a canvas to decode');
	},
	(width, height) =>
		({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' }) as ImageData
);

function isPsd(bytes: Buffer, name: string): boolean {
	return bytes.subarray(0, 4).toString('latin1') === '8BPS' || /\.psd$/i.test(name);
}

function rgba(psdLike: { imageData?: { width: number; height: number; data: ArrayLike<number> } }): Sharp | null {
	const px = psdLike.imageData;
	if (!px || !px.width || !px.height) return null;
	const buf = Buffer.from(px.data as Uint8Array);
	return sharp(buf, { raw: { width: px.width, height: px.height, channels: 4 } });
}

/** Photoshop writes a blank composite when Maximize Compatibility is off. */
async function looksBlank(img: Sharp): Promise<boolean> {
	const stats = await img.clone().stats();
	return stats.channels.slice(0, 3).every((c) => c.stdev < 0.5);
}

/**
 * Flatten visible raster layers ourselves (normal blend, top-down order as
 * Photoshop lists them) when the file has no usable composite.
 */
async function flattenLayers(psd: Psd): Promise<Sharp> {
	const overlays: OverlayOptions[] = [];
	const visit = async (layers: Layer[] | undefined) => {
		for (const layer of layers ?? []) {
			if (layer.hidden) continue;
			if (layer.children) {
				await visit(layer.children);
				continue;
			}
			const px = layer.imageData;
			if (!px?.width || !px.height) continue;
			let left = layer.left ?? 0;
			let top = layer.top ?? 0;
			let piece = sharp(Buffer.from(px.data as Uint8Array), {
				raw: { width: px.width, height: px.height, channels: 4 }
			});
			// Clip to the canvas: sharp refuses overlays that spill past the base.
			const x0 = Math.max(0, -left);
			const y0 = Math.max(0, -top);
			const x1 = Math.min(px.width, psd.width - left);
			const y1 = Math.min(px.height, psd.height - top);
			if (x1 <= x0 || y1 <= y0) continue;
			if (x0 || y0 || x1 !== px.width || y1 !== px.height) {
				piece = piece.extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 });
				left += x0;
				top += y0;
			}
			const input = await piece.png().toBuffer();
			overlays.push({ input, left, top, blend: 'over' });
		}
	};
	await visit(psd.children);
	if (!overlays.length) throw new ReplaceError('PSD has no visible image layers');
	return sharp({
		create: { width: psd.width, height: psd.height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } }
	}).composite(overlays);
}

async function decodePsd(bytes: Buffer): Promise<Sharp> {
	// Structure + composite first; layers are only decoded if we need them.
	const head = readPsd(bytes, { useImageData: true, skipLayerImageData: true, skipThumbnail: true });
	if (head.width > MAX_DIM || head.height > MAX_DIM) throw new ReplaceError('PSD is too large');
	const composite = rgba(head);
	if (composite && !(await looksBlank(composite))) return composite;
	const full = readPsd(bytes, { useImageData: true, skipThumbnail: true, skipCompositeImageData: true });
	return flattenLayers(full);
}

export async function replaceImage(opts: {
	series: Series;
	episode: Episode;
	user: PublicUser;
	imageId: string;
	bytes: Buffer;
	name: string;
}): Promise<{ image: ImageRow; canUndo: true }> {
	if (jobSnapshot(opts.episode.id)?.running) {
		throw new ReplaceError('AI translate is already running on this chapter', 409);
	}
	const row = await db.select().from(images).where(eq(images.id, opts.imageId)).get();
	if (!row || row.episodeId !== opts.episode.id) throw new ReplaceError('Image not found', 404);

	const path = imagePath(opts.series.slug, opts.episode.slug, row.filename);
	if (!existsSync(path)) throw new ReplaceError('Image file missing', 404);
	await ensureOriginal(opts.series.slug, opts.episode.slug, row.filename);

	const source = isPsd(opts.bytes, opts.name) ? await decodePsd(opts.bytes) : sharp(opts.bytes);
	const flat = source.flatten({ background: { r: 255, g: 255, b: 255 } });
	const ext = (row.filename.match(/\.([^.]+)$/)?.[1] || 'jpg').toLowerCase();
	const encoded =
		ext === 'png'
			? flat.png()
			: ext === 'webp'
				? flat.webp({ quality: 95 })
				: flat.jpeg({ quality: 95, mozjpeg: true });
	const { data, info } = await encoded.toBuffer({ resolveWithObject: true });

	const bak = await nextImageBackupPath(opts.series.slug, opts.episode.slug, row.filename);
	await copyFile(path, bak);
	const tmp = `${path}.tmp.${ext}`;
	await writeFile(tmp, data);
	await rename(tmp, path);

	const t = now();
	await db.update(images).set({ width: info.width, height: info.height, updatedAt: t }).where(eq(images.id, row.id));
	const image = toImage({ ...row, width: info.width, height: info.height, updatedAt: t });
	broadcast(opts.episode.id, { type: 'image:upsert', image });
	void logActivity({
		seriesId: opts.series.id,
		episodeId: opts.episode.id,
		userId: opts.user.id,
		action: 'replaced_image',
		payload: { imageId: row.id, filename: row.filename, source: opts.name }
	}).then((entry) => broadcast(opts.episode.id, { type: 'activity', entry }));
	return { image, canUndo: true };
}
