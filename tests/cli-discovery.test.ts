import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import posix from 'node:path/posix';
import win32 from 'node:path/win32';
import { join } from 'node:path';
import { test } from 'node:test';
import {
	CLI_FOUND_REASON,
	cliReadiness,
	discoverCli,
	executablePath,
	nodeDiscoveryHost,
	spawnSearchPath,
	type DiscoveryFs,
	type DiscoveryHost,
	type StatInfo,
} from '../src/lib/server/cliDiscovery';

type Entry =
	| { kind: 'file'; mode: number; mtimeMs: number }
	| { kind: 'directory'; mode: number; mtimeMs: number }
	| { kind: 'symlink'; target: string; mode: number; mtimeMs: number };

type MemoryHost = DiscoveryHost & {
	addFile(path: string, extra?: { mode?: number; mtimeMs?: number }): void;
	addDir(path: string): void;
	addSymlink(path: string, target: string): void;
	forbid(path: string): void;
};

function memoryHost(opts: {
	platform?: string;
	arch?: string;
	cwd?: string;
	path?: typeof posix | typeof win32;
	env?: Record<string, string | undefined>;
	homedir?: () => string | null;
} = {}): MemoryHost {
	const pathApi = opts.path ?? posix;
	const platform = opts.platform ?? 'linux';
	const files = new Map<string, Entry>();
	const dirs = new Set<string>();
	const forbidden = new Set<string>();
	const norm = (p: string) => pathApi.normalize(p);
	const ensureParents = (p: string) => {
		let current = norm(p);
		for (;;) {
			const parent = pathApi.dirname(current);
			if (parent === current) break;
			dirs.add(norm(parent));
			current = parent;
		}
	};
	const lookup = (p: string): { ok: true; value: Entry } | { ok: false; error: 'missing' | 'forbidden' } => {
		const key = norm(p);
		if (forbidden.has(key)) return { ok: false, error: 'forbidden' };
		const entry = files.get(key);
		if (entry) return { ok: true, value: entry };
		if (dirs.has(key)) return { ok: true, value: { kind: 'directory', mode: 0o755, mtimeMs: 1 } };
		return { ok: false, error: 'missing' };
	};
	const toStat = (entry: Entry): StatInfo => ({
		kind: entry.kind === 'symlink' ? 'symlink' : entry.kind,
		mode: entry.mode,
		mtimeMs: entry.mtimeMs,
	});
	const follow = (p: string, entry: Entry, depth = 0): ReturnType<DiscoveryFs['stat']> => {
		if (entry.kind !== 'symlink') return { ok: true, value: toStat(entry) };
		if (depth > 8) return { ok: false, error: 'missing' };
		const target = pathApi.isAbsolute(entry.target) ? entry.target : pathApi.join(pathApi.dirname(p), entry.target);
		if (forbidden.has(norm(target))) return { ok: false, error: 'forbidden' };
		const next = lookup(target);
		if (!next.ok) return next;
		return follow(target, next.value, depth + 1);
	};
	const host: MemoryHost = {
		cwd: opts.cwd ?? (platform === 'win32' ? 'C:\\app' : '/app'),
		platform,
		arch: opts.arch ?? 'x64',
		env: { PATH: '', HOME: platform === 'win32' ? undefined : '/home/user', ...opts.env },
		path: pathApi,
		homedir: opts.homedir ?? (() => null),
		savedTools: {},
		fs: {
			lstat(p) {
				const hit = lookup(p);
				if (!hit.ok) return hit;
				return { ok: true, value: toStat(hit.value) };
			},
			stat(p) {
				const hit = lookup(p);
				if (!hit.ok) return hit;
				return follow(p, hit.value);
			},
			readdir(p) {
				const key = norm(p);
				if (forbidden.has(key)) return { ok: false, error: 'forbidden' };
				if (!dirs.has(key)) return { ok: false, error: 'missing' };
				const names = new Set<string>();
				for (const file of files.keys()) {
					if (pathApi.dirname(file) === key) names.add(pathApi.basename(file));
				}
				for (const dir of dirs) {
					if (dir !== key && pathApi.dirname(dir) === key) names.add(pathApi.basename(dir));
				}
				return { ok: true, value: [...names] };
			},
			canExecute(p) {
				const resolved = host.fs.stat(p);
				if (!resolved.ok || resolved.value.kind !== 'file') return false;
				if (platform === 'win32') return true;
				return (resolved.value.mode & 0o111) !== 0;
			},
		},
		addFile(p, extra = {}) {
			const key = norm(p);
			ensureParents(key);
			files.set(key, { kind: 'file', mode: extra.mode ?? 0o755, mtimeMs: extra.mtimeMs ?? 1 });
		},
		addDir(p) {
			const key = norm(p);
			ensureParents(key);
			dirs.add(key);
		},
		addSymlink(p, target) {
			const key = norm(p);
			ensureParents(key);
			files.set(key, { kind: 'symlink', target, mode: 0o755, mtimeMs: 1 });
		},
		forbid(p) {
			forbidden.add(norm(p));
		},
	};
	if (platform !== 'win32' && host.env.HOME) host.addDir(host.env.HOME);
	if (platform === 'win32' && host.env.USERPROFILE) host.addDir(host.env.USERPROFILE);
	return host;
}

