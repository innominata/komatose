/**
 * Versioned portable pack of named model rows and selection profiles.
 * No API keys, executable paths, or probe results. Private, loopback, and
 * link-local HTTP endpoints are omitted unless export opts them in; credentials
 * in URLs are always stripped.
 */
import {
	CHAT_AND_CLI_OPERATIONS,
	isCliAdapterId,
	isReservedLegacyHost,
	MODEL_RUNTIMES,
	sanitizeRowId,
	SEED_ROWS,
	seedRow,
	type CliAdapterId,
	type ModelAccess,
	type ModelRow,
	type ModelRuntime,
} from './modelRegistry';
import {
	cloneProfileSelections,
	normalizeProfileName,
	parseProfileSelections,
	profileRowForRef,
	type ModelProfile,
	type ModelProfileSelections,
} from './modelProfiles';
import type { ProviderOperation } from './providerCatalog';
import { ROLES, type Role } from './types';

export const MODEL_PACK_KIND = 'komatose.model-pack';
export const MODEL_PACK_VERSION = 1;

const FORBIDDEN_KEYS = new Set([
	'apikey',
	'api_key',
	'authorization',
	'bearer',
	'bin',
	'catalogs',
	'credential',
	'credentials',
	'executable',
	'password',
	'probes',
	'secret',
	'token',
]);

const ALL_ROLES: Role[] = ['admin', 'translator', 'proofreader', 'typesetter'];

export class ModelPackError extends Error {
	status = 400;
	constructor(message: string) {
		super(message);
		this.name = 'ModelPackError';
	}
}

export type PortableHttp = {
	baseUrl: string;
	apiKeyEnv: string;
};

export type PortableModel = {
	id: string;
	name: string;
	slug: string;
	access: 'remote_http' | 'cli';
	cliAdapter?: CliAdapterId;
	runtime?: ModelRuntime;
	operations: ProviderOperation[];
	roles: Role[];
	http?: PortableHttp;
	disabled?: boolean;
};

export type PortableProfile = {
	id: string;
	name: string;
	selections: ModelProfileSelections;
};

export type ModelPack = {
	kind: typeof MODEL_PACK_KIND;
	version: number;
	exportedAt: string;
	models: PortableModel[];
	profiles: PortableProfile[];
};

export type ConflictAction = { action: 'skip' } | { action: 'rename'; id: string; name?: string };

export type ImportDecisions = {
	models?: Record<string, ConflictAction>;
	profiles?: Record<string, ConflictAction>;
};

export type PackConflict = {
	kind: 'model' | 'profile';
	id: string;
	name: string;
	reason: 'id' | 'name';
	existingId?: string;
	existingName?: string;
};

export type PackDependency = {
	kind: 'model' | 'env';
	ref: string;
	message: string;
};

export type PackPreviewItem = {
	kind: 'model' | 'profile';
	id: string;
	name: string;
	detail: string;
};

export type PackPreview = {
	pack: ModelPack;
	add: PackPreviewItem[];
	conflicts: PackConflict[];
	missing: PackDependency[];
};

function assertObject(raw: unknown, message: string): Record<string, unknown> {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new ModelPackError(message);
	}
	return raw as Record<string, unknown>;
}

function walkForbidden(raw: unknown, path = '') {
	if (!raw || typeof raw !== 'object') return;
	if (Array.isArray(raw)) {
		raw.forEach((item, i) => walkForbidden(item, `${path}[${i}]`));
		return;
	}
	for (const [key, value] of Object.entries(raw)) {
		const lower = key.toLowerCase();
		if (FORBIDDEN_KEYS.has(lower) || lower.endsWith('path') || lower === 'saved') {
			throw new ModelPackError(`Pack must not include ${key}.`);
		}
		if (typeof value === 'string' && /(?:^sk-|BEGIN [A-Z ]+PRIVATE KEY)/.test(value)) {
			throw new ModelPackError('Pack must not include API keys or private key material.');
		}
		if (typeof value === 'string' && /^file:/i.test(value.trim())) {
			throw new ModelPackError('Pack must not include file endpoints.');
		}
		if (typeof value === 'string' && urlHasEmbeddedSecret(value)) {
			throw new ModelPackError('Pack must not include passwords or tokens in endpoint URLs.');
		}
		walkForbidden(value, path ? `${path}.${key}` : key);
	}
}

export type EndpointScope = 'public' | 'loopback' | 'link-local' | 'private' | 'unspecified';

