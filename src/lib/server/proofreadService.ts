/**
 * Client for the external proofreading service.
 *
 * The service is a separate, optional process (see docs/PROOFREADING_SERVICE.md).
 * The application only ever sees a readiness flag, an opaque conversation
 * token, and critique text. When the service is not configured or not
 * reachable, proofreaders are reported unavailable and their tools stay hidden.
 */

import { isProofreaderId, proofreaderLabel, proofreaderOnlyMessage, PROOFREADER_IDS, type ProofreaderId } from '../proofreaders';
import { WorkflowError } from './workflowStore';
import { readUserSettings } from './userSettings';

export type ProofreaderStatus = {
	id: ProofreaderId;
	ready: boolean;
	context: string;
	reason: string;
};

const DEFAULT_URL = 'http://127.0.0.1:9231';
const STATUS_TIMEOUT_MS = 2_000;

export function proofreadServiceUrl(): string {
	return (process.env.SCAN_PROOFREAD_SERVICE_URL || DEFAULT_URL).replace(/\/$/, '');
}

export function proofreadServiceConfigured(): boolean {
	return Boolean((process.env.SCAN_PROOFREAD_SERVICE_URL || '').trim());
}

function authHeaders(): Record<string, string> {
	const token = (process.env.SCAN_PROOFREAD_SERVICE_TOKEN || '').trim();
	return token ? { authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = STATUS_TIMEOUT_MS): Promise<T> {
	const response = await fetch(`${proofreadServiceUrl()}${path}`, {
		...init,
		headers: { 'content-type': 'application/json', ...authHeaders(), ...(init.headers || {}) },
		signal: init.signal ?? AbortSignal.timeout(timeoutMs),
	});
	const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	if (!response.ok) {
		throw new WorkflowError(
			String(payload.error || `Proofreading service returned HTTP ${response.status}`),
			response.status === 401 ? 503 : response.status,
		);
	}
	return payload as T;
}

/** Health check used to decide whether proofreader tools are visible at all. */
export async function proofreadServiceAvailable(): Promise<boolean> {
	if (!proofreadServiceConfigured()) return false;
	try {
		await request<{ ok: boolean }>('/v1/health', {}, STATUS_TIMEOUT_MS);
		return true;
	} catch {
		return false;
	}
}

function toStatus(id: ProofreaderId, raw: Record<string, unknown>): ProofreaderStatus {
	return {
		id,
		ready: raw.ready === true,
		context: typeof raw.context === 'string' ? raw.context : '',
		reason: String(raw.reason || ''),
	};
}

export async function proofreaderStatus(id: ProofreaderId): Promise<ProofreaderStatus> {
	const payload = await request<{ proofreaders?: Record<string, unknown>[] }>('/v1/proofreaders');
	const rows = Array.isArray(payload.proofreaders) ? payload.proofreaders : [];
	const match = rows.find((row) => String(row.id || '') === id);
	if (!match) return { id, ready: false, context: '', reason: `${proofreaderLabel(id)} is not available.` };
	return toStatus(id, match);
}

/** All proofreaders the service offers, in the application's declared order. */
export async function listProofreaderStatuses(): Promise<ProofreaderStatus[]> {
	const payload = await request<{ proofreaders?: Record<string, unknown>[] }>('/v1/proofreaders');
	const rows = Array.isArray(payload.proofreaders) ? payload.proofreaders : [];
	return PROOFREADER_IDS.map((id) => {
		const match = rows.find((row) => String(row.id || '') === id);
		return match
			? toStatus(id, match)
			: { id, ready: false, context: '', reason: `${proofreaderLabel(id)} is not available.` };
	});
}

export async function startProofreader(id: ProofreaderId): Promise<ProofreaderStatus> {
	const payload = await request<{ proofreader?: Record<string, unknown> }>(
		'/v1/proofreaders/start',
		{ method: 'POST', body: JSON.stringify({ proofreader: id }) },
		30_000,
	);
	return toStatus(id, payload.proofreader || {});
}

export async function proofreadWithService(opts: {
	proofreader: ProofreaderId;
	images: Buffer[];
	prompt?: string;
	followUp?: boolean;
	abort?: AbortSignal;
}): Promise<{ critique: string; context: string }> {
	const payload = await request<{ critique?: unknown; context?: unknown }>(
		'/v1/proofread',
		{
			method: 'POST',
			body: JSON.stringify({
				proofreader: opts.proofreader,
				prompt: opts.prompt,
				followUp: opts.followUp === true,
				images: opts.images.map((bytes) => bytes.toString('base64')),
			}),
			signal: opts.abort,
		},
		15 * 60_000,
	);
	return {
		critique: String(payload.critique || ''),
		context: typeof payload.context === 'string' ? payload.context : '',
	};
}

/** Parse a requested proofreader id, falling back to the first one. */
export function parseProofreaderId(raw: unknown): ProofreaderId {
	const value = String(raw || '').trim();
	return isProofreaderId(value) ? value : PROOFREADER_IDS[0];
}

export function assertProofreaderIdOrThrow(raw: unknown): ProofreaderId {
	const value = String(raw || '').trim();
	if (!isProofreaderId(value)) throw new WorkflowError(`Unknown proofreader: ${value || '(none)'}`);
	return value;
}

/** Proofreaders only serve page proofreading; other operations must not select them. */
export function assertNotProofreader(engine: string, action: string): void {
	if (isProofreaderId(engine)) throw new WorkflowError(proofreaderOnlyMessage(engine, action));
}

/**
 * Access gate. Proofreaders are granted per user and the feature is off by
 * default, so both the service being configured and the user holding a grant
 * are required before anything is offered.
 */
export function assertProofreaderGrant(
	user: { id: string; role?: string | null } | null | undefined,
	id: ProofreaderId,
): void {
	if (!user) throw new WorkflowError('Sign in required', 401);
	if (user.role === 'admin') return;
	if (readUserSettings(user.id).proofreaders.includes(id)) return;
	throw new WorkflowError(`You do not have access to ${proofreaderLabel(id)}`, 403);
}

/** The proofreaders a user may use, filtered to those the service reports ready. */
export async function grantedProofreaders(
	user: { id: string; role?: string | null } | null | undefined,
): Promise<ProofreaderStatus[]> {
	const allowed = user?.role === 'admin'
		? [...PROOFREADER_IDS]
		: user
			? readUserSettings(user.id).proofreaders
			: [];
	if (!allowed.length) return [];
	const all = await listProofreaderStatuses();
	return all.filter((item) => allowed.includes(item.id));
}
