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
	proofreadServiceConfigured,
} = await import('../src/lib/server/proofreadService');
const {
	readUserSettings,
	saveUserProofreaders,
	hasAnyProofreader,
} = await import('../src/lib/server/userSettings');
const { PROOFREADER_IDS, isProofreaderId, proofreaderOnlyMessage } = await import('../src/lib/proofreaders');

after(() => rm(root, { recursive: true, force: true }));

await db.insert(users).values([
	{ id: 'admin-1', username: 'root', passwordHash: 'unused', role: 'admin', createdAt: 1 },
	{ id: 'granted-1', username: 'granted', passwordHash: 'unused', role: 'proofreader', createdAt: 2 },
	{ id: 'plain-1', username: 'plain', passwordHash: 'unused', role: 'translator', createdAt: 3 },
]);

const engineIds = () => listTranslateEngines().map((engine) => engine.id);
const configured = proofreadServiceConfigured();

test('no service means no proofreader is ever offered', () => {
	if (configured) {
		assert.ok(engineIds().some(isProofreaderId), 'a configured service should offer proofreaders');
		return;
	}
	assert.deepEqual(engineIds().filter(isProofreaderId), []);
});

test('proofreaders are proofread-only, never a translation engine', () => {
	for (const id of PROOFREADER_IDS) {
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
