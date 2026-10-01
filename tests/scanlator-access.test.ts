import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ROLES, STAFF_ROLES, TEST_SERIES_SLUG, TEST_SERIES_TITLE } from '../src/lib/types';
import { rowAllowedForRole, type ModelRow } from '../src/lib/modelRegistry';

const root = await mkdtemp(join(tmpdir(), 'scan-scanlator-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.DATABASE_URL = join(root, 'data', 'test.db');

const {
	assignableRoles,
	canAssignRole,
	canClean,
	canCreateSeries,
	canEditTranslations,
	canGrantSeries,
	canManageAccess,
	canManageTargetUser,
	canManageUsers,
	canUpload,
	ensureTestSeries,
	grantSeriesMembership,
	grantTestSeriesAccess,
	hasSeriesAccess,
	isTestSeries,
} = await import('../src/lib/server/access');
const { createUser } = await import('../src/lib/server/auth');
const { requireClean, requireEdit, requireManageUsers, requireUpload } = await import('../src/lib/server/http');
const { db } = await import('../src/lib/server/db');
const { series, seriesMembers, users } = await import('../src/lib/server/db/schema');
const { listSeriesForUser } = await import('../src/lib/server/queries');
const { eq } = await import('drizzle-orm');

after(() => rm(root, { recursive: true, force: true }));

const admin = { id: 'admin-1', username: 'root', role: 'admin' as const };
const scanlator = { id: 'scan-1', username: 'guest', role: 'scanlator' as const };
const translator = { id: 'tr-1', username: 'pat', role: 'translator' as const };

function model(roles: ModelRow['roles'], extra: Partial<ModelRow> = {}): ModelRow {
	return {
		id: extra.id || 'm',
		name: 'Model',
		slug: 'model',
		access: 'local_http',
		runtime: 'llamacpp',
		operations: ['translate'],
		roles,
		seeded: true,
		operationsLocked: false,
		disabled: false,
		...extra,
	};
}

test('scanlator is a first-class role with full workflow and no backend control', () => {
	assert.deepEqual(ROLES, ['admin', 'scanlator', 'translator', 'proofreader', 'typesetter']);
	assert.deepEqual(STAFF_ROLES, ['translator', 'proofreader', 'typesetter']);

	assert.equal(canManageUsers(admin), true);
	assert.equal(canManageUsers(scanlator), false);
	assert.equal(canManageAccess(admin), true);
	assert.equal(canManageAccess(scanlator), true);
	assert.equal(canManageAccess(translator), false);

	assert.equal(canCreateSeries(scanlator), true);
	assert.equal(canCreateSeries(translator), false);
	assert.equal(canUpload(scanlator), true);
	assert.equal(canEditTranslations(scanlator), true);
	assert.equal(canClean(scanlator), true);

	requireUpload(scanlator);
	requireEdit(scanlator);
	requireClean(scanlator);
	requireManageUsers(admin);
	assert.throws(() => requireManageUsers(scanlator), /Forbidden/);
	assert.throws(() => requireManageUsers(translator), /Forbidden/);
});

test('scanlators can only assign regular staff roles and manage people they invited', () => {
	assert.deepEqual(assignableRoles(scanlator), [...STAFF_ROLES]);
	assert.equal(canAssignRole(scanlator, 'translator'), true);
	assert.equal(canAssignRole(scanlator, 'admin'), false);
	assert.equal(canAssignRole(scanlator, 'scanlator'), false);
	assert.equal(canAssignRole(admin, 'scanlator'), true);

	const invited = { id: 'u-invited', role: 'translator' as const, createdBy: scanlator.id };
	const stranger = { id: 'u-stranger', role: 'translator' as const, createdBy: admin.id };
	const otherScan = { id: 'u-scan', role: 'scanlator' as const, createdBy: admin.id };
	assert.equal(canManageTargetUser(scanlator, invited), true);
	assert.equal(canManageTargetUser(scanlator, stranger), false);
	assert.equal(canManageTargetUser(scanlator, otherScan), false);
	assert.equal(canManageTargetUser(scanlator, { id: scanlator.id, role: 'scanlator', createdBy: null }), false);
	assert.equal(canManageTargetUser(admin, stranger), true);
});

test('scanlators can grant their own series, Test, and series an admin assigned', () => {
	assert.equal(isTestSeries({ title: TEST_SERIES_TITLE, slug: 'other' }), true);
	assert.equal(isTestSeries({ title: 'Owned', slug: TEST_SERIES_SLUG }), true);
	assert.equal(isTestSeries({ title: 'Owned', slug: 'owned' }), false);

	assert.equal(canGrantSeries(scanlator, { title: 'Mine', slug: 'mine', createdBy: scanlator.id }), true);
	assert.equal(canGrantSeries(scanlator, { title: TEST_SERIES_TITLE, slug: TEST_SERIES_SLUG, createdBy: null }), true);
	assert.equal(canGrantSeries(scanlator, { id: 'secret', title: 'Secret', slug: 'secret', createdBy: admin.id }), false);
	assert.equal(
		canGrantSeries(scanlator, { id: 'secret', title: 'Secret', slug: 'secret', createdBy: admin.id }, new Set(['secret'])),
		true,
	);
	assert.equal(canGrantSeries(admin, { title: 'Secret', slug: 'secret', createdBy: admin.id }), true);
});

test('new scanlators get the shared Test series and own the series they create', async () => {
	const rootUser = await createUser('demo-admin', 'password', 'admin');
	const created = await createUser('demo-scanlator', 'password', 'scanlator', rootUser.id);
	const test = await ensureTestSeries();
	assert.equal(test.title, TEST_SERIES_TITLE);
	assert.equal(test.slug, TEST_SERIES_SLUG);
	assert.equal(await hasSeriesAccess({ id: created.id, username: created.username, role: created.role }, test.id), true);

	const listed = await listSeriesForUser(created.id, false);
	assert.equal(listed.some((item) => item.id === test.id), true);

	const t = Date.now();
	await db.insert(series).values({
		id: 'owned-series',
		slug: 'owned-series',
		title: 'Guest Book',
		notes: '',
		glossary: '[]',
		createdBy: created.id,
		createdAt: t,
		updatedAt: t,
	});
	await grantSeriesMembership('owned-series', created.id);
	assert.equal(await hasSeriesAccess({ id: created.id, username: created.username, role: created.role }, 'owned-series'), true);
	assert.equal(
		canGrantSeries({ id: created.id, username: created.username, role: created.role }, {
			title: 'Guest Book',
			slug: 'owned-series',
			createdBy: created.id,
		}),
		true,
	);

	await db.insert(series).values({
		id: 'admin-series',
		slug: 'admin-series',
		title: 'Private Work',
		notes: '',
		glossary: '[]',
		createdBy: rootUser.id,
		createdAt: t,
		updatedAt: t,
	});
	assert.equal(
		canGrantSeries({ id: created.id, username: created.username, role: created.role }, {
			id: 'admin-series',
			title: 'Private Work',
			slug: 'admin-series',
			createdBy: rootUser.id,
		}),
		false,
	);
	assert.equal(await hasSeriesAccess({ id: created.id, username: created.username, role: created.role }, 'admin-series'), false);

	await grantSeriesMembership('admin-series', created.id);
	const assigned = { id: created.id, username: created.username, role: created.role };
	assert.equal(await hasSeriesAccess(assigned, 'admin-series'), true);
	assert.equal(
		canGrantSeries(assigned, {
			id: 'admin-series',
			title: 'Private Work',
			slug: 'admin-series',
			createdBy: rootUser.id,
		}, new Set(['admin-series'])),
		true,
	);
	assert.equal((await listSeriesForUser(created.id, false)).some((item) => item.id === 'admin-series'), true);

	const staff = await createUser('demo-letterer', 'password', 'typesetter', created.id);
	await grantTestSeriesAccess(staff.id);
	const membership = await db
		.select()
		.from(seriesMembers)
		.where(eq(seriesMembers.userId, staff.id));
	assert.equal(membership.some((row) => row.seriesId === test.id), true);
	assert.equal(membership.some((row) => row.seriesId === 'admin-series'), false);

	const row = await db.select().from(users).where(eq(users.id, staff.id)).get();
	assert.equal(row?.createdBy, created.id);
	assert.equal(canManageTargetUser({ id: created.id, username: created.username, role: created.role }, row!), true);
});

test('scanlators use staff models but not admin-only billed rows', () => {
	const local = model(['translator', 'proofreader', 'typesetter']);
	const billedAdmin = model(['admin'], { access: 'remote_http', runtime: 'openai', id: 'gpt' });
	const disabled = model(['translator'], { disabled: true });
	assert.equal(rowAllowedForRole(local, 'scanlator'), true);
	assert.equal(rowAllowedForRole(local, 'translator'), true);
	assert.equal(rowAllowedForRole(billedAdmin, 'scanlator'), false);
	assert.equal(rowAllowedForRole(billedAdmin, 'admin'), true);
	assert.equal(rowAllowedForRole(disabled, 'scanlator'), false);
});
