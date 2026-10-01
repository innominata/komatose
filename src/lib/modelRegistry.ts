import { capabilityPassed, CAPABILITY_REQUIREMENTS, type CapabilityId, type CapabilitySample } from './modelCapabilities';
import { MODEL_TASK_IDS, type ProbeOutcome } from './modelTasks';
/**
 * Named translation-assistant rows. Saved TaskEngine.engine is a row id
 * (or a legacy host id that hydrate/resolve still accept).
 */
import type { ManagedLaunch, RequestPreset } from './managedModels';
import { DEFAULT_CHAT_MODEL_ID } from './modelDefaults';
import type { ProviderOperation } from './providerCatalog';
import {
	isProofreaderId,
	PROOFREADER_DEFS,
	proofreaderLabel,
	type ProofreaderId,
} from './proofreaders';
import {
	PRODUCTION_CLI_ADAPTER_IDS,
	cliAdapterDef,
	isProductionCliAdapterId,
	type ProductionCliAdapterId,
} from './cliAdapterDefs';
import {
	GEMMA4_12B_ID,
	GEMMA4_26B_ID,
	GEMMA4_E2B_ID,
} from './gemmaModels';
import {
	QWEN3_VL_ID,
	QWEN3_VL_LABEL,
	QWEN_38_27B_ID,
	qwenModelLabel,
} from './qwenModels';
import { translationModel } from './translationModels';
import { localReviewModel } from './localReviewModels';
import { ROLES, type Role } from './roles';

const ALL_ROLES: Role[] = ['admin', 'translator', 'proofreader', 'typesetter'];

/** Opaque upstream model ids may include `/` and `:` (`org/model:tag`). */
const MODEL_SLUG_INVALID_CHAR = /[^\w./:[\]=,+\-@]/;

export const RESERVED_LEGACY_HOST_IDS = ['qwen', 'grok', 'codex', 'cursor'] as const;

/**
 * Ids that were once seeded rows and are no longer. Overlay entries for these are
 * dropped rather than reinterpreted, so an install that predates their removal can
 * never resurrect them as a bogus row of another access kind.
 */
export const RETIRED_SEED_IDS = [
	'chatgpt',
	'deepseek',
	// The chat-model rows were never configs: this build ships launch presets in
	// Setup instead, so an operator adds them explicitly (or not at all).
	QWEN_38_27B_ID,
	GEMMA4_E2B_ID,
	GEMMA4_12B_ID,
	GEMMA4_26B_ID,
	'shisa-v2-llama3.1-8b-q4',
] as const;

export function isReservedLegacyHost(id: string): boolean {
	return (RESERVED_LEGACY_HOST_IDS as readonly string[]).includes(id);
}

export function sanitizeModelSlug(raw: unknown): string {
	const s = String(raw || '').trim();
	if (!s) return '';
	const specialist = translationModel(s);
	if (specialist) return specialist.id;
	return s;
}

export function isValidModelSlug(value: string): boolean {
	if (!value) return true;
	if (translationModel(value)) return true;
	return !MODEL_SLUG_INVALID_CHAR.test(value);
}

export const MODEL_ACCESSES = ['local_http', 'remote_http', 'cli', 'proofreader'] as const;
export type ModelAccess = (typeof MODEL_ACCESSES)[number];

export const CLI_ADAPTER_IDS = PRODUCTION_CLI_ADAPTER_IDS;
export type CliAdapterId = ProductionCliAdapterId;

export const MODEL_RUNTIMES = [
	'llamacpp',
	'openai',
	'qwen3vl',
	'cat-translate',
	'hy-manga',
	'hy-mt',
	'ko-en-minrnn',
	'opus-mt-ja-en',
	'shisa',
	'sugoi-ja-en',
	'translategemma',
	'hayai',
	'paddleocr-vl',
	'manga-ocr',
] as const;
export type ModelRuntime = (typeof MODEL_RUNTIMES)[number];

export type ModelHttpConfig = {
	baseUrl: string;
	apiKeyEnv: string;
};

