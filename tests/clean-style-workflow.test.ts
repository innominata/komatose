import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { PAGE_STEPS, pageStepStamp } from '../src/lib/workflow';

const root = await mkdtemp(join(tmpdir(), 'komatose-clean-style-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.DATABASE_URL = join(root, 'data/test.db');
const { sqlite } = await import('../src/lib/server/db');
const { getDoc, putDoc, storeAsset, readAsset } = await import('../src/lib/server/workflowStore');
const { getSeries, getEpisode, listImages, listLines } = await import('../src/lib/server/queries');
const { forgetPageHistory, completeOutstandingPages, rememberPageSteps } = await import('../src/lib/server/stepUndo');
const { preferences, resolveStyle, typesetRegions, applyCleaning, readiness } = await import('../src/lib/server/workflowService');
const { uploadFont } = await import('../src/lib/server/typesetting');
const { listJobs, createJob, updateJob } = await import('../src/lib/server/jobs');
const { POST } = await import('../src/routes/api/episodes/[eid]/workflow/+server');
sqlite.prepare("INSERT INTO users(id,username,password_hash,role,created_at) VALUES('u','fixture','unused','admin',1)").run();
sqlite.prepare("INSERT INTO series(id,slug,title,created_at,updated_at) VALUES('s','series','Fixture',1,1)").run();
const user = { id: 'u', username: 'fixture', role: 'admin' } as const;
const font = (await uploadFont('s', 'Fixture.otf', await readFile('/usr/share/fonts/julietaula-montserrat-fonts/Montserrat-Regular.otf'))).font;
const artwork = await storeAsset(await sharp({ create: { width: 400, height: 500, channels: 3, background: 'white' } }).png().toBuffer());
const mask = await storeAsset(await sharp({ create: { width: 400, height: 500, channels: 3, background: 'black' } }).png().toBuffer());
putDoc(null, 'series:s', { style: { fontId: font.id, size: 12, minSize: 6, autoContrast: false }, styles: { '()': { fontId: font.id, size: 16, minSize: 6, autoContrast: false } } }, 0);
after(async () => { sqlite.close(); await rm(root, { recursive: true, force: true }); });

async function chapter(id: string, count = 1) {
  sqlite.prepare('INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES(?,?,?,?,1,1)').run(id, 's', id, id);
  for (let i = 0; i < count; i++) {
    const imageId = `${id}-p${i}`;
    sqlite.prepare('INSERT INTO images(id,episode_id,filename,original_name,sort_order,width,height,created_at,updated_at) VALUES(?,?,?,?,?,400,500,1,1)').run(imageId, id, `${i}.png`, `${i}.png`, i);
    putDoc(id, `page:${imageId}`, { prepared: artwork, preparedAt: 1, cleaned: artwork, cleanBase: artwork, mask, maskApproved: true, cleanApproved: true, strokes: [{ points: [{ x: .1, y: .1 }], radius: 5 }], expansion: 5, maskDiagnostics: { mask, source: artwork, regions: '', version: 'fixture', entries: [] } }, 0);
  }
  return { series: (await getSeries('s'))!, episode: (await getEpisode(id))! };
}
function region(episodeId: string, id: string, page = 0, type = '()', extra: Record<string, unknown> = {}) {
  sqlite.prepare("INSERT INTO lines(id,episode_id,image_id,source,body,source_state,status,line_type,placed,x,y,w,h,updated_at) VALUES(?,?,?,'source','A thought','read','approved',?,1,.1,.1,.7,.6,1)").run(id, episodeId, `${episodeId}-p${page}`, type);
  return putDoc(episodeId, `region:${id}`, { polygon: [{ x: .1, y: .1 }, { x: .8, y: .1 }, { x: .7, y: .7 }, { x: .2, y: .7 }], geometryApproved: true, geometryConfidence: .9, textMask: mask, style: { fontId: font.id, size: 23, minSize: 6, autoContrast: false, rotation: 12, skewX: 5 }, ...extra }, 0);
}
function event(eid: string, body: unknown, actor: { id: string; username: string; role: string } = user) {
  return { locals: { user: actor }, params: { eid }, request: new Request('http://fixture/workflow', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) } as any;
}
function undoHistory(id: string) {
  return (sqlite.prepare('SELECT undo FROM workflow_docs WHERE id=?').get(id) as { undo: string }).undo;
}

test('mark Clean done applies the latest pass, approves artwork, discards masks, and stamps the final state', async () => {
  const { episode } = await chapter('done');
  const cleanResult = await storeAsset(await sharp({ create: { width: 400, height: 500, channels: 3, background: 'red' } }).png().toBuffer());
  const previous = getDoc<any>('page:done-p0', {});
  putDoc(episode.id, previous.id, { ...previous.data, cleaned: cleanResult, cleanApproved: false, cleanMethod: 'fixture', backend: 'CPU' }, previous.revision);
  const before = getDoc<any>('page:done-p0', {});
  // Geometry operations remember completions without discarding mask work.
  rememberPageSteps(episode.id, 'done-p0');
  assert.equal(getDoc<any>('page:done-p0', {}).data.mask, mask);
  forgetPageHistory(episode.id, 'done-p0', 'clean');
  const doc = getDoc<any>('page:done-p0', {});
  for (const key of ['mask', 'strokes', 'expansion', 'maskDiagnostics']) assert.equal(doc.data[key], undefined);
  assert.equal(doc.data.maskApproved, false);
  assert.equal(doc.data.prepared, before.data.prepared);
  assert.equal(doc.data.cleanBase, cleanResult);
  assert.equal(doc.data.cleaned, undefined);
  assert.equal(doc.data.cleanApproved, true);
  assert.equal(doc.data.cleanMethod, undefined);
  assert.equal(doc.data.backend, undefined);
  assert.equal(doc.data.completed.clean, pageStepStamp('clean', doc.data, [], [], []));
  assert.deepEqual(JSON.parse(undoHistory(doc.id)), []);
  assert.ok((await readAsset(artwork)).length);
  assert.ok((await readAsset(cleanResult)).length, 'The applied pass remains referenced after clearing undo');
});

test('Clean done approves already applied artwork or an uncleaned source without creating a cleaning pass', async () => {
  await chapter('approve-existing', 2);
  for (const [index, base] of [[0, artwork], [1, undefined]] as const) {
    const id = `approve-existing-p${index}`;
    const doc = getDoc<any>(`page:${id}`, {});
    putDoc('approve-existing', doc.id, { prepared: artwork, preparedAt: 1, cleanBase: base, cleanApproved: false }, doc.revision);
    const result = await POST(event('approve-existing', { action: 'forget-page-history', imageId: id, step: 'clean' }));
    assert.equal(result.status, 200);
    const final = getDoc<any>(doc.id, {}).data;
    assert.equal(final.prepared, artwork);
    assert.equal(final.cleanBase, base);
    assert.equal(final.cleaned, undefined);
    assert.equal(final.cleanApproved, true);
    assert.equal(final.completed.clean, pageStepStamp('clean', final, [], [], []));
  }
});

test('bulk completion clears masks and keeps undo history; Apply cleaning retains the same artwork', async () => {
  await chapter('bulk', 2);
  const doc = getDoc<any>('page:bulk-p0', {});
  applyCleaning('bulk', 'bulk-p0', doc.revision);
  const applied = getDoc<any>('page:bulk-p0', {});
  assert.equal(applied.data.cleanBase, artwork);
  assert.equal(applied.data.cleaned, undefined);
  assert.equal(applied.data.mask, undefined);
  const undo = undoHistory(applied.id);
  completeOutstandingPages('bulk');
  assert.equal(undoHistory(applied.id), undo);
  const marked = getDoc<any>('page:bulk-p1', {});
  assert.equal(marked.data.mask, undefined);
  assert.equal(marked.data.strokes, undefined);
  assert.equal(marked.data.cleanBase, artwork);
  assert.equal(marked.data.cleaned, undefined);
  assert.equal(marked.data.cleanApproved, true);
  assert.equal(marked.data.completed.clean, pageStepStamp('clean', marked.data, [], [], []));
});

test('series category defaults stay coherent across chapters with legacy chapter overrides', async () => {
  const { episode } = await chapter('coherent');
  region(episode.id, 'coherent-thought');
  putDoc(episode.id, `chapter:${episode.id}`, { styles: { '()': { fontId: font.id, size: 45 } }, dpi: 96 }, 0);
  const line = (await listLines(episode.id))[0];
  assert.equal(resolveStyle(line, {}, episode.id, 's').size, 16);
  assert.equal(preferences(episode.id, 's').styles?.['()']?.size, 16);
  assert.equal(resolveStyle(line, { style: { size: 20 } }, episode.id, 's').size, 20);
  const response = await POST(event(episode.id, { action: 'preferences', expectedRevision: 1, data: { styles: { '()': { size: 45 } } } }));
  assert.equal(response.status, 400);
  const normal = await POST(event(episode.id, { action: 'preferences', expectedRevision: 1, data: { dpi: 120 } }));
  assert.equal(normal.status, 200);
});

test('saved-style batch renders real text, preserves shapes/masks/transforms and skips locks without detecting geometry', async () => {
  const ctx = await chapter('refit', 2);
  for (const [id, page, locked] of [['refit-a', 0, false], ['refit-b', 1, false], ['refit-lock', 1, true]] as const) region('refit', id, page, '()', { locked });
  const lines = await listLines('refit');
  const before = new Map(lines.map(line => [line.id, getDoc<any>(`region:${line.id}`, {})]));
  let geometryCalls = 0;
  const result = await typesetRegions(ctx.series, ctx.episode, await listImages('refit'), lines, new AbortController().signal, () => {}, async () => { geometryCalls++; throw new Error('Must not detect geometry'); }, { savedStyle: true });
  assert.equal(geometryCalls, 0);
  assert.deepEqual(result, { completed: 2, skipped: 1, total: 3, errors: [] });
  for (const line of lines) {
    const doc = getDoc<any>(`region:${line.id}`, {});
    const old = before.get(line.id)!;
    if (old.data.locked) { assert.deepEqual(doc, old); continue; }
    for (const key of ['polygon', 'geometryApproved', 'geometryConfidence', 'textMask']) assert.deepEqual(doc.data[key], old.data[key]);
    assert.equal(doc.data.style.rotation, 12);
    assert.equal(doc.data.style.skewX, 5);
    assert.equal(doc.data.style.size, undefined);
    assert.equal(doc.data.layout.style.size, 16);
    assert.equal(doc.data.layout.style.fontId, font.id);
    assert.ok(doc.data.layout.svg.includes('<path'));
    assert.deepEqual((await listLines('refit')).find(l => l.id === line.id), line);
  }
});

test('chapter category refit filters other types, ignored/unplaced/blank text and locked layouts', async () => {
  const ctx = await chapter('api', 2);
  region('api', 'api-first'); region('api', 'api-second', 1);
  region('api', 'api-lock', 1, '()', { locked: true });
  region('api', 'api-speech', 1, '""'); region('api', 'api-ignore'); region('api', 'api-unplaced'); region('api', 'api-empty');
  sqlite.prepare("UPDATE lines SET source_state='ignored' WHERE id='api-ignore'").run();
  sqlite.prepare("UPDATE lines SET placed=0 WHERE id='api-unplaced'").run();
  sqlite.prepare("UPDATE lines SET body='' WHERE id='api-empty'").run();
  const untouched = ['api-lock', 'api-speech', 'api-ignore', 'api-unplaced', 'api-empty'].map(id => getDoc<any>(`region:${id}`, {}));
  const response = await POST(event(ctx.episode.id, { action: 'typeset-all', scope: 'chapter', lineType: '()', savedStyle: true }));
  assert.equal(response.status, 202);
  const { jobId } = await response.json();
  for (let attempt = 0; attempt < 100 && ['queued', 'running'].includes(listJobs('api').find(j => j.id === jobId)!.state); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  const job = listJobs('api').find(j => j.id === jobId)!;
  assert.equal(job.state, 'completed');
  assert.equal(job.progress.completed, 2);
  assert.equal(job.progress.skipped, 1);
  assert.equal(job.progress.total, 3);
  assert.deepEqual(job.progress.errors, []);
  for (const doc of untouched) assert.deepEqual(getDoc<any>(doc.id, {}), doc);
  for (const id of ['api-first', 'api-second']) assert.equal(getDoc<any>(`region:${id}`, {}).data.layout.style.size, 16);
  for (const body of [{ scope: 'page', lineType: '()' }, { scope: 'chapter', lineType: 'missing-type' }, { scope: 'chapter' }])
    assert.equal((await POST(event('api', { action: 'typeset-all', savedStyle: true, ...body }))).status, 400);
});

test('Clean completion waits for active mask work so a late mask cannot reopen the page', async () => {
  await chapter('running');
  const jobId = createJob('running', 'mask', { request: { imageId: 'running-p0' } });
  updateJob(jobId, 'running', {});
  const before = getDoc<any>('page:running-p0', {});
  assert.equal((await POST(event('running', { action: 'forget-page-history', imageId: 'running-p0', step: 'clean' }))).status, 409);
  assert.deepEqual(getDoc<any>('page:running-p0', {}), before);
  updateJob(jobId, 'completed', {});
  assert.equal((await POST(event('running', { action: 'forget-page-history', imageId: 'running-p0', step: 'clean' }))).status, 200);
  assert.equal(getDoc<any>('page:running-p0', {}).data.mask, undefined);
});

test('Export can mark each step done across the chapter without changing other steps or chapters', async () => {
  await chapter('export-untouched');
  const untouched = getDoc<any>('page:export-untouched-p0', {});
  for (const step of PAGE_STEPS) {
    const id = `export-${step}`;
    await chapter(id, 2);
    const before = getDoc<any>(`page:${id}-p0`, {});
    const undo = undoHistory(before.id);
    const response = await POST(event(id, { action: 'mark-all-complete', step }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).pages, 2);
    for (const index of [0, 1]) {
      const doc = getDoc<any>(`page:${id}-p${index}`, {});
      assert.deepEqual(Object.keys(doc.data.completed), [step]);
      assert.equal(doc.data.completed[step], pageStepStamp(step, doc.data, [], [], []));
      assert.equal(doc.data.mask, step === 'clean' ? undefined : mask);
      assert.equal(doc.data.cleaned, step === 'clean' ? undefined : artwork);
    }
    assert.equal(undoHistory(before.id), undo);
  }
  assert.deepEqual(getDoc<any>(untouched.id, {}), untouched);
});

test('Export bulk completion is available with content blockers and does not hide missing content', async () => {
  const ctx = await chapter('export-missing');
  region(ctx.episode.id, 'export-missing-text', 0, '()', { geometryApproved: false });
  sqlite.prepare("UPDATE lines SET body='',source='',source_state='unreadable',status='draft' WHERE id='export-missing-text'").run();
  const response = await POST(event(ctx.episode.id, { action: 'mark-all-complete' }));
  assert.equal(response.status, 200);
  const issues = readiness(ctx.series, ctx.episode, await listImages(ctx.episode.id), await listLines(ctx.episode.id));
  assert.equal(issues.some(issue => issue.code === 'step-complete'), false);
  for (const code of ['source', 'translation', 'review', 'geometry', 'layout'])
    assert.ok(issues.some(issue => issue.code === code), `${code} must still block export`);
});

test('Approve everything accepts current saved work, skips ignored/empty text, retains history, and stays in this chapter', async () => {
  const ctx = await chapter('export-approve', 2);
  region(ctx.episode.id, 'export-approve-text', 0, '()', {
    geometryApproved: false,
    layout: { key: 'stale', svg: '<svg>saved text</svg>', missingGlyphs: [], overflow: false },
  });
  region(ctx.episode.id, 'export-approve-empty', 1, '()', { geometryApproved: false });
  region(ctx.episode.id, 'export-approve-ignore', 1, '()', { geometryApproved: false });
  sqlite.prepare("UPDATE lines SET status='draft' WHERE episode_id=?").run(ctx.episode.id);
  sqlite.prepare("UPDATE lines SET body='' WHERE id='export-approve-empty'").run();
  sqlite.prepare("UPDATE lines SET source_state='ignored' WHERE id='export-approve-ignore'").run();
  await chapter('export-approve-other');
  region('export-approve-other', 'export-approve-other-text', 0, '()', { geometryApproved: false });
  const other = getDoc<any>('region:export-approve-other-text', {});
  const otherPage = getDoc<any>('page:export-approve-other-p0', {});
  const ignored = getDoc<any>('region:export-approve-ignore', {});
  const before = getDoc<any>('region:export-approve-text', {});
  const pageBefore = getDoc<any>('page:export-approve-p0', {});
  const history = JSON.parse(undoHistory(pageBefore.id));
  const response = await POST(event(ctx.episode.id, { action: 'approve-everything' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { translations: 1, geometry: 2, cleaning: 2, layouts: 1 });
  const texts = await listLines(ctx.episode.id);
  assert.equal(texts.find(l => l.id === 'export-approve-text')!.status, 'approved');
  for (const id of ['export-approve-empty', 'export-approve-ignore'])
    assert.equal(texts.find(l => l.id === id)!.status, 'draft');
  const approved = getDoc<any>(before.id, {});
  assert.equal(approved.data.geometryApproved, true);
  assert.deepEqual(approved.data.polygon, before.data.polygon);
  assert.deepEqual(approved.data.style, before.data.style);
  assert.equal(approved.data.layout.svg, before.data.layout.svg);
  assert.notEqual(approved.data.layout.key, 'stale');
  for (const index of [0, 1]) {
    const page = getDoc<any>(`page:export-approve-p${index}`, {});
    assert.equal(page.data.cleanBase, artwork);
    assert.equal(page.data.cleaned, undefined);
    assert.equal(page.data.cleanApproved, true);
    assert.equal(page.data.mask, undefined);
    assert.equal(page.data.completed, undefined);
    assert.ok(page.revision > pageBefore.revision);
  }
  const savedHistory = JSON.parse(undoHistory(pageBefore.id));
  assert.deepEqual(savedHistory.slice(0, history.length), history);
  assert.deepEqual(savedHistory.at(-1), pageBefore.data);
  assert.deepEqual(getDoc<any>(other.id, {}), other);
  assert.deepEqual(getDoc<any>(otherPage.id, {}), otherPage);
  assert.deepEqual(getDoc<any>(ignored.id, {}), ignored);
  const issues = readiness(ctx.series, ctx.episode, await listImages(ctx.episode.id), texts);
  assert.ok(issues.some(i => i.code === 'translation' && i.lineId === 'export-approve-empty'));
  assert.ok(issues.some(i => i.code === 'layout' && i.lineId === 'export-approve-empty'));
  assert.equal((await POST(event(ctx.episode.id, { action: 'mark-all-complete' }))).status, 200);
  assert.equal(readiness(ctx.series, ctx.episode, await listImages(ctx.episode.id), texts).some(i => i.code === 'step-complete'), false);
});

test('Export bulk actions validate steps, enforce permissions, and wait for jobs without partial changes', async () => {
  await chapter('export-guard');
  sqlite.prepare("INSERT INTO series_members(series_id,user_id,created_at) VALUES('s','u',1)").run();
  const reader = { ...user, role: 'proofreader' };
  const setter = { ...user, role: 'typesetter' };
  const before = getDoc<any>('page:export-guard-p0', {});
  for (const step of ['prepare', 'invalid', '', null])
    assert.equal((await POST(event('export-guard', { action: 'mark-all-complete', step }))).status, 400);
  assert.equal((await POST(event('export-guard', { action: 'mark-all-complete', step: 'clean' }, reader))).status, 403);
  assert.equal((await POST(event('export-guard', { action: 'mark-all-complete', step: 'review' }, setter))).status, 403);
  for (const actor of [reader, setter]) {
    assert.equal((await POST(event('export-guard', { action: 'mark-all-complete' }, actor))).status, 403);
    assert.equal((await POST(event('export-guard', { action: 'approve-everything' }, actor))).status, 403);
  }
  const job = createJob('export-guard', 'typeset-all', {});
  updateJob(job, 'running', {});
  for (const action of ['mark-all-complete', 'approve-everything'])
    assert.equal((await POST(event('export-guard', { action }))).status, 409);
  assert.deepEqual(getDoc<any>(before.id, {}), before);
  updateJob(job, 'completed', {});
  assert.equal((await POST(event('export-guard', { action: 'mark-all-complete', step: 'review' }, reader))).status, 200);
  assert.equal((await POST(event('export-guard', { action: 'mark-all-complete', step: 'typeset' }, setter))).status, 200);
});

test('Approve everything rolls back earlier approvals if saving artwork fails', async () => {
  await chapter('export-atomic');
  region('export-atomic', 'export-atomic-text', 0, '()', { geometryApproved: false });
  sqlite.prepare("UPDATE lines SET status='draft' WHERE id='export-atomic-text'").run();
  const before = getDoc<any>('region:export-atomic-text', {});
  const page = getDoc<any>('page:export-atomic-p0', {});
  const messages: unknown[] = [];
  const rooms = (globalThis as any).__scanRooms as Map<string, Set<unknown>>;
  const client = { ws: { readyState: 1, send: (payload: string) => messages.push(JSON.parse(payload)) } };
  rooms.set('export-atomic', new Set([client]));
  sqlite.exec(`CREATE TRIGGER reject_export_approval BEFORE UPDATE ON workflow_docs
    WHEN NEW.id='page:export-atomic-p0' BEGIN SELECT RAISE(ABORT, 'fixture artwork failure'); END;`);
  try {
    assert.equal((await POST(event('export-atomic', { action: 'approve-everything' }))).status, 500);
    assert.equal((await listLines('export-atomic'))[0].status, 'draft');
    assert.deepEqual(getDoc<any>(before.id, {}), before);
    assert.deepEqual(getDoc<any>(page.id, {}), page);
    assert.deepEqual(messages, [], 'Rolled-back approvals must not appear in other editors');
  } finally {
    sqlite.exec('DROP TRIGGER reject_export_approval');
    rooms.delete('export-atomic');
  }
});
