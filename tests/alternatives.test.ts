import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proofreaderOnlyMessage } from '../src/lib/proofreaders';
import {
	runAlternatives,
	type AlternativesHandlers,
	type AlternativesOpts,
} from '../src/lib/server/alternatives';

// These tests inject fake local handlers, but the local branch reserves a managed
// model before delegating. Mark the seed rows as unmanaged so nothing is reserved.
const { SEED_ROWS } = await import('../src/lib/modelRegistry');
const { setEffectiveManagedRow } = await import('../src/lib/server/modelUsage');
for (const row of SEED_ROWS) setEffectiveManagedRow(row.id, { ...row, managedLaunch: undefined });


const opts: AlternativesOpts = {
	seriesNotes: 'Scene notes',
	seriesGlossary: '太郎 → Taro',
	prior: 'Previous page',
	pages: 'Page 3',
	script: 'Complete chapter script',
	source: '待って！',
	current: 'Wait!',
	fresh: 'Hold on!',
	lineType: '""',
	page: 'Page 3',
	lang: 'japanese',
	model: 'chosen-model',
};

function trackers() {
	const calls: { kind: 'cli' | 'local'; engine?: string; opts: AlternativesOpts }[] = [];
	const handlers: AlternativesHandlers = {
		async cli(engine, next) {
			calls.push({ kind: 'cli', engine, opts: next });
			return [{ translation: `${engine}:${next.source}`, reasoning: engine }];
		},
		async local(next) {
			calls.push({ kind: 'local', opts: next });
			return [{ translation: `qwen:${next.current}`, reasoning: next.model || '' }];
		},
	};
	return { calls, handlers };
}

test('alternative phrasing selects only the matching CLI or local implementation', async () => {
	const { calls, handlers } = trackers();
	for (const engine of ['grok', 'codex', 'cursor'] as const) {
		calls.length = 0;
		const out = await runAlternatives(engine, opts, handlers);
		assert.deepEqual(calls.map((call) => [call.kind, call.engine]), [['cli', engine]]);
		assert.equal(out[0].translation, `${engine}:待って！`);
	}
	calls.length = 0;
	const local = await runAlternatives('qwen', opts, handlers);
	assert.deepEqual(calls.map((call) => [call.kind, call.engine]), [['local', undefined]]);
	assert.equal(local[0].translation, 'qwen:Wait!');
});

test('alternative phrasing forwards source, current, pack fields, model and cancellation', async () => {
	const { calls, handlers } = trackers();
	const abort = new AbortController().signal;
	await runAlternatives('codex', { ...opts, abort }, handlers);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].opts.source, '待って！');
	assert.equal(calls[0].opts.current, 'Wait!');
	assert.equal(calls[0].opts.fresh, 'Hold on!');
	assert.equal(calls[0].opts.seriesNotes, opts.seriesNotes);
	assert.equal(calls[0].opts.seriesGlossary, opts.seriesGlossary);
	assert.equal(calls[0].opts.script, opts.script);
	assert.equal(calls[0].opts.lang, 'japanese');
	assert.equal(calls[0].opts.model, 'chosen-model');
	assert.equal(calls[0].opts.lineType, '""');
	assert.equal(calls[0].opts.abort, abort);
});

test('a proofreader and unknown engines are rejected before alternative phrasing', async () => {
	for (const engine of ['proofreader-a', 'unknown', 'claude', '']) {
		const { calls, handlers } = trackers();
		await assert.rejects(
			runAlternatives(engine, opts, handlers),
			engine === 'proofreader-a'
				? { message: proofreaderOnlyMessage('proofreader-a', 'alternative translations') }
				: /Unsupported translation engine/,
		);
		assert.equal(calls.length, 0);
	}
});

test('alternative-phrasing runtime errors do not fall back to the other implementation', async () => {
	let localCalls = 0;
	await assert.rejects(runAlternatives('grok', opts, {
		async cli() { throw new Error('Grok CLI not found'); },
		async local() { localCalls++; return []; },
	}), /Grok CLI not found/);
	assert.equal(localCalls, 0);

	let cliCalls = 0;
	await assert.rejects(runAlternatives('qwen', opts, {
		async cli() { cliCalls++; return []; },
		async local() { throw new Error('LLAMASWAP_API_KEY is not set'); },
	}), /LLAMASWAP_API_KEY/);
	assert.equal(cliCalls, 0);
});

test('an already-cancelled alternatives request never reaches handlers', async () => {
	const { calls, handlers } = trackers();
	await assert.rejects(runAlternatives('qwen', { ...opts, abort: AbortSignal.abort() }, handlers));
	await assert.rejects(runAlternatives('cursor', { ...opts, abort: AbortSignal.abort() }, handlers));
	assert.equal(calls.length, 0);
});
