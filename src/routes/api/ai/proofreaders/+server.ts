import { json } from '@sveltejs/kit';
import {
	assertProofreaderGrant,
	grantedProofreaders,
	parseProofreaderId,
	proofreaderStatus,
	startProofreader
} from '$lib/server/proofreadService';
import { fail, messageOf, requireUser, statusOf } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
	try {
		const user = requireUser(locals.user);
		const requested = url.searchParams.get('engine');
		if (!requested) return json({ ok: true, items: await grantedProofreaders(user) });
		const engine = parseProofreaderId(requested);
		assertProofreaderGrant(user, engine);
		return json({ ok: true, ...(await proofreaderStatus(engine)) });
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};

export const POST: RequestHandler = async ({ locals, request }) => {
	try {
		const user = requireUser(locals.user);
		const body = await request.json().catch(() => ({}));
		if (body?.action && body.action !== 'start') return fail(400, 'Unknown proofreader action');
		const engine = parseProofreaderId(body?.engine);
		assertProofreaderGrant(user, engine);
		return json({ ok: true, ...(await startProofreader(engine)) });
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};
