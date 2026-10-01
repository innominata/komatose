import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { QWEN_38_27B_ID } from '../src/lib/qwenModels';

const root = await mkdtemp(join(tmpdir(), 'scan-fresh-'));
const dataDir = join(root, 'data');
const homeDir = join(root, 'home');
const binDir = join(root, 'bin');
await mkdir(dataDir, { recursive: true });
await mkdir(homeDir, { recursive: true });
await mkdir(binDir, { recursive: true });

const HOST_LEAK = /\/home\/inno\b|\/www\/scan\/data\b|SCAN_GPU_MODE=komatose/;

function stripHostEnv() {
	const drop = [
		'LLAMASWAP_URL',
		'LLAMASWAP_API_KEY',
		'LLAMASWAP_MODEL',
		'SCAN_GPU_MODE',
		'GROK_BIN',
		'CODEX_BIN',
		'CURSOR_BIN',
		'CURSOR_AGENT_BIN',
		'OPENAI_API_KEY',
		'DEEPSEEK_API_KEY',
		'SCAN_PROOFREAD_SERVICE_URL',
		'SCAN_PROOFREAD_SERVICE_TOKEN',
		'SCAN_REVIEW_MODELS_DIR',
		'SCAN_REVIEW_PYTHON',
		'SCAN_REVIEW_LLAMA_SERVER',
		'SCAN_TRANSLATION_MODELS_DIR',
		'SCAN_TRANSLATION_PYTHON',
		'SCAN_TRANSLATION_LLAMA_SERVER',
		'SCAN_WORKFLOW_PYTHON',
		'PADDLEOCR_PYTHON',
		'DATABASE_URL',
		'SCAN_ROOT',
		'SCAN_DATA_DIR',
	];
	for (const key of drop) delete process.env[key];
}

stripHostEnv();
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = dataDir;
process.env.DATABASE_URL = join(dataDir, 'scan.db');
process.env.HOME = homeDir;
process.env.PATH = `/usr/bin:/bin`;
process.env.LLAMASWAP_URL = 'http://127.0.0.1:1/v1';

const TRANSLATE_JSON = JSON.stringify({
	items: [{ i: 0, literal: 'テスト', translation: 'Wait!', reasoning: 'isolated-smoke' }],
});

const hits = { models: 0, localChat: 0, remoteChat: 0 };

const fakeHttp = createServer(async (req, res) => {
	res.setHeader('content-type', 'application/json');
	if (req.method === 'GET' && (req.url === '/v1/models' || req.url === '/models')) {
		hits.models += 1;
		res.end(JSON.stringify({ data: [{ id: QWEN_38_27B_ID }, { id: 'gpt-4o-smoke' }] }));
		return;
	}
	if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/chat/completions')) {
		let body = '';
		for await (const chunk of req) body += chunk;
		const payload = JSON.parse(body || '{}') as {
			chat_template_kwargs?: unknown;
			model?: string;
		};
		if (payload.chat_template_kwargs) hits.localChat += 1;
		else hits.remoteChat += 1;
		res.end(JSON.stringify({ choices: [{ message: { content: TRANSLATE_JSON } }] }));
		return;
	}
	res.statusCode = 404;
	res.end(JSON.stringify({ error: 'not found' }));
});
await new Promise<void>((resolve) => fakeHttp.listen(0, '127.0.0.1', resolve));
const fakePort = (fakeHttp.address() as { port: number }).port;
const fakeBase = `http://127.0.0.1:${fakePort}/v1`;

const fakeCliSource = `#!${process.execPath}
const fs = require('node:fs');
const payload = ${JSON.stringify(TRANSLATE_JSON)};
const argv = process.argv.slice(1);
const dashO = argv.indexOf('-o');
if (dashO >= 0 && argv[dashO + 1]) fs.writeFileSync(argv[dashO + 1], payload);
if (argv.includes('--output-format') && argv.includes('json')) {
  process.stdout.write(JSON.stringify({ type: 'result', result: payload }) + '\\n');
} else {
  process.stdout.write(payload + '\\n');
}
`;

for (const name of ['grok', 'codex', 'cursor-agent']) {
	const path = join(binDir, name);
	await writeFile(path, fakeCliSource, { mode: 0o755 });
	await chmod(path, 0o755);
}

