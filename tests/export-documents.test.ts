import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';

const root = await mkdtemp(join(tmpdir(), 'komatose-export-documents-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.DATABASE_URL = join(root, 'data/test.db');
const { sqlite } = await import('../src/lib/server/db');
const { getDoc, putDoc } = await import('../src/lib/server/workflowStore');
const { getEpisode, getSeries } = await import('../src/lib/server/queries');
const { captureExportMetadata, buildExport } = await import('../src/lib/server/finishedExport');
const { chapterScript, exportDocument } = await import('../src/lib/server/exportDocuments');
const { GET, POST } = await import('../src/routes/api/series/[id]/export-documents/+server');
sqlite.prepare("INSERT INTO users(id,username,password_hash,role,created_at) VALUES('u','fixture','unused','admin',1)").run();
sqlite.prepare("INSERT INTO series(id,slug,title,created_at,updated_at) VALUES('s','fixture','Fixture series',1,1),('other','other','Private',1,1)").run();
const user = { id: 'u', username: 'fixture', role: 'admin' };
after(async () => { sqlite.close(); await rm(root, { recursive: true, force: true }); });

for (const [id, order] of [['third', 3], ['first', 1], ['second', 2]] as const) {
  sqlite.prepare('INSERT INTO episodes(id,series_id,slug,title,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,1,1)').run(id, 's', id, `Chapter ${order}`, order);
  sqlite.prepare('INSERT INTO images(id,episode_id,filename,original_name,sort_order,width,height,caption,page_number,created_at,updated_at) VALUES(?,?,?,?,0,100,200,?,1,1,1)').run(`${id}-page`, id, 'missing.png', 'missing.png', `Scene ${order}: a rainy street.`);
}
sqlite.prepare("INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES('private','other','private','Private chapter',1,1)").run();
putDoc(null, 'series:s', { regionKinds: [{ id: 'memory', label: 'Flashback', color: '#abcdef' }] }, 0);
putDoc('first', 'chapter:first', { chapterSummary: 'Two friends meet in Seoul.' }, 0);
function line(id: string, chapterId: string, imageId: string | null, order: number, type: string, extra = {}) {
  sqlite.prepare(`INSERT INTO lines(id,episode_id,image_id,source,body,source_state,status,line_type,sort_order,placed,updated_at)
    VALUES(?,?,?,'안녕하세요','Hello there','read','needs_work',?,?,?,1)`).run(id, chapterId, imageId, type, order, imageId ? 1 : 0);
  if (Object.keys(extra).length) putDoc(chapterId, `region:${id}`, extra, 0);
}
// Insert out of order so tests catch reliance on row/insertion order.
line('late', 'first', 'first-page', 8, 'memory');
line('early', 'first', 'first-page', 1, '()');
line('ignored', 'first', 'first-page', 9, 'plain');
sqlite.prepare("UPDATE lines SET source_state='ignored',ignore_reason='watermark',source='',body='' WHERE id='ignored'").run();
line('unplaced', 'first', null, 10, '""');
line('second-line', 'second', 'second-page', 0, '::');
line('third-line', 'third', 'third-page', 0, '[]');
const series = (await getSeries('s'))!;
const episode = (await getEpisode('first'))!;
const snapshot = () => captureExportMetadata(series, episode);
function event(body?: unknown, actor: typeof user | null = user, seriesId = 's') {
  return { locals: { user: actor }, params: { id: seriesId }, request: new Request('http://fixture/export-documents', {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  }) } as any;
}

test('bilingual and English scripts retain region types, stable IDs, scene notes and all text', () => {
  const text = chapterScript(snapshot(), true);
  assert.match(text, /Series: Fixture series/);
  assert.match(text, /Chapter: Chapter 1 \[first\]/);
  assert.match(text, /Chapter scene summary:\nTwo friends meet in Seoul\./);
  assert.ok(text.indexOf('--- Page 1 ---') < text.indexOf('Scene notes:'));
  assert.ok(text.indexOf('Scene 1: a rainy street.') < text.indexOf('ID: early'));
  assert.ok(text.indexOf('ID: early') < text.indexOf('ID: late'));
  assert.match(text, /Thought \[\(\)\]/);
  assert.match(text, /Flashback \[memory\]/);
  assert.match(text, /Original:\n안녕하세요\nEnglish:\nHello there/);
  assert.match(text, /ignored: watermark/);
  assert.match(text, /\[not translated\]/);
  assert.match(text, /Unplaced \/ no page[\s\S]*ID: unplaced/);
  const english = chapterScript(snapshot(), false);
  assert.match(english, /Thought/);
  assert.match(english, /Scene 1: a rainy street\./);
  assert.doesNotMatch(english, /안녕하세요|Original:/);
  const withoutNotes = chapterScript(snapshot(), true, false);
  assert.doesNotMatch(withoutNotes, /rainy street|Two friends|Scene notes/);
  assert.match(withoutNotes, /안녕하세요/);
});

test('metadata capture reads incomplete pages without preparing images or changing any saved data', () => {
  const before = sqlite.prepare('SELECT total_changes() AS changes').get();
  const snap = snapshot();
  assert.equal(snap.pages[0].source.prepared, undefined);
  assert.ok(snap.issues.length);
  assert.deepEqual(sqlite.prepare('SELECT total_changes() AS changes').get(), before);
  assert.equal((sqlite.prepare('SELECT count(*) AS n FROM workflow_jobs').get() as any).n, 0);
  assert.equal(getDoc('page:first-page', {}).revision, 0);
});

test('viewer endpoint combines chapters in series order and preserves structured JSON', async () => {
  const list = await GET(event());
  assert.equal(list.status, 200);
  const listing = await list.json();
  assert.deepEqual(listing.chapters.map((chapter: any) => chapter.id), ['first', 'second', 'third']);
  assert.ok(listing.files.some((file: any) => file.id === 'font-manifest.json'));
  assert.ok(!listing.files.some((file: any) => file.id === 'attribution.txt'));
  const before = sqlite.prepare('SELECT total_changes() AS changes').get();
  const response = await POST(event({ episodeIds: ['third', 'first', 'second', 'first'], file: 'bilingual.txt' }));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { document, chapterCount } = await response.json();
  assert.equal(chapterCount, 3);
  assert.ok(document.text.indexOf('Chapter 1') < document.text.indexOf('Chapter 2'));
  assert.ok(document.text.indexOf('Chapter 2') < document.text.indexOf('Chapter 3'));
  assert.equal(document.text.match(/NEXT CHAPTER/g).length, 2);
  assert.match(document.text, /SFX/);
  const jsonResponse = await POST(event({ episodeIds: ['second', 'first'], file: 'chapter.json' }));
  const combined = (await jsonResponse.json()).document;
  assert.equal(combined.filename, 'chapters.json');
  const data = JSON.parse(combined.text);
  assert.deepEqual(data.chapters.map((chapter: any) => chapter.episode.id), ['first', 'second']);
  assert.equal(data.chapters[0].pages[0].image.caption, 'Scene 1: a rainy street.');
  assert.equal(data.chapters[0].lines.find((line: any) => line.id === 'early').lineType, '()');
  assert.deepEqual(sqlite.prepare('SELECT total_changes() AS changes').get(), before);
});

test('metadata formats include fonts and readiness notes and share script formatting with ZIP exports', async () => {
  const snap = snapshot();
  const font = { id: 'font', hash: 'hash', postscriptName: 'FixtureFont' };
  snap.pages[0].regions[0].data.layout = { font } as any;
  assert.deepEqual(JSON.parse(exportDocument([snap, snap], 'font-manifest.json').text).fonts, [font]);
  assert.match(exportDocument([snap], 'DRAFT.txt').text, /Chapter 1[\s\S]*revision/);
  assert.equal(JSON.parse(exportDocument([snap], 'chapter.json').text).episode.id, 'first');
  const zip = await JSZip.loadAsync(await buildExport(snap));
  for (const id of ['english.txt', 'bilingual.txt', 'chapter.json', 'font-manifest.json', 'DRAFT.txt'] as const)
    assert.equal(await zip.file(id)!.async('string'), exportDocument([snap], id).text);
  const plainScript = { ...snap, format: 'bilingual', includeMetadata: false };
  const scriptZip = await JSZip.loadAsync(await buildExport(plainScript));
  assert.deepEqual(Object.keys(scriptZip.files), ['bilingual.txt']);
  assert.match(await scriptZip.file('bilingual.txt')!.async('string'), /Scene notes:[\s\S]*Thought/);
});

test('document endpoint validates input and protects other series and anonymous requests', async () => {
  assert.equal((await GET(event(undefined, null))).status, 401);
  assert.equal((await POST(event({ episodeIds: ['first'], file: 'english.txt' }, null))).status, 401);
  for (const body of [null, {}, { episodeIds: [], file: 'english.txt' }, { episodeIds: [1], file: 'english.txt' }, { episodeIds: ['first'], file: '../private' }, { episodeIds: ['first'], file: 'english.txt', includeSceneNotes: 'yes' }])
    assert.equal((await POST(event(body))).status, 400);
  assert.equal((await POST(event({ episodeIds: ['private'], file: 'chapter.json' }))).status, 404);
  const actor = { ...user, role: 'proofreader' };
  assert.equal((await GET(event(undefined, actor))).status, 403);
  sqlite.prepare("INSERT INTO series_members(series_id,user_id,created_at) VALUES('s','u',1)").run();
  assert.equal((await GET(event(undefined, actor))).status, 200);
  assert.equal((await POST(event({ episodeIds: ['first'], file: 'english.txt' }, actor))).status, 200);
  assert.equal((await GET(event(undefined, actor, 'other'))).status, 403);
});

test('attribution appears for licensed works and empty/unlabelled pages remain clear', async () => {
  const snap = snapshot();
  snap.series = { ...snap.series, title: 'Give My Regards to Black Jack' };
  assert.match(exportDocument([snap], 'attribution.txt').text, /佐藤秀峰|Sato|densho/i);
  snap.pages[0].image.pageNumber = null;
  snap.pages[0].image.caption = '';
  snap.pages[0].regions = [];
  snap.lines = [];
  const text = chapterScript(snap, true);
  assert.match(text, /Page 1 \(unnumbered\)/);
  assert.match(text, /Scene notes:\n\[none saved\]/);
  assert.match(text, /\[No regions\]/);
});
