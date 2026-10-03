import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { compareOcrReadings } from '../src/lib/ocrConsensus';
import { DEFAULT_STYLE } from '../src/lib/workflow';

process.env.SCAN_ROOT = await mkdtemp(join(tmpdir(), 'scan-review-workflow-'));
process.env.DATABASE_URL = join(process.env.SCAN_ROOT, 'data/test.db');
process.env.LLAMASWAP_API_KEY = 'fixture';
process.env.LLAMASWAP_URL = 'http://review.fixture/v1';
const { sqlite, db } = await import('../src/lib/server/db');
const { lines, images } = await import('../src/lib/server/db/schema');
const { getSeries, getEpisode, listLines } = await import('../src/lib/server/queries');
const { getDoc, putDoc, storeAsset, readAsset } = await import('../src/lib/server/workflowStore');
const { readOcrConsensus, saveOcrConsensus } = await import('../src/lib/server/ocrConsensus');
const { capturePageImages } = await import('../src/lib/server/pageImages');
const { startPageProofread, cancelPageProofread, rememberProofread, resetProofreadCursor, proofreadCursor } = await import('../src/lib/server/pageProofread');
const { listJobs } = await import('../src/lib/server/jobs');
const { removeBlankRegions } = await import('../src/lib/server/workflowService');
const { saveImageFile } = await import('../src/lib/server/storage');
sqlite.prepare("INSERT INTO users(id, username, password_hash, role, created_at) VALUES('ai-ocr','OCR','unused','admin',1),('human','Human','unused','admin',1)").run();
sqlite.prepare("INSERT INTO series(id,slug,title,created_at,updated_at) VALUES('s','s','Series',1,1)").run();
sqlite.prepare("INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES('e','s','e','Episode',1,1)").run();
const { createLocalHttpRow } = await import('../src/lib/server/modelRegistryStore');
// Chat models ship as launch presets now, so the legacy `engine: 'qwen'` host only
// resolves to a row this install actually has. Register the fixture slugs the way
// Setup → Local models would add an installed chat row.
const { fixturePasses } = await import('./local-ocr-fixture');
for (const slug of ['review-mask-fixture', 'proofreader-fixture', 'fixture']) {
  const row = createLocalHttpRow({ name: slug, slug });
  await fixturePasses(row.id, ['sourceReview', 'pageImageProofread', 'translate', 'vision']);
}
const fixtureSettings = getDoc('series:s', {});
putDoc(null, fixtureSettings.id, { regionAi: { translate: { engine: 'fixture', model: '' } } }, fixtureSettings.revision);
const series = (await getSeries('s'))!, episode = (await getEpisode('e'))!;
const pair = (hayai: string, paddle: string) => compareOcrReadings([
  { model: 'hayai-ocr-v2', source: hayai }, { model: 'paddleocr-vl-1.6', source: paddle },
]);
const current = async (id: string) => (await listLines('e')).find(l => l.id === id)!;
async function addLine(id: string, extra: Record<string, unknown> = {}) {
  await db.insert(lines).values({ id, episodeId: 'e', source: '', body: '', lineType: 'plain',
    sourceState: 'unreadable', updatedBy: 'ai-ocr', sortOrder: 0, updatedAt: 1, ...extra });
  return current(id);
}
async function finished(id: string) {
  for (let i = 0; i < 500; i++) {
    const job = listJobs('e').find(j => j.id === id)!;
    if (!['queued', 'running', 'cancelling'].includes(job.state)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Fixture job timed out');
}

test('consensus OCR and Qwen hints receive the chapter language', async () => {
  const { ocrTranslateSystem } = await import('../src/lib/server/ocrReview');
  const { paddleOcrPrompt } = await import('../src/lib/server/localReview');
  assert.match(ocrTranslateSystem('korean'), /Korean/);
  assert.match(ocrTranslateSystem('japanese'), /Japanese/);
  assert.equal(paddleOcrPrompt(), 'OCR:');
  assert.equal(paddleOcrPrompt('korean'), 'OCR:\nOCR language: Korean');
  assert.equal(paddleOcrPrompt('japanese'), 'OCR:\nOCR language: Japanese');
  const seen: string[] = [];
  const result = await readOcrConsensus(Buffer.from('fixture'), new AbortController().signal, async (id, _crop, _signal, lang) => {
    seen.push(`read:${lang}`);
    return id === 'hayai-ocr-v2' ? '안녕' : '안녕하세요';
  }, async (_source, _abort, lang) => {
    seen.push(`translate:${lang}`);
    return 'Hi';
  }, 'korean');
  assert.equal(result.agreed, false);
  assert.deepEqual(seen, ['read:korean', 'read:korean', 'translate:korean', 'translate:korean']);
});

test('agreement ignores wrapping, dashes/tildes, and canonical Unicode but keeps letters and other punctuation', () => {
  assert.equal(pair('나의자유를건', '나의 자유를 건').source, '나의 자유를 건');
  assert.equal(pair('こんにちは！', 'こん\nにちは！').agreed, true);
  assert.equal(pair('한글'.normalize('NFD'), '한글').agreed, true);
  assert.equal(pair('匠～さっき', '匠-さっき').agreed, true);
  assert.equal(pair('hello~world', 'hello—world').source, 'hello—world');
  for (const [a, b] of [['ドーン', 'ドン'], ['そう！', 'そう？'], ['', ''], ['？！', '？！']])
    assert.equal(pair(a, b).agreed, false);
  assert.equal(pair('', '안녕').agreed, true);
  assert.equal(pair('', '안녕').source, '안녕');
});

test('automatic OCR reuses one page mask and both recognizers receive only the kept lettering', async () => {
  const { detectLetteringMask, maskedBubbleCrop } = await import('../src/lib/server/reviewMask');
  const { bubbleFromNorm } = await import('../src/lib/server/bubbles');
  const { regionRectangle } = await import('../src/lib/regionGeometry');
  const { localMaskFixture } = await import('./local-ocr-fixture');
  const fixture = await localMaskFixture();
  const raw = await sharp({ create: { width: 100, height: 80, channels: 3, background: '#aaaaaa' } })
    .composite([{ input: Buffer.from('<svg width="100" height="80"><rect x="20" y="30" width="10" height="20" fill="black"/><rect x="70" y="30" width="10" height="20" fill="black"/></svg>') }])
    .png().toBuffer();
  const bubbles = [bubbleFromNorm(100, 80, 0, 0, .5, 1), bubbleFromNorm(100, 80, .5, 0, .5, 1)];
  const abort = new AbortController();
  try {
    const mask = await detectLetteringMask(raw, bubbles.map(regionRectangle), 3, abort.signal);
    for (const bubble of bubbles) {
      const crop = await maskedBubbleCrop(raw, bubble, abort.signal, mask);
      const pixels = await sharp(crop).removeAlpha().raw().toBuffer();
      assert.ok(pixels[0] > 245, 'artwork outside the mask becomes white');
      assert.ok(pixels[(40 * 50 + 25) * 3] < 20, 'lettering stays visible');
      const readers: string[] = [];
      await readOcrConsensus(crop, abort.signal, async (model, sent) => {
        assert.deepEqual(sent, crop);
        readers.push(model);
        return '原文';
      });
      assert.deepEqual(readers, ['hayai-ocr-v2', 'paddleocr-vl-1.6']);
    }
    assert.equal((await fixture.calls()).length, 1, 'one detector call for the whole page');
    const empty = await sharp({ create: { width: 100, height: 80, channels: 3, background: 'black' } }).png().toBuffer();
    const fallback = await maskedBubbleCrop(raw, bubbles[0], abort.signal, empty);
    const unmasked = await sharp(fallback).removeAlpha().raw().toBuffer();
    assert.ok(unmasked[0] > 150 && unmasked[0] < 200, 'empty lettering mask keeps the original crop for OCR');
    abort.abort();
    await assert.rejects(maskedBubbleCrop(raw, bubbles[0], abort.signal), { name: 'AbortError' });
    assert.equal((await fixture.calls()).length, 1, 'cancelled detection does not start a worker');
  } finally { fixture.restore(); }
});

test('source review API masks by default and honors an explicit opt-out or edited mask', async () => {
  const { POST } = await import('../src/routes/api/episodes/[eid]/region-ai/+server');
  const { localMaskFixture } = await import('./local-ocr-fixture');
  const fixture = await localMaskFixture();
  const raw = await sharp({ create: { width: 60, height: 60, channels: 3, background: '#aaaaaa' } }).png().toBuffer();
  const file = await saveImageFile({ seriesSlug: 's', episodeSlug: 'e', sortOrder: 9, originalName: 'mask.png', bytes: raw, mime: 'image/png' });
  await db.insert(images).values({ ...file, id: 'review-mask-p', episodeId: 'e', originalName: 'mask.png', sortOrder: 9, createdAt: 1, updatedAt: 1 });
  const line = await addLine('review-mask-l', { imageId: 'review-mask-p', x: 0, y: 0, w: 1, h: 1 });
  const cleaned = await storeAsset(await sharp({ create: { width: 60, height: 60, channels: 3, background: 'white' } }).png().toBuffer());
  putDoc('e', 'page:review-mask-p', { cleanBase: cleaned, prepared: cleaned }, 0);
  const originalFetch = globalThis.fetch;
  const sent: Buffer[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/models')) return Response.json({ data: [] });
    if (!String(url).endsWith('/chat/completions')) return Response.json({}, { status: 503 });
    const body = JSON.parse(String(init?.body));
    const image = body.messages[1].content.find((part: any) => part.type === 'image_url');
    sent.push(Buffer.from(image.image_url.url.split(',')[1], 'base64'));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ status: 'readable', source: '原文', translation: 'Text', answer: 'Read the lettering.' }) } }] });
  };
  try {
    const edited = await sharp({ create: { width: 60, height: 60, channels: 3, background: 'white' } }).png().toBuffer();
    for (const extra of [{}, { maskEnabled: false }, { mask: edited.toString('base64') }]) {
      const response = await POST({ locals: { user: { id: 'human', username: 'Human', role: 'admin' } }, params: { eid: 'e' },
        request: new Request('http://fixture/region-ai', { method: 'POST', body: JSON.stringify({ action: 'review', lineId: line.id,
          expectedRevision: line.revision, reviewers: [{ engine: 'qwen', model: 'review-mask-fixture' }], ...extra }) }) } as any);
      assert.equal(response.status, 200, await response.text());
    }
    assert.equal(sent.length, 3);
    const first = await sharp(sent[0]).removeAlpha().raw().toBuffer();
    assert.ok(first[0] > 245, 'automatic mask removes surrounding artwork');
    assert.ok(Math.abs(first[(30 * 60 + 30) * 3] - 170) < 5, 'mask is applied to source pixels, not the cleaned page');
    for (const bytes of sent.slice(1)) {
      const pixels = await sharp(bytes).removeAlpha().raw().toBuffer();
      assert.ok(Math.abs(pixels[0] - 170) < 5, 'opt-out and edited mask preserve their chosen pixels');
    }
    assert.equal((await fixture.calls()).length, 1);
    assert.deepEqual(getDoc<any>('page:review-mask-p', {}).data, { cleanBase: cleaned, prepared: cleaned });
    assert.equal((await current(line.id)).source, '', 'review still only proposes changes');
  } finally {
    fixture.restore();
    globalThis.fetch = originalFetch;
    sqlite.prepare("DELETE FROM images WHERE id='review-mask-p'").run();
    sqlite.prepare("DELETE FROM lines WHERE id='review-mask-l'").run();
  }
});

