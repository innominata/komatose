/**
 * Admin-saved CLI executable locations.
 * Missing file means automatic discovery. No credentials or model rows.
 * Allowed ids are production adapter definitions only.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
	PRODUCTION_CLI_ADAPTER_IDS,
	cliAdapterDef,
	formatAdapterList,
	isProductionCliAdapterId,
	type ProductionCliAdapterId,
} from '../cliAdapterDefs';

export type CliToolId = ProductionCliAdapterId;

function toolLabel(id: string): string {
	return cliAdapterDef(id)?.label || id;
}

export function isCliToolId(id: string): id is CliToolId {
	return isProductionCliAdapterId(id);
}

export class CliToolsConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CliToolsConfigError';
	}
}

export type CliToolSettings = Partial<Record<string, string>>;

const TOOL_IDS: readonly CliToolId[] = PRODUCTION_CLI_ADAPTER_IDS;
const MAX_EXECUTABLE_CHARS = 4096;

/** Resolved at call time so tests can isolate SCAN_DATA_DIR after import. */
export function cliToolsPath(): string {
	const root = process.env.SCAN_ROOT || process.cwd();
	const data = process.env.SCAN_DATA_DIR || join(root, 'data');
	return join(data, 'cli-tools.json');
}

export function validateCliToolId(id: string): CliToolId {
	if (!isCliToolId(id)) {
		throw new CliToolsConfigError(`Choose ${formatAdapterList(PRODUCTION_CLI_ADAPTER_IDS, 'or')}.`);
	}
	return id;
}

export function normalizeSavedExecutable(raw: unknown, id: string): string {
	if (typeof raw !== 'string') {
		throw new CliToolsConfigError(
			`Saved ${toolLabel(id)} location must be a single executable path or command name.`,
		);
	}
	const value = raw.trim();
	if (!value) {
		throw new CliToolsConfigError(`Saved ${toolLabel(id)} location is empty.`);
	}
	if (value.length > MAX_EXECUTABLE_CHARS) {
		throw new CliToolsConfigError(`Saved ${toolLabel(id)} location is too long.`);
	}
	if (/[\n\r\0]/.test(value)) {
		throw new CliToolsConfigError(
			`Saved ${toolLabel(id)} location must be one path or command name, not a script.`,
		);
	}
	return value;
}

export function readCliToolSettings(): CliToolSettings {
	const path = cliToolsPath();
	let raw: string;
	try {
		raw = readFileSync(path, 'utf8');
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code === 'ENOENT') return {};
		throw new CliToolsConfigError('Could not read CLI tool settings.');
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new CliToolsConfigError(
			'CLI tool settings file is not valid JSON. Fix or delete SCAN_DATA_DIR/cli-tools.json.',
		);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new CliToolsConfigError(
			'CLI tool settings must be a JSON object of tool ids to executable strings.',
		);
	}
	const rec = parsed as Record<string, unknown>;
	const unknown = Object.keys(rec).filter((key) => !isCliToolId(key));
	if (unknown.length) {
		throw new CliToolsConfigError(
			`CLI tool settings contain unknown tool id ${JSON.stringify(unknown[0])}. Only ${formatAdapterList(PRODUCTION_CLI_ADAPTER_IDS, 'and')} are allowed.`,
		);
	}
	const out: CliToolSettings = {};
	for (const id of TOOL_IDS) {
		if (!Object.prototype.hasOwnProperty.call(rec, id)) continue;
		const value = rec[id];
		if (value == null || value === '') continue;
		out[id] = normalizeSavedExecutable(value, id);
	}
	return out;
}

export function savedCliTool(id: string, settings?: CliToolSettings): string | undefined {
	const value = (settings ?? readCliToolSettings())[id];
	return value?.trim() || undefined;
}

export function writeCliToolSettings(settings: CliToolSettings): CliToolSettings {
	const path = cliToolsPath();
	mkdirSync(dirname(path), { recursive: true });
	const payload: Record<string, string> = {};
	for (const id of TOOL_IDS) {
		const value = settings[id];
		if (typeof value === 'string' && value.trim()) {
			payload[id] = normalizeSavedExecutable(value, id);
		}
	}
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
	try {
		renameSync(tmp, path);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			/* ignore */
		}
		throw error;
	}
	return { ...payload };
}

export function setCliToolSetting(id: string, executable: unknown): CliToolSettings {
	const tool = validateCliToolId(id);
	const value = normalizeSavedExecutable(executable, tool);
	const next = { ...readCliToolSettings(), [tool]: value };
	return writeCliToolSettings(next);
}

export function clearCliToolSetting(id: string): CliToolSettings {
	const tool = validateCliToolId(id);
	const next = { ...readCliToolSettings() };
	delete next[tool];
	return writeCliToolSettings(next);
}
