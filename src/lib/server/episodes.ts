import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { and, eq } from 'drizzle-orm';
import { db, sqlite } from './db';
import { activity, comments, episodes, images, lines, series } from './db/schema';
import { episodeSlugify, nid, now, slugify } from './ids';
import { assertEpisodeIdle, cancelAiTranslate } from './aiTranslate';
import { logActivity } from './activity';
import { uniqueSlug } from './queries';
import { broadcast } from './realtime';
import { episodeDir, moveEpisodeDir, moveSeriesDir } from './storage';
import type { Episode, PublicUser, Series } from '../types';

export class EpisodeConflictError extends Error {
	status = 400;
	constructor(message: string) {
		super(message);
	}
}

export async function setSeriesTitle(opts: { series: Series; title: string }): Promise<{ title: string; slug: string }> {
	const title = opts.title.trim();
	if (!title) throw new EpisodeConflictError('Title required');
	const slug = slugify(title);
	const clash = await db.select({ id: series.id }).from(series).where(eq(series.slug, slug)).get();
	if (clash && clash.id !== opts.series.id) {
		throw new EpisodeConflictError(`Series "${title}" already exists`);
	}
	let moved = false;
	try {
		if (slug !== opts.series.slug) {
			await moveSeriesDir(opts.series.slug, slug);
			moved = true;
		}
		await db.update(series).set({ title, slug, updatedAt: now() }).where(eq(series.id, opts.series.id));
	} catch (e) {
		if (moved) {
			await moveSeriesDir(slug, opts.series.slug).catch(() => undefined);
		}
		throw e;
	}
	return { title, slug };
}

export async function setEpisodeTitle(opts: {
	series: Series;
	episode: Episode;
	title: string;
}): Promise<{ title: string; slug: string }> {
	const title = opts.title.trim();
	if (!title) throw new EpisodeConflictError('Title required');
	const slug = episodeSlugify(title);
	const clash = await db
		.select({ id: episodes.id })
		.from(episodes)
		.where(and(eq(episodes.seriesId, opts.series.id), eq(episodes.slug, slug)))
		.get();
	if (clash && clash.id !== opts.episode.id) {
		throw new EpisodeConflictError(`Chapter "${title}" already exists`);
	}
	let moved = false;
	try {
		if (slug !== opts.episode.slug) {
			await moveEpisodeDir(opts.series.slug, opts.episode.slug, slug);
			moved = slug !== opts.episode.slug;
		}
		await db
			.update(episodes)
			.set({ title, slug, updatedAt: now() })
			.where(eq(episodes.id, opts.episode.id));
	} catch (e) {
		if (moved) {
			await moveEpisodeDir(opts.series.slug, slug, opts.episode.slug).catch(() => undefined);
		}
		throw e;
	}
	return { title, slug };
}

export async function moveEpisode(opts: { seriesId: string; episodeId: string; dir: 'up' | 'down' }) {
	const rows = await db.select().from(episodes).where(eq(episodes.seriesId, opts.seriesId));
	const list = rows.sort((a, b) => a.sortOrder - b.sortOrder);
	const idx = list.findIndex((e) => e.id === opts.episodeId);
	if (idx < 0) throw new EpisodeConflictError('Chapter not found');
	const swap = opts.dir === 'up' ? idx - 1 : idx + 1;
	if (swap < 0 || swap >= list.length) return;
	const a = list[idx];
	const b = list[swap];
	await db.update(episodes).set({ sortOrder: b.sortOrder, updatedAt: now() }).where(eq(episodes.id, a.id));
	await db.update(episodes).set({ sortOrder: a.sortOrder, updatedAt: now() }).where(eq(episodes.id, b.id));
}

function remapCopiedValue(value: unknown, maps: Map<string, string>[]): unknown {
	if (typeof value === 'string') {
		for (const map of maps) {
			const next = map.get(value);
			if (next) return next;
		}
		return value;
	}
	if (Array.isArray(value)) return value.map((item) => remapCopiedValue(item, maps));
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			out[key] = remapCopiedValue(item, maps);
		}
		return out;
	}
	return value;
}

function remapWorkflowDocId(
	id: string,
	fromEpisode: string,
	toEpisode: string,
	imageMap: Map<string, string>,
	lineMap: Map<string, string>,
): string | null {
	if (id === `chapter:${fromEpisode}`) return `chapter:${toEpisode}`;
	if (id === `uploads:${fromEpisode}`) return `uploads:${toEpisode}`;
	if (id.startsWith('page:')) {
		const next = imageMap.get(id.slice(5));
		return next ? `page:${next}` : null;
	}
	if (id.startsWith('region:')) {
		const next = lineMap.get(id.slice(7));
		return next ? `region:${next}` : null;
	}
	return null;
}

