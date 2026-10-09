import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'komatose-series-reading-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.DATABASE_URL = join(root, 'data/test.db');
const { sqlite } = await import('../src/lib/server/db');
const { getDoc, putDoc } = await import('../src/lib/server/workflowStore');
const { preferences } = await import('../src/lib/server/workflowService');
const { migrateSeriesReadingPreferences } = await import('../src/lib/server/db/workflowMigration');
const { POST } = await import('../src/routes/api/episodes/[eid]/workflow/+server');
const user = { id: 'u', username: 'fixture', role: 'admin' };
sqlite.prepare("INSERT INTO users(id,username,password_hash,role,created_at) VALUES('u','fixture','unused','admin',1)").run();
after(async () => { sqlite.close(); await rm(root, { recursive: true, force: true }); });

function series(id: string) {
  sqlite.prepare('INSERT INTO series(id,slug,title,created_at,updated_at) VALUES(?,?,?,1,1)').run(id, id, id);
}
function chapter(id: string, seriesId: string) {
  sqlite.prepare('INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES(?,?,?,?,1,1)').run(id, seriesId, id, id);
}
function event(eid: string, body: unknown, actor = user) {
  return { locals: { user: actor }, params: { eid }, request: new Request('http://fixture/workflow', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) } as any;
}
const doc = (id: string) => getDoc<Record<string, any>>(id, {});

test('migration preserves saved choices and other settings, removes chapter overrides, and runs only once', () => {
  series('migrate');
  chapter('older', 'migrate');
  chapter('newer', 'migrate');
  putDoc('older', 'chapter:older', { lang: 'japanese', direction: 'rtl', dpi: 96, chapterSummary: 'Keep notes' }, 0);
  putDoc('newer', 'chapter:newer', { lang: 'korean', direction: 'ltr', dpi: 144 }, 0);
  sqlite.prepare('UPDATE workflow_docs SET updated_at=? WHERE id=?').run(1, 'chapter:older');
  sqlite.prepare('UPDATE workflow_docs SET updated_at=? WHERE id=?').run(2, 'chapter:newer');
  sqlite.prepare("UPDATE workflow_docs SET redo='[{\"dpi\":72}]' WHERE id='chapter:older'").run();
  putDoc(null, 'series:migrate', { styles: { '()': { size: 16 } }, regionAi: { model: 'saved-model' } }, 0);
  series('explicit');
  chapter('explicit-chapter', 'explicit');
  putDoc(null, 'series:explicit', { lang: 'japanese', direction: 'ltr', style: { size: 20 } }, 0);
  putDoc('explicit-chapter', 'chapter:explicit-chapter', { lang: 'korean', direction: 'rtl', dpi: 72 }, 0);
  series('empty');
  series('language-only');
  chapter('language-only-chapter', 'language-only');
  putDoc('language-only-chapter', 'chapter:language-only-chapter', { lang: 'korean' }, 0);
  series('invalid');
  chapter('invalid-chapter', 'invalid');
  putDoc('invalid-chapter', 'chapter:invalid-chapter', { lang: 'invalid', direction: null, dpi: 100 }, 0);
  const prior = sqlite.prepare("SELECT undo,redo,data FROM workflow_docs WHERE id='chapter:older'").get() as any;
  sqlite.prepare('DELETE FROM schema_versions WHERE version=9').run();
  migrateSeriesReadingPreferences(sqlite);
  assert.deepEqual(doc('series:migrate').data, {
    styles: { '()': { size: 16 } }, regionAi: { model: 'saved-model' }, lang: 'korean', direction: 'ltr',
  });
  assert.deepEqual(doc('series:explicit').data, { lang: 'japanese', direction: 'ltr', style: { size: 20 } });
  assert.deepEqual(doc('series:empty').data, { lang: 'japanese', direction: 'rtl' });
  assert.deepEqual(doc('series:language-only').data, { lang: 'korean', direction: 'ltr' });
  assert.deepEqual(doc('series:invalid').data, { lang: 'japanese', direction: 'rtl' });
  assert.deepEqual(doc('chapter:older').data, { dpi: 96, chapterSummary: 'Keep notes' });
  assert.deepEqual(doc('chapter:newer').data, { dpi: 144 });
  assert.deepEqual(doc('chapter:invalid-chapter').data, { dpi: 100 });
  const migrated = sqlite.prepare("SELECT undo,redo FROM workflow_docs WHERE id='chapter:older'").get() as any;
  assert.deepEqual(JSON.parse(migrated.undo), [...JSON.parse(prior.undo), JSON.parse(prior.data)]);
  assert.equal(migrated.redo, prior.redo);
  const snapshot = sqlite.prepare('SELECT * FROM workflow_docs ORDER BY id').all();
  const revisions = sqlite.prepare('SELECT id,revision FROM episodes ORDER BY id').all();
  migrateSeriesReadingPreferences(sqlite);
  assert.deepEqual(sqlite.prepare('SELECT * FROM workflow_docs ORDER BY id').all(), snapshot);
  assert.deepEqual(sqlite.prepare('SELECT id,revision FROM episodes ORDER BY id').all(), revisions);
});

