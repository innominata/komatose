import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const root = await mkdtemp(join(tmpdir(), 'scan-codex-clean-test-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.DATABASE_URL = join(root, 'data', 'test.db');
const { cleanWithCodex, probeCodexCleaning } = await import('../src/lib/server/codexClean');
const originalBin = process.env.CODEX_BIN;
const originalModel = process.env.CODEX_MODEL;
const fakeBin = join(root, 'codex');
const callsPath = join(root, 'calls.jsonl');
const modePath = join(root, 'mode');
await writeFile(modePath, 'success');
await writeFile(fakeBin, String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = ${JSON.stringify(root)};
if (process.argv[2] === 'features') { fs.writeSync(1, 'image_generation stable true\n'); process.exit(0); }
const mode = fs.readFileSync(path.join(root, 'mode'), 'utf8');
const args = process.argv.slice(2);
const prompt = args.at(-1);
(() => {
  const cwd = process.cwd();
  fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify({ cwd, args, prompt }) + '\n');
  fs.copyFileSync('artwork.png', path.join(root, 'input.png'));
  fs.copyFileSync('mask.png', path.join(root, 'input-mask.png'));
  if (mode === 'wait') return setTimeout(() => {}, 60000);
  if (mode === 'exit') { fs.writeSync(2, 'fixture backend failure'); process.exit(1); }
  const last = args[args.indexOf('-o') + 1];
  fs.writeFileSync(last, JSON.stringify({ error: mode === 'error' ? 'Image generation limit reached' : '' }));
  if (mode === 'success' || mode === 'shape') fs.copyFileSync(path.join(root, mode === 'shape' ? 'wide.png' : 'fill.png'), 'cleaned.png');
  if (mode === 'invalid') fs.writeFileSync('cleaned.png', 'not an image');
})();
`, { mode: 0o755 });
process.env.CODEX_BIN = fakeBin;
process.env.CODEX_MODEL = 'fixture-model';
await sharp({ create: { width: 512, height: 512, channels: 3, background: '#c83219' } }).png().toFile(join(root, 'fill.png'));
await sharp({ create: { width: 512, height: 256, channels: 3, background: '#c83219' } }).png().toFile(join(root, 'wide.png'));
const calls = async () => (await readFile(callsPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

async function fixture(name: string, width: number, height: number, pixels: [number, number][]) {
	const source = Buffer.alloc(width * height * 4);
	for (let i = 0; i < width * height; i++) source.set([i % 251, (i * 3) % 253, (i * 7) % 255, 255], i * 4);
	const mask = Buffer.alloc(width * height);
	for (const [x, y] of pixels) mask[y * width + x] = 255;
	const opts = { path: join(root, `${name}.png`), mask: join(root, `${name}-mask.png`), out: join(root, `${name}-out.png`) };
	await sharp(source, { raw: { width, height, channels: 4 } }).png().toFile(opts.path);
	await sharp(mask, { raw: { width, height, channels: 1 } }).png().toFile(opts.mask);
	return { opts, source, mask };
}

test('Codex cleaning sends the matching mask and keeps native dimensions', async () => {
	assert.equal((await probeCodexCleaning()).available, true);
	const { opts } = await fixture('small', 96, 80, [[40, 30], [41, 30], [42, 31]]);
	const result = await cleanWithCodex(opts);
	assert.equal(result.method, 'codex');
	assert.equal(result.patches, 1);
	const output = await sharp(opts.out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	assert.equal(output.info.width, 96);
	assert.equal(output.info.height, 80);
	assert.deepEqual(output.data.subarray((30 * 96 + 40) * 4, (30 * 96 + 40) * 4 + 4), Buffer.from([200, 50, 25, 255]));
	const request = (await calls()).at(-1);
	assert(request.args.includes('workspace-write'));
	assert(request.args.includes('image_generation'));
	assert.equal(request.args[request.args.indexOf('-m') + 1], 'fixture-model');
	assert.match(request.prompt, /black pixels provide surrounding artwork context/);
	assert.match(request.prompt, /Reconstruct the artwork hidden behind the marked lettering/);
	assert.doesNotMatch(request.prompt, /missing finger/);
	const sentMask = await sharp(join(root, 'input-mask.png')).greyscale().raw().toBuffer({ resolveWithObject: true });
	assert.equal(sentMask.info.width, 512);
	assert.equal(sentMask.data[30 * 512 + 40], 255);
	assert.equal(sentMask.data[0], 0);
	assert.equal(sentMask.data.filter(v => v !== 0).length, 3);
	await assert.rejects(access(request.cwd));
});

test('Codex cleaning forwards user reconstruction notes', async () => {
	const { opts } = await fixture('notes', 32, 32, [[8, 8]]);
	const count = (await calls()).length;
	await cleanWithCodex({
		...opts,
		prompt: 'Redraw the missing finger properly. Keep the surrounding pose.',
	});
	assert.equal((await calls()).length, count + 1);
	const request = (await calls()).at(-1);
	assert.match(request.prompt, /Redraw the missing finger properly\. Keep the surrounding pose\./);
	assert.match(request.prompt, /black pixels provide surrounding artwork context/);
});

test('long pages are cropped without changing native dimensions or missing tile edges', async () => {
	const { opts } = await fixture('strip', 800, 1800, [[767, 767], [768, 768], [20, 1700]]);
	const count = (await calls()).length;
	const result = await cleanWithCodex(opts);
	assert.equal(result.patches, 2);
	const output = await sharp(opts.out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	assert.equal(output.info.width, 800);
	assert.equal(output.info.height, 1800);
	assert.deepEqual(output.data.subarray((767 * 800 + 767) * 4, (767 * 800 + 767) * 4 + 4), Buffer.from([200, 50, 25, 255]));
	assert.deepEqual(output.data.subarray((1700 * 800 + 20) * 4, (1700 * 800 + 20) * 4 + 4), Buffer.from([200, 50, 25, 255]));
	assert.equal((await calls()).length - count, 2);
	const input = await sharp(join(root, 'input.png')).metadata();
	assert(input.width! <= 1024 && input.height! <= 1024);
});

test('empty, mismatched and cancelled masks never invoke the model', async () => {
	const { opts } = await fixture('empty', 20, 20, []);
	const count = (await calls()).length;
	await assert.rejects(cleanWithCodex(opts), /mask is empty/);
	await sharp({ create: { width: 10, height: 10, channels: 3, background: 'white' } }).png().toFile(opts.mask);
	await assert.rejects(cleanWithCodex(opts), /dimensions/);
	await assert.rejects(cleanWithCodex(opts, AbortSignal.abort()));
	assert.equal((await calls()).length, count);
	await assert.rejects(access(opts.out));
});

test('model errors and malformed results leave the previous output intact', async () => {
	const { opts } = await fixture('failure', 20, 20, [[10, 10]]);
	await writeFile(opts.out, 'previous cleaned artifact');
	for (const [mode, error] of [['error', /limit reached/], ['exit', /backend failure/], ['missing', /valid cleaned image/], ['invalid', /unsupported image format/], ['shape', /framing/]] as const) {
		await writeFile(modePath, mode);
		await assert.rejects(cleanWithCodex(opts), error);
		assert.equal(await readFile(opts.out, 'utf8'), 'previous cleaned artifact');
		await assert.rejects(access((await calls()).at(-1).cwd));
	}
	await writeFile(modePath, 'success');
});

test('cancelling a running generation stops the CLI and removes temporary inputs', async () => {
	const { opts } = await fixture('cancel', 20, 20, [[10, 10]]);
	await writeFile(modePath, 'wait');
	const count = (await calls()).length;
	const controller = new AbortController();
	const task = assert.rejects(cleanWithCodex(opts, controller.signal), /Cancelled/);
	for (let i = 0; i < 100 && (await calls()).length === count; i++) await new Promise(resolve => setTimeout(resolve, 20));
	assert.equal((await calls()).length, count + 1);
	controller.abort();
	await task;
	await assert.rejects(access(opts.out));
	await assert.rejects(access((await calls()).at(-1).cwd));
	await writeFile(modePath, 'success');
});

after(async () => {
	if (originalBin === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = originalBin;
	if (originalModel === undefined) delete process.env.CODEX_MODEL; else process.env.CODEX_MODEL = originalModel;
	await rm(root, { recursive: true, force: true });
});
