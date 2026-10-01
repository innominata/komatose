/**
 * Browser-safe CLI adapter definitions: id, labels, supported tasks, and
 * discovery metadata (command names, env vars, known install paths).
 * No filesystem, processes, or credentials.
 */

export const CLI_CHAT_OPERATIONS = [
	'translate',
	'vision',
	'describe',
	'proofreadEnglish',
	'chapterReview',
	'advisory',
	'compactNotes',
	'alternatives',
	'pageImageProofread',
] as const;

export type CliAdapterDiscoveryMeta = {
	command: string;
	overrideVars: readonly string[];
	knownRelative: readonly string[];
	missingReason: string;
	/** Server-only extra search (Cursor Codex helper). Discovery uses the flag, not the id. */
	bundledExtension?: boolean;
};

export type CliAdapterDef = {
	readonly id: string;
	readonly label: string;
	readonly catalogLabel: string;
	readonly production: boolean;
	readonly operations: readonly string[];
	/** Row ids pinned to a discovered slug; a model name is never hardcoded. */
	readonly rowIdForSlug?: Readonly<Record<string, string>>;
	readonly discovery: CliAdapterDiscoveryMeta;
};

const grok = {
	id: 'grok',
	label: 'Grok',
	catalogLabel: 'Grok CLI',
	production: true,
	operations: CLI_CHAT_OPERATIONS,
	rowIdForSlug: {},
	discovery: {
		command: 'grok',
		overrideVars: ['GROK_BIN'],
		knownRelative: ['.grok/bin/grok', '.local/bin/grok', 'bin/grok'],
		missingReason: 'Grok CLI not found. Install grok or set GROK_BIN to its executable.',
	},
} as const satisfies CliAdapterDef;

const codex = {
	id: 'codex',
	label: 'Codex',
	catalogLabel: 'Codex CLI',
	production: true,
	operations: [...CLI_CHAT_OPERATIONS, 'cleaning'],
	rowIdForSlug: {},
	discovery: {
		command: 'codex',
		overrideVars: ['CODEX_BIN'],
		knownRelative: ['.local/bin/codex', 'bin/codex'],
		missingReason: 'Codex CLI not found. Install Codex CLI or set CODEX_BIN to its executable.',
		bundledExtension: true,
	},
} as const satisfies CliAdapterDef;

const cursor = {
	id: 'cursor',
	label: 'Cursor',
	catalogLabel: 'Cursor CLI',
	production: true,
	operations: CLI_CHAT_OPERATIONS,
	rowIdForSlug: { auto: 'cursor-auto' },
	discovery: {
		command: 'cursor-agent',
		overrideVars: ['CURSOR_BIN', 'CURSOR_AGENT_BIN'],
		knownRelative: ['.local/bin/cursor-agent', 'bin/cursor-agent'],
		missingReason:
			'Cursor CLI not found as cursor-agent. Install cursor-agent or set CURSOR_BIN to that executable. Generic programs named agent are not selected automatically.',
	},
} as const satisfies CliAdapterDef;

/** Fake contract adapter. Not production: no catalog row, admin tool, or built-in registry entry. */
const example = {
	id: 'example',
	label: 'Example',
	catalogLabel: 'Example CLI',
	production: false,
	operations: ['advisory'],
	rowIdForSlug: {},
	discovery: {
		command: 'example-cli',
		overrideVars: ['EXAMPLE_BIN'],
		knownRelative: ['.local/bin/example-cli', 'bin/example-cli'],
		missingReason: 'Example CLI not found. Install example-cli or set EXAMPLE_BIN to its executable.',
	},
} as const satisfies CliAdapterDef;

export const CLI_ADAPTER_DEFS = [grok, codex, cursor, example] as const;
export type CliAdapterDefEntry = (typeof CLI_ADAPTER_DEFS)[number];
export type CliAdapterDefId = CliAdapterDefEntry['id'];
export type ProductionCliAdapterId = Extract<CliAdapterDefEntry, { production: true }>['id'];

/**
 * Returns the shared definition type rather than the narrowed literal entry, so
 * optional members (e.g. `rowIdForSlug`, `discovery.bundledExtension`) are
 * accessible on every adapter without per-variant narrowing.
 */
export function cliAdapterDef(id: string): CliAdapterDef | undefined {
	return CLI_ADAPTER_DEFS.find((item) => item.id === id);
}

export function isCliAdapterDefId(id: string): id is CliAdapterDefId {
	return Boolean(cliAdapterDef(id));
}

export function productionCliAdapterDefs(): Array<Extract<CliAdapterDefEntry, { production: true }>> {
	return CLI_ADAPTER_DEFS.filter(
		(item): item is Extract<CliAdapterDefEntry, { production: true }> => item.production,
	);
}

export const PRODUCTION_CLI_ADAPTER_IDS: readonly ProductionCliAdapterId[] = productionCliAdapterDefs().map(
	(item) => item.id,
);

export function isProductionCliAdapterId(id: string): id is ProductionCliAdapterId {
	return productionCliAdapterDefs().some((item) => item.id === id);
}

export function formatAdapterList(ids: readonly string[], lastWord: 'or' | 'and'): string {
	if (ids.length <= 1) return ids[0] || '';
	if (ids.length === 2) return `${ids[0]} ${lastWord} ${ids[1]}`;
	return `${ids.slice(0, -1).join(', ')}, ${lastWord} ${ids[ids.length - 1]}`;
}
