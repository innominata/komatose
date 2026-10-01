import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { parseOpenAiModelList } from '$lib/cliModelLists';
import { REMOTE_PROVIDERS } from '$lib/remoteProviders';
import { envVar } from '$lib/server/envFile';
import { fail, messageOf, requireManageUsers, requireUser, statusOf } from '$lib/server/http';
import { normalizeHttpBase } from '$lib/server/modelConnection';
import { openaiListModels } from '$lib/server/openaiHttp';

/**
 * Probe budget for an unsaved endpoint: long enough for a slow first hop to a
 * provider across the world, short enough that the admin form stays snappy.
 */
const PROBE_TIMEOUT_MS = 8000;

/**
 * Probe keys are sent as Bearer tokens to a URL the operator types. Allow catalog
 * names and ordinary key variables, and refuse the app's own secrets.
 */
const BLOCKED_PROBE_KEY = /SECRET|PASSWORD|SESSION|DATABASE|COOKIE|^SCAN_/;

function allowedProbeKeyEnv(name: string): boolean {
	if (!name) return true;
	if (!/^[A-Z][A-Z0-9_]*$/.test(name) || BLOCKED_PROBE_KEY.test(name)) return false;
	if (/_(API_KEY|KEY|TOKEN)$/.test(name)) return true;
	return REMOTE_PROVIDERS.some((item) => item.apiKeyEnv === name);
}

/** The secret lives in `.env` and travels only in the Authorization header; scrub it from echoes. */
function redactKey(text: string, apiKey: string): string {
	return apiKey ? text.split(apiKey).join('[redacted]') : text;
}

/** `openaiListModels` reports non-2xx as `HTTP <status>`; keep the number for the UI badge. */
function httpStatusOf(e: unknown): number | undefined {
	const match = /^HTTP (\d{3})/.exec(e instanceof Error ? e.message : '');
	return match ? Number(match[1]) : undefined;
}

/** Transport failures are cryptic ("fetch failed"); give the admin something readable instead. */
function probeErrorText(e: unknown): string {
	if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError'))
		return `No response after ${PROBE_TIMEOUT_MS / 1000} seconds`;
	const text = messageOf(e);
	return text === 'fetch failed' ? 'Could not reach the endpoint' : text;
}

/** The catalog is read-only here; the UI searches/filters it client-side. */
export const GET: RequestHandler = async ({ locals }) => {
	try {
		requireManageUsers(requireUser(locals.user));
		return json({ ok: true, providers: REMOTE_PROVIDERS });
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};

/**
 * `action: 'probe'` reaches an endpoint BEFORE it is saved: the URL is normalized
 * the way a saved row would be and the key is read from `.env` by name, so a
 * broken or unauthorized host never lands in the registry.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	try {
		requireManageUsers(requireUser(locals.user));
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
		const action = String(body.action || '');
		if (action === 'probe') {
			const keyEnv = String(body.apiKeyEnv || '').trim();
			// The request carries a variable NAME only — anything else could smuggle
			// a raw secret into a value that later gets stored as an env var name.
			if (!allowedProbeKeyEnv(keyEnv))
				return fail(400, 'Key variable must look like OPENAI_API_KEY');
			let baseUrl: string;
			try {
				baseUrl = normalizeHttpBase(String(body.baseUrl || ''));
			} catch (e) {
				return fail(400, messageOf(e));
			}
			const apiKey = keyEnv ? envVar(keyEnv) : '';
			const base = { ok: true, keySet: Boolean(apiKey), keyEnv, models: [] as { id: string; label: string }[] };
			try {
				const list = await openaiListModels(baseUrl, apiKey, AbortSignal.timeout(PROBE_TIMEOUT_MS));
				return json({ ...base, reachable: true, models: parseOpenAiModelList(list) });
			} catch (e) {
				const status = httpStatusOf(e);
				return json({
					...base,
					reachable: false,
					...(status != null ? { status } : {}),
					error: redactKey(probeErrorText(e), apiKey),
				});
			}
		}
		return fail(400, 'Unknown action');
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};
