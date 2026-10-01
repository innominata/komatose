import { readFile } from 'node:fs/promises';
import { findSpeechBubbles } from '../src/lib/server/bubbles';

const dir = process.env.SCAN_BENCH_DIR;
if (!dir) {
	console.error('Set SCAN_BENCH_DIR to the episode image directory to count bubbles in.');
	process.exit(1);
}
const files = [
	'01-pages-001-010.jpg',
	'02-pages-011-020.jpg',
	'03-pages-021-030.jpg',
	'06-pages-051-060.jpg',
	'10-pages-091-100.jpg'
];
for (const f of files) {
	const raw = await readFile(`${dir}/${f}`);
	const b = await findSpeechBubbles(raw);
	console.log(f, b.length);
}
