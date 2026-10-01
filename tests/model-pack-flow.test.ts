import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { CHAT_AND_CLI_OPERATIONS } from '../src/lib/modelRegistry';
import {
	MODEL_PACK_KIND,
	MODEL_PACK_VERSION,
	type ModelPack,
} from '../src/lib/modelPack';
import { applyProfileSelections } from '../src/lib/modelProfiles';
import { QWEN_38_27B_ID } from '../src/lib/qwenModels';
import { regionAiSettings } from '../src/lib/regionAi';
import { ROLES } from '../src/lib/types';

const root = await mkdtemp(join(tmpdir(), 'scan-pack-flow-'));
const dataDir = join(root, 'data');
await mkdir(dataDir, { recursive: true });

function stripHostEnv() {
	const drop = [
		'LLAMASWAP_URL',
		'LLAMASWAP_API_KEY',
		'SCAN_GPU_MODE',
		'GROK_BIN',
		'CODEX_BIN',
		'CURSOR_BIN',
		'OPENAI_API_KEY',
		'STUDIO_OPENAI_KEY',
		'DATABASE_URL',
		'SCAN_ROOT',
		'SCAN_DATA_DIR',
	];
	for (const key of drop) delete process.env[key];
}

stripHostEnv();
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = dataDir;
process.env.DATABASE_URL = join(dataDir, 'test.db');
process.env.HOME = join(root, 'home');
process.env.PATH = '/usr/bin:/bin';

const TRANSLATE_JSON = JSON.stringify({
	items: [{ i: 0, literal: 'テスト', translation: 'Wait!', reasoning: 'pack-flow' }],
});

const fakeHttp = createServer(async (req, res) => {
	res.setHeader('content-type', 'application/json');
	if (req.method === 'GET' && (req.url === '/v1/models' || req.url === '/models')) {
		res.end(JSON.stringify({ data: [{ id: 'gpt-4o-flow' }] }));
		return;
	}
	if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/chat/completions')) {
		res.end(JSON.stringify({ choices: [{ message: { content: TRANSLATE_JSON } }] }));
		return;
	}
	res.statusCode = 404;
	res.end(JSON.stringify({ error: 'not found' }));
});
await new Promise<void>((resolve) => fakeHttp.listen(0, '127.0.0.1', resolve));
const fakePort = (fakeHttp.address() as { port: number }).port;
const fakeBase = `http://127.0.0.1:${fakePort}/v1`;

const {
	applyImportedPack,
	exportModelPack,
	previewImportedPack,
} = await import('../src/lib/server/modelPackStore');
const {
	createLocalHttpRow,
	invalidateRegistryCache,
	listRegistryRows,
	updateRegistryRow,
	writeModelOverlay,
} = await import('../src/lib/server/modelRegistryStore');

/** The chat model ships as a launch preset: add the row an operator adds in
 * Setup → Local models so the pack profile's chat refs resolve on this install. */
function addChatRow() {
	createLocalHttpRow({ name: 'Qwen 3.8 27B', slug: 'qwen3.8-27b-q4' });
}
const { readModelProfiles, writeModelProfiles } = await import('../src/lib/server/modelProfileStore');
const { packJournalPath, writePackJournal } = await import('../src/lib/server/modelPackJournal');
const { probeModelRow } = await import('../src/lib/server/modelProbe');
const { invalidateEnvFileCache } = await import('../src/lib/server/envFile');
const { requireManageUsers, requireUser } = await import('../src/lib/server/http');

after(async () => {
	await new Promise<void>((resolve, reject) => fakeHttp.close((err) => (err ? reject(err) : resolve())));
	await rm(root, { recursive: true, force: true });
});

const remoteModel = {
	id: 'studio-gpt4o',
	name: 'Studio GPT-4o',
	slug: 'gpt-4o-flow',
	access: 'remote_http' as const,
	runtime: 'openai' as const,
	operations: [...CHAT_AND_CLI_OPERATIONS],
	roles: [...ROLES],
	http: { baseUrl: 'https://api.example.com/v1', apiKeyEnv: 'STUDIO_OPENAI_KEY' },
};