test('one recognizer failing retains the other reading, translates it, and cancellation stops the second recognizer', async () => {
  const result = await readOcrConsensus(Buffer.from('fixture'), new AbortController().signal, async id => {
    if (id === 'hayai-ocr-v2') throw new Error('Fixture failure');
    return '안녕';
  }, async source => `EN ${source}`);
  assert.equal(result.agreed, true);
  assert.equal(result.source, '안녕');
  assert.equal(result.readings[1].source, '안녕');
  assert.match(result.readings[0].error!, /Fixture failure/);
  const abort = new AbortController();
  let calls = 0;
  await assert.rejects(readOcrConsensus(Buffer.from('fixture'), abort.signal, async () => {
    calls++; abort.abort(); return '안녕';
  }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('plurality writes the agreed source and English and keeps dissenters as suggestions', async () => {
  const line = await addLine('plurality');
  const result = compareOcrReadings([
    { model: 'hayai-ocr-v2', source: 'こんにちは' },
    { model: 'paddleocr-vl-1.6', source: 'こんにちは' },
    { model: 'qwen3-vl-8b', source: 'こんばんは' },
  ]);
  assert.equal(result.agreed, true);
  for (const reading of result.readings) if (reading.source) reading.translation = `EN ${reading.source}`;
  saveOcrConsensus('e', line, result);
  const saved = await current(line.id);
  assert.equal(saved.source, 'こんにちは');
  assert.equal(saved.body, 'EN こんにちは');
  assert.equal(saved.sourceState, 'read');
  const suggestions = sqlite.prepare("SELECT body, translation FROM suggestions WHERE line_id=? AND state='pending'").all(line.id) as { body: string; translation: string }[];
  assert.deepEqual(suggestions, [{ body: 'こんばんは', translation: 'EN こんばんは' }]);
});

test('one collapsed transcription suggestion fills empty source and English', async () => {
  const line = await addLine('lone-suggestion');
  const result = compareOcrReadings([
    { model: 'hayai-ocr-v2', source: 'こんにちは.' },
    { model: 'paddleocr-vl-1.6', source: 'こんにちは' },
  ]);
  assert.equal(result.agreed, false);
  for (const reading of result.readings) reading.translation = 'Hello';
  saveOcrConsensus('e', line, result);
  const saved = await current(line.id);
  assert.equal(saved.source, 'こんにちは.');
  assert.equal(saved.body, 'Hello');
  assert.equal(saved.sourceState, 'read');
  assert.equal((sqlite.prepare("SELECT count(*) n FROM suggestions WHERE line_id=? AND state='pending'").get(line.id) as { n: number }).n, 0);
});

test('transcription promotes dictionary SFX and demotes free-text dialogue to an aside', async () => {
  const bubble = await addLine('class-bubble', { lineType: '""' });
  saveOcrConsensus('e', bubble, pair('ドキドキ', 'ドキドキ'));
  assert.equal((await current(bubble.id)).lineType, '::');

  const sfx = await addLine('class-sfx', { lineType: '::' });
  saveOcrConsensus('e', sfx, pair('待って！', '待って！'));
  assert.equal((await current(sfx.id)).lineType, '//');

  const spelled = await addLine('class-spelled', { lineType: '""' });
  const disagreed = pair('ドーン', 'ドン');
  saveOcrConsensus('e', spelled, disagreed);
  assert.equal((await current(spelled.id)).source, '');
  assert.equal((await current(spelled.id)).lineType, '::');

  const chosen = await addLine('class-chosen', { lineType: '::', updatedBy: 'human' });
  saveOcrConsensus('e', chosen, pair('こんにちは', 'こんにちは'));
  assert.equal((await current(chosen.id)).lineType, '::');
});

test('disagreement clears machine drafts, keeps two translated source suggestions, and survives blank cleanup', async () => {
  const line = await addLine('disagree', { source: 'Old OCR', body: 'Old translation', sourceState: 'read' });
  const disagreed = pair('ドーン', 'ドン');
  disagreed.readings[0].translation = 'Boom';
  disagreed.readings[1].translation = 'Don';
  saveOcrConsensus('e', line, disagreed);
  const saved = await current(line.id);
  assert.equal(saved.source, ''); assert.equal(saved.body, '');
  assert.equal(saved.sourceState, 'unreadable'); assert.equal(saved.status, 'needs_work');
  const suggestions = sqlite.prepare("SELECT * FROM suggestions WHERE line_id=? AND state='pending'").all(line.id) as any[];
  assert.equal(suggestions.length, 2);
  assert.deepEqual(suggestions.map(s => [s.body, s.translation]).sort(), [['ドン', 'Don'], ['ドーン', 'Boom']].sort());
  assert.ok(suggestions.every(s => s.kind === 'source-review' && s.base_revision === saved.revision));
  assert.ok(suggestions.some(s => /Hayai OCR v2/.test(s.reason)));
  assert.ok(suggestions.some(s => /PaddleOCR-VL/.test(s.reason)));
  assert.ok(suggestions.every(s => / · /.test(s.reason)));
  await addLine('empty-art');
  assert.deepEqual(removeBlankRegions('e'), ['empty-art']);
  assert.ok(await current(line.id));
  assert.equal(listJobs('e').length, 0, 'no automatic translation or council');
  saveOcrConsensus('e', saved, pair('안녕', '안녕'));
  assert.equal((await current(line.id)).source, '안녕');
  assert.equal((sqlite.prepare("SELECT count(*) n FROM suggestions WHERE line_id=? AND state='pending'").get(line.id) as any).n, 0);
});

test('manual, approved, and concurrent edits survive OCR results', async () => {
  for (const extra of [{ updatedBy: 'human' }, { status: 'approved' }]) {
    const line = await addLine(`protected-${JSON.stringify(extra)}`, { source: 'Human source', body: 'Human English', ...extra });
    saveOcrConsensus('e', line, pair('ドーン', 'ドン'));
    assert.equal((await current(line.id)).source, 'Human source');
    assert.equal((await current(line.id)).body, 'Human English');
  }
  const line = await addLine('concurrent', { source: 'Original', body: 'Original English' });
  sqlite.prepare("UPDATE lines SET source='New source',body='New English',updated_by='human' WHERE id=?").run(line.id);
  saveOcrConsensus('e', line, pair('一致', '一致'));
  assert.equal((await current(line.id)).body, 'New English');
});

let submitted: Awaited<ReturnType<typeof capturePageImages>>;
test('page images retain source pixels and render the current cleaned typeset page, including overflow', async () => {
  const raw = await sharp({ create: { width: 64, height: 64, channels: 3, background: 'white' } }).png().toBuffer();
  const cleaned = await sharp({ create: { width: 64, height: 64, channels: 3, background: 'blue' } }).png().toBuffer();
  const file = await saveImageFile({ seriesSlug: 's', episodeSlug: 'e', sortOrder: 0, originalName: 'page.png', bytes: raw, mime: 'image/png' });
  await db.insert(images).values({ id: 'p', episodeId: 'e', ...file, originalName: 'page.png', sortOrder: 0, createdAt: 1, updatedAt: 1 });
  putDoc('e', 'page:p', { prepared: await storeAsset(raw), preparedAt: 1, cleaned: await storeAsset(cleaned) }, 0);
  await addLine('lettering', { imageId: 'p', x: .2, y: .2, w: .6, h: .6, source: '原文', body: 'English', sourceState: 'read' });
  putDoc('e', 'region:lettering', { layout: { overflow: true, size: 3, style: { ...DEFAULT_STYLE, outlineWidth: 0 },
    svg: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect x="20" y="20" width="10" height="10" fill="red"/></svg>' } }, 0);
  submitted = await capturePageImages(series, episode, 'p');
  const rawPixels = await sharp(submitted.raw).removeAlpha().raw().toBuffer();
  const rendered = await sharp(submitted.typeset!).removeAlpha().raw().toBuffer();
  assert.deepEqual([...rawPixels.subarray(0, 3)], [255, 255, 255]);
  assert.deepEqual([...rendered.subarray(0, 3)], [0, 0, 255]);
  const at = (25 * 64 + 25) * 3;
  assert.deepEqual([...rendered.subarray(at, at + 3)], [255, 0, 0]);
  await assert.rejects(capturePageImages(series, episode, 'not-in-this-episode'), /Page not found/);
});

test('a same-page proofread is a typeset follow-up until another page is sent', async () => {
  const { proofreadAttach } = await import('../src/lib/pageProofread');
  resetProofreadCursor();
  assert.equal(proofreadAttach('p1', 'chat-1'), 'both');
  rememberProofread('proofreader-a', 'p1', 'chat-1');
  assert.equal(proofreadAttach('p1', 'chat-1', proofreadCursor()), 'typeset');
  assert.equal(proofreadAttach('p2', 'chat-1', proofreadCursor()), 'both');
  rememberProofread('proofreader-a', 'p2', 'chat-1');
  assert.equal(proofreadAttach('p1', 'chat-1', proofreadCursor()), 'both');
  rememberProofread('proofreader-a', 'p1', 'chat-1');
  assert.equal(proofreadAttach('p1', 'chat-2', proofreadCursor()), 'both');
  resetProofreadCursor();
});

test('proofreader receives both images in order, persists critique and snapshots, and never applies changes', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/models')) return Response.json({ data: [] });
    if (!String(url).endsWith('/chat/completions')) return Response.json({}, { status: 503 });
    calls++;
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.model, 'proofreader-fixture');
    const parts = payload.messages[1].content;
    assert.match(payload.messages[0].content, /You are a Japanese\/Korean scanlation proofreader/);
    assert.match(parts[0].text, /Image 1: RAW.*Image 2: WORKING TYPESET/);
    assert.equal(parts.filter((p: any) => p.type === 'image_url').length, 2);
    for (const [i, bytes] of [submitted.raw, submitted.typeset!].entries()) {
      const jpeg = await sharp(bytes).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
      assert.equal(parts[i + 1].image_url.url, `data:image/jpeg;base64,${jpeg.toString('base64')}`);
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify({ critique: 'Panel 1: adjust the English line break.\nKeep the speaker’s uncertainty.' }) } }] });
  };
  try {
    const before = await current('lettering');
    const { jobId } = startPageProofread({ series, episode, imageId: 'p', model: { engine: 'qwen', model: 'proofreader-fixture' } });
    const job = await finished(jobId);
    assert.equal(job.state, 'completed', job.error || '');
    assert.match(job.progress.critique, /Panel 1/);
    assert.deepEqual(await current('lettering'), before);
    const saved = JSON.parse((sqlite.prepare('SELECT progress FROM workflow_jobs WHERE id=?').get(jobId) as any).progress);
    assert.equal(saved.critique, job.progress.critique);
    assert.deepEqual(await readAsset(saved.snapshot.raw), submitted.raw);
    assert.deepEqual(await readAsset(saved.snapshot.typeset), submitted.typeset);
    const page = getDoc<any>('page:p', {});
    putDoc('e', page.id, { ...page.data, cleaned: page.data.prepared }, page.revision);
    assert.equal(listJobs('e').find(j => j.id === jobId)!.progress.snapshot.typeset, saved.snapshot.typeset);
    assert.equal(calls, 1, 'reloading saved job data makes no model request');
    const cancelled = startPageProofread({ series, episode, imageId: 'p', model: { engine: 'qwen', model: 'proofreader-fixture' } });
    cancelPageProofread(cancelled.jobId);
    assert.equal((await finished(cancelled.jobId)).state, 'cancelled');
    assert.equal(calls, 1, 'cancelled capture never reaches the model');
  } finally { globalThis.fetch = originalFetch; }
});