function parseIPv4(host: string): [number, number, number, number] | null {
	const parts = host.split('.');
	if (parts.length !== 4) return null;
	const oct: number[] = [];
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const n = Number(part);
		if (!Number.isInteger(n) || n < 0 || n > 255) return null;
		oct.push(n);
	}
	return oct as [number, number, number, number];
}

function classifyIPv4(oct: [number, number, number, number]): EndpointScope {
	const [a, b] = oct;
	if (a === 127) return 'loopback';
	if (a === 10) return 'private';
	if (a === 192 && b === 168) return 'private';
	if (a === 172 && b >= 16 && b <= 31) return 'private';
	if (a === 169 && b === 254) return 'link-local';
	if (a === 0) return 'unspecified';
	return 'public';
}

function parseIPv6(host: string): number[] | null {
	let value = host.trim().toLowerCase();
	if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
	const zone = value.indexOf('%');
	if (zone >= 0) value = value.slice(0, zone);
	if (value.includes('.')) {
		const colon = value.lastIndexOf(':');
		if (colon < 0) return null;
		const tail = parseIPv4(value.slice(colon + 1));
		if (!tail) return null;
		const hi = ((tail[0] << 8) | tail[1]).toString(16);
		const lo = ((tail[2] << 8) | tail[3]).toString(16);
		value = `${value.slice(0, colon + 1)}${hi}:${lo}`;
	}
	if ((value.match(/::/g) || []).length > 1) return null;
	const sides = value.split('::');
	const parseGroups = (part: string): number[] | null => {
		if (part === '') return [];
		const groups = part.split(':');
		const out: number[] = [];
		for (const group of groups) {
			if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
			out.push(parseInt(group, 16));
		}
		return out;
	};
	if (sides.length === 1) {
		const groups = parseGroups(sides[0]);
		return groups && groups.length === 8 ? groups : null;
	}
	const left = parseGroups(sides[0]);
	const right = parseGroups(sides[1]);
	if (!left || !right) return null;
	const fill = 8 - left.length - right.length;
	if (fill < 1) return null;
	return [...left, ...Array(fill).fill(0), ...right];
}

function classifyIPv6(groups: number[]): EndpointScope {
	if (groups.length !== 8) return 'public';
	const mapped =
		groups[0] === 0 &&
		groups[1] === 0 &&
		groups[2] === 0 &&
		groups[3] === 0 &&
		groups[4] === 0 &&
		groups[5] === 0xffff;
	if (mapped) {
		return classifyIPv4([
			(groups[6] >> 8) & 255,
			groups[6] & 255,
			(groups[7] >> 8) & 255,
			groups[7] & 255,
		]);
	}
	if (groups.every((item) => item === 0)) return 'unspecified';
	if (
		groups[0] === 0 &&
		groups[1] === 0 &&
		groups[2] === 0 &&
		groups[3] === 0 &&
		groups[4] === 0 &&
		groups[5] === 0 &&
		groups[6] === 0 &&
		groups[7] === 1
	) {
		return 'loopback';
	}
	if ((groups[0] & 0xffc0) === 0xfe80) return 'link-local';
	if ((groups[0] & 0xfe00) === 0xfc00) return 'private';
	return 'public';
}

/** Classify a hostname or IP literal. No DNS lookup. */
export function classifyEndpointHost(host: string): EndpointScope {
	const name = host.trim().replace(/\.$/, '').toLowerCase();
	if (!name) return 'public';
	if (name === 'localhost' || name.endsWith('.localhost')) return 'loopback';
	if (name === 'local' || name.endsWith('.local')) return 'link-local';
	const ipv4 = parseIPv4(name);
	if (ipv4) return classifyIPv4(ipv4);
	const ipv6 = parseIPv6(name);
	if (ipv6) return classifyIPv6(ipv6);
	return 'public';
}

function hostFromUrlText(raw: string): string | null {
	const match = raw.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^/?#]*@)?(\[[^\]]+\]|[^/?#:]+)/);
	return match?.[1] || null;
}

/** Classify an endpoint URL from its host only. No DNS or network I/O. */
export function classifyEndpointUrl(raw: string): EndpointScope | 'invalid' {
	const value = raw.trim();
	if (!value) return 'invalid';
	try {
		const url = new URL(value);
		if (url.protocol === 'file:') return 'unspecified';
		return classifyEndpointHost(url.hostname);
	} catch {
		const host = hostFromUrlText(value);
		if (!host) return 'invalid';
		return classifyEndpointHost(host);
	}
}

export function isNonPublicEndpoint(raw: string): boolean {
	const scope = classifyEndpointUrl(raw);
	return scope !== 'public' && scope !== 'invalid';
}

