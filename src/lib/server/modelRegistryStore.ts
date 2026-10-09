import type { CapabilitySample } from '../modelCapabilities';
import { packageRows } from './modelPackages';
import { validateManagedLaunch, type ManagedLaunch, type RequestPreset } from '../managedModels';
import { assertModelIdentityEditable } from './modelUsage';
import { reservedReviewService } from './gpuMode';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	CHAT_AND_CLI_OPERATIONS,
	cliRowId,
	mergeRegistry,
	RETIRED_SEED_IDS,
	sanitizeRowId,
	takenRowIds,
	type CliAdapterId,
	type ModelCatalogCache,
	type ModelOverlay,
	type ModelRow,
	type ProbeSample,
} from '../modelRegistry';
import { ROLES } from '../types';
import type { ProviderOperation } from '../providerCatalog';
import { recordSample } from '../modelEstimate';
import { sanitizePortableUrl } from '../modelPack';
import { recoverPackApply, writeAtomicJson } from './modelPackJournal';
import { toHomeLaunch } from './homePath';

/** Resolved at call time so tests can isolate SCAN_DATA_DIR after import. */
export function modelsOverlayPath(): string {
	const root = process.env.SCAN_ROOT || process.cwd();
	const data = process.env.SCAN_DATA_DIR || join(root, 'data');
	return join(data, 'models.json');
}

const overlayPath = () => modelsOverlayPath();

let cache: { path: string; overlay: ModelOverlay; rows: ModelRow[] } | null = null;

function emptyOverlay(): ModelOverlay {
	return { rows: [], catalogs: [] };
}

export function readModelOverlay(): ModelOverlay {
	if (recoverPackApply()) invalidateRegistryCache();
	try {
		const raw = readFileSync(overlayPath(), 'utf8');
		const parsed = JSON.parse(raw) as ModelOverlay;
		if (!parsed || typeof parsed !== 'object') return emptyOverlay();
		const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
		return {
			rows: normalizeOverlayRows(rows),
			catalogs: Array.isArray(parsed.catalogs) ? parsed.catalogs : [],
		};
	} catch {
		return emptyOverlay();
	}
}

/**
 * Overlay rows this build must not serve: retired seeds are dropped so they
 * can never come back, and recipes are rewritten to portable `~/…` paths so
 * this machine's home directory never lingers in `models.json`. The file is
 * rewritten once when either applies.
 */
function normalizeOverlayRows(rows: NonNullable<ModelOverlay['rows']>): NonNullable<ModelOverlay['rows']> {
	let changed = false;
	const mapped = rows
		.filter((row) => {
			const id = String(row?.id || '').trim();
			// Retired seed entries are dropped wholesale; an operator-added row
			// (seeded: false) reusing the id survives — the chat models ship as
			// presets that an operator adds under exactly these ids.
			const keep =
				!(RETIRED_SEED_IDS as readonly string[]).includes(id) || row?.seeded === false;
			if (!keep) changed = true;
			return keep;
		})
		.map((row) => {
			const launch = row?.managedLaunch;
			if (!launch || typeof launch !== 'object' || typeof launch.executable !== 'string') return row;
			const portable = toHomeLaunch(launch);
			if (JSON.stringify(portable) === JSON.stringify(launch)) return row;
			changed = true;
			return { ...row, managedLaunch: portable };
		});
	if (!changed) return rows;
	try {
		writeModelOverlay({ rows: mapped, catalogs: readModelOverlayRaw()?.catalogs });
	} catch {
		/* Read-only data dir: still serve the normalized list. */
	}
	return mapped;
}

function readModelOverlayRaw(): ModelOverlay | null {
	try {
		const parsed = JSON.parse(readFileSync(overlayPath(), 'utf8')) as ModelOverlay;
		return parsed && typeof parsed === 'object' ? parsed : null;
	} catch {
		return null;
	}
}

export function listRegistryRows(force = false): ModelRow[] {
	if (recoverPackApply()) invalidateRegistryCache();
	const path = overlayPath();
	if (!force && cache?.path === path) return packageRows(cache.rows);
	const overlay = readModelOverlay();
	const rows = mergeRegistry(overlay);
	cache = { path, overlay, rows };
	return packageRows(rows);
}

export function invalidateRegistryCache() {
	cache = null;
}

