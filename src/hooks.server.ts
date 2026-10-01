import { discoverModelPackages } from '$lib/server/modelPackages';
discoverModelPackages();
import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import '$lib/server/db';
import { getUserBySession, SESSION_COOKIE, userCount } from '$lib/server/auth';

const PUBLIC = new Set(['/login', '/setup']);

export const handle: Handle = async ({ event, resolve }) => {
	const sessionId = event.cookies.get(SESSION_COOKIE);
	event.locals.user = await getUserBySession(sessionId);
	event.locals.userCount = await userCount();

	const path = event.url.pathname;
	const isPublic =
		PUBLIC.has(path) || path.startsWith('/api/auth/') || path.startsWith('/p/');

	if (event.locals.userCount === 0 && path !== '/setup' && !path.startsWith('/api/auth/setup')) {
		if (path.startsWith('/api/')) {
			return new Response(JSON.stringify({ error: 'Setup required' }), {
				status: 409,
				headers: { 'content-type': 'application/json' }
			});
		}
		throw redirect(303, '/setup');
	}

	if (event.locals.userCount > 0 && path === '/setup') {
		throw redirect(303, event.locals.user ? '/' : '/login');
	}

	if (!event.locals.user && !isPublic && event.locals.userCount > 0) {
		if (path.startsWith('/api/')) {
			return new Response(JSON.stringify({ error: 'Unauthorized' }), {
				status: 401,
				headers: { 'content-type': 'application/json' }
			});
		}
		throw redirect(303, '/login');
	}

	return resolve(event);
};