/** Current chapter/page/region/upload documents only. History and suggestions stay on the original. */
function copyWorkflowDocs(
	fromEpisode: string,
	toEpisode: string,
	imageMap: Map<string, string>,
	lineMap: Map<string, string>,
	updatedAt: number,
) {
	const rows = sqlite
		.prepare('SELECT id, revision, data FROM workflow_docs WHERE episode_id=?')
		.all(fromEpisode) as { id: string; revision: number; data: string }[];
	const insert = sqlite.prepare(
		'INSERT INTO workflow_docs(id,episode_id,revision,data,undo,redo,updated_at) VALUES(?,?,?,?,?,?,?)',
	);
	const maps = [imageMap, lineMap];
	for (const row of rows) {
		const nextId = remapWorkflowDocId(row.id, fromEpisode, toEpisode, imageMap, lineMap);
		if (!nextId) continue;
		let data = row.data;
		try {
			data = JSON.stringify(remapCopiedValue(JSON.parse(row.data), maps));
		} catch {
			/* keep original JSON if a document is malformed */
		}
		insert.run(nextId, toEpisode, row.revision, data, '[]', '[]', updatedAt);
	}
}

export async function duplicateEpisode(opts: {
	series: Series;
	episode: Episode;
	user: PublicUser;
}): Promise<{ id: string; title: string; slug: string }> {
	assertEpisodeIdle(opts.episode.id);
	const title = `${opts.episode.title} (copy)`;
	const slug = await uniqueSlug('episode', episodeSlugify(title), opts.series.id);
	const existing = await db.select({ sortOrder: episodes.sortOrder }).from(episodes).where(eq(episodes.seriesId, opts.series.id));
	const sortOrder = existing.reduce((max, row) => Math.max(max, row.sortOrder), -1) + 1;
	const t = now();
	const id = nid();
	const src = await db.select().from(episodes).where(eq(episodes.id, opts.episode.id)).get();
	await db.insert(episodes).values({
		id,
		seriesId: opts.series.id,
		slug,
		title,
		sortOrder,
		status: opts.episode.status,
		previewToken: null,
		glossary: src?.glossary || '[]',
		createdAt: t,
		updatedAt: t
	});

	const fromDir = episodeDir(opts.series.slug, opts.episode.slug);
	const toDir = episodeDir(opts.series.slug, slug);
	let copiedFiles = false;
	try {
		if (existsSync(fromDir)) {
			await mkdir(toDir, { recursive: true });
			const names = await readdir(fromDir);
			for (const name of names) {
				if (name.includes('.bak') || name === 'undo.json') continue;
				await copyFile(join(fromDir, name), join(toDir, name));
			}
			copiedFiles = true;
		}

		const srcImages = await db.select().from(images).where(eq(images.episodeId, opts.episode.id));
		const imageMap = new Map<string, string>();
		for (const img of srcImages) {
			const newId = nid();
			imageMap.set(img.id, newId);
			await db.insert(images).values({
				...img,
				id: newId,
				episodeId: id,
				createdAt: t,
				updatedAt: t
			});
		}

		const srcLines = await db.select().from(lines).where(eq(lines.episodeId, opts.episode.id));
		const lineMap = new Map<string, string>();
		for (const line of srcLines) {
			const newId = nid();
			lineMap.set(line.id, newId);
			await db.insert(lines).values({
				...line,
				id: newId,
				episodeId: id,
				imageId: line.imageId ? imageMap.get(line.imageId) || null : null,
				updatedAt: t
			});
		}

		const srcComments = await db.select().from(comments);
		for (const c of srcComments) {
			const newLineId = lineMap.get(c.lineId);
			if (!newLineId) continue;
			await db.insert(comments).values({
				...c,
				id: nid(),
				lineId: newLineId,
				createdAt: t
			});
		}

		copyWorkflowDocs(opts.episode.id, id, imageMap, lineMap, t);
	} catch (e) {
		if (copiedFiles) await rm(toDir, { recursive: true, force: true });
		await db.delete(episodes).where(eq(episodes.id, id));
		throw e;
	}

	const entry = await logActivity({
		seriesId: opts.series.id,
		episodeId: id,
		userId: opts.user.id,
		action: 'duplicated_episode',
		payload: { sourceId: opts.episode.id, title }
	});
	broadcast(id, { type: 'activity', entry });
	return { id, title, slug };
}

export async function deleteEpisode(opts: { series: Series; episode: Episode }) {
	cancelAiTranslate(opts.episode.id);
	await db.delete(episodes).where(eq(episodes.id, opts.episode.id));
	await rm(episodeDir(opts.series.slug, opts.episode.slug), { recursive: true, force: true });
}

export async function clearEpisodeMeta(opts: { series: Series; episode: Episode; user: PublicUser }) {
	cancelAiTranslate(opts.episode.id);
	await db.delete(lines).where(eq(lines.episodeId, opts.episode.id));
	await db.delete(activity).where(eq(activity.episodeId, opts.episode.id));
	const updatedAt = now();
	await db
		.update(episodes)
		.set({ status: 'raws', updatedAt })
		.where(eq(episodes.id, opts.episode.id));
	broadcast(opts.episode.id, { type: 'episode:clear' });
	broadcast(opts.episode.id, { type: 'episode:status', status: 'raws', updatedAt });
	const entry = await logActivity({
		seriesId: opts.series.id,
		episodeId: opts.episode.id,
		userId: opts.user.id,
		action: 'cleared_chapter',
		payload: {}
	});
	broadcast(opts.episode.id, { type: 'activity', entry });
	return { updatedAt };
}