test('proofreader follow-up creates a new critique from the parent job', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/models')) return Response.json({ data: [] });
    if (!String(url).endsWith('/chat/completions')) return Response.json({}, { status: 503 });
    calls++;
    const payload = JSON.parse(String(init?.body));
    const parts = payload.messages[1].content;
    assert.match(parts[0].text, /Editor follow-up:\nTighten the SFX/);
    assert.match(parts[0].text, /Previous critique:/);
    assert.equal(parts.filter((p: any) => p.type === 'image_url').length, 3);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ critique: 'SFX in panel 2 is still clipped.' }) } }] });
  };
  try {
    const { startPageProofreadFollowUp } = await import('../src/lib/server/pageProofread');
    const parent = listJobs('e').find(j => j.kind === 'page-proofread' && j.state === 'completed');
    assert.ok(parent, 'needs the completed proofread job from the previous test');
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer();
    const { jobId } = startPageProofreadFollowUp({
      series, episode, parentJobId: parent.id, prompt: 'Tighten the SFX', images: [png],
    });
    const job = await finished(jobId);
    assert.equal(job.state, 'completed', job.error || '');
    assert.match(job.progress.critique, /SFX in panel 2/);
    assert.equal(job.payload.followUpOf, parent.id);
    assert.equal(job.progress.prompt, 'Tighten the SFX');
    assert.equal(job.progress.snapshot.followUpImages.length, 1);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('drawn-region OCR runs Hayai then Paddle, saves consensus, and translates', async () => {
  const { startRegionOcr } = await import('../src/lib/server/aiTranslate');
  const { localOcrFixture } = await import('./local-ocr-fixture');
  const restoreOcr = await localOcrFixture();
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    if (String(url).includes('ocr.fixture/hayai-ocr-v2')) {
      calls.push('hayai');
      return Response.json({ source: 'こんにちは' });
    }
    if (String(url).includes('ocr.fixture/paddleocr-vl-1.6')) {
      calls.push('paddle');
      return Response.json({ choices: [{ message: { content: 'こんにちは' } }] });
    }
    calls.push('translate');
    return Response.json({ choices: [{ message: { content: JSON.stringify({ items: [
      { i: 0, translation: 'Hello', literal: 'greeting', reasoning: 'Agreed source' },
    ] }) } }] });
  };
  try {
    const line = await addLine('drawn-ocr', { imageId: 'p', x: .1, y: .1, w: .4, h: .4 });
    const { jobId } = startRegionOcr({
      series, episode, user: { id: 'human', username: 'Human', role: 'admin' },
      lineId: line.id, expectedRevision: line.revision,
    });
    const job = await finished(jobId);
    assert.equal(job.state, 'completed', job.error || '');
    assert.deepEqual(calls.slice(0, 2), ['hayai', 'paddle']);
    const saved = await current(line.id);
    assert.equal(saved.source, 'こんにちは');
    assert.equal(saved.sourceState, 'read');
    assert.equal(saved.body, 'Hello');
    assert.ok(calls.includes('translate'));
    assert.match(job.progress.message, /transcribed and translated/i);
  } finally {
    restoreOcr();
    globalThis.fetch = originalFetch;
  }
});

