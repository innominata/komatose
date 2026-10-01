import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { test } from 'node:test';
import { chatCompletions } from '../src/lib/server/llm';
import {
	openaiListModels,
	withAssistantHttp,
	type AssistantHttpConfig,
	type HttpProfile,
} from '../src/lib/server/openaiHttp';

const SCHEMA = {
	type: 'json_schema',
	json_schema: {
		name: 'scan_contract',
		strict: true,
		schema: { type: 'object', additionalProperties: false, properties: {} },
	},
};

const MESSAGES = [{ role: 'user' as const, content: 'hi' }];
const FAIL = /abort|Cancel|JSON|Unexpected token|not-json|401|502|empty content|not set|timed out|llama-swap/i;

type Mode = 'ok' | 'malformed' | 'empty' | 'unauthorized' | 'unavailable' | 'hang';

type Hit = {
	url: string;
	authorization?: string;
	body: Record<string, unknown>;
};

async function readBody(req: IncomingMessage) {
	let raw = '';
	for await (const chunk of req) raw += chunk;
	if (!raw) return {};
	return JSON.parse(raw) as Record<string, unknown>;
}

async function fakeHttp(mode: Mode = 'ok') {
	const hits: Hit[] = [];
	const server: Server = createServer(async (req, res) => {
		const url = req.url || '';
		let body: Record<string, unknown> = {};
		if (req.method === 'POST') {
			try {
				body = await readBody(req);
			} catch {
				body = { parseError: true };
			}
		}
		hits.push({ url, authorization: req.headers.authorization, body });
		if (mode === 'hang') {
			await new Promise((resolve) => setTimeout(resolve, 400));
			if (!res.writableEnded) {
				res.statusCode = 504;
				res.end(JSON.stringify({ error: 'hang' }));
			}
			return;
		}
		res.setHeader('content-type', 'application/json');
		if (mode === 'unauthorized') {
			res.statusCode = 401;
			res.end(JSON.stringify({ error: 'invalid_api_key' }));
			return;
		}
		if (mode === 'unavailable') {
			res.statusCode = 502;
			res.end(JSON.stringify({ error: 'bad gateway' }));
			return;
		}
		if (mode === 'malformed') {
			res.end('not-json');
			return;
		}
		if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
			res.end(JSON.stringify({ data: [{ id: body.model || 'listed-model' }] }));
			return;
		}
		if (mode === 'empty') {
			res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }));
			return;
		}
		res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as { port: number }).port;
	return {
		hits,
		baseUrl: `http://127.0.0.1:${port}/v1`,
		async close() {
			if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((err) => (err ? reject(err) : resolve())),
			);
		},
	};
}

type Fake = Awaited<ReturnType<typeof fakeHttp>>;

async function withPair(primaryMode: Mode, fn: (primary: Fake, sibling: Fake) => Promise<void>) {
	const primary = await fakeHttp(primaryMode);
	const sibling = await fakeHttp('ok');
	try {
		await fn(primary, sibling);
		assert.equal(sibling.hits.length, 0, 'must not call another HTTP endpoint');
	} finally {
		await primary.close();
		await sibling.close();
	}
}