function assertSafeReason(reason: string, ...secrets: (string | undefined)[]) {
	assert.doesNotMatch(reason, /\/home\/inno\b/);
	for (const secret of secrets) {
		if (secret) assert.equal(reason.includes(secret), false, reason);
	}
}

test('injected fs: override precedence and invalid overrides do not fall through', () => {
	const host = memoryHost({
		env: { HOME: '/home/user', PATH: '/usr/bin', GROK_BIN: '/opt/custom/grok' },
	});
	host.addFile('/usr/bin/grok');
	host.addFile('/home/user/.grok/bin/grok');
	host.addFile('/opt/custom/grok');
	const found = discoverCli('grok', host);
	assert.equal(found.status, 'found');
	assert.equal(found.source, 'override');
	assert.equal(found.path, '/opt/custom/grok');
	assert.equal(found.reason, CLI_FOUND_REASON);

	host.env.GROK_BIN = '/missing/grok';
	const missing = discoverCli('grok', host);
	assert.equal(missing.status, 'invalid_override');
	assert.equal(missing.source, 'override');
	assert.equal(executablePath(missing), null);
	assert.match(missing.reason, /GROK_BIN/);
	assert.match(missing.reason, /not found|unset/i);
	assertSafeReason(missing.reason, '/missing/grok', '/usr/bin/grok', '/home/user');

	host.addDir('/opt/custom');
	host.env.GROK_BIN = '/opt/custom';
	const directory = discoverCli('grok', host);
	assert.equal(directory.status, 'invalid_override');
	assert.equal(executablePath(directory), null);
	assert.match(directory.reason, /directory/);
	assertSafeReason(directory.reason, '/opt/custom', '/usr/bin/grok');
});

test('injected fs: CURSOR_BIN wins over CURSOR_AGENT_BIN even when invalid', () => {
	const host = memoryHost({
		env: {
			HOME: '/home/user',
			PATH: '/usr/bin',
			CURSOR_BIN: '/bad/cursor',
			CURSOR_AGENT_BIN: '/usr/bin/cursor-agent',
		},
	});
	host.addFile('/usr/bin/cursor-agent');
	const result = discoverCli('cursor', host);
	assert.equal(result.status, 'invalid_override');
	assert.equal(result.overrideVar, 'CURSOR_BIN');
	assert.equal(executablePath(result), null);
	assertSafeReason(result.reason, '/usr/bin/cursor-agent', '/bad/cursor');

	delete host.env.CURSOR_BIN;
	const fallback = discoverCli('cursor', host);
	assert.equal(fallback.status, 'found');
	assert.equal(fallback.path, '/usr/bin/cursor-agent');
	assert.equal(fallback.overrideVar, 'CURSOR_AGENT_BIN');
});

