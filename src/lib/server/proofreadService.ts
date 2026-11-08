/**
 * Client for the external proofreading service.
 *
 * The service is a separate, optional process (see docs/PROOFREADING_SERVICE.md).
 * The application only ever sees a readiness flag, an opaque conversation
 * token, and critique text. When the service is not configured or not
 * reachable, proofreaders are reported unavailable and their tools stay hidden.
 */

import {
	isProofreaderId,
	isProofreaderSlug,
	noteProofreaderOptions,
	proofreaderLabel,
	proofreaderLabelFromId,
	proofreaderOnlyMessage,
	PROOFREADER_UNAVAILABLE_MESSAGE,
	type ProofreaderId,
} from '../proofreaders';
import { isProductionCliAdapterId } from '../cliAdapterDefs';
import { proofreaderModelRow, RESERVED_LEGACY_HOST_IDS, seedRow } from '../modelRegistry';
import { listRegistryRows, upsertRegistryRow } from './modelRegistryStore';
import { WorkflowError } from './workflowStore';
import { storeAsset } from './workflowStore';
import { directorAsset, directorContext, directorEvent } from './directorAudit';
import { readUserSettings } from './userSettings';

export type ProofreaderStatus = {
	id: ProofreaderId;
	label: string;
	ready: boolean;
	context: string;
	reason: string;
};

type ReportedProofreader = ProofreaderStatus & { named: boolean };

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

function acceptableProofreaderId(id: string): boolean {
	if (!isProofreaderSlug(id)) return false;
	if ((RESERVED_LEGACY_HOST_IDS as readonly string[]).includes(id)) return false;
	if (isProductionCliAdapterId(id)) return false;
	const seed = seedRow(id);
	return !seed || seed.access === 'proofreader';
}

/** The service's `/v1/proofreaders` body, in the order it reported. */
export function readReportedProofreaders(payload: unknown): ReportedProofreader[] {
	const record = payload && typeof payload === 'object' ? (payload as { proofreaders?: unknown }) : {};
	const rows = Array.isArray(record.proofreaders) ? record.proofreaders : [];
	const out: ReportedProofreader[] = [];
	const seen = new Set<string>();
	for (const raw of rows) {
		if (!raw || typeof raw !== 'object') continue;
		const item = raw as Record<string, unknown>;
		const id = String(item.id || '').trim();
		if (!acceptableProofreaderId(id) || seen.has(id)) continue;
		seen.add(id);
		const explicit = String(item.label || item.name || '').trim();
		out.push({
			id,
			label: explicit || proofreaderLabelFromId(id),
			named: Boolean(explicit),
			ready: item.ready === true,
			context: typeof item.context === 'string' ? item.context : '',
			reason: String(item.reason || ''),
		});
	}
	return out;
}

function present(status: ReportedProofreader): ProofreaderStatus {
	const { named: _named, ...rest } = status;
	return rest;
}

/** Saved rows for options the service no longer reports stay addressable, but are not invented here. */
async function rememberReported(reported: ReportedProofreader[]): Promise<void> {
	const rows = listRegistryRows();
	for (const item of reported) {
		const existing = rows.find((row) => row.id === item.id);
		if (existing && existing.access !== 'proofreader') continue;
		if (!existing) {
			upsertRegistryRow(proofreaderModelRow(item.id, item.label));
			continue;
		}
		if (item.named && existing.name !== item.label) upsertRegistryRow({ ...existing, name: item.label });
	}
	noteProofreaderOptions(
		reported.map((item) => ({ id: item.id, label: item.label })),
		{ replace: true },
	);
	const reportedIds = new Set(reported.map((item) => item.id));
	noteProofreaderOptions(
		listRegistryRows()
			.filter((row) => row.access === 'proofreader' && !reportedIds.has(row.id))
			.map((row) => ({ id: row.id, label: row.name })),
	);
}

export async function proofreaderStatus(id: ProofreaderId): Promise<ProofreaderStatus> {
	const label = proofreaderLabel(id);
	if (!proofreadServiceConfigured()) {
		return { id, label, ready: false, context: '', reason: PROOFREADER_UNAVAILABLE_MESSAGE };
	}
	const match = (await listProofreaderStatuses()).find((row) => row.id === id);
	if (!match) return { id, label, ready: false, context: '', reason: `${label} is not available.` };
	return match;
}

