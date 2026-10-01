import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { CHAT_AND_CLI_OPERATIONS, SEED_ROWS } from '../src/lib/modelRegistry';
import {
	MODEL_PACK_KIND,
	MODEL_PACK_VERSION,
	ModelPackError,
	buildModelPack,
	parseImportDecisions,
	parseModelPack,
	previewModelPack,
	resolveImport,
	classifyEndpointHost,
	classifyEndpointUrl,
	isNonPublicEndpoint,
	previewPackExport,
	sanitizePortableUrl,
	validateResolvedImport,
	type ModelPack,
} from '../src/lib/modelPack';
import { QWEN3_VL_ID, QWEN_38_27B_ID } from '../src/lib/qwenModels';
import { ROLES } from '../src/lib/types';

const HOST_LEAK = /\/home\/inno\b|\/www\/scan\/data\b|SCAN_GPU_MODE=komatose|sk-secret|secret-output|\/opt\/fake-grok/;

const root = await mkdtemp(join(tmpdir(), 'scan-model-pack-'));
const dataA = join(root, 'install-a');
const dataB = join(root, 'install-b');
await mkdir(dataA, { recursive: true });
await mkdir(dataB, { recursive: true });

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
process.env.SCAN_DATA_DIR = dataA;
process.env.DATABASE_URL = join(dataA, 'test.db');
process.env.HOME = join(root, 'home');
process.env.PATH = '/usr/bin:/bin';

const {
	applyImportedPack,
	exportModelPack,
	previewImportedPack,
} = await import('../src/lib/server/modelPackStore');
const {
	invalidateRegistryCache,
	listRegistryRows,
	readModelOverlay,
	writeModelOverlay,
} = await import('../src/lib/server/modelRegistryStore');
const { readModelProfiles, writeModelProfiles } = await import('../src/lib/server/modelProfileStore');
const { setCliToolSetting, cliToolsPath } = await import('../src/lib/server/cliToolSettings');

after(() => rm(root, { recursive: true, force: true }));

const remoteModel = {
	id: 'studio-gpt4o',
	name: 'Studio GPT-4o',
	slug: 'gpt-4o',
	access: 'remote_http' as const,
	runtime: 'openai' as const,
	operations: [...CHAT_AND_CLI_OPERATIONS],
	roles: [...ROLES],
	http: { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'STUDIO_OPENAI_KEY' },
};

const cliModel = {
	id: 'grok-custom-beta',
	name: 'Grok custom beta',
	slug: 'grok-custom-beta',
	access: 'cli' as const,
	cliAdapter: 'grok' as const,
	operations: [...CHAT_AND_CLI_OPERATIONS],
	roles: [...ROLES],
};

const studioProfile = {
	id: 'profile-studio',
	name: 'Studio remote',
	selections: {
		translate: { engine: 'studio-gpt4o', model: '' },
		// Profile refs point at shipped seeds: the chat model is operator-added
		// now, so it would be "missing" on every fresh install.
		proofread: { engine: QWEN3_VL_ID, model: '' },
		reviewers: [{ engine: 'studio-gpt4o', model: '' }],
		transcriptionModels: [QWEN3_VL_ID],
	},
};

function overlayRemote(id: string, baseUrl: string) {
	return {
		...remoteModel,
		id,
		name: id,
		http: { baseUrl, apiKeyEnv: 'STUDIO_OPENAI_KEY' },
		seeded: false as const,
		operationsLocked: false,
	};
}

function namedProfile(id: string, engine: string) {
	return {
		id,
		name: id,
		updatedAt: 0,
		selections: {
			translate: { engine, model: '' },
			proofread: { engine: QWEN3_VL_ID, model: '' },
			reviewers: [] as Array<{ engine: string; model: string }>,
			transcriptionModels: [QWEN3_VL_ID],
		},
	};
}

function samplePack(overrides: Partial<ModelPack> = {}): ModelPack {
	return {
		kind: MODEL_PACK_KIND,
		version: MODEL_PACK_VERSION,
		exportedAt: '2026-09-15T00:00:00.000Z',
		models: [remoteModel, cliModel],
		profiles: [studioProfile],
		...overrides,
	};
}

