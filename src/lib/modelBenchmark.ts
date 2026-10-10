import {
	GOLD_PAGES,
	goldOcrGroup,
	goldRequired,
	goldTranslationLines,
	type GoldBox,
	type GoldLine,
	type GoldPage,
} from './benchmarkGold';
import type { BenchmarkDataset } from './benchmarkDatasets';

/**
 * Shared scoring for the Japanese manga and Korean manhwa gold datasets.
 *
 * Detection: a gold box is found when detections cover at least half of it. A detection
 * is correct when it sits mostly on required lettering, or covers most of one required
 * box without being far larger (bubble-sized boxes count). Detections that sit on
 * sign/title lettering are neutral; everything else is a false alarm.
 *
 * OCR: every gold line is aligned against the page output as a fuzzy substring, so
 * reading order and line breaks do not matter. Line accuracy is 1 − edits / length,
 * weighted by characters. Output that no gold line accounts for is noise.
 *
 * Translation: chrF (character 1–6-grams, β = 2, case-insensitive) against the reference
 * English and against the literal reference, plus meaning checks from the gold keys.
 * A chat model can also grade saved translations for meaning: different wording that
 * keeps the same facts, names, and intent still counts as comparable.
 */

export type DetectionScore = {
	/** Required boxes (speech, captions, SFX). */
	targets: number;
	found: number;
	dialogueTargets: number;
	dialogueFound: number;
	sfxTargets: number;
	sfxFound: number;
	/** Sign and title boxes found; informational only. */
	optionalTargets: number;
	optionalFound: number;
	detections: number;
	correct: number;
	neutral: number;
	falseAlarms: number;
	/** Line ids with at least one required box left unfound. */
	missed: string[];
	/** Indexes into the detection list that count as false alarms. */
	falseIndexes: number[];
};

export type DetectionTotals = DetectionScore & { recall: number; precision: number; f1: number };

const PAD = 12;
const STEP = 4;

function area(box: GoldBox) {
	return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
}

function pad(box: GoldBox, by = PAD): GoldBox {
	return [box[0] - by, box[1] - by, box[2] + by, box[3] + by];
}

/** The middle of a gold box: gold boxes carry some balloon margin, which tight detectors rightly leave out. */
export function goldCore(box: GoldBox, inset = 0.2): GoldBox {
	const dx = (box[2] - box[0]) * inset;
	const dy = (box[3] - box[1]) * inset;
	return [box[0] + dx, box[1] + dy, box[2] - dx, box[3] - dy];
}

function inside(x: number, y: number, box: GoldBox) {
	return x >= box[0] && x < box[2] && y >= box[1] && y < box[3];
}

/** Fraction of `target` covered by the union of `cover`, sampled on a small grid. */
export function coveredFraction(target: GoldBox, cover: GoldBox[]): number {
	const relevant = cover.filter((box) => box[0] < target[2] && box[2] > target[0] && box[1] < target[3] && box[3] > target[1]);
	if (!relevant.length || area(target) <= 0) return 0;
	let hit = 0;
	let all = 0;
	for (let y = target[1] + STEP / 2; y < target[3]; y += STEP) {
		for (let x = target[0] + STEP / 2; x < target[2]; x += STEP) {
			all += 1;
			if (relevant.some((box) => inside(x, y, box))) hit += 1;
		}
	}
	return all ? hit / all : 0;
}

function overlap(a: GoldBox, b: GoldBox) {
	return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
}