test('injected fs: command-name override, relative paths, spaces, and ~/ home join', () => {
	const host = memoryHost({
		cwd: '/srv/scan',
		env: { HOME: '/home/user', PATH: '/usr/bin', GROK_BIN: 'grok' },
	});
	host.addFile('/usr/bin/grok');
	const named = discoverCli('grok', host);
	assert.equal(named.status, 'found');
	assert.equal(named.source, 'override');
	assert.equal(named.path, '/usr/bin/grok');

	host.env.GROK_BIN = './bin/grok';
	host.addFile('/srv/scan/bin/grok');
	const relative = discoverCli('grok', host);
	assert.equal(relative.path, '/srv/scan/bin/grok');

	host.env.GROK_BIN = '/opt/My Tools/grok cli';
	host.addFile('/opt/My Tools/grok cli');
	const spaced = discoverCli('grok', host);
	assert.equal(spaced.status, 'found');
	assert.equal(spaced.path, '/opt/My Tools/grok cli');
	assertSafeReason(spaced.reason, '/opt/My Tools/grok cli');

	host.env.GROK_BIN = '~/.grok/bin/grok';
	host.addFile('/home/user/.grok/bin/grok');
	const home = discoverCli('grok', host);
	assert.equal(home.path, '/home/user/.grok/bin/grok');

	host.env.GROK_BIN = 'grok --foo';
	const commandString = discoverCli('grok', host);
	assert.equal(commandString.status, 'invalid_override');
	assert.match(commandString.reason, /GROK_BIN/);
	assertSafeReason(commandString.reason, 'grok --foo');
});

test('injected fs: missing PATH/home skips known installs without a hard-coded user path', () => {
	const host = memoryHost({
		env: { PATH: '', HOME: undefined },
		homedir: () => null,
	});
	const grok = discoverCli('grok', host);
	assert.equal(grok.status, 'missing');
	assert.equal(executablePath(grok), null);
	assert.match(grok.reason, /GROK_BIN/);
	assertSafeReason(grok.reason);
	assert.equal(spawnSearchPath(host), '');
});

test('injected fs: PATH wins over known installs and bundled Codex helpers', () => {
	const host = memoryHost({
		platform: 'linux',
		arch: 'x64',
		env: { HOME: '/home/user', PATH: '/usr/bin' },
	});
	host.addFile('/usr/bin/codex');
	host.addFile('/home/user/.local/bin/codex');
	host.addFile('/home/user/.cursor/extensions/openai.chatgpt-new/bin/linux-x86_64/codex', { mtimeMs: 9 });
	const result = discoverCli('codex', host);
	assert.equal(result.source, 'path');
	assert.equal(result.path, '/usr/bin/codex');
});

test('injected fs: known Grok install and newest verified bundled Codex layout', () => {
	const host = memoryHost({
		platform: 'linux',
		arch: 'x64',
		env: { HOME: '/home/user', PATH: '/usr/bin' },
	});
	host.addFile('/home/user/.grok/bin/grok');
	const grok = discoverCli('grok', host);
	assert.equal(grok.source, 'known_install');
	assert.equal(grok.path, '/home/user/.grok/bin/grok');

	host.addFile('/home/user/.cursor/extensions/openai.chatgpt-old/bin/linux-x86_64/codex', { mtimeMs: 10 });
	host.addFile('/home/user/.cursor/extensions/openai.chatgpt-new/bin/linux-x86_64/codex', { mtimeMs: 50 });
	const bundled = discoverCli('codex', host);
	assert.equal(bundled.source, 'bundled_extension');
	assert.equal(bundled.path, '/home/user/.cursor/extensions/openai.chatgpt-new/bin/linux-x86_64/codex');
});

test('injected fs: unreadable extension dirs do not crash other providers', () => {
	const host = memoryHost({
		env: { HOME: '/home/user', PATH: '/usr/bin' },
	});
	host.addFile('/usr/bin/grok');
	host.addDir('/home/user/.cursor/extensions');
	host.forbid('/home/user/.cursor/extensions');
	assert.equal(discoverCli('grok', host).status, 'found');
	assert.equal(discoverCli('codex', host).status, 'missing');
	assert.match(discoverCli('codex', host).reason, /CODEX_BIN/);
});

