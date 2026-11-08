import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = await mkdtemp(join(tmpdir(), 'scan-proofreader-access-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.DATABASE_URL = join(root, 'data', 'test.db');

const { listTranslateEngines } = await import('../src/lib/server/cliTranslate');
const { db } = await import('../src/lib/server/db');
const { users } = await import('../src/lib/server/db/schema');
const {
	assertProofreaderGrant,
	readReportedProofreaders,
} = await import('../src/lib/server/proofreadService');
const {
	readUserSettings,
	saveUserProofreaders,
	hasAnyProofreader,
} = await import('../src/lib/server/userSettings');
const {
	isProofreaderId,
	noteProofreaderOptions,
	proofreaderLabel,
	proofreaderOnlyMessage,
} = await import('../src/lib/proofreaders');

after(() => rm(root, { recursive: true, force: true }));

await db.insert(users).values([
	{ id: 'admin-1', username: 'root', passwordHash: 'unused', role: 'admin', createdAt: 1 },
	{ id: 'granted-1', username: 'granted', passwordHash: 'unused', role: 'proofreader', createdAt: 2 },
	{ id: 'plain-1', username: 'plain', passwordHash: 'unused', role: 'translator', createdAt: 3 },
]);

const engineIds = () => listTranslateEngines().map((engine) => engine.id);

test('translate engines never include proofreaders; the service report is the list', () => {
	assert.deepEqual(engineIds().filter(isProofreaderId), []);
});

test('the service report names the proofreaders, and missing ones are not invented', () => {
	const reported = readReportedProofreaders({
		proofreaders: [
			{ id: 'night-shift', label: 'Night shift', ready: true, context: 'c1', reason: '' },
			{ id: 'desk-b', name: 'Desk B', ready: true, context: '', reason: 'ready' },
			{ id: 'proofreader-a', ready: false, context: '', reason: 'down' },
			{ id: 'proofreader-a', ready: true, context: 'dup', reason: '' },
			{ id: 'not a proofreader', ready: true },
			{ id: 'qwen', ready: true },
			{ id: 'claude', ready: true },
			{ id: 'hayai-ocr-v2', ready: true },
			{ id: '', ready: true },
		],
	});
	assert.deepEqual(reported.map((item) => item.id), ['night-shift', 'desk-b', 'proofreader-a']);
	assert.equal(reported.some((item) => item.id === 'proofreader-b'), false);
	assert.equal(reported[0]?.label, 'Night shift');
	assert.equal(reported[0]?.named, true);
	assert.equal(reported[1]?.label, 'Desk B');
	assert.equal(reported[1]?.named, true);
	assert.equal(reported[2]?.label, 'Proofreader A');
	assert.equal(reported[2]?.named, false);
	assert.equal(reported[2]?.ready, false);
	assert.equal(isProofreaderId('night-shift'), false);
	noteProofreaderOptions(reported.map((item) => ({ id: item.id, label: item.label })));
	assert.equal(isProofreaderId('night-shift'), true);
	assert.equal(proofreaderLabel('night-shift'), 'Night shift');
	assert.equal(proofreaderLabel('proofreader-a'), 'Proofreader A');
	assert.equal(isProofreaderId('not-a-proofreader'), false);
	assert.equal(isProofreaderId('qwen'), false);
	assert.equal(isProofreaderId('hayai-ocr-v2'), false);
});

test('proofreaders are proofread-only, never a translation engine', () => {
	for (const id of ['proofreader-a', 'proofreader-b']) {
		assert.equal(isProofreaderId(id), true);
		assert.match(proofreaderOnlyMessage(id, 'translation'), /only for Proofread raw \+ typeset images/);
	}
	assert.equal(isProofreaderId('gpt-5.4'), false);
});

test('a grant is off until an admin adds it, and defaults to none', () => {
	assert.deepEqual(readUserSettings('plain-1').proofreaders, []);
	assert.equal(hasAnyProofreader('plain-1'), false);

	saveUserProofreaders('plain-1', ['proofreader-b']);
	assert.deepEqual(readUserSettings('plain-1').proofreaders, ['proofreader-b']);
	assert.equal(hasAnyProofreader('plain-1'), true);

	// Unknown ids are dropped rather than persisted.
	saveUserProofreaders('plain-1', ['proofreader-b', 'not-a-proofreader']);
	assert.deepEqual(readUserSettings('plain-1').proofreaders, ['proofreader-b']);

	saveUserProofreaders('plain-1', []);
	assert.equal(hasAnyProofreader('plain-1'), false);
});

test('access checks reject an ungranted user and accept a granted one or an admin', () => {
	assert.throws(
		() => assertProofreaderGrant({ id: 'plain-1', role: 'translator' }, 'proofreader-a'),
		/do not have access/,
	);
	assert.doesNotThrow(() => assertProofreaderGrant({ id: 'admin-1', role: 'admin' }, 'proofreader-a'));

	saveUserProofreaders('granted-1', ['proofreader-a']);
	assert.doesNotThrow(() => assertProofreaderGrant({ id: 'granted-1', role: 'proofreader' }, 'proofreader-a'));
	assert.throws(
		() => assertProofreaderGrant({ id: 'granted-1', role: 'proofreader' }, 'proofreader-b'),
		/do not have access/,
	);
	assert.throws(() => assertProofreaderGrant(null, 'proofreader-a'), /Sign in required/);
});
