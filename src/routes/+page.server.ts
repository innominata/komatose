import { fail } from '@sveltejs/kit';
import { canCreateSeries, canUpload, grantSeriesMembership, grantTestSeriesAccess, isScanlator, isTestSeries } from '$lib/server/access';
import { db } from '$lib/server/db';
import { episodes, series } from '$lib/server/db/schema';
import { nid, now, slugify } from '$lib/server/ids';
import { listSeriesForUser, uniqueSlug } from '$lib/server/queries';
import { logActivity } from '$lib/server/activity';
import { addTestPages } from '$lib/server/testPages';
import { eq } from 'drizzle-orm';
import { TEST_SERIES_TITLE } from '$lib/types';
import { putDoc } from '$lib/server/workflowStore';
import { saveSeriesCredit } from '$lib/server/seriesCredits';
import { sniffMime } from '$lib/server/storage';
import sharp from 'sharp';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user!;
	if (isScanlator(user)) await grantTestSeriesAccess(user.id);
	const items = await listSeriesForUser(user.id, user.role === 'admin');
	const counts: Record<string, number> = {};
	for (const s of items) {
		const eps = await db.select({ id: episodes.id }).from(episodes).where(eq(episodes.seriesId, s.id));
		counts[s.id] = eps.length;
	}
	return { series: items, counts, canCreate: canCreateSeries(user), canBackup: canUpload(user) };
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const user = locals.user!;
		if (!canCreateSeries(user)) return fail(403, { error: 'Forbidden' });
		const form = await request.formData();
		const title = String(form.get('title') || '').trim();
		if (!title) return fail(400, { error: 'Title required' });
		const pageMode = String(form.get('pageMode') || 'pages');
		const lang = String(form.get('lang') || 'japanese');
		const direction = String(form.get('direction') || (lang === 'korean' ? 'ltr' : 'rtl'));
		if (pageMode !== 'pages' && pageMode !== 'strip') return fail(400, { error: 'Choose Pages or Strip' });
		if (lang !== 'japanese' && lang !== 'korean') return fail(400, { error: 'Choose Japanese or Korean' });
		if (direction !== 'ltr' && direction !== 'rtl') return fail(400, { error: 'Choose a reading direction' });
		const creditFiles: { kind: 'pre' | 'post'; file: File; bytes: Buffer }[] = [];
		for (const kind of ['pre', 'post'] as const) {
			const file = form.get(kind);
			if (!(file instanceof File) || !file.size) continue;
			if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(sniffMime(file.name, file.type)))
				return fail(400, { error: `Unsupported ${kind}-credits image type` });
			try {
				const bytes = Buffer.from(await file.arrayBuffer());
				const meta = await sharp(bytes).metadata();
				if (!meta.width || !meta.height) throw new Error('Empty image');
				creditFiles.push({ kind, file, bytes });
			} catch {
				return fail(400, { error: `Could not read ${kind}-credits image` });
			}
		}
		if (isTestSeries({ title, slug: '' })) {
			const existing = await db.select({ id: series.id }).from(series).where(eq(series.title, TEST_SERIES_TITLE)).get();
			if (existing) return fail(400, { error: 'Test already exists as the shared testing series' });
		}
		const slug = await uniqueSlug('series', slugify(title));
		const id = nid();
		const t = now();
		await db.insert(series).values({
			id,
			slug,
			title,
			notes: '',
			glossary: '[]',
			createdBy: user.id,
			createdAt: t,
			updatedAt: t
		});
		putDoc(null, `series:${id}`, { pageMode, lang, direction }, 0);
		await grantSeriesMembership(id, user.id);
		for (const { kind, file, bytes } of creditFiles)
			await saveSeriesCredit(id, kind, file.name, bytes, file.type);
		await logActivity({ seriesId: id, userId: user.id, action: 'created_series', payload: { title } });
		return { ok: true, seriesId: id };
	},
	addTestPages: async ({ locals }) => {
		const user = locals.user!;
		if (!canCreateSeries(user)) return fail(403, { error: 'Forbidden' });
		try {
			return { testPages: await addTestPages(user.id) };
		} catch (e) {
			return fail(500, { error: e instanceof Error ? e.message : 'Could not add test pages' });
		}
	}
};
