import { MODEL_TASK_IDS } from './modelTasks';
import { accessGroup, resolveAssistant, rowForReviewer, rowHasOperation } from './modelRegistry';
import { PROOFREADER_DEFS } from './proofreaders';
import {
	CLI_CHAT_OPERATIONS,
	PRODUCTION_CLI_ADAPTER_IDS,
	productionCliAdapterDefs,
} from './cliAdapterDefs';

export const PROVIDER_IDS = ['qwen', ...PRODUCTION_CLI_ADAPTER_IDS, ...PROOFREADER_DEFS.map((item) => item.id)] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export type ProviderTransport = 'local' | 'cli' | 'proofreader';

export const PROVIDER_OPERATIONS = MODEL_TASK_IDS;
export type ProviderOperation = (typeof PROVIDER_OPERATIONS)[number];

export type ProviderInfo = {
	id: ProviderId;
	label: string;
	transport: ProviderTransport;
};

const LOCAL_AND_CLI_OPERATIONS: readonly ProviderOperation[] = CLI_CHAT_OPERATIONS;

export const PROVIDER_CATALOG = [
	{
		id: 'qwen',
		label: 'Local HTTP',
		transport: 'local',
	},
	...productionCliAdapterDefs().map((item) => ({
		id: item.id,
		label: item.catalogLabel,
		transport: 'cli' as const,
	})),
	...PROOFREADER_DEFS.map((item) => ({
		id: item.id,
		label: item.catalogLabel,
		transport: 'proofreader' as const,
	})),
] as const satisfies readonly ProviderInfo[];

export type CatalogEntry = (typeof PROVIDER_CATALOG)[number];
export type CliProviderId = Extract<CatalogEntry, { transport: 'cli' }>['id'];

const PROVIDER_BY_ID = new Map<string, CatalogEntry>(PROVIDER_CATALOG.map((provider) => [provider.id, provider]));

export const PROVIDER_LABELS: Record<ProviderId, string> = Object.fromEntries(
	PROVIDER_CATALOG.map((provider) => [provider.id, provider.label]),
) as Record<ProviderId, string>;

export const CLI_PROVIDER_IDS = PROVIDER_CATALOG.filter(
	(provider): provider is Extract<CatalogEntry, { transport: 'cli' }> => provider.transport === 'cli',
).map((provider) => provider.id);

export function providerById(id: string): CatalogEntry | undefined {
	return PROVIDER_BY_ID.get(id);
}

export function isKnownProvider(id: string): id is ProviderId {
	return PROVIDER_BY_ID.has(id);
}

export function isCliProvider(id: string): id is CliProviderId {
	return providerById(id)?.transport === 'cli';
}

export function isProofreaderProvider(id: string): boolean {
	return providerById(id)?.transport === 'proofreader';
}

function operationList(
	operation: ProviderOperation | readonly ProviderOperation[],
): readonly ProviderOperation[] {
	return typeof operation === 'string' ? [operation] : operation;
}

export function providerSupports(
	id: string,
	operation: ProviderOperation | readonly ProviderOperation[],
): boolean {
 try { return rowHasOperation(resolveAssistant(id, '').row, operation); }
 catch { return false; }
}

export function providersForOperation(
	operation: ProviderOperation | readonly ProviderOperation[],
): CatalogEntry[] {
	return PROVIDER_CATALOG.filter((provider) => providerSupports(provider.id, operation));
}

export function unsupportedProviderReason(
	id: string,
	operation: ProviderOperation | readonly ProviderOperation[],
	live?: LiveProviderEngine,
): string {
	const provider = providerById(id);
	const label = live?.label || provider?.label;

	try {
		const resolved = resolveAssistant(id, '');

		for (const item of operationList(operation)) {
			const probe = resolved.row.probes?.[item];
			if (probe?.ok === false)
				return `${resolved.row.name} failed its ${item} test: ${probe.reason || 'no usable output'}.`;
		}
		if (!provider)
			return `${resolved.row.name} has not passed this task. Run it under Admin → Models → Jobs.`;
	} catch {
		if (!provider && !live) return `Unknown provider: ${id}`;
	}
	if (label) {
		return `${label} needs a current passing test for this task. Run it under Admin → Models → Jobs.`;
	}
	return `Unknown provider: ${id}`;
}

/** Live picker row. `available` is never invented as true. */
export type ProviderSelectionOption = {
	id: string;
	label: string;
	available: boolean;
	reason?: string;
	pageImageOnly?: boolean;
	group?: string;
	operations?: readonly ProviderOperation[];
	estimates?: Record<string, { label: string; ms: number; medianMs?: number }>;
	access?: string;
};