export function scoreDetection(page: GoldPage, detections: GoldBox[]): DetectionScore {
	const required = page.lines.filter(goldRequired);
	const optional = page.lines.filter((line) => !goldRequired(line));
	const requiredBoxes = required.flatMap((line) => line.boxes);
	const optionalBoxes = optional.flatMap((line) => line.boxes);
	const score: DetectionScore = {
		targets: 0, found: 0, dialogueTargets: 0, dialogueFound: 0, sfxTargets: 0, sfxFound: 0,
		optionalTargets: 0, optionalFound: 0, detections: detections.length, correct: 0, neutral: 0,
		falseAlarms: 0, missed: [], falseIndexes: [],
	};
	for (const line of required) {
		let lineMissed = false;
		for (const box of line.boxes) {
			const found = coveredFraction(goldCore(box), detections) >= 0.5;
			score.targets += 1;
			if (found) score.found += 1;
			else lineMissed = true;
			if (line.kind === 'sfx') {
				score.sfxTargets += 1;
				if (found) score.sfxFound += 1;
			} else {
				score.dialogueTargets += 1;
				if (found) score.dialogueFound += 1;
			}
		}
		if (lineMissed) score.missed.push(line.id);
	}
	for (const box of optionalBoxes) {
		score.optionalTargets += 1;
		if (coveredFraction(goldCore(box), detections) >= 0.5) score.optionalFound += 1;
	}
	const paddedRequired = requiredBoxes.map((box) => pad(box));
	const paddedOptional = optionalBoxes.map((box) => pad(box));
	const wraps = (det: GoldBox, boxes: GoldBox[]) => boxes.some((box) => overlap(det, box) >= area(box) * 0.5 && area(det) <= area(box) * 4);
	detections.forEach((det, index) => {
		if (coveredFraction(det, paddedRequired) >= 0.5 || wraps(det, requiredBoxes)) score.correct += 1;
		// Title columns sit far apart, so a box spanning several is mostly gap: a quarter on lettering is enough.
		else if (coveredFraction(det, paddedOptional) >= 0.25 || wraps(det, optionalBoxes)) score.neutral += 1;
		else {
			score.falseAlarms += 1;
			score.falseIndexes.push(index);
		}
	});
	return score;
}

export function emptyDetectionScore(): DetectionScore {
	return scoreDetection({ ...GOLD_PAGES[0], lines: [] }, []);
}

export function totalDetection(scores: DetectionScore[]): DetectionTotals {
	const sum = emptyDetectionScore();
	const counts = sum as unknown as Record<string, number>;
	for (const score of scores) {
		for (const [key, value] of Object.entries(score)) {
			if (typeof value === 'number') counts[key] += value;
		}
		sum.missed.push(...score.missed);
	}
	const recall = sum.targets ? sum.found / sum.targets : 0;
	const judged = sum.correct + sum.falseAlarms;
	const precision = judged ? sum.correct / judged : 0;
	const f1 = recall + precision ? (2 * recall * precision) / (recall + precision) : 0;
	return { ...sum, falseIndexes: [], recall, precision, f1 };
}

/** Letters and digits only, NFKC-folded: punctuation, spacing, and ellipses never cost a point. */
export function ocrKey(text: string): string {
	return String(text || '').normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '');
}

/** Best approximate occurrence of `needle` anywhere in `hay` (semi-global edit distance). */
export function fuzzyFind(hay: string, needle: string): { distance: number; start: number; end: number } {
	const a = [...needle];
	const b = [...hay];
	const m = a.length;
	const n = b.length;
	if (!m) return { distance: 0, start: 0, end: 0 };
	if (!n) return { distance: m, start: 0, end: 0 };
	let prev = new Array<number>(n + 1).fill(0);
	let prevStart = Array.from({ length: n + 1 }, (_, j) => j);
	for (let i = 1; i <= m; i++) {
		const cur = new Array<number>(n + 1);
		const curStart = new Array<number>(n + 1);
		cur[0] = i;
		curStart[0] = 0;
		for (let j = 1; j <= n; j++) {
			const diag = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
			const up = prev[j] + 1;
			const left = cur[j - 1] + 1;
			if (diag <= up && diag <= left) {
				cur[j] = diag;
				curStart[j] = prevStart[j - 1];
			} else if (up <= left) {
				cur[j] = up;
				curStart[j] = prevStart[j];
			} else {
				cur[j] = left;
				curStart[j] = curStart[j - 1];
			}
		}
		prev = cur;
		prevStart = curStart;
	}
	let end = 0;
	for (let j = 1; j <= n; j++) if (prev[j] < prev[end]) end = j;
	return { distance: prev[end], start: prevStart[end], end };
}

export type OcrLineScore = {
	id: string;
	group: 'dialogue' | 'other';
	gold: string;
	/** What the output held where the line matched best. */
	read: string;
	accuracy: number;
	chars: number;
};

export type OcrPageScore = {
	lines: OcrLineScore[];
	/** Share of output characters that no gold line accounts for. */
	noise: number;
	outputChars: number;
};

/**
 * Lines claim output exclusively, longest first, so a sign that is a substring of a banner
 * cannot borrow the banner's text. A repeated SFX may claim one reading per box.
 */