test('injected fs: unsupported bundled layout is not invented; PATH can still win', () => {
	const host = memoryHost({
		platform: 'darwin',
		arch: 'arm64',
		env: { HOME: '/home/user', PATH: '' },
	});
	host.addFile('/home/user/.cursor/extensions/openai.chatgpt-x/bin/linux-x86_64/codex');
	host.addFile('/home/user/.cursor/extensions/openai.chatgpt-x/bin/darwin-arm64/codex');
	const missing = discoverCli('codex', host);
	assert.equal(missing.status, 'missing');
	assert.match(missing.reason, /linux x64|CODEX_BIN/i);
	assert.doesNotMatch(missing.reason, /darwin-arm64/);
	assertSafeReason(missing.reason, '/home/user');
});

test('injected fs: directories, non-executables and broken symlinks are rejected; valid symlinks work', () => {
	const host = memoryHost({ env: { HOME: '/home/user', PATH: '/opt/bin:/usr/bin' } });
	host.addDir('/opt/bin/grok');
	host.addFile('/usr/bin/grok', { mode: 0o644 });
	const blocked = discoverCli('grok', host);
	assert.equal(blocked.status, 'permission_failure');
	assert.equal(executablePath(blocked), null);
	assert.match(blocked.reason, /not executable/);
	assertSafeReason(blocked.reason, '/usr/bin/grok');

	host.addFile('/usr/bin/grok', { mode: 0o755 });
	host.addSymlink('/opt/bin/grok-link', '/usr/bin/grok');
	host.env.GROK_BIN = '/opt/bin/grok-link';
	const linked = discoverCli('grok', host);
	assert.equal(linked.status, 'found');
	assert.equal(linked.path, '/opt/bin/grok-link');

	host.addSymlink('/opt/bin/broken', '/no/such/grok');
	host.env.GROK_BIN = '/opt/bin/broken';
	const broken = discoverCli('grok', host);
	assert.equal(broken.status, 'invalid_override');
	assert.match(broken.reason, /broken symbolic link/);
});

test('injected fs: generic agent binaries are not selected as Cursor', () => {
	const host = memoryHost({ env: { HOME: '/home/user', PATH: '/usr/bin:/home/user/.grok/bin' } });
	host.addFile('/usr/bin/agent');
	host.addFile('/home/user/.grok/bin/agent');
	host.addFile('/usr/bin/cursor');
	const cursor = discoverCli('cursor', host);
	assert.equal(cursor.status, 'missing');
	assert.equal(executablePath(cursor), null);
	assert.match(cursor.reason, /cursor-agent/);
	assert.match(cursor.reason, /CURSOR_BIN/);
	assert.match(cursor.reason, /agent are not selected/);
	assertSafeReason(cursor.reason, '/usr/bin/agent', '/home/user/.grok/bin/agent');

	host.addFile('/usr/bin/cursor-agent');
	const named = discoverCli('cursor', host);
	assert.equal(named.path, '/usr/bin/cursor-agent');
	assert.equal(named.source, 'path');
});

test('injected fs: saved setting is after env and does not fall through when invalid', () => {
	const host = memoryHost({
		env: { HOME: '/home/user', PATH: '/usr/bin' },
	});
	host.savedTools = { grok: '/opt/My Tools/grok cli' };
	host.addFile('/usr/bin/grok');
	host.addFile('/opt/My Tools/grok cli');
	const saved = discoverCli('grok', host);
	assert.equal(saved.status, 'found');
	assert.equal(saved.source, 'saved_setting');
	assert.equal(saved.path, '/opt/My Tools/grok cli');

	host.env.GROK_BIN = '/opt/custom/grok';
	host.addFile('/opt/custom/grok');
	const envWins = discoverCli('grok', host);
	assert.equal(envWins.source, 'override');
	assert.equal(envWins.path, '/opt/custom/grok');

	host.env.GROK_BIN = '/missing/env-grok';
	const badEnv = discoverCli('grok', host);
	assert.equal(badEnv.status, 'invalid_override');
	assert.equal(badEnv.source, 'override');
	assert.equal(executablePath(badEnv), null);
	assertSafeReason(badEnv.reason, '/opt/My Tools/grok cli', '/usr/bin/grok');

	delete host.env.GROK_BIN;
	host.savedTools = { grok: '/missing/saved-grok' };
	const badSaved = discoverCli('grok', host);
	assert.equal(badSaved.status, 'invalid_override');
	assert.equal(badSaved.source, 'saved_setting');
	assert.equal(executablePath(badSaved), null);
	assert.match(badSaved.reason, /saved Grok location/i);
	assertSafeReason(badSaved.reason, '/missing/saved-grok', '/usr/bin/grok');

	host.savedTools = {};
	const restored = discoverCli('grok', host);
	assert.equal(restored.source, 'path');
	assert.equal(restored.path, '/usr/bin/grok');
});