export type ProbeSample = {
	operation: ProviderOperation;
	ok: boolean;
	outcome?: ProbeOutcome;
	fingerprint?: string;
	at: number;
	reason?: string;
	ms?: number;
	samplesMs?: number[];
	outputPreview?: string;
};

export type ModelRow = {
	qualificationAdapter?: 'general' | 'ocr' | 'translator' | 'direct';
	implementedTasks?: ProviderOperation[];
	capabilities?: Partial<Record<CapabilityId, CapabilitySample>>;
	capabilityHistory?: CapabilitySample[];
	capabilityFingerprints?: Partial<Record<CapabilityId, string>>;
	packageId?: string;
	modelRevision?: string;
	taskFingerprints?: Record<string, string>;
	probeHistory?: ProbeSample[];
	id: string;
	name: string;
	slug: string;
	access: ModelAccess;
	cliAdapter?: CliAdapterId;
	runtime?: ModelRuntime;
	operations: ProviderOperation[];
	roles: Role[];
	languages?: Array<'japanese' | 'korean'>;
	http?: ModelHttpConfig;
	managedLaunch?: ManagedLaunch | null;
	requestPreset?: RequestPreset;
	suggestions?: { knownGood?: ProviderOperation[] };
	seeded: boolean;
	operationsLocked: boolean;
	disabled?: boolean;
	probes?: Partial<Record<ProviderOperation, ProbeSample>>;
};

export type AssistantHost = 'http' | 'qwen' | CliAdapterId | ProofreaderId;

export type ResolvedAssistant = {
	row: ModelRow;
	slug: string;
	host: AssistantHost;
};

export type ModelCatalogCache = {
	adapter: string;
	at: number;
	models: { id: string; label: string }[];
};

export type ModelOverlay = {
	rows?: Array<Partial<ModelRow> & { id: string }>;
	catalogs?: ModelCatalogCache[];
};

export const CHAT_AND_CLI_OPERATIONS: ProviderOperation[] = [...MODEL_TASK_IDS];

function row(partial: Omit<ModelRow, 'seeded' | 'operationsLocked' | 'roles'> & {
	roles?: Role[];
	operationsLocked?: boolean;
}): ModelRow {
	return {
		roles: ALL_ROLES,
		seeded: true,
		operationsLocked: partial.operationsLocked ?? false,
		...partial,
	};
}

