import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Setup's installers, services and model rows all live in Admin → Models now.
export const load: PageServerLoad = async () => {
	throw redirect(307, '/admin/models');
};