/** Proofreaders the service currently reports, in its order. */
export async function listProofreaderStatuses(): Promise<ProofreaderStatus[]> {
	const payload = await request<{ proofreaders?: unknown }>('/v1/proofreaders');
	const reported = readReportedProofreaders(payload);
	await rememberReported(reported);
	return reported.map(present);
}

export async function startProofreader(id: ProofreaderId): Promise<ProofreaderStatus> {
	const payload = await request<{ proofreader?: Record<string, unknown> }>(
		'/v1/proofreaders/start',
		{ method: 'POST', body: JSON.stringify({ proofreader: id }) },
		30_000,
	);
	const raw = payload.proofreader || {};
	const explicit = String(raw.label || raw.name || '').trim();
	return {
		id,
		label: explicit || proofreaderLabel(id),
		ready: raw.ready === true,
		context: typeof raw.context === 'string' ? raw.context : '',
		reason: String(raw.reason || ''),
	};
}

export type ProofreadServiceMode = 'critique' | 'raw';

export async function proofreadWithService(opts: {
	proofreader: ProofreaderId;
	mode: ProofreadServiceMode;
	images: Buffer[];
	prompt?: string;
	followUp?: boolean;
	abort?: AbortSignal;
}): Promise<{ critique: string; context: string }> {
	const director = directorContext();
	if (director) {
		const hashes = await Promise.all(opts.images.map(storeAsset));
		for (const hash of hashes) directorAsset(director.runId, hash);
		directorEvent(director.runId, director.episodeId, director.imageId || null, 'proofreader:request', {
			proofreader: opts.proofreader, mode: opts.mode, prompt: opts.prompt || '', followUp: opts.followUp === true, images: hashes,
		});
	}
	const payload = await request<{ critique?: unknown; context?: unknown }>(
		'/v1/proofread',
		{
			method: 'POST',
			body: JSON.stringify({
				proofreader: opts.proofreader,
				mode: opts.mode,
				prompt: opts.prompt,
				followUp: opts.followUp === true,
				images: opts.images.map((bytes) => bytes.toString('base64')),
			}),
			signal: opts.abort,
		},
		15 * 60_000,
	);
	if (director) directorEvent(director.runId, director.episodeId, director.imageId || null,
		'proofreader:response', { critique: payload.critique });
	return {
		critique: String(payload.critique || ''),
		context: typeof payload.context === 'string' ? payload.context : '',
	};
}

/** True for a reported proofreader, a saved proofreader row, or a `proofreader-*` id. */
export function isKnownProofreaderEngine(id: string): boolean {
	if (isProofreaderId(id)) return true;
	return listRegistryRows().some((row) => row.id === id && row.access === 'proofreader');
}

/** A requested id. Does not substitute a different proofreader. */
export async function requireProofreaderId(raw: unknown): Promise<ProofreaderId> {
	const value = String(raw || '').trim();
	if (!isProofreaderSlug(value)) throw new WorkflowError(`Unknown proofreader: ${value || '(none)'}`);
	if (isKnownProofreaderEngine(value)) return value;
	if (!proofreadServiceConfigured()) throw new WorkflowError(`Unknown proofreader: ${value}`);
	const reported = await listProofreaderStatuses();
	if (!reported.some((item) => item.id === value)) throw new WorkflowError(`Unknown proofreader: ${value}`);
	return value;
}

export function assertProofreaderIdOrThrow(raw: unknown): ProofreaderId {
	const value = String(raw || '').trim();
	if (!isKnownProofreaderEngine(value)) throw new WorkflowError(`Unknown proofreader: ${value || '(none)'}`);
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

/** The proofreaders a user may use, limited to what the service currently reports. */
export async function grantedProofreaders(
	user: { id: string; role?: string | null } | null | undefined,
): Promise<ProofreaderStatus[]> {
	if (!user || !proofreadServiceConfigured()) return [];
	let all: ProofreaderStatus[] = [];
	try {
		all = await listProofreaderStatuses();
	} catch {
		return [];
	}
	if (user.role === 'admin') return all;
	const allowed = readUserSettings(user.id).proofreaders;
	return all.filter((item) => allowed.includes(item.id));
}
