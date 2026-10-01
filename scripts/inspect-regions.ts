/**
 * Per-region detector + recogniser trace for one page.
 *
 *   npx tsx scripts/inspect-regions.ts [--detector rtdetr] [--dump DIR] page.jpg
 *
 * Prints READ/DROP for every detected region. `--dump` writes the crops that
 * the recogniser returned nothing for, which is the fastest way to tell a
 * detector false positive from a recognition failure.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { cropBubble } from '../src/lib/server/bubbles';
import { detectRegions } from '../src/lib/server/detect';
import { isMeaningfulSource, readBubbleOcr } from '../src/lib/server/ocr';
import { DETECTORS, type Detector } from '../src/lib/types';

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}
const detectorArg = flag('--detector');
const detector: Detector = (DETECTORS as string[]).includes(detectorArg ?? '')
	? (detectorArg as Detector)
	: 'rtdetr';
const dump = flag('--dump');
const page = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--detector' && argv[i - 1] !== '--dump');

if (!page) {
	console.error('usage: inspect-regions.ts [--detector rtdetr] [--dump DIR] <page.jpg>');
	process.exit(1);
}
if (dump) await mkdir(dump, { recursive: true });

const bytes = await readFile(page);
const meta = await sharp(bytes).metadata();
const regions = await detectRegions(
	{ path: page, bytes, width: meta.width || 1, height: meta.height || 1 },
	{ detector }
);
console.log(`${page} · ${detector} · ${regions.length} regions`);

let read = 0;
for (let i = 0; i < regions.length; i++) {
	const r = regions[i];
	const jpeg = await cropBubble(bytes, r.ocr);
	const out = await readBubbleOcr(jpeg);
	const keep = isMeaningfulSource(out.source, out.score);
	if (keep) read++;
	console.log(
		`${keep ? 'READ' : 'DROP'} ${String(i + 1).padStart(2)} ${r.kind.padEnd(7)} ` +
			`det=${r.score.toFixed(2)} ${r.ocr.width}x${r.ocr.height}@y${r.ocr.top} ` +
			`ocr=${out.score.toFixed(2)} ${JSON.stringify(out.source)}`
	);
	if (!keep && dump) {
		await writeFile(join(dump, `${String(i + 1).padStart(2, '0')}-y${r.ocr.top}.jpg`), jpeg);
	}
}
console.log(`read ${read}/${regions.length}`);
process.exit(0);
