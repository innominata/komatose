import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
	CHAT_AND_CLI_OPERATIONS,
	cliRowId,
	type ModelRow,
	hydrateTaskEngine,
	mergeRegistry,
	pickerSeedEngines,
	RESERVED_LEGACY_HOST_IDS,
	resolveAssistant,
	rowAllowedForRole,
	rowHasOperation,
	allowedOperations,
	sanitizeModelSlug,
	isValidModelSlug,
	SEED_ROWS,
	truncateOutputPreview,
} from '../src/lib/modelRegistry';
import { enginesForRegionAiField } from '../src/lib/regionAi';
import { providerRunGate, selectProvidersForOperation } from '../src/lib/providerCatalog';
import { compareOcrReadings } from '../src/lib/ocrConsensus';
import {
	parseCodexDebugModels,
	parseCodexDebugModelsText,
	parseCursorModelList,
	cursorAuthError,
	parseGrokModelList,
	parseOpenAiModelList,
} from '../src/lib/cliModelLists';
import {
	batchedPageMs,
	medianMs,
	serialPageMs,
	transcribeSetPageMs,
} from '../src/lib/modelEstimate';
import { QWEN3_VL_ID, QWEN_38_27B_ID } from '../src/lib/qwenModels';

const root = await mkdtemp(join(tmpdir(), 'scan-models-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.DATABASE_URL = join(root, 'data', 'test.db');
const { probeModelRow } = await import('../src/lib/server/modelProbe');
/**
 * CLI rows are discovered, not seeded. Tests that need one build it the way
 * discovery/Add does.
 */
function cliTestRow(id: string, slug: string, cliAdapter: ModelRow['cliAdapter'], name = id): ModelRow {
	return {
		id,
		name,
		slug,
		access: 'cli',
		cliAdapter,
		operations: [...CHAT_AND_CLI_OPERATIONS],
		roles: ['admin', 'translator', 'proofreader', 'typesetter'],
		seeded: false,
		operationsLocked: true,
	};
}

const store = await import('../src/lib/server/modelRegistryStore');
after(() => rm(root, { recursive: true, force: true }));

/**
 * The chat model is no longer seeded: tests that resolve the legacy "qwen"
 * host to it pass the row an operator adds in Setup → Local models.
 */
function chatTestRow(): ModelRow {
	return {
		id: QWEN_38_27B_ID,
		name: 'Qwen 3.8 27B',
		slug: QWEN_38_27B_ID,
		access: 'local_http',
		runtime: 'llamacpp',
		operations: [...CHAT_AND_CLI_OPERATIONS],
		roles: ['admin', 'translator', 'proofreader', 'typesetter'],
		requestPreset: 'qwen-thinking',
		seeded: false,
		operationsLocked: false,
	};
}

test('hydrate maps every legacy host/model pair onto named rows', () => {
	// Chat rows are operator-added now, so legacy "qwen" hydration needs a row
	// list that contains one.
	const chatSeeds: ModelRow[] = [...SEED_ROWS, chatTestRow()];
	assert.deepEqual(hydrateTaskEngine({ engine: 'qwen', model: 'qwen3.8-27b-q4' }, chatSeeds), {
		engine: QWEN_38_27B_ID,
		model: '',
	});
	assert.deepEqual(hydrateTaskEngine({ engine: 'qwen', model: '' }, chatSeeds), {
		engine: QWEN_38_27B_ID,
		model: '',
	});
	assert.deepEqual(hydrateTaskEngine({ engine: 'qwen', model: 'hy-mt2-manga-v5' }, chatSeeds), {
		engine: 'hy-mt2-manga-v5',
		model: '',
	});
	assert.deepEqual(hydrateTaskEngine({ engine: 'qwen', model: 'saved-local-model' }, chatSeeds), {
		engine: QWEN_38_27B_ID,
		model: 'saved-local-model',
	});
	// CLI models are discovered, not seeded: an unadded slug stays a host+model pair.
	assert.deepEqual(hydrateTaskEngine({ engine: 'cursor', model: 'composer-2.5' }), {
		engine: 'cursor',
		model: 'composer-2.5',
	});
	assert.deepEqual(hydrateTaskEngine({ engine: 'cursor', model: 'auto' }), {
		engine: 'cursor',
		model: 'auto',
	});
	// Once discovery/Add creates the row, the same pair maps onto it.
	const discovered: ModelRow[] = [
		...SEED_ROWS,
		cliTestRow('composer-2.5', 'composer-2.5', 'cursor', 'Composer 2.5'),
	];
	assert.deepEqual(hydrateTaskEngine({ engine: 'cursor', model: 'composer-2.5' }, discovered), {
		engine: 'composer-2.5',
		model: '',
	});
	assert.deepEqual(hydrateTaskEngine({ engine: 'grok', model: 'chosen-model' }), {
		engine: 'grok',
		model: 'chosen-model',
	});
	const leftover = hydrateTaskEngine({ engine: 'mystery', model: 'x' });
	assert.equal(leftover.engine, 'mystery');
	assert.equal(leftover.model, 'x');
});

test('unknown engines throw instead of falling through to Qwen', () => {
	assert.throws(() => resolveAssistant(''), /Unsupported translation engine/);
	assert.throws(() => resolveAssistant('claude'), /Unsupported translation engine: claude/);
});

test('naming Qwen 3.8 27B does not substitute the seeded Qwen3-VL row', async () => {
	const { assistantDisplayName, isLocalOcrReviewer } = await import('../src/lib/modelRegistry');
	const { QWEN_38_27B_LABEL, QWEN3_VL_LABEL } = await import('../src/lib/qwenModels');
	assert.equal(assistantDisplayName(QWEN_38_27B_ID), QWEN_38_27B_LABEL);
	assert.notEqual(assistantDisplayName(QWEN_38_27B_ID), QWEN3_VL_LABEL);
	assert.equal(assistantDisplayName(QWEN3_VL_ID), QWEN3_VL_LABEL);
	assert.equal(isLocalOcrReviewer(QWEN_38_27B_ID), false);
	assert.equal(isLocalOcrReviewer(QWEN3_VL_ID), true);
});

test('CLI id collisions are prefixed; cursor auto stays cursor-auto', () => {
	const taken = new Set(SEED_ROWS.map((row) => row.id));
	assert.equal(cliRowId('cursor', 'auto', taken), 'cursor-auto');
	// Free slug: the plain slug becomes the id, as discovery adds it.
	assert.equal(cliRowId('codex', 'gpt-5.4', taken), 'gpt-5.4');
	// Once another adapter owns the slug, later ones are prefixed.
	taken.add('gpt-5.4');
	assert.equal(cliRowId('cursor', 'gpt-5.4', taken), 'cursor-gpt-5.4');
	assert.equal(cliRowId('grok', 'brand-new-grok', taken), 'brand-new-grok');
});

test('overlay can add a remote row; seeded rows stay and retired chat rows are gone', () => {
	store.invalidateRegistryCache();
	const remote = store.createRemoteHttpRow({
		id: 'work-gpt4o',
		name: 'Work GPT-4o',
		slug: 'gpt-4o',
		baseUrl: 'https://api.openai.com/v1',
		apiKeyEnv: 'OPENAI_API_KEY',
	});
	assert.equal(remote.access, 'remote_http');
	assert.equal(remote.http?.apiKeyEnv, 'OPENAI_API_KEY');
	assert.ok(!JSON.stringify(store.readModelOverlay()).includes('sk-'));
	assert.throws(() => store.removeOverlayRow(QWEN3_VL_ID), /Seeded models cannot be deleted/);
	// The chat model is retired, not seeded: its id no longer names a row at all.
	assert.throws(() => store.removeOverlayRow(QWEN_38_27B_ID), /Model not found/);
	store.removeOverlayRow('work-gpt4o');
});

test('mergeRegistry keeps seeds when overlay is empty or malformed', () => {
	assert.ok(mergeRegistry(null).some((row) => row.id === QWEN3_VL_ID));
	assert.ok(mergeRegistry({ rows: [{ id: '' }] }).some((row) => row.id === 'hayai-ocr-v2'));
});

test('Qwen3-VL is one row that widens into a chat model — never a twin entry', () => {
	assert.equal(mergeRegistry(null).filter((row) => row.slug === QWEN3_VL_ID).length, 1);
	const reader = mergeRegistry(null).find((row) => row.id === QWEN3_VL_ID)!;
	assert.deepEqual(reader.operations, [...CHAT_AND_CLI_OPERATIONS], 'task-agnostic from the seed: no boxes');
	assert.equal(reader.operationsLocked, false, 'no box may be locked onto it');
	// A saved overlay with a narrowed job list cannot put a box back on the seed.
	const boxed = mergeRegistry({ rows: [{ id: QWEN3_VL_ID, operations: ['describe', 'vision', 'advisory'] }] })
		.find((row) => row.id === QWEN3_VL_ID)!;
	assert.deepEqual(boxed.operations, [...CHAT_AND_CLI_OPERATIONS]);
	const merged = mergeRegistry({
		rows: [{
			id: QWEN3_VL_ID,
			operations: [...CHAT_AND_CLI_OPERATIONS],
			http: { baseUrl: '', apiKeyEnv: 'LLAMASWAP_API_KEY' },
			managedLaunch: {
				preset: 'generic' as const,
				executable: '/usr/bin/llama-server',
				modelPath: '/models/review/qwen3-vl-8b/Qwen3-VL-8B-Instruct-Q8_0.gguf',
				projectorPath: '/models/review/qwen3-vl-8b/mmproj-F16.gguf',
				port: 18084,
				device: 'auto',
				contextSize: 16384,
				gpuLayers: 999,
				slots: 2,
				startOnBoot: true,
				extraArgs: [],
			},
		}],
	}).find((row) => row.id === QWEN3_VL_ID)!;
	assert.ok(merged.managedLaunch, 'the one row carries the launch');
	assert.ok(merged.operations.includes('translate'));
	assert.equal(merged.operationsLocked, false);
});

test('CLI list parsers keep Cursor/Grok/Codex/OpenAI catalogs', () => {
	assert.equal(cursorAuthError('Error: Authentication required. Run \'agent login\''), 'Cursor CLI is not signed in on this server. Run `cursor-agent login` as the account Komatose runs under.');
	assert.equal(cursorAuthError('Not logged in\n'), 'Cursor CLI is not signed in on this server. Run `cursor-agent login` as the account Komatose runs under.');
	assert.equal(cursorAuthError('auto - Auto (default)\n'), null);
	assert.deepEqual(
		parseCursorModelList('Available models\n\nauto - Auto (default)\ncomposer-2.5 - Composer 2.5\ngpt-5.4 - GPT-5.4\n'),
		[
			{ id: 'auto', label: 'Auto (default)' },
			{ id: 'composer-2.5', label: 'Composer 2.5' },
			{ id: 'gpt-5.4', label: 'GPT-5.4' },
		],
	);
	assert.deepEqual(parseGrokModelList('Available:\n  grok-4.6\n  grok-4.5\n'), [
		{ id: 'grok-4.6', label: 'grok-4.6' },
		{ id: 'grok-4.5', label: 'grok-4.5' },
	]);
	const codex = parseCodexDebugModels({
		models: [
			{ slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', supported_in_api: true, model_messages: 'HUGE' },
			{ slug: 'hidden', display_name: 'Hidden', visibility: 'hidden' },
			{ slug: 'no-api', display_name: 'No API', visibility: 'list', supported_in_api: false },
		],
	});
	assert.deepEqual(codex, [{ id: 'gpt-5.4', label: 'GPT-5.4' }]);
	assert.deepEqual(
		parseCodexDebugModelsText('noise\n{"models":[{"slug":"o3","display_name":"o3"}]}\n'),
		[{ id: 'o3', label: 'o3' }],
	);
	assert.deepEqual(parseOpenAiModelList({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o' }] }), [
		{ id: 'gpt-4o', label: 'gpt-4o' },
	]);
});

test('native-path Tests use fake adapters, not TRANSLATE_SCHEMA on Hayai', async () => {
	const hayai = SEED_ROWS.find((row) => row.id === 'hayai-ocr-v2')!;
	const hy = SEED_ROWS.find((row) => row.id === 'hy-mt2-manga-v5')!;
	const grok = cliTestRow('grok-4.6', 'grok-4.6', 'grok', 'Grok 4.6');
	const cursor = cliTestRow('composer-2.5', 'composer-2.5', 'cursor', 'Composer 2.5');
	const okHayai = await probeModelRow(hayai, 'vision', {
		vision: async (_row, jpeg) => {
			assert.ok(jpeg.length > 2000);
			return { source: '待って', lineType: '""' };
		},
	});
	assert.equal(okHayai.ok, true);
	assert.match(okHayai.outputPreview || '', /待って/);
	const okHy = await probeModelRow(hy, 'translate', {
		invoke: async () => [{ translation: 'Test' }],
	});
	assert.equal(okHy.ok, true);
	assert.match(okHy.outputPreview || '', /Test/);
	const grokText = await probeModelRow(grok, 'translate', {
		translate: async () => [{
			x: 0, y: 0, w: 1, h: 1, lineType: '""', source: 'テスト',
			literal: '', translation: 'Test', reasoning: '',
		}],
	});
	assert.equal(grokText.ok, true);
	const grokVisionFail = await probeModelRow(grok, 'vision', {
		vision: async () => ({ source: '' }),
	});
	assert.equal(grokVisionFail.ok, false);
	const cursorVision = await probeModelRow(cursor, 'vision', {
		vision: async () => ({ source: '待って', lineType: '""' }),
	});
	assert.equal(cursorVision.ok, true);
	assert.equal(truncateOutputPreview('Bearer sk-secret hello', 80).includes('sk-secret'), false);
});

test('a Test marks the job it was run for, so the Jobs grid stops retesting the model', async () => {
	// A CLI agent allows every job at once. Each cell runs its own Test and must land
	// under the job it was run for: filed under `translate` instead, the other eight
	// jobs stayed "not tested" and were queued again on every run.
	const gpt = store.addCliSlug('codex', 'gpt-5.6-luna', 'GPT 5.6 Luna');
	try {
		for (const operation of gpt.operations) {
			const sample = await probeModelRow(gpt, operation, {
				translate: async () => [
					{ x: 0, y: 0, w: 1, h: 1, lineType: '""', source: 'テスト', literal: '', translation: 'Test', reasoning: '' },
				],
				vision: async () => ({ source: '待って', lineType: '""' }),
				task: async () => 'ok',
			});
			assert.equal(sample.ok, ['translate', 'vision', 'describe'].includes(operation), `${operation}: ${sample.reason}`);
			assert.equal(sample.operation, operation);
			store.saveProbeResult(gpt.id, sample);
		}
		const saved = store.findRegistryRow(gpt.id)!;
		assert.deepEqual(gpt.operations.filter((op) => !saved.probes?.[op]), []);
	} finally {
		store.removeOverlayRow(gpt.id);
	}
});

test('plurality: two-agree, 2-vs-1, n=1, tie, all fail', () => {
	const two = compareOcrReadings([
		{ model: 'hayai-ocr-v2', source: '나의자유를건' },
		{ model: 'paddleocr-vl-1.6', source: '나의 자유를 건' },
	]);
	assert.equal(two.agreed, true);
	assert.equal(two.source, '나의 자유를 건');
	const majority = compareOcrReadings([
		{ model: 'a', source: 'こんにちは' },
		{ model: 'b', source: 'こんにちは' },
		{ model: 'c', source: 'こんばんは' },
	]);
	assert.equal(majority.agreed, true);
	assert.equal(majority.source, 'こんにちは');
	const one = compareOcrReadings([{ model: 'grok-4.6', source: '待って！' }]);
	assert.equal(one.agreed, true);
	assert.equal(one.source, '待って！');
	const tie = compareOcrReadings([
		{ model: 'a', source: 'はい' },
		{ model: 'b', source: 'いいえ' },
	]);
	assert.equal(tie.agreed, false);
	assert.equal(tie.source, '');
	const failed = compareOcrReadings([
		{ model: 'a', source: '', error: 'down' },
		{ model: 'b', source: '', error: 'down' },
	]);
	assert.equal(failed.agreed, false);
});

test('estimate math: vision serial, batched translate, Hy-MT serial, parallel transcribe set', () => {
	assert.equal(medianMs([10, 30, 20]), 20);
	assert.equal(serialPageMs(100, 8), 800);
	assert.equal(batchedPageMs(100, 8), 450);
	assert.equal(transcribeSetPageMs([200, 150, 100], 8, 3), 8 * 200);
	assert.equal(transcribeSetPageMs([200, 150, 100, 90, 80, 70], 8, 3), 8 * (200 + 90));
});

test('vision Test crop is lettering, not a blank tile', async () => {
	const { visionProbeJpeg } = await import('../src/lib/server/modelProbe');
	const jpeg = await visionProbeJpeg();
	assert.ok(jpeg.length > 2000);
	const { default: sharp } = await import('sharp');
	const meta = await sharp(jpeg).metadata();
	assert.ok((meta.width || 0) >= 200);
	assert.ok((meta.height || 0) >= 100);
	const stats = await sharp(jpeg).stats();
	assert.ok(stats.channels[0].stdev > 10);
});

test('parseEnvFile, /v1 base URLs, and missing-key text name the env var not the row id', async () => {
	const { parseEnvFile } = await import('../src/lib/server/envFile');
	const { missingApiKeyMessage, openaiChatCompletions, openaiCompatibleBaseUrl } = await import(
		'../src/lib/server/openaiHttp'
	);
	assert.deepEqual(parseEnvFile('DEEPSEEK_API_KEY=abc\n# skip\nexport FOO="bar"\n'), {
		DEEPSEEK_API_KEY: 'abc',
		FOO: 'bar',
	});
	assert.equal(openaiCompatibleBaseUrl('https://api.deepseek.com'), 'https://api.deepseek.com/v1');
	assert.equal(openaiCompatibleBaseUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1');
	assert.equal(openaiCompatibleBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com/v1');
	const msg = missingApiKeyMessage('DEEPSEEK_API_KEY');
	assert.match(msg, /DEEPSEEK_API_KEY/);
	assert.doesNotMatch(msg, /deepseek-flash/);
	await assert.rejects(
		() =>
			openaiChatCompletions([{ role: 'user', content: 'hi' }], {
				config: {
					baseUrl: 'https://api.deepseek.com/v1',
					apiKey: '',
					model: 'deepseek-flash',
					profile: 'openai',
					rowId: 'deepseek-flash',
					apiKeyEnv: 'DEEPSEEK_API_KEY',
				},
			}),
		(error: unknown) => {
			const text = error instanceof Error ? error.message : String(error);
			assert.match(text, /DEEPSEEK_API_KEY/);
			assert.equal(text.includes('API key deepseek-flash'), false);
			return true;
		},
	);
});

test('remote HTTP reads DEEPSEEK_API_KEY from .env when process env is empty', async () => {
	const { envVar, invalidateEnvFileCache } = await import('../src/lib/server/envFile');
	const { httpConfigFor } = await import('../src/lib/server/assistantRoute');
	const saved = process.env.DEEPSEEK_API_KEY;
	delete process.env.DEEPSEEK_API_KEY;
	try {
		await writeFile(join(root, '.env'), 'DEEPSEEK_API_KEY=from-dotenv-file\n');
		invalidateEnvFileCache();
		assert.equal(envVar('DEEPSEEK_API_KEY'), 'from-dotenv-file');
		process.env.DEEPSEEK_API_KEY = 'from-process';
		assert.equal(envVar('DEEPSEEK_API_KEY'), 'from-process');
		delete process.env.DEEPSEEK_API_KEY;
		const cfg = httpConfigFor(
			{
				id: 'deepseek-flash',
				name: 'DeepSeek Flash',
				slug: 'deepseek-flash',
				access: 'remote_http',
				runtime: 'openai',
				operations: ['translate'],
				roles: ['admin'],
				http: { baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
				seeded: false,
				operationsLocked: false,
			},
			'deepseek-flash',
		);
		assert.ok(cfg);
		assert.equal(cfg.baseUrl, 'https://api.deepseek.com/v1');
		assert.equal(cfg.apiKeyEnv, 'DEEPSEEK_API_KEY');
		assert.equal(cfg.apiKey, 'from-dotenv-file');
	} finally {
		if (saved === undefined) delete process.env.DEEPSEEK_API_KEY;
		else process.env.DEEPSEEK_API_KEY = saved;
		invalidateEnvFileCache();
	}
});

test('remote OpenAI profile sends json_object, not json_schema', async () => {
	const {
		compatResponseFormat,
		DEEPSEEK_MAX_OUTPUT_TOKENS,
		isDeepSeekHost,
		openaiChatCompletions,
		openaiMaxTokens,
		openaiThinking,
		responseFormatRejected,
	} = await import('../src/lib/server/openaiHttp');
	assert.equal(isDeepSeekHost('https://api.deepseek.com/v1'), true);
	assert.equal(isDeepSeekHost('https://api.openai.com/v1'), false);
	assert.deepEqual(openaiThinking('https://api.deepseek.com/v1', true, true), { type: 'disabled' });
	assert.deepEqual(openaiThinking('https://api.deepseek.com/v1', false, true), { type: 'enabled' });
	assert.deepEqual(openaiThinking('https://api.deepseek.com/v1', true, true, true), { type: 'disabled' });
	assert.deepEqual(openaiThinking('https://api.deepseek.com/v1', false, true, true), { type: 'disabled' });
	assert.equal(openaiThinking('https://api.openai.com/v1', true, true), undefined);
	assert.equal(openaiMaxTokens('https://api.deepseek.com/v1', 8192), DEEPSEEK_MAX_OUTPUT_TOKENS);
	assert.equal(openaiMaxTokens('https://api.openai.com/v1', 8192), 8192);
	const schema = { type: 'json_schema', json_schema: { name: 'scan_translate', strict: true, schema: { type: 'object' } } };
	assert.deepEqual(compatResponseFormat(schema, 'openai'), { type: 'json_object' });
	assert.equal(compatResponseFormat(schema, 'llamacpp'), schema);
	assert.equal(responseFormatRejected(400, '{"error":{"message":"This response_format type is unavailable now"}}'), true);
	assert.equal(responseFormatRejected(401, '{"error":{"message":"This response_format type is unavailable now"}}'), false);

	const bodies: Array<{ response_format?: unknown; thinking?: unknown; max_tokens?: number }> = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body || '{}')));
		return new Response(JSON.stringify({ choices: [{ message: { content: '{"items":[]}' } }] }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	}) as typeof fetch;
	try {
		const text = await openaiChatCompletions([{ role: 'user', content: 'hi' }], {
			config: {
				baseUrl: 'https://api.deepseek.com/v1',
				apiKey: 'test-key',
				model: 'deepseek-flash',
				profile: 'openai',
				rowId: 'deepseek-flash',
				apiKeyEnv: 'DEEPSEEK_API_KEY',
			},
			schema,
		});
		assert.equal(text, '{"items":[]}');
		assert.equal(bodies.length, 1);
		assert.deepEqual(bodies[0].response_format, { type: 'json_object' });
		assert.deepEqual(bodies[0].thinking, { type: 'disabled' });
		assert.equal(bodies[0].max_tokens, 4096);
	} finally {
		globalThis.fetch = originalFetch;
	}

	const retryBodies: Array<Record<string, unknown>> = [];
	globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body || '{}'));
		retryBodies.push(body);
		if (body.response_format) {
			return new Response(
				JSON.stringify({ error: { message: 'This response_format type is unavailable now', type: 'invalid_request_error' } }),
				{ status: 400, headers: { 'content-type': 'application/json' } },
			);
		}
		return new Response(JSON.stringify({ choices: [{ message: { content: '{"items":[{"i":0}]}' } }] }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	}) as typeof fetch;
	try {
		const text = await openaiChatCompletions([{ role: 'user', content: 'hi' }], {
			config: {
				baseUrl: 'https://api.deepseek.com/v1',
				apiKey: 'test-key',
				model: 'deepseek-flash',
				profile: 'openai',
			},
			schema: { type: 'json_object' },
		});
		assert.equal(text, '{"items":[{"i":0}]}');
		assert.equal(retryBodies.length, 2);
		assert.deepEqual(retryBodies[0].response_format, { type: 'json_object' });
		assert.equal('response_format' in retryBodies[1], false);
		assert.deepEqual(retryBodies[0].thinking, { type: 'disabled' });
		assert.deepEqual(retryBodies[1].thinking, { type: 'disabled' });
	} finally {
		globalThis.fetch = originalFetch;
	}

	const openaiBodies: Array<{ thinking?: unknown }> = [];
	globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
		openaiBodies.push(JSON.parse(String(init?.body || '{}')));
		return new Response(JSON.stringify({ choices: [{ message: { content: '{"items":[]}' } }] }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	}) as typeof fetch;
	try {
		await openaiChatCompletions([{ role: 'user', content: 'hi' }], {
			config: {
				baseUrl: 'https://api.openai.com/v1',
				apiKey: 'test-key',
				model: 'gpt-4o',
				profile: 'openai',
			},
			schema,
		});
		assert.equal('thinking' in openaiBodies[0], false);
	} finally {
		globalThis.fetch = originalFetch;
	}

	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '' } }] }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})) as typeof fetch;
	try {
		await assert.rejects(
			() =>
				openaiChatCompletions([{ role: 'user', content: 'hi' }], {
					config: {
						baseUrl: 'https://api.deepseek.com/v1',
						apiKey: 'test-key',
						model: 'deepseek-flash',
						profile: 'openai',
					},
					schema,
				}),
			/4096-token output limit/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('DeepSeek vision requests fold the system turn onto the user image and disable thinking', async () => {
	const {
		deepSeekVisionMessages,
		openaiChatCompletions,
	} = await import('../src/lib/server/openaiHttp');
	const folded = deepSeekVisionMessages([
		{ role: 'system', content: 'Copy the glyphs. Return JSON {source, lineType}.' },
		{
			role: 'user',
			content: [
				{ type: 'text', text: 'Read this crop.' },
				{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QQ==' } },
			],
		},
	]);
	assert.equal(folded.some((m) => m.role === 'system'), false);
	assert.equal(folded.length, 1);
	assert.equal(folded[0].role, 'user');
	assert.ok(Array.isArray(folded[0].content));
	const parts = folded[0].content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
	assert.equal(parts[0].type, 'text');
	assert.match(parts[0].text || '', /Copy the glyphs/);
	assert.match(parts[0].text || '', /Read this crop/);
	assert.equal(parts[1].type, 'image_url');

	const bodies: Array<{
		messages?: Array<{ role: string; content: unknown }>;
		thinking?: unknown;
		response_format?: unknown;
		model?: string;
	}> = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body || '{}')));
		return new Response(JSON.stringify({
			choices: [{ message: { content: '{"source":"待て","lineType":"\\"\\""}' } }],
		}), { status: 200, headers: { 'content-type': 'application/json' } });
	}) as typeof fetch;
	try {
		const text = await openaiChatCompletions([
			{ role: 'system', content: 'Copy the glyphs. Return JSON {source, lineType}.' },
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'Read this crop.' },
					{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QQ==' } },
				],
			},
		], {
			config: {
				baseUrl: 'https://api.deepseek.com/v1',
				apiKey: 'test-key',
				model: 'deepseek-flash',
				profile: 'openai',
				rowId: 'deepseek-flash',
				apiKeyEnv: 'DEEPSEEK_API_KEY',
			},
			schema: { type: 'json_schema', json_schema: { name: 'scan_read', schema: { type: 'object' } } },
			thinking: false,
		});
		assert.equal(text, '{"source":"待て","lineType":"\\"\\""}');
		assert.equal(bodies.length, 1);
		assert.equal(bodies[0].model, 'deepseek-flash');
		assert.equal(bodies[0].messages?.some((m) => m.role === 'system'), false);
		assert.deepEqual(bodies[0].thinking, { type: 'disabled' });
		assert.deepEqual(bodies[0].response_format, { type: 'json_object' });
		const user = bodies[0].messages?.[0];
		assert.equal(user?.role, 'user');
		assert.ok(Array.isArray(user?.content));
		assert.ok((user?.content as Array<{ type: string }>).some((part) => part.type === 'image_url'));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('DeepSeek discards a length-truncated review instead of keeping a few leftover words', async () => {
	const { openaiChatCompletions } = await import('../src/lib/server/openaiHttp');
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(
			JSON.stringify({
				choices: [{
					finish_reason: 'length',
					message: { content: '{"status":"readable","source":"ここ","translation":"Here","answer":"' },
				}],
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		)) as typeof fetch;
	try {
		await assert.rejects(
			openaiChatCompletions([{ role: 'user', content: 'review' }], {
				config: {
					baseUrl: 'https://api.deepseek.com/v1',
					apiKey: 'test-key',
					model: 'deepseek-flash',
					profile: 'openai',
					rowId: 'deepseek-flash',
					apiKeyEnv: 'DEEPSEEK_API_KEY',
				},
				maxTokens: 8192,
			}),
			/4096-token output limit/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('live snapshot lets a non-seeded row be chosen and run; changed ops and disabled stay out', () => {
	store.invalidateRegistryCache();
	const remote = store.createRemoteHttpRow({
		id: 'review-qualified',
		name: 'Review Qualified',
		slug: 'review-model',
		baseUrl: 'https://remote.example/v1',
		apiKeyEnv: 'OPENAI_API_KEY',
		operations: ['translate', 'advisory'],
	});
	assert.equal(remote.id, 'review-qualified');
	assert.deepEqual(remote.operations, [...CHAT_AND_CLI_OPERATIONS], 'rows are created task-agnostic');
	assert.equal(rowHasOperation(remote, 'translate'), false, 'an untested job is not offered');
	assert.equal(rowHasOperation(remote, 'advisory'), false);
	store.saveCapabilityResults(remote.id, ['translation', 'conversation'].map(capability => ({ capability: capability as 'translation' | 'conversation', ok: true, at: Date.now(), fingerprint: remote.capabilityFingerprints![capability as 'translation' | 'conversation'] })));
	const passed = store.findRegistryRow('review-qualified')!;
	const snapshot = [{
		id: passed.id,
		label: passed.name,
		available: true,
		operations: allowedOperations(passed),
		access: passed.access,
	}, {
		id: 'vision-only-remote',
		label: 'Vision Only',
		available: true,
		operations: ['vision'] as const,
	}, {
		id: 'turned-off',
		label: 'Off',
		available: false,
		operations: ['translate'] as const,
		reason: 'Disabled',
	}];
	const translate = selectProvidersForOperation(snapshot, 'translate');
	assert.ok(translate.some((engine) => engine.id === 'review-qualified' && engine.available));
	assert.ok(!translate.some((engine) => engine.id === 'vision-only-remote'));
	assert.equal(providerRunGate('review-qualified', 'translate', snapshot).ok, true);
	assert.equal(providerRunGate('review-qualified', 'vision', snapshot).ok, false, 'no vision check means it is not offered');
	const enquire = enginesForRegionAiField('enquire', snapshot);
	assert.ok(enquire.some((engine) => engine.id === 'review-qualified'));
	// Saved job boxes are ignored: an overlay cannot narrow a model's tasks.
	store.updateRegistryRow('review-qualified', { operations: ['vision'] });
	assert.ok(store.findRegistryRow('review-qualified')!.operations.includes('translate'), 'the box does not stick');
	// The test is the verdict: a failed translate run takes it out of that task only.
	store.saveCapabilityResults(remote.id, [{ capability: 'translation', ok: false, outcome: 'failed_validation', at: Date.now(), fingerprint: passed.capabilityFingerprints!.translation, reason: 'no answer' }]);
	const failedRow = store.findRegistryRow('review-qualified')!;
	assert.equal(rowHasOperation(failedRow, 'translate'), false, 'a failed test blocks the task');
	assert.equal(rowHasOperation(failedRow, 'advisory'), false, 'dependent jobs also require translation');
	assert.equal(rowHasOperation(failedRow, 'chapterReview'), true, 'conversation-only jobs remain available');
	const afterFail = [{
		id: 'review-qualified',
		label: 'Review Qualified',
		available: true,
		operations: allowedOperations(failedRow),
	}];
	assert.equal(providerRunGate('review-qualified', 'translate', afterFail).ok, false);
	store.removeOverlayRow('review-qualified');
});

test('qualified slugs survive resolve, hydrate, Test override, and CLI id creation', () => {
	const slug = 'org/model:tag';
	assert.equal(sanitizeModelSlug(slug), slug);
	const rows = mergeRegistry({
		rows: [{
			id: 'qualified-remote',
			name: 'Qualified',
			slug,
			access: 'remote_http',
			runtime: 'openai',
			operations: ['translate', 'vision'],
		}],
	});
	assert.equal(resolveAssistant('qualified-remote', '', rows).slug, slug);
	assert.equal(resolveAssistant('qualified-remote', slug, rows).slug, slug);
	assert.deepEqual(hydrateTaskEngine({ engine: 'qualified-remote', model: '' }, rows), {
		engine: 'qualified-remote',
		model: '',
	});
	assert.deepEqual(hydrateTaskEngine({ engine: 'grok', model: slug }, rows), {
		engine: 'grok',
		model: slug,
	});
	const taken = new Set(SEED_ROWS.map((row) => row.id));
	assert.equal(cliRowId('grok', slug, taken), slug);
});

test('legacy host aliases cannot be used as new row ids and still resolve to the original host', () => {
	store.invalidateRegistryCache();
	for (const host of RESERVED_LEGACY_HOST_IDS) {
		const remote = store.createRemoteHttpRow({
			id: host,
			name: `Shadow ${host}`,
			slug: `${host}-remote`,
			baseUrl: 'https://shadow.example/v1',
			apiKeyEnv: 'OPENAI_API_KEY',
		});
		assert.notEqual(remote.id, host);
		assert.match(remote.id, new RegExp(`^${host}-\\d+$`));
		const cli = store.addCliSlug('grok', host, `CLI ${host}`);
		assert.notEqual(cli.id, host);
	}
	const shadowed = [
		...mergeRegistry({
			rows: [{
				id: 'qwen',
				name: 'Shadow Qwen',
				slug: 'stealth-qwen',
				access: 'remote_http',
				runtime: 'openai',
				operations: ['translate'],
			}],
		}),
		// The chat row is operator-added, so the caller passes it alongside.
		chatTestRow(),
	];
	assert.ok(!shadowed.some((row) => row.id === 'qwen' && row.access === 'remote_http'));
	const qwen = resolveAssistant('qwen', '', shadowed);
	assert.equal(qwen.host, 'http');
	assert.equal(qwen.row.id, QWEN_38_27B_ID);
	const grok = resolveAssistant('grok', '', shadowed);
	assert.equal(grok.host, 'grok');
	assert.equal(grok.row.access, 'cli');
});

test('any registry row can be hidden from pickers without deleting it', () => {
	store.invalidateRegistryCache();
	const added = store.addCliSlug('grok', 'polluting-slug', 'Polluting');
	assert.equal(added.disabled, true);
	assert.equal(rowAllowedForRole(added, 'translator'), false);
	assert.ok(!pickerSeedEngines(store.listRegistryRows()).some((item) => item.id === added.id));
	const shown = store.updateRegistryRow(added.id, { disabled: false });
	assert.equal(shown.disabled, false);
	assert.equal(rowAllowedForRole(shown, 'translator'), true);
	assert.ok(pickerSeedEngines(store.listRegistryRows()).some((item) => item.id === added.id));
	const extra = store.addCliSlug('cursor', 'other-slug', 'Other');
	store.setRowsDisabled([added.id, extra.id], true);
	const rows = store.listRegistryRows();
	assert.equal(rows.find((row) => row.id === added.id)?.disabled, true);
	assert.equal(rows.find((row) => row.id === extra.id)?.disabled, true);
	assert.ok(pickerSeedEngines(rows).some((item) => item.id === QWEN3_VL_ID));
	assert.ok(!pickerSeedEngines(rows).some((item) => item.id === added.id || item.id === extra.id));
	store.setRowsDisabled([added.id, QWEN3_VL_ID, 'proofreader-a'], true);
	const hidden = pickerSeedEngines(store.listRegistryRows());
	assert.ok(!hidden.some((item) => item.id === added.id));
	assert.ok(!hidden.some((item) => item.id === QWEN3_VL_ID));
	assert.ok(!hidden.some((item) => item.id === 'proofreader-a'));
	store.setRowsDisabled([added.id, QWEN3_VL_ID, 'proofreader-a'], false);
	store.removeOverlayRow(added.id);
	store.removeOverlayRow(extra.id);
});

test('remote advisory checks the selected row, not local Qwen', async () => {
	store.invalidateRegistryCache();
	const remote = store.createRemoteHttpRow({
		id: 'advice-remote',
		name: 'Advice Remote',
		slug: 'advice-slug',
		baseUrl: 'https://advice.example',
		apiKeyEnv: 'OPENAI_API_KEY',
	});
	store.saveCapabilityResults(remote.id, (['translation', 'conversation'] as const).map(capability => ({ capability, ok: true, at: Date.now(), fingerprint: remote.capabilityFingerprints![capability] })));
	const saved = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = 'fake-remote-key';
	const urls: string[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = String(input instanceof Request ? input.url : input);
		urls.push(url);
		if (url.includes('127.0.0.1:8081') || url.includes('localhost:8081')) {
			throw new Error('Local model service is unreachable');
		}
		return new Response(JSON.stringify({
			choices: [{ message: { content: '{"answer":"from-remote","suggestions":[]}' } }],
		}), { status: 200, headers: { 'content-type': 'application/json' } });
	}) as typeof fetch;
	try {
		const { assertEngineReady } = await import('../src/lib/server/engineReadiness');
		await assertEngineReady(remote.id);
		assert.ok(urls.every(url => url.startsWith('https://advice.example/')));
		const { advisoryModel } = await import('../src/lib/server/regionAi');
		const out = await advisoryModel(
			{ engine: remote.id, model: '' },
			'Advise.',
			'What does this mean?',
			[],
			undefined,
			{ type: 'object', properties: { answer: { type: 'string' } } },
		) as { answer?: string };
		assert.equal(out.answer, 'from-remote');
		assert.ok(urls.some((url) => url.includes('advice.example')));
		assert.ok(!urls.some((url) => url.includes('127.0.0.1:8081') || url.includes('localhost:8081')));
	} finally {
		globalThis.fetch = originalFetch;
		if (saved === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = saved;
		store.removeOverlayRow(remote.id);
	}
});

test('a failed vision Test does not block a diagnostic retest on the native path', async () => {
	const slug = 'org/' + 'a'.repeat(80) + ':tag';
	store.invalidateRegistryCache();
	const remote = store.createRemoteHttpRow({
		id: 'vision-retest',
		name: 'Vision Retest',
		slug,
		baseUrl: 'https://vision.example',
		apiKeyEnv: 'OPENAI_API_KEY',
		operations: ['translate', 'vision'],
	});
	store.saveProbeResult(remote.id, {
		operation: 'vision',
		ok: false,
		at: Date.now(),
		reason: 'temporary outage',
	});
	const failed = store.findRegistryRow(remote.id)!;
	assert.equal(failed.probes?.vision?.ok, false);
	const { routeAssistant } = await import('../src/lib/server/assistantRoute');
	assert.throws(
		() => routeAssistant(failed.id, failed.slug, 'vision', 'read area'),
		/Needs Transcription/,
	);
	const diagnostic = routeAssistant(failed.id, failed.slug, 'vision', 'read area', { diagnostic: true });
	assert.equal(diagnostic.slug, slug);
	store.saveProbeResult(remote.id, {
		operation: 'vision',
		ok: false,
		at: Date.now(),
		ms: 0,
		reason: 'Deepseek failed its vision Test and cannot read images.',
	});
	const circular = store.findRegistryRow(remote.id)!;
	assert.throws(
		() => routeAssistant(circular.id, circular.slug, 'vision', 'read area'),
		/Needs Transcription/,
	);
	const saved = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = 'fake-remote-key';
	let hits = 0;
	const models: string[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
		hits += 1;
		const body = JSON.parse(String(init?.body || '{}')) as { model?: string };
		if (body.model) models.push(body.model);
		return new Response(JSON.stringify({
			choices: [{ message: { content: '{"source":"待って","lineType":"\\"\\""}' } }],
		}), { status: 200, headers: { 'content-type': 'application/json' } });
	}) as typeof fetch;
	try {
		const sample = await probeModelRow(failed, 'vision');
		assert.equal(sample.ok, true);
		assert.ok(hits >= 1);
		assert.ok(models.includes(slug));
		store.updateRegistryRow(remote.id, { slug: 'org/model:tag-v2' });
		assert.ok(store.findRegistryRow(remote.id)?.probes?.vision, 'Earlier evidence is retained as stale');
	} finally {
		globalThis.fetch = originalFetch;
		if (saved === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = saved;
		store.removeOverlayRow(remote.id);
	}
});


test('empty live capabilities override seeded defaults in pickers and Run checks', () => {
	const snapshot = [{ id: QWEN_38_27B_ID, available: true, operations: [] }];
	assert.equal(providerRunGate(QWEN_38_27B_ID, 'translate', snapshot).ok, false);
	assert.deepEqual(selectProvidersForOperation(snapshot, 'translate'), []);
	const saved = selectProvidersForOperation(snapshot, 'translate', QWEN_38_27B_ID);
	assert.equal(saved.length, 1);
	assert.equal(saved[0].available, false);
	// No live operations and no passing test: the task stays closed.
	assert.equal(providerRunGate(QWEN_38_27B_ID, 'translate', [{ id: QWEN_38_27B_ID }]).ok, false);
});

test('long model identifiers survive normal routing, Test overrides and legacy hydration', () => {
	const slug = 'org/' + 'a'.repeat(80);
	const rows = mergeRegistry({ rows: [{
		id: 'long-identifier', name: 'Long identifier', slug,
		access: 'remote_http', runtime: 'openai', operations: ['translate'],
	}] });
	assert.equal(isValidModelSlug(slug), true);
	assert.equal(sanitizeModelSlug(slug), slug);
	assert.equal(resolveAssistant('long-identifier', '', rows).slug, slug);
	assert.equal(resolveAssistant('long-identifier', slug, rows).slug, slug);
	assert.equal(hydrateTaskEngine({ engine: 'grok', model: slug }, rows).model, slug);
});
