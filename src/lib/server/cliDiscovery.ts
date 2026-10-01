/**
 * Server-only CLI executable discovery for Grok, Codex and Cursor.
 *
 * Precedence for each tool:
 * 1. Explicit nonempty environment override (see OVERRIDE_VARS). A bad
 *    override is an error; another installation is not selected.
 * 2. Admin-saved executable in SCAN_DATA_DIR/cli-tools.json. A bad saved
 *    path is an error; another installation is not selected.
 * 3. The named command on PATH (PATH directories only).
 * 4. Known install locations under the user's home directory.
 * 5. Codex only: optional bundled helper from a Cursor `openai.chatgpt-*`
 *    extension, and only for the verified linux x64 layout.
 *
 * Override values are a single path or command name. They are never passed to
 * a shell, split on spaces, or expanded for `$VARS`, globs, or `~user`.
 * Relative paths resolve from the server working directory. A leading `~/` or
 * `~\` is joined to the resolved home directory.
 *
 * Cursor is discovered as `cursor-agent` only. A generic `agent` binary is
 * never auto-selected (Grok also ships one). If Cursor is installed under
 * another name, set CURSOR_BIN.
 *
 * `status === 'found'` means a launchable file was found. It is not a login
 * check and not a model-availability check. Absolute paths stay on the server.
 */
