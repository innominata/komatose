import { error, fail } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { renderSafeMarkdown } from '$lib/safeMarkdown';
import { canCreateSeries, canClean, canEditStickies, canEditTranslations, canUpload, hasSeriesAccess, isTestSeries } from '$lib/server/access';
import { logActivity } from '$lib/server/activity';
import { db } from '$lib/server/db';
import { episodes, series, seriesMembers, users } from '$lib/server/db/schema';
import { nid, now, episodeSlugify } from '$lib/server/ids';
import { getSeries, toEpisode, uniqueSlug } from '$lib/server/queries';
import { duplicateEpisode, moveEpisode, setEpisodeTitle, setSeriesTitle, deleteEpisode } from '$lib/server/episodes';
import { parseGlossary, serializeGlossary } from '$lib/glossary';
import { listFonts, uploadFont } from '$lib/server/typesetting';
import { getDoc } from '$lib/server/workflowStore';
import { saveSeriesTypeSettings } from '$lib/server/workflowService';
import { allTypeStyles, type Preferences } from '$lib/workflow';
import { activeRegionKinds } from '$lib/regionCatalog';
import { messageOf, statusOf } from '$lib/server/http';
import { EPISODE_STATUSES } from '$lib/types';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const user = locals.user!;
	const s = await getSeries(params.id);
	if (!s) error(404, 'Series not found');
	if (!(await hasSeriesAccess(user, s.id))) error(403, 'Forbidden');
	const eps = await db.select().from(episodes).where(eq(episodes.seriesId, s.id));
	const members = await db
		.select({ id: users.id, username: users.username, role: users.role })
		.from(seriesMembers)
		.innerJoin(users, eq(seriesMembers.userId, users.id))
		.where(eq(seriesMembers.seriesId, s.id));
	const notesHtml = renderSafeMarkdown(s.notes || '');
	const typeDoc = getDoc<Partial<Preferences>>(`series:${s.id}`, {});
	return {
		series: s,
		episodes: eps.map(toEpisode).sort((a, b) => a.sortOrder - b.sortOrder),
		members,
		notesHtml,
		fonts: listFonts(s.id),
		typeRevision: typeDoc.revision,
		typeStyles: allTypeStyles(typeDoc.data),
		typeStyle: allTypeStyles(typeDoc.data)['""'],
		regionKinds: activeRegionKinds(typeDoc.data.regionKinds),
		canUpload: canUpload(user),
		canRename: canUpload(user) && (user.role === 'admin' || !isTestSeries(s)),
		canEdit: canEditTranslations(user),
		canEditStickies: canEditStickies(user),
		canManageType: canUpload(user) || canClean(user),
		canAdmin: canCreateSeries(user),
		statuses: EPISODE_STATUSES
	};
};

