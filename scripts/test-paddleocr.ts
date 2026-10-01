import { readFile } from 'node:fs/promises';
import { cropBubble, findSpeechBubbles } from '../src/lib/server/bubbles';
import { readBubbleOcr } from '../src/lib/server/ocr';

const files = process.argv.slice(2);
if (!files.length) {
	console.error('Usage: node --import tsx scripts/test-paddleocr.ts <page.jpg> [page.jpg ...]');
	process.exit(1);
}

for (const page of files) {
	const raw = await readFile(page);
	const t0 = Date.now();
	const bubbles = await findSpeechBubbles(raw);
	console.log(`\n${page.split('/').pop()}  ${bubbles.length} regions  ${Date.now() - t0}ms`);
	for (let i = 0; i < bubbles.length; i++) {
		const t1 = Date.now();
		const jpeg = await cropBubble(raw, bubbles[i]);
		const read = await readBubbleOcr(jpeg);
		console.log(
			`  ${String(i + 1).padStart(2, '0')} ${bubbles[i].width}x${bubbles[i].height} ${Date.now() - t1}ms  ${JSON.stringify(read.source)}`
		);
	}
}
process.exit(0);