export function scoreOcrPage(page: GoldPage, output: string): OcrPageScore {
	const chars = [...ocrKey(output)];
	const used = new Array<boolean>(chars.length).fill(false);
	const free = () => chars.map((ch, i) => (used[i] ? '\u0000' : ch)).join('');
	const scored = new Map<string, OcrLineScore>();
	const order = page.lines
		.map((line) => ({ line, gold: ocrKey(line.source) }))
		.filter((item) => item.gold && item.line.ocr !== false)
		.sort((a, b) => [...b.gold].length - [...a.gold].length);
	for (const { line, gold } of order) {
		const size = [...gold].length;
		for (let copy = 0; copy < line.boxes.length; copy++) {
			const hit = fuzzyFind(free(), gold);
			const accuracy = Math.max(0, 1 - hit.distance / size);
			if (copy === 0) {
				const group = goldOcrGroup(line);
				if (group) scored.set(line.id, { id: line.id, group, gold: line.source, read: chars.slice(hit.start, hit.end).join(''), accuracy, chars: size });
			}
			if (accuracy < 0.5) break;
			for (let i = hit.start; i < hit.end; i++) used[i] = true;
		}
	}
	const lines = page.lines.flatMap((line) => scored.get(line.id) || []);
	const stray = used.filter((value) => !value).length;
	return { lines, noise: chars.length ? stray / chars.length : 0, outputChars: chars.length };
}

export type OcrTotals = { dialogue: number; other: number; noise: number; lines: number; exact: number };

export function totalOcr(pages: OcrPageScore[]): OcrTotals {
	const weigh = (group: OcrLineScore['group']) => {
		const lines = pages.flatMap((page) => page.lines.filter((line) => line.group === group));
		const chars = lines.reduce((sum, line) => sum + line.chars, 0);
		return chars ? lines.reduce((sum, line) => sum + line.accuracy * line.chars, 0) / chars : 0;
	};
	const output = pages.reduce((sum, page) => sum + page.outputChars, 0);
	const stray = pages.reduce((sum, page) => sum + page.noise * page.outputChars, 0);
	const all = pages.flatMap((page) => page.lines);
	return {
		dialogue: weigh('dialogue'),
		other: weigh('other'),
		noise: output ? stray / output : 0,
		lines: all.length,
		exact: all.filter((line) => line.accuracy === 1).length,
	};
}

export type ChrfStats = { match: number[]; hyp: number[]; ref: number[] };

const CHRF_ORDER = 6;
const CHRF_BETA = 2;

function chrfText(text: string) {
	return String(text || '')
		.normalize('NFKC')
		.toLowerCase()
		.replace(/[‘’]/g, "'")
		.replace(/[“”]/g, '"')
		.replace(/…/g, '...')
		.replace(/\s+/g, '');
}

function ngrams(chars: string[], n: number) {
	const counts = new Map<string, number>();
	for (let i = 0; i + n <= chars.length; i++) {
		const gram = chars.slice(i, i + n).join('');
		counts.set(gram, (counts.get(gram) || 0) + 1);
	}
	return counts;
}

export function chrfStats(hypothesis: string, reference: string): ChrfStats {
	const hyp = [...chrfText(hypothesis)];
	const ref = [...chrfText(reference)];
	const stats: ChrfStats = { match: [], hyp: [], ref: [] };
	for (let n = 1; n <= CHRF_ORDER; n++) {
		const h = ngrams(hyp, n);
		const r = ngrams(ref, n);
		let match = 0;
		for (const [gram, count] of h) match += Math.min(count, r.get(gram) || 0);
		stats.match.push(match);
		stats.hyp.push(Math.max(0, hyp.length - n + 1));
		stats.ref.push(Math.max(0, ref.length - n + 1));
	}
	return stats;
}

export function emptyChrf(): ChrfStats {
	return { match: new Array(CHRF_ORDER).fill(0), hyp: new Array(CHRF_ORDER).fill(0), ref: new Array(CHRF_ORDER).fill(0) };
}

export function addChrf(into: ChrfStats, add: ChrfStats): ChrfStats {
	for (let i = 0; i < CHRF_ORDER; i++) {
		into.match[i] += add.match[i];
		into.hyp[i] += add.hyp[i];
		into.ref[i] += add.ref[i];
	}
	return into;
}

