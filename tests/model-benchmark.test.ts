import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import sharp from 'sharp';
import { GOLD_PAGES, goldRequired, goldTranslationLines, type GoldBox } from '../src/lib/benchmarkGold';
import {
	chrf,
	englishHas,
	fuzzyFind,
	keyHits,
	ocrKey,
	officialBaseline,
	parseBenchmarkOutput,
	parseReviewGrades,
	parseReviewScore,
	REVIEW_SYSTEM,
	reviewLetter,
	reviewUserPrompt,
	scoreDetection,
	scoreOcrPage,
	scoreTranslationPage,
	totalDetection,
	totalOcr,
	totalTranslation,
} from '../src/lib/modelBenchmark';
import { compareSortValues, nextSort, sortedBy } from '../src/lib/benchmarkSort';
import { QWEN3_VL_ID } from '../src/lib/qwenModels';
import { localReviewModel } from '../src/lib/localReviewModels';
import { DEFAULT_TRANSCRIPTION_MODEL_IDS, SEED_ROWS } from '../src/lib/modelRegistry';

const root = await mkdtemp(join(tmpdir(), 'scan-benchmark-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.DATABASE_URL = join(root, 'data', 'test.db');
after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

const page = (id: string) => GOLD_PAGES.find((item) => item.id === id)!;

test('the gold covers all ten fixture pages with sane boxes and references', () => {
	assert.deepEqual(GOLD_PAGES.map((item) => item.id), ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010']);
	const ids = new Set<string>();
	for (const item of GOLD_PAGES) {
		assert.ok(existsSync(join(process.cwd(), item.file)), item.file);
		assert.ok(existsSync(join(process.cwd(), item.english!)), item.english);
		for (const line of item.lines) {
			assert.ok(!ids.has(line.id), `duplicate ${line.id}`);
			ids.add(line.id);
			assert.ok(line.id.startsWith(`${item.id}-`), line.id);
			assert.ok(line.boxes.length, line.id);
			for (const [x0, y0, x1, y1] of line.boxes) {
				assert.ok(x0 >= 0 && y0 >= 0 && x1 <= item.width && y1 <= item.height && x1 > x0 && y1 > y0, `${line.id} box`);
			}
			if (line.en) assert.ok(line.literal, `${line.id} has official English but no literal`);
			// The official English must pass its own meaning checks, or the keys are wrong.
			if (line.en && line.keys) assert.equal(keyHits(line.keys, line.en).missed.length, 0, `${line.id}: ${keyHits(line.keys, line.en).missed}`);
		}
	}
	assert.equal(page('005').lines.length, 0, 'page 5 is art only');
	const translated = GOLD_PAGES.flatMap(goldTranslationLines);
	assert.ok(translated.length >= 40, `${translated.length} translation lines`);
	assert.ok(GOLD_PAGES.flatMap((item) => item.lines).filter(goldRequired).length >= 30);
});

test('detection: gold boxes score perfect, a blank page is all false alarms, bubble boxes count', () => {
	const p = page('007');
	const boxes = p.lines.flatMap((line) => line.boxes);
	const perfect = totalDetection([scoreDetection(p, boxes)]);
	assert.equal(perfect.recall, 1);
	assert.equal(perfect.precision, 1);

	const blank = scoreDetection(page('005'), [[100, 100, 300, 300]]);
	assert.equal(blank.falseAlarms, 1);
	assert.equal(blank.targets, 0);

	// A balloon-sized box around one line is still a correct detection.
	const [x0, y0, x1, y1] = p.lines.find((line) => line.id === '007-i-win')!.boxes[0];
	const bubble: GoldBox = [x0 - 40, y0 - 40, x1 + 40, y1 + 40];
	const one = scoreDetection(p, [bubble]);
	assert.equal(one.correct, 1);
	assert.equal(one.found, 1);
	assert.ok(one.missed.includes('007-24-hours'));

	// A sign detection is neutral: no credit, no penalty.
	const sign = scoreDetection(page('003'), [page('003').lines.find((line) => line.id === '003-sign')!.boxes[0]]);
	assert.equal(sign.neutral, 1);
	assert.equal(sign.falseAlarms, 0);
	assert.equal(sign.optionalFound, 1);

	// Repeated SFX boxes are separate targets.
	const scrub = p.lines.find((line) => line.id === '007-scrub')!;
	const half = scoreDetection(p, scrub.boxes.slice(0, 2));
	assert.equal(half.sfxTargets, 4);
	assert.equal(half.sfxFound, 2);
});

test('OCR: fuzzy alignment ignores order and punctuation, charges edits, and measures noise', () => {
	assert.equal(ocrKey('8千人……'), '8千人');
	assert.equal(ocrKey('ＡＢ！？ 1'), 'AB1');
	assert.deepEqual(fuzzyFind('xxabcxx', 'abc'), { distance: 0, start: 2, end: 5 });
	assert.equal(fuzzyFind('xxabdxx', 'abc').distance, 1);

	const p = page('007');
	const perfect = scoreOcrPage(p, [...p.lines].reverse().map((line) => line.source).join('\n'));
	assert.ok(perfect.lines.every((line) => line.accuracy === 1));
	assert.equal(perfect.noise, 0);

	const sloppy = scoreOcrPage(p, 'じゃあ僕の勝ちだ\n2時間しか寝てない\n関係ない文字列です');
	const win = sloppy.lines.find((line) => line.id === '007-i-win')!;
	assert.equal(win.accuracy, 1);
	assert.ok(sloppy.lines.find((line) => line.id === '007-24-hours')!.accuracy < 0.5);
	assert.ok(sloppy.noise > 0.2);
	const totals = totalOcr([sloppy]);
	assert.ok(totals.dialogue > 0 && totals.dialogue < 1);

	const typo = scoreOcrPage(page('006'), '眠そうだな斎藤');
	assert.ok(Math.abs(typo.lines.find((line) => line.id === '006-sleepy')!.accuracy - 6 / 7) < 1e-9);
});

test('translation: chrF, word-safe meaning keys, and literal scoring', () => {
	assert.equal(chrf('Then I win.', 'Then I win.'), 1);
	assert.equal(chrf('', 'Then I win.'), 0);
	assert.ok(chrf('Then I win', 'then i win!') > 0.8);
	assert.ok(chrf('I only slept 2 hours!', 'I only slept 3 hours!') > chrf('Bananas are yellow.', 'I only slept 3 hours!'));
	assert.equal(englishHas('This is it', 'hi'), false);
	assert.equal(englishHas('Eels and Godhands', 'eel'), true);
	assert.equal(englishHas('in your hands', 'you'), true);
	assert.equal(englishHas('slept 12 hours', '2'), false);
	assert.equal(englishHas("It's my victory", 'win'), false);

	const p = page('007');
	const lines = scoreTranslationPage(p, goldTranslationLines(p).map((line) => ({ id: line.id, translation: line.en!, literal: line.literal })));
	const totals = totalTranslation(lines);
	assert.equal(totals.official, 1);
	assert.equal(totals.literal, 1);
	assert.equal(totals.meaning, 1);
	assert.equal(totals.missing, 0);

	const empty = totalTranslation(scoreTranslationPage(p, []));
	assert.equal(empty.missing, goldTranslationLines(p).length);
	assert.equal(empty.official, 0);

	const baseline = officialBaseline();
	assert.equal(baseline.official, 1);
	assert.ok(baseline.literal > 0.3 && baseline.literal < 0.9, `official vs literal ${baseline.literal}`);
});

test('page output parser accepts line lists, a source string, or raw text', () => {
	assert.equal(parseBenchmarkOutput('{"lines":["あ","い"]}').source, 'あ\nい');
	assert.equal(parseBenchmarkOutput('{"source":"あ"}').source, 'あ');
	assert.equal(parseBenchmarkOutput('ありがとう').source, 'ありがとう');
});

test('the retired Qwen3-VL 4B is gone from every registry', () => {
	assert.equal(localReviewModel('qwen3-vl-4b'), undefined);
	assert.ok(!SEED_ROWS.some((row) => row.id === 'qwen3-vl-4b'));
	assert.ok(!(DEFAULT_TRANSCRIPTION_MODEL_IDS as readonly string[]).includes('qwen3-vl-4b'));
	assert.equal(localReviewModel(QWEN3_VL_ID)?.id, QWEN3_VL_ID);
});

test('visible CLI rows join both benchmarks; hidden rows do not', async () => {
	const { ocrBenchmarkRows, translationBenchmarkRows } = await import('../src/lib/server/modelBenchmark');
	const passed = (operation: 'translate' | 'vision') => ({ operation, ok: true as const, at: 1 });
	const grok = { ...SEED_ROWS[0], id: 'grok-4.6', name: 'Grok 4.6', slug: 'grok-4.6', access: 'cli' as const, cliAdapter: 'grok' as const, runtime: undefined, probes: { translate: passed('translate'), vision: passed('vision') }, operations: ['translate', 'vision'] as never, seeded: false };
	const rows = [
		...SEED_ROWS.map((row) => (
			row.id === 'hy-mt2-manga-v5' || row.id === 'opus-mt-ja-en' || row.id === 'imsbee-ko-en-translator'
				? { ...row, probes: { translate: passed('translate') } }
				: row
		)),
		grok,
	];
	assert.ok(ocrBenchmarkRows(rows).some((row) => row.id === 'grok-4.6'));
	assert.ok(translationBenchmarkRows(rows).some((row) => row.id === 'grok-4.6'));
	assert.ok(translationBenchmarkRows(rows, () => true).some((row) => row.id === 'hy-mt2-manga-v5'));
	assert.ok(!translationBenchmarkRows(rows, (model) => model.id !== 'opus-mt-ja-en').some((row) => row.id === 'opus-mt-ja-en'), 'translators without weights are not offered');
	assert.ok(!translationBenchmarkRows(rows, () => true).some((row) => row.id === 'imsbee-ko-en-translator'), 'Korean-only translator is not offered for Japanese');
	assert.ok(!ocrBenchmarkRows(rows).some((row) => row.id === 'qwen3-vl-4b'));
	const hidden = rows.map((row) => (row.id === 'grok-4.6' ? { ...row, disabled: true } : row));
	assert.ok(!ocrBenchmarkRows(hidden).some((row) => row.id === 'grok-4.6'));
	assert.ok(!translationBenchmarkRows(hidden).some((row) => row.id === 'grok-4.6'));
});

const blankJpeg = await sharp({ create: { width: 1414, height: 2000, channels: 3, background: '#fff' } }).jpeg().toBuffer();

test('OCR run: every detector setup is scored per page, and crop models read gold and detector crops', async () => {
	const { startOcrBenchmark, waitBenchmark, listDetectorSetups } = await import('../src/lib/server/modelBenchmark');
	const setups = listDetectorSetups().map((setup) => setup.id);
	for (const id of ['rtdetr', 'ctd', 'paddle', 'heuristic', 'coo', 'koharu', 'rtdetr+coo+koharu']) assert.ok(setups.includes(id), id);
	const pages = [page('006'), page('007')];
	const row = SEED_ROWS.find((item) => item.id === 'paddleocr-vl-1.6')!;
	const calls: string[] = [];
	const readTexts: string[] = [];
	startOcrBenchmark({
		detectors: ['rtdetr', 'rtdetr+coo', 'koharu'],
		models: [row.id],
		sources: ['gold', 'rtdetr'],
		rows: [row],
		pages,
		image: async () => blankJpeg,
		// RT-DETR finds every dialogue box; COO finds the SFX; Koharu finds nothing.
		detectPart: async (part, p) => {
			calls.push(`${part}:${p.id}`);
			const lines = p.lines.filter((line) => part === 'coo' ? line.kind === 'sfx' : part === 'rtdetr' ? line.kind === 'speech' : false);
			return { regions: lines.flatMap((line) => line.boxes.map((box) => ({ cls: part === 'coo' ? 'text_free' : 'text', score: 0.9, box }))), width: 1414, height: 2000 };
		},
		mask: async () => undefined,
		crop: async (_raw, bubble) => Buffer.from(JSON.stringify([bubble.left, bubble.top])),
		readCrop: async (_row, jpeg) => {
			const [x, y] = JSON.parse(jpeg.toString()) as number[];
			const line = pages.flatMap((p) => p.lines).find((item) => item.boxes.some((b) => Math.abs(b[0] - x) <= 12 && Math.abs(b[1] - y) <= 12));
			readTexts.push(line?.id || '?');
			return line?.source || '';
		},
	});
	const { ocr } = await waitBenchmark();
	assert.equal(ocr?.state, 'done');
	// RT-DETR is always cross-checked by Comic Text Detector, so its setups run both.
	assert.deepEqual(calls.sort(), ['coo:006', 'coo:007', 'ctd:006', 'ctd:007', 'koharu:006', 'koharu:007', 'rtdetr:006', 'rtdetr:007']);
	const rt = ocr!.detectors.find((item) => item.id === 'rtdetr')!;
	const rtCoo = ocr!.detectors.find((item) => item.id === 'rtdetr+coo')!;
	const koharu = ocr!.detectors.find((item) => item.id === 'koharu')!;
	assert.equal(rt.pages.length, 2);
	assert.equal(rt.totals.dialogueFound, rt.totals.dialogueTargets);
	assert.equal(rt.totals.sfxFound, 0);
	assert.equal(rtCoo.totals.recall, 1);
	assert.equal(koharu.totals.found, 0);

	const gold = ocr!.models.find((item) => item.source === 'gold')!;
	const viaRt = ocr!.models.find((item) => item.source === 'rtdetr')!;
	assert.equal(gold.state, 'done');
	assert.equal(gold.totals.dialogue, 1);
	assert.ok(gold.totals.other > 0.99, 'signs and SFX read from gold crops');
	assert.equal(viaRt.totals.dialogue, 1);
	assert.ok(viaRt.totals.other < gold.totals.other, 'RT-DETR alone misses the SFX, so its crops cannot read them');
	assert.equal(ocr!.progress.done, ocr!.progress.total);
});

test('OCR run: one failed crop does not fail the page, and English misreads are dropped like chapter transcription', async () => {
	const { startOcrBenchmark, waitBenchmark } = await import('../src/lib/server/modelBenchmark');
	const p = page('007');
	const row = SEED_ROWS.find((item) => item.id === 'paddleocr-vl-1.6')!;
	const art: [number, number, number, number] = [60, 60, 220, 220];
	startOcrBenchmark({
		detectors: ['rtdetr'],
		models: [row.id],
		sources: ['rtdetr'],
		rows: [row],
		pages: [p],
		image: async () => blankJpeg,
		detectPart: async (part) => ({
			regions: part === 'rtdetr'
				? [...p.lines.filter((line) => line.kind === 'speech').flatMap((line) => line.boxes), art].map((box) => ({ cls: 'text', score: 0.9, box }))
				: [],
			width: 1414,
			height: 2000,
		}),
		mask: async () => undefined,
		crop: async (_raw, bubble) => Buffer.from(JSON.stringify([bubble.left, bubble.top])),
		readCrop: async (_row, jpeg) => {
			const [x, y] = JSON.parse(jpeg.toString()) as number[];
			if (Math.abs(x - art[0]) <= 12 && Math.abs(y - art[1]) <= 12) return 'HOSARY';
			const line = p.lines.find((item) => item.boxes.some((b) => Math.abs(b[0] - x) <= 12 && Math.abs(b[1] - y) <= 12));
			if (line?.id === '007-me-too') throw new Error('reached its output limit');
			return line?.source || '';
		},
	});
	const { ocr } = await waitBenchmark();
	const result = ocr!.models[0];
	assert.equal(result.state, 'done');
	assert.equal(result.error, undefined);
	const read = result.pages[0];
	assert.equal(read.error, undefined);
	assert.equal(read.failedCrops, 1);
	assert.match(read.cropError || '', /output limit/);
	assert.equal(read.dropped, 1);
	assert.ok(!read.output.includes('HOSARY'));
	assert.equal(read.lines.find((line) => line.id === '007-me-too')?.accuracy, 0);
	assert.equal(read.lines.find((line) => line.id === '007-i-win')?.accuracy, 1);
});

test('translation run: page lines go out with ids and line types; missing lines and failures are scored', async () => {
	const { startTranslationBenchmark, waitBenchmark, startOcrBenchmark } = await import('../src/lib/server/modelBenchmark');
	const row = SEED_ROWS.find((item) => item.id === 'hy-mt2-manga-v5')!;
	const seen: string[] = [];
	startTranslationBenchmark({
		models: [row.id],
		rows: [row],
		pages: [page('005'), page('007'), page('009')],
		translate: async (_row, boxes, p) => {
			if (p.id === '009') throw new Error('model offline');
			seen.push(...boxes.map((box) => `${box.id}:${box.lineType}`));
			return boxes.map((box) => {
				const line = p.lines.find((item) => item.id === box.id)!;
				return { ...box, translation: box.id === '007-i-win' ? '' : line.en!, literal: line.literal! };
			});
		},
	});
	assert.throws(() => startOcrBenchmark({ detectors: ['rtdetr'] }), /already running/);
	const { translation } = await waitBenchmark();
	assert.equal(translation?.state, 'done');
	assert.deepEqual(translation!.pages, ['007', '009'], 'page 5 has nothing to translate');
	assert.ok(seen.includes('007-scrub:::'));
	assert.ok(seen.includes('007-i-win:""'));
	const result = translation!.models[0];
	assert.equal(result.totals.missing, goldTranslationLines(page('009')).length + 1);
	assert.match(result.error || '', /1 of 2 pages failed: model offline/);
	assert.ok(result.totals.official > 0.2 && result.totals.official < 1);
});

test('unknown models and detectors are rejected before anything runs', async () => {
	const { startOcrBenchmark, startTranslationBenchmark } = await import('../src/lib/server/modelBenchmark');
	assert.throws(() => startOcrBenchmark({ detectors: ['nope'] }), /Unknown text detector/);
	assert.throws(() => startOcrBenchmark({ models: ['qwen3-vl-4b'], rows: SEED_ROWS }), /not available/);
	assert.throws(() => startTranslationBenchmark({ models: [], rows: SEED_ROWS }), /at least one/);
});

test('a new run keeps the last result for every model and detector it does not rerun', async () => {
	const { startOcrBenchmark, startTranslationBenchmark, waitBenchmark, listBenchmarkStatus, cancelBenchmark } = await import('../src/lib/server/modelBenchmark');
	const hy = SEED_ROWS.find((item) => item.id === 'hy-mt2-manga-v5')!;
	const opus = SEED_ROWS.find((item) => item.id === 'opus-mt-ja-en')!;
	const paddle = SEED_ROWS.find((item) => item.id === 'paddleocr-vl-1.6')!;
	const pages = [page('007')];
	startTranslationBenchmark({
		models: [hy.id],
		rows: [hy, opus],
		pages,
		translate: async (_row, boxes, p) => boxes.map((box) => {
			const line = p.lines.find((item) => item.id === box.id)!;
			return { ...box, translation: line.en || '', literal: line.literal || '' };
		}),
	});
	await waitBenchmark();
	startTranslationBenchmark({
		models: [opus.id],
		rows: [hy, opus],
		pages,
		translate: async (_row, boxes) => boxes.map((box) => ({ ...box, translation: 'no', literal: 'no' })),
	});
	const { translation } = await waitBenchmark();
	const kept = translation!.models.find((item) => item.id === hy.id)!;
	const replaced = translation!.models.find((item) => item.id === opus.id)!;
	assert.equal(translation!.models.filter((item) => item.id === hy.id).length, 1);
	assert.ok(kept.totals.official > replaced.totals.official, 'a model left out of the new run keeps its score');
	assert.ok(kept.at && replaced.at && kept.at < replaced.at);

	let release = () => {};
	const gate = new Promise<void>((resolve) => { release = resolve; });
	startTranslationBenchmark({
		models: [opus.id],
		rows: [hy, opus],
		pages,
		translate: async (_row, _boxes, _p, signal) => {
			await gate;
			signal.throwIfAborted();
			return [];
		},
	});
	const deadline = Date.now() + 2000;
	let shown = listBenchmarkStatus().runs.translation;
	while (Date.now() < deadline && shown?.models.find((item) => item.id === opus.id)?.state !== 'running') {
		await new Promise((resolve) => setTimeout(resolve, 10));
		shown = listBenchmarkStatus().runs.translation;
	}
	assert.equal(shown?.models.find((item) => item.id === hy.id)?.state, 'done', 'models not in the running benchmark stay visible');
	assert.equal(shown?.models.find((item) => item.id === opus.id)?.state, 'running');
	assert.equal(cancelBenchmark(), true);
	release();
	await waitBenchmark();
	const afterCancel = listBenchmarkStatus().runs.translation!;
	assert.equal(afterCancel.state, 'cancelled');
	assert.equal(afterCancel.models.find((item) => item.id === opus.id)?.totals.official, replaced.totals.official, 'cancelling a rerun puts the last score back');

	startOcrBenchmark({
		detectors: ['rtdetr'],
		models: [paddle.id],
		sources: ['gold'],
		rows: [paddle],
		pages,
		image: async () => blankJpeg,
		detectPart: async () => ({ regions: [], width: 1414, height: 2000 }),
		mask: async () => undefined,
		crop: async () => blankJpeg,
		readCrop: async () => 'x',
	});
	await waitBenchmark();
	startOcrBenchmark({
		detectors: ['heuristic'],
		pages,
		image: async () => blankJpeg,
		detectPart: async () => ({ regions: [], width: 1414, height: 2000 }),
		mask: async () => undefined,
		crop: async () => blankJpeg,
	});
	const { ocr } = await waitBenchmark();
	assert.equal(ocr!.detectors.filter((item) => item.id === 'rtdetr').length, 1);
	assert.ok(ocr!.detectors.some((item) => item.id === 'heuristic'));
	assert.ok(ocr!.models.some((item) => item.id === paddle.id && item.source === 'gold'), 'an OCR row stays when the next run does not include it');
});

test('benchmark column sort puts missing values last and toggles on the same header', () => {
	assert.equal(compareSortValues(1, 2, 'asc'), -1);
	assert.equal(compareSortValues(1, 2, 'desc'), 1);
	assert.ok(compareSortValues(Number.NaN, 1, 'desc') > 0);
	assert.ok(compareSortValues(1, Number.NaN, 'asc') < 0);
	assert.equal(compareSortValues('', 'b', 'asc'), 1);
	const first = nextSort({ key: 'f1', dir: 'desc' }, 'label', 'asc');
	assert.deepEqual(first, { key: 'label', dir: 'asc' });
	assert.deepEqual(nextSort(first, 'label', 'asc'), { key: 'label', dir: 'desc' });
	const rows = sortedBy(
		[{ id: 'low', n: 0.2 }, { id: 'high', n: 0.9 }, { id: 'empty', n: Number.NaN }],
		{ key: 'n', dir: 'desc' },
		(row) => row.n,
	);
	assert.deepEqual(rows.map((row) => row.id), ['high', 'low', 'empty']);
});

test('meaning review grades saved translations without rewarding a copied reference', async () => {
	assert.equal(parseReviewScore(96), 0.96);
	assert.equal(parseReviewScore('0.82'), 0.82);
	assert.equal(parseReviewScore('B'), 0.82);
	assert.equal(parseReviewScore(1), 1);
	assert.equal(reviewLetter(0.96), 'A');
	assert.equal(reviewLetter(0.82), 'B');
	assert.match(REVIEW_SYSTEM, /Do not reward copying the reference/);
	assert.match(REVIEW_SYSTEM, /assessment of two to four sentences/);
	const graded = parseReviewGrades('```json\n{"assessment":"Holds the meaning in different words.","lines":[{"id":"007-i-win","score":96,"note":"Same win, different words."},{"id":"other","score":10,"note":"no"}]}\n```', ['007-i-win']);
	assert.equal(graded.assessment, 'Holds the meaning in different words.');
	assert.deepEqual(graded.lines, [{ id: '007-i-win', comparable: 0.96, note: 'Same win, different words.' }]);
	assert.throws(() => parseReviewGrades({ lines: [] }, ['007-i-win']), /did not grade/);

	const { startTranslationBenchmark, startTranslationReview, waitBenchmark, listBenchmarkStatus } = await import('../src/lib/server/modelBenchmark');
	const hy = structuredClone(SEED_ROWS.find((item) => item.id === 'hy-mt2-manga-v5')!);
	const opus = structuredClone(SEED_ROWS.find((item) => item.id === 'opus-mt-ja-en')!);
	const reviewer = {
		...hy,
		id: 'meaning-grader',
		name: 'Meaning grader',
		slug: 'meaning-grader',
		managedLaunch: null,
		capabilities: { conversation: { capability: 'conversation' as const, ok: true, fingerprint: 'chat', at: 1 } },
		capabilityFingerprints: { conversation: 'chat' },
	};
	const failed = { ...reviewer, id: 'failed-chat', capabilities: { conversation: { ...reviewer.capabilities!.conversation!, ok: false } } };
	const pages = [page('007'), page('009')];
	const translate = async (_row: typeof hy, boxes: { id?: string }[], p: ReturnType<typeof page>) => boxes.map((box) => {
		const line = p.lines.find((item) => item.id === box.id)!;
		const translation = box.id === '007-i-win' ? 'I take this round.' : (line.en || '');
		return { ...box, translation, literal: line.literal || '' };
	});
	startTranslationBenchmark({ models: [hy.id, opus.id], rows: [hy, opus], pages, translate });
	await waitBenchmark();
	assert.throws(() => startTranslationReview({ reviewer: failed.id, rows: [failed] }), /Conversation check/);
	assert.throws(() => startTranslationReview({ reviewer: 'missing', rows: [reviewer] }), /Conversation check/);

	let prompts = 0;
	startTranslationReview({
		reviewer: reviewer.id,
		rows: [reviewer, failed],
		models: [hy.id],
		review: async (_row, prompt, abort) => {
			abort.throwIfAborted();
			prompts += 1;
			const body = JSON.parse(prompt) as { lines: { id: string; page?: string; source: string; response: string }[] };
			assert.ok(body.lines.some((line) => line.page === '007' && line.source && line.response === 'I take this round.'));
			assert.ok(body.lines.some((line) => line.page === '009'));
			return {
				assessment: 'A close localization. The win is reworded and still means the same thing.',
				lines: body.lines.map((line) => ({ id: line.id, score: line.id === '007-i-win' ? 96 : 90, note: 'Comparable.' })),
			};
		},
	});
	assert.throws(() => startTranslationBenchmark({ models: [hy.id], rows: [hy], pages, translate }), /already running/);
	await waitBenchmark();
	const status = listBenchmarkStatus();
	assert.equal(status.review?.state, 'done');
	assert.equal(status.review?.progress.total, 1, 'every page of a saved translation is one request');
	assert.equal(status.review?.reviewerName, 'Meaning grader');
	const gradedModel = status.runs.translation!.models.find((item) => item.id === hy.id)!;
	const untouched = status.runs.translation!.models.find((item) => item.id === opus.id)!;
	assert.equal(untouched.review, undefined);
	assert.equal(gradedModel.review?.error, undefined);
	assert.equal(gradedModel.review?.assessment, 'A close localization. The win is reworded and still means the same thing.');
	assert.equal(reviewLetter(gradedModel.review!.totals.comparable), 'A');
	assert.equal(gradedModel.review!.totals.lines, gradedModel.pages.reduce((sum, item) => sum + item.lines.length, 0));
	const win = gradedModel.pages[0].lines.find((line) => line.id === '007-i-win')!;
	assert.ok(win.chrfOfficial < 0.5, 'the localization does not copy the official wording');
	assert.ok((gradedModel.review!.lines.find((line) => line.id === '007-i-win')?.comparable || 0) >= 0.9);
	assert.equal(prompts, 1);

	startTranslationBenchmark({
		models: [hy.id],
		rows: [hy, opus],
		pages: [page('007')],
		translate,
	});
	await waitBenchmark();
	const replaced = listBenchmarkStatus().runs.translation!.models.find((item) => item.id === hy.id)!;
	assert.equal(replaced.review, undefined, 'benchmarking the model again drops the grade for the old responses');
});