const studioProfile = {
	id: 'profile-studio',
	name: 'Studio remote',
	selections: {
		translate: { engine: 'studio-gpt4o', model: '' },
		proofread: { engine: QWEN_38_27B_ID, model: '' },
		reviewers: [{ engine: 'studio-gpt4o', model: '' }],
		transcriptionModels: [QWEN_38_27B_ID],
	},
};

function flowPack(): ModelPack {
	return {
		kind: MODEL_PACK_KIND,
		version: MODEL_PACK_VERSION,
		exportedAt: '2026-09-15T00:00:00.000Z',
		models: [remoteModel],
		profiles: [studioProfile],
	};
}

function snapshotFiles() {
	return Promise.all([
		readFile(join(dataDir, 'models.json'), 'utf8').catch(() => ''),
		readFile(join(dataDir, 'model-profiles.json'), 'utf8').catch(() => ''),
		readFile(packJournalPath(), 'utf8').catch(() => ''),
	]);
}

describe('model pack import to task', { concurrency: 1 }, () => {
	test('import pack, set missing env, apply profile, run translate', async () => {
		writeModelOverlay({ rows: [], catalogs: [] });
		writeModelProfiles([]);
		invalidateRegistryCache();
		addChatRow();
		delete process.env.STUDIO_OPENAI_KEY;
		invalidateEnvFileCache();

		const pack = flowPack();
		const preview = previewImportedPack(pack);
		assert.ok(preview.add.some((item) => item.id === 'studio-gpt4o'));
		assert.ok(preview.missing.some((item) => item.kind === 'env' && item.ref === 'STUDIO_OPENAI_KEY'));
		assert.equal(preview.conflicts.length, 0);

		process.env.STUDIO_OPENAI_KEY = 'fixture-flow-key';
		invalidateEnvFileCache();
		const applied = applyImportedPack(pack);
		assert.deepEqual(applied.addedModels, ['studio-gpt4o']);
		assert.deepEqual(applied.addedProfiles, ['profile-studio']);
		assert.equal(existsSync(packJournalPath()), false);

		updateRegistryRow('studio-gpt4o', {
			http: { baseUrl: fakeBase, apiKeyEnv: 'STUDIO_OPENAI_KEY' },
		});

		const profile = readModelProfiles().find((item) => item.id === 'profile-studio');
		assert.ok(profile);
		const before = regionAiSettings({
			translate: { engine: 'composer-2.5', model: '' },
			describe: { engine: QWEN_38_27B_ID, model: '' },
			vision: { engine: QWEN_38_27B_ID, model: '' },
			proofread: { engine: 'composer-2.5', model: '' },
			enquire: { engine: 'composer-2.5', model: '' },
			reviewers: [{ engine: 'composer-2.5', model: '' }],
			transcriptionModels: [QWEN_38_27B_ID],
		});
		const used = applyProfileSelections(before, profile.selections, listRegistryRows());
		assert.equal(used.ok, true);
		assert.equal(used.settings.translate.engine, 'studio-gpt4o');
		assert.deepEqual(used.settings.describe, before.describe);

		const row = listRegistryRows().find((item) => item.id === 'studio-gpt4o');
		assert.ok(row);
		const sample = await probeModelRow(row, 'translate');
		assert.equal(sample.ok, true, sample.reason);
		assert.match(sample.outputPreview || '', /Wait!/);
	});

	test('failed profile write restores overlay and leaves no journal', async () => {
		writeModelOverlay({ rows: [], catalogs: [] });
		writeModelProfiles([]);
		invalidateRegistryCache();
		addChatRow();
		const before = await snapshotFiles();
		assert.throws(
			() =>
				applyImportedPack(flowPack(), undefined, {
					afterOverlayWrite: () => {
						throw new Error('disk full');
					},
				}),
			/disk full/,
		);
		assert.deepEqual(await snapshotFiles(), before);
		assert.equal(listRegistryRows().some((row) => row.id === 'studio-gpt4o'), false);
		assert.deepEqual(readModelProfiles(), []);
		assert.equal(existsSync(packJournalPath()), false);
	});

	test('interrupted apply completes from the journal after restart', async () => {
		writeModelOverlay({ rows: [], catalogs: [] });
		writeModelProfiles([]);
		invalidateRegistryCache();
		const overlayAfter = {
			rows: [
				{
					...remoteModel,
					seeded: false,
					operationsLocked: false,
				},
			],
			catalogs: [],
		};
		const profilesAfter = [{ ...studioProfile, updatedAt: 1 }];
		writePackJournal({ overlay: overlayAfter, profiles: profilesAfter });
		writeModelOverlay(overlayAfter);
		const profilesOnDisk = await readFile(join(dataDir, 'model-profiles.json'), 'utf8');
		assert.equal(profilesOnDisk.includes('profile-studio'), false);
		assert.equal(existsSync(packJournalPath()), true);
		invalidateRegistryCache();

		const rows = listRegistryRows();
		assert.ok(rows.some((row) => row.id === 'studio-gpt4o'));
		assert.equal(readModelProfiles()[0]?.id, 'profile-studio');
		assert.equal(existsSync(packJournalPath()), false);

		const roundTrip = exportModelPack();
		assert.ok(roundTrip.models.some((item) => item.id === 'studio-gpt4o'));
		assert.ok(roundTrip.profiles.some((item) => item.id === 'profile-studio'));
	});
});