export const actions: Actions = {
	rename: async ({ request, locals, params }) => {
		const user = locals.user!;
		if (!canUpload(user)) return fail(403, { error: 'Forbidden' });
		if (!(await hasSeriesAccess(user, params.id))) return fail(403, { error: 'Forbidden' });
		const form = await request.formData();
		const title = String(form.get('title') || '').trim();
		if (!title) return fail(400, { error: 'Title required' });
		const existing = await getSeries(params.id);
		if (!existing) return fail(404, { error: 'Series not found' });
		if (user.role !== 'admin' && isTestSeries(existing) && title !== existing.title) {
			return fail(400, { error: 'The shared Test series cannot be renamed' });
		}
		try {
			const result = await setSeriesTitle({ series: existing, title });
			await logActivity({
				seriesId: params.id,
				userId: user.id,
				action: 'renamed_series',
				payload: { from: existing.title, title: result.title, slug: result.slug }
			});
			return { ok: true };
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Rename failed' });
		}
	},
	notes: async ({ request, locals, params }) => {
		const user = locals.user!;
		if (!(await hasSeriesAccess(user, params.id))) return fail(403, { error: 'Forbidden' });
		const form = await request.formData();
		const notes = String(form.get('notes') || '');
		await db.update(series).set({ notes, updatedAt: now() }).where(eq(series.id, params.id));
		await logActivity({ seriesId: params.id, userId: user.id, action: 'updated_series_notes' });
		return { ok: true };
	},
	createEpisode: async ({ request, locals, params }) => {
		const user = locals.user!;
		if (!canUpload(user)) return fail(403, { error: 'Forbidden' });
		if (!(await hasSeriesAccess(user, params.id))) return fail(403, { error: 'Forbidden' });
		const form = await request.formData();
		const title = String(form.get('title') || '').trim();
		if (!title) return fail(400, { error: 'Title required' });
		const existing = await db.select().from(episodes).where(eq(episodes.seriesId, params.id));
		const slug = await uniqueSlug('episode', episodeSlugify(title), params.id);
		const id = nid();
		const t = now();
		try {
			await db.insert(episodes).values({
				id,
				seriesId: params.id,
				slug,
				title,
				sortOrder: existing.length,
				status: 'raws',
				glossary: '[]',
				createdAt: t,
				updatedAt: t
			});
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Could not add chapter' });
		}
		await logActivity({
			seriesId: params.id,
			episodeId: id,
			userId: user.id,
			action: 'created_episode',
			payload: { title }
		});
		return { ok: true };
	},
	renameEpisode: async ({ request, locals, params }) => {
		const user = locals.user!;
		if (!canEditTranslations(user)) return fail(403, { error: 'Forbidden' });
		if (!(await hasSeriesAccess(user, params.id))) return fail(403, { error: 'Forbidden' });
		const form = await request.formData();
		const episodeId = String(form.get('episodeId') || '');
		const title = String(form.get('title') || '').trim();
		const ep = await db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
		if (!ep || ep.seriesId !== params.id) return fail(404, { error: 'Chapter not found' });
		const s = await getSeries(params.id);
		if (!s) return fail(404, { error: 'Series not found' });
		try {
			const result = await setEpisodeTitle({ series: s, episode: toEpisode(ep), title });
			await logActivity({
				seriesId: params.id,
				episodeId,
				userId: user.id,
				action: 'renamed_episode',
				payload: { from: ep.title, title: result.title, slug: result.slug }
			});
			return { ok: true };
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Rename failed' });
		}
	},
	moveEpisode: async ({ request, locals, params }) => {
		const user = locals.user!;
		if (!canEditTranslations(user)) return fail(403, { error: 'Forbidden' });
		if (!(await hasSeriesAccess(user, params.id))) return fail(403, { error: 'Forbidden' });
		const form = await request.formData();
		const episodeId = String(form.get('episodeId') || '');
		const dir = String(form.get('dir') || '');
		if (dir !== 'up' && dir !== 'down') return fail(400, { error: 'Invalid direction' });
		await moveEpisode({ seriesId: params.id, episodeId, dir });
		await logActivity({
			seriesId: params.id,
			episodeId,
			userId: user.id,
			action: 'reordered_episode',
			payload: { dir }
		});
		return { ok: true };
	},
	deleteEpisode: async ({ request, locals, params }) => {
		const user = locals.user!;
		if (!canUpload(user)) return fail(403, { error: 'Forbidden' });
		if (!(await hasSeriesAccess(user, params.id))) return fail(403, { error: 'Forbidden' });
		const form = await request.formData();
		const episodeId = String(form.get('episodeId') || '');
		const ep = await db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
		if (!ep || ep.seriesId !== params.id) return fail(404, { error: 'Chapter not found' });
		const s = await getSeries(params.id);
		if (!s) return fail(404, { error: 'Series not found' });
		await deleteEpisode({ series: s, episode: toEpisode(ep) });
		await logActivity({
			seriesId: params.id,
			userId: user.id,
			action: 'deleted_episode',
			payload: { title: ep.title, slug: ep.slug }
		});
		return { ok: true };
	},
	duplicateEpisode: async ({ request, locals, params }) => {
		const user = locals.user!;
		if (!canUpload(user)) return fail(403, { error: 'Forbidden' });
		if (!(await hasSeriesAccess(user, params.id))) return fail(403, { error: 'Forbidden' });
		const form = await request.formData();
		const episodeId = String(form.get('episodeId') || '');
		const ep = await db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
		if (!ep || ep.seriesId !== params.id) return fail(404, { error: 'Chapter not found' });
		const s = await getSeries(params.id);
		if (!s) return fail(404, { error: 'Series not found' });
		try {
			const result = await duplicateEpisode({ series: s, episode: toEpisode(ep), user });
			await logActivity({
				seriesId: params.id,
				episodeId: result.id,
				userId: user.id,
				action: 'duplicated_episode',
				payload: { sourceId: episodeId, title: result.title }
			});
			return { ok: true };
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Duplicate failed' });
		}
	},
	uploadFont: async ({ request, locals, params }) => {
		const user = locals.user!;
		if (!canUpload(user) && !canClean(user)) return fail(403, { error: 'Forbidden' });
		if (!(await hasSeriesAccess(user, params.id))) return fail(403, { error: 'Forbidden' });
		try {
			const form = await request.formData();
			const fonts = form.getAll('font').filter((f): f is File => f instanceof File && f.size > 0);
			if (!fonts.length) return fail(400, { error: 'Choose a font file' });
			let added = 0;
			let duplicates = 0;
			const category = form.get('category');
			for (const font of fonts) {
				const result = await uploadFont(params.id, font.name, Buffer.from(await font.arrayBuffer()), category);
				if (result.duplicate) duplicates++;
				else added++;
				await logActivity({
					seriesId: params.id,
					userId: user.id,
					action: 'uploaded_series_font',
					payload: { filename: font.name }
				});
			}
			const message =
				fonts.length === 1
					? duplicates
						? 'Font already on this series.'
						: 'Font added to this series.'
					: duplicates && added
						? `Added ${added} fonts (${duplicates} already on this series).`
						: duplicates
							? `All ${duplicates} fonts already on this series.`
							: `Added ${added} fonts to this series.`;
			return { ok: true, message };
		} catch (e) {
			return fail(statusOf(e), { error: messageOf(e) });
		}
	},
	typeSettings: async ({ request, locals, params }) => {
		const user = locals.user!;
		if (!canUpload(user) && !canClean(user)) return fail(403, { error: 'Forbidden' });
		if (!(await hasSeriesAccess(user, params.id))) return fail(403, { error: 'Forbidden' });
		try {
			const body = await request.json();
			const doc = saveSeriesTypeSettings(params.id, Number(body.expectedRevision), {
				style: body.style,
				styles: body.styles
			});
			await logActivity({
				seriesId: params.id,
				userId: user.id,
				action: 'updated_series_type',
				payload: { types: Object.keys(body.styles || {}) }
			});
			return { ok: true, message: 'Series type settings saved.', revision: doc.revision };
		} catch (e) {
			return fail(statusOf(e), { error: messageOf(e) });
		}
	},
	glossary: async ({ request, locals, params }) => {
		const user = locals.user!;
		if (!canEditStickies(user)) return fail(403, { error: 'Forbidden' });
		if (!(await hasSeriesAccess(user, params.id))) return fail(403, { error: 'Forbidden' });
		const form = await request.formData();
		const glossary = parseGlossary(String(form.get('glossary') || '[]'));
		for (const term of glossary) term.edited = true;
		await db
			.update(series)
			.set({ glossary: serializeGlossary(glossary), updatedAt: now() })
			.where(eq(series.id, params.id));
		await logActivity({ seriesId: params.id, userId: user.id, action: 'updated_series_glossary' });
		return { ok: true };
	}
};
