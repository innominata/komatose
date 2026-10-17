import { building } from '$app/environment';
import { recoverDirectorRuns } from '$lib/server/directorService';
import { discoverModelPackages } from '$lib/server/modelPackages';
discoverModelPackages();
import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import '$lib/server/db';
import { getUserBySession, SESSION_COOKIE, userCount } from '$lib/server/auth';
import { directorLocked } from '$lib/server/directorAudit';
import { requestSeriesId, seriesMaintenanceMessage, trackSeriesWrite } from '$lib/server/seriesMaintenance';
import { recoverSeriesRestores } from '$lib/server/seriesBackups';

const backupRecovery = building ? Promise.resolve() : recoverSeriesRestores();

if (!building) void backupRecovery.then(() => recoverDirectorRuns()).catch(error => console.error('Director recovery:', error));

const PUBLIC = new Set(['/login', '/setup']);

export const handle: Handle = async ({ event, resolve }) => {
	await backupRecovery;
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
	const episodeWrite = /^\/api\/episodes\/([^/]+)(?:\/|$)/.exec(path);
	if (episodeWrite && !['GET','HEAD','OPTIONS'].includes(event.request.method) &&
		!path.startsWith(`/api/episodes/${episodeWrite[1]}/director`) && directorLocked(episodeWrite[1])) {
		return new Response(JSON.stringify({error:'Director is editing this chapter. Pause it before making manual changes.'}),
			{status:409,headers:{'content-type':'application/json'}});
	}

	const seriesId = requestSeriesId(path);
	if (seriesId) {
		const message = seriesMaintenanceMessage(seriesId);
		if (message) return new Response(JSON.stringify({ error: message }), { status: 409, headers: { 'content-type': 'application/json' } });
		// Backup actions acquire their own exclusive maintenance lock.
		const backupAction = /^\/series\/[^/]+\/?$/.test(path) && event.request.method === 'POST' && event.url.searchParams.has('/backup');
		if (!['GET', 'HEAD', 'OPTIONS'].includes(event.request.method) && !backupAction) {
			const finished = trackSeriesWrite(seriesId);
			try { return await resolve(event); }
			finally { finished(); }
		}
	}
	return resolve(event);
};