export const SEED_ROWS: ModelRow[] = [
	// The chat models (Qwen 3.8 27B, Gemma 4) are deliberately not seeded:
	// Setup ships their launch presets instead, so an operator adds one as a
	// real config on this machine. Their ids are retired in RETIRED_SEED_IDS.
	// One model, one entry: Qwen3-VL reads images for the app, and the Qwen3-VL
	// 8B install extends this same row into the operator's light chat model
	// (one managed server, one copy of the weights) instead of adding a twin row.
	//
	// Models are task-agnostic: every seeded model ships with every task, and
	// the per-task test is what decides whether it can actually do one. A model
	// with no text input fails the text tests, an OCR model fails the review
	// tests — that is the test's job, not a box set at seed time.
	row({
		id: QWEN3_VL_ID,
		name: QWEN3_VL_LABEL,
		slug: QWEN3_VL_ID,
		access: 'local_http',
		runtime: 'qwen3vl',
		operations: [...CHAT_AND_CLI_OPERATIONS],
	}),
	row({
		id: 'cat-translate-7b-q4',
		name: 'CAT-Translate 7B Q4',
		slug: 'cat-translate-7b-q4',
		access: 'local_http',
		runtime: 'cat-translate',
		operations: [...CHAT_AND_CLI_OPERATIONS],
		languages: ['japanese'],
	}),
	row({
		id: 'hy-mt2-manga-v5',
		name: 'Hy-MT2 1.8B Manga v5',
		slug: 'hy-mt2-manga-v5',
		access: 'local_http',
		runtime: 'hy-manga',
		operations: [...CHAT_AND_CLI_OPERATIONS],
		languages: ['japanese'],
	}),
	row({
		id: 'hy-mt2-7b-q4',
		name: 'Hy-MT2 7B Q4',
		slug: 'hy-mt2-7b-q4',
		access: 'local_http',
		runtime: 'hy-mt',
		operations: [...CHAT_AND_CLI_OPERATIONS],
		languages: ['japanese'],
	}),
	row({
		id: 'imsbee-ko-en-translator',
		name: 'Imsbee Ko→En Translator',
		slug: 'imsbee-ko-en-translator',
		access: 'local_http',
		runtime: 'ko-en-minrnn',
		operations: [...CHAT_AND_CLI_OPERATIONS],
		languages: ['korean'],
	}),
	row({
		id: 'opus-mt-ja-en',
		name: 'Opus-MT Ja→En',
		slug: 'opus-mt-ja-en',
		access: 'local_http',
		runtime: 'opus-mt-ja-en',
		operations: [...CHAT_AND_CLI_OPERATIONS],
		languages: ['japanese'],
	}),
	row({
		id: 'shisa-v2.1-qwen3-8b-q4',
		name: 'Shisa v2.1 8B Q4',
		slug: 'shisa-v2.1-qwen3-8b-q4',
		access: 'local_http',
		runtime: 'shisa',
		operations: [...CHAT_AND_CLI_OPERATIONS],
		languages: ['japanese'],
	}),
	row({
		id: 'sugoi-v4-ja-en',
		name: 'Sugoi v4 Ja→En',
		slug: 'sugoi-v4-ja-en',
		access: 'local_http',
		runtime: 'sugoi-ja-en',
		operations: [...CHAT_AND_CLI_OPERATIONS],
		languages: ['japanese'],
	}),
	row({
		id: 'translategemma-4b-q4',
		name: 'TranslateGemma 4B Q4',
		slug: 'translategemma-4b-q4',
		access: 'local_http',
		runtime: 'translategemma',
		operations: [...CHAT_AND_CLI_OPERATIONS],
		languages: ['japanese'],
	}),
	row({
		id: 'translategemma-12b-q4',
		name: 'TranslateGemma 12B Q4',
		slug: 'translategemma-12b-q4',
		access: 'local_http',
		runtime: 'translategemma',
		operations: [...CHAT_AND_CLI_OPERATIONS],
		languages: ['japanese'],
	}),
	row({
		id: 'hayai-ocr-v2',
		name: 'Hayai OCR v2',
		slug: 'hayai-ocr-v2',
		access: 'local_http',
		runtime: 'hayai',
		operations: [...CHAT_AND_CLI_OPERATIONS],
	}),
	row({
		id: 'manga-ocr',
		name: 'Manga OCR',
		slug: 'manga-ocr',
		access: 'local_http',
		runtime: 'manga-ocr',
		operations: [...CHAT_AND_CLI_OPERATIONS],
		languages: ['japanese'],
	}),
	row({
		id: 'paddleocr-vl-1.6',
		name: 'PaddleOCR-VL-1.6',
		slug: 'paddleocr-vl-1.6',
		access: 'local_http',
		runtime: 'paddleocr-vl',
		operations: [...CHAT_AND_CLI_OPERATIONS],
	}),
];

/**
 * Proofreaders are contributed by the proofreading service, not seeded here.
 * The rows exist only so a configured service has something to resolve to; when
 * no service is configured they are reported unavailable and stay hidden.
 */
const PROOFREADER_SEED_ROWS: ModelRow[] = PROOFREADER_DEFS.map((def) =>
	row({
		id: def.id,
		name: def.label,
		slug: def.id,
		access: 'proofreader',
		operations: ['pageImageProofread'],
		operationsLocked: true,
	}),
);

export const ALL_SEED_ROWS: ModelRow[] = [...SEED_ROWS, ...PROOFREADER_SEED_ROWS];


export const DEFAULT_TRANSCRIPTION_MODEL_IDS = ['hayai-ocr-v2', 'paddleocr-vl-1.6'] as const;

