import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proofreaderOnlyMessage } from '../src/lib/proofreaders';
import {
	runCompactSceneNotes,
	type CompactNotesHandlers,
	type CompactNotesRow,
} from '../src/lib/server/compactNotes';

// These tests inject fake local handlers, but the local branch reserves a managed
// model before delegating. Mark the seed rows as unmanaged so nothing is reserved.
const { SEED_ROWS } = await import('../src/lib/modelRegistry');
const { setEffectiveManagedRow } = await import('../src/lib/server/modelUsage');
for (const row of SEED_ROWS) setEffectiveManagedRow(row.id, { ...row, managedLaunch: undefined });


const rows: CompactNotesRow[] = [
	{ i: 0, caption: 'Night market alley. Two runners enter.' },
	{ i: 2, caption: 'The stall keeper points left.' },
];

function trackers() {
	const calls: { kind: 'cli' | 'local'; engine?: string; rows: CompactNotesRow[]; opts: { abort?: AbortSignal; model?: string } }[] = [];
	const handlers: CompactNotesHandlers = {
		async cli(engine, nextRows, opts) {
			calls.push({ kind: 'cli', engine, rows: nextRows, opts });
			return { chapter: `${engine}-chapter`, pages: nextRows.map((row) => ({ ...row, caption: `${engine}:${row.caption}` })) };
		},
		async local(nextRows, opts) {
			calls.push({ kind: 'local', rows: nextRows, opts });
			return { chapter: 'qwen-chapter', pages: nextRows.map((row) => ({ ...row, caption: `qwen:${row.caption}` })) };
		},
	};
	return { calls, handlers };
}

test('compact notes call only the matching CLI or local implementation', async () => {
	const { calls, handlers } = trackers();
	for (const engine of ['grok', 'codex', 'cursor'] as const) {
		calls.length = 0;
		const out = await runCompactSceneNotes(engine, rows, { model: 'chosen-model' }, handlers);
		assert.deepEqual(calls.map((call) => [call.kind, call.engine]), [['cli', engine]]);
		assert.equal(out.chapter, `${engine}-chapter`);
		assert.equal(out.pages[0].caption, `${engine}:${rows[0].caption}`);
	}
	calls.length = 0;
	const local = await runCompactSceneNotes('qwen', rows, { model: 'local-model' }, handlers);
	assert.deepEqual(calls.map((call) => [call.kind, call.engine]), [['local', undefined]]);
	assert.equal(local.chapter, 'qwen-chapter');
});

test('compact notes keep model, abort and page captions attached to their indexes', async () => {
	const { calls, handlers } = trackers();
	const abort = new AbortController().signal;
	const before = structuredClone(rows);
	await runCompactSceneNotes('codex', rows, { model: 'chosen-model', abort }, handlers);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].opts.model, 'chosen-model');
	assert.equal(calls[0].opts.abort, abort);
	assert.deepEqual(calls[0].rows, before);
	assert.deepEqual(rows, before);
	assert.deepEqual(calls[0].rows.map((row) => row.i), [0, 2]);
});

test('a proofreader and unknown engines are rejected before compacting notes', async () => {
	for (const engine of ['proofreader-a', 'unknown', 'claude', '']) {
		const { calls, handlers } = trackers();
		await assert.rejects(
			runCompactSceneNotes(engine, rows, { model: 'chosen-model' }, handlers),
			engine === 'proofreader-a'
				? { message: proofreaderOnlyMessage('proofreader-a', 'scene-note compaction') }
				: /Unsupported translation engine/,
		);
		assert.equal(calls.length, 0);
	}
});

test('compact-notes runtime errors do not fall back to the other implementation', async () => {
	let localCalls = 0;
	await assert.rejects(runCompactSceneNotes('grok', rows, {}, {
		async cli() { throw new Error('Grok CLI not found'); },
		async local() { localCalls++; return { chapter: '', pages: [] }; },
	}), /Grok CLI not found/);
	assert.equal(localCalls, 0);

	let cliCalls = 0;
	await assert.rejects(runCompactSceneNotes('qwen', rows, {}, {
		async cli() { cliCalls++; return { chapter: '', pages: [] }; },
		async local() { throw new Error('LLAMASWAP_API_KEY is not set'); },
	}), /LLAMASWAP_API_KEY/);
	assert.equal(cliCalls, 0);
});

test('an already-cancelled compact-notes request never reaches handlers', async () => {
	const { calls, handlers } = trackers();
	await assert.rejects(runCompactSceneNotes('qwen', rows, { abort: AbortSignal.abort() }, handlers));
	await assert.rejects(runCompactSceneNotes('cursor', rows, { abort: AbortSignal.abort() }, handlers));
	assert.equal(calls.length, 0);
});