/** Reusable contract: local llama.cpp and remote OpenAI-compatible chat share these cases. */
export function runHttpEndpointContract(name: string, profile: HttpProfile) {
	const model = `contract-${name}-slug`;
	const apiKey = `sk-${name}-primary`;
	const apiKeyEnv = profile === 'llamacpp' ? 'LLAMASWAP_API_KEY' : 'OPENAI_API_KEY';

	function config(baseUrl: string, extra?: Partial<AssistantHttpConfig>): AssistantHttpConfig {
		return {
			baseUrl,
			apiKey,
			model,
			profile,
			rowId: `row-${name}`,
			apiKeyEnv,
			...extra,
		};
	}

	function chat(
		baseUrl: string,
		extra?: { abort?: AbortSignal; schema?: unknown; apiKey?: string; model?: string },
	) {
		const cfg = config(baseUrl, {
			apiKey: extra?.apiKey ?? apiKey,
			model: extra?.model ?? model,
		});
		return withAssistantHttp(cfg, () =>
			chatCompletions(MESSAGES, {
				model: cfg.model,
				abort: extra?.abort,
				schema: extra?.schema ?? SCHEMA,
			}),
		);
	}

	test(`${name}: successful chat keeps the model id and provider-specific body`, async () => {
		await withPair('ok', async (primary, sibling) => {
			assert.equal(await chat(primary.baseUrl), '{"ok":true}');
			assert.equal(primary.hits.length, 1);
			assert.equal(sibling.hits.length, 0);
			const hit = primary.hits[0];
			assert.equal(hit.url, '/v1/chat/completions');
			assert.equal(hit.body.model, model);
			assert.equal(hit.authorization, `Bearer ${apiKey}`);
			if (profile === 'llamacpp') {
				assert.equal(hit.body.cache_prompt, true);
				assert.equal(hit.body.chat_template_kwargs, undefined);
				assert.deepEqual(hit.body.response_format, SCHEMA);
			} else {
				assert.equal('cache_prompt' in hit.body, false);
				assert.equal('chat_template_kwargs' in hit.body, false);
				assert.deepEqual(hit.body.response_format, { type: 'json_object' });
			}
		});
	});

	test(`${name}: model identifier is forwarded unchanged`, async () => {
		await withPair('ok', async (primary) => {
			const chosen = `${model}-override`;
			await chat(primary.baseUrl, { model: chosen });
			assert.equal(primary.hits[0].body.model, chosen);
			assert.notEqual(primary.hits[0].body.model, 'qwen3.8-27b-q4');
		});
	});

	test(`${name}: credentials go only to the selected endpoint`, async () => {
		await withPair('ok', async (primary, sibling) => {
			await chat(primary.baseUrl);
			assert.equal(primary.hits[0].authorization, `Bearer ${apiKey}`);
			assert.equal(sibling.hits.length, 0);
			assert.match(primary.baseUrl, /127\.0\.0\.1/);
			assert.notEqual(primary.baseUrl, sibling.baseUrl);
		});
	});

	test(`${name}: GET /models uses the selected endpoint credential`, async () => {
		await withPair('ok', async (primary, sibling) => {
			const json = await openaiListModels(primary.baseUrl, apiKey);
			assert.ok(json);
			assert.equal(primary.hits.length, 1);
			assert.equal(primary.hits[0].url, '/v1/models');
			assert.equal(primary.hits[0].authorization, `Bearer ${apiKey}`);
			assert.equal(sibling.hits.length, 0);
		});
	});

	test(`${name}: malformed output fails clearly and does not switch providers`, async () => {
		await withPair('malformed', async (primary) => {
			await assert.rejects(() => chat(primary.baseUrl), FAIL);
			assert.equal(primary.hits.length, 1);
			assert.equal(primary.hits[0].body.model, model);
		});
	});

	test(`${name}: empty content does not switch providers`, async () => {
		await withPair('empty', async (primary) => {
			if (profile === 'openai') {
				await assert.rejects(() => chat(primary.baseUrl), /empty content/);
			} else {
				assert.equal(await chat(primary.baseUrl), '');
			}
			assert.equal(primary.hits.length, 1);
			assert.equal(primary.hits[0].body.model, model);
		});
	});

	test(`${name}: unavailable service fails clearly and does not switch providers`, async () => {
		await withPair('unavailable', async (primary) => {
			await assert.rejects(() => chat(primary.baseUrl), /502|bad gateway|llama-swap/i);
			assert.equal(primary.hits.length, 1);
			assert.equal(primary.hits[0].body.model, model);
		});
	});

	test(`${name}: authentication failure fails clearly and does not switch providers`, async () => {
		await withPair('unauthorized', async (primary) => {
			await assert.rejects(() => chat(primary.baseUrl), /401|invalid_api_key/i);
			assert.equal(primary.hits.length, 1);
			assert.equal(primary.hits[0].authorization, `Bearer ${apiKey}`);
			assert.equal(primary.hits[0].body.model, model);
		});
	});

	test(`${name}: missing API key does not call another endpoint`, async () => {
		await withPair('ok', async (primary) => {
			if (profile === 'openai') {
				await assert.rejects(() => chat(primary.baseUrl, { apiKey: '' }), /OPENAI_API_KEY is not set/);
				assert.equal(primary.hits.length, 0);
			} else {
				assert.equal(await chat(primary.baseUrl, { apiKey: '' }), '{"ok":true}');
				assert.equal(primary.hits.length, 1);
				assert.equal(primary.hits[0].authorization, undefined);
				assert.equal(primary.hits[0].body.model, model);
			}
		});
	});

	test(`${name}: cancellation fails clearly and does not switch providers`, async () => {
		await withPair('ok', async (primary) => {
			await assert.rejects(
				() => chat(primary.baseUrl, { abort: AbortSignal.abort() }),
				/abort|Cancel/i,
			);
		});
	});

	test(`${name}: hang respects abort and does not switch providers`, async () => {
		await withPair('hang', async (primary) => {
			await assert.rejects(
				() => chat(primary.baseUrl, { abort: AbortSignal.timeout(80) }),
				/abort|Cancel|timed out/i,
			);
			assert.ok(primary.hits.length <= 1);
			if (primary.hits[0]) assert.equal(primary.hits[0].body.model, model);
		});
	});
}

runHttpEndpointContract('llamacpp', 'llamacpp');
runHttpEndpointContract('openai', 'openai');

test('cross-path: each HTTP call keeps its own model id and bearer token', async () => {
	const local = await fakeHttp('ok');
	const remote = await fakeHttp('ok');
	try {
		const localText = await withAssistantHttp(
			{
				baseUrl: local.baseUrl,
				apiKey: 'sk-local-only',
				model: 'local-slug',
				profile: 'llamacpp',
				rowId: 'local-row',
				apiKeyEnv: 'LLAMASWAP_API_KEY',
			},
			() => chatCompletions(MESSAGES, { model: 'local-slug' }),
		);
		const remoteText = await withAssistantHttp(
			{
				baseUrl: remote.baseUrl,
				apiKey: 'sk-remote-only',
				model: 'remote-slug',
				profile: 'openai',
				rowId: 'remote-row',
				apiKeyEnv: 'OPENAI_API_KEY',
			},
			() => chatCompletions(MESSAGES, { model: 'remote-slug' }),
		);
		assert.equal(localText, '{"ok":true}');
		assert.equal(remoteText, '{"ok":true}');
		assert.equal(local.hits.length, 1);
		assert.equal(remote.hits.length, 1);
		assert.equal(local.hits[0].authorization, 'Bearer sk-local-only');
		assert.equal(remote.hits[0].authorization, 'Bearer sk-remote-only');
		assert.equal(local.hits[0].body.model, 'local-slug');
		assert.equal(remote.hits[0].body.model, 'remote-slug');
		assert.equal(local.hits[0].body.cache_prompt, true);
		assert.equal('cache_prompt' in remote.hits[0].body, false);
	} finally {
		await local.close();
		await remote.close();
	}
});
