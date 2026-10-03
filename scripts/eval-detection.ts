/**
 * Score detector setups against the gold boxes for fixtures/test-pages.
 *
 *   npx tsx scripts/eval-detection.ts collect          run every backend once, cache the raw output
 *   npx tsx scripts/eval-detection.ts [setup ...]      score cached output (all setups when none are named)
 *   npx tsx scripts/eval-detection.ts --misses <setup> list missed lines and false alarms for one setup
 *
 * The cache holds raw backend output (before merging), so changes to the merge and
 * classification rules in src/lib/server/detect.ts can be scored in seconds.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { GOLD_PAGES, GOLD_LANG } from '../src/lib/benchmarkGold';
import { DETECTOR_SETUPS, scoreDetection, totalDetection, type DetectorPart } from '../src/lib/modelBenchmark';
import { composeSetup } from '../src/lib/server/modelBenchmark';
import { parseKoharuRegions, parseSfxRegions } from '../src/lib/server/detect';
import { detectRegionsPy, type WorkerRegion } from '../src/lib/server/ocr';
import { localOperation } from '../src/lib/server/localWorker';

const CACHE = process.env.DETECT_EVAL_CACHE || join(tmpdir(), 'komatose-detect-eval.json');
type Raw = { regions: WorkerRegion[]; width: number; height: number };
type Cache = Record<string, Partial<Record<DetectorPart, Raw>>>;
const PARTS: DetectorPart[] = ['rtdetr', 'ctd', 'paddle', 'coo', 'koharu'];
/** Private pages (not committed): `EXTRA_PAGES=/tmp/a.jpg,/tmp/b.jpg`. They are listed, not scored. */
const EXTRA = (process.env.EXTRA_PAGES || '').split(',').filter(Boolean);
const extraId = (file: string) => `extra:${file}`;

async function collect() {
	const cache: Cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
	const only = process.argv.slice(3);
	const pages = [
		...GOLD_PAGES.map((page) => ({ id: page.id, path: join(process.cwd(), page.file) })),
		...EXTRA.map((file) => ({ id: extraId(file), path: file })),
	];
	for (const page of pages) {
		const path = page.path;
		cache[page.id] ||= {};
		for (const part of PARTS) {
			if (only.length && !only.includes(part)) continue;
			const started = Date.now();
			try {
				let out: Raw;
				if (part === 'coo') {
					const found = await localOperation({ cmd: 'detect-sfx', path, confidence: 0.6 });
					out = { regions: parseSfxRegions(found.regions), width: Number(found.width) || 1, height: Number(found.height) || 1 };
				} else if (part === 'koharu') {
					const found = await localOperation({ cmd: 'detect-text', path, out: join(tmpdir(), 'eval-koharu-mask.png'), maskExpansion: 3 });
					out = { regions: parseKoharuRegions(found.regions), width: Number(found.width) || 1, height: Number(found.height) || 1 };
				} else {
					const found = await detectRegionsPy(path, { backend: part, lang: GOLD_LANG, supplement: false });
					out = { regions: found.regions, width: found.width, height: found.height };
				}
				cache[page.id][part] = out;
				console.log(`${page.id} ${part.padEnd(7)} ${String(out.regions.length).padStart(3)} boxes ${((Date.now() - started) / 1000).toFixed(1)}s`);
			} catch (error) {
				console.log(`${page.id} ${part} FAILED ${error instanceof Error ? error.message : error}`);
			}
			writeFileSync(CACHE, JSON.stringify(cache));
		}
	}
}

function setupBoxes(setupId: string, pageId: string, cache: Cache, width: number, height: number) {
	const setup = DETECTOR_SETUPS.find((item) => item.id === setupId)!;
	const outputs = new Map<DetectorPart, any>();
	for (const part of setup.parts) {
		const raw = cache[pageId]?.[part];
		if (!raw) return undefined;
		outputs.set(part, { ...raw, ms: 0 });
	}
	return composeSetup(setup, outputs, width, height);
}

async function listExtra(setupId: string) {
	const cache: Cache = JSON.parse(readFileSync(CACHE, 'utf8'));
	for (const file of EXTRA) {
		const meta = await sharp(file).metadata();
		const found = setupBoxes(setupId, extraId(file), cache, meta.width!, meta.height!);
		console.log(`${file} ${meta.width}x${meta.height} ${setupId}: ${found?.length ?? 0} regions`);
		for (const r of found ?? []) {
			console.log(`  [${[r.place.left, r.place.top, r.place.left + r.place.width, r.place.top + r.place.height].map(Math.round).join(', ')}] ${r.kind} ${r.score.toFixed(2)} ${r.provenance?.backend ?? ''}`);
		}
	}
}

async function score() {
	const cache: Cache = JSON.parse(readFileSync(CACHE, 'utf8'));
	const argv = process.argv.slice(2);
	const misses = argv.includes('--misses');
	const names = argv.filter((a) => !a.startsWith('--'));
	const ids = names.length ? names : DETECTOR_SETUPS.map((s) => s.id);
	console.log(`${'setup'.padEnd(22)} recall  prec   f1    found/targets  sfx   false  regions`);
	for (const id of ids) {
		const scores = [];
		const lines: string[] = [];
		let regions = 0;
		for (const page of GOLD_PAGES) {
			const found = setupBoxes(id, page.id, cache, page.width, page.height);
			if (!found) continue;
			const boxes = found.map((r) => [r.place.left, r.place.top, r.place.left + r.place.width, r.place.top + r.place.height].map(Math.round) as [number, number, number, number]);
			regions += boxes.length;
			const s = scoreDetection(page, boxes);
			scores.push(s);
			if (misses) {
				if (s.missed.length) lines.push(`  ${page.id} missed: ${s.missed.join(', ')}`);
				for (const index of s.falseIndexes) lines.push(`  ${page.id} false : [${boxes[index].join(', ')}] ${found[index].kind} ${found[index].score.toFixed(2)}`);
			}
		}
		if (!scores.length) continue;
		const t = totalDetection(scores);
		console.log(
			`${id.padEnd(22)} ${t.recall.toFixed(3)}  ${t.precision.toFixed(3)}  ${t.f1.toFixed(3)}  ${`${t.found}/${t.targets}`.padEnd(13)}  ${`${t.sfxFound}/${t.sfxTargets}`.padEnd(5)} ${String(t.falseAlarms).padStart(4)}   ${regions}`,
		);
		for (const line of lines) console.log(line);
	}
}

if (process.argv[2] === 'collect') await collect();
else if (process.argv[2] === 'extra') await listExtra(process.argv[3] || 'ctd+coo+koharu');
else await score();
process.exit(0);
