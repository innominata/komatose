import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import posix from 'node:path/posix';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { refreshCliToolDrafts } from '../src/lib/cliToolDrafts';

const root = await mkdtemp(join(tmpdir(), 'scan-cli-tools-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.DATABASE_URL = join(root, 'data', 'test.db');
await mkdir(join(root, 'data'), { recursive: true });

const {
	CliToolsConfigError,
	clearCliToolSetting,
	cliToolsPath,
	readCliToolSettings,
	setCliToolSetting,
	writeCliToolSettings,
} = await import('../src/lib/server/cliToolSettings');
const {
	CLI_FOUND_REASON,
	cliReadiness,
	discoverCli,
	executablePath,
	grokExecutable,
} = await import('../src/lib/server/cliDiscovery');
type DiscoveryFs = import('../src/lib/server/cliDiscovery').DiscoveryFs;
type DiscoveryHost = import('../src/lib/server/cliDiscovery').DiscoveryHost;
type StatInfo = import('../src/lib/server/cliDiscovery').StatInfo;
const { applyCliToolAdminAction, listCliToolAdminStatus, publicConfigSource } = await import(
	'../src/lib/server/cliToolStatus'
);
const { requireManageUsers, requireUser } = await import('../src/lib/server/http');
const { createGrokAdapter } = await import('../src/lib/server/cliAdapters/grok');
const { CliAdapterRegistry } = await import('../src/lib/server/cliAdapters/registry');

type Entry =
	| { kind: 'file'; mode: number; mtimeMs: number }
	| { kind: 'directory'; mode: number; mtimeMs: number }
	| { kind: 'symlink'; target: string; mode: number; mtimeMs: number };

function memoryHost(opts: {
	env?: Record<string, string | undefined>;
	cwd?: string;
	savedTools?: Record<string, string>;
	omitSavedTools?: boolean;
} = {}): DiscoveryHost & { addFile(path: string): void } {
	const pathApi = posix;
	const files = new Map<string, Entry>();
	const dirs = new Set<string>();
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
	const host: DiscoveryHost & { addFile(path: string): void } = {
		cwd: opts.cwd ?? '/app',
		platform: 'linux',
		arch: 'x64',
		env: { PATH: '', HOME: '/home/user', ...opts.env },
		path: pathApi,
		homedir: () => null,
		fs: {
			lstat(p) {
				const hit = lookup(p);
				if (!hit.ok) return hit;
				return { ok: true, value: toStat(hit.value) };
			},
			stat(p) {
				const hit = lookup(p);
				if (!hit.ok) return hit;
				return { ok: true, value: toStat(hit.value) };
			},
			readdir: () => ({ ok: false, error: 'missing' }),
			canExecute(p) {
				const resolved = host.fs.stat(p);
				return resolved.ok && resolved.value.kind === 'file' && (resolved.value.mode & 0o111) !== 0;
			},
		} satisfies DiscoveryFs,
		addFile(p) {
			const key = norm(p);
			ensureParents(key);
			files.set(key, { kind: 'file', mode: 0o755, mtimeMs: 1 });
		},
	};
	if (!opts.omitSavedTools) host.savedTools = opts.savedTools || {};
	return host;
}

function resetSettings() {
	writeCliToolSettings({});
}

function assertSafe(payload: unknown, ...secrets: (string | undefined)[]) {
	const text = JSON.stringify(payload);
	assert.equal('path' in (payload as object) && typeof (payload as { path?: unknown }).path === 'string', false);
	assert.doesNotMatch(text, /\/home\/inno\b/);
	for (const secret of secrets) {
		if (secret && secret.includes('/')) assert.equal(text.includes(secret), false, text);
	}
}

describe('cli tool settings', { concurrency: 1 }, () => {
test('missing settings file keeps automatic discovery', () => {
	if (existsSync(cliToolsPath())) unlinkSync(cliToolsPath());
	assert.deepEqual(readCliToolSettings(), {});
	const host = memoryHost({ env: { PATH: '/usr/bin' } });
	host.addFile('/usr/bin/grok');
	const result = discoverCli('grok', host);
	assert.equal(result.source, 'path');
	assert.equal(result.path, '/usr/bin/grok');
});

test('saved paths and command names resolve, including spaces; env beats saved', () => {
	const host = memoryHost({
		env: { PATH: '/usr/bin', HOME: '/home/user' },
		savedTools: { grok: '/opt/My Tools/grok cli', codex: 'codex' },
	});
	host.addFile('/opt/My Tools/grok cli');
	host.addFile('/usr/bin/codex');
	host.addFile('/usr/bin/grok');
	assert.equal(discoverCli('grok', host).path, '/opt/My Tools/grok cli');
	assert.equal(discoverCli('grok', host).source, 'saved_setting');
	assert.equal(discoverCli('codex', host).path, '/usr/bin/codex');
	assert.equal(discoverCli('codex', host).source, 'saved_setting');

	host.env.GROK_BIN = '/opt/env/grok';
	host.addFile('/opt/env/grok');
	assert.equal(discoverCli('grok', host).source, 'override');
	assert.equal(discoverCli('grok', host).path, '/opt/env/grok');

	host.env.GROK_BIN = '/missing/env';
	const invalidEnv = discoverCli('grok', host);
	assert.equal(invalidEnv.status, 'invalid_override');
	assert.equal(executablePath(invalidEnv), null);
	assert.notEqual(invalidEnv.path, '/opt/My Tools/grok cli');
});

test('invalid saved path fails without selecting another installed agent; clear restores automatic', async () => {
	resetSettings();
	const host = memoryHost({ env: { PATH: '/usr/bin' }, omitSavedTools: true });
	host.addFile('/usr/bin/grok');
	setCliToolSetting('grok', '/missing/saved-grok');
	const blocked = discoverCli('grok', host);
	assert.equal(blocked.status, 'invalid_override');
	assert.equal(blocked.source, 'saved_setting');
	assert.equal(executablePath(blocked), null);
	assert.match(blocked.reason, /saved Grok location/i);
	assertSafe(listCliToolAdminStatus(host).find((tool) => tool.id === 'grok'), '/usr/bin/grok');

	clearCliToolSetting('grok');
	const restored = discoverCli('grok', host);
	assert.equal(restored.source, 'path');
	assert.equal(restored.path, '/usr/bin/grok');
	assert.deepEqual(readCliToolSettings(), {});
});

test('updating one tool preserves others; malformed config is explicit', async () => {
	resetSettings();
	setCliToolSetting('grok', '/opt/grok');
	setCliToolSetting('codex', 'codex');
	setCliToolSetting('grok', '/opt/grok-v2');
	assert.deepEqual(readCliToolSettings(), { grok: '/opt/grok-v2', codex: 'codex' });
	clearCliToolSetting('grok');
	assert.deepEqual(readCliToolSettings(), { codex: 'codex' });
	clearCliToolSetting('codex');

	await writeFile(cliToolsPath(), '[]\n');
	assert.throws(() => readCliToolSettings(), CliToolsConfigError);
	const host = memoryHost({ env: { PATH: '/usr/bin' }, omitSavedTools: true });
	host.addFile('/usr/bin/grok');
	const malformed = discoverCli('grok', host);
	assert.equal(malformed.status, 'invalid_override');
	assert.equal(malformed.source, 'saved_setting');
	assert.equal(executablePath(malformed), null);
	assert.match(malformed.reason, /JSON object|valid JSON/);

	await writeFile(cliToolsPath(), '{ "grok": 12 }\n');
	assert.throws(() => readCliToolSettings(), /single executable path/);
	await writeFile(cliToolsPath(), '{ "grok": "/opt/grok", "claude": "/opt/claude" }\n');
	assert.throws(() => readCliToolSettings(), /unknown tool id "claude"/);
	assert.throws(() => setCliToolSetting('grok', 12), /single executable path/);
	assert.throws(
		() => applyCliToolAdminAction('save', { id: 'grok', executable: 12 }),
		/single executable path/,
	);
	writeCliToolSettings({});
});

test('check and single-agent save preserve other unsaved drafts', () => {
	const tools = [
		{ id: 'grok', saved: '/opt/grok' },
		{ id: 'codex', saved: 'codex' },
		{ id: 'cursor', saved: null },
	];
	const drafts = { grok: '/opt/grok', codex: '/tmp/unsaved-codex', cursor: '/tmp/unsaved-cursor' };
	assert.deepEqual(refreshCliToolDrafts(drafts, tools, []), drafts);
	assert.deepEqual(refreshCliToolDrafts(drafts, [
		{ id: 'grok', saved: '/opt/grok-v2' },
		{ id: 'codex', saved: 'codex' },
		{ id: 'cursor', saved: null },
	], ['grok']), {
		grok: '/opt/grok-v2',
		codex: '/tmp/unsaved-codex',
		cursor: '/tmp/unsaved-cursor',
	});
});

test('admin save/clear/check and public status hide resolved paths', async () => {
	resetSettings();
	const binDir = join(root, 'bins');
	await mkdir(binDir, { recursive: true });
	const grok = join(binDir, 'grok bin');
	await writeFile(grok, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
	await chmod(grok, 0o755);

	const tools = applyCliToolAdminAction('save', { id: 'grok', executable: grok });
	const row = tools.find((tool) => tool.id === 'grok')!;
	assert.equal(row.saved, grok);
	assert.equal(row.found, true);
	assert.equal(row.source, 'saved_setting');
	assert.equal(row.message, CLI_FOUND_REASON);
	assertSafe(row);
	assert.equal(JSON.stringify(tools).includes('"path"'), false);

	const checked = applyCliToolAdminAction('check', { id: 'grok' });
	assert.equal(checked.find((tool) => tool.id === 'grok')?.found, true);
	assert.equal(grokExecutable(), grok);
	assert.equal(cliReadiness('grok').available, true);

	const cleared = applyCliToolAdminAction('clear', { id: 'grok' });
	assert.equal(cleared.find((tool) => tool.id === 'grok')?.saved, null);
	assert.notEqual(grokExecutable(), grok);
});

test('non-admin access is rejected; check does not import spawn or billed Test', async () => {
	assert.throws(() => requireUser(null), /Unauthorized/);
	assert.throws(
		() => requireManageUsers({ id: 'u1', username: 'pat', role: 'translator' }),
		/Forbidden/,
	);
	requireManageUsers({ id: 'a1', username: 'root', role: 'admin' });

	const route = await readFile(new URL('../src/routes/api/admin/cli-tools/+server.ts', import.meta.url), 'utf8');
	assert.doesNotMatch(route, /cliTranslate|modelProbe|modelCatalogs|spawn|execFile/);
	const settings = await readFile(new URL('../src/lib/server/cliToolSettings.ts', import.meta.url), 'utf8');
	assert.doesNotMatch(settings, /spawn|execFile|execSync|fork/);
});

test('adapter resolution uses the saved executable from the same discovery path', () => {
	const host = memoryHost({
		env: { PATH: '/usr/bin' },
		savedTools: { grok: '/opt/saved/grok' },
	});
	host.addFile('/usr/bin/grok');
	host.addFile('/opt/saved/grok');
	const adapter = createGrokAdapter({
		executable: () => grokExecutable(host),
		defaultModel: () => 'grok-4.6',
		listModels: async () => [],
	}, {
		parse: JSON.parse,
		async run() {
			throw new Error('check must not execute the CLI');
		},
		headlessArgs: () => [],
		imagePromptArgs: async () => [],
	});
	assert.equal(adapter.executable(), '/opt/saved/grok');
	const registry = new CliAdapterRegistry([adapter]);
	assert.equal(registry.get('grok').executable(), '/opt/saved/grok');
	assert.equal(publicConfigSource(discoverCli('grok', host).source), 'saved_setting');
});

});

after(async () => {
	await rm(root, { recursive: true, force: true });
});