test('simulated win32 (not a native Windows run): PATH delimiter and executable suffixes', () => {
	const host = memoryHost({
		platform: 'win32',
		path: win32,
		cwd: 'C:\\app',
		env: {
			USERPROFILE: 'C:\\Users\\me',
			PATH: 'C:\\Windows\\System32;C:\\Tools',
			HOME: undefined,
		},
		homedir: () => 'C:\\Users\\me',
	});
	host.addDir('C:\\Users\\me');
	const spawnPath = spawnSearchPath(host);
	assert.match(spawnPath, /;/);
	assert.ok(spawnPath.startsWith('C:\\Users\\me\\.local\\bin;'));
	assert.match(spawnPath, /C:\\Windows\\System32/);
	assert.equal(spawnPath.includes('C:\\Windows\\System32:C:\\Tools'), false);

	host.addFile('C:\\Tools\\grok.cmd');
	const shim = discoverCli('grok', host);
	assert.equal(shim.status, 'unsupported_launch_target');
	assert.match(shim.reason, /\.cmd|\.bat|shell/);
	assert.equal(executablePath(shim), null);
	assertSafeReason(shim.reason, 'C:\\Tools\\grok.cmd');

	host.addFile('C:\\Tools\\grok.exe');
	const exe = discoverCli('grok', host);
	assert.equal(exe.status, 'found');
	assert.equal(exe.path, 'C:\\Tools\\grok.exe');

	host.env.GROK_BIN = 'C:\\Tools\\grok.cmd';
	const overrideShim = discoverCli('grok', host);
	assert.equal(overrideShim.status, 'unsupported_launch_target');
	assert.match(overrideShim.reason, /GROK_BIN/);
	assert.equal(executablePath(overrideShim), null);
});

test('simulated portability requires an injected path API; process.platform is not enough', () => {
	const host = memoryHost({
		platform: 'win32',
		path: posix,
		env: { HOME: '/home/user', PATH: '/bin:/usr/bin' },
	});
	assert.equal(host.path.delimiter, ':');
	assert.match(spawnSearchPath(host), /:/);
	assert.equal(posix.delimiter, ':');
	assert.equal(win32.delimiter, ';');
});