export function writeModelOverlay(overlay: ModelOverlay) {
	const path = overlayPath();
	const payload: ModelOverlay = {
		rows: overlay.rows || [],
		catalogs: overlay.catalogs || [],
	};
	writeAtomicJson(path, payload);
	invalidateRegistryCache();
}

export function saveRegistryRows(rows: ModelRow[], catalogs?: ModelCatalogCache[]) {
	const overlay = readModelOverlay();
	writeModelOverlay({
		rows: rows.map((row) => ({
			id: row.id,
			name: row.name,
			slug: row.slug,
			access: row.access,
			cliAdapter: row.cliAdapter,
			runtime: row.runtime,
			operations: row.operations,
			roles: row.roles,
			languages: row.languages,
			http: row.http,
			managedLaunch: row.managedLaunch ? toHomeLaunch(row.managedLaunch) : row.managedLaunch,
			requestPreset: row.requestPreset,
			suggestions: row.suggestions,
			seeded: row.seeded,
			operationsLocked: row.operationsLocked,
			disabled: row.disabled,
			autoRun: row.autoRun,
			probes: row.probes,
			probeHistory: row.probeHistory,
			capabilities: row.capabilities,
			capabilityHistory: row.capabilityHistory,
			modelRevision: row.modelRevision,
			packageId: row.packageId,
		})),
		catalogs: catalogs || overlay.catalogs,
	});
}

export function upsertRegistryRow(row: ModelRow): ModelRow[] {
	const rows = listRegistryRows(true);
	const idx = rows.findIndex((item) => item.id === row.id);
	if (idx >= 0) rows[idx] = row;
	else rows.push(row);
	saveRegistryRows(rows);
	return listRegistryRows(true);
}

export function removeOverlayRow(id: string): ModelRow[] {
	const rows = listRegistryRows(true);
	const target = rows.find((item) => item.id === id);
	if (!target) throw Object.assign(new Error('Model not found'), { status: 404 });
	assertModelIdentityEditable(id);
	if (target.seeded) throw Object.assign(new Error('Seeded models cannot be deleted'), { status: 400 });
	saveRegistryRows(rows.filter((item) => item.id !== id));
	return listRegistryRows(true);
}

export function saveCatalogCache(adapter: string, models: { id: string; label: string }[]) {
	const overlay = readModelOverlay();
	const catalogs = [...(overlay.catalogs || []).filter((item) => item.adapter !== adapter), {
		adapter,
		at: Date.now(),
		models,
	}];
	writeModelOverlay({ ...overlay, catalogs });
}

export function catalogCache(adapter: string): ModelCatalogCache | undefined {
	return readModelOverlay().catalogs?.find((item) => item.adapter === adapter);
}

export function saveProbeResult(id: string, sample: ProbeSample): ModelRow {
	const rows = listRegistryRows(true);
	const row = rows.find((item) => item.id === id);
	if (!row) throw Object.assign(new Error('Model not found'), { status: 404 });
	sample = { ...sample, fingerprint: sample.fingerprint || row.taskFingerprints?.[sample.operation] };
	const prev = row.probes?.[sample.operation];
	const samplesMs = sample.ok && sample.ms != null
		? recordSample(prev?.samplesMs, sample.ms)
		: prev?.samplesMs;
	row.probeHistory = [...(row.probeHistory || []), ...(prev && !row.probeHistory?.length ? [prev] : []), sample];
	if ((sample.outcome === "cancelled" || sample.outcome === "error") && prev?.fingerprint === sample.fingerprint && prev?.ok) {
		saveRegistryRows(rows);
		return listRegistryRows(true).find(item => item.id === id)!;
	}
	row.probes = {
		...row.probes,
		[sample.operation]: {
			...sample,
			samplesMs,
		},
	};
	saveRegistryRows(rows);
	return listRegistryRows(true).find((item) => item.id === id)!;
}

export function findRegistryRow(id: string): ModelRow | undefined {
	return listRegistryRows().find((item) => item.id === id);
}

