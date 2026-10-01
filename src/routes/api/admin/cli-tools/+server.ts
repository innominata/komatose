import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fail, messageOf, requireManageUsers, requireUser, statusOf } from '$lib/server/http';
import { applyCliToolAdminAction, listCliToolAdminStatus } from '$lib/server/cliToolStatus';
import { CliToolsConfigError } from '$lib/server/cliToolSettings';

export const GET: RequestHandler = async ({ locals }) => {
	try {
		requireManageUsers(requireUser(locals.user));
		return json({ ok: true, tools: listCliToolAdminStatus() });
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};

export const POST: RequestHandler = async ({ locals, request }) => {
	try {
		requireManageUsers(requireUser(locals.user));
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
		const tools = applyCliToolAdminAction(String(body.action || ''), body);
		return json({ ok: true, tools });
	} catch (e) {
		if (e instanceof CliToolsConfigError) return fail(400, e.message);
		return fail(statusOf(e), messageOf(e));
	}
};