function useInstall(dir: string) {
	process.env.SCAN_DATA_DIR = dir;
	process.env.SCAN_ROOT = root;
	invalidateRegistryCache();
}

function snapshot(dir: string) {
	return Promise.all([
		readFile(join(dir, 'models.json'), 'utf8').catch(() => ''),
		readFile(join(dir, 'model-profiles.json'), 'utf8').catch(() => ''),
		readFile(join(dir, 'cli-tools.json'), 'utf8').catch(() => ''),
	]);
}

describe('model pack parse/preview', () => {
	test('rejects malformed files, version mismatches, secrets, and file endpoints', () => {
		assert.throws(() => parseModelPack('{'), /not valid JSON/);
		assert.throws(() => parseModelPack([]), /JSON object/);
		assert.throws(
			() => parseModelPack({ kind: 'other', version: 1, models: [], profiles: [] }),
			/not a Komatose model pack/,
		);
		assert.throws(
			() => parseModelPack({ kind: MODEL_PACK_KIND, version: 99, models: [], profiles: [] }),
			/version 99/,
		);
		assert.throws(
			() => parseModelPack({ ...samplePack(), apiKey: 'sk-secret' }),
			/must not include apiKey/i,
		);
		assert.throws(
			() =>
				parseModelPack({
					...samplePack(),
					models: [{ ...remoteModel, probes: { translate: { ok: true } } }],
				}),
			/must not include probes/i,
		);
		assert.throws(
			() =>
				parseModelPack({
					...samplePack(),
					models: [{ ...cliModel, executable: '/opt/fake-grok' }],
				}),
			/must not include executable/i,
		);
		assert.throws(
			() =>
				parseModelPack({
					...samplePack(),
					models: [
						{
							...remoteModel,
							http: { ...remoteModel.http, baseUrl: 'file:///tmp/weights' },
						},
					],
				}),
			/file endpoints/i,
		);
		assert.equal(
			parseModelPack({
				...samplePack(),
				models: [
					{
						...remoteModel,
						http: { ...remoteModel.http, baseUrl: 'http://192.168.1.10/v1' },
					},
				],
			}).models[0]?.http?.baseUrl,
			'http://192.168.1.10/v1',
		);
		assert.throws(
			() =>
				parseModelPack({
					...samplePack(),
					models: [
						{
							...remoteModel,
							http: { ...remoteModel.http, apiKey: 'sk-secret' },
						},
					],
				}),
			/must not include apiKey|API keys/i,
		);
		assert.throws(
			() => parseImportDecisions({ models: { 'studio-gpt4o': { action: 'overwrite' } } }),
			/skipped or renamed/i,
		);
		assert.throws(
			() =>
				parseModelPack({
					...samplePack(),
					models: [
						{
							...remoteModel,
							http: { ...remoteModel.http, baseUrl: 'https://user:s3cret@api.example.com/v1' },
						},
					],
				}),
			/passwords or tokens/i,
		);
		assert.throws(
			() =>
				parseModelPack({
					...samplePack(),
					models: [
						{
							...remoteModel,
							http: { ...remoteModel.http, baseUrl: 'https://api.example.com/v1?api_key=sk-live' },
						},
					],
				}),
			/passwords or tokens/i,
		);
	});

	test('export strips passwords and query-string tokens from endpoint URLs', () => {
		assert.equal(
			sanitizePortableUrl('https://user:s3cret@api.example.com/v1?api_key=sk-live&foo=1'),
			'https://api.example.com/v1?foo=1',
		);
		const dirty = {
			...remoteModel,
			http: {
				baseUrl: 'https://user:s3cret@api.example.com/v1?token=abc&api_key=sk-live',
				apiKeyEnv: 'STUDIO_OPENAI_KEY',
			},
			seeded: false,
			operationsLocked: false,
		};
		const pack = buildModelPack([dirty], []);
		assert.equal(pack.models[0]?.http?.baseUrl, 'https://api.example.com/v1');
		const text = JSON.stringify(pack);
		assert.equal(text.includes('s3cret'), false);
		assert.equal(text.includes('sk-live'), false);
		assert.equal(text.includes('token=abc'), false);
		assert.equal(/\/\/user:/.test(text), false);
	});

	test('classifies private, loopback, link-local, IPv6, and hostname suffixes without DNS', () => {
		const cases: Array<[string, ReturnType<typeof classifyEndpointUrl>]> = [
			['http://10.0.0.1/v1', 'private'],
			['http://10.255.255.255:8080/v1', 'private'],
			['http://172.16.0.1/v1', 'private'],
			['http://172.31.255.255/v1', 'private'],
			['http://172.15.255.255/v1', 'public'],
			['http://172.32.0.1/v1', 'public'],
			['http://192.168.0.1/v1', 'private'],
			['http://169.254.1.1/v1', 'link-local'],
			['http://127.0.0.1/v1', 'loopback'],
			['http://127.255.0.1/v1', 'loopback'],
			['http://8.8.8.8/v1', 'public'],
			['http://0.0.0.0/v1', 'unspecified'],
			['http://[::1]/v1', 'loopback'],
			['http://[::]/v1', 'unspecified'],
			['http://[fe80::1]/v1', 'link-local'],
			['http://[fe80::1%25eth0]/v1', 'link-local'],
			['http://[fc00::1]/v1', 'private'],
			['http://[fd12:3456:789a::1]/v1', 'private'],
			['http://[2001:4860:4860::8888]/v1', 'public'],
			['http://[::ffff:127.0.0.1]/v1', 'loopback'],
			['http://[::ffff:10.1.2.3]/v1', 'private'],
			['http://[::ffff:8.8.8.8]/v1', 'public'],
			['http://localhost/v1', 'loopback'],
			['http://Foo.LocalHost/v1', 'loopback'],
			['http://printer.local/v1', 'link-local'],
			['http://local.example.com/v1', 'public'],
			['http://api.internal/v1', 'public'],
			['https://api.openai.com/v1', 'public'],
		];
		for (const [url, scope] of cases) {
			assert.equal(classifyEndpointUrl(url), scope, url);
			assert.equal(isNonPublicEndpoint(url), scope !== 'public' && scope !== 'invalid', url);
		}
		assert.equal(classifyEndpointHost('localhost'), 'loopback');
		assert.equal(classifyEndpointHost('studio.localhost'), 'loopback');
		assert.equal(classifyEndpointHost('printer.local'), 'link-local');
		assert.equal(classifyEndpointHost('local.example.com'), 'public');
		assert.equal(classifyEndpointHost('::ffff:192.168.1.9'), 'private');
		assert.equal(classifyEndpointHost('2001:4860:4860::8888'), 'public');
		assert.equal(classifyEndpointHost('fe80::1%eth0'), 'link-local');
		assert.equal(classifyEndpointUrl('file:///tmp/weights'), 'unspecified');
	});

	test('default export omits non-public endpoints; includePrivate still strips credentials', () => {
		const rows = [
			overlayRemote('public-openai', 'https://api.openai.com/v1'),
			overlayRemote('lan-10', 'http://10.1.2.3/v1'),
			overlayRemote('lan-172', 'http://172.16.4.5/v1'),
			overlayRemote('lan-192', 'http://user:s3cret@192.168.10.2/v1?api_key=sk-live&keep=1'),
			overlayRemote('link-local', 'http://169.254.10.10/v1'),
			overlayRemote('loopback-v4', 'http://127.0.0.1:8081/v1'),
			overlayRemote('loopback-name', 'http://localhost:9999/v1'),
			overlayRemote('loopback-suffix', 'http://llama.localhost/v1'),
			overlayRemote('mdns', 'http://printer.local/v1'),
			overlayRemote('ipv6-loop', 'http://[::1]/v1'),
			overlayRemote('ipv6-link', 'http://[fe80::1]/v1'),
			overlayRemote('ipv6-ula', 'http://[fd00::1]/v1'),
			overlayRemote('ipv6-mapped-loop', 'http://[::ffff:127.0.0.1]/v1'),
			overlayRemote('public-name', 'http://api.internal/v1'),
			overlayRemote('file-weights', 'file:///tmp/weights'),
			{
				id: 'local-http-chat',
				name: 'Local HTTP chat',
				slug: QWEN_38_27B_ID,
				access: 'local_http' as const,
				runtime: 'llamacpp' as const,
				operations: [...CHAT_AND_CLI_OPERATIONS],
				roles: [...ROLES],
				http: { baseUrl: 'http://127.0.0.1:8081/v1', apiKeyEnv: '' },
				seeded: false as const,
				operationsLocked: false,
			},
		];
		const lanProfile = namedProfile('profile-lan', 'lan-192');
		const seedProfile = namedProfile('profile-seed', QWEN3_VL_ID);
		const localHttpProfile = namedProfile('profile-local-http', 'local-http-chat');

		const closed = previewPackExport(rows, [lanProfile, seedProfile, localHttpProfile]);
		assert.equal(closed.includePrivate, false);
		assert.deepEqual(
			closed.pack.models.map((item) => item.id).sort(),
			['public-name', 'public-openai'],
		);
		assert.equal(closed.includedPrivate.length, 0);
		assert.ok(closed.excludedModels.some((item) => item.id === 'lan-10' && item.reason === 'private'));
		assert.ok(closed.excludedModels.some((item) => item.id === 'lan-172' && item.reason === 'private'));
		assert.ok(closed.excludedModels.some((item) => item.id === 'lan-192' && item.reason === 'private'));
		assert.ok(closed.excludedModels.some((item) => item.id === 'link-local' && item.reason === 'link-local'));
		assert.ok(closed.excludedModels.some((item) => item.id === 'loopback-v4' && item.reason === 'loopback'));
		assert.ok(closed.excludedModels.some((item) => item.id === 'loopback-name' && item.reason === 'loopback'));
		assert.ok(closed.excludedModels.some((item) => item.id === 'loopback-suffix' && item.reason === 'loopback'));
		assert.ok(closed.excludedModels.some((item) => item.id === 'mdns' && item.reason === 'link-local'));
		assert.ok(closed.excludedModels.some((item) => item.id === 'ipv6-loop' && item.reason === 'loopback'));
		assert.ok(closed.excludedModels.some((item) => item.id === 'ipv6-link' && item.reason === 'link-local'));
		assert.ok(closed.excludedModels.some((item) => item.id === 'ipv6-ula' && item.reason === 'private'));
		assert.ok(closed.excludedModels.some((item) => item.id === 'ipv6-mapped-loop' && item.reason === 'loopback'));
		assert.ok(closed.excludedModels.some((item) => item.id === 'file-weights' && item.reason === 'file'));
		assert.ok(closed.excludedModels.some((item) => item.id === 'local-http-chat' && item.reason === 'local_http'));
		const lanNeed = closed.profilesNeedingConfig.find((item) => item.id === 'profile-lan');
		assert.ok(lanNeed);
		assert.ok(lanNeed.excludedModels.some((item) => item.id === 'lan-192' && item.reason === 'private'));
		assert.equal(
			closed.profilesNeedingConfig.some((item) => item.id === 'profile-seed'),
			false,
		);
		const localNeed = closed.profilesNeedingConfig.find((item) => item.id === 'profile-local-http');
		assert.ok(localNeed);
		assert.ok(localNeed.excludedModels.some((item) => item.id === 'local-http-chat'));

		const open = previewPackExport(rows, [lanProfile, seedProfile, localHttpProfile], { includePrivate: true });
		assert.equal(open.includePrivate, true);
		assert.ok(open.pack.models.some((item) => item.id === 'lan-192'));
		assert.ok(open.pack.models.some((item) => item.id === 'ipv6-ula'));
		assert.ok(open.pack.models.some((item) => item.id === 'loopback-name'));
		assert.equal(
			open.pack.models.some((item) => item.id === 'file-weights'),
			false,
		);
		assert.equal(
			open.pack.models.some((item) => item.id === 'local-http-chat'),
			false,
		);
		const lanRow = open.pack.models.find((item) => item.id === 'lan-192');
		assert.equal(lanRow?.http?.baseUrl, 'http://192.168.10.2/v1?keep=1');
		const openText = JSON.stringify(open.pack);
		assert.equal(openText.includes('s3cret'), false);
		assert.equal(openText.includes('sk-live'), false);
		assert.equal(/\/\/user:/.test(openText), false);
		assert.ok(open.includedPrivate.some((item) => item.id === 'lan-192' && item.scope === 'private'));
		assert.ok(open.includedPrivate.some((item) => item.id === 'ipv6-loop' && item.scope === 'loopback'));
		assert.equal(
			open.profilesNeedingConfig.some((item) => item.id === 'profile-lan'),
			false,
		);
		assert.ok(open.profilesNeedingConfig.some((item) => item.id === 'profile-local-http'));
	});

	test('preview lists adds, id conflicts, and missing model refs', () => {
		const pack = samplePack();
		const empty = previewModelPack(pack, SEED_ROWS, []);
		assert.equal(empty.add.length, 3);
		assert.equal(empty.conflicts.length, 0);
		assert.ok(empty.missing.some((item) => item.kind === 'env' && item.ref === 'STUDIO_OPENAI_KEY'));
		assert.equal(empty.missing.some((item) => item.kind === 'model'), false);

		const conflicted = previewModelPack(
			pack,
			[...SEED_ROWS, { ...remoteModel, seeded: false, operationsLocked: false }],
			[{ ...studioProfile, updatedAt: 1 }],
		);
		assert.ok(conflicted.conflicts.some((item) => item.kind === 'model' && item.id === 'studio-gpt4o'));
		assert.ok(conflicted.conflicts.some((item) => item.kind === 'profile' && item.reason === 'id'));

		const missingRef = previewModelPack(
			samplePack({
				profiles: [
					{
						...studioProfile,
						selections: {
							...studioProfile.selections,
							translate: { engine: 'gone-row', model: '' },
						},
					},
				],
			}),
			[],
			[],
		);
		assert.ok(missingRef.missing.some((item) => item.kind === 'model' && item.ref === 'gone-row'));
	});

	test('resolve requires skip or rename and remaps profile refs', () => {
		const pack = samplePack();
		const existingModel = { ...remoteModel, seeded: false, operationsLocked: false };
		const existingProfile = { ...studioProfile, updatedAt: 1 };
		assert.throws(
			() => resolveImport(pack, [...SEED_ROWS, existingModel], [existingProfile], {}),
			/skip or rename/i,
		);
		const skipped = resolveImport(pack, [...SEED_ROWS, existingModel], [existingProfile], {
			models: { 'studio-gpt4o': { action: 'skip' } },
			profiles: { 'profile-studio': { action: 'skip' } },
		});
		assert.equal(skipped.models.some((item) => item.id === 'studio-gpt4o'), false);
		assert.equal(skipped.profiles.length, 0);

		const renamed = resolveImport(pack, [...SEED_ROWS, existingModel], [existingProfile], {
			models: { 'studio-gpt4o': { action: 'rename', id: 'studio-gpt4o-copy', name: 'Studio copy' } },
			profiles: { 'profile-studio': { action: 'rename', id: 'profile-studio-copy', name: 'Studio remote import' } },
		});
		assert.equal(renamed.models.find((item) => item.id === 'studio-gpt4o-copy')?.name, 'Studio copy');
		assert.equal(renamed.profiles[0]?.id, 'profile-studio-copy');
		assert.equal(renamed.profiles[0]?.selections.translate.engine, 'studio-gpt4o-copy');
		assert.throws(
			() =>
				validateResolvedImport(
					resolveImport(
						samplePack({
							profiles: [
								{
									...studioProfile,
									selections: {
										...studioProfile.selections,
										translate: { engine: 'gone-row', model: '' },
									},
								},
							],
						}),
						SEED_ROWS,
						[],
						{},
					),
					SEED_ROWS,
					[],
				),
			/gone-row/,
		);
	});
});