const SEED_BY_ID = new Map(ALL_SEED_ROWS.map((item) => [item.id, item]));

export function seedRow(id: string): ModelRow | undefined {
	const found = SEED_BY_ID.get(id);
	return found ? { ...found, operations: [...found.operations], roles: [...found.roles] } : undefined;
}

export function isCliAdapterId(id: string): id is CliAdapterId {
	return isProductionCliAdapterId(id);
}

export function isAssistantHost(id: string): id is AssistantHost {
	return id === 'http' || id === 'qwen' || isProofreaderId(id) || isProductionCliAdapterId(id);
}

export function hostOf(row: ModelRow): AssistantHost {
	if (row.access === 'proofreader') return isProofreaderId(row.id) ? row.id : 'proofreader-a';
	if (row.cliAdapter) return row.cliAdapter;
	return 'http';
}

/**
 * Whether a model may be offered for a task. Shared capability evidence opens
 * language jobs; specialist and custom adapters use direct integration evidence.
 */
export function rowHasOperation(row: ModelRow, operation: ProviderOperation | readonly ProviderOperation[]): boolean {
	const list = typeof operation === 'string' ? [operation] : operation;
	return list.some((item) => {
		if (row.implementedTasks && !row.implementedTasks.includes(item)) return false;
		if (item === 'sourceReview') return rowHasOperation(row, 'vision');
		const required = row.qualificationAdapter && row.qualificationAdapter !== 'direct' ? CAPABILITY_REQUIREMENTS[item] : undefined;
		if (required) return required.every(id => capabilityPassed(row, id));
		const probe = row.probes?.[item];
		return probe?.ok === true && Boolean(probe.fingerprint) && probe.fingerprint === row.taskFingerprints?.[item];
	});
}

/** Jobs enabled by current qualification evidence. */
export function allowedOperations(row: ModelRow): ProviderOperation[] {
	const candidates = new Set<ProviderOperation>(MODEL_TASK_IDS);
	for (const key of Object.keys(row.probes ?? {})) candidates.add(key as ProviderOperation);
	return [...candidates].filter((item) => rowHasOperation(row, item));
}

export function isOcrSpecialist(row: ModelRow): boolean {
	return row.runtime === 'hayai' || row.runtime === 'paddleocr-vl' || row.runtime === 'manga-ocr';
}

export function isTranslationSpecialist(row: ModelRow): boolean {
	return row.runtime === 'cat-translate' || row.runtime === 'hy-manga' || row.runtime === 'hy-mt' || row.runtime === 'ko-en-minrnn' || row.runtime === 'opus-mt-ja-en' || row.runtime === 'shisa' || row.runtime === 'sugoi-ja-en' || row.runtime === 'translategemma';
}

export function isProbeable(row: ModelRow): boolean {
	return true;
}

export function isOnDemandAccess(row: ModelRow): boolean {
	return row.access === 'cli' || row.access === 'remote_http' || row.access === 'proofreader';
}

export function rowForReviewer(row: ModelRow): boolean {
	return !row.disabled && rowHasOperation(row, 'sourceReview');
}

export function visionEligible(row: ModelRow): boolean {
	return !row.disabled && rowHasOperation(row, 'vision');
}

export function takenRowIds(rows: Array<{ id: string }>): Set<string> {
	return new Set([...RESERVED_LEGACY_HOST_IDS, ...rows.map((item) => item.id)]);
}

export function cliRowId(adapter: CliAdapterId, slug: string, taken: Set<string>): string {
	if (!slug) return adapter;
	const blocked = new Set<string>([...RESERVED_LEGACY_HOST_IDS, ...taken]);
	const pinned = cliAdapterDef(adapter)?.rowIdForSlug?.[slug];
	if (pinned) return pinned;
	if (!blocked.has(slug)) return slug;
	let id = `${adapter}-${slug}`;
	let n = 2;
	while (blocked.has(id)) {
		id = `${adapter}-${slug}-${n}`;
		n += 1;
	}
	return id;
}