const { userCount, createUser } = await import('../src/lib/server/auth');
const { loadSetupReport } = await import('../src/lib/server/setupLive');
const { listCliToolAdminStatus } = await import('../src/lib/server/cliToolStatus');
const { setCliToolSetting, cliToolsPath } = await import('../src/lib/server/cliToolSettings');
const { createRemoteHttpRow, createLocalHttpRow, updateRegistryRow, addCliSlug, listRegistryRows, invalidateRegistryCache } = await import(
	'../src/lib/server/modelRegistryStore'
);
const { probeModelRow } = await import('../src/lib/server/modelProbe');
const { applyModelProfileAction } = await import('../src/lib/server/modelProfileStore');
const { applyProfileSelections, snapshotProfileSelections } = await import('../src/lib/modelProfiles');
const { regionAiSettings } = await import('../src/lib/regionAi');
const { saveSeriesRegionAi } = await import('../src/lib/server/workflowService');
const { db } = await import('../src/lib/server/db/index');
const { series } = await import('../src/lib/server/db/schema');
const { installedLocalReviewModels } = await import('../src/lib/server/localReview');
const { listTranslationModels } = await import('../src/lib/server/translationRuntime');
const { invalidateEnvFileCache } = await import('../src/lib/server/envFile');

after(async () => {
	await new Promise<void>((resolve, reject) => fakeHttp.close((err) => (err ? reject(err) : resolve())));
	await rm(root, { recursive: true, force: true });
});

function assertNoHostLeak(value: unknown, label: string) {
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	assert.doesNotMatch(text, HOST_LEAK, label);
}

