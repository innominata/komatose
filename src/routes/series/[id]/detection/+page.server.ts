import { error } from '@sveltejs/kit';
import { hasSeriesAccess } from '$lib/server/access';
import { getSeries } from '$lib/server/queries';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const s = await getSeries(params.id);
	if (!s) error(404, 'Series not found');
	if (!(await hasSeriesAccess(locals.user!, s.id))) error(403, 'Forbidden');
	return { series: { id: s.id, title: s.title } };
};
