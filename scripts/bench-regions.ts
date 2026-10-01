/**
 * End-to-end detector comparison through the real app path
 * (detectRegions -> cropBubble -> readBubbleOcr).
 *
 *   npx tsx scripts/bench-regions.ts [--ocr] [--detectors a,b] page.jpg ...
 *
 * Without --ocr it only counts regions, which is fast. With --ocr it also
 * reads every region, so you see how many survive the recogniser — that is
 * the number of lines AI translate would actually produce.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import sharp from 'sharp';
import { cropBubble } from '../src/lib/server/bubbles';
import { detectRegions } from '../src/lib/server/detect';
import { isMeaningfulSource, readBubbleOcr } from '../src/lib/server/ocr';
import { DETECTORS, type Detector } from '../src/lib/types';

const argv = process.argv.slice(2);
const withOcr = argv.includes('--ocr');
const listIdx = argv.indexOf('--detectors');
const detectorArg = listIdx >= 0 ? argv[listIdx + 1] : '';
const detectors: Detector[] = detectorArg
	? (detectorArg.split(',').filter((d) => (DETECTORS as string[]).includes(d)) as Detector[])
	: [...DETECTORS];
const skip = listIdx >= 0 ? listIdx + 1 : -1;
const pages = argv.filter((a, i) => !a.startsWith('--') && i !== skip);

if (!pages.length) {
	console.error('usage: bench-regions.ts [--ocr] [--detectors rtdetr,ctd] <page.jpg> ...');
	process.exit(1);
}

const head = withOcr
	? `${'page'.padEnd(24)} ${'detector'.padEnd(10)} ${'regions'.padStart(7)} ${'read'.padStart(5)} ${'chars'.padStart(6)} ${'sec'.padStart(6)}`
	: `${'page'.padEnd(24)} ${'detector'.padEnd(10)} ${'regions'.padStart(7)} ${'sfx'.padStart(5)} ${'sec'.padStart(6)}`;
console.log(head);

for (const page of pages) {
	const bytes = await readFile(page);
	const meta = await sharp(bytes).metadata();
	const width = meta.width || 1;
	const height = meta.height || 1;
	for (const detector of detectors) {
		const t0 = Date.now();
		try {
			const regions = await detectRegions({ path: page, bytes, width, height }, { detector });
			const free = regions.filter((r) => r.kind === 'free').length;
			if (!withOcr) {
				console.log(
					`${basename(page).padEnd(24)} ${detector.padEnd(10)} ${String(regions.length).padStart(7)} ${String(free).padStart(5)} ${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}`
				);
				continue;
			}
			let read = 0;
			let chars = 0;
			for (const region of regions) {
				const jpeg = await cropBubble(bytes, region.ocr);
				const out = await readBubbleOcr(jpeg);
				if (!isMeaningfulSource(out.source, out.score)) continue;
				read++;
				chars += out.source.length;
			}
			console.log(
				`${basename(page).padEnd(24)} ${detector.padEnd(10)} ${String(regions.length).padStart(7)} ${String(read).padStart(5)} ${String(chars).padStart(6)} ${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}`
			);
		} catch (e) {
			console.log(
				`${basename(page).padEnd(24)} ${detector.padEnd(10)} ERR ${e instanceof Error ? e.message : String(e)}`
			);
		}
	}
}
process.exit(0);