test('fill-missing writes only empty source, empty English, and empty suggestion translations', async () => {
  const { startFillMissing } = await import('../src/lib/server/aiTranslate');
  const { suggest } = await import('../src/lib/server/workflowStore');
  const empty = await addLine('fill-src', { imageId: 'p', placed: true, x: .1, y: .1, w: .3, h: .3, source: '', body: 'Keep English' });
  const sourced = await addLine('fill-en', { imageId: 'p', placed: true, x: .4, y: .1, w: .3, h: .3, source: '原文', body: '', sourceState: 'read' });
  const keep = await addLine('fill-keep', { imageId: 'p', placed: true, x: .1, y: .5, w: .3, h: .3, source: '既存', body: 'Existing English', sourceState: 'read' });
  await addLine('fill-ign', { imageId: 'p', placed: true, x: .4, y: .5, w: .3, h: .3, source: '', body: '', sourceState: 'ignored' });
  const missingSug = suggest('e', sourced.id, sourced.revision ?? 0, '別の原文', 'Independent OCR', 'source-review', '');
  suggest('e', keep.id, keep.revision ?? 0, '既存', 'already translated', 'source-review', 'Already English');
  const { jobId, sources, english, suggestions } = await startFillMissing({
    series, episode, user: { id: 'human', username: 'Human', role: 'admin' },
    engine: 'qwen', model: 'fixture',
    ocrLine: async () => pair('こんにちは', 'こんにちは'),
    translateLines: async (pageLines) => new Map(pageLines.map(l => [l.id, `EN ${l.source}`])),
    translateSuggestion: async (source) => `SUG ${source}`,
  });
  assert.ok(sources >= 1 && english >= 1 && suggestions >= 1);
  const job = await finished(jobId);
  assert.equal(job.state, 'completed', job.error || '');
  assert.equal((await current(empty.id)).source, 'こんにちは');
  assert.equal((await current(empty.id)).body, 'Keep English');
  assert.equal((await current(sourced.id)).source, '原文');
  assert.equal((await current(sourced.id)).body, 'EN 原文');
  assert.equal((await current(keep.id)).source, '既存');
  assert.equal((await current(keep.id)).body, 'Existing English');
  assert.equal((await current('fill-ign')).source, '');
  assert.equal((sqlite.prepare('SELECT translation FROM suggestions WHERE id=?').get(missingSug) as any).translation, 'SUG 別の原文');
  assert.equal((sqlite.prepare("SELECT translation FROM suggestions WHERE body='既存'").get() as any).translation, 'Already English');
});