describe('admin-only setup, executables, and model pack', () => {
	test('anonymous and non-admin users cannot manage these surfaces', async () => {
		assert.throws(() => requireUser(null), /Unauthorized/);
		for (const role of ['scanlator', 'translator', 'proofreader', 'typesetter'] as const) {
			assert.throws(
				() => requireManageUsers({ id: 'u1', username: 'pat', role }),
				/Forbidden/,
			);
		}
		requireManageUsers({ id: 'a1', username: 'root', role: 'admin' });

		const files = [
			new URL('../src/routes/api/admin/setup/+server.ts', import.meta.url),
			new URL('../src/routes/api/admin/cli-tools/+server.ts', import.meta.url),
			new URL('../src/routes/api/admin/models/+server.ts', import.meta.url),
			new URL('../src/routes/api/admin/managed-models/+server.ts', import.meta.url),
			new URL('../src/routes/api/admin/review-models/+server.ts', import.meta.url),
			new URL('../src/routes/api/admin/model-benchmark/+server.ts', import.meta.url),
			new URL('../src/routes/api/admin/model-pack/+server.ts', import.meta.url),
			new URL('../src/routes/api/rebuild/+server.ts', import.meta.url),
			// Setup and Settings now live under /admin/models, guarded by its layout.
			new URL('../src/routes/admin/models/+layout.server.ts', import.meta.url),
		];
		for (const file of files) {
			const src = await readFile(file, 'utf8');
			assert.match(
				src,
				/requireManageUsers\(requireUser\(locals\.user\)\)|canManageUsers\(locals\.user\)/,
				file.pathname,
			);
		}
		assert.match(
			await readFile(new URL('../src/routes/+layout.svelte', import.meta.url), 'utf8'),
			/data\.user\.role === 'admin'[\s\S]*<RebuildButton/,
		);
		assert.match(
			await readFile(new URL('../src/lib/components/workflow/StudioDocbar.svelte', import.meta.url), 'utf8'),
			/\{#if canRebuild\}[\s\S]*<RebuildButton/,
		);
		assert.match(
			await readFile(new URL('../src/routes/series/[id]/episodes/[eid]/+page.server.ts', import.meta.url), 'utf8'),
			/canRebuild:\s*canManageUsers\(user\)/,
		);
	});
});
