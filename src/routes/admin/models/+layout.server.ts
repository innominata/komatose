import { error } from '@sveltejs/kit';
import { canManageUsers } from '$lib/server/access';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user || !canManageUsers(locals.user)) error(403, 'Forbidden');
	return {};
};
