import { readFile } from 'node:fs/promises';
import { cropBubble, findSpeechBubbles } from '../src/lib/server/bubbles';
import { isDrawnSfx, readBubble, translateScript, type DetectedBox } from '../src/lib/server/llm';

const PAGE = process.env.SCAN_BENCH_PAGE;
if (!PAGE) {
	console.error('Set SCAN_BENCH_PAGE to the page image to compare against.');
	process.exit(1);
}
const MODELS = ['qwen3.8-27b-q4', 'qwen3.8-27b-q6'] as const;

async function runModel(model: string, crops: Buffer[]) {
	const started = Date.now();
	const located: DetectedBox[] = [];
	for (let i = 0; i < crops.length; i++) {
		const t0 = Date.now();
		const read = await readBubble(crops[i], undefined, model);
		const ms = Date.now() - t0;
		const skip = !read.source || isDrawnSfx({
			x: 0,
			y: 0,
			w: 1,
			h: 1,
			lineType: read.lineType,
			source: read.source,
			literal: '',
			translation: '',
			reasoning: ''
		});
		console.error(`[${model}] bubble ${i + 1}/${crops.length} ${ms}ms source=${JSON.stringify(read.source)} type=${read.lineType}${skip ? ' SKIP' : ''}`);
		if (skip) continue;
		located.push({
			x: 0,
			y: 0,
			w: 1,
			h: 1,
			lineType: read.lineType,
			source: read.source,
			literal: '',
			translation: '',
			reasoning: ''
		});
	}
	const t1 = Date.now();
	const translated = await translateScript(located, {
		seriesNotes: '',
		prior: '',
		pageLabel: '02 · page 1/14',
		model
	});
	console.error(`[${model}] translate ${Date.now() - t1}ms, total ${Date.now() - started}ms`);
	return translated;
}

const raw = await readFile(PAGE);
const bubbles = await findSpeechBubbles(raw);
console.error(`found ${bubbles.length} bubbles`);
const crops = await Promise.all(bubbles.map((b) => cropBubble(raw, b)));

const results: Record<string, Awaited<ReturnType<typeof runModel>>> = {};
for (const model of MODELS) {
	results[model] = await runModel(model, crops);
}

const n = Math.max(...MODELS.map((m) => results[m].length));
console.log('\n# Q4 vs Q6 — chapter 02 first strip\n');
for (let i = 0; i < n; i++) {
	const a = results[MODELS[0]][i];
	const b = results[MODELS[1]][i];
	const sameSrc = (a?.source || '') === (b?.source || '');
	const sameTr = (a?.translation || '') === (b?.translation || '');
	console.log(`## ${i + 1}  OCR ${sameSrc ? 'same' : 'DIFF'}  EN ${sameTr ? 'same' : 'DIFF'}`);
	console.log(`Q4 source: ${a?.source || '—'}`);
	console.log(`Q6 source: ${b?.source || '—'}`);
	console.log(`Q4 EN:     ${a?.translation || '—'}`);
	console.log(`Q6 EN:     ${b?.translation || '—'}`);
	console.log('');
}
