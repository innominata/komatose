import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import manifest from '../fixtures/manhwa-pages/manifest.json';
import { benchmarkDataset } from '../src/lib/benchmarkDatasets';
import { GOLD_PAGES, goldOcrGroup, goldRequired, goldTranslationLines, type GoldPage } from '../src/lib/benchmarkGold';
import { benchmarkPagePrompt, keyHits, ocrKey, officialBaseline, scoreDetection, scoreOcrPage, scoreTranslationPage, totalDetection, totalOcr, totalTranslation } from '../src/lib/modelBenchmark';
import { SEED_ROWS, type ModelRow } from '../src/lib/modelRegistry';
import { bubbleFromNorm } from '../src/lib/server/bubbles';

const scratch = await mkdtemp(join(tmpdir(), 'komatose-korean-benchmark-'));
process.env.SCAN_ROOT = process.cwd();
process.env.SCAN_DATA_DIR = join(scratch, 'data');
process.env.DATABASE_URL = join(scratch, 'scan.db');
after(() => rm(scratch, { recursive: true, force: true }));
const ko = benchmarkDataset('manhwa-ko');
const server = await import('../src/lib/server/modelBenchmark');
const general = (id: string, lang?: 'korean' | 'japanese'): ModelRow => ({
  ...SEED_ROWS[0], id, name: id, slug: id, runtime: undefined, languages: lang ? [lang] : undefined,
  seeded: false, access: 'remote_http', operations: ['vision', 'translate'],
  qualificationAdapter: 'direct', managedLaunch: undefined,
  probes: { vision: { operation: 'vision', ok: true, at: 1 }, translate: { operation: 'translate', ok: true, at: 1 } },
});
const reader = general('fixture-ko-reader', 'korean');
const translator = general('fixture-ko-translator', 'korean');

test('all eight bundled Korean pages have checked, valid gold and immutable source hashes', async () => {
  assert.equal(ko.lang, 'korean');
  assert.equal(ko.referenceLabel, 'reference');
  assert.deepEqual(ko.pages.map(page => page.id), manifest.map(page => page.id));
  assert.equal(ko.pages.length, 8);
  const ids = new Set<string>();
  for (const page of ko.pages) {
    const bytes = await readFile(page.file);
    const meta = await sharp(bytes).metadata();
    assert.equal(meta.width, page.width);
    assert.equal(meta.height, page.height);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.find(item => item.id === page.id)!.sha256);
    assert.equal(page.english, undefined);
    for (const line of page.lines) {
      assert.ok(!ids.has(line.id), line.id);
      ids.add(line.id);
      assert.ok(line.boxes.length);
      for (const [x0, y0, x1, y1] of line.boxes) {
        assert.ok([x0, y0, x1, y1].every(Number.isInteger));
        assert.ok(x0 >= 0 && y0 >= 0 && x1 <= page.width && y1 <= page.height && x1 > x0 && y1 > y0, line.id);
      }
      if (line.ocr === false) {
        assert.ok(line.note, line.id);
        assert.equal(line.source, '');
        assert.equal(goldOcrGroup(line), null);
        assert.ok(!goldTranslationLines(page).includes(line));
      } else if (goldOcrGroup(line) && ocrKey(line.source)) {
        assert.ok(line.en && line.literal, `${line.id}: readable lettering needs references`);
      }
      if (line.en) assert.deepEqual(keyHits(line.keys, line.en).missed, [], line.id);
    }
  }
  assert.ok(ko.pages.flatMap(goldTranslationLines).length >= 35);
  const baseline = officialBaseline(ko.pages);
  assert.equal(baseline.official, 1);
  assert.equal(baseline.meaning, 1);
});

test('Korean scoring handles Hangul normalization, standalone jamo, SFX and punctuation', () => {
  for (const page of ko.pages) {
    const output = page.lines.filter(line => line.ocr !== false).flatMap(line => line.boxes.map(() => line.source)).join('\n');
    const perfect = totalOcr([scoreOcrPage(page, output.normalize('NFD'))]);
    assert.equal(perfect.dialogue, 1, page.id);
    assert.equal(perfect.other, 1, page.id);
    assert.equal(perfect.noise, 0, page.id);
    const detection = totalDetection([scoreDetection(page, page.lines.flatMap(line => line.boxes))]);
    assert.equal(detection.recall, 1);
    assert.equal(detection.precision, 1);
    assert.equal(scoreDetection(page, [[0, 1600, 10, 1610]]).falseAlarms, 1);
  }
  const jamo: GoldPage = { ...ko.pages[0], lines: [{ id: 'jamo', kind: 'sfx', source: 'ㅋㅋ ㅠㅠ', boxes: [[0, 0, 100, 100]] }] };
  assert.equal(totalOcr([scoreOcrPage(jamo, 'ㅋㅋ\nㅠㅠ')]).other, 1);
  assert.ok(totalOcr([scoreOcrPage(ko.pages[0], '')]).dialogue === 0);
  const corrupted = scoreOcrPage(ko.pages[0], ko.pages[0].lines.map(line => line.source).join('\n').replace('미안', '미앙'));
  assert.ok(corrupted.lines.find(line => line.id === '001-sorry')!.accuracy < 1);
  assert.ok(scoreOcrPage(ko.pages[0], '허구의없는말아무거나').noise > 0);
  const reaction = ko.pages[1].lines.find(line => line.id === '002-reaction')!;
  assert.ok(goldRequired(reaction));
  assert.ok(!goldTranslationLines(ko.pages[1]).includes(reaction));
  assert.equal(scoreOcrPage(ko.pages[1], '…?').lines.some(line => line.id === reaction.id), false);
  assert.match(benchmarkPagePrompt('korean'), /Korean.*top-to-bottom, left-to-right/);
  assert.match(benchmarkPagePrompt('japanese'), /Japanese.*right-to-left/);
});