export type LiveProviderEngine = {
	id: string;
	label?: string;
	available?: boolean;
	reason?: string;
	pageImageOnly?: boolean;
	group?: string;
	operations?: readonly ProviderOperation[] | string[];
	estimates?: Record<string, { label: string; ms: number; medianMs?: number }>;
	access?: string;
};

function liveOperations(engine?: LiveProviderEngine): readonly string[] | undefined {
	return engine?.operations;
}

/** Prefer the live snapshot's operations over the static catalog / seed table. */
export function engineSupportsOperation(
	engine: LiveProviderEngine,
	operation: ProviderOperation | readonly ProviderOperation[],
): boolean {
	const listed = liveOperations(engine);
	if (listed) return operationList(operation).some((item) => listed.includes(item));
	return providerSupports(engine.id, operation);
}

/** The one available engine for an operation — for defaulting when the shipped default cannot run. */
export function singleAvailableEngineFor(
	engines: readonly LiveProviderEngine[],
	operation: ProviderOperation | readonly ProviderOperation[],
): string | undefined {
	const capable = engines.filter(
		(engine) => engine.available === true && engineSupportsOperation(engine, operation),
	);
	return capable.length === 1 ? capable[0].id : undefined;
}

export type ProviderRunGate = { ok: boolean; reason: string };

export function providerRunGate(
	engineId: string | undefined | null,
	operation: ProviderOperation | readonly ProviderOperation[],
	engines: readonly LiveProviderEngine[] = [],
): ProviderRunGate {
	if (!engineId) return { ok: false, reason: 'Choose a provider in AI model settings.' };
	const live = engines.find((engine) => engine.id === engineId);
	if (live && liveOperations(live)) {
		if (engineSupportsOperation(live, operation)) return { ok: true, reason: '' };
		return { ok: false, reason: unsupportedProviderReason(engineId, operation, live) };
	}
	if (providerSupports(engineId, operation)) return { ok: true, reason: '' };
	return { ok: false, reason: unsupportedProviderReason(engineId, operation, live) };
}

function omittedProviderOption(id: string): ProviderSelectionOption {
	const catalog = providerById(id);
	return {
		id,
		label: catalog?.label || id,
		available: false,
		reason: catalog
			? `${catalog.label} availability is unknown until model status refreshes.`
			: `Unknown provider: ${id}`,
		pageImageOnly: catalog?.transport === 'proofreader',
	};
}

export function toProviderSelectionOption(
	engine: LiveProviderEngine,
): ProviderSelectionOption {
	const catalog = providerById(engine.id);
	let group = engine.group;
	if (!group) {
		try {
			group = accessGroup(resolveAssistant(engine.id, '').row);
		} catch {
			group = catalog?.transport === 'proofreader' ? 'Proofreaders' : catalog?.transport === 'cli' ? 'CLI agents' : undefined;
		}
	}
	return {
		id: engine.id,
		label: engine.label || catalog?.label || engine.id,
		available: engine.available === true,
		reason: engine.reason,
		pageImageOnly: engine.pageImageOnly ?? (catalog?.transport === 'proofreader'),
		group,
		operations: engine.operations as ProviderOperation[] | undefined,
		estimates: engine.estimates,
		access: engine.access,
	};
}

/** Live engines for an operation; keep an unsupported or omitted saved ID visible. */
export function selectProvidersForOperation(
	engines: readonly LiveProviderEngine[],
	operation: ProviderOperation | readonly ProviderOperation[],
	savedId?: string,
	extras: readonly LiveProviderEngine[] = [],
): ProviderSelectionOption[] {
	const pool: LiveProviderEngine[] = [];
	for (const engine of [...engines, ...extras]) {
		if (!pool.some((item) => item.id === engine.id)) pool.push(engine);
	}
	const chosen = pool.filter((engine) => engineSupportsOperation(engine, operation)).map(toProviderSelectionOption);
	if (!savedId || chosen.some((engine) => engine.id === savedId)) return chosen;
	const saved = pool.find((engine) => engine.id === savedId);
	if (engineSupportsOperation(saved || { id: savedId }, operation)) {
		chosen.push(saved ? toProviderSelectionOption(saved) : omittedProviderOption(savedId));
		return chosen;
	}

	const fallback = saved ? toProviderSelectionOption(saved) : omittedProviderOption(savedId);
	chosen.push({
		...fallback,
		available: false,
		reason: unsupportedProviderReason(savedId, operation, saved),
	});
	return chosen;
}
