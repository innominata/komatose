import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { BENCHMARK_DATASETS, benchmarkDataset, type BenchmarkDataset } from '../benchmarkDatasets';
import {
	GOLD_PAGES,
	goldTranslationLines,
	type GoldBox,
	type GoldKind,
	type GoldPage,
} from '../benchmarkGold';
import {
	BENCHMARK_PAGE_SCHEMA,
	BENCHMARK_PAGE_SYSTEM,
	benchmarkPagePrompt,
	officialBaseline,
	parseBenchmarkOutput,
	parseReviewGrades,
	REVIEW_SCHEMA,
	REVIEW_SYSTEM,
	reviewUserPrompt,
	scoreDetection,
	scoreOcrPage,
	scoreTranslationPage,
	totalDetection,
	totalOcr,
	totalReview,
	totalTranslation,
	DETECTOR_SETUPS,
	GOLD_SOURCE,
	PAGE_SOURCE,
	type DetectorPart,
	type DetectorSetup,
	type LineReview,
	type OcrPage,
	type OcrResult,
	type OcrRun,
	type ReviewProgress,
	type TranslationLineScore,
	type TranslationRun,
	type BenchmarkKind,
} from '../modelBenchmark';

export { DETECTOR_SETUPS, GOLD_SOURCE, PAGE_SOURCE };
import { detectorDefaults } from './detectorConfig';
import { detectorSetupId, parseDetectorSetup } from '../detectorSetup';
import { installedLocalReviewModels } from './localReview';
import { conversationAvailable } from '../modelCapabilities';
import { rowHasOperation, isOcrSpecialist, type ModelRow } from '../modelRegistry';
import { listRegistryRows } from './modelRegistryStore';
import { holdManagedModel } from './managedModels';
import { modelHttpConfig } from './modelConnection';
import { withAssistantHttp } from './openaiHttp';
import { chatCompletions, extractJsonObject, parseReadPayload, readBubble, translateScript, type DetectedBox } from './llm';
import { ROOT } from './paths';
import {
	koharuInstalled,
	parseKoharuRegions,
	parseSfxRegions,
	regionsFromDetection,
	composeDetections,
	type DetectedRegion,
} from './detect';
import { detectRegionsPy, type WorkerRegion } from './ocr';
import type { DetectorSource } from './detectFusion';
import { localOperation } from './localWorker';
import { findSpeechBubbles, bubbleFromNorm, type SpeechBubble } from './bubbles';
import { detectLetteringMask, transcribeBubbleCrop } from './reviewMask';
import { regionRectangle } from '../regionGeometry';
import { defaultTranscriptionRead } from './ocrConsensus';
import { dropRedundantTranscriptions, transcriptionIsEnglish } from '../transcribeRegions';
import { runVisionRead } from './visionRead';
import { readBubbleWithCli, translateScriptWithCli } from './cliTranslate';
import { runTranslationTask } from './translationTask';
import { translationModel, type TranslationModel } from '../translationModels';
import { translationModelReadiness } from './translationRuntime';
import type { LineType, OcrLang } from '../types';

type PartOutput = { regions: WorkerRegion[]; width: number; height: number; ms: number; mask?: Buffer };

export type BenchmarkDeps = {
	dataset?: string;
	rows?: ModelRow[];
	pages?: GoldPage[];
	image?: (page: GoldPage) => Promise<Buffer>;
	detectPart?: (part: DetectorPart, page: GoldPage, path: string, abort: AbortSignal, lang: OcrLang) => Promise<Omit<PartOutput, 'ms'>>;
	crop?: (raw: Buffer, bubble: SpeechBubble, abort: AbortSignal, mask?: Buffer) => Promise<Buffer>;
	mask?: (raw: Buffer, bubbles: SpeechBubble[], abort: AbortSignal) => Promise<Buffer | undefined>;
	readCrop?: (row: ModelRow, jpeg: Buffer, abort: AbortSignal, lang: OcrLang) => Promise<string>;
	readPage?: (row: ModelRow, jpeg: Buffer, abort: AbortSignal, lang: OcrLang) => Promise<string>;
	translate?: (row: ModelRow, boxes: DetectedBox[], page: GoldPage, abort: AbortSignal, dataset: BenchmarkDataset) => Promise<DetectedBox[]>;
	review?: (row: ModelRow, prompt: string, abort: AbortSignal) => Promise<unknown>;
};

export type StartOcrOpts = BenchmarkDeps & { detectors?: string[]; models?: string[]; sources?: string[] };
export type StartTranslationOpts = BenchmarkDeps & { models?: string[] };

type DatasetState = { ocr?: OcrRun; translation?: TranslationRun; review?: ReviewProgress };
type State = {
  runs: Record<string, DatasetState>;
  lastDataset?: string;
  active?: { kind: BenchmarkKind | 'review'; dataset: string; abort: AbortController; promise: Promise<void> };
};
const globalState = globalThis as typeof globalThis & { __scanModelBenchmark3?: State };
const state: State = (globalState.__scanModelBenchmark3 ??= { runs: {} });
const datasetKey = (dataset: BenchmarkDataset) => `${dataset.id}-v${dataset.version}`;
function liveState(dataset: BenchmarkDataset) {
  return state.runs[datasetKey(dataset)] ??= {};
}

const PAGE_SCHEMA = {
	type: 'json_schema',
	json_schema: { name: 'page_benchmark', strict: true, schema: BENCHMARK_PAGE_SCHEMA },
};

function httpError(message: string, status: number) {
	return Object.assign(new Error(message), { status });
}