test('series choices govern existing and new chapters, even with restored legacy overrides', () => {
  series('inherit');
  chapter('inherit-a', 'inherit');
  chapter('inherit-b', 'inherit');
  putDoc(null, 'series:inherit', { lang: 'korean', direction: 'ltr' }, 0);
  putDoc('inherit-a', 'chapter:inherit-a', { lang: 'japanese', direction: 'rtl', dpi: 96 }, 0);
  for (const id of ['inherit-a', 'inherit-b']) {
    assert.equal(preferences(id, 'inherit').lang, 'korean');
    assert.equal(preferences(id, 'inherit').direction, 'ltr');
  }
  chapter('inherit-new', 'inherit');
  assert.equal(preferences('inherit-new', 'inherit').lang, 'korean');
  assert.equal(preferences('inherit-new', 'inherit').direction, 'ltr');
  assert.equal(preferences('inherit-a', 'inherit').dpi, 96);
  assert.equal(preferences('inherit-b', 'inherit').dpi, null);
  series('defaults');
  chapter('defaults-chapter', 'defaults');
  putDoc('defaults-chapter', 'chapter:defaults-chapter', { lang: 'korean', direction: 'ltr' }, 0);
  assert.equal(preferences('defaults-chapter', 'defaults').lang, 'japanese');
  assert.equal(preferences('defaults-chapter', 'defaults').direction, 'rtl');
});

test('API saves series choices with concurrency checks and notifies every chapter; DPI stays local', async () => {
  series('api');
  chapter('api-a', 'api');
  chapter('api-b', 'api');
  putDoc(null, 'series:api', { style: { size: 16 }, regionAi: { model: 'keep' } }, 0);
  const rooms = (globalThis as any).__scanRooms as Map<string, Set<any>>;
  const received: Record<string, any[]> = { 'api-a': [], 'api-b': [] };
  for (const id of Object.keys(received)) rooms.set(id, new Set([{ ws: { readyState: 1, send: (v: string) => received[id].push(JSON.parse(v)) } }]));
  const before = sqlite.prepare("SELECT id,revision FROM episodes WHERE series_id='api' ORDER BY id").all() as any[];
  try {
    const response = await POST(event('api-a', { action: 'preferences', scope: 'series', expectedRevision: 1, data: { lang: 'korean', direction: 'ltr' } }));
    assert.equal(response.status, 200, await response.text());
    assert.equal(preferences('api-b', 'api').lang, 'korean');
    assert.equal(preferences('api-b', 'api').direction, 'ltr');
    assert.deepEqual(doc('series:api').data.style, { size: 16 });
    assert.deepEqual(doc('series:api').data.regionAi, { model: 'keep' });
    for (const { id, revision } of before) {
      assert.equal((sqlite.prepare('SELECT revision FROM episodes WHERE id=?').get(id) as any).revision, revision + 1);
      assert.deepEqual(received[id], [{ type: 'workflow:changed', id: 'series:api', revision: 2 }]);
    }
    const stale = await POST(event('api-b', { action: 'preferences', scope: 'series', expectedRevision: 1, data: { lang: 'japanese' } }));
    assert.equal(stale.status, 409);
    const partial = await POST(event('api-b', { action: 'preferences', scope: 'series', expectedRevision: 2, data: { direction: 'rtl' } }));
    assert.equal(partial.status, 200, await partial.text());
    assert.equal(preferences('api-a', 'api').lang, 'korean');
    assert.equal(preferences('api-a', 'api').direction, 'rtl');
    const local = await POST(event('api-a', { action: 'preferences', expectedRevision: 0, data: { dpi: 144 } }));
    assert.equal(local.status, 200, await local.text());
    assert.deepEqual(doc('chapter:api-a').data, { dpi: 144 });
    assert.equal(preferences('api-b', 'api').dpi, null);
  } finally {
    for (const id of Object.keys(received)) rooms.delete(id);
  }
});

test('API rejects invalid or chapter-scoped choices without changing stored settings', async () => {
  const before = doc('series:api');
  for (const data of [{ lang: 'english' }, { lang: null }, { lang: ['korean'] }, { direction: 'sideways' }, { direction: ['rtl'] }, { direction: null }, { lang: 'korean', dpi: 96 }]) {
    const response = await POST(event('api-a', { action: 'preferences', scope: 'series', expectedRevision: before.revision, data }));
    assert.equal(response.status, 400, JSON.stringify(data));
  }
  for (const data of [{ lang: 'korean' }, { direction: 'ltr' }]) {
    const response = await POST(event('api-a', { action: 'preferences', expectedRevision: doc('chapter:api-a').revision, data }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /belong to the series/);
  }
  assert.deepEqual(doc('series:api'), before);
});

test('series reading settings retain translation-edit permissions and series access checks', async () => {
  sqlite.prepare("INSERT INTO series_members(series_id,user_id,created_at) VALUES('api','u',1)").run();
  const body = { action: 'preferences', scope: 'series', expectedRevision: doc('series:api').revision, data: { lang: 'japanese', direction: 'rtl' } };
  assert.equal((await POST(event('api-a', body, { ...user, role: 'typesetter' }))).status, 403);
  assert.equal((await POST(event('api-a', body, { ...user, role: 'proofreader' }))).status, 200);
  const noAccess = await POST(event('inherit-a', { ...body, expectedRevision: doc('series:inherit').revision }, { ...user, role: 'proofreader' }));
  assert.equal(noAccess.status, 403);
});
