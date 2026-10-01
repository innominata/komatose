import { fail } from '@sveltejs/kit';
import { canCreateSeries, grantSeriesMembership, grantTestSeriesAccess, isScanlator, isTestSeries } from '$lib/server/access';
import { db } from '$lib/server/db';
import { episodes, series } from '$lib/server/db/schema';
import { nid, now, slugify } from '$lib/server/ids';
import { listSeriesForUser, uniqueSlug } from '$lib/server/queries';
import { logActivity } from '$lib/server/activity';
import { addTestPages } from '$lib/server/testPages';
import { eq } from 'drizzle-orm';
import { TEST_SERIES_TITLE } from '$lib/types';
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
	return { series: items, counts, canCreate: canCreateSeries(user) };
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const user = locals.user!;
		if (!canCreateSeries(user)) return fail(403, { error: 'Forbidden' });
		const form = await request.formData();
		const title = String(form.get('title') || '').trim();
		if (!title) return fail(400, { error: 'Title required' });
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
		await grantSeriesMembership(id, user.id);
		await logActivity({ seriesId: id, userId: user.id, action: 'created_series', payload: { title } });
		return { ok: true };
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