test('Korean translation scores references and missing lines with the existing metrics', () => {
  const page = ko.pages[5];
  const gold = goldTranslationLines(page);
  const scores = scoreTranslationPage(page, gold.map(line => ({ id: line.id, translation: line.en!, literal: line.literal })));
  assert.equal(totalTranslation(scores).official, 1);
  assert.equal(totalTranslation(scores).literal, 1);
  assert.equal(totalTranslation(scores).meaning, 1);
  assert.equal(totalTranslation(scoreTranslationPage(page, [])).missing, gold.length);
});

test('dataset IDs and model language restrictions are enforced before starting work', () => {
  assert.throws(() => benchmarkDataset('bad'), /Unknown benchmark dataset/);
  assert.throws(() => server.listBenchmarkStatus('bad'), /Unknown benchmark dataset/);
  assert.throws(() => server.startOcrBenchmark({ dataset: 'bad', detectors: ['heuristic'] }), /Unknown benchmark dataset/);
  const rows = [reader, general('ja', 'japanese'), general('unrestricted')];
  assert.deepEqual(server.ocrBenchmarkRows(rows, 'korean').map(row => row.id), [reader.id, 'unrestricted']);
  assert.deepEqual(server.ocrBenchmarkRows(rows).map(row => row.id), ['ja', 'unrestricted']);
  const specialists = ['imsbee-ko-en-translator', 'opus-mt-ja-en'].map(id => {
    const row = SEED_ROWS.find(item => item.id === id)!;
    return { ...row, probes: { translate: { operation: 'translate' as const, ok: true, at: 1 } } };
  });
  assert.deepEqual(server.translationBenchmarkRows(specialists, () => true, 'korean').map(row => row.id), ['imsbee-ko-en-translator']);
  assert.deepEqual(server.translationBenchmarkRows(specialists, () => false, 'korean'), []);
  assert.deepEqual(server.translationBenchmarkRows(specialists, () => true).map(row => row.id), ['opus-mt-ja-en']);
  assert.throws(() => server.startOcrBenchmark({ dataset: ko.id, rows: [general('ja', 'japanese')], models: ['ja'] }), /not available/);
  assert.throws(() => server.startTranslationBenchmark({ dataset: ko.id, rows: [specialists[1]], models: [specialists[1].id] }), /not available/);
});

test('legacy Japanese results load without leaking into Korean or changing the old file', async () => {
  const dir = join(scratch, 'data/run');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'model-benchmark-translation.json');
  const legacy = { kind: 'translation', id: 'legacy', at: 1, state: 'done', models: [{ id: 'legacy', state: 'done', pages: [{ page: '001', lines: [{ ja: '日本語' }] }] }] };
  await writeFile(file, JSON.stringify(legacy));
  const loaded = server.listBenchmarkStatus().runs.translation!;
  assert.equal(loaded.dataset, 'manga-ja');
  assert.equal(loaded.models[0].pages[0].lines[0].source, '日本語');
  assert.equal('ja' in loaded.models[0].pages[0].lines[0], false);
  assert.equal(server.listBenchmarkStatus(ko.id).runs.translation, null);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), legacy);
  const mismatched = join(dir, 'model-benchmark-manhwa-ko-v1-translation.json');
  await writeFile(mismatched, JSON.stringify({ ...legacy, dataset: ko.id, datasetVersion: 2 }));
  assert.equal(server.listBenchmarkStatus(ko.id).runs.translation, null);
  await rm(mismatched);
});