function messageOf(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function runPath(kind: BenchmarkKind, dataset: BenchmarkDataset, legacy = false) {
	const dir = join(process.env.SCAN_DATA_DIR || join(process.env.SCAN_ROOT || ROOT, 'data'), 'run');
	mkdirSync(dir, { recursive: true });
	return join(dir, `model-benchmark-${legacy ? "" : `${datasetKey(dataset)}-`}${kind}.json`);
}

function readSaved<T extends OcrRun | TranslationRun>(kind: BenchmarkKind, dataset: BenchmarkDataset): T | undefined {
	try {
		const path = runPath(kind, dataset);
    const legacy = !existsSync(path) && dataset.id === 'manga-ja' && dataset.version === 1;
		const value = JSON.parse(readFileSync(legacy ? runPath(kind, dataset, true) : path, 'utf8')) as T;
		if (value?.kind !== kind || (!legacy && (value.dataset !== dataset.id || value.datasetVersion !== dataset.version))
      || (value.dataset && value.dataset !== dataset.id)
      || (value.datasetVersion != null && value.datasetVersion !== dataset.version)) return;
    value.dataset = dataset.id;
    value.datasetVersion = dataset.version;
    if (value.kind === 'translation') for (const model of value.models) for (const page of model.pages) {
      for (const line of page.lines) {
        const old = line as typeof line & { ja?: string };
        line.source ??= old.ja || '';
        delete old.ja;
      }
    }
		// Rows saved before each result carried its own time share the run's time.
		for (const item of [...(value.kind === 'ocr' ? value.detectors : []), ...value.models]) item.at ??= value.at;
		return value;
	} catch {
		/* absent */
	}
}

type ScoredRow = { id: string; state: string; pages: unknown[]; error?: string };

/** A row that finished, or failed with its own error. A cancel leaves pending rows out. */
function isBenchmarkResult(item: ScoredRow) {
	return item.state === 'done' || (item.state === 'error' && (item.pages.length > 0 || Boolean(item.error)));
}

/**
 * The tables show the latest result for every setup and model, not only the
 * ones in the run that just finished. `includeOpen` keeps rows this run is
 * still working on, in place of their previous score.
 */
function mergeLatest<T extends ScoredRow>(previous: T[] | undefined, current: T[], key: (item: T) => string, includeOpen: boolean): T[] {
	const visible = current.filter((item) => (includeOpen && (item.state === 'pending' || item.state === 'running')) || isBenchmarkResult(item));
	const keys = new Set(visible.map(key));
	const older = (previous || []).filter((item) => !keys.has(key(item)) && isBenchmarkResult(item));
	return [...visible, ...older];
}

function foldHistory(run: OcrRun | TranslationRun) {
	if (run.kind === 'ocr') {
		const saved = readSaved<OcrRun>('ocr', benchmarkDataset(run.dataset));
		run.detectors = mergeLatest(saved?.detectors, run.detectors, (item) => item.id, false);
		run.models = mergeLatest(saved?.models, run.models, (item) => `${item.id}@${item.source}`, false);
		return;
	}
	const saved = readSaved<TranslationRun>('translation', benchmarkDataset(run.dataset));
	run.models = mergeLatest(saved?.models, run.models, (item) => item.id, false);
}

/** While a run is in progress, list the rows it has not touched yet from the last saved results. */
function shownRun<T extends OcrRun | TranslationRun>(live: T | undefined, kind: BenchmarkKind, dataset: BenchmarkDataset): T | null {
	if (!live) return readSaved<T>(kind, dataset) || null;
	if (live.state !== 'running') return live;
	if (live.kind === 'ocr') {
		const saved = readSaved<OcrRun>('ocr', dataset);
		return {
			...live,
			detectors: mergeLatest(saved?.detectors, live.detectors, (item) => item.id, true),
			models: mergeLatest(saved?.models, live.models, (item) => `${item.id}@${item.source}`, true),
		} as T;
	}
	const saved = readSaved<TranslationRun>('translation', dataset);
	return { ...live, models: mergeLatest(saved?.models, live.models, (item) => item.id, true) } as T;
}

function writeSaved(run: OcrRun | TranslationRun) {
	writeFileSync(runPath(run.kind, benchmarkDataset(run.dataset)), JSON.stringify(run), { mode: 0o600 });
}

function packageRoot() {
	return join(dirname(fileURLToPath(import.meta.url)), '../../..');
}

export function fixturePath(file: string) {
	const candidates = [join(process.env.SCAN_ROOT || ROOT, file), join(packageRoot(), file)];
	return candidates.find((path) => existsSync(path)) || candidates[0];
}

export function fixturesAvailable(pages: GoldPage[] = GOLD_PAGES) {
	return pages.every((page) => existsSync(fixturePath(page.file)));
}

/** A reduced source or English edition image for the selected dataset. */
export async function benchmarkPageImage(id: string, english = false, width = 720, datasetId = 'manga-ja'): Promise<Buffer> {
	const page = benchmarkDataset(datasetId).pages.find((item) => item.id === id);
	if (!page) throw httpError('Unknown benchmark page', 404);
	const file = english ? page.english : page.file;
	if (!file) throw httpError('This dataset has text-only English references', 404);
	const path = fixturePath(file);
	if (!existsSync(path)) throw httpError(`Missing ${english ? page.english : page.file}`, 404);
	return sharp(path).rotate().resize({ width: Math.min(width, page.width), withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
}

function cooInstalled() {
	return existsSync(process.env.SCAN_COO_MODEL || join(ROOT, 'data/models/coo/dbnetpp-coo.pt'));
}

function partMissing(part: DetectorPart): string | undefined {
	if (part === 'coo' && !cooInstalled()) return 'COO DBNet++ is not installed';
	if (part === 'koharu' && !koharuInstalled()) return 'Koharu SAM-TS-L is not installed';
}

export function listDetectorSetups() {
	return DETECTOR_SETUPS.map((setup) => {
		const reason = setup.parts.map(partMissing).find(Boolean);
		return { ...setup, available: !reason, reason };
	});
}

/** The setup a chapter on the default runs today: add-ons that are not installed drop out. */
export function chapterSetupId(): string {
	const defaults = detectorDefaults();
	const { available } = defaults;
	const setup = parseDetectorSetup(defaults.setup) ?? { base: 'rtdetr', coo: false, koharu: false };
	return detectorSetupId({
		base: setup.base,
		coo: setup.coo && available.coo.installed,
		koharu: setup.koharu && available.koharu.installed,
	});
}

export function usesCrops(_row: ModelRow) {
  // Every eligible integration reads the same crop contract as chapter transcription.
  return true;
}
export function usesFullPage(_row: ModelRow) { return false; }
function supportsLanguage(row: ModelRow, lang: OcrLang) {
  return !row.languages || row.languages.includes(lang);
}
export function ocrBenchmarkRows(rows: ModelRow[] = listRegistryRows(), lang: OcrLang = 'japanese'): ModelRow[] {
  const installed = new Set(installedLocalReviewModels().map(model => model.id as string));
  return rows.filter(row => !row.disabled && rowHasOperation(row, 'vision') && supportsLanguage(row, lang)
    && (!isOcrSpecialist(row) || installed.has(row.id)));
}
/** Chat models that can grade saved translations. A failed Conversation check stays out. */
export function reviewBenchmarkRows(rows: ModelRow[] = listRegistryRows()): ModelRow[] {
	return rows.filter((row) => !row.disabled && conversationAvailable(row));
}
export function translationBenchmarkRows(rows: ModelRow[] = listRegistryRows(), installed = (model: TranslationModel) => translationModelReadiness(model).available, lang: OcrLang = 'japanese'): ModelRow[] {
  return rows.filter(row => {
    if (row.disabled || !rowHasOperation(row, 'translate') || !supportsLanguage(row, lang)) return false;
    const model = translationModel(row.slug);
    return !model || (model.languages.includes(lang) && installed(model));
  });
}
function modelFlags(row: ModelRow) {
  return { local: row.access === 'local_http', billed: row.access === 'cli' || row.access === 'remote_http' };
}
function needsLocalReview(row: ModelRow) { return isOcrSpecialist(row); }

function envNumber(name: string) {
	const value = Number(process.env[name]);
	return process.env[name] && Number.isFinite(value) ? value : undefined;
}

async function defaultDetectPart(part: DetectorPart, _page: GoldPage, path: string, abort: AbortSignal, lang: OcrLang): Promise<Omit<PartOutput, 'ms'>> {
	if (part === 'heuristic') {
		const bytes = await readFile(path);
		const meta = await sharp(bytes).metadata();
		const bubbles = await findSpeechBubbles(bytes);
		return {
			regions: bubbles.map((b) => ({ cls: 'bubble', score: 1, box: [b.left, b.top, b.left + b.width, b.top + b.height] as GoldBox })),
			width: meta.width || 1,
			height: meta.height || 1,
		};
	}
	if (part === 'coo') {
		const found = await localOperation({ cmd: 'detect-sfx', path, confidence: envNumber('SCAN_COO_CONF') ?? 0.6 }, abort);
		return { regions: parseSfxRegions(found.regions), width: Number(found.width) || 1, height: Number(found.height) || 1 };
	}
	if (part === 'koharu') {
		const dir = await mkdtemp(join(tmpdir(), 'scan-bench-koharu-'));
		try {
			const out = join(dir, 'mask.png');
			const found = await localOperation({ cmd: 'detect-text', path, out, maskExpansion: 3 }, abort);
			const mask = existsSync(out) ? await readFile(out) : undefined;
			return { regions: parseKoharuRegions(found.regions), width: Number(found.width) || 1, height: Number(found.height) || 1, mask };
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}
	return detectRegionsPy(path, {
		backend: part,
		conf: envNumber('SCAN_DETECT_CONF'),
		tile: envNumber('SCAN_DETECT_TILE'),
		// Comic Text Detector is its own part when a setup cross-checks with it.
		supplement: false,
		lang,
		abort,
	});
}

/** Same merge as detectRegions: every part's boxes are cross-checked, then COO and Koharu add their evidence. */
export function composeSetup(setup: DetectorSetup, outputs: Map<DetectorPart, PartOutput>, width: number, height: number): DetectedRegion[] {
	const heuristic = outputs.get('heuristic');
	if (setup.parts.includes('heuristic')) return heuristic ? regionsFromDetection(heuristic.regions, width, height) : [];
	const parts: Partial<Record<DetectorSource, WorkerRegion[]>> = {};
	for (const part of setup.parts) {
		const out = outputs.get(part);
		if (out) parts[part as DetectorSource] = out.regions;
	}
	return composeDetections(parts, width, height);
}

function boxOf(bubble: SpeechBubble): GoldBox {
	return [bubble.left, bubble.top, bubble.left + bubble.width, bubble.top + bubble.height].map(Math.round) as GoldBox;
}

function goldBubbles(page: GoldPage): SpeechBubble[] {
	return page.lines
		.filter((line) => !line.latin && line.ocr !== false && /[\p{L}\p{N}]/u.test(line.source))
		.flatMap((line) => line.boxes)
		.map(([x0, y0, x1, y1]) => {
			const p = 6;
			const left = Math.max(0, x0 - p);
			const top = Math.max(0, y0 - p);
			return bubbleFromNorm(page.width, page.height, left / page.width, top / page.height, (x1 + p - left) / page.width, (y1 + p - top) / page.height);
		});
}

/** Do not ask readers to guess glyphs excluded from the gold transcription. */
export function scoredOcrBubbles(page: GoldPage, bubbles: SpeechBubble[]): SpeechBubble[] {
  const excluded = page.lines.filter(line => line.ocr === false).flatMap(line => line.boxes);
  return bubbles.filter(bubble => {
    const [x0, y0, x1, y1] = boxOf(bubble);
    const area = Math.max(1, (x1 - x0) * (y1 - y0));
    return !excluded.some(([a, b, c, d]) =>
      Math.max(0, Math.min(x1, c) - Math.max(x0, a)) * Math.max(0, Math.min(y1, d) - Math.max(y0, b)) >= area / 2);
  });
}

async function defaultMask(raw: Buffer, bubbles: SpeechBubble[], abort: AbortSignal) {
	if (!bubbles.length) return undefined;
	try {
		return await detectLetteringMask(raw, bubbles.map((bubble) => regionRectangle(bubble)), 3, abort);
	} catch (error) {
		if (abort.aborted) throw error;
		return undefined;
	}
}

async function defaultReadCrop(row: ModelRow, jpeg: Buffer, abort: AbortSignal, lang: OcrLang) {
	return defaultTranscriptionRead(row.id, jpeg, abort, lang);
}

async function defaultReadPage(row: ModelRow, jpeg: Buffer, abort: AbortSignal, lang: OcrLang): Promise<string> {
	if (row.access === 'cli') {
		const read = await runVisionRead(row.id, { jpeg, lang, model: row.slug, abort, diagnostic: true }, {
			cli: (engine, opts) => readBubbleWithCli(engine, opts.jpeg, { lang: opts.lang, model: opts.model, abort: opts.abort }),
			local: (opts) => readBubble(opts.jpeg, opts.abort, opts.model, opts.lang),
		});
		return parseReadPayload(read).source;
	}
	const cfg = modelHttpConfig(row);
	if (!cfg) throw new Error(`${row.name} has no HTTP endpoint`);
	const dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
	const text = await withAssistantHttp(cfg, () => chatCompletions(
		[
			{ role: 'system', content: BENCHMARK_PAGE_SYSTEM },
			{ role: 'user', content: [{ type: 'text', text: benchmarkPagePrompt(lang) }, { type: 'image_url', image_url: { url: dataUrl } }] },
		],
		{ abort, schema: PAGE_SCHEMA, temperature: 0, maxTokens: 2048, thinking: false, model: row.slug },
	));
	try {
		return parseBenchmarkOutput(JSON.stringify(extractJsonObject(text))).source;
	} catch {
		return parseBenchmarkOutput(text).source;
	}
}

const LINE_TYPES: Record<GoldKind, LineType> = { speech: '""', caption: '[]', sfx: '::', sign: 'OT', title: 'OT' };

export function translationBoxes(page: GoldPage): DetectedBox[] {
	return goldTranslationLines(page).map((line) => {
		const [x0, y0, x1, y1] = line.boxes[0];
		return {
			id: line.id,
			x: x0 / page.width,
			y: y0 / page.height,
			w: (x1 - x0) / page.width,
			h: (y1 - y0) / page.height,
			lineType: LINE_TYPES[line.kind],
			source: line.source,
			literal: '',
			translation: '',
			reasoning: '',
		};
	});
}

async function defaultTranslate(row: ModelRow, boxes: DetectedBox[], page: GoldPage, abort: AbortSignal, dataset: BenchmarkDataset) {
	const index = dataset.pages.findIndex((item) => item.id === page.id);
	return runTranslationTask({
		engine: row.id,
		model: row.slug,
		boxes,
		seriesNotes: dataset.seriesNotes,
		seriesGlossary: dataset.glossary,
		prior: '',
		pageLabel: `${dataset.series} · page ${index + 1}/${dataset.pages.length}`,
		lang: dataset.lang,
		abort,
	}, { cli: translateScriptWithCli, local: translateScript });
}

function pageJpeg(raw: Buffer) {
	return sharp(raw).rotate().resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
}

function assertIdle() {
	if (!state.active) return;
	const label = state.active.kind === 'ocr' ? 'OCR benchmark' : state.active.kind === 'review' ? 'meaning review' : 'translation benchmark';
	throw httpError(`A ${label} is already running`, 409);
}

function pick(catalog: ModelRow[], ids: string[] | undefined, what: string) {
	const wanted = [...new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean))];
	return wanted.map((id) => {
		const row = catalog.find((item) => item.id === id);
		if (!row) throw httpError(`${id} is not available for the ${what} benchmark. Show it in pickers and install it if it is a local model.`, 400);
		return row;
	});
}

function settle(run: OcrRun | TranslationRun, abort: AbortController, error?: unknown) {
	if (error !== undefined) {
		run.state = abort.signal.aborted ? 'cancelled' : 'error';
		if (!abort.signal.aborted) run.error = messageOf(error);
	} else {
		run.state = 'done';
	}
	run.finishedAt = Date.now();
	run.progress.step = run.state === 'done' ? 'Finished' : run.state === 'cancelled' ? 'Cancelled' : 'Failed';
	for (const item of [...(run.kind === 'ocr' ? run.detectors : []), ...run.models]) {
		if (item.state === 'pending' || item.state === 'running') item.state = run.state === 'done' ? 'done' : 'error';
	}
	foldHistory(run);
	writeSaved(run);
}

export function startOcrBenchmark(opts: StartOcrOpts): OcrRun {
	assertIdle();
	const dataset = benchmarkDataset(opts.dataset);
	const pages = opts.pages || dataset.pages;
	const setups = listDetectorSetups();
	const setupIds = [...new Set(opts.detectors || [])];
	for (const id of setupIds) {
		const setup = setups.find((item) => item.id === id);
		if (!setup) throw httpError(`Unknown text detector ${id}`, 400);
		if (!setup.available && !opts.detectPart) throw httpError(`${setup.label}: ${setup.reason}`, 400);
	}
	const models = pick(opts.rows ? opts.rows.filter(row => !row.disabled && supportsLanguage(row, dataset.lang)) : ocrBenchmarkRows(undefined, dataset.lang), opts.models, 'OCR');
	const cropModels = models.filter(usesCrops);
	const pageModels = models.filter(usesFullPage);
	const sources = [...new Set((opts.sources?.length ? opts.sources : [GOLD_SOURCE]).map(String))];
	for (const source of sources) {
		if (source === GOLD_SOURCE) continue;
		const setup = setups.find((item) => item.id === source);
		if (!setup) throw httpError(`Unknown crop source ${source}`, 400);
		if (!setup.available && !opts.detectPart) throw httpError(`${setup.label}: ${setup.reason}`, 400);
	}
	if (!setupIds.length && !models.length) throw httpError('Choose at least one text detector or OCR model', 400);
	if (!fixturesAvailable(pages) && !opts.image) throw httpError(`${dataset.fixtureDir} is incomplete`, 500);

	const cropSources = cropModels.length ? sources : [];
	const detectorSetups = [...new Set([...setupIds, ...cropSources.filter((id) => id !== GOLD_SOURCE)])]
		.map((id) => DETECTOR_SETUPS.find((setup) => setup.id === id)!);
	const parts = [...new Set(detectorSetups.flatMap((setup) => setup.parts))];
	const labelOf = (source: string) => source === GOLD_SOURCE ? 'Gold boxes' : source === PAGE_SOURCE ? 'Full page' : DETECTOR_SETUPS.find((setup) => setup.id === source)?.label || source;

	const started = Date.now();
	const run: OcrRun = {
		kind: 'ocr',
		dataset: dataset.id,
		datasetVersion: dataset.version,
		id: randomUUID(),
		at: started,
		state: 'running',
		pages: pages.map((page) => page.id),
		progress: {
			done: 0,
			total: pages.length * (parts.length + cropSources.length + cropModels.length * cropSources.length + pageModels.length),
			step: 'Starting',
		},
		detectors: setupIds.map((id) => ({
			id,
			label: labelOf(id),
			state: 'pending' as const,
			pages: [],
			totals: totalDetection([]),
			at: started,
		})),
		models: [
			...cropModels.flatMap((row) => cropSources.map((source) => ({ row, source }))),
			...pageModels.map((row) => ({ row, source: PAGE_SOURCE })),
		].map(({ row, source }) => ({
			id: row.id,
			name: row.name,
			source,
			sourceLabel: labelOf(source),
			state: 'pending' as const,
			pages: [],
			totals: totalOcr([]),
			at: started,
			...modelFlags(row),
		})),
	};
	liveState(dataset).ocr = run;
	state.lastDataset = dataset.id;
	const abort = new AbortController();
	const step = (text: string) => { run.progress.step = text; };
	const tick = () => { run.progress.done = Math.min(run.progress.total, run.progress.done + 1); };
	const image = opts.image || ((page: GoldPage) => readFile(fixturePath(page.file)));
	const detectPart = opts.detectPart || defaultDetectPart;
	const crop = opts.crop || ((raw: Buffer, bubble: SpeechBubble, signal: AbortSignal, mask?: Buffer) => transcribeBubbleCrop(raw, bubble, signal, mask));
	const makeMask = opts.mask || defaultMask;
	const readCrop = opts.readCrop || defaultReadCrop;
	const readPage = opts.readPage || defaultReadPage;

	const promise = (async () => {
		const scratch = await mkdtemp(join(tmpdir(), 'scan-bench-'));
		try {
			const signal = abort.signal;
			/** Per page: the regions every detector setup produced, and Koharu's mask when it ran. */
			const detected = new Map<string, Map<string, { regions: DetectedRegion[]; error?: string }>>();
			const koharuMasks = new Map<string, Buffer>();
			const raws = new Map<string, Buffer>();
			for (const page of pages) {
				signal.throwIfAborted();
				const raw = await image(page);
				raws.set(page.id, raw);
				const path = join(scratch, `${page.id}.jpg`);
				await writeFile(path, raw);
				const outputs = new Map<DetectorPart, PartOutput>();
				const failures = new Map<DetectorPart, string>();
				for (const part of parts) {
					signal.throwIfAborted();
					step(`Page ${page.id} · detecting with ${part}`);
					const started = Date.now();
					try {
						const out = await detectPart(part, page, path, signal, dataset.lang);
						outputs.set(part, { ...out, ms: Date.now() - started });
						if (part === 'koharu' && out.mask) koharuMasks.set(page.id, out.mask);
					} catch (error) {
						if (signal.aborted) throw error;
						failures.set(part, messageOf(error));
					}
					tick();
				}
				const perSetup = new Map<string, { regions: DetectedRegion[]; error?: string }>();
				for (const setup of detectorSetups) {
					const failed = setup.parts.map((part) => failures.get(part)).find(Boolean);
					const regions = failed ? [] : composeSetup(setup, outputs, page.width, page.height);
					perSetup.set(setup.id, { regions, error: failed });
					const result = run.detectors.find((item) => item.id === setup.id);
					if (!result) continue;
					result.state = 'running';
					const boxes = regions.map((region) => boxOf(region.place));
					result.pages.push({
						page: page.id,
						ms: setup.parts.reduce((sum, part) => sum + (outputs.get(part)?.ms || 0), 0),
						boxes,
						score: scoreDetection(page, boxes),
						error: failed,
					});
					result.totals = totalDetection(result.pages.filter((item) => !item.error).map((item) => item.score));
					if (result.pages.length === pages.length) {
						const errors = result.pages.filter((item) => item.error);
						result.state = errors.length === pages.length ? 'error' : 'done';
						if (errors.length) result.error = errors[0].error;
					}
				}
				detected.set(page.id, perSetup);
			}

			/** Crops are cut once per source and page, then every model reads the same images. */
			const crops = new Map<string, { images: Buffer[]; bubbles: SpeechBubble[]; error?: string }>();
			for (const source of cropSources) {
				for (const page of pages) {
					signal.throwIfAborted();
					step(`Page ${page.id} · cropping ${labelOf(source)}`);
					const raw = raws.get(page.id)!;
					const found = source === GOLD_SOURCE ? undefined : detected.get(page.id)?.get(source);
					const bubbles = found ? scoredOcrBubbles(page, found.regions.map((region) => region.ocr)) : goldBubbles(page);
					const setup = DETECTOR_SETUPS.find((item) => item.id === source);
					const mask = bubbles.length
						? (setup?.parts.includes('koharu') && koharuMasks.get(page.id)) || await makeMask(raw, bubbles, signal)
						: undefined;
					const images: Buffer[] = [];
					for (const bubble of bubbles) images.push(await crop(raw, bubble, signal, mask));
					crops.set(`${source}:${page.id}`, { images, bubbles, error: found?.error && `${labelOf(source)} failed: ${found.error}` });
					tick();
				}
			}

			const record = (result: OcrResult, page: GoldPage, item: Omit<OcrPage, 'lines' | 'noise' | 'outputChars'>) => {
				const scored = scoreOcrPage(page, item.output);
				result.pages.push({ ...item, ...scored });
				result.totals = totalOcr(result.pages.filter((p) => !p.error));
			};
			const finish = (result: OcrResult) => {
				const errors = result.pages.filter((item) => item.error);
				result.state = errors.length === result.pages.length && result.pages.length ? 'error' : 'done';
				if (errors.length) result.error = `${errors.length} of ${result.pages.length} pages failed: ${errors[0].error}`;
			};

			for (const row of cropModels) {
				let release = () => {};
				try {
					release = await holdManagedModel(row.id, Boolean(row.managedLaunch), signal);
				} catch (error) {
					for (const result of run.models.filter((item) => item.id === row.id && item.source !== PAGE_SOURCE)) {
						result.state = 'error';
						result.error = messageOf(error);
					}
					run.progress.done += pages.length * cropSources.length;
					continue;
				}
				try {
					for (const source of cropSources) {
						const result = run.models.find((item) => item.id === row.id && item.source === source)!;
						result.state = 'running';
						for (const page of pages) {
							signal.throwIfAborted();
							const cut = crops.get(`${source}:${page.id}`);
							const images = cut?.images || [];
							step(`Page ${page.id} · ${row.name} reading ${images.length} crops (${labelOf(source)})`);
							const started = Date.now();
							const parts: string[] = [];
							let error = cut?.error;
							let failedCrops = 0;
							let cropError: string | undefined;
							if (!error) try {
								const readAll = async (s: AbortSignal) => {
									for (const jpeg of images) {
										s.throwIfAborted();
										try {
											parts.push((await readCrop(row, jpeg, s, dataset.lang)).trim());
										} catch (e) {
											if (s.aborted) throw e;
											failedCrops++;
											cropError ??= messageOf(e);
											parts.push('');
										}
									}
								};
								await readAll(signal);
								if (failedCrops && failedCrops === images.length) error = `All ${failedCrops} crops failed: ${cropError}`;
							} catch (e) {
								if (signal.aborted) throw e;
								error = messageOf(e);
							}
							const bubbles = cut?.bubbles || [];
							const drop = dropRedundantTranscriptions(parts.map((source, index) => ({
								id: String(index),
								x: bubbles[index]?.left ?? 0,
								y: bubbles[index]?.top ?? 0,
								w: bubbles[index]?.width ?? 0,
								h: bubbles[index]?.height ?? 0,
								source,
								english: transcriptionIsEnglish(source, []),
							})));
							const kept = parts.filter((text, index) => text && !drop.has(String(index)));
							record(result, page, {
								page: page.id,
								ms: Date.now() - started,
								regions: images.length,
								output: kept.join('\n'),
								...(failedCrops && !error ? { failedCrops, cropError } : {}),
								...(drop.size ? { dropped: drop.size } : {}),
								error,
							});
							tick();
						}
						finish(result);
					}
				} finally {
					release();
				}
			}

			for (const row of pageModels) {
				const result = run.models.find((item) => item.id === row.id && item.source === PAGE_SOURCE)!;
				let release = () => {};
				try {
					release = await holdManagedModel(row.id, Boolean(row.managedLaunch), signal);
				} catch (error) {
					result.state = 'error';
					result.error = messageOf(error);
					run.progress.done += pages.length;
					continue;
				}
				try {
					result.state = 'running';
					for (const page of pages) {
						signal.throwIfAborted();
						step(`Page ${page.id} · ${row.name} reading the full page`);
						const started = Date.now();
						let output = '';
						let error: string | undefined;
						try {
							output = await readPage(row, await pageJpeg(raws.get(page.id)!), signal, dataset.lang);
						} catch (e) {
							if (signal.aborted) throw e;
							error = messageOf(e);
						}
						record(result, page, { page: page.id, ms: Date.now() - started, regions: 1, output, error });
						tick();
					}
					finish(result);
				} finally {
					release();
				}
			}
			settle(run, abort);
		} catch (error) {
			settle(run, abort, error);
		} finally {
			await rm(scratch, { recursive: true, force: true });
			if (state.active?.abort === abort) state.active = undefined;
		}
	})();
	state.active = { kind: 'ocr', dataset: dataset.id, abort, promise };
	return run;
}

export function startTranslationBenchmark(opts: StartTranslationOpts): TranslationRun {
	assertIdle();
	const dataset = benchmarkDataset(opts.dataset);
	const pages = (opts.pages || dataset.pages).filter((page) => goldTranslationLines(page).length);
	const models = pick(opts.rows ? opts.rows.filter(row => !row.disabled && supportsLanguage(row, dataset.lang) && (!translationModel(row.slug) || translationModel(row.slug)!.languages.includes(dataset.lang))) : translationBenchmarkRows(undefined, undefined, dataset.lang), opts.models, 'translation');
	if (!models.length) throw httpError('Choose at least one translation model', 400);
	const started = Date.now();
	const run: TranslationRun = {
		kind: 'translation',
		dataset: dataset.id,
		datasetVersion: dataset.version,
		id: randomUUID(),
		at: started,
		state: 'running',
		pages: pages.map((page) => page.id),
		progress: { done: 0, total: pages.length * models.length, step: 'Starting' },
		models: models.map((row) => ({
			id: row.id,
			name: row.name,
			state: 'pending' as const,
			pages: [],
			totals: totalTranslation([]),
			at: started,
			...modelFlags(row),
		})),
	};
	liveState(dataset).translation = run;
	state.lastDataset = dataset.id;
	const abort = new AbortController();
	const translate = opts.translate || defaultTranslate;
	const promise = (async () => {
		try {
			const signal = abort.signal;
			for (const [index, row] of models.entries()) {
				const result = run.models[index];
				let release = () => {};
				try {
					release = await holdManagedModel(row.id, Boolean(row.managedLaunch), signal);
				} catch (error) {
					result.state = 'error';
					result.error = messageOf(error);
					run.progress.done += pages.length;
					continue;
				}
				try {
					result.state = 'running';
					for (const page of pages) {
						signal.throwIfAborted();
						const boxes = translationBoxes(page);
						run.progress.step = `Page ${page.id} · ${row.name} translating ${boxes.length} lines`;
						const started = Date.now();
						let out: DetectedBox[] = [];
						let error: string | undefined;
						try {
							out = await translate(row, boxes.map((box) => ({ ...box })), page, signal, dataset);
						} catch (e) {
							if (signal.aborted) throw e;
							error = messageOf(e);
						}
						const lines = scoreTranslationPage(page, boxes.map((box, i) => {
							const hit = out.find((item) => item.id === box.id) || out[i];
							return { id: box.id!, translation: hit?.translation || '', literal: hit?.literal || '' };
						}));
						result.pages.push({ page: page.id, ms: Date.now() - started, lines, error });
						result.totals = totalTranslation(result.pages.flatMap((item) => item.lines));
						run.progress.done += 1;
					}
					const errors = result.pages.filter((item) => item.error);
					result.state = errors.length === result.pages.length && result.pages.length ? 'error' : 'done';
					if (errors.length) result.error = `${errors.length} of ${result.pages.length} pages failed: ${errors[0].error}`;
				} finally {
					release();
				}
			}
			settle(run, abort);
		} catch (error) {
			settle(run, abort, error);
		} finally {
			if (state.active?.abort === abort) state.active = undefined;
		}
	})();
	state.active = { kind: 'translation', dataset: dataset.id, abort, promise };
	return run;
}

function reviewPrompt(dataset: BenchmarkDataset, pages: { page: string; lines: TranslationLineScore[] }[]) {
	return reviewUserPrompt({
		language: dataset.lang === 'korean' ? 'Korean' : 'Japanese',
		referenceKind: dataset.referenceLabel === 'official' ? 'official English edition' : 'checked English reference',
		lines: pages.flatMap((page) => page.lines.map((line) => ({
			id: line.id,
			page: page.page,
			source: line.source,
			reference: line.official,
			literal: line.goldLiteral,
			response: line.translation,
			...(line.literal ? { responseLiteral: line.literal } : {}),
		}))),
	});
}

async function defaultReview(row: ModelRow, prompt: string, abort: AbortSignal): Promise<unknown> {
	const { executeModelTask } = await import('./modelTaskRunner');
	// Enquire also requires a translation check. This grade only needs Conversation,
	// which the caller already required, so the task gate is not the eligibility check.
	return executeModelTask(row, 'advisory', {
		system: REVIEW_SYSTEM,
		prompt,
		images: [],
		schema: REVIEW_SCHEMA,
		model: row.slug,
	}, { abort, diagnostic: true });
}

export type StartReviewOpts = BenchmarkDeps & { reviewer: string; models?: string[] };

/** Grade saved translation responses. Does not call the models that produced them. */
export function startTranslationReview(opts: StartReviewOpts): ReviewProgress {
	assertIdle();
	const dataset = benchmarkDataset(opts.dataset);
	const run = liveState(dataset).translation || readSaved<TranslationRun>('translation', dataset);
	if (!run) throw httpError('No saved translations to review. Run the translation benchmark first.', 400);
	const ready = run.models.filter((item) => item.pages.some((page) => page.lines.length));
	const wanted = [...new Set((opts.models || []).map((id) => String(id || '').trim()).filter(Boolean))];
	const results = wanted.length ? wanted.map((id) => {
		const item = ready.find((row) => row.id === id);
		if (!item) throw httpError(`${id} has no saved translation to review`, 400);
		return item;
	}) : ready;
	if (!results.length) throw httpError('No saved translations to review. Run the translation benchmark first.', 400);
	const reviewer = reviewBenchmarkRows(opts.rows).find((row) => row.id === opts.reviewer);
	if (!reviewer) throw httpError('Choose a model that has passed the Conversation check', 400);
	const jobs = results.map((result) => ({ result, pages: result.pages.filter((page) => page.lines.length) }));
	const progress: ReviewProgress = {
		state: 'running',
		reviewerId: reviewer.id,
		reviewerName: reviewer.name,
		at: Date.now(),
		progress: { done: 0, total: jobs.length, step: 'Starting' },
	};
	const slot = liveState(dataset);
	slot.translation = run;
	slot.review = progress;
	state.lastDataset = dataset.id;
	const abort = new AbortController();
	const review = opts.review || defaultReview;
	let release = () => {};
	const promise = (async () => {
		try {
			const signal = abort.signal;
			try {
				release = await holdManagedModel(reviewer.id, Boolean(reviewer.managedLaunch), signal);
			} catch (error) {
				progress.state = 'error';
				progress.error = messageOf(error);
				progress.progress.step = 'Failed';
				return;
			}
			for (const job of jobs) {
				signal.throwIfAborted();
				const expected = job.pages.reduce((sum, page) => sum + page.lines.length, 0);
				progress.progress.step = `${reviewer.name} grading ${job.result.name} · ${job.pages.length} pages`;
				let graded: LineReview[] = [];
				let assessment = '';
				let failure = '';
				try {
					const parsed = parseReviewGrades(
						await review(reviewer, reviewPrompt(dataset, job.pages), signal),
						job.pages.flatMap((page) => page.lines.map((line) => line.id)),
					);
					graded = parsed.lines;
					assessment = parsed.assessment;
				} catch (error) {
					if (signal.aborted) throw error;
					failure = messageOf(error);
				}
				job.result.review = {
					reviewerId: reviewer.id,
					reviewerName: reviewer.name,
					at: Date.now(),
					resultAt: job.result.at || run.at,
					lines: graded,
					totals: totalReview(graded, expected),
					...(assessment ? { assessment } : {}),
					...(failure ? { error: failure } : {}),
				};
				progress.progress.done += 1;
				writeSaved(run);
			}
		} catch (error) {
			progress.state = abort.signal.aborted ? 'cancelled' : 'error';
			if (!abort.signal.aborted) progress.error = messageOf(error);
			progress.progress.step = progress.state === 'cancelled' ? 'Cancelled' : 'Failed';
		} finally {
			if (progress.state === 'running') {
				progress.state = 'done';
				progress.progress.step = 'Finished';
			}
			progress.finishedAt = Date.now();
			writeSaved(run);
			release();
			if (state.active?.abort === abort) state.active = undefined;
		}
	})();
	state.active = { kind: 'review', dataset: dataset.id, abort, promise };
	return progress;
}

export function cancelBenchmark() {
	if (!state.active) return false;
	state.active.abort.abort(new Error('Cancelled'));
	return true;
}

export async function waitBenchmark() {
	await state.active?.promise;
	return liveState(benchmarkDataset(state.lastDataset));
}

export function listBenchmarkStatus(datasetId = 'manga-ja') {
	const dataset = benchmarkDataset(datasetId);
	const live = liveState(dataset);
	const setups = listDetectorSetups();
	const row = (item: ModelRow) => ({
		id: item.id,
		name: item.name,
		...modelFlags(item),
		crops: usesCrops(item),
		specialist: needsLocalReview(item),
	});
	return {
		ok: true,
		dataset,
		datasets: BENCHMARK_DATASETS.map(({ id, label }) => ({ id, label })),
		runningDataset: state.active?.dataset || null,
		available: fixturesAvailable(dataset.pages),
		pages: dataset.pages.map((page) => ({ id: page.id, note: page.note })),
		detectors: setups,
		chapterSetup: chapterSetupId(),
		ocrModels: ocrBenchmarkRows(undefined, dataset.lang).map(row),
		translationModels: translationBenchmarkRows(undefined, undefined, dataset.lang).map(row),
		reviewModels: reviewBenchmarkRows().map(row),
		review: live.review || null,
		baseline: officialBaseline(dataset.pages),
		running: state.active?.kind || null,
		runs: {
			ocr: shownRun(live.ocr, 'ocr', dataset),
			translation: shownRun(live.translation, 'translation', dataset),
		},
	};
}