/** 0–1. Orders the reference is too short for are left out of the average. */
export function chrfScore(stats: ChrfStats): number {
	let precision = 0;
	let recall = 0;
	let orders = 0;
	for (let i = 0; i < CHRF_ORDER; i++) {
		if (!stats.ref[i]) continue;
		orders += 1;
		precision += stats.hyp[i] ? stats.match[i] / stats.hyp[i] : 0;
		recall += stats.match[i] / stats.ref[i];
	}
	if (!orders) return 0;
	precision /= orders;
	recall /= orders;
	const b2 = CHRF_BETA * CHRF_BETA;
	return precision + recall ? ((1 + b2) * precision * recall) / (b2 * precision + recall) : 0;
}

export function chrf(hypothesis: string, reference: string): number {
	return chrfScore(chrfStats(hypothesis, reference));
}

/** Short phrases match whole words, allowing a plain inflection (eels, your, saying). */
export function englishHas(text: string, phrase: string): boolean {
	const haystack = String(text || '').toLowerCase().replace(/[‘’]/g, "'");
	const needle = phrase.toLowerCase();
	if (needle.length <= 3) {
		const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:s|es|d|ed|r|ing)?(?:$|[^a-z0-9])`).test(haystack);
	}
	return haystack.includes(needle);
}

export function keyHits(keys: string[][] | undefined, text: string): { hit: number; total: number; missed: string[] } {
	const groups = keys || [];
	const missed = groups.filter((group) => !group.some((phrase) => englishHas(text, phrase))).map((group) => group[0]);
	return { hit: groups.length - missed.length, total: groups.length, missed };
}

export type TranslationLineScore = {
	id: string;
	source: string;
	official: string;
	goldLiteral: string;
	translation: string;
	literal: string;
	/** chrF against natural English (official edition or checked reference). */
	chrfOfficial: number;
	/** chrF of the model's literal (or its translation when it gives none) against the literal reference. */
	chrfLiteral: number;
	keysHit: number;
	keysTotal: number;
	missedKeys: string[];
};

export type TranslationOutput = { id: string; translation: string; literal?: string };

export function scoreTranslationPage(page: GoldPage, outputs: TranslationOutput[]): TranslationLineScore[] {
	const byId = new Map(outputs.map((out) => [out.id, out]));
	return goldTranslationLines(page).map((line) => scoreTranslationLine(line, byId.get(line.id)));
}

export function scoreTranslationLine(line: GoldLine, out: TranslationOutput | undefined): TranslationLineScore {
	const translation = String(out?.translation || '').trim();
	const literal = String(out?.literal || '').trim();
	const keys = keyHits(line.keys, translation);
	return {
		id: line.id,
		source: line.source,
		official: line.en || '',
		goldLiteral: line.literal || '',
		translation,
		literal,
		chrfOfficial: translation ? chrf(translation, line.en || '') : 0,
		chrfLiteral: literal || translation ? chrf(literal || translation, line.literal || line.en || '') : 0,
		keysHit: keys.hit,
		keysTotal: keys.total,
		missedKeys: keys.missed,
	};
}

export type TranslationTotals = { official: number; literal: number; meaning: number; lines: number; missing: number };

/** Corpus chrF over every line, so long captions weigh more than a one-word reply. */
export function totalTranslation(lines: TranslationLineScore[]): TranslationTotals {
	const official = emptyChrf();
	const literal = emptyChrf();
	let hit = 0;
	let total = 0;
	for (const line of lines) {
		addChrf(official, chrfStats(line.translation, line.official));
		addChrf(literal, chrfStats(line.literal || line.translation, line.goldLiteral || line.official));
		hit += line.keysHit;
		total += line.keysTotal;
	}
	return {
		official: chrfScore(official),
		literal: chrfScore(literal),
		meaning: total ? hit / total : 0,
		lines: lines.length,
		missing: lines.filter((line) => !line.translation).length,
	};
}

/** Natural English scored against the literal reference: the dataset reference baseline. */
export function officialBaseline(pages: GoldPage[] = GOLD_PAGES): TranslationTotals {
	return totalTranslation(pages.flatMap((page) =>
		scoreTranslationPage(page, goldTranslationLines(page).map((line) => ({ id: line.id, translation: line.en || '' })))));
}

/** Detector backends; a setup combines one or more of them the way chapter transcription does. */
export type DetectorPart = 'rtdetr' | 'ctd' | 'paddle' | 'heuristic' | 'coo' | 'koharu';

export type DetectorSetup = { id: string; label: string; parts: DetectorPart[] };

/** RT-DETR and Comic Text Detector cross-check each other, the way chapter transcription runs them. */
const CROSS_CHECK: Partial<Record<DetectorPart, DetectorPart>> = { rtdetr: 'ctd', ctd: 'rtdetr' };

function setup(id: string, label: string, parts: DetectorPart[]): DetectorSetup {
	const partner = CROSS_CHECK[parts[0]];
	return { id, label, parts: partner ? [parts[0], partner, ...parts.slice(1)] : parts };
}

export const DETECTOR_SETUPS: DetectorSetup[] = [
	setup('rtdetr+coo+koharu', 'RT-DETR + COO + Koharu', ['rtdetr', 'coo', 'koharu']),
	setup('rtdetr+coo', 'RT-DETR + COO', ['rtdetr', 'coo']),
	setup('rtdetr+koharu', 'RT-DETR + Koharu', ['rtdetr', 'koharu']),
	setup('rtdetr', 'RT-DETR', ['rtdetr']),
	setup('ctd+coo+koharu', 'Comic Text Detector + COO + Koharu', ['ctd', 'coo', 'koharu']),
	setup('ctd+coo', 'Comic Text Detector + COO', ['ctd', 'coo']),
	setup('ctd+koharu', 'Comic Text Detector + Koharu', ['ctd', 'koharu']),
	setup('ctd', 'Comic Text Detector', ['ctd']),
	setup('paddle+coo+koharu', 'PaddleOCR lines + COO + Koharu', ['paddle', 'coo', 'koharu']),
	setup('paddle+coo', 'PaddleOCR lines + COO', ['paddle', 'coo']),
	setup('paddle+koharu', 'PaddleOCR lines + Koharu', ['paddle', 'koharu']),
	setup('paddle', 'PaddleOCR lines', ['paddle']),
	setup('heuristic', 'Geometric bubbles', ['heuristic']),
	setup('coo', 'COO DBNet++ alone (SFX only)', ['coo']),
	setup('koharu', 'Koharu SAM-TS-L alone', ['koharu']),
];

export const GOLD_SOURCE = 'gold';
export const PAGE_SOURCE = 'page';

export type DetectionPage = { page: string; ms: number; boxes: GoldBox[]; score: DetectionScore; error?: string };
export type DetectionResult = {
	id: string;
	label: string;
	state: 'pending' | 'running' | 'done' | 'error';
	pages: DetectionPage[];
	totals: DetectionTotals;
	/** When this setup was benchmarked. Older rows stay visible until they are run again. */
	at?: number;
	error?: string;
};

export type OcrPage = {
	page: string;
	ms: number;
	regions: number;
	output: string;
	lines: OcrLineScore[];
	noise: number;
	outputChars: number;
	/** Crops that failed while the rest of the page still read. */
	failedCrops?: number;
	cropError?: string;
	/** Readings chapter transcription would not save: duplicates from overlapping boxes, or English. */
	dropped?: number;
	error?: string;
};
export type OcrResult = {
	id: string;
	name: string;
	/** `gold`, `page` (one full-page call), or a detector setup id whose boxes were cropped. */
	source: string;
	sourceLabel: string;
	state: 'pending' | 'running' | 'done' | 'error';
	pages: OcrPage[];
	totals: OcrTotals;
	local?: boolean;
	billed?: boolean;
	/** When this model and crop source were benchmarked. */
	at?: number;
	error?: string;
};

export type TranslationPage = { page: string; ms: number; lines: TranslationLineScore[]; error?: string };
export type TranslationResult = {
	id: string;
	name: string;
	state: 'pending' | 'running' | 'done' | 'error';
	pages: TranslationPage[];
	totals: TranslationTotals;
	local?: boolean;
	billed?: boolean;
	/** When this model was benchmarked. */
	at?: number;
	error?: string;
	/** Meaning grade of these saved lines. Dropped when this model is benchmarked again. */
	review?: TranslationReview;
};

export type LineReview = { id: string; comparable: number; note: string };
export type ReviewTotals = { comparable: number; graded: number; lines: number };
export type TranslationReview = {
	reviewerId: string;
	reviewerName: string;
	at: number;
	/** `at` of the translation result these grades belong to. */
	resultAt: number;
	lines: LineReview[];
	totals: ReviewTotals;
	/** Two to four sentences on the translation as a whole. */
	assessment?: string;
	error?: string;
};
export type ReviewProgress = {
	state: 'running' | 'done' | 'error' | 'cancelled';
	reviewerId: string;
	reviewerName: string;
	at: number;
	finishedAt?: number;
	progress: { done: number; total: number; step: string };
	error?: string;
};

/** Hide a grade that belongs to an older run of the same model. */
export function attachedReview(row: { at?: number; review?: TranslationReview }): TranslationReview | undefined {
	const review = row.review;
	if (!review || (row.at && review.resultAt && review.resultAt !== row.at)) return;
	return review;
}

type RunBase = {
	dataset: string;
	datasetVersion: number;
	id: string;
	at: number;
	finishedAt?: number;
	state: 'running' | 'done' | 'error' | 'cancelled';
	progress: { done: number; total: number; step: string };
	pages: string[];
	error?: string;
};
export type OcrRun = RunBase & { kind: 'ocr'; detectors: DetectionResult[]; models: OcrResult[] };
export type TranslationRun = RunBase & { kind: 'translation'; models: TranslationResult[] };
export type BenchmarkKind = 'ocr' | 'translation';

/** `specialist`: a transcription model chapters can use (Hayai, PaddleOCR-VL, Manga OCR, Qwen3-VL). */
export type BenchmarkModel = { id: string; name: string; local?: boolean; billed?: boolean; crops?: boolean; specialist?: boolean };

export type BenchmarkStatus = {
	dataset: BenchmarkDataset;
	datasets: { id: string; label: string }[];
	runningDataset: string | null;
	ok: boolean;
	available: boolean;
	pages: { id: string; note: string }[];
	detectors: (DetectorSetup & { available: boolean; reason?: string })[];
	chapterSetup: string;
	ocrModels: BenchmarkModel[];
	translationModels: BenchmarkModel[];
	/** Models with a passing Conversation check. Any of them can grade saved translations. */
	reviewModels: BenchmarkModel[];
	review: ReviewProgress | null;
	baseline: TranslationTotals;
	running: BenchmarkKind | 'review' | null;
	runs: { ocr: OcrRun | null; translation: TranslationRun | null };
};

/** Median page time: the first page also pays for loading the model. */
export function medianMs(pages: { ms: number; error?: string }[]): number {
	const times = pages.filter((page) => !page.error).map((page) => page.ms).sort((a, b) => a - b);
	if (!times.length) return 0;
	const mid = Math.floor(times.length / 2);
	return times.length % 2 ? times[mid] : (times[mid - 1] + times[mid]) / 2;
}

export function parseBenchmarkOutput(text: string): { source: string } {
	const raw = String(text || '').trim();
	const jsonMatch = raw.match(/\{[\s\S]*\}/);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[0]) as { source?: unknown; lines?: unknown };
			if (Array.isArray(parsed.lines)) {
				return { source: parsed.lines.map((line) => typeof line === 'string' ? line : String((line as { source?: unknown })?.source || '')).filter(Boolean).join('\n') };
			}
			if (typeof parsed.source === 'string') return { source: parsed.source };
		} catch {
			/* fall through */
		}
	}
	return { source: raw };
}

export const BENCHMARK_PAGE_SYSTEM = 'You transcribe comic pages. Return JSON only, no markdown.';
export const BENCHMARK_PAGE_USER =
	'Transcribe every piece of Japanese lettering on this page — speech balloons, captions, sound effects, and signs — in reading order (right-to-left, top-to-bottom). Leave out furigana. JSON: {"lines":["one balloon or caption per entry"]}';
export const BENCHMARK_PAGE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['lines'],
	properties: { lines: { type: 'array', items: { type: 'string' } } },
};

/** Language and reading order belong to the fixture, not the model. */
export function benchmarkPagePrompt(lang: 'japanese' | 'korean') {
  return lang === 'japanese' ? BENCHMARK_PAGE_USER
    : 'Transcribe every piece of Korean lettering on this page — speech balloons, captions, sound effects, and signs — in reading order (top-to-bottom, left-to-right within panels). Preserve standalone Hangul consonants. JSON: {"lines":["one balloon or caption per entry"]}';
}

export const REVIEW_SYSTEM = `You grade a comic translation against a checked English reference. Compare meaning, not words.

The reference is one good rendering, not the only wording. A different localization is highly comparable when a reader would take away the same facts, names, numbers, relationships, tone, and intent. Do not reward copying the reference. Do not mark a line down only because it is more literal or more natural than the reference.

Grade the response field. responseLiteral, when present, is the model's own close rendering and is context only.

Score each line as an integer from 0 to 100:
- 100: same meaning, facts, and tone; the wording may differ completely
- 75: the meaning is there, with a small miss in tone or a minor detail
- 50: the point survives, but a fact, name, number, or the tone is wrong
- 25: only partly related
- 0: empty, unrelated, or the opposite meaning

Return JSON only: an assessment of two to four sentences on the translation as a whole, plus one note of at most 20 words per line. The assessment should say what the translation keeps, what it changes or drops, and whether a different localization still carries the meaning.`;

export const REVIEW_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['assessment', 'lines'],
	properties: {
		assessment: { type: 'string' },
		lines: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['id', 'score', 'note'],
				properties: {
					id: { type: 'string' },
					score: { type: 'number' },
					note: { type: 'string' },
				},
			},
		},
	},
};

export type ReviewRequestLine = {
	id: string;
	page?: string;
	source: string;
	reference: string;
	literal: string;
	response: string;
	responseLiteral?: string;
};

export function reviewUserPrompt(input: { language: string; referenceKind: string; lines: ReviewRequestLine[] }): string {
	return JSON.stringify({
		language: input.language,
		referenceKind: input.referenceKind,
		lines: input.lines.map((line) => ({
			id: line.id,
			...(line.page ? { page: line.page } : {}),
			source: line.source,
			reference: line.reference,
			literal: line.literal,
			response: line.response,
			...(line.responseLiteral ? { responseLiteral: line.responseLiteral } : {}),
		})),
	});
}

const REVIEW_LETTERS: Record<string, number> = { A: 0.95, B: 0.82, C: 0.67, D: 0.5, F: 0.2 };

/** 0–1. Integers above 1 are the 0–100 scale the prompt asks for. */
export function parseReviewScore(value: unknown): number | undefined {
	if (typeof value === 'string' && /^[abcdf]$/i.test(value.trim())) return REVIEW_LETTERS[value.trim().toUpperCase()];
	const score = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
	if (!Number.isFinite(score)) return;
	if (score > 1) return Math.min(100, Math.max(0, score)) / 100;
	return Math.max(0, score);
}

export function reviewLetter(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
	if (score >= 0.9) return 'A';
	if (score >= 0.75) return 'B';
	if (score >= 0.6) return 'C';
	if (score >= 0.4) return 'D';
	return 'F';
}

function reviewObject(raw: unknown): unknown {
	if (typeof raw !== 'string') return raw;
	const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
	const text = fenced?.[1] || raw;
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) throw new Error('Review did not return JSON');
	try {
		return JSON.parse(match[0]);
	} catch {
		throw new Error('Review did not return JSON');
	}
}

export type ParsedReview = { lines: LineReview[]; assessment: string };

/** Grades for the ids this request sent, plus the overall written assessment. */
export function parseReviewGrades(raw: unknown, expectedIds: string[]): ParsedReview {
	const value = reviewObject(raw) as { lines?: unknown; assessment?: unknown };
	if (!Array.isArray(value?.lines)) throw new Error('Review did not return line grades');
	const wanted = new Set(expectedIds);
	const seen = new Set<string>();
	const grades: LineReview[] = [];
	for (const item of value.lines) {
		if (!item || typeof item !== 'object') continue;
		const row = item as { id?: unknown; score?: unknown; note?: unknown };
		const id = String(row.id || '');
		if (!wanted.has(id) || seen.has(id)) continue;
		const comparable = parseReviewScore(row.score);
		if (comparable == null) continue;
		seen.add(id);
		grades.push({ id, comparable, note: String(row.note || '').trim().slice(0, 240) });
	}
	if (!grades.length && expectedIds.length) throw new Error('Review did not grade any lines');
	return { lines: grades, assessment: String(value.assessment || '').trim().slice(0, 2000) };
}

export function totalReview(lines: LineReview[], expected: number): ReviewTotals {
	const comparable = lines.length ? lines.reduce((sum, line) => sum + line.comparable, 0) / lines.length : 0;
	return { comparable, graded: lines.length, lines: expected };
}
