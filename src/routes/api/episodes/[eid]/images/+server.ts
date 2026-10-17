import { json } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { logActivity } from '$lib/server/activity';
import { db } from '$lib/server/db';
import { episodes, images, lines } from '$lib/server/db/schema';
import { assertEpisodeIdle, fail, messageOf, requireEpisodeAccess, requireUpload, requireUser, statusOf } from '$lib/server/http';
import { nid, now } from '$lib/server/ids';
import { listImages, toImage } from '$lib/server/queries';
import { broadcast } from '$lib/server/realtime';
import { packForStitch, removeImageFile, saveImageFile, sniffMime, stitchPack, STITCH_MIN_COUNT } from '$lib/server/storage';
import sharp from 'sharp';
import { ensurePageThumbnail } from '$lib/server/workflowService';
import { hash, storeAsset, putDoc, getDoc } from '$lib/server/workflowStore';
import { readFile } from 'node:fs/promises';
import { origImagePath } from '$lib/server/storage';
import type { RequestHandler } from './$types';
import { creditRole, isCreditKind } from '$lib/credits';

export const POST: RequestHandler = async ({ locals, params, request }) => {
	try {
		const user = requireUser(locals.user);
		requireUpload(user);
		const { episode, series } = await requireEpisodeAccess(user, params.eid);
		assertEpisodeIdle(episode.id);
		const form = await request.formData();
		const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
		if (!files.length) return fail(400, 'No files');
		const creditKind = form.get('creditKind');
		if (creditKind != null) {
			if (!isCreditKind(creditKind) || files.length !== 1) return fail(400, 'Choose one pre-credits or post-credits image');
			const file = files[0];
			if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(sniffMime(file.name, file.type)))
				return fail(400, 'Unsupported credits image type');
			const bytes = await sharp(Buffer.from(await file.arrayBuffer())).png().toBuffer();
			const current = await listImages(episode.id);
			const role = creditRole(creditKind);
			const previous = current.find((img) => img.role === role);
			if (previous) {
				const attached = await db.select({ id: lines.id }).from(lines).where(eq(lines.imageId, previous.id)).get();
				if (attached) return fail(409, 'Remove regions from the existing credits page before replacing it');
			}
			const sortOrder = previous?.sortOrder ?? (creditKind === 'pre' ? -1 : current.length);
			const saved = await saveImageFile({ seriesSlug: series.slug, episodeSlug: episode.slug,
				sortOrder: Math.max(0, sortOrder), originalName: file.name, bytes, mime: 'image/png' });
			const t = now();
			const row = { id: nid(), episodeId: episode.id, filename: saved.filename,
				originalName: file.name, sortOrder, width: saved.width, height: saved.height,
				dpi: saved.dpi, caption: '', role, createdAt: t, updatedAt: t };
			await db.insert(images).values(row);
			if (previous) {
				await db.delete(images).where(eq(images.id, previous.id));
				await removeImageFile(series.slug, episode.slug, previous.filename);
				broadcast(episode.id, { type: 'image:delete', id: previous.id });
			}
			await db.update(episodes).set({ numberingStale: true, revision: (episode.revision ?? 0) + 1 }).where(eq(episodes.id, episode.id));
			const image = toImage(row);
			broadcast(episode.id, { type: 'image:upsert', image });
			const next = await listImages(episode.id);
			broadcast(episode.id, { type: 'image:reorder', order: next.map((img) => ({ id: img.id, sortOrder: img.sortOrder })) });
			await logActivity({ seriesId: series.id, episodeId: episode.id, userId: user.id,
				action: 'saved_chapter_credits', payload: { kind: creditKind, filename: file.name } });
			return json({ image, all: next, warnings: [] });
		}
		const existing = await listImages(episode.id);
		const beforeId = String(form.get('beforeId') || '');
		const afterId = String(form.get('afterId') || '');
		let insertAt = existing.length;
		if (beforeId) {
			const i = existing.findIndex((img) => img.id === beforeId);
			if (i >= 0) insertAt = i;
		} else if (afterId) {
			const i = existing.findIndex((img) => img.id === afterId);
			if (i >= 0) insertAt = i + 1;
		}
		const incoming = [];
		const uploadHashes: { hash: string; originalName: string }[] = [];
		const warnings: string[] = [];
		const seen = new Set<string>();
		for (const img of existing) { try { seen.add(hash(await readFile(origImagePath(series.slug,episode.slug,img.filename)))); } catch {} }
		for (const file of files) {
			const bytes = Buffer.from(await file.arrayBuffer());
			const digest = await storeAsset(bytes);
			if (seen.has(digest)) warnings.push(`Duplicate content: ${file.name}`);
			seen.add(digest); uploadHashes.push({ hash: digest, originalName:file.name });
			const mime = sniffMime(file.name, file.type);
			const meta = await sharp(bytes).metadata();
			incoming.push({
				bytes,
				originalName: file.name,
				mime,
				width: meta.width || 0,
				height: meta.height || 0
			});
		}
		const packs = form.get('stitch') === 'true' ? packForStitch(incoming) : incoming.map((item) => [item]);
		for (let i = existing.length - 1; i >= insertAt; i--) {
			const img = existing[i];
			await db.update(images).set({ sortOrder: img.sortOrder + packs.length }).where(eq(images.id, img.id));
		}
		const created = [];
		let slice = 0;
		for (let p = 0; p < packs.length; p++) {
			const pack = packs[p];
			const from = slice + 1;
			slice += pack.length;
			const stitched = await stitchPack(pack, { from, to: slice });
			const saved = await saveImageFile({
				seriesSlug: series.slug,
				episodeSlug: episode.slug,
				sortOrder: insertAt + p,
				originalName: stitched.originalName,
				bytes: stitched.bytes,
				mime: stitched.mime
			});
			const row = {
				id: nid(),
				episodeId: episode.id,
				filename: saved.filename,
				originalName: stitched.originalName,
				sortOrder: insertAt + p,
				width: saved.width,
				height: saved.height,
				dpi: saved.dpi,
				caption: '',
				role: 'page',
				createdAt: now(),
				updatedAt: now()
			};
			await db.insert(images).values(row);
			const image = toImage(row);
			created.push(image);
			broadcast(episode.id, { type: 'image:upsert', image });
			await ensurePageThumbnail(series, episode, image);
		}
		const imports = getDoc<{ uploads: {hash:string;originalName:string}[] }>(`uploads:${episode.id}`, {uploads:[]});
		putDoc(episode.id,imports.id,{uploads:[...imports.data.uploads,...uploadHashes]},imports.revision);
		const next = await listImages(episode.id);
		broadcast(
			episode.id,
			{ type: 'image:reorder', order: next.map((img) => ({ id: img.id, sortOrder: img.sortOrder })) }
		);
		const entry = await logActivity({
			seriesId: series.id,
			episodeId: episode.id,
			userId: user.id,
			action: 'uploaded_images',
			payload: { count: created.length, slices: files.length }
		});
		broadcast(episode.id, { type: 'activity', entry });
		return json({ images: created, all: next, warnings });
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	try {
		const user = requireUser(locals.user);
		requireUpload(user);
		const { episode } = await requireEpisodeAccess(user, params.eid);
		assertEpisodeIdle(episode.id);
		const body = await request.json();
		const order = body.order as { id: string; sortOrder: number }[];
		if (!Array.isArray(order)) return fail(400, 'Invalid order');
		const current = await listImages(episode.id);
		if (order.length !== current.length || new Set(order.map(i=>i.id)).size !== current.length || order.some(i=>!current.some(p=>p.id===i.id) || !Number.isInteger(i.sortOrder) || i.sortOrder < 0) || new Set(order.map(i=>i.sortOrder)).size !== current.length) return fail(400, 'Order must include each chapter page exactly once');
		db.transaction(tx => { for (const item of order) tx.update(images).set({sortOrder:item.sortOrder}).where(and(eq(images.id,item.id),eq(images.episodeId,episode.id))).run(); });
		broadcast(episode.id, { type: 'image:reorder', order });
		return json({ ok: true });
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};
