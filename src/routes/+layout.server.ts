import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	return {
		user: locals.user,
		userCount: locals.userCount,
		path: url.pathname
	};
};
