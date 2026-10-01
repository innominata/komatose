import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	ADVISORY_PROOFREADER_MESSAGE,
	runAdvisory,
	type AdvisoryHandlers,
	type AdvisoryOpts,
} from '../src/lib/server/advisory';

// The local branch of runAdvisory reserves a managed model before delegating.
// These tests inject fake handlers, so mark the local row as not managed.
const { QWEN_38_27B_ID } = await import('../src/lib/qwenModels');
const { seedRow } = await import('../src/lib/modelRegistry');
const { setEffectiveManagedRow } = await import('../src/lib/server/modelUsage');
const local = seedRow(QWEN_38_27B_ID);
if (local) setEffectiveManagedRow(local.id, { ...local, managedLaunch: undefined });

const jpeg = Buffer.from('fake-jpeg');
const schema = { type: 'object', properties: { answer: { type: 'string' } } };

const opts: AdvisoryOpts = {
	system: 'You are an adviser.',
	prompt: 'What does this line mean?',
	images: [jpeg],
	schema,
	model: 'chosen-model',
};

function trackers() {
	const calls: { kind: 'cli' | 'local'; engine?: string; opts: AdvisoryOpts }[] = [];
	const handlers: AdvisoryHandlers = {
		async cli(engine, next) {
			calls.push({ kind: 'cli', engine, opts: next });
			return { answer: `${engine}:${next.prompt}`, engine };
		},
		async local(next) {
			calls.push({ kind: 'local', opts: next });
			return { answer: `qwen:${next.model}`, schema: next.schema };
		},
	};
	return { calls, handlers };
}

test('region-AI advisory selects only the matching CLI or local implementation', async () => {
	const { calls, handlers } = trackers();
	for (const engine of ['grok', 'codex', 'cursor'] as const) {
		calls.length = 0;
		const out = await runAdvisory(engine, opts, handlers) as { answer: string };
		assert.deepEqual(calls.map((call) => [call.kind, call.engine]), [['cli', engine]]);
		assert.equal(out.answer, `${engine}:What does this line mean?`);
	}
	calls.length = 0;
	const local = await runAdvisory('qwen', opts, handlers) as { answer: string };
	assert.deepEqual(calls.map((call) => [call.kind, call.engine]), [['local', undefined]]);
	assert.equal(local.answer, 'qwen:chosen-model');
});

test('region-AI advisory forwards system, prompt, images, schema, model and cancellation', async () => {
	const { calls, handlers } = trackers();
	const abort = new AbortController().signal;
	await runAdvisory('codex', { ...opts, abort }, handlers);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].opts.system, opts.system);
	assert.equal(calls[0].opts.prompt, opts.prompt);
	assert.equal(calls[0].opts.images, opts.images);
	assert.equal(calls[0].opts.images[0], jpeg);
	assert.equal(calls[0].opts.schema, schema);
	assert.equal(calls[0].opts.model, 'chosen-model');
	assert.equal(calls[0].opts.abort, abort);
});

test('a proofreader and unknown engines are rejected before region-AI advisory', async () => {
	for (const engine of ['proofreader-a', 'unknown', 'claude', '']) {
		const { calls, handlers } = trackers();
		await assert.rejects(
			runAdvisory(engine, opts, handlers),
			engine === 'proofreader-a'
				? { message: ADVISORY_PROOFREADER_MESSAGE }
				: /Unsupported translation engine/,
		);
		assert.equal(calls.length, 0);
	}
});

test('region-AI advisory runtime errors do not fall back to the other implementation', async () => {
	let localCalls = 0;
	await assert.rejects(runAdvisory('grok', opts, {
		async cli() { throw new Error('Grok CLI not found'); },
		async local() { localCalls++; return {}; },
	}), /Grok CLI not found/);
	assert.equal(localCalls, 0);

	let cliCalls = 0;
	await assert.rejects(runAdvisory('qwen', opts, {
		async cli() { cliCalls++; return {}; },
		async local() { throw new Error('LLAMASWAP_API_KEY is not set'); },
	}), /LLAMASWAP_API_KEY/);
	assert.equal(cliCalls, 0);
});

test('an already-cancelled advisory request never reaches handlers', async () => {
	const { calls, handlers } = trackers();
	await assert.rejects(runAdvisory('qwen', { ...opts, abort: AbortSignal.abort() }, handlers));
	await assert.rejects(runAdvisory('cursor', { ...opts, abort: AbortSignal.abort() }, handlers));
	assert.equal(calls.length, 0);
});