function cloneRow(row: ModelRow): ModelRow {
	return {
		...row,
		managedLaunch: row.managedLaunch ? structuredClone(row.managedLaunch) : row.managedLaunch,
		operations: [...row.operations],
		roles: [...row.roles],
		languages: row.languages ? [...row.languages] : undefined,
		http: row.http ? { ...row.http } : undefined,
		suggestions: row.suggestions?.knownGood
			? { knownGood: [...row.suggestions.knownGood] }
			: row.suggestions,
		probes: row.probes ? { ...row.probes } : undefined,
	};
}

function validOperation(value: unknown): value is ProviderOperation {
	return typeof value === 'string' && MODEL_TASK_IDS.includes(value as ProviderOperation);
}

function validRole(value: unknown): value is Role {
	return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

function mergeSeedWithOverlay(seed: ModelRow, extra: Partial<ModelRow>): ModelRow {
	const next = cloneRow(seed);
	if ('managedLaunch' in extra) next.managedLaunch = extra.managedLaunch;
	if (extra.requestPreset === 'generic' || extra.requestPreset === 'qwen-thinking') next.requestPreset = extra.requestPreset;
	if (typeof extra.name === 'string' && extra.name.trim()) next.name = extra.name.trim();
	if (typeof extra.slug === 'string' && extra.slug.trim()) next.slug = extra.slug.trim();
	if (typeof extra.disabled === 'boolean') next.disabled = extra.disabled;
	if (Array.isArray(extra.roles)) next.roles = extra.roles.filter(validRole);
	// Seeded models are task-agnostic: a saved overlay can no longer put a task
	// box back on one. The per-task test decides what it can do.
	if (seed.access === 'remote_http' || seed.runtime === 'openai' || seed.runtime === 'llamacpp' || seed.runtime === 'qwen3vl') {
		if (extra.http && typeof extra.http.baseUrl === 'string') {
			next.http = {
				baseUrl: extra.http.baseUrl,
				apiKeyEnv: typeof extra.http.apiKeyEnv === 'string' ? extra.http.apiKeyEnv : next.http?.apiKeyEnv || '',
			};
		}
	}
	if (extra.suggestions?.knownGood) {
		next.suggestions = { knownGood: extra.suggestions.knownGood.filter(validOperation) };
	}
	if (extra.probes) next.probes = { ...next.probes, ...extra.probes };
	next.probeHistory = extra.probeHistory;
	next.capabilities = extra.capabilities;
	next.capabilityHistory = extra.capabilityHistory;
	next.modelRevision = extra.modelRevision;
	next.packageId = extra.packageId;
	return next;
}

function overlayRowFromPartial(extra: Partial<ModelRow> & { id: string }, taken: Set<string>): ModelRow | null {
	const id = extra.id.trim();
	if (!id || taken.has(id) || isReservedLegacyHost(id)) return null;
	const access = MODEL_ACCESSES.includes(extra.access as ModelAccess) ? (extra.access as ModelAccess) : 'remote_http';
	const cliAdapter = isCliAdapterId(String(extra.cliAdapter || '')) ? extra.cliAdapter : undefined;
	if (access === 'cli' && !cliAdapter && !extra.packageId) return null;
	const runtime = MODEL_RUNTIMES.includes(extra.runtime as ModelRuntime) ? (extra.runtime as ModelRuntime) : access === 'remote_http' ? 'openai' : undefined;
	// Operator rows are task-agnostic too: any operations list that predates
	// this (a saved box) is widened back to every task — except external
	// proofreading services, which only ever do page images.
	const operations = [...CHAT_AND_CLI_OPERATIONS];
	// Only external proofreading services are fixed to their one job; every real
	// model is task-agnostic and the tests decide.
	const operationsLocked = false;
	return {
		id,
		name: (extra.name || extra.slug || id).trim(),
		slug: access === 'cli' && extra.slug === '' ? '' : (extra.slug || id).trim(),
		access,
		cliAdapter,
		runtime: runtime || (access === 'remote_http' ? 'openai' : undefined),
		operations,
		roles: Array.isArray(extra.roles) ? extra.roles.filter(validRole) : [...ALL_ROLES],
		http: extra.http && typeof extra.http.baseUrl === 'string'
			? { baseUrl: extra.http.baseUrl, apiKeyEnv: String(extra.http.apiKeyEnv || '') }
			: access === 'remote_http'
				? { baseUrl: '', apiKeyEnv: 'OPENAI_API_KEY' }
				: undefined,
		suggestions: extra.suggestions?.knownGood
			? { knownGood: extra.suggestions.knownGood.filter(validOperation) }
			: undefined,
		managedLaunch: extra.managedLaunch,
		requestPreset: extra.requestPreset === 'qwen-thinking' ? 'qwen-thinking' : 'generic',
		seeded: false,
		operationsLocked,
		disabled: extra.disabled === true,
		probes: extra.probes,
		probeHistory: extra.probeHistory,
		capabilities: extra.capabilities,
		capabilityHistory: extra.capabilityHistory,
		modelRevision: extra.modelRevision,
		packageId: extra.packageId,
	};
}

/** Overlay cannot wipe seeds. Invalid extras are skipped. */
export function mergeRegistry(overlay?: ModelOverlay | null, seeds: ModelRow[] = ALL_SEED_ROWS): ModelRow[] {
	const extras = Array.isArray(overlay?.rows) ? overlay!.rows! : [];
	const byId = new Map(seeds.map((item) => [item.id, cloneRow(item)]));
	for (const extra of extras) {
		if (!extra || typeof extra.id !== 'string' || !extra.id.trim()) continue;
		const id = extra.id.trim();
		// Retired seeds are dropped so a pre-upgrade overlay cannot resurrect
		// them — but an operator-added row (seeded: false) may reuse the id:
		// the shipped chat models are added by hand this way now.
		if ((RETIRED_SEED_IDS as readonly string[]).includes(id) && extra.seeded !== false) continue;
		const existing = byId.get(extra.id);
		if (existing?.seeded) {
			byId.set(extra.id, mergeSeedWithOverlay(existing, extra));
			continue;
		}
		if (existing && !existing.seeded) {
			byId.set(extra.id, mergeSeedWithOverlay(existing, extra));
			continue;
		}
		const created = overlayRowFromPartial(extra, takenRowIds([...byId.values()]));
		if (created) byId.set(created.id, created);
	}
	return [...byId.values()];
}

function findBySlug(rows: ModelRow[], adapter: CliAdapterId, slug: string): ModelRow | undefined {
	return rows.find((item) => item.cliAdapter === adapter && item.slug === slug);
}

function ephemeralCli(adapter: CliAdapterId, slug: string, rows: ModelRow[]): ModelRow {
	const taken = new Set(rows.map((item) => item.id));
	const def = cliAdapterDef(adapter);
	return {
		id: cliRowId(adapter, slug, taken),
		name: slug || def?.label || adapter,
		slug,
		access: 'cli',
		cliAdapter: adapter,
		operations: [...CHAT_AND_CLI_OPERATIONS],
		roles: [...ALL_ROLES],
		seeded: false,
		operationsLocked: true,
	};
}

export function resolveAssistant(
	engine: string,
	model = '',
	rows: ModelRow[] = ALL_SEED_ROWS,
	// The "whichever chat row exists" fallback is a machine-level question: it
	// needs this install's real rows. Callers holding only seeds (the browser
	// hydrating a saved choice) pass false so a saved model id is never quietly
	// rewritten to a different row.
	chatFallback = true,
): ResolvedAssistant {
	const id = String(engine || '').trim();
	const slugIn = sanitizeModelSlug(model);
	if (!id) throw new Error('Unsupported translation engine: ');

	// Legacy host ids stay host lookups even if an overlay row reused the alias.
	if (!isReservedLegacyHost(id)) {
		const direct = rows.find((item) => item.id === id);
		if (direct) {
			return { row: direct, slug: slugIn || direct.slug, host: hostOf(direct) };
		}
	}

	if (isProofreaderId(id)) {
		const tab = rows.find((item) => item.id === id) || seedRow(id)!;
		return { row: tab, slug: tab.slug, host: id };
	}

	if (id === 'qwen') {
		if (localReviewModel(slugIn)?.id === QWEN3_VL_ID) {
			const vl = rows.find((item) => item.id === slugIn) || seedRow(slugIn)!;
			return { row: vl, slug: vl.slug, host: 'http' };
		}
		const specialist = translationModel(slugIn);
		if (specialist) {
			const found = rows.find((item) => item.id === specialist.id) || seedRow(specialist.id);
			if (found) return { row: found, slug: found.slug, host: 'http' };
		}
		const local = localReviewModel(slugIn);
		if (local) {
			const found = rows.find((item) => item.id === local.id) || seedRow(local.id);
			if (found) return { row: found, slug: found.slug, host: 'http' };
		}
		// Legacy "qwen" host: resolve to the local chat model this machine
		// actually has. Chat rows are no longer seeded, so an operator who has
		// not added one falls through to the error below.
		const general =
			(slugIn ? rows.find((item) => item.slug === slugIn && item.access === 'local_http') : undefined) ||
      rows.find((item) => item.id === QWEN_38_27B_ID);
		if (general) return { row: general, slug: slugIn || general.slug, host: 'http' };
	}

	if (isCliAdapterId(id)) {
		const slug = id === 'cursor' && slugIn === 'auto' ? 'auto' : slugIn;
		if (slug) {
			const match = findBySlug(rows, id, slug);
			if (match) return { row: match, slug: match.slug, host: id };
			return { row: ephemeralCli(id, slug, rows), slug, host: id };
		}
		// No hardcoded default model: an empty slug means the CLI runs with its own
		// default, and the concrete slug comes from discovery once a row is added.
		const match = rows.find((item) => item.cliAdapter === id && !item.slug);
		if (match) return { row: match, slug: '', host: id };
		return { row: ephemeralCli(id, '', rows), slug: '', host: id };
	}

	// The shipped chat default with no row on this machine used to stop here.
	// Other installs run a lighter chat model (Qwen3-VL 8B, a remote row, a CLI
	// model) instead of the 27B, so fall back to whichever chat row exists
	// before giving up.
	if (chatFallback && (id === DEFAULT_CHAT_MODEL_ID || id === QWEN_38_27B_ID)) {
		// Real chat rows translate *and* handle context work. Only proven chat
		// candidates qualify: OCR and single-purpose translation specialists
		// cannot do the job, and a model whose text test failed must not be
		// picked as the fallback.
		const chatCapable = (item: ModelRow) =>
			!item.disabled &&
			rowHasOperation(item, 'translate') &&
			rowHasOperation(item, 'describe');
		const fallback =
			rows.find((item) => chatCapable(item) && item.access === 'local_http' && item.managedLaunch) ||
			rows.find((item) => chatCapable(item) && item.access === 'local_http') ||
			rows.find((item) => chatCapable(item) && item.access === 'remote_http') ||
			rows.find((item) => chatCapable(item) && item.access === 'cli');
		if (fallback) return { row: fallback, slug: slugIn || fallback.slug, host: hostOf(fallback) };
		throw new Error('No chat model has passed Translation and Description. Run those tests under Admin → Models → Jobs.');
	}

	throw new Error(`Unsupported translation engine: ${id}`);
}

export function hydrateTaskEngine(
	stored: unknown,
	rows: ModelRow[] = ALL_SEED_ROWS,
	// Hydration normalizes a saved choice; it must not substitute a different
	// model for it. Only the server, holding this machine's real rows, lets the
	// chat fallback rewrite a saved chat id whose row is gone.
	chatFallback = false,
): { engine: string; model: string } {
	const rec = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
	const engine = typeof rec.engine === 'string' ? rec.engine : '';
	const model = sanitizeModelSlug(rec.model);
	try {
		const resolved = resolveAssistant(engine || DEFAULT_CHAT_MODEL_ID, model, rows, chatFallback);
		const inRegistry = rows.some((item) => item.id === resolved.row.id);
		if (!inRegistry && resolved.row.access === 'cli' && resolved.row.cliAdapter) {
			return { engine: resolved.row.cliAdapter, model: resolved.slug };
		}
		const override = resolved.slug && resolved.slug !== resolved.row.slug ? resolved.slug : '';
		return { engine: resolved.row.id, model: override };
	} catch {
		return { engine: engine || 'unknown', model };
	}
}

export function accessGroup(row: ModelRow): 'Local models' | 'Remote models' | 'CLI agents' | 'Proofreaders' {
	if (row.access === 'remote_http') return 'Remote models';
	if (row.access === 'cli') return 'CLI agents';
	if (row.access === 'proofreader') return 'Proofreaders';
	return 'Local models';
}

export function rowAllowedForRole(row: ModelRow, role?: Role | null): boolean {
	if (!role) return row.roles.length > 0 && !row.disabled;
	if (role === 'scanlator') {
		return (
			!row.disabled &&
			row.roles.some((item) => item === 'scanlator' || item === 'translator' || item === 'proofreader' || item === 'typesetter')
		);
	}
	return !row.disabled && row.roles.includes(role);
}

export function assistantDisplayName(engine: string, model = '', rows: ModelRow[] = ALL_SEED_ROWS): string {
	try {
		// Seed rows do not include every installed chat model. The chat fallback
		// would relabel Qwen 3.8 27B as whichever chat row is seeded (Qwen3-VL).
		return resolveAssistant(engine, model, rows, false).row.name;
	} catch {
		const raw = String(engine || model || '').trim();
		if (!raw) return 'Unknown model';
		const named = qwenModelLabel(raw);
		return named !== raw ? named : raw;
	}
}

export function isLocalOcrReviewer(engine: string, model = '', rows: ModelRow[] = ALL_SEED_ROWS): boolean {
	try {
		const resolved = resolveAssistant(engine, model, rows, false);
		return Boolean(
			localReviewModel(resolved.row.id) ||
				localReviewModel(resolved.slug) ||
				localReviewModel(model),
		);
	} catch {
		return Boolean(localReviewModel(model));
	}
}

export function truncateOutputPreview(text: string, max = 280): string {
	const cleaned = String(text || '')
		.replace(/(Bearer\s+)\S+/gi, '$1[redacted]')
		.replace(/(api[_-]?key["\s:=]+)[\w-]+/gi, '$1[redacted]');
	const compact = cleaned.replace(/\s+/g, ' ').trim();
	return compact.length <= max ? compact : `${compact.slice(0, max)}…`;
}

export function pickerSeedEngines(rows: ModelRow[] = ALL_SEED_ROWS): Array<{
	id: string;
	label: string;
	available: boolean;
	pageImageOnly?: boolean;
	group: ReturnType<typeof accessGroup>;
	operations: ProviderOperation[];
	access: ModelAccess;
}> {
	return rows.filter((row) => !row.disabled).map((row) => ({
		id: row.id,
		label: row.name,
		available: true,
		pageImageOnly: row.access === 'proofreader',
		group: accessGroup(row),
		operations: allowedOperations(row),
		access: row.access,
	}));
}

export function defaultProbeOperation(row: ModelRow): ProviderOperation {
	if (isOcrSpecialist(row) || row.runtime === 'qwen3vl') return 'vision';
	if (isTranslationSpecialist(row)) return 'translate';
	return 'translate';
}

export function sanitizeRowId(raw: unknown): string {
	return String(raw || '')
		.trim()
		.toLowerCase()
		.replace(/[^\w.-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80);
}

export function discoveredRowId(adapter: CliAdapterId, slug: string, rows: ModelRow[]): string {
	return cliRowId(adapter, slug, new Set(rows.map((item) => item.id)));
}