test('fill-missing applies one collapsed suggestion and keeps existing English', async () => {
  const { saveFillMissingSource } = await import('../src/lib/server/fillMissing');
  const empty = await addLine('fill-lone', { source: '', body: '' });
  const keep = await addLine('fill-lone-keep', { source: '', body: 'Stay' });
  const result = compareOcrReadings([
    { model: 'hayai-ocr-v2', source: 'こんにちは.' },
    { model: 'paddleocr-vl-1.6', source: 'こんにちは' },
  ]);
  for (const reading of result.readings) reading.translation = 'Hello';
  saveFillMissingSource('e', empty, result);
  saveFillMissingSource('e', keep, result);
  assert.equal((await current(empty.id)).source, 'こんにちは.');
  assert.equal((await current(empty.id)).body, 'Hello');
  assert.equal((await current(keep.id)).source, 'こんにちは.');
  assert.equal((await current(keep.id)).body, 'Stay');
  const majority = compareOcrReadings([
    { model: 'hayai-ocr-v2', source: 'はい' },
    { model: 'paddleocr-vl-1.6', source: 'はい' },
    { model: 'qwen3-vl-8b', source: 'いいえ' },
  ]);
  majority.readings.find(r => r.source === 'いいえ')!.translation = 'No';
  const dissent = await addLine('fill-dissent', { source: '', body: '' });
  saveFillMissingSource('e', dissent, majority);
  assert.equal((await current(dissent.id)).source, 'はい');
  assert.equal((await current(dissent.id)).body, '');
  const pending = sqlite.prepare("SELECT body, translation FROM suggestions WHERE line_id=? AND state='pending'").all(dissent.id) as { body: string; translation: string }[];
  assert.deepEqual(pending, [{ body: 'いいえ', translation: 'No' }]);
});