/** Loopback, private, link-local, .local / .localhost, and file endpoints. */
export function isMachineLocalUrl(raw: string): boolean {
	return isNonPublicEndpoint(raw);
}

const SECRET_QUERY =
	/^(?:api[_-]?key|key|token|access[_-]?token|refresh[_-]?token|auth|authorization|password|passwd|secret|bearer|sid|session)$/i;

function isSecretQueryParam(name: string): boolean {
	if (SECRET_QUERY.test(name)) return true;
	return /(?:api[_-]?key|token|secret|password|passwd|bearer)/i.test(name);
}

/** True when a URL carries userinfo or secret query parameters. */
export function urlHasEmbeddedSecret(raw: string): boolean {
	const value = raw.trim();
	if (!value) return false;
	try {
		const url = new URL(value);
		if (url.username || url.password) return true;
		for (const key of url.searchParams.keys()) {
			if (isSecretQueryParam(key)) return true;
		}
		return false;
	} catch {
		return (
			/\/\/[^/?#]*:[^/?#]*@/.test(value) ||
			/[?&](?:api[_-]?key|key|token|access[_-]?token|password|passwd|secret|auth|authorization|bearer)=/i.test(value)
		);
	}
}

/** Drop userinfo, fragments, and secret query parameters. Keep the public origin and path. */
export function sanitizePortableUrl(raw: string): string {
	const value = raw.trim();
	if (!value) return '';
	try {
		const url = new URL(value);
		url.username = '';
		url.password = '';
		url.hash = '';
		for (const key of [...url.searchParams.keys()]) {
			if (isSecretQueryParam(key)) url.searchParams.delete(key);
		}
		let out = url.toString();
		if (out.endsWith('?')) out = out.slice(0, -1);
		if (out.endsWith('#')) out = out.slice(0, -1);
		return out;
	} catch {
		return value
			.replace(/\/\/[^@/?#]*:[^@/?#]*@/, '//')
			.replace(/[?&](?:api[_-]?key|key|token|access[_-]?token|password|passwd|secret|auth|authorization|bearer)=[^&]*/gi, '')
			.replace(/\?&/, '?')
			.replace(/[?&#]$/, '');
	}
}

function validOperation(value: unknown): value is ProviderOperation {
	return typeof value === 'string' && (CHAT_AND_CLI_OPERATIONS as string[]).includes(value);
}

function validRole(value: unknown): value is Role {
	return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export type PackExportOptions = {
	includePrivate?: boolean;
};

export type ExcludedPackModel = {
	id: string;
	name: string;
	reason: EndpointScope | 'file' | 'local_http';
	endpoint: string;
};

export type IncludedPrivateEndpoint = {
	id: string;
	name: string;
	endpoint: string;
	scope: EndpointScope;
};

export type ProfileNeedsConfig = {
	id: string;
	name: string;
	excludedModels: Array<{ id: string; name: string; reason: string }>;
};

export type PackExportPreview = {
	pack: ModelPack;
	includePrivate: boolean;
	includedPrivate: IncludedPrivateEndpoint[];
	excludedModels: ExcludedPackModel[];
	profilesNeedingConfig: ProfileNeedsConfig[];
};

export function isPortableModelRow(row: ModelRow): boolean {
	if (row.seeded) return false;
	if (row.access === 'remote_http') return true;
	if (row.access === 'cli' && row.cliAdapter) return true;
	return false;
}

function excludedReason(scope: EndpointScope | 'invalid'): ExcludedPackModel['reason'] {
	if (scope === 'invalid' || scope === 'public') return 'private';
	return scope;
}

export function portableModelFromRow(
	row: ModelRow,
	options: PackExportOptions = {},
): PortableModel | null {
	return previewPortableModel(row, options)?.model || null;
}

function previewPortableModel(
	row: ModelRow,
	options: PackExportOptions = {},
): {
	model?: PortableModel;
	excluded?: ExcludedPackModel;
	includedPrivate?: IncludedPrivateEndpoint;
} {
	if (row.seeded) return {};
	if (row.access === 'cli' && row.cliAdapter) {
		return {
			model: {
				id: row.id,
				name: row.name,
				slug: row.slug,
				access: 'cli',
				cliAdapter: row.cliAdapter,
				operations: [...row.operations],
				roles: [...row.roles],
				disabled: row.disabled === true ? true : undefined,
			},
		};
	}
	if (row.access === 'local_http') {
		return {
			excluded: {
				id: row.id,
				name: row.name,
				reason: 'local_http',
				endpoint: (row.http?.baseUrl || '').trim(),
			},
		};
	}
	if (row.access !== 'remote_http') return {};
	const baseUrl = sanitizePortableUrl(row.http?.baseUrl || '');
	if (!baseUrl || urlHasEmbeddedSecret(baseUrl)) return {};
	let protocol = '';
	try {
		protocol = new URL(baseUrl).protocol;
	} catch {
		protocol = '';
	}
	if (protocol === 'file:') {
		return { excluded: { id: row.id, name: row.name, reason: 'file', endpoint: baseUrl } };
	}
	const scope = classifyEndpointUrl(baseUrl);
	const nonPublic = scope !== 'public' && scope !== 'invalid';
	if (nonPublic && !options.includePrivate) {
		return {
			excluded: {
				id: row.id,
				name: row.name,
				reason: excludedReason(scope),
				endpoint: baseUrl,
			},
		};
	}
	const model: PortableModel = {
		id: row.id,
		name: row.name,
		slug: row.slug,
		access: 'remote_http',
		runtime: row.runtime === 'openai' || !row.runtime ? 'openai' : row.runtime,
		operations: [...row.operations],
		roles: [...row.roles],
		http: { baseUrl, apiKeyEnv: (row.http?.apiKeyEnv || '').trim() },
		disabled: row.disabled === true ? true : undefined,
	};
	if (nonPublic) {
		return {
			model,
			includedPrivate: {
				id: row.id,
				name: row.name,
				endpoint: baseUrl,
				scope,
			},
		};
	}
	return { model };
}

export function portableProfileFromStored(profile: ModelProfile): PortableProfile {
	return {
		id: profile.id,
		name: profile.name,
		selections: cloneProfileSelections(profile.selections),
	};
}

function profileRefIds(profile: PortableProfile | ModelProfile): string[] {
	return [
		profile.selections.translate.engine,
		profile.selections.proofread.engine,
		...profile.selections.reviewers.map((item) => item.engine),
		...profile.selections.transcriptionModels,
		...(profile.selections.transcriptionDecider ? [profile.selections.transcriptionDecider.engine] : []),
	];
}

function destRowsAfterExport(included: PortableModel[]): ModelRow[] {
	const extras: ModelRow[] = included.map((model) => ({
		id: model.id,
		name: model.name,
		slug: model.slug,
		access: model.access,
		cliAdapter: model.cliAdapter,
		runtime: model.runtime,
		// Portable rows are task-agnostic too: whatever box the pack recorded is
		// widened — the per-task tests decide what the model can run.
		operations: [...CHAT_AND_CLI_OPERATIONS],
		roles: model.roles,
		http: model.http,
		seeded: false,
		operationsLocked: false,
		disabled: model.disabled,
	}));
	return [...SEED_ROWS, ...extras];
}

export function previewPackExport(
	rows: readonly ModelRow[],
	profiles: readonly ModelProfile[],
	options: PackExportOptions = {},
	now = new Date(),
): PackExportPreview {
	const includePrivate = options.includePrivate === true;
	const models: PortableModel[] = [];
	const excludedModels: ExcludedPackModel[] = [];
	const includedPrivate: IncludedPrivateEndpoint[] = [];
	for (const row of rows) {
		const next = previewPortableModel(row, options);
		if (next.model) models.push(next.model);
		if (next.excluded) excludedModels.push(next.excluded);
		if (next.includedPrivate) includedPrivate.push(next.includedPrivate);
	}
	const dest = destRowsAfterExport(models);
	const excludedById = new Map(excludedModels.map((item) => [item.id, item]));
	const profilesNeedingConfig: ProfileNeedsConfig[] = [];
	const portableProfiles = profiles.map(portableProfileFromStored);
	for (const profile of portableProfiles) {
		const missing: ProfileNeedsConfig['excludedModels'] = [];
		for (const ref of profileRefIds(profile)) {
			if (seedRow(ref)) continue;
			const found = profileRowForRef({ engine: ref, model: '' }, dest);
			if (found.row) continue;
			const excluded = excludedById.get(ref);
			if (missing.some((item) => item.id === ref)) continue;
			missing.push({
				id: ref,
				name: excluded?.name || ref,
				reason: excluded ? excluded.reason : 'missing',
			});
		}
		if (missing.length) {
			profilesNeedingConfig.push({ id: profile.id, name: profile.name, excludedModels: missing });
		}
	}
	return {
		pack: {
			kind: MODEL_PACK_KIND,
			version: MODEL_PACK_VERSION,
			exportedAt: now.toISOString(),
			models,
			profiles: portableProfiles,
		},
		includePrivate,
		includedPrivate,
		excludedModels,
		profilesNeedingConfig,
	};
}

export function buildModelPack(
	rows: readonly ModelRow[],
	profiles: readonly ModelProfile[],
	now = new Date(),
	options: PackExportOptions = {},
): ModelPack {
	return previewPackExport(rows, profiles, options, now).pack;
}

function parseHttp(raw: unknown): PortableHttp {
	const rec = assertObject(raw, 'Remote model HTTP settings must be an object.');
	if ('apiKey' in rec || 'api_key' in rec) {
		throw new ModelPackError('Pack must not include API keys.');
	}
	const baseUrl = typeof rec.baseUrl === 'string' ? rec.baseUrl.trim() : '';
	const apiKeyEnv = typeof rec.apiKeyEnv === 'string' ? rec.apiKeyEnv.trim() : '';
	if (!baseUrl) throw new ModelPackError('Remote model is missing a base URL.');
	try {
		if (new URL(baseUrl).protocol === 'file:') {
			throw new ModelPackError('Pack must not include file endpoints.');
		}
	} catch (error) {
		if (error instanceof ModelPackError) throw error;
	}
	if (urlHasEmbeddedSecret(baseUrl)) {
		throw new ModelPackError('Pack must not include passwords or tokens in endpoint URLs.');
	}
	if (!apiKeyEnv) throw new ModelPackError('Remote model is missing an API key environment variable name.');
	if (!/^[A-Z][A-Z0-9_]*$/.test(apiKeyEnv)) {
		throw new ModelPackError('API key field must be an environment variable name, not a secret.');
	}
	return { baseUrl, apiKeyEnv };
}

function parsePortableModel(raw: unknown, index: number): PortableModel {
	const rec = assertObject(raw, `Model ${index + 1} must be an object.`);
	const id = sanitizeRowId(rec.id);
	if (!id) throw new ModelPackError(`Model ${index + 1} is missing an id.`);
	if (isReservedLegacyHost(id)) {
		throw new ModelPackError(`${id} is a reserved host id and cannot be imported as a row.`);
	}
	const name = typeof rec.name === 'string' ? rec.name.trim() : '';
	const slug = typeof rec.slug === 'string' ? rec.slug.trim() : '';
	if (!name) throw new ModelPackError(`Model ${id} is missing a name.`);
	if (!slug) throw new ModelPackError(`Model ${id} is missing a slug.`);
	const access = rec.access;
	if (access === 'local_http' || access === 'proofreader') {
		throw new ModelPackError('Pack must not include local endpoints or proofreader rows.');
	}
	if (access !== 'remote_http' && access !== 'cli') {
		throw new ModelPackError(`Model ${id} has an unsupported access type.`);
	}
	const operations = Array.isArray(rec.operations)
		? rec.operations.filter(validOperation)
		: [...CHAT_AND_CLI_OPERATIONS];
	if (!operations.length) throw new ModelPackError(`Model ${id} has no tasks.`);
	const roles = Array.isArray(rec.roles) ? rec.roles.filter(validRole) : [...ALL_ROLES];
	if (access === 'cli') {
		if (!isCliAdapterId(String(rec.cliAdapter || ''))) {
			throw new ModelPackError(`Model ${id} needs a supported CLI adapter.`);
		}
		return {
			id,
			name,
			slug,
			access: 'cli',
			cliAdapter: rec.cliAdapter as CliAdapterId,
			operations,
			roles,
			disabled: rec.disabled === true ? true : undefined,
		};
	}
	if (rec.runtime != null && rec.runtime !== 'openai' && !MODEL_RUNTIMES.includes(rec.runtime as ModelRuntime)) {
		throw new ModelPackError(`Model ${id} has an unsupported runtime.`);
	}
	return {
		id,
		name,
		slug,
		access: 'remote_http',
		runtime: 'openai',
		operations,
		roles,
		http: parseHttp(rec.http),
		disabled: rec.disabled === true ? true : undefined,
	};
}

function parsePortableProfile(raw: unknown, index: number): PortableProfile {
	const rec = assertObject(raw, `Profile ${index + 1} must be an object.`);
	const id = typeof rec.id === 'string' ? rec.id.trim() : '';
	if (!id) throw new ModelPackError(`Profile ${index + 1} is missing an id.`);
	return {
		id,
		name: normalizeProfileName(rec.name),
		selections: parseProfileSelections(rec.selections),
	};
}

export function parseModelPack(raw: unknown): ModelPack {
	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw);
		} catch {
			throw new ModelPackError('Model pack is not valid JSON.');
		}
	}
	const rec = assertObject(raw, 'Model pack must be a JSON object.');
	walkForbidden(rec);
	if (rec.kind !== MODEL_PACK_KIND) {
		throw new ModelPackError('This file is not a Komatose model pack.');
	}
	if (rec.version !== MODEL_PACK_VERSION) {
		throw new ModelPackError(
			`Unsupported model pack version ${String(rec.version)}. This app reads version ${MODEL_PACK_VERSION}.`,
		);
	}
	if (!Array.isArray(rec.models) || !Array.isArray(rec.profiles)) {
		throw new ModelPackError('Model pack must include models and profiles lists.');
	}
	const models = rec.models.map((item, i) => parsePortableModel(item, i));
	const ids = new Set<string>();
	for (const model of models) {
		if (ids.has(model.id)) throw new ModelPackError(`Model pack has a duplicate model id ${model.id}.`);
		ids.add(model.id);
	}
	let profiles: PortableProfile[];
	try {
		profiles = rec.profiles.map((item, i) => parsePortableProfile(item, i));
	} catch (error) {
		if (error instanceof Error && error.name === 'ModelProfileError') {
			throw new ModelPackError(error.message);
		}
		throw error;
	}
	const profileIds = new Set<string>();
	for (const profile of profiles) {
		if (profileIds.has(profile.id)) throw new ModelPackError(`Model pack has a duplicate profile id ${profile.id}.`);
		profileIds.add(profile.id);
	}
	const exportedAt = typeof rec.exportedAt === 'string' ? rec.exportedAt : '';
	return {
		kind: MODEL_PACK_KIND,
		version: MODEL_PACK_VERSION,
		exportedAt,
		models,
		profiles,
	};
}

function nameKey(name: string): string {
	return name.trim().toLowerCase();
}

function parseDecisionMap(raw: unknown, label: string): Record<string, ConflictAction> | undefined {
	if (raw == null) return undefined;
	const rec = assertObject(raw, `${label} decisions must be an object.`);
	const out: Record<string, ConflictAction> = {};
	for (const [id, value] of Object.entries(rec)) {
		const item = assertObject(value, `Decision for ${label} ${id} must be an object.`);
		if (item.action === 'skip') {
			out[id] = { action: 'skip' };
			continue;
		}
		if (item.action === 'rename') {
			const nextId = typeof item.id === 'string' ? item.id.trim() : '';
			if (!nextId) throw new ModelPackError(`Choose a new id when renaming ${label} ${id}.`);
			out[id] = {
				action: 'rename',
				id: nextId,
				name: typeof item.name === 'string' ? item.name : undefined,
			};
			continue;
		}
		throw new ModelPackError('Conflicts must be skipped or renamed. Overwrite is not allowed.');
	}
	return out;
}

export function parseImportDecisions(raw: unknown): ImportDecisions {
	if (raw == null) return {};
	const rec = assertObject(raw, 'Import decisions must be an object.');
	return {
		models: parseDecisionMap(rec.models, 'model'),
		profiles: parseDecisionMap(rec.profiles, 'profile'),
	};
}

function decisionFor(
	map: Record<string, ConflictAction> | undefined,
	id: string,
	required: boolean,
	label: string,
): ConflictAction | undefined {
	const decision = map?.[id];
	if (!decision) {
		if (required) throw new ModelPackError(`Choose skip or rename for conflicting ${label} ${id}.`);
		return undefined;
	}
	if (decision.action === 'skip') return decision;
	const nextId = typeof decision.id === 'string' ? decision.id.trim() : '';
	if (!nextId) throw new ModelPackError(`Choose a new id when renaming ${label} ${id}.`);
	return { action: 'rename', id: nextId, name: decision.name };
}

export function previewModelPack(
	pack: ModelPack,
	rows: readonly ModelRow[],
	profiles: readonly ModelProfile[],
	envNames: ReadonlySet<string> = new Set(),
): PackPreview {
	const add: PackPreviewItem[] = [];
	const conflicts: PackConflict[] = [];
	const missing: PackDependency[] = [];
	const existingIds = new Set(rows.map((row) => row.id));
	const existingProfileIds = new Set(profiles.map((item) => item.id));
	const existingProfileNames = new Map(profiles.map((item) => [nameKey(item.name), item]));

	for (const model of pack.models) {
		const existing = rows.find((row) => row.id === model.id);
		if (existing) {
			conflicts.push({
				kind: 'model',
				id: model.id,
				name: model.name,
				reason: 'id',
				existingId: existing.id,
				existingName: existing.name,
			});
			continue;
		}
		add.push({
			kind: 'model',
			id: model.id,
			name: model.name,
			detail: model.access === 'cli' ? `${model.cliAdapter} · ${model.slug}` : model.http?.baseUrl || model.slug,
		});
		if (model.access === 'remote_http' && model.http?.apiKeyEnv && !envNames.has(model.http.apiKeyEnv)) {
			missing.push({
				kind: 'env',
				ref: model.http.apiKeyEnv,
				message: `${model.name} expects ${model.http.apiKeyEnv} in .env on this machine.`,
			});
		}
	}

	const incomingIds = new Set(pack.models.map((item) => item.id));
	for (const profile of pack.profiles) {
		const byId = existingProfileIds.has(profile.id);
		const byName = existingProfileNames.get(nameKey(profile.name));
		if (byId) {
			conflicts.push({
				kind: 'profile',
				id: profile.id,
				name: profile.name,
				reason: 'id',
				existingId: profile.id,
				existingName: profiles.find((item) => item.id === profile.id)?.name,
			});
		} else if (byName) {
			conflicts.push({
				kind: 'profile',
				id: profile.id,
				name: profile.name,
				reason: 'name',
				existingId: byName.id,
				existingName: byName.name,
			});
		} else {
			add.push({ kind: 'profile', id: profile.id, name: profile.name, detail: 'named profile' });
		}
		const refs = [
			profile.selections.translate.engine,
			profile.selections.proofread.engine,
			...profile.selections.reviewers.map((item) => item.engine),
			...profile.selections.transcriptionModels,
		...(profile.selections.transcriptionDecider ? [profile.selections.transcriptionDecider.engine] : []),
		];
		for (const ref of refs) {
			if (existingIds.has(ref) || incomingIds.has(ref)) continue;
			if (profileRowForRef({ engine: ref, model: '' }, rows).row) continue;
			if (missing.some((item) => item.kind === 'model' && item.ref === ref)) continue;
			missing.push({
				kind: 'model',
				ref,
				message: `Profile ${profile.name} needs model ${ref}, which is not in this install or pack.`,
			});
		}
	}

	return { pack, add, conflicts, missing };
}

function remapSelections(
	selections: ModelProfileSelections,
	modelMap: Map<string, string>,
): ModelProfileSelections {
	const mapRef = (engine: string) => modelMap.get(engine) || engine;
	return {
		...cloneProfileSelections(selections),
		...(selections.transcriptionDecider ? { transcriptionDecider: { ...selections.transcriptionDecider, engine: mapRef(selections.transcriptionDecider.engine) } } : {}),
		translate: { engine: mapRef(selections.translate.engine), model: selections.translate.model },
		proofread: { engine: mapRef(selections.proofread.engine), model: selections.proofread.model },
		reviewers: selections.reviewers.map((item) => ({ engine: mapRef(item.engine), model: item.model })),
		transcriptionModels: selections.transcriptionModels.map((id) => mapRef(id)),
	};
}

export type ResolvedImport = {
	models: PortableModel[];
	profiles: PortableProfile[];
	skippedModelIds: string[];
	skippedProfileIds: string[];
};

export function resolveImport(
	pack: ModelPack,
	rows: readonly ModelRow[],
	profiles: readonly ModelProfile[],
	decisions: ImportDecisions = {},
): ResolvedImport {
	const preview = previewModelPack(pack, rows, profiles);
	const modelMap = new Map<string, string>();
	const taken = new Set(rows.map((row) => row.id));
	const models: PortableModel[] = [];
	const skippedModelIds: string[] = [];

	for (const model of pack.models) {
		const conflict = preview.conflicts.find((item) => item.kind === 'model' && item.id === model.id);
		if (!conflict) {
			if (taken.has(model.id) || isReservedLegacyHost(model.id)) {
				throw new ModelPackError(`Model id ${model.id} is already taken.`);
			}
			taken.add(model.id);
			modelMap.set(model.id, model.id);
			models.push(model);
			continue;
		}
		const decision = decisionFor(decisions.models, model.id, true, 'model');
		if (!decision || decision.action === 'skip') {
			skippedModelIds.push(model.id);
			modelMap.set(model.id, model.id);
			continue;
		}
		const nextId = sanitizeRowId(decision.id);
		if (!nextId) throw new ModelPackError(`Choose a valid new id for model ${model.id}.`);
		if (nextId === model.id) {
			throw new ModelPackError(`Renaming ${model.id} requires a different id. Skip to keep the existing row.`);
		}
		if (taken.has(nextId) || isReservedLegacyHost(nextId)) {
			throw new ModelPackError(`Cannot rename ${model.id} to ${nextId}; that id is already taken.`);
		}
		taken.add(nextId);
		modelMap.set(model.id, nextId);
		models.push({
			...model,
			id: nextId,
			name: decision.name?.trim() || model.name,
		});
	}

	const profileIds = new Set(profiles.map((item) => item.id));
	const profileNames = new Set(profiles.map((item) => nameKey(item.name)));
	const resolvedProfiles: PortableProfile[] = [];
	const skippedProfileIds: string[] = [];

	for (const profile of pack.profiles) {
		const conflict = preview.conflicts.find((item) => item.kind === 'profile' && item.id === profile.id);
		const selections = remapSelections(profile.selections, modelMap);
		if (!conflict) {
			if (profileIds.has(profile.id) || profileNames.has(nameKey(profile.name))) {
				throw new ModelPackError(`Profile ${profile.name} conflicts with an existing profile.`);
			}
			profileIds.add(profile.id);
			profileNames.add(nameKey(profile.name));
			resolvedProfiles.push({ ...profile, selections });
			continue;
		}
		const decision = decisionFor(decisions.profiles, profile.id, true, 'profile');
		if (!decision || decision.action === 'skip') {
			skippedProfileIds.push(profile.id);
			continue;
		}
		const nextId = decision.id.trim();
		const nextName = normalizeProfileName(decision.name || profile.name);
		if (nextId === profile.id && conflict.reason === 'id') {
			throw new ModelPackError(`Renaming profile ${profile.id} requires a different id. Skip to keep the existing profile.`);
		}
		if (profileIds.has(nextId)) {
			throw new ModelPackError(`Cannot rename profile ${profile.id} to ${nextId}; that id is already taken.`);
		}
		if (profileNames.has(nameKey(nextName))) {
			throw new ModelPackError(`A profile named ${JSON.stringify(nextName)} already exists.`);
		}
		profileIds.add(nextId);
		profileNames.add(nameKey(nextName));
		resolvedProfiles.push({ id: nextId, name: nextName, selections });
	}

	return { models, profiles: resolvedProfiles, skippedModelIds, skippedProfileIds };
}

export function validateResolvedImport(
	resolved: ResolvedImport,
	rows: readonly ModelRow[],
	profiles: readonly ModelProfile[],
	maxProfiles = 50,
): void {
	if (profiles.length + resolved.profiles.length > maxProfiles) {
		throw new ModelPackError(`Keep at most ${maxProfiles} model profiles.`);
	}
	const available = new Map(rows.map((row) => [row.id, row]));
	for (const model of resolved.models) {
		if (available.has(model.id)) {
			throw new ModelPackError(`Model ${model.id} already exists.`);
		}
		available.set(model.id, {
			id: model.id,
			name: model.name,
			slug: model.slug,
			access: model.access as ModelAccess,
			cliAdapter: model.cliAdapter,
			runtime: model.runtime,
			operations: [...CHAT_AND_CLI_OPERATIONS],
			roles: model.roles,
			http: model.http,
			seeded: false,
			operationsLocked: false,
			disabled: model.disabled,
		});
	}
	for (const profile of resolved.profiles) {
		const refs = [
			profile.selections.translate,
			profile.selections.proofread,
			...profile.selections.reviewers,
			...profile.selections.transcriptionModels.map((id) => ({ engine: id, model: '' })),
			...(profile.selections.transcriptionDecider ? [profile.selections.transcriptionDecider] : []),
		];
		for (const ref of refs) {
			const found = profileRowForRef(ref, [...available.values()]);
			if (found.missing || !found.row) {
				throw new ModelPackError(`Profile ${profile.name} needs model ${ref.engine}, which is not available after import.`);
			}
		}
	}
}

export function portableModelToOverlay(model: PortableModel): Partial<ModelRow> & { id: string } {
	return {
		id: model.id,
		name: model.name,
		slug: model.slug,
		access: model.access,
		cliAdapter: model.cliAdapter,
		runtime: model.runtime,
		operations: [...CHAT_AND_CLI_OPERATIONS],
		roles: model.roles,
		http: model.http,
		disabled: model.disabled,
		seeded: false,
		operationsLocked: false,
	};
}
