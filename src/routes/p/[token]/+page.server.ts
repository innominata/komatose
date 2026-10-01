import { error } from '@sveltejs/kit';
import { loadPreviewByToken } from '$lib/server/queries';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const data = await loadPreviewByToken(params.token);
	if (!data) error(404, 'Preview not found');
	return { ...data, token: params.token };
};
