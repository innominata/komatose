import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
	REMOTE_PROVIDERS,
	providerById,
	searchProviders,
	type RemoteProvider,
} from '../src/lib/remoteProviders';
import { parseOpenAiModelList } from '../src/lib/cliModelLists';

// Isolate before server modules load so paths/env snapshot the temp root.
const root = await mkdtemp(join(tmpdir(), 'scan-remote-providers-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.DATABASE_URL = join(root, 'data', 'test.db');
await mkdir(join(root, 'data'), { recursive: true });

const { envVar, invalidateEnvFileCache } = await import('../src/lib/server/envFile');
const { openaiListModels } = await import('../src/lib/server/openaiHttp');
const { normalizeHttpBase } = await import('../src/lib/server/modelConnection');

after(() => {
	// Temp dirs are left for the OS cleaner; no jobs were started here.
});

test('catalog invariants: unique ids, http(s) bases, env names, groups, and depth', () => {
	assert.ok(REMOTE_PROVIDERS.length >= 30, `catalog too small: ${REMOTE_PROVIDERS.length}`);
	const ids = new Set<string>();
	for (const provider of REMOTE_PROVIDERS) {
		assert.ok(!ids.has(provider.id), `duplicate provider id ${provider.id}`);
		ids.add(provider.id);
		assert.ok(
			provider.group === 'global' || provider.group === 'china' || provider.group === 'local',
			`${provider.id} has unknown group ${provider.group}`,
		);
		assert.ok(
			provider.apiKeyEnv === '' || /^[A-Z][A-Z0-9_]*$/.test(provider.apiKeyEnv),
			`${provider.id} key variable is not a valid env name: ${provider.apiKeyEnv}`,
		);
		assert.doesNotThrow(() => new URL(provider.baseUrl), `${provider.id} base URL does not parse`);
		assert.match(provider.baseUrl, /^https?:\/\//, `${provider.id} must use HTTP or HTTPS`);
		assert.ok(
			/\/v1$/i.test(provider.baseUrl) || Boolean(provider.notes),
			`${provider.id} base URL must end with /v1 or explain itself in notes`,
		);
		if (provider.group === 'china')
			assert.ok(!provider.baseUrl.includes('openai.com'), `${provider.id} is not a China endpoint`);
		for (const model of provider.models || []) assert.ok(model.trim().length > 0, `${provider.id} empty model id`);
	}
	for (const group of ['global', 'china', 'local'] as const)
		assert.ok(REMOTE_PROVIDERS.some((provider) => provider.group === group), `${group} group is empty`);
});

test('searchProviders matches name, id, group, base URL, key env and model ids', () => {
	assert.equal(searchProviders('').length, REMOTE_PROVIDERS.length);
	assert.equal(searchProviders('   ').length, REMOTE_PROVIDERS.length);
	assert.equal(searchProviders('deepseek-chat').map((provider) => provider.id).join(), 'deepseek');
	assert.ok(searchProviders('moonshot').some((provider) => provider.id === 'moonshot'));
	assert.ok(searchProviders('dashscope.aliyuncs.com').some((provider) => provider.id === 'dashscope'));
	assert.ok(searchProviders('MINIMAX_API_KEY').some((provider) => provider.id === 'minimax'));
	assert.ok(searchProviders('mimo').some((provider) => provider.id === 'xiaomi-mimo'));
	assert.ok(searchProviders('xiaomi').some((provider) => provider.id === 'xiaomi-mimo'));
	assert.equal(providerById('xiaomi-mimo')?.baseUrl, 'https://api.xiaomimimo.com/v1');
	assert.equal(providerById('xiaomi-mimo')?.apiKeyEnv, 'MIMO_API_KEY');
	assert.ok(searchProviders('MoonShOt').some((provider) => provider.id === 'moonshot'));
	assert.equal(searchProviders('no-such-provider-anywhere').length, 0);
	const groupIds = (group: RemoteProvider['group']) =>
		REMOTE_PROVIDERS.filter((provider) => provider.group === group)
			.map((provider) => provider.id)
			.sort();
	assert.deepEqual(searchProviders('china').map((provider) => provider.id).sort(), groupIds('china'));
	assert.deepEqual(searchProviders('local').map((provider) => provider.id).sort(), groupIds('local'));
	assert.deepEqual(searchProviders('global').map((provider) => provider.id).sort(), groupIds('global'));
});

test('providerById resolves catalog entries and misses unknown ids', () => {
	assert.equal(providerById('deepseek')?.baseUrl, 'https://api.deepseek.com/v1');
	assert.equal(providerById('ollama')?.apiKeyEnv, '');
	assert.equal(providerById('does-not-exist'), undefined);
	assert.equal(providerById(''), undefined);
	for (const provider of REMOTE_PROVIDERS) assert.equal(providerById(provider.id), provider);
});

test('probe responses map through parseOpenAiModelList to {id,label} rows', () => {
	assert.deepEqual(parseOpenAiModelList({ data: [{ id: 'm1' }] }), [{ id: 'm1', label: 'm1' }]);
	assert.deepEqual(parseOpenAiModelList({ data: [{ id: 'dup' }, { id: 'dup' }, { id: '' }] }), [
		{ id: 'dup', label: 'dup' },
	]);
	assert.deepEqual(parseOpenAiModelList(['raw', 'list']), [
		{ id: 'raw', label: 'raw' },
		{ id: 'list', label: 'list' },
	]);
	assert.deepEqual(parseOpenAiModelList({ data: 'not-a-list' }), []);
});

test('normalizeHttpBase is exactly what the probe applies to a pasted base URL', () => {
	assert.equal(normalizeHttpBase('https://api.deepseek.com'), 'https://api.deepseek.com/v1');
	assert.equal(normalizeHttpBase('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1');
	assert.equal(normalizeHttpBase('https://qianfan.baidubce.com/v2'), 'https://qianfan.baidubce.com/v2');
	assert.throws(() => normalizeHttpBase(''), /not configured/);
	assert.throws(() => normalizeHttpBase('file:///etc/passwd'), /HTTP or HTTPS/);
	assert.throws(() => normalizeHttpBase('not a url'), /Invalid URL/);
});

type Hit = { url: string; authorization?: string };

async function fakeModels(mode: 'ok' | 'unauthorized' = 'ok') {
	const hits: Hit[] = [];
	const server: Server = createServer((req, res) => {
		hits.push({ url: req.url || '', authorization: req.headers.authorization });
		res.setHeader('content-type', 'application/json');
		if (mode === 'unauthorized') {
			res.statusCode = 401;
			res.end(JSON.stringify({ error: 'invalid_api_key' }));
			return;
		}
		res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as { port: number }).port;
	return {
		hits,
		baseUrl: `http://127.0.0.1:${port}`,
		async close() {
			if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

test('probe path: GET /models lists models on a loopback endpoint with no key', async () => {
	const fake = await fakeModels('ok');
	try {
		// No key: the probe must still call the endpoint and never send a header.
		const baseUrl = normalizeHttpBase(fake.baseUrl);
		const list = await openaiListModels(baseUrl, '', AbortSignal.timeout(2000));
		assert.deepEqual(parseOpenAiModelList(list), [{ id: 'm1', label: 'm1' }]);
		assert.equal(fake.hits.length, 1);
		assert.equal(fake.hits[0].url, '/v1/models');
		assert.equal(fake.hits[0].authorization, undefined);
	} finally {
		await fake.close();
	}
});

test('probe path: unauthorized endpoints fail with HTTP 401 and never echo the key', async () => {
	const fake = await fakeModels('unauthorized');
	const key = 'sk-secret-probe-token';
	try {
		const list = await openaiListModels(normalizeHttpBase(fake.baseUrl), key, AbortSignal.timeout(2000));
		assert.fail(`unexpected success: ${JSON.stringify(list).slice(0, 80)}`);
	} catch (e) {
		assert.match((e as Error).message, /^HTTP 401/);
		assert.equal((e as Error).message.includes(key), false, 'error must not contain key material');
	} finally {
		await fake.close();
	}
});

test('envVar resolves .env values from SCAN_ROOT and reports missing variables as empty', async () => {
	const name = 'REMOTE_PROVIDERS_TEST_KEY';
	delete process.env[name];
	assert.equal(envVar(name), '');
	await writeFile(join(root, '.env'), `${name}=from-dotenv\nREMOTE_PROVIDERS_OTHER_KEY=other\n`);
	invalidateEnvFileCache();
	assert.equal(envVar(name), 'from-dotenv');
	assert.equal(envVar('REMOTE_PROVIDERS_OTHER_KEY'), 'other');
	assert.equal(envVar('REMOTE_PROVIDERS_MISSING_KEY'), '');
	// Live process env wins over the file, matching Admin Test after a restart.
	process.env[name] = 'from-process';
	assert.equal(envVar(name), 'from-process');
	delete process.env[name];
	assert.equal(envVar(name), 'from-dotenv');
});
