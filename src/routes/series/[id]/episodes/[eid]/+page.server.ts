import { error } from '@sveltejs/kit';
import { canClean, canEditTranslations, canManageUsers, canUpload, hasSeriesAccess } from '$lib/server/access';
import { pickerSeedEngines } from '$lib/modelRegistry';
import { listRegistryRows } from '$lib/server/modelRegistryStore';
import { getEpisode, getSeries } from '$lib/server/queries';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const user = locals.user!;
	const s = await getSeries(params.id);
	const ep = await getEpisode(params.eid);
	if (!s || !ep || ep.seriesId !== s.id) error(404, 'Not found');
	if (!(await hasSeriesAccess(user, s.id))) error(403, 'Forbidden');
	return {
		series: s,
		episode: ep,
		user: { id: user.id, role: user.role },
		canEdit: canEditTranslations(user),
		canUpload: canUpload(user),
		canClean: canClean(user),
		canRebuild: canManageUsers(user),
		engines: pickerSeedEngines(listRegistryRows())
	};
};
