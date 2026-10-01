import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Visibility and per-model tasks live in Admin → Models → Jobs & defaults.
export const load: PageServerLoad = async () => {
	throw redirect(307, '/admin/models/jobs');
};