test('fill-missing disagreement keeps empty source and existing English, and page scope leaves other pages alone', async () => {
  const { startFillMissing } = await import('../src/lib/server/aiTranslate');
  const { collectFillMissingWork, saveFillMissingSource, writeFillMissingEnglish, writeFillMissingSuggestionTranslation } = await import('../src/lib/server/fillMissing');
  const { suggest } = await import('../src/lib/server/workflowStore');
  const line = await addLine('fill-disagree', { imageId: 'p', placed: true, x: .2, y: .2, w: .3, h: .3, source: '', body: 'Stay' });
  const disagreed = pair('ドーン', 'ドン');
  disagreed.readings[0].translation = 'Boom';
  disagreed.readings[1].translation = 'Don';
  saveFillMissingSource('e', line, disagreed);
  assert.equal((await current(line.id)).source, '');
  assert.equal((await current(line.id)).body, 'Stay');
  const pending = sqlite.prepare("SELECT body,translation FROM suggestions WHERE line_id=? AND state='pending'").all(line.id) as any[];
  assert.deepEqual(pending.map(s => [s.body, s.translation]).sort(), [['ドン', 'Don'], ['ドーン', 'Boom']].sort());
  const filled = await addLine('fill-helper-en', { source: '源', body: '', sourceState: 'read' });
  assert.equal(writeFillMissingEnglish('e', filled.id, 'Draft'), true);
  assert.equal((await current(filled.id)).body, 'Draft');
  assert.equal(writeFillMissingEnglish('e', filled.id, 'Overwrite'), false);
  assert.equal((await current(filled.id)).body, 'Draft');
  saveFillMissingSource('e', await current(filled.id), pair('新しい', '新しい'));
  assert.equal((await current(filled.id)).source, '源');
  const sugId = suggest('e', filled.id, (await current(filled.id)).revision ?? 0, '別の源', 'enquiry', 'source-enquiry', '');
  assert.equal(writeFillMissingSuggestionTranslation('e', sugId, 'Enquiry EN'), true);
  assert.equal(writeFillMissingSuggestionTranslation('e', sugId, 'Second'), false);
  assert.equal((sqlite.prepare('SELECT translation FROM suggestions WHERE id=?').get(sugId) as any).translation, 'Enquiry EN');
  const existing = await db.select().from(images).get();
  await db.insert(images).values({ ...existing!, id: 'fill-p2', sortOrder: 99 });
  await db.insert(images).values({ ...existing!, id: 'fill-complete-page', sortOrder: 100 });
  await addLine('fill-other-page', { imageId: 'fill-p2', placed: true, x: .1, y: .1, w: .4, h: .4, source: '', body: '' });
  await addLine('fill-complete-only', { imageId: 'fill-complete-page', placed: true, x: .1, y: .1, w: .2, h: .2, source: '有', body: 'Yes', sourceState: 'read' });
  assert.equal(collectFillMissingWork('e', 'p').sourceLines.some(l => l.id === 'fill-other-page'), false);
  const { jobId } = await startFillMissing({
    series, episode, user: { id: 'human', username: 'Human', role: 'admin' },
    imageId: 'p', engine: 'qwen',
    ocrLine: async () => pair('無視', '無視'),
    translateLines: async (pageLines) => new Map(pageLines.map(l => [l.id, 'NO'])),
    translateSuggestion: async () => 'NO',
  });
  const job = await finished(jobId);
  assert.equal(job.state, 'completed', job.error || '');
  assert.equal((await current('fill-other-page')).source, '');
  assert.equal((await current('fill-other-page')).body, '');
  await assert.rejects(startFillMissing({
    series, episode, user: { id: 'human', username: 'Human', role: 'admin' },
    imageId: 'unknown-page', ocrLine: async () => pair('a', 'a'),
  }), /Page not found/);
  await assert.rejects(startFillMissing({
    series, episode, user: { id: 'human', username: 'Human', role: 'admin' },
    imageId: 'fill-complete-page', ocrLine: async () => pair('a', 'a'),
  }), /Nothing to fill/);
});

