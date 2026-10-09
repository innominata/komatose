import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGlossary, serializeGlossary, mergeGlossaryLists, glossaryPrompt, glossaryHits, upsertGlossary } from '../src/lib/glossary';
import { characterLabel, glossaryCharacters, resolveCharacter } from '../src/lib/characters';
import { pageStepStamp, PAGE_STEPS } from '../src/lib/workflow';
import type { GlossaryTerm } from '../src/lib/types';

const root = await mkdtemp(join(tmpdir(), 'komatose-characters-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.DATABASE_URL = join(root, 'data/test.db');
const { sqlite } = await import('../src/lib/server/db');
const { getDoc, putDoc } = await import('../src/lib/server/workflowStore');
const { persistSeriesGlossary, currentSeriesGlossary, addAcceptedSeriesTerms } = await import('../src/lib/server/seriesGlossary');
const { assignCharacter, loadSpeakerAssignments, speakerContextForLines } = await import('../src/lib/server/characters');
const { loadChapterPack, formatChapterScript } = await import('../src/lib/server/proofread');
const { proofreadPrompt, translatePrompt } = await import('../src/lib/server/llm');
const { enquiryContext } = await import('../src/lib/server/regionAi');
const { reviewedBilingualScript } = await import('../src/lib/server/glossaryMine');
const { listLines } = await import('../src/lib/server/queries');
const { captureExportMetadata } = await import('../src/lib/server/finishedExport');
const { chapterScript } = await import('../src/lib/server/exportDocuments');
const { POST } = await import('../src/routes/api/episodes/[eid]/workflow/+server');
const { PATCH } = await import('../src/routes/api/series/[id]/+server');
after(async () => { sqlite.close(); await rm(root, { recursive: true, force: true }); });
sqlite.prepare("INSERT INTO users(id,username,password_hash,role,created_at) VALUES('u','fixture','unused','admin',1)").run();
sqlite.prepare("INSERT INTO series(id,slug,title,created_at,updated_at) VALUES('s','series','Series',1,1),('other','other','Other',1,1)").run();
for (const [id, seriesId] of [['a', 's'], ['b', 's'], ['foreign', 'other']]) {
  sqlite.prepare('INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES(?,?,?,?,1,1)').run(id, seriesId, id, id);
  sqlite.prepare('INSERT INTO images(id,episode_id,filename,original_name,width,height,page_number,caption,created_at,updated_at) VALUES(?,?,?,?,100,200,1,?,1,1)').run(`${id}-page`, id, 'missing.png', 'missing.png', 'A cafe.');
  sqlite.prepare(`INSERT INTO lines(id,episode_id,image_id,source,body,source_state,status,line_type,placed,updated_at)
    VALUES(?,?,?,'안녕','Hello','read','approved','""',1,1)`).run(`${id}-line`, id, `${id}-page`);
}
sqlite.prepare("INSERT INTO lines(id,episode_id,source,body,source_state,status,line_type,placed,updated_at) VALUES('unplaced','a','네','Yes','read','approved','()',0,1)").run();
const character: GlossaryTerm = { id: 'muyeol', kind: 'character', source: '박무열', translation: 'Park Muyeol', edited: true,
  aliases: ['Park Mooyeol', 'Park Moo-yeol', 'Park Mu-yeol'], notes: 'Speaks gently; childhood friend of Minji.' };
persistSeriesGlossary('s', [character, { source: '서울', translation: 'Seoul', edited: true }]);
persistSeriesGlossary('other', [{ id: 'other-character', kind: 'character', source: '김민지', translation: 'Kim Minji' }]);
const user = { id: 'u', username: 'fixture', role: 'admin' };
function event(eid: string, body: unknown, actor = user) {
  return { locals: { user: actor }, params: { eid }, request: new Request('http://fixture/workflow', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) } as any;
}

test('character metadata survives glossary serialization, merges, hits and locked-name updates', () => {
  assert.deepEqual(parseGlossary(serializeGlossary([character])), [character]);
  assert.deepEqual(mergeGlossaryLists([character], [{ source: '박무열', translation: 'Park Moo-yeol' }]), [character]);
  assert.deepEqual(glossaryHits([character], '박무열이 왔다'), [character]);
  assert.equal(upsertGlossary([character], '박무열', 'Park Mooyeol').changed, false);
  assert.deepEqual(glossaryCharacters([character, { source: '서울', translation: 'Seoul' }]), [character]);
  const prompt = glossaryPrompt([...Array.from({ length: 90 }, (_, i) => ({ source: `term${i}`, translation: `Term ${i}`, edited: true })), character]);
  assert.match(prompt, /Character: 박무열 → Park Muyeol/);
  assert.match(prompt, /exact spelling, spacing and hyphenation; do not re-romanize/);
  assert.match(prompt, /Park Moo-yeol/);
  assert.match(prompt, /Speaks gently/);
  const unnamed = { ...character, id: 'anonymous', source: '', translation: 'The shopkeeper' };
  assert.equal(mergeGlossaryLists([unnamed, { ...unnamed, id: 'unknown', translation: 'The stranger' }]).length, 2);
});

test('assigning speakers preserves text, geometry, style, layouts and page completions', async () => {
  const original = { geometryApproved: true, polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
    style: { size: 20, rotation: 10 }, layout: { key: 'saved-layout' }, textMask: 'mask', locked: true };
  putDoc('a', 'region:a-line', original, 0);
  const lines = await listLines('a');
  const stamps = PAGE_STEPS.map(step => pageStepStamp(step, {}, lines, [], [{ id: 'a-line', data: original as any }]));
  const response = await POST(event('a', { action: 'assign-character', id: 'a-line', characterId: 'muyeol', expectedRevision: 1 }));
  assert.equal(response.status, 200, await response.clone().text());
  const saved = getDoc<any>('region:a-line', {});
  assert.deepEqual(saved.data, { ...original, speaker: { characterId: 'muyeol', name: 'Park Muyeol', source: '박무열' } });
  assert.deepEqual(await listLines('a'), lines);
  assert.deepEqual(PAGE_STEPS.map(step => pageStepStamp(step, {}, lines, [], [{ id: 'a-line', data: saved.data }])), stamps);
  const stale = await POST(event('a', { action: 'assign-character', id: 'a-line', characterId: null, expectedRevision: 1 }));
  assert.equal(stale.status, 409);
  assert.deepEqual(getDoc<any>('region:a-line', {}).data, saved.data);
});

test('translation, proofreading, enquiry, glossary mining and exports carry the assigned speaker', async () => {
  assignCharacter('a', 's', 'unplaced', 'muyeol', 0);
  const pack = await loadChapterPack({ seriesId: 's', episodeId: 'a' });
  const item = pack.items.find((_, i) => pack.targets[i].id === 'a-line')!;
  assert.match(item.speaker!, /Park Muyeol \(박무열\)/);
  assert.match(item.speaker!, /Speaks gently/);
  const script = formatChapterScript(pack.items);
  assert.match(script, /speaker: Park Muyeol/);
  const proofread = proofreadPrompt({ ...pack, settled: '', lang: 'korean' });
  assert.match(proofread, /speaker: Park Muyeol/);
  assert.match(proofread, /do not re-romanize/);
  const translation = translatePrompt({ seriesNotes: '', seriesGlossary: pack.seriesGlossary, prior: '', pageLabel: 'page 1', lang: 'korean',
    lines: [{ i: 0, source: '안녕', lineType: '""', speaker: item.speaker }, { i: 1, source: '안녕', lineType: '""', speaker: 'Kim Minji' }] });
  assert.match(translation, /\[0\][\s\S]*Speaker: Park Muyeol[\s\S]*\[1\][\s\S]*Speaker: Kim Minji/);
  const context = speakerContextForLines(pack.targets, pack.series.glossary, loadSpeakerAssignments('a'));
  assert.match(context, /Region a-line[\s\S]*Speaker: Park Muyeol/);
  assert.match(context, /not who is being addressed/);
  const enquiry = await enquiryContext(pack.series, pack.episode, pack.targets[0], undefined, [], {} as any);
  assert.match(enquiry.text, /Park Muyeol/);
  const mined = reviewedBilingualScript(pack.targets, pack.imgs, loadSpeakerAssignments('a'), pack.series.glossary);
  assert.match(mined, /Speaker: Park Muyeol/);
  const snap = captureExportMetadata(pack.series, pack.episode);
  assert.equal(snap.speakers?.unplaced.characterId, 'muyeol');
  assert.match(chapterScript(snap, true), /Speaker: Park Muyeol \(박무열\)/);
  assert.match(chapterScript(snap, false), /Unplaced \/ no page[\s\S]*Speaker: Park Muyeol/);
});

test('Korean specialist requests distinguish identical dialogue by assigned speaker', async () => {
  const { translateWithSpecialist } = await import('../src/lib/server/specialistTranslation');
  const { translationModel } = await import('../src/lib/translationModels');
  const requests: string[] = [];
  const speakers = ['Park Muyeol', 'Kim Minji'];
  const translated = await translateWithSpecialist(translationModel('hy-mt2-1.8b-q4')!, speakers.map((speaker, i) => ({
    id: `region-${i}`, source: '오늘은 잘 지냈어?', speaker, lineType: '""',
    x: 0, y: 0, w: .2, h: .1, translation: '', literal: '', reasoning: '',
  })), { seriesNotes: '', prior: '', pageLabel: 'Page 1', lang: 'korean', seriesGlossary: glossaryPrompt([character]) }, async (_model, request) => {
    requests.push(request.messages.map(message => message.content).join('\n'));
    return { choices: [{ finish_reason: 'stop', message: { content: 'How was your day?' } }] };
  });
  assert.equal(requests.length, 2);
  for (const [i, request] of requests.entries()) {
    assert.ok(request.includes(`Speaker of this region (not necessarily the person addressed): ${speakers[i]}`));
    assert.match(request, /Keep this exact spelling, spacing and hyphenation/);
    assert.match(request, /do not translate this context or print speaker labels/);
    assert.ok(request.endsWith('오늘은 잘 지냈어?'));
  }
  assert.deepEqual(translated.map(box => box.speaker), speakers);
  assert.deepEqual(translated.map(box => box.translation), ['How was your day?', 'How was your day?']);
});

test('renaming a character updates speaker context across chapters without reassigning regions', async () => {
  assignCharacter('b', 's', 'b-line', 'muyeol', 0);
  const before = getDoc<any>('region:a-line', {});
  persistSeriesGlossary('s', [{ ...character, translation: 'Park Mu-yeol' }]);
  for (const id of ['a', 'b']) {
    const pack = await loadChapterPack({ seriesId: 's', episodeId: id });
    assert.match(pack.items[0].speaker!, /Park Mu-yeol/);
    assert.match(chapterScript(captureExportMetadata(pack.series, pack.episode), true), /Speaker: Park Mu-yeol/);
  }
  assert.deepEqual(getDoc<any>('region:a-line', {}), before);
  persistSeriesGlossary('s', []);
  assert.equal(characterLabel(resolveCharacter(before.data.speaker, [])), 'Park Muyeol (박무열)', 'Removing a glossary row leaves the saved identity readable');
  persistSeriesGlossary('s', [character]);
});

test('unknown speakers stay unknown, assignments can be cleared, and foreign characters/regions are rejected', async () => {
  const request = (id: string, characterId: unknown, revision = 0) => POST(event('a', { action: 'assign-character', id, characterId, expectedRevision: revision }));
  assert.equal((await request('foreign-line', 'muyeol')).status, 404);
  assert.equal((await request('a-line', 'other-character', 2)).status, 404);
  assert.equal((await request('a-line', [], 2)).status, 400);
  const before = getDoc<any>('region:a-line', {});
  assert.equal((await request('a-line', null, before.revision)).status, 200);
  const after = getDoc<any>('region:a-line', {});
  assert.equal(after.data.speaker, undefined);
  const { speaker: _speaker, ...rest } = before.data;
  assert.deepEqual(after.data, rest);
  const pack = await loadChapterPack({ seriesId: 's', episodeId: 'a' });
  assert.equal(pack.items[0].speaker, 'Unknown / unassigned');
});

test('glossary API retains stable character IDs, aliases and notes; mined names become characters', async () => {
  const response = await PATCH({ locals: { user }, params: { id: 's' }, request: new Request('http://fixture/series', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ glossary: [character, { kind: 'character', source: '', translation: 'The shopkeeper' }] }),
  }) } as any);
  assert.equal(response.status, 200, await response.clone().text());
  const saved = (await response.json()).glossary as GlossaryTerm[];
  assert.deepEqual(saved[0], character);
  assert.ok(saved[1].id);
  assert.equal(currentSeriesGlossary('s')[1].id, saved[1].id);
  addAcceptedSeriesTerms('s', [{ source: '김민지', translation: 'Kim Minji', kind: 'name' }]);
  const mined = currentSeriesGlossary('s').find(term => term.source === '김민지')!;
  assert.equal(mined.kind, 'character');
  assert.ok(mined.id);
  assert.equal(mined.edited, true);
  addAcceptedSeriesTerms('s', [{ source: '김민지', translation: 'Kim Min-ji', kind: 'name' }]);
  assert.equal(currentSeriesGlossary('s').find(term => term.id === mined.id)!.translation, 'Kim Minji');
  assert.throws(() => persistSeriesGlossary('s', [character, { ...character, source: '다른이름' }]), /unique ID/);
});

test('assignment requires translation-edit permission and access to the series', async () => {
  const body = { action: 'assign-character', id: 'a-line', characterId: 'muyeol', expectedRevision: getDoc('region:a-line', {}).revision };
  sqlite.prepare("INSERT INTO series_members(series_id,user_id,created_at) VALUES('s','u',1)").run();
  assert.equal((await POST(event('a', body, { ...user, role: 'typesetter' }))).status, 403);
  assert.equal((await POST(event('a', body, { ...user, role: 'proofreader' }))).status, 200);
  assert.equal((await POST(event('foreign', { ...body, id: 'foreign-line' }, { ...user, role: 'proofreader' }))).status, 403);
});