export function addCliSlug(adapter: CliAdapterId, slug: string, label?: string): ModelRow {
	const trimmed = String(slug || '').trim();
	if (!trimmed) throw Object.assign(new Error('Choose a model slug'), { status: 400 });
	const rows = listRegistryRows(true);
	const existing = rows.find((item) => item.cliAdapter === adapter && item.slug === trimmed);
	if (existing) return existing;
	const id = cliRowId(adapter, trimmed, takenRowIds(rows));
	const row: ModelRow = {
		id,
		name: (label || trimmed).trim(),
		slug: trimmed,
		access: 'cli',
		cliAdapter: adapter,
		operations: [...CHAT_AND_CLI_OPERATIONS],
		roles: [...ROLES],
		seeded: false,
		operationsLocked: false,
		disabled: true,
	};
	upsertRegistryRow(row);
	return findRegistryRow(id)!;
}

export function setRowsDisabled(ids: string[], disabled: boolean): ModelRow[] {
	const wanted = new Set(ids.map((id) => String(id || '').trim()).filter(Boolean));
	if (!wanted.size) return listRegistryRows(true);
	const rows = listRegistryRows(true);
	let changed = false;
	for (const row of rows) {
		if (!wanted.has(row.id) || row.disabled === disabled) continue;
		row.disabled = disabled;
		changed = true;
	}
	if (changed) saveRegistryRows(rows);
	return listRegistryRows(true);
}

export function createRemoteHttpRow(input: {
	id?: string;
	name: string;
	slug: string;
	baseUrl: string;
	apiKeyEnv: string;
	operations?: ProviderOperation[];
}): ModelRow {
	const rows = listRegistryRows(true);
	const taken = takenRowIds(rows);
	let id = sanitizeRowId(input.id || input.slug || input.name);
	if (!id) throw Object.assign(new Error('Choose a model id'), { status: 400 });
	if (taken.has(id)) {
		let n = 2;
		while (taken.has(`${id}-${n}`)) n += 1;
		id = `${id}-${n}`;
	}
	const slug = String(input.slug || id).trim();
	if (!slug) throw Object.assign(new Error('Choose a model slug'), { status: 400 });
	const apiKeyEnv = String(input.apiKeyEnv || 'OPENAI_API_KEY').trim();
	if (!/^[A-Z][A-Z0-9_]*$/.test(apiKeyEnv)) {
		throw Object.assign(new Error('API key field must be an environment variable name, not a secret'), { status: 400 });
	}
	const operations = (input.operations || [...CHAT_AND_CLI_OPERATIONS]).filter((item) => item !== 'cleaning');
	const row: ModelRow = {
		id,
		name: (input.name || slug).trim(),
		slug,
		access: 'remote_http',
		runtime: 'openai',
		operations,
		roles: [...ROLES],
		http: { baseUrl: sanitizePortableUrl(String(input.baseUrl || '')), apiKeyEnv },
		seeded: false,
		operationsLocked: false,
	};
	upsertRegistryRow(row);
	return findRegistryRow(id)!;
}

export function updateRegistryRow(id: string, patch: Partial<ModelRow>): ModelRow {
	const rows = listRegistryRows(true);
	const idx = rows.findIndex((item) => item.id === id);
	if (idx < 0) throw Object.assign(new Error('Model not found'), { status: 404 });
	const current = rows[idx];
	const next = { ...current };
	if (patch.requestPreset !== undefined) {
		if (!['generic', 'qwen-thinking'].includes(patch.requestPreset)) throw new Error('Unknown request preset');
		next.requestPreset = patch.requestPreset;
	}
	if (Object.hasOwn(patch, 'managedLaunch')) {
		if (current.access !== 'local_http' || (current.runtime !== 'llamacpp' && current.runtime !== 'qwen3vl'))
			throw new Error('Only local llama.cpp models can be managed');
		next.managedLaunch = patch.managedLaunch === null ? null : toHomeLaunch(validateManagedLaunch(patch.managedLaunch));
		if (next.managedLaunch && rows.some(row => row.id !== id && row.managedLaunch?.port === next.managedLaunch!.port)) throw new Error('Another managed model uses this port');
		const reserved = next.managedLaunch ? reservedReviewService(next.managedLaunch.port) : undefined;
		if (reserved) throw new Error(`Port ${next.managedLaunch!.port} is reserved for ${reserved.label}`);
	}
	if (typeof patch.name === 'string' && patch.name.trim()) next.name = patch.name.trim();
	if (typeof patch.slug === 'string' && patch.slug.trim()) next.slug = patch.slug.trim();
	if (typeof patch.disabled === 'boolean') next.disabled = patch.disabled;
	if (typeof patch.autoRun === 'boolean') next.autoRun = patch.autoRun;

	if (Array.isArray(patch.roles)) next.roles = patch.roles;
	if ((current.access === 'remote_http' || current.runtime === 'openai' || current.runtime === 'llamacpp' || current.runtime === 'qwen3vl') && patch.http) {
		const apiKeyEnv = String(patch.http.apiKeyEnv || current.http?.apiKeyEnv || '').trim();
		if (apiKeyEnv && !/^[A-Z][A-Z0-9_]*$/.test(apiKeyEnv)) {
			throw Object.assign(new Error('API key field must be an environment variable name, not a secret'), { status: 400 });
		}
		next.http = {
			baseUrl:
				typeof patch.http.baseUrl === 'string'
					? sanitizePortableUrl(patch.http.baseUrl)
					: current.http?.baseUrl || '',
			apiKeyEnv,
		};
	}
	const targetChanged =
		next.slug !== current.slug ||
		next.http?.baseUrl !== current.http?.baseUrl ||
		next.http?.apiKeyEnv !== current.http?.apiKeyEnv;
	if (targetChanged) assertModelIdentityEditable(id); // Fingerprints mark earlier evidence stale; keep its history.
	if (patch.managedLaunch === null) assertModelIdentityEditable(id);
	upsertRegistryRow(next);
	return findRegistryRow(id)!;
}