describe('model pack two isolated installations', { concurrency: 1 }, () => {
	test('export/import round trip, conflicts, and failed validation leave dest untouched', async () => {
		useInstall(dataA);
		writeModelOverlay({
			rows: [
				{
					...remoteModel,
					seeded: false,
					operationsLocked: false,
					probes: {
						translate: {
							operation: 'translate',
							ok: true,
							at: 1,
							ms: 99,
							outputPreview: 'secret-output',
						},
					},
				},
				{ ...cliModel, seeded: false, operationsLocked: true },
				{
					id: 'local-only-chat',
					name: 'Local chat',
					slug: QWEN_38_27B_ID,
					access: 'local_http',
					runtime: 'llamacpp',
					operations: [...CHAT_AND_CLI_OPERATIONS],
					roles: [...ROLES],
					http: { baseUrl: 'http://127.0.0.1:8081/v1', apiKeyEnv: '' },
					seeded: false,
					operationsLocked: false,
				},
				{
					id: 'loopback-remote',
					name: 'Loopback remote',
					slug: 'gpt-4o',
					access: 'remote_http',
					runtime: 'openai',
					operations: [...CHAT_AND_CLI_OPERATIONS],
					roles: [...ROLES],
					http: { baseUrl: 'http://localhost:9999/v1', apiKeyEnv: 'STUDIO_OPENAI_KEY' },
					seeded: false,
					operationsLocked: false,
				},
			],
			catalogs: [{ adapter: 'grok', at: 1, models: [{ id: 'secret-slug', label: 'Secret' }] }],
		});
		writeModelProfiles([{ ...studioProfile, updatedAt: 1 }]);
		setCliToolSetting('grok', '/opt/fake-grok');
		process.env.STUDIO_OPENAI_KEY = 'sk-secret';

		const pack = exportModelPack(new Date('2026-09-15T12:00:00.000Z'));
		const packText = JSON.stringify(pack);
		assert.equal(pack.kind, MODEL_PACK_KIND);
		assert.equal(pack.version, MODEL_PACK_VERSION);
		assert.deepEqual(
			pack.models.map((item) => item.id).sort(),
			['grok-custom-beta', 'studio-gpt4o'],
		);
		assert.equal(pack.profiles.length, 1);
		assert.equal(pack.profiles[0]?.id, 'profile-studio');
		assert.equal(/"apiKey"\s*:/.test(packText), false);
		assert.equal(packText.includes('sk-secret'), false);
		assert.equal(packText.includes('probes'), false);
		assert.equal(packText.includes('secret-output'), false);
		assert.equal(packText.includes('/opt/fake-grok'), false);
		assert.equal(packText.includes('127.0.0.1'), false);
		assert.equal(packText.includes('localhost'), false);
		assert.equal(packText.includes('secret-slug'), false);
		assert.equal(pack.models.find((item) => item.id === 'studio-gpt4o')?.http?.apiKeyEnv, 'STUDIO_OPENAI_KEY');
		assert.doesNotMatch(packText, HOST_LEAK);
		assert.deepEqual(parseModelPack(JSON.stringify(pack)).models, pack.models);

		const built = buildModelPack(listRegistryRows(), readModelProfiles());
		assert.deepEqual(
			built.models.map((item) => item.id).sort(),
			pack.models.map((item) => item.id).sort(),
		);

		delete process.env.STUDIO_OPENAI_KEY;
		useInstall(dataB);
		assert.equal(listRegistryRows().some((row) => row.id === 'studio-gpt4o'), false);
		assert.deepEqual(readModelProfiles(), []);
		assert.equal(existsSync(cliToolsPath()), false);

		const preview = previewImportedPack(pack);
		assert.ok(preview.add.some((item) => item.id === 'studio-gpt4o'));
		assert.ok(preview.add.some((item) => item.id === 'profile-studio'));
		assert.equal(preview.conflicts.length, 0);
		assert.ok(preview.missing.some((item) => item.kind === 'env' && item.ref === 'STUDIO_OPENAI_KEY'));

		const applied = applyImportedPack(pack);
		assert.deepEqual(applied.addedModels.sort(), ['grok-custom-beta', 'studio-gpt4o']);
		assert.deepEqual(applied.addedProfiles, ['profile-studio']);
		const destRows = listRegistryRows();
		assert.ok(destRows.some((row) => row.id === 'studio-gpt4o' && row.http?.baseUrl === 'https://api.openai.com/v1'));
		assert.ok(destRows.some((row) => row.id === 'grok-custom-beta' && row.cliAdapter === 'grok'));
		assert.equal(destRows.some((row) => row.id === 'local-only-chat'), false);
		assert.equal(destRows.some((row) => row.id === 'loopback-remote'), false);
		assert.equal(destRows.find((row) => row.id === 'studio-gpt4o')?.probes, undefined);
		assert.deepEqual(readModelProfiles().map((item) => item.id), ['profile-studio']);
		assert.equal(existsSync(cliToolsPath()), false);
		const destText = JSON.stringify({ overlay: readModelOverlay(), profiles: readModelProfiles() });
		assert.doesNotMatch(destText, HOST_LEAK);
		assert.equal(destText.includes('sk-secret'), false);

		const roundTrip = exportModelPack();
		assert.deepEqual(
			roundTrip.models.map((item) => ({ ...item, disabled: item.disabled || undefined })),
			pack.models.map((item) => ({ ...item, disabled: item.disabled || undefined })),
		);
		assert.deepEqual(
			roundTrip.profiles.map((item) => ({ id: item.id, name: item.name, selections: item.selections })),
			pack.profiles.map((item) => ({ id: item.id, name: item.name, selections: item.selections })),
		);

		const beforeConflict = await snapshot(dataB);
		assert.throws(() => applyImportedPack(pack), ModelPackError);
		assert.deepEqual(await snapshot(dataB), beforeConflict);

		const skipped = applyImportedPack(pack, {
			models: { 'studio-gpt4o': { action: 'skip' }, 'grok-custom-beta': { action: 'skip' } },
			profiles: { 'profile-studio': { action: 'skip' } },
		});
		assert.deepEqual(skipped.addedModels, []);
		assert.deepEqual(skipped.addedProfiles, []);
		assert.equal(listRegistryRows().filter((row) => row.id === 'studio-gpt4o').length, 1);
		assert.equal(readModelProfiles().length, 1);

		const renamed = applyImportedPack(pack, {
			models: {
				'studio-gpt4o': { action: 'rename', id: 'studio-gpt4o-copy' },
				'grok-custom-beta': { action: 'rename', id: 'grok-custom-beta-copy' },
			},
			profiles: { 'profile-studio': { action: 'rename', id: 'profile-studio-copy', name: 'Studio remote import' } },
		});
		assert.deepEqual(renamed.addedModels.sort(), ['grok-custom-beta-copy', 'studio-gpt4o-copy']);
		const afterRename = listRegistryRows();
		assert.ok(afterRename.some((row) => row.id === 'studio-gpt4o'));
		assert.ok(afterRename.some((row) => row.id === 'studio-gpt4o-copy'));
		const copyProfile = readModelProfiles().find((item) => item.id === 'profile-studio-copy');
		assert.equal(copyProfile?.selections.translate.engine, 'studio-gpt4o-copy');
		assert.equal(readModelProfiles().find((item) => item.id === 'profile-studio')?.selections.translate.engine, 'studio-gpt4o');

		const beforeBad = await snapshot(dataB);
		const badPack = samplePack({
			models: [remoteModel],
			profiles: [
				{
					...studioProfile,
					id: 'profile-missing',
					name: 'Missing dep',
					selections: {
						...studioProfile.selections,
						translate: { engine: 'gone-row', model: '' },
					},
				},
			],
		});
		assert.throws(() => applyImportedPack(badPack, {
			models: { 'studio-gpt4o': { action: 'skip' } },
		}), /gone-row/);
		assert.deepEqual(await snapshot(dataB), beforeBad);
	});
});