test('Korean OCR routes language through detection and recognition and skips uncertain crops', async () => {
  const page = ko.pages[2];
  const seen: string[] = [];
  const excluded = page.lines.find(line => line.ocr === false)!;
  const [x0, y0, x1, y1] = excluded.boxes[0];
  const excludedBubble = bubbleFromNorm(page.width, page.height, x0 / page.width, y0 / page.height, (x1 - x0) / page.width, (y1 - y0) / page.height);
  assert.deepEqual(server.scoredOcrBubbles(page, [excludedBubble]), []);
  server.startOcrBenchmark({
    dataset: ko.id, pages: [page], rows: [reader], models: [reader.id], sources: ['gold', 'heuristic'], detectors: ['heuristic'],
    detectPart: async (_part, page, _path, _abort, lang) => {
      assert.equal(lang, 'korean');
      seen.push('detect');
      return { regions: page.lines.flatMap(line => line.boxes.map(box => ({ cls: 'text' as const, score: 1, box }))), width: page.width, height: page.height };
    },
    mask: async () => undefined,
    crop: async (_raw, bubble) => Buffer.from(JSON.stringify([bubble.left, bubble.top])),
    readCrop: async (_row, jpeg, _abort, lang) => {
      assert.equal(lang, 'korean');
      const [x, y] = JSON.parse(jpeg.toString());
      const line = page.lines.find(line => line.boxes.some(box => Math.abs(box[0] - x) <= 12 && Math.abs(box[1] - y) <= 12));
      assert.ok(line);
      assert.notEqual(line.ocr, false);
      seen.push(line.id);
      return line.source;
    },
  });
  const { ocr } = await server.waitBenchmark();
  assert.equal(ocr!.state, 'done');
  assert.equal(ocr!.dataset, ko.id);
  assert.equal(ocr!.progress.done, ocr!.progress.total);
  assert.ok(seen.includes('detect'));
  assert.ok(ocr!.models.every(model => model.totals.dialogue === 1));
  assert.equal(server.listBenchmarkStatus().runs.ocr, null);
});

test('dataset histories remain separate through active runs, reruns and cancellation', async () => {
  const page = ko.pages[0];
  const perfect = async (_row: ModelRow, boxes: ReturnType<typeof server.translationBoxes>, page: GoldPage, _abort: AbortSignal, dataset: typeof ko) => {
    assert.equal(dataset.lang, 'korean');
    assert.equal(boxes[0].source, page.lines[0].source);
    assert.equal(boxes[0].lineType, '""');
    return boxes.map(box => ({ ...box, translation: page.lines.find(line => line.id === box.id)!.en! }));
  };
  server.startTranslationBenchmark({ dataset: ko.id, pages: [page], rows: [translator], models: [translator.id], translate: perfect });
  const first = (await server.waitBenchmark()).translation!;
  assert.equal(first.models[0].totals.official, 1);
  assert.equal(server.listBenchmarkStatus().runs.translation!.id, 'legacy');
  const other = general('fixture-other', 'korean');
  server.startTranslationBenchmark({ dataset: ko.id, pages: [page], rows: [other], models: [other.id], translate: async () => [] });
  await server.waitBenchmark();
  assert.equal(server.listBenchmarkStatus(ko.id).runs.translation!.models.find(model => model.id === translator.id)!.totals.official, 1);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  server.startTranslationBenchmark({ dataset: ko.id, pages: [page], rows: [translator], models: [translator.id], translate: async (_row, _boxes, _page, abort) => {
    await gate;
    abort.throwIfAborted();
    return [];
  } });
  const viewedJapanese = server.listBenchmarkStatus();
  assert.equal(viewedJapanese.runningDataset, ko.id);
  assert.equal(viewedJapanese.runs.translation!.id, 'legacy');
  assert.throws(() => server.startOcrBenchmark({ detectors: ['heuristic'] }), /already running/);
  assert.equal(server.cancelBenchmark(), true);
  release();
  await server.waitBenchmark();
  const cancelled = server.listBenchmarkStatus(ko.id).runs.translation!;
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.models.find(model => model.id === translator.id)!.totals.official, 1);
  assert.ok(cancelled.models.some(model => model.id === other.id));
  const saved = JSON.parse(await readFile(join(scratch, 'data/run/model-benchmark-manhwa-ko-v1-translation.json'), 'utf8'));
  assert.equal(saved.dataset, ko.id);
  assert.equal(saved.datasetVersion, 1);
  assert.equal(JSON.parse(await readFile(join(scratch, 'data/run/model-benchmark-translation.json'), 'utf8')).id, 'legacy');
});

test('page images use the selected dataset and text-only English returns 404', async () => {
  const koImage = await server.benchmarkPageImage('001', false, 5000, ko.id);
  const metadata = await sharp(koImage).metadata();
  assert.equal(metadata.width, 941);
  assert.equal(metadata.height, 1672);
  assert.equal((await sharp(await server.benchmarkPageImage('001')).metadata()).width, 720);
  await assert.rejects(server.benchmarkPageImage('001', true, 720, ko.id), /text-only/);
  await assert.rejects(server.benchmarkPageImage('999', false, 720, ko.id), /Unknown benchmark page/);
});

test('detection evaluator validates cache dataset/version and accepts both dataset flag forms', async () => {
  const cachePath = join(scratch, 'detection-cache.json');
  const env = { ...process.env, DETECT_EVAL_CACHE: cachePath };
  await writeFile(cachePath, JSON.stringify({ dataset: ko.id, datasetVersion: 1, pages: {} }));
  for (const args of [['--dataset', ko.id], [`--dataset=${ko.id}`]]) {
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/eval-detection.ts', ...args, 'rtdetr'], { env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
  }
  const mismatch = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/eval-detection.ts', '--dataset', 'manga-ja'], { env, encoding: 'utf8' });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /Cache does not match/);
});