test('isolated fresh install: startup, setup, registration, profiles, one task per adapter', async () => {
	assert.equal(await userCount(), 0);
	assert.deepEqual(installedLocalReviewModels(), []);
	assert.equal(
		listTranslationModels().filter((item) => item.available).length,
		0,
	);
	const emptyCli = listCliToolAdminStatus();
	assert.equal(emptyCli.every((tool) => !tool.found), true, JSON.stringify(emptyCli));
	const empty = await loadSetupReport();
	// The chat model ships as a preset, not a seed: a fresh install has no
	// local chat item until an operator adds one below.
	assert.equal(empty.items.find((item) => item.id === `local:${QWEN_38_27B_ID}`), undefined);
	assert.equal(empty.items.find((item) => item.id === 'cli:grok')?.state, 'missing');
	assert.equal(empty.items.find((item) => item.id === 'cli:codex')?.state, 'missing');
	assert.equal(empty.items.find((item) => item.id === 'cli:cursor')?.state, 'missing');
	assert.equal(empty.items.find((item) => item.id === 'capability:translate')?.state, 'missing');
	assert.ok(empty.nextSteps.some((step) => step.action === 'configure_endpoint'));
	assertNoHostLeak(empty, 'empty setup report');

	const admin = await createUser('fresh-admin', 'password', 'admin');
	assert.equal(admin.role, 'admin');
	assert.equal(await userCount(), 1);

	process.env.LLAMASWAP_URL = fakeBase;
	delete process.env.LLAMASWAP_API_KEY;
	process.env.SMOKE_REMOTE_KEY = 'fixture-remote';
	invalidateEnvFileCache();

	setCliToolSetting('grok', join(binDir, 'grok'));
	setCliToolSetting('codex', join(binDir, 'codex'));
	setCliToolSetting('cursor', join(binDir, 'cursor-agent'));
	const savedTools = JSON.parse(await readFile(cliToolsPath(), 'utf8'));
	assertNoHostLeak(savedTools, 'cli-tools.json');
	assert.match(savedTools.grok, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

	const remote = createRemoteHttpRow({
		id: 'smoke-gpt4o',
		name: 'Smoke GPT-4o',
		slug: 'gpt-4o-smoke',
		baseUrl: fakeBase,
		apiKeyEnv: 'SMOKE_REMOTE_KEY',
	});
	assert.equal(remote.access, 'remote_http');
	assert.equal(remote.http?.apiKeyEnv, 'SMOKE_REMOTE_KEY');
	assert.equal('apiKey' in (remote.http || {}), false);

	// CLI rows are discovered, not seeded: an admin adds one per adapter before it
	// can run a task. They start disabled and become usable once probing passes.
	const grokCli = addCliSlug('grok', 'grok-4.6');
	const codexCli = addCliSlug('codex', 'gpt-5.4');
	const cursorCli = addCliSlug('cursor', 'composer-2.5');
	for (const row of [grokCli, codexCli, cursorCli]) {
		assert.equal(row.access, 'cli');
		assert.equal(row.seeded, false);
		assert.equal(row.disabled, true);
	}

	invalidateRegistryCache();
	// Adding the chat model the way Setup does keeps the local path covered.
	const localChat = createLocalHttpRow({
		name: 'Qwen 3.8 27B',
		slug: QWEN_38_27B_ID,
		baseUrl: fakeBase,
	});
	updateRegistryRow(localChat.id, { requestPreset: 'qwen-thinking' });
	const ready = await loadSetupReport();
	assert.equal(ready.items.find((item) => item.id === `local:${localChat.id}`)?.state, 'configured');
	assert.equal(ready.items.find((item) => item.id === 'cli:grok')?.state, 'configured');
	assert.equal(ready.items.find((item) => item.id === 'remote:smoke-gpt4o')?.state, 'configured');
	assert.equal(ready.items.find((item) => item.id === 'capability:translate')?.state, 'configured');
	assert.ok(hits.models >= 1);
	assertNoHostLeak(ready, 'configured setup report');

	const localProfile = snapshotProfileSelections({
		translate: { engine: QWEN_38_27B_ID, model: '' },
		proofread: { engine: QWEN_38_27B_ID, model: '' },
		reviewers: [{ engine: QWEN_38_27B_ID, model: '' }],
		transcriptionModels: [QWEN_38_27B_ID],
	});
	const cliProfile = snapshotProfileSelections({
		translate: { engine: grokCli.id, model: '' },
		proofread: { engine: codexCli.id, model: '' },
		reviewers: [{ engine: cursorCli.id, model: '' }],
		transcriptionModels: [QWEN_38_27B_ID],
	});
	const savedLocal = applyModelProfileAction('save', { name: 'Local only', selections: localProfile });
	applyModelProfileAction('save', { name: 'CLI agents', selections: cliProfile });
	const validated = applyModelProfileAction('validate', { id: savedLocal.profile?.id }, listRegistryRows());
	assert.deepEqual(validated.issues, []);
	assertNoHostLeak(validated.profiles, 'model profiles');

	const before = regionAiSettings({
		translate: { engine: cursorCli.id, model: '' },
		describe: { engine: 'qwen3-vl-8b', model: '' },
		vision: { engine: 'qwen3-vl-8b', model: '' },
		proofread: { engine: cursorCli.id, model: '' },
		enquire: { engine: cursorCli.id, model: '' },
		reviewers: [{ engine: cursorCli.id, model: '' }],
		transcriptionModels: [QWEN_38_27B_ID],
	});
	const applied = applyProfileSelections(before, localProfile, listRegistryRows());
	assert.equal(applied.ok, true);
	assert.equal(applied.settings.translate.engine, QWEN_38_27B_ID);
	assert.deepEqual(applied.settings.describe, before.describe);

	await db.insert(series).values({
		id: 'fresh-series',
		slug: 'fresh-series',
		title: 'Fresh',
		notes: '',
		glossary: '[]',
		createdAt: 1,
		updatedAt: 1,
	});
	const persisted = saveSeriesRegionAi('fresh-series', 0, applied.settings);
	assert.equal(persisted.data.regionAi?.translate?.engine, QWEN_38_27B_ID);

	const rows = Object.fromEntries(listRegistryRows().map((row) => [row.id, row]));
	const tasks = [
		['local_http', rows[QWEN_38_27B_ID]],
		['remote_http', rows[remote.id]],
		['cli:grok', rows[grokCli.id]],
		['cli:codex', rows[codexCli.id]],
		['cli:cursor', rows[cursorCli.id]],
	] as const;
	for (const [kind, row] of tasks) {
		const sample = await probeModelRow(row, 'translate');
		assert.equal(sample.ok, true, `${kind}: ${sample.reason}`);
		assert.match(sample.outputPreview || '', /Wait!/);
	}
	assert.ok(hits.localChat >= 1, 'local HTTP translate');
	assert.ok(hits.remoteChat >= 1, 'remote HTTP translate');
});
