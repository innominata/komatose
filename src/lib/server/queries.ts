import { and, asc, eq, inArray } from 'drizzle-orm';
import type { CommentRow, Episode, ImageRow, LineRow, LineType, Series } from '../types';
import { parsePageRole, parseSeriesCredits } from '../credits';
import { parseGlossary } from '../glossary';
import { stickyMainText } from '../prCorrection';
import { db } from './db';
import { comments, episodes, images, lines, series, seriesMembers, users } from './db/schema';

export function toSeries(row: typeof series.$inferSelect): Series {
	return {
		id: row.id,
		slug: row.slug,
		title: row.title,
		notes: row.notes,
		glossary: parseGlossary(row.glossary ?? '[]'),
		credits: parseSeriesCredits(row.credits),
		createdBy: row.createdBy ?? null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

export function toEpisode(row: typeof episodes.$inferSelect): Episode {
	return {
		id: row.id,
		seriesId: row.seriesId,
		slug: row.slug,
		title: row.title,
		sortOrder: row.sortOrder,
		status: row.status as Episode['status'],
		numberingStale: row.numberingStale,
		revision: row.revision,
		glossary: parseGlossary(row.glossary ?? '[]'),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

export function toImage(row: Omit<typeof images.$inferSelect, 'dpi' | 'pageNumber' | 'captionRevision'> & Partial<typeof images.$inferSelect>): ImageRow {
	return {
		...row,
		caption: row.caption || '',
		role: parsePageRole(row.role),
		updatedAt: row.updatedAt || row.createdAt
	};
}

export function toLine(row: Omit<typeof lines.$inferSelect, 'source' | 'ocrConfidence' | 'sourceState' | 'ignoreReason' | 'revision' | 'invert'> & Partial<typeof lines.$inferSelect>): LineRow {
	return {
		id: row.id,
		episodeId: row.episodeId,
		imageId: row.imageId,
		source: row.source ?? '',
		ocrConfidence: row.ocrConfidence ?? null,
		sourceState: row.sourceState ?? 'unreadable',
		ignoreReason: row.ignoreReason ?? '',
		revision: row.revision ?? 0,
		body: row.body,
		lineType: row.lineType as LineType,
		status: row.status as LineRow['status'],
		placed: Boolean(row.placed),
		invert: row.invert == null ? null : Boolean(row.invert),
		x: row.x,
		y: row.y,
		w: row.w,
		h: row.h,
		sidebarX: row.sidebarX,
		sidebarY: row.sidebarY,
		sidebarW: row.sidebarW,
		sidebarH: row.sidebarH,
		sortOrder: row.sortOrder,
		createdBy: row.createdBy,
		updatedBy: row.updatedBy,
		updatedAt: row.updatedAt
	};
}

export async function getSeries(id: string) {
	const row = await db.select().from(series).where(eq(series.id, id)).get();
	return row ? toSeries(row) : null;
}

export async function getEpisode(id: string) {
	const row = await db.select().from(episodes).where(eq(episodes.id, id)).get();
	return row ? toEpisode(row) : null;
}

export async function listImages(episodeId: string): Promise<ImageRow[]> {
	const rows = await db
		.select()
		.from(images)
		.where(eq(images.episodeId, episodeId))
		.orderBy(asc(images.sortOrder));
	return rows.map(toImage);
}

export async function listLines(episodeId: string): Promise<LineRow[]> {
	const rows = await db
		.select()
		.from(lines)
		.where(eq(lines.episodeId, episodeId))
		.orderBy(asc(lines.sortOrder), asc(lines.updatedAt));
	return rows.map(toLine);
}

export function toComment(
	row: { revision?: number; id: string; lineId: string; userId: string; body: string; correction: boolean | null; createdAt: number },
	username: string
): CommentRow {
	return {
		id: row.id,
		revision: row.revision ?? 0,
		lineId: row.lineId,
		userId: row.userId,
		username,
		body: row.body,
		correction: Boolean(row.correction),
		createdAt: row.createdAt
	};
}

export async function listComments(episodeId: string): Promise<CommentRow[]> {
	const episodeLines = await db.select({ id: lines.id }).from(lines).where(eq(lines.episodeId, episodeId));
	const ids = episodeLines.map((l) => l.id);
	if (!ids.length) return [];
	const rows = await db
		.select({
			id: comments.id,
			revision: comments.revision,
			lineId: comments.lineId,
			userId: comments.userId,
			username: users.username,
			body: comments.body,
			correction: comments.correction,
			createdAt: comments.createdAt
		})
		.from(comments)
		.innerJoin(users, eq(comments.userId, users.id))
		.where(inArray(comments.lineId, ids))
		.orderBy(asc(comments.createdAt));
	return rows.map((r) => ({ ...r, correction: Boolean(r.correction) }));
}

export async function listSeriesForUser(userId: string, isAdmin: boolean): Promise<Series[]> {
	if (isAdmin) {
		const rows = await db.select().from(series).orderBy(asc(series.title));
		return rows.map(toSeries);
	}
	const rows = await db
		.select({ series })
		.from(seriesMembers)
		.innerJoin(series, eq(seriesMembers.seriesId, series.id))
		.where(eq(seriesMembers.userId, userId))
		.orderBy(asc(series.title));
	return rows.map((r) => toSeries(r.series));
}

export async function uniqueSlug(table: 'series' | 'episode', base: string, seriesId?: string): Promise<string> {
	let slug = base;
	for (let i = 0; i < 50; i++) {
		if (table === 'series') {
			const hit = await db.select({ id: series.id }).from(series).where(eq(series.slug, slug)).get();
			if (!hit) return slug;
		} else {
			const hit = await db
				.select({ id: episodes.id })
				.from(episodes)
				.where(and(eq(episodes.seriesId, seriesId!), eq(episodes.slug, slug)))
				.get();
			if (!hit) return slug;
		}
		slug = `${base}-${i + 2}`;
	}
	return `${base}-${Date.now()}`;
}

export async function getEpisodePreviewToken(episodeId: string): Promise<string | null> {
	const row = await db
		.select({ previewToken: episodes.previewToken })
		.from(episodes)
		.where(eq(episodes.id, episodeId))
		.get();
	return row?.previewToken ?? null;
}

export type PreviewPayload = {
	seriesTitle: string;
	episodeTitle: string;
	images: ImageRow[];
	lines: LineRow[];
};

export async function loadPreviewByToken(token: string): Promise<PreviewPayload | null> {
	if (!token || token.length < 20 || token.length > 80) return null;
	const ep = await db.select().from(episodes).where(eq(episodes.previewToken, token)).get();
	if (!ep) return null;
	const s = await getSeries(ep.seriesId);
	if (!s) return null;
	const [imgs, lns, comms] = await Promise.all([listImages(ep.id), listLines(ep.id), listComments(ep.id)]);
	const lines = lns
		.filter((l) => l.placed && l.imageId)
		.map((l) => ({ ...l, body: stickyMainText(l, comms) }));
	return {
		seriesTitle: s.title,
		episodeTitle: ep.title,
		images: imgs,
		lines
	};
}
