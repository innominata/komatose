import type { RequestEvent } from '@sveltejs/kit';
import { AI_USER_ID } from '../types';
import { logRequestActivity, withRequestLog } from './activity';
import { sqlite } from './db';
import { broadcast } from './realtime';

/** Requests that change nothing, or that only save the caller's own view settings. */
const SKIP_PATHS = [/^\/api\/romanize\b/, /^\/api\/me\/settings\b/, /^\/api\/episodes\/[^/]+\/preview\b/, /^\/api\/auth\//];
const SKIP_ACTIONS = new Set([
	'workflow:postprocess-previews',
	'workflow:prepare',
	'workflow:preferences',
	'director:preflight',
	'director:dismiss-warning',
]);

/** Body fields worth keeping. Anything else (text, strokes, passwords) never reaches the log. */
const KEEP = ['scope', 'method', 'history', 'step', 'engine', 'decision', 'format', 'kind', 'mode', 'lineType'] as const;

const MAX_BODY = 512 * 1024;

function isWrite(method: string) {
	return !['GET', 'HEAD', 'OPTIONS'].includes(method);
}

/** `workflow`, `images`, `users`… — the last fixed segment of the route. */
function areaOf(event: RequestEvent): string {
	const route = event.route.id || event.url.pathname;
	const fixed = route.split('/').filter((part) => part && !part.startsWith('[') && !part.startsWith('('));
	return fixed[fixed.length - 1] || 'app';
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value && value.length <= 200 ? value : undefined;
}

function pageNumber(imageId: string): number | undefined {
	const row = sqlite.prepare('SELECT page_number, sort_order FROM images WHERE id=?').get(imageId) as
		| { page_number: number | null; sort_order: number }
		| undefined;
	return row ? (row.page_number ?? row.sort_order + 1) : undefined;
}

function seriesOf(event: RequestEvent, episodeId: string | null): string | null {
	if (episodeId) {
		const row = sqlite.prepare('SELECT series_id FROM episodes WHERE id=?').get(episodeId) as { series_id: string } | undefined;
		return row?.series_id ?? null;
	}
	const id = event.params.id;
	if (id && /^\/(api\/)?series\//.test(event.route.id || '')) return id;
	return null;
}

/** A copy of a small JSON body; other bodies (uploads, forms) are never copied or read. */
async function readJson(request: Request): Promise<Record<string, unknown>> {
	try {
		const body = await request.json();
		return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
	} catch {
		return {};
	}
}

/**
 * Run a request and, when it changed something and its endpoint wrote no activity entry
 * of its own, record one for the admin activity log.
 */
export async function trackRequestActivity(event: RequestEvent, run: () => Promise<Response>): Promise<Response> {
	const method = event.request.method;
	const path = event.url.pathname;
	if (!isWrite(method) || SKIP_PATHS.some((re) => re.test(path))) return run();
	// Read a copy of the body alongside the handler; the handler consumes the original.
	const type = event.request.headers.get('content-type') || '';
	const size = Number(event.request.headers.get('content-length') || 0);
	const body = type.includes('application/json') && size <= MAX_BODY
		? readJson(event.request.clone())
		: Promise.resolve({} as Record<string, unknown>);
	const tracked = withRequestLog(run);
	const response = await tracked.result;
	try {
		const user = event.locals.user;
		if (!user || user.id === AI_USER_ID || response.status >= 400 || tracked.logged()) return response;
		const area = areaOf(event);
		const formAction = [...event.url.searchParams.keys()].find((key) => key.startsWith('/'))?.slice(1);
		const b = formAction ? {} : await body;
		let name = formAction || str(b.action) || method.toLowerCase();
		if (area === 'workflow' && name === 'page' && (b.history === 'undo' || b.history === 'redo')) name = `page-${b.history}`;
		if (area === 'workflow' && method === 'POST' && !formAction && !b.action) name = 'upload-font';
		const action = `${area}:${name}`;
		if (SKIP_ACTIONS.has(action)) return response;

		const episodeId = event.params.eid ?? null;
		const imageId = str(b.imageId) || event.params.imgid;
		const regionId = str(b.lineId) || (area === 'workflow' || area === 'region-ai' ? str(b.id) : undefined);
		const payload: Record<string, unknown> = {};
		if (imageId) {
			payload.imageId = imageId;
			const page = pageNumber(imageId);
			if (page !== undefined) payload.page = page;
		}
		if (regionId) payload.regionId = regionId;
		if (Array.isArray(b.imageIds)) payload.pages = b.imageIds.length;
		if (Array.isArray(b.ids)) payload.items = b.ids.length;
		for (const key of KEEP) if (str(b[key])) payload[key] = b[key];
		const detail = [payload.method, payload.scope, payload.decision].filter(Boolean).join(', ');
		if (detail) payload.detail = detail;
		if (event.params.id && !episodeId) payload.subjectId = event.params.id;

		const entry = await logRequestActivity({
			seriesId: seriesOf(event, episodeId),
			episodeId,
			userId: user.id,
			action,
			target: [imageId, regionId, payload.scope, payload.method].filter(Boolean).join('|') || path,
			payload,
		});
		if (entry && episodeId) broadcast(episodeId, { type: 'activity', entry });
	} catch (error) {
		console.error('Activity log:', error);
	}
	return response;
}