test('read-drawing API validates drawings and requires current evidence for the selected reader', async () => {
  const { POST } = await import('../src/routes/api/episodes/[eid]/region-ai/+server');
  const line = await addLine('handwrite-l');
  const locals = { user: { id: 'human', username: 'Human', role: 'admin' } };
  const post = (eid: string, body: Record<string, unknown>) =>
    POST({
      locals,
      params: { eid },
      request: new Request('http://fixture/region-ai', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    } as any);
  const empty = await post('e', {
    action: 'read-drawing',
    lineId: line.id,
    expectedRevision: line.revision,
    image: '',
  });
  assert.equal(empty.status, 400);
  assert.match(await empty.text(), /Draw a character/);
  const junk = await post('e', {
    action: 'read-drawing',
    lineId: line.id,
    expectedRevision: line.revision,
    image: 'not-png',
  });
  assert.equal(junk.status, 400);
  sqlite.prepare("INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES('handwrite-ko','s','handwrite-ko','KO',1,1)").run();
  putDoc('handwrite-ko', 'chapter:handwrite-ko', { lang: 'korean' }, 0);
  await db.insert(lines).values({
    id: 'handwrite-ko-l', episodeId: 'handwrite-ko', source: '', body: '', lineType: 'plain',
    sourceState: 'unreadable', updatedBy: 'human', sortOrder: 0, updatedAt: 1,
  });
  const koLine = (await listLines('handwrite-ko'))[0];
  const korean = await post('handwrite-ko', {
    action: 'read-drawing',
    lineId: koLine.id,
    expectedRevision: koLine.revision,
    image: 'x',
  });
  assert.equal(korean.status, 400);
  assert.match(await korean.text(), /Japanese/);
  const ink = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'white' } })
    .composite([{ input: Buffer.from('<svg width="16" height="16"><rect x="2" y="2" width="4" height="4" fill="black"/></svg>') }])
    .png().toBuffer();
  const { listRegistryRows, saveProbeResult } = await import('../src/lib/server/modelRegistryStore');
  for (const row of listRegistryRows()) saveProbeResult(row.id, {operation:'vision', ok:false, outcome:'unsupported', at:Date.now()});
  const none = await post('e', {
    action: 'read-drawing',
    lineId: line.id,
    expectedRevision: (await current(line.id)).revision,
    image: `data:image/png;base64,${ink.toString('base64')}`,
  });
  const reason = await none.text();
  assert.equal(none.status, 400, reason);
  assert.match(reason, /current passing|Read Text|OCR|test/i);
});