import { accessSync, constants, lstatSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import nodePath from 'node:path';
import { CliToolsConfigError, readCliToolSettings, savedCliTool } from './cliToolSettings';
import {
	CLI_ADAPTER_DEFS,
	cliAdapterDef,
	isCliAdapterDefId,
	type CliAdapterDefEntry,
	type CliAdapterDefId,
} from '../cliAdapterDefs';

export type CliToolId = CliAdapterDefId;

export type DiscoveryStatus =
	| 'found'
	| 'missing'
	| 'invalid_override'
	| 'permission_failure'
	| 'unsupported_launch_target';

export type DiscoverySource = 'override' | 'saved_setting' | 'path' | 'known_install' | 'bundled_extension';

export type CliDiscoveryResult = {
	status: DiscoveryStatus;
	reason: string;
	source?: DiscoverySource;
	/** Absolute executable path. Server-side only; do not send to the browser. */
	path?: string;
	overrideVar?: string;
	issue?: 'cmd_shim' | 'non_exe' | 'directory' | 'broken_symlink' | 'other';
};

export type PathApi = {
	delimiter: string;
	sep: string;
	join(...parts: string[]): string;
	isAbsolute(p: string): boolean;
	basename(p: string): string;
	dirname(p: string): string;
	normalize(p: string): string;
	extname(p: string): string;
};

export type StatInfo = {
	kind: 'file' | 'directory' | 'symlink' | 'other';
	mode: number;
	mtimeMs: number;
};

export type FsLookup<T> = { ok: true; value: T } | { ok: false; error: 'missing' | 'forbidden' };

export type DiscoveryFs = {
	lstat(path: string): FsLookup<StatInfo>;
	stat(path: string): FsLookup<StatInfo>;
	readdir(path: string): FsLookup<string[]>;
	canExecute(path: string): boolean;
};

export type DiscoveryHost = {
	cwd: string;
	platform: string;
	arch: string;
	env: NodeJS.ProcessEnv | Record<string, string | undefined>;
	path: PathApi;
	homedir(): string | null;
	fs: DiscoveryFs;
	/**
	 * Admin-saved executables. When the property is present (including `{}`),
	 * discovery uses it and does not read the settings file. Omitted means
	 * read SCAN_DATA_DIR/cli-tools.json at call time.
	 */
	savedTools?: Partial<Record<CliToolId, string>>;
};

/** Collect one field from every adapter into a record keyed by adapter id. */
function adapterRecord<T>(pick: (item: CliAdapterDefEntry) => T): Record<CliToolId, T> {
	const out = {} as Record<CliToolId, T>;
	for (const item of CLI_ADAPTER_DEFS) out[item.id] = pick(item);
	return out;
}

export const OVERRIDE_VARS = adapterRecord((item) => item.discovery.overrideVars);

export const CLI_COMMAND = adapterRecord((item) => item.discovery.command);

export const CLI_LABEL = adapterRecord((item) => item.label);

/** Bundled Cursor Codex helper is only verified for this layout. */
export const BUNDLED_CODEX_LAYOUT = 'linux-x86_64';

export const CLI_FOUND_REASON =
	'CLI executable found; authentication and model availability are checked by the CLI when run';

const KNOWN_RELATIVE = adapterRecord((item) => item.discovery.knownRelative);

export function isCliToolId(id: string): id is CliToolId {
	return isCliAdapterDefId(id);
}

export function nodeDiscoveryHost(): DiscoveryHost {
	return {
		get cwd() {
			return process.cwd();
		},
		get platform() {
			return process.platform;
		},
		get arch() {
			return process.arch;
		},
		get env() {
			return process.env;
		},
		path: nodePath,
		homedir: () => {
			try {
				return homedir() || null;
			} catch {
				return null;
			}
		},
		fs: nodeDiscoveryFs(),
	};
}

function nodeDiscoveryFs(): DiscoveryFs {
	return {
		lstat: (path) => readStat(path, true),
		stat: (path) => readStat(path, false),
		readdir: (path) => {
			try {
				return { ok: true, value: readdirSync(path) };
			} catch (error) {
				return { ok: false, error: fsError(error) };
			}
		},
		canExecute: (path) => {
			try {
				accessSync(path, constants.X_OK);
				return true;
			} catch {
				return false;
			}
		},
	};
}

function readStat(path: string, link: boolean): FsLookup<StatInfo> {
	try {
		const info = link ? lstatSync(path) : statSync(path);
		const kind = info.isSymbolicLink()
			? 'symlink'
			: info.isFile()
				? 'file'
				: info.isDirectory()
					? 'directory'
					: 'other';
		return { ok: true, value: { kind, mode: info.mode, mtimeMs: info.mtimeMs } };
	} catch (error) {
		return { ok: false, error: fsError(error) };
	}
}

function fsError(error: unknown): 'missing' | 'forbidden' {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
	return 'forbidden';
}

function envValue(env: DiscoveryHost['env'], name: string): string {
	return String(env[name] || '').trim();
}

/** Home from env, then platform APIs. Never a hard-coded user path. */
export function resolveHome(host: DiscoveryHost): string | null {
	const unix = envValue(host.env, 'HOME');
	if (unix) return unix;
	if (host.platform === 'win32') {
		const profile = envValue(host.env, 'USERPROFILE');
		if (profile) return profile;
		const drive = envValue(host.env, 'HOMEDRIVE');
		const folder = envValue(host.env, 'HOMEPATH');
		if (drive && folder) {
			if (host.path.isAbsolute(folder) || folder.startsWith('\\') || folder.startsWith('/')) {
				return `${drive}${folder}`;
			}
			return host.path.join(drive, folder);
		}
	}
	const osHome = host.homedir()?.trim();
	return osHome || null;
}

export function extraBinDirectories(host: DiscoveryHost = nodeDiscoveryHost()): string[] {
	const home = resolveHome(host);
	if (!home) return [];
	return [
		host.path.join(home, '.local', 'bin'),
		host.path.join(home, 'bin'),
		host.path.join(home, '.grok', 'bin'),
	];
}

export function spawnSearchPath(host: DiscoveryHost = nodeDiscoveryHost()): string {
	const current = envValue(host.env, 'PATH');
	const parts = [
		...extraBinDirectories(host),
		...current.split(host.path.delimiter).filter(Boolean),
	];
	return parts.join(host.path.delimiter);
}

export function spawnProcessEnv(host: DiscoveryHost = nodeDiscoveryHost()): NodeJS.ProcessEnv {
	const home = resolveHome(host);
	return {
		...host.env,
		...(home ? { HOME: home } : {}),
		PATH: spawnSearchPath(host),
	};
}

export function executablePath(result: CliDiscoveryResult): string | null {
	return result.status === 'found' && result.path ? result.path : null;
}

export function cliReadiness(id: CliToolId, host: DiscoveryHost = nodeDiscoveryHost()): {
	available: boolean;
	reason: string;
} {
	const result = discoverCli(id, host);
	return { available: result.status === 'found', reason: result.reason };
}

export function discoverCli(id: CliToolId, host: DiscoveryHost = nodeDiscoveryHost()): CliDiscoveryResult {
	try {
		return discoverCliUnchecked(id, host);
	} catch (error) {
		if (error instanceof CliToolsConfigError) {
			return {
				status: 'invalid_override',
				source: 'saved_setting',
				reason: error.message,
			};
		}
		return { status: 'missing', reason: missingReason(id) };
	}
}

function settingsFor(host: DiscoveryHost): Partial<Record<CliToolId, string>> {
	if (Object.prototype.hasOwnProperty.call(host, 'savedTools')) return host.savedTools || {};
	return readCliToolSettings();
}

export function environmentOverrideVar(id: CliToolId, host: DiscoveryHost = nodeDiscoveryHost()): string | undefined {
	return firstOverride(id, host)?.name;
}

function discoverCliUnchecked(id: CliToolId, host: DiscoveryHost): CliDiscoveryResult {
	const override = firstOverride(id, host);
	if (override) return resolveOverride(id, override.name, override.value, host);

	const saved = savedCliTool(id, settingsFor(host));
	if (saved) return resolveExplicit(id, saved, host, 'saved_setting');

	const command = CLI_COMMAND[id];
	const pathHit = searchNamedCommand(id, command, 'path', pathDirectories(host), host);
	if (pathHit.status === 'found') return pathHit;

	const home = resolveHome(host);
	const knownDirs: string[] = [];
	const knownFiles: string[] = [];
	if (home) {
		for (const relative of KNOWN_RELATIVE[id]) {
			knownFiles.push(joinHomeRelative(home, relative, host));
		}
		knownDirs.push(
			host.path.join(home, '.local', 'bin'),
			host.path.join(home, 'bin'),
		);
	}
	const knownHit = firstLaunchable(id, [
		...knownFiles.flatMap((file) => fileVariants(file, host).map((path) => ({ path, source: 'known_install' as const }))),
		...commandCandidatesInDirs(command, knownDirs, 'known_install', host),
	], host);
	if (knownHit.status === 'found') return knownHit;

	if (cliAdapterDef(id)?.discovery.bundledExtension) {
		return betterFailure(pathHit, knownHit, findBundledCodex(host));
	}

	return betterFailure(pathHit, knownHit, { status: 'missing', reason: missingReason(id) });
}

function firstOverride(id: CliToolId, host: DiscoveryHost): { name: string; value: string } | null {
	for (const name of OVERRIDE_VARS[id]) {
		const value = envValue(host.env, name);
		if (value) return { name, value };
	}
	return null;
}

function joinHomeRelative(home: string, relative: string, host: DiscoveryHost): string {
	const parts = relative.split('/').filter(Boolean);
	return host.path.join(home, ...parts);
}

function pathDirectories(host: DiscoveryHost): string[] {
	return envValue(host.env, 'PATH').split(host.path.delimiter).filter(Boolean);
}

function looksLikePath(value: string, host: DiscoveryHost): boolean {
	if (host.path.isAbsolute(value)) return true;
	if (value === '.' || value === '..') return true;
	if (value.startsWith(`./`) || value.startsWith(`../`)) return true;
	if (host.platform === 'win32' && (value.startsWith('.\\') || value.startsWith('..\\'))) return true;
	if (value.includes(host.path.sep)) return true;
	if (host.platform === 'win32' && value.includes('/')) return true;
	return false;
}

function expandLeadingHome(value: string, host: DiscoveryHost): string | null {
	if (!(value.startsWith('~/') || value.startsWith('~\\'))) return value;
	const home = resolveHome(host);
	if (!home) return null;
	return host.path.join(home, value.slice(2));
}

function resolveSpecified(value: string, host: DiscoveryHost): { kind: 'path'; path: string } | { kind: 'command'; name: string } | { kind: 'no_home' } {
	const expanded = expandLeadingHome(value, host);
	if (expanded === null) return { kind: 'no_home' };
	if (looksLikePath(expanded, host)) {
		const resolved = host.path.isAbsolute(expanded)
			? expanded
			: host.path.join(host.cwd, expanded);
		return { kind: 'path', path: host.path.normalize(resolved) };
	}
	return { kind: 'command', name: expanded };
}

function resolveOverride(
	id: CliToolId,
	overrideVar: string,
	value: string,
	host: DiscoveryHost,
): CliDiscoveryResult {
	return resolveExplicit(id, value, host, 'override', overrideVar);
}

function resolveExplicit(
	id: CliToolId,
	value: string,
	host: DiscoveryHost,
	source: 'override' | 'saved_setting',
	overrideVar?: string,
): CliDiscoveryResult {
	const specified = resolveSpecified(value, host);
	if (specified.kind === 'no_home') {
		return {
			status: 'invalid_override',
			source,
			overrideVar,
			reason:
				source === 'override'
					? `${overrideVar} starts with ~/ but no home directory is available. Use an absolute path, or unset ${overrideVar} to allow normal discovery.`
					: `The saved ${CLI_LABEL[id]} location starts with ~/ but no home directory is available. Use an absolute path, or clear it to allow automatic discovery.`,
		};
	}
	if (specified.kind === 'command') {
		const found = searchNamedCommand(id, specified.name, source, pathDirectories(host), host);
		if (found.status === 'found') return { ...found, overrideVar, source };
		if (found.status === 'missing') {
			return {
				status: 'invalid_override',
				source,
				overrideVar,
				reason: explicitMissingReason(id, source, overrideVar),
			};
		}
		return {
			...found,
			status:
				found.status === 'unsupported_launch_target' || found.status === 'permission_failure'
					? found.status
					: 'invalid_override',
			source,
			overrideVar,
			reason: explicitReason(id, source, overrideVar, found),
		};
	}
	const inspected = inspectCandidate(specified.path, host);
	if (inspected.status === 'found') {
		return {
			status: 'found',
			source,
			overrideVar,
			path: specified.path,
			reason: CLI_FOUND_REASON,
		};
	}
	if (inspected.status === 'missing') {
		return {
			status: 'invalid_override',
			source,
			overrideVar,
			reason: explicitMissingReason(id, source, overrideVar),
		};
	}
	return {
		status: inspected.status === 'permission_failure' || inspected.status === 'unsupported_launch_target'
			? inspected.status
			: 'invalid_override',
		source,
		overrideVar,
		issue: overrideIssue(inspected),
		reason: explicitReason(id, source, overrideVar, inspected),
	};
}

type Inspected =
	| { status: 'found'; mtimeMs: number }
	| { status: 'missing' }
	| { status: 'invalid_override'; detail: 'directory' | 'broken_symlink' | 'other' }
	| { status: 'permission_failure' }
	| { status: 'unsupported_launch_target'; detail: 'cmd_shim' | 'non_exe' };

function inspectCandidate(candidate: string, host: DiscoveryHost): Inspected {
	const link = host.fs.lstat(candidate);
	if (!link.ok) return link.error === 'forbidden' ? { status: 'permission_failure' } : { status: 'missing' };
	let file = link.value;
	if (file.kind === 'symlink') {
		const target = host.fs.stat(candidate);
		if (!target.ok) {
			return target.error === 'forbidden'
				? { status: 'permission_failure' }
				: { status: 'invalid_override', detail: 'broken_symlink' };
		}
		file = target.value;
	}
	if (file.kind === 'directory') return { status: 'invalid_override', detail: 'directory' };
	if (file.kind !== 'file') return { status: 'invalid_override', detail: 'other' };
	if (host.platform === 'win32') {
		const ext = host.path.extname(candidate).toLowerCase();
		if (ext === '.cmd' || ext === '.bat') return { status: 'unsupported_launch_target', detail: 'cmd_shim' };
		if (ext !== '.exe') return { status: 'unsupported_launch_target', detail: 'non_exe' };
		return { status: 'found', mtimeMs: file.mtimeMs };
	}
	if (!host.fs.canExecute(candidate)) return { status: 'permission_failure' };
	return { status: 'found', mtimeMs: file.mtimeMs };
}

function winSuffixes(command: string, host: DiscoveryHost): string[] {
	if (host.path.extname(command)) return [command];
	if (host.platform !== 'win32') return [command];
	return [`${command}.exe`, command, `${command}.cmd`, `${command}.bat`];
}

function fileVariants(file: string, host: DiscoveryHost): string[] {
	if (host.platform !== 'win32') return [file];
	if (host.path.extname(file)) return [file];
	return [`${file}.exe`, file, `${file}.cmd`, `${file}.bat`];
}

function commandCandidatesInDirs(
	command: string,
	dirs: string[],
	source: DiscoverySource,
	host: DiscoveryHost,
): { path: string; source: DiscoverySource }[] {
	const names = winSuffixes(command, host);
	const out: { path: string; source: DiscoverySource }[] = [];
	for (const dir of dirs) {
		if (!dir) continue;
		for (const name of names) {
			out.push({ path: host.path.join(dir, name), source });
		}
	}
	return out;
}

function searchNamedCommand(
	id: CliToolId,
	command: string,
	source: DiscoverySource,
	dirs: string[],
	host: DiscoveryHost,
): CliDiscoveryResult {
	return firstLaunchable(id, commandCandidatesInDirs(command, dirs, source, host), host);
}

function firstLaunchable(
	id: CliToolId,
	candidates: { path: string; source: DiscoverySource }[],
	host: DiscoveryHost,
): CliDiscoveryResult {
	const seen = new Set<string>();
	let fallback: CliDiscoveryResult | undefined;
	for (const candidate of candidates) {
		const key = candidate.path;
		if (seen.has(key)) continue;
		seen.add(key);
		const inspected = inspectCandidate(candidate.path, host);
		if (inspected.status === 'found') {
			return {
				status: 'found',
				source: candidate.source,
				path: candidate.path,
				reason: CLI_FOUND_REASON,
			};
		}
		if (inspected.status === 'permission_failure' || inspected.status === 'unsupported_launch_target') {
			fallback ??= {
				status: inspected.status,
				source: candidate.source,
				reason: searchFailureReason(id, inspected),
				issue: inspected.status === 'unsupported_launch_target' ? inspected.detail : undefined,
			};
		}
	}
	return fallback ?? { status: 'missing', reason: missingReason(id) };
}

function betterFailure(...results: CliDiscoveryResult[]): CliDiscoveryResult {
	return results.find((result) => result.status === 'permission_failure' || result.status === 'unsupported_launch_target')
		?? results.find((result) => result.status === 'invalid_override')
		?? results[results.length - 1];
}

function bundledCodexArchDir(host: DiscoveryHost): string | null {
	const arch = host.arch === 'x86_64' || host.arch === 'amd64' ? 'x64' : host.arch;
	if (host.platform === 'linux' && arch === 'x64') return BUNDLED_CODEX_LAYOUT;
	return null;
}

function findBundledCodex(host: DiscoveryHost): CliDiscoveryResult {
	const home = resolveHome(host);
	if (!home) return { status: 'missing', reason: missingReason('codex') };
	const extDir = host.path.join(home, '.cursor', 'extensions');
	let names: string[];
	try {
		const listed = host.fs.readdir(extDir);
		if (!listed.ok) return { status: 'missing', reason: missingReason('codex') };
		names = listed.value;
	} catch {
		return { status: 'missing', reason: missingReason('codex') };
	}
	const archDir = bundledCodexArchDir(host);
	if (!archDir) {
		const hasBundle = names.some((name) => name.startsWith('openai.chatgpt-'));
		if (!hasBundle) return { status: 'missing', reason: missingReason('codex') };
		return {
			status: 'missing',
			reason: 'Codex CLI not found on PATH. Bundled Cursor Codex helper discovery is only verified on linux x64; set CODEX_BIN to a Codex executable.',
		};
	}
	const found: { path: string; mtimeMs: number }[] = [];
	let fallback: CliDiscoveryResult | undefined;
	for (const name of names) {
		if (!name.startsWith('openai.chatgpt-')) continue;
		const bin = host.path.join(extDir, name, 'bin', archDir, 'codex');
		const inspected = inspectCandidate(bin, host);
		if (inspected.status === 'found') found.push({ path: bin, mtimeMs: inspected.mtimeMs });
		else if (inspected.status === 'permission_failure' || inspected.status === 'unsupported_launch_target') {
			fallback ??= {
				status: inspected.status,
				source: 'bundled_extension',
				reason: searchFailureReason('codex', inspected),
			};
		}
	}
	found.sort((a, b) => b.mtimeMs - a.mtimeMs);
	if (found[0]) {
		return {
			status: 'found',
			source: 'bundled_extension',
			path: found[0].path,
			reason: CLI_FOUND_REASON,
		};
	}
	return fallback ?? { status: 'missing', reason: missingReason('codex') };
}

function missingReason(id: CliToolId): string {
	return cliAdapterDef(id)?.discovery.missingReason || `${id} CLI not found.`;
}

function overrideMissingReason(overrideVar: string, id: CliToolId): string {
	return `${overrideVar} is set, but that path or command was not found. Set ${overrideVar} to a runnable ${CLI_LABEL[id]} executable, or unset it to allow normal discovery.`;
}

function savedMissingReason(id: CliToolId): string {
	return `The saved ${CLI_LABEL[id]} location was not found. Set it to a runnable ${CLI_LABEL[id]} executable, or clear it to allow automatic discovery.`;
}

function explicitMissingReason(
	id: CliToolId,
	source: 'override' | 'saved_setting',
	overrideVar?: string,
): string {
	if (source === 'override' && overrideVar) return overrideMissingReason(overrideVar, id);
	return savedMissingReason(id);
}

function explicitReason(
	id: CliToolId,
	source: 'override' | 'saved_setting',
	overrideVar: string | undefined,
	inspected: Inspected | CliDiscoveryResult,
): string {
	if (source === 'override' && overrideVar) return overrideReason(overrideVar, id, inspected);
	return savedReason(id, inspected);
}

function savedReason(id: CliToolId, inspected: Inspected | CliDiscoveryResult): string {
	const label = CLI_LABEL[id];
	const issue = overrideIssue(inspected);
	if (inspected.status === 'permission_failure') {
		return `The saved ${label} location is not executable. Check permissions, or clear it to allow automatic discovery.`;
	}
	if (inspected.status === 'unsupported_launch_target') {
		if (issue === 'non_exe') {
			return `The saved ${label} location is a file this server cannot launch without a shell. On Windows, save a .exe, or clear it to allow automatic discovery.`;
		}
		return `The saved ${label} location is a Windows command shim (.cmd/.bat). This server launches CLIs without a shell, so those shims are unsupported. Save a .exe, or clear it. Discovery will not use another installation while this setting is saved.`;
	}
	if (issue === 'directory') {
		return `The saved ${label} location is a directory. Save the ${label} executable file, or clear it to allow automatic discovery.`;
	}
	if (issue === 'broken_symlink') {
		return `The saved ${label} location is a broken symbolic link. Point it at a real executable, or clear it to allow automatic discovery.`;
	}
	return `The saved ${label} location is not a usable ${label} executable. Use a runnable file (not a directory). Discovery will not use another installation while this setting is saved.`;
}

function overrideIssue(inspected: Inspected | CliDiscoveryResult): CliDiscoveryResult['issue'] {
	if ('detail' in inspected) return inspected.detail;
	if ('issue' in inspected) return inspected.issue;
	return undefined;
}

function overrideReason(overrideVar: string, id: CliToolId, inspected: Inspected | CliDiscoveryResult): string {
	const label = CLI_LABEL[id];
	const issue = overrideIssue(inspected);
	if (inspected.status === 'permission_failure') {
		return `${overrideVar} is set but that file is not executable. Check permissions, or unset ${overrideVar} to allow normal discovery.`;
	}
	if (inspected.status === 'unsupported_launch_target') {
		if (issue === 'non_exe') {
			return `${overrideVar} is set to a file this server cannot launch without a shell. On Windows, set ${overrideVar} to a .exe, or unset it to allow normal discovery.`;
		}
		return `${overrideVar} points to a Windows command shim (.cmd/.bat). This server launches CLIs without a shell, so those shims are unsupported. Set ${overrideVar} to a .exe, or unset it. Discovery will not use another installation while this override is set.`;
	}
	if (issue === 'directory') {
		return `${overrideVar} is set to a directory. Set it to the ${label} executable file, or unset it to allow normal discovery.`;
	}
	if (issue === 'broken_symlink') {
		return `${overrideVar} is set to a broken symbolic link. Point it at a real executable, or unset it to allow normal discovery.`;
	}
	return `${overrideVar} is set but does not point to a usable ${label} executable. Use a runnable file (not a directory). Discovery will not use another installation while this override is set.`;
}

function searchFailureReason(id: CliToolId, inspected: Inspected): string {
	const label = CLI_LABEL[id];
	const override = OVERRIDE_VARS[id][0];
	if (inspected.status === 'permission_failure') {
		return `${label} CLI was found but is not executable. Check permissions or set ${override} to a runnable file.`;
	}
	if (inspected.status === 'unsupported_launch_target' && inspected.detail === 'cmd_shim') {
		return `${label} CLI was found as a Windows command shim (.cmd/.bat), which this server cannot launch without a shell. Set ${override} to a .exe.`;
	}
	return `${label} CLI was found, but it is not a launchable executable for this server. Set ${override} to a runnable file.`;
}

export function grokExecutable(host: DiscoveryHost = nodeDiscoveryHost()): string | null {
	return executablePath(discoverCli('grok', host));
}

export function codexExecutable(host: DiscoveryHost = nodeDiscoveryHost()): string | null {
	return executablePath(discoverCli('codex', host));
}

export function cursorExecutable(host: DiscoveryHost = nodeDiscoveryHost()): string | null {
	return executablePath(discoverCli('cursor', host));
}
