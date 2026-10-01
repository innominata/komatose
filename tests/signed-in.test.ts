import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = await mkdtemp(join(tmpdir(), 'scan-signed-in-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.DATABASE_URL = join(root, 'data', 'test.db');

const { activityLabel, listUserActivity, logActivity } = await import('../src/lib/server/activity');
const { createSession, getUserBySession, SESSION_TOUCH_MS } = await import('../src/lib/server/auth');
const { db } = await import('../src/lib/server/db');
const { activity, sessions, users } = await import('../src/lib/server/db/schema');
const { listSignedInUsers, SIGNED_IN_MS } = await import('../src/lib/server/signedIn');
const { eq } = await import('drizzle-orm');

after(() => rm(root, { recursive: true, force: true }));

await db.insert(users).values([
	{ id: 'admin-1', username: 'root', passwordHash: 'unused', role: 'admin', createdAt: 1 },
	{ id: 'pat-1', username: 'pat', passwordHash: 'unused', role: 'translator', createdAt: 2 },
	{ id: 'idle-1', username: 'idle', passwordHash: 'unused', role: 'typesetter', createdAt: 3 },
]);

test('activity labels use the action, then episode, series, or payload title', () => {
	assert.equal(activityLabel('signed_in', '{}'), 'Signed in');
	assert.equal(activityLabel('signed_out', '{}', 'Lantern', 'Chapter 1'), 'Signed out');
	assert.equal(activityLabel('created_series', '{"title":"Lantern"}'), 'Created series · Lantern');
	assert.equal(activityLabel('updated_series_notes', '{}', 'Lantern', null), 'Updated series notes · Lantern');
	assert.equal(
		activityLabel('renamed_episode', '{}', 'Lantern', 'Chapter 1'),
		'Renamed episode · Chapter 1',
	);
});

test('signed-in list is recent sessions plus each user\'s last 20 actions', async () => {
	const t = Date.now();
	await db.insert(sessions).values([
		{ id: 'sess-admin', userId: 'admin-1', expiresAt: t + 86_400_000, lastSeenAt: t - 1_000 },
		{ id: 'sess-pat', userId: 'pat-1', expiresAt: t + 86_400_000, lastSeenAt: t - 2_000 },
		{ id: 'sess-idle', userId: 'idle-1', expiresAt: t + 86_400_000, lastSeenAt: t - SIGNED_IN_MS - 1_000 },
		{ id: 'sess-expired', userId: 'pat-1', expiresAt: t - 1_000, lastSeenAt: t },
	]);
	for (let i = 0; i < 22; i++) {
		await db.insert(activity).values({
			id: `act-pat-${i}`,
			userId: 'pat-1',
			action: i === 21 ? 'signed_in' : `edit_${i}`,
			payload: '{}',
			createdAt: t - (22 - i) * 1_000,
		});
	}
	await logActivity({ userId: 'admin-1', action: 'created_series', payload: { title: 'Lantern' } });

	const signedIn = await listSignedInUsers(t);
	assert.deepEqual(
		signedIn.map((u) => u.username),
		['root', 'pat'],
	);
	const pat = signedIn.find((u) => u.username === 'pat')!;
	assert.equal(pat.actions.length, 20);
	assert.equal(pat.actions[0].action, 'signed_in');
	assert.equal(pat.actions[0].label, 'Signed in');
	assert.equal(pat.actions.at(-1)?.action, 'edit_2');
	assert.ok(!pat.actions.some((a) => a.action === 'edit_0' || a.action === 'edit_1'));
	const rootUser = signedIn.find((u) => u.username === 'root')!;
	assert.equal(rootUser.actions[0].label, 'Created series · Lantern');
	assert.equal((await listUserActivity('idle-1')).length, 0);
});

test('getUserBySession refreshes last seen when it is stale', async () => {
	const sid = await createSession('idle-1');
	const stale = Date.now() - SESSION_TOUCH_MS - 10_000;
	await db.update(sessions).set({ lastSeenAt: stale }).where(eq(sessions.id, sid));
	const user = await getUserBySession(sid);
	assert.equal(user?.username, 'idle');
	const row = await db.select().from(sessions).where(eq(sessions.id, sid)).get();
	assert.ok(row);
	assert.ok(row.lastSeenAt > stale);
});