export function createLocalHttpRow(input: {
	name: string;
	slug: string;
	baseUrl?: string;
	apiKeyEnv?: string;
	/** Applied in the same write as the row, so a rejected recipe leaves nothing behind. */
	managedLaunch?: ManagedLaunch | null;
	requestPreset?: RequestPreset;
}): ModelRow {
	const rows = listRegistryRows(true);
	const slug = input.slug.trim();
	if (!slug) throw new Error('Choose a model identifier');
	const base = sanitizeRowId(slug);
	if (!base) throw new Error('Choose a valid model identifier');
	const taken = takenRowIds(rows);
	let id = base;
	let n = 2;
	while (taken.has(id)) id = `${base}-${n++}`;
	const key = (input.apiKeyEnv || '').trim();
	if (key && !/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error('Use an API-key environment variable name');
	const requestPreset = input.requestPreset ?? 'generic';
	if (requestPreset !== 'generic' && requestPreset !== 'qwen-thinking') throw new Error('Unknown request preset');
	let managedLaunch: ManagedLaunch | null = null;
	if (input.managedLaunch) {
		managedLaunch = toHomeLaunch(validateManagedLaunch(input.managedLaunch));
		if (rows.some((row) => row.managedLaunch?.port === managedLaunch!.port))
			throw new Error('Another managed model uses this port');
		const reserved = reservedReviewService(managedLaunch.port);
		if (reserved) throw new Error(`Port ${managedLaunch.port} is reserved for ${reserved.label}`);
	}
	const row: ModelRow = {
		id,
		name: input.name.trim() || slug,
		slug,
		access: 'local_http',
		runtime: 'llamacpp',
		operations: [...CHAT_AND_CLI_OPERATIONS],
		roles: [...ROLES],
		http: { baseUrl: sanitizePortableUrl(input.baseUrl || ''), apiKeyEnv: key },
		managedLaunch,
		requestPreset,
		seeded: false,
		operationsLocked: false,
	};
	upsertRegistryRow(row);
	return findRegistryRow(id)!;
}

/** Persist shared evidence without synthesizing job passes. */
export function saveCapabilityResults(id: string, samples: CapabilitySample[]): ModelRow {
  const rows = listRegistryRows(true);
  const row = rows.find(item => item.id === id);
  if (!row) throw new Error('Model not found');
  for (const sample of samples) {
    const previous = row.capabilities?.[sample.capability];
    row.capabilityHistory = [...(row.capabilityHistory || []), sample];
    if (['error', 'cancelled'].includes(sample.outcome || '') && previous?.ok && previous.fingerprint === sample.fingerprint) continue;
    row.capabilities = { ...row.capabilities, [sample.capability]: sample };
  }
  saveRegistryRows(rows);
  return listRegistryRows(true).find(item => item.id === id)!;
}