test('wrappers and readiness share the resolver (linux host, isolated env, real temp files)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'scan-cli-disc-wrap-'));
	const keys = ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'PATH', 'GROK_BIN', 'CODEX_BIN', 'CURSOR_BIN', 'CURSOR_AGENT_BIN', 'SCAN_DATA_DIR'] as const;
	const saved = new Map(keys.map((key) => [key, process.env[key]]));
	try {
		const grok = join(root, 'grok');
		await writeFile(grok, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
		await chmod(grok, 0o755);
		process.env.HOME = root;
		process.env.PATH = root;
		process.env.SCAN_DATA_DIR = join(root, 'data');
		delete process.env.USERPROFILE;
		delete process.env.GROK_BIN;
		delete process.env.CODEX_BIN;
		delete process.env.CURSOR_BIN;
		delete process.env.CURSOR_AGENT_BIN;
		const { grokBin, cursorBin, listTranslateEngines } = await import('../src/lib/server/cliTranslate');
		const discovered = discoverCli('grok');
		assert.equal(discovered.status, 'found');
		assert.equal(grokBin(), discovered.path);
		assert.equal(cliReadiness('grok').available, true);
		assert.equal(cliReadiness('grok').reason, discovered.reason);
		assert.equal(listTranslateEngines().find((engine) => engine.id === 'grok')?.available, true);
		assert.equal(listTranslateEngines().find((engine) => engine.id === 'grok')?.reason, discovered.reason);

		const dirOverride = join(root, 'not-a-bin');
		await mkdir(dirOverride);
		process.env.GROK_BIN = dirOverride;
		const invalid = discoverCli('grok');
		assert.equal(invalid.status, 'invalid_override');
		assert.equal(grokBin(), null);
		assert.equal(cliReadiness('grok').available, false);
		assert.equal(cliReadiness('grok').reason, invalid.reason);
		assert.equal(listTranslateEngines().find((engine) => engine.id === 'grok')?.available, false);
		assert.equal(listTranslateEngines().find((engine) => engine.id === 'grok')?.reason, invalid.reason);
		assertSafeReason(invalid.reason, dirOverride, grok, root);

		const agent = join(root, 'agent');
		await writeFile(agent, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
		await chmod(agent, 0o755);
		assert.equal(cursorBin(), null);
		assert.match(discoverCli('cursor').reason, /CURSOR_BIN/);
	} finally {
		for (const key of keys) {
			const value = saved.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	}
});

test('linux host: real files reject directories/non-executables/broken links and accept symlinks and spaces', async () => {
	assert.equal(process.platform, 'linux');
	const root = await mkdtemp(join(tmpdir(), 'scan-cli-disc-linux-'));
	try {
		const spacedDir = join(root, 'My Tools');
		await mkdir(spacedDir);
		const grok = join(spacedDir, 'grok bin');
		await writeFile(grok, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
		await chmod(grok, 0o755);
		const linked = join(root, 'grok-link');
		await symlink(grok, linked);
		const broken = join(root, 'broken');
		await symlink(join(root, 'missing'), broken);
		const folder = join(root, 'folder');
		await mkdir(folder);
		const locked = join(root, 'locked');
		await writeFile(locked, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
		await chmod(locked, 0o644);

		const host: DiscoveryHost = {
			...nodeDiscoveryHost(),
			cwd: root,
			env: { HOME: root, PATH: '' },
			homedir: () => root,
			savedTools: {},
		};

		host.env.GROK_BIN = grok;
		assert.equal(discoverCli('grok', host).path, grok);
		host.env.GROK_BIN = linked;
		assert.equal(discoverCli('grok', host).status, 'found');
		assert.equal((await lstat(linked)).isSymbolicLink(), true);
		host.env.GROK_BIN = broken;
		assert.equal(discoverCli('grok', host).status, 'invalid_override');
		host.env.GROK_BIN = folder;
		assert.equal(discoverCli('grok', host).status, 'invalid_override');
		host.env.GROK_BIN = locked;
		assert.equal(discoverCli('grok', host).status, 'permission_failure');
		assertSafeReason(discoverCli('grok', host).reason, locked, root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('linux host: PATH is searched before a bundled linux-x86_64 Codex helper', async () => {
	assert.equal(process.platform, 'linux');
	const root = await mkdtemp(join(tmpdir(), 'scan-cli-disc-bundle-'));
	try {
		const pathCodex = join(root, 'on-path', 'codex');
		await mkdir(join(root, 'on-path'));
		await writeFile(pathCodex, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
		await chmod(pathCodex, 0o755);
		const bundled = join(root, '.cursor', 'extensions', 'openai.chatgpt-z', 'bin', 'linux-x86_64', 'codex');
		await mkdir(join(root, '.cursor', 'extensions', 'openai.chatgpt-z', 'bin', 'linux-x86_64'), { recursive: true });
		await writeFile(bundled, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
		await chmod(bundled, 0o755);
		await utimes(bundled, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
		const host: DiscoveryHost = {
			...nodeDiscoveryHost(),
			cwd: root,
			platform: 'linux',
			arch: 'x64',
			env: { HOME: root, PATH: join(root, 'on-path') },
			homedir: () => root,
			savedTools: {},
		};
		const result = discoverCli('codex', host);
		assert.equal(result.source, 'path');
		assert.equal(result.path, pathCodex);
		host.env.PATH = join(root, 'empty');
		await mkdir(join(root, 'empty'));
		const fallback = discoverCli('codex', host);
		assert.equal(fallback.source, 'bundled_extension');
		assert.equal(fallback.path, bundled);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
