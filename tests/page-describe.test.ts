import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proofreaderOnlyMessage } from '../src/lib/proofreaders';
import { QWEN3_VL_ID } from '../src/lib/qwenModels';
import {
	runDescribePage,
	type DescribePageHandlers,
	type DescribePageOpts,
} from '../src/lib/server/pageDescribe';

// These tests inject fake local handlers, but the local branch reserves a managed
// model before delegating. Mark the seed rows as unmanaged so nothing is reserved.
const { SEED_ROWS } = await import('../src/lib/modelRegistry');
const { setEffectiveManagedRow } = await import('../src/lib/server/modelUsage');
for (const row of SEED_ROWS) setEffectiveManagedRow(row.id, { ...row, managedLaunch: undefined });


const jpeg = Buffer.from('page-jpeg');

function trackers() {
	const calls: { kind: 'cli' | 'local' | 'qwen3vl'; engine?: string; opts: DescribePageOpts }[] = [];
	const handlers: DescribePageHandlers = {
		async cli(engine, opts) {
			calls.push({ kind: 'cli', engine, opts });
			return `${engine}:note`;
		},
		async local(opts) {
			calls.push({ kind: 'local', opts });
			return `qwen:${opts.model || 'default'}`;
		},
		async qwen3vl(opts) {
			calls.push({ kind: 'qwen3vl', opts });
			return 'qwen3vl:note';
		},
	};
	return { calls, handlers };
}

test('page description selects CLI, local Qwen, or Qwen3-VL only', async () => {
	const { calls, handlers } = trackers();
	for (const engine of ['grok', 'codex', 'cursor'] as const) {
		calls.length = 0;
		assert.equal(await runDescribePage(engine, { jpeg, model: 'chosen-model' }, handlers), `${engine}:note`);
		assert.deepEqual(calls.map((call) => [call.kind, call.engine]), [['cli', engine]]);
	}
	calls.length = 0;
	assert.equal(await runDescribePage('qwen', { jpeg, model: 'qwen3.8-27b-q4' }, handlers), 'qwen:qwen3.8-27b-q4');
	assert.deepEqual(calls.map((call) => call.kind), ['local']);

	calls.length = 0;
	assert.equal(await runDescribePage('qwen', { jpeg, model: QWEN3_VL_ID }, handlers), 'qwen3vl:note');
	assert.deepEqual(calls.map((call) => call.kind), ['qwen3vl']);

	calls.length = 0;
	assert.equal(await runDescribePage('grok', { jpeg, model: QWEN3_VL_ID }, handlers), 'grok:note');
	assert.deepEqual(calls.map((call) => [call.kind, call.engine]), [['cli', 'grok']]);
});

test('page description forwards jpeg, model and cancellation', async () => {
	const { calls, handlers } = trackers();
	const abort = new AbortController().signal;
	await runDescribePage('codex', { jpeg, model: 'chosen-model', abort }, handlers);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].opts.jpeg, jpeg);
	assert.equal(calls[0].opts.model, 'chosen-model');
	assert.equal(calls[0].opts.abort, abort);
});

test('a proofreader and unknown engines are rejected before page description', async () => {
	for (const engine of ['proofreader-a', 'unknown', 'claude', '']) {
		const { calls, handlers } = trackers();
		await assert.rejects(
			runDescribePage(engine, { jpeg, model: 'chosen-model' }, handlers),
			engine === 'proofreader-a'
				? { message: proofreaderOnlyMessage('proofreader-a', 'page description') }
				: /Unsupported translation engine/,
		);
		assert.equal(calls.length, 0);
	}
});

test('page-description runtime errors do not fall back to another implementation', async () => {
	let local = 0;
	let qwen3vl = 0;
	let cli = 0;
	await assert.rejects(runDescribePage('grok', { jpeg }, {
		async cli() { throw new Error('Grok CLI not found'); },
		async local() { local++; return ''; },
		async qwen3vl() { qwen3vl++; return ''; },
	}), /Grok CLI not found/);
	assert.equal(local, 0);
	assert.equal(qwen3vl, 0);

	await assert.rejects(runDescribePage('qwen', { jpeg, model: QWEN3_VL_ID }, {
		async cli() { cli++; return ''; },
		async local() { local++; return ''; },
		async qwen3vl() { throw new Error('Qwen3-VL unavailable'); },
	}), /Qwen3-VL unavailable/);
	assert.equal(cli, 0);
	assert.equal(local, 0);

	await assert.rejects(runDescribePage('qwen', { jpeg, model: 'qwen3.8-27b-q4' }, {
		async cli() { cli++; return ''; },
		async local() { throw new Error('LLAMASWAP_API_KEY is not set'); },
		async qwen3vl() { qwen3vl++; return ''; },
	}), /LLAMASWAP_API_KEY/);
	assert.equal(cli, 0);
	assert.equal(qwen3vl, 0);
});

test('an already-cancelled page description never reaches handlers', async () => {
	const { calls, handlers } = trackers();
	await assert.rejects(runDescribePage('qwen', { jpeg, abort: AbortSignal.abort() }, handlers));
	await assert.rejects(runDescribePage('cursor', { jpeg, abort: AbortSignal.abort() }, handlers));
	assert.equal(calls.length, 0);
});
