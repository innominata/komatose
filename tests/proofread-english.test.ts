import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proofreaderOnlyMessage } from '../src/lib/proofreaders';
import type { ProofreadItem } from '../src/lib/server/llm';
import {
	runProofreadEnglish,
	type ProofreadEnglishHandlers,
	type ProofreadEnglishOpts,
} from '../src/lib/server/proofreadEnglish';

// These tests inject fake local handlers, but the local branch reserves a managed
// model before delegating. Mark the seed rows as unmanaged so nothing is reserved.
const { SEED_ROWS } = await import('../src/lib/modelRegistry');
const { setEffectiveManagedRow } = await import('../src/lib/server/modelUsage');
for (const row of SEED_ROWS) setEffectiveManagedRow(row.id, { ...row, managedLaunch: undefined });


const items: ProofreadItem[] = [
	{
		i: 0,
		page: 'page 1/2',
		lineType: '""',
		source: '待って！',
		literal: 'Wait!',
		current: 'Hold on!',
		notes: 'urgent',
	},
];

const opts: ProofreadEnglishOpts = {
	seriesNotes: 'Scene notes',
	seriesGlossary: '太郎 → Taro',
	prior: 'Previous page',
	pages: 'This page:\nA hallway',
	settled: '[0] ("") Hold on!',
	lang: 'japanese',
	model: 'chosen-model',
};

function trackers() {
	const calls: {
		kind: 'cli' | 'local';
		engine?: string;
		items: ProofreadItem[];
		opts: ProofreadEnglishOpts;
	}[] = [];
	const handlers: ProofreadEnglishHandlers = {
		async cli(engine, nextItems, next) {
			calls.push({ kind: 'cli', engine, items: nextItems, opts: next });
			return new Map([[nextItems[0].i, { translation: `${engine}:${nextItems[0].current}`, reasoning: engine }]]);
		},
		async local(nextItems, next) {
			calls.push({ kind: 'local', items: nextItems, opts: next });
			return new Map([[nextItems[0].i, { translation: `qwen:${next.settled}`, reasoning: next.model || '' }]]);
		},
	};
	return { calls, handlers };
}

test('proofread edited English selects only the matching CLI or local implementation', async () => {
	const { calls, handlers } = trackers();
	for (const engine of ['grok', 'codex', 'cursor'] as const) {
		calls.length = 0;
		const out = await runProofreadEnglish(engine, items, opts, handlers);
		assert.deepEqual(calls.map((call) => [call.kind, call.engine]), [['cli', engine]]);
		assert.equal(out.get(0)?.translation, `${engine}:Hold on!`);
	}
	calls.length = 0;
	const local = await runProofreadEnglish('qwen', items, opts, handlers);
	assert.deepEqual(calls.map((call) => [call.kind, call.engine]), [['local', undefined]]);
	assert.equal(local.get(0)?.translation, 'qwen:[0] ("") Hold on!');
});

test('proofread edited English forwards items, pack fields, model and cancellation', async () => {
	const { calls, handlers } = trackers();
	const abort = new AbortController().signal;
	await runProofreadEnglish('codex', items, { ...opts, abort }, handlers);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].items, items);
	assert.equal(calls[0].items[0].i, 0);
	assert.equal(calls[0].items[0].source, '待って！');
	assert.equal(calls[0].items[0].current, 'Hold on!');
	assert.equal(calls[0].opts.seriesNotes, opts.seriesNotes);
	assert.equal(calls[0].opts.seriesGlossary, opts.seriesGlossary);
	assert.equal(calls[0].opts.prior, opts.prior);
	assert.equal(calls[0].opts.pages, opts.pages);
	assert.equal(calls[0].opts.settled, opts.settled);
	assert.equal(calls[0].opts.lang, 'japanese');
	assert.equal(calls[0].opts.model, 'chosen-model');
	assert.equal(calls[0].opts.abort, abort);
});

test('a proofreader and unknown engines are rejected before proofread edited English', async () => {
	for (const engine of ['proofreader-a', 'unknown', 'claude', '']) {
		const { calls, handlers } = trackers();
		await assert.rejects(
			runProofreadEnglish(engine, items, opts, handlers),
			engine === 'proofreader-a'
				? { message: proofreaderOnlyMessage('proofreader-a', 'Proofread edited English') }
				: /Unsupported translation engine/,
		);
		assert.equal(calls.length, 0);
	}
});

test('proofread-edited-English runtime errors do not fall back to the other implementation', async () => {
	let localCalls = 0;
	await assert.rejects(runProofreadEnglish('grok', items, opts, {
		async cli() { throw new Error('Grok CLI not found'); },
		async local() { localCalls++; return new Map(); },
	}), /Grok CLI not found/);
	assert.equal(localCalls, 0);

	let cliCalls = 0;
	await assert.rejects(runProofreadEnglish('qwen', items, opts, {
		async cli() { cliCalls++; return new Map(); },
		async local() { throw new Error('LLAMASWAP_API_KEY is not set'); },
	}), /LLAMASWAP_API_KEY/);
	assert.equal(cliCalls, 0);
});

test('an already-cancelled proofread request never reaches handlers', async () => {
	const { calls, handlers } = trackers();
	await assert.rejects(runProofreadEnglish('qwen', items, { ...opts, abort: AbortSignal.abort() }, handlers));
	await assert.rejects(runProofreadEnglish('cursor', items, { ...opts, abort: AbortSignal.abort() }, handlers));
	assert.equal(calls.length, 0);
});
