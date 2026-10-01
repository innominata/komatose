import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proofreaderOnlyMessage } from '../src/lib/proofreaders';
import {
	runChapterReview,
	type ChapterReviewHandlers,
	type ChapterReviewOpts,
} from '../src/lib/server/chapterReview';

// These tests inject fake local handlers, but the local branch reserves a managed
// model before delegating. Mark the seed rows as unmanaged so nothing is reserved.
const { SEED_ROWS } = await import('../src/lib/modelRegistry');
const { setEffectiveManagedRow } = await import('../src/lib/server/modelUsage');
for (const row of SEED_ROWS) setEffectiveManagedRow(row.id, { ...row, managedLaunch: undefined });


const payload: ChapterReviewOpts = {
	seriesNotes: 'Scene notes',
	seriesGlossary: '太郎 → Taro',
	prior: 'Previous page',
	pages: 'Page 1',
	script: 'Complete chapter: 2 lines on 1 pages.',
	lang: 'japanese',
	model: 'chosen-model',
};

function trackers() {
	const calls: { kind: 'cli' | 'local'; engine?: string; opts: ChapterReviewOpts }[] = [];
	const handlers: ChapterReviewHandlers = {
		async cli(engine, opts) {
			calls.push({ kind: 'cli', engine, opts });
			return { summary: `${engine}-summary`, issues: [], questions: [], notes: opts.script };
		},
		async local(opts) {
			calls.push({ kind: 'local', opts });
			return { summary: `qwen:${opts.model}`, issues: [], questions: [], notes: opts.seriesNotes };
		},
	};
	return { calls, handlers };
}

test('chapter review selects only the matching CLI or local implementation', async () => {
	const { calls, handlers } = trackers();
	for (const engine of ['grok', 'codex', 'cursor'] as const) {
		calls.length = 0;
		const out = await runChapterReview(engine, payload, handlers);
		assert.deepEqual(calls.map((call) => [call.kind, call.engine]), [['cli', engine]]);
		assert.equal(out.summary, `${engine}-summary`);
	}
	calls.length = 0;
	const local = await runChapterReview('qwen', payload, handlers);
	assert.deepEqual(calls.map((call) => [call.kind, call.engine]), [['local', undefined]]);
	assert.equal(local.summary, 'qwen:chosen-model');
});

test('chapter review forwards pack fields, model, language and cancellation', async () => {
	const { calls, handlers } = trackers();
	const abort = new AbortController().signal;
	await runChapterReview('codex', { ...payload, abort }, handlers);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].opts.seriesNotes, payload.seriesNotes);
	assert.equal(calls[0].opts.seriesGlossary, payload.seriesGlossary);
	assert.equal(calls[0].opts.prior, payload.prior);
	assert.equal(calls[0].opts.pages, payload.pages);
	assert.equal(calls[0].opts.script, payload.script);
	assert.equal(calls[0].opts.lang, 'japanese');
	assert.equal(calls[0].opts.model, 'chosen-model');
	assert.equal(calls[0].opts.abort, abort);
});

test('a proofreader and unknown engines are rejected before chapter review', async () => {
	for (const engine of ['proofreader-a', 'unknown', 'claude', '']) {
		const { calls, handlers } = trackers();
		await assert.rejects(
			runChapterReview(engine, payload, handlers),
			engine === 'proofreader-a'
				? { message: proofreaderOnlyMessage('proofreader-a', 'chapter review') }
				: /Unsupported translation engine/,
		);
		assert.equal(calls.length, 0);
	}
});

test('chapter-review runtime errors do not fall back to the other implementation', async () => {
	let localCalls = 0;
	await assert.rejects(runChapterReview('grok', payload, {
		async cli() { throw new Error('Grok CLI not found'); },
		async local() { localCalls++; return { summary: '', issues: [], questions: [], notes: '' }; },
	}), /Grok CLI not found/);
	assert.equal(localCalls, 0);

	let cliCalls = 0;
	await assert.rejects(runChapterReview('qwen', payload, {
		async cli() { cliCalls++; return { summary: '', issues: [], questions: [], notes: '' }; },
		async local() { throw new Error('LLAMASWAP_API_KEY is not set'); },
	}), /LLAMASWAP_API_KEY/);
	assert.equal(cliCalls, 0);
});

test('an already-cancelled chapter review never reaches handlers', async () => {
	const { calls, handlers } = trackers();
	await assert.rejects(runChapterReview('qwen', { ...payload, abort: AbortSignal.abort() }, handlers));
	await assert.rejects(runChapterReview('cursor', { ...payload, abort: AbortSignal.abort() }, handlers));
	assert.equal(calls.length, 0);
});
