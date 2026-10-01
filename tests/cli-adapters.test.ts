import assert from 'node:assert/strict';
import type { DetectedBox } from '../src/lib/server/llm';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CliAdapterRegistry } from '../src/lib/server/cliAdapters/registry';
import { createCodexAdapter } from '../src/lib/server/cliAdapters/codex';
import { createGrokAdapter } from '../src/lib/server/cliAdapters/grok';
import { createCursorAdapter } from '../src/lib/server/cliAdapters/cursor';
import type { AdvisoryRequest, CliAdapter, CommandRuntime } from '../src/lib/server/cliAdapters/types';

const request: AdvisoryRequest = { system: 'Review', prompt: 'Question', images: [], schema: { type: 'object' } };
const options = { executable: () => '/fake/agent', defaultModel: () => 'default-model', listModels: async () => [] };
function fake(overrides: Partial<CliAdapter> = {}): CliAdapter {
  return { ...options, id: 'custom', label: 'Custom', supportsImages: false, advisory: async r => r.model, ...overrides };
}

test('registry supports independent adapters, defaults, explicit models and rejects duplicates', async () => {
  const registry = new CliAdapterRegistry([fake()]);
  assert.equal(await registry.advisory('custom', request), 'default-model');
  assert.equal(await registry.advisory('custom', { ...request, model: 'chosen' }), 'chosen');
  assert.throws(() => new CliAdapterRegistry([fake(), fake()]), /Duplicate/);
  assert.throws(() => new CliAdapterRegistry([fake({ id: '../bad' })]), /Invalid/);
  await assert.rejects(registry.advisory('unknown', request), /Unknown/);
  assert.equal(registry.has('codex'), false);
});

test('unsupported images, unavailable agents and pre-cancelled requests never execute', async () => {
  let calls = 0;
  const adapter = fake({ advisory: async () => { calls++; } });
  const registry = new CliAdapterRegistry([adapter]);
  await assert.rejects(registry.advisory('custom', { ...request, images: [Buffer.from('image')] }), /does not support/);
  await assert.rejects(registry.advisory('custom', { ...request, abort: AbortSignal.abort() }));
  await assert.rejects(new CliAdapterRegistry([fake({ executable: () => null })]).advisory('custom', request), /not found/);
  assert.equal(calls, 0);
});

test('Codex preserves schema, images, selected model, stdin, sandbox and final-file precedence', async () => {
  let work = '';
  const abort = new AbortController();
  const runtime: CommandRuntime = {
    parse: JSON.parse,
    async run(command) {
      work = command.cwd;
      assert.equal(command.abort, abort.signal);
      assert.equal(command.args[command.args.indexOf('--sandbox') + 1], 'read-only');
      assert.equal(command.args[command.args.indexOf('-m') + 1], 'chosen');
      assert.deepEqual(command.args.slice(-2), ['--', '-']);
      assert.match(command.stdin!, /Review\n\nQuestion/);
      assert.deepEqual(JSON.parse(await readFile(join(work, 'schema.json'), 'utf8')), request.schema);
      assert.equal(await readFile(join(work, 'image-1.jpg'), 'utf8'), 'image');
      await writeFile(join(work, 'last.txt'), '{"answer":"final"}');
      return { code: 0, stdout: '{"answer":"stdout"}', stderr: '' };
    },
  };
  const registry = new CliAdapterRegistry([createCodexAdapter(options, runtime)]);
  assert.deepEqual(await registry.advisory('codex', { ...request, images: [Buffer.from('image')], model: 'chosen', abort: abort.signal }), { answer: 'final' });
  assert.equal(existsSync(work), false);
});

test('temporary files are removed after process errors, malformed output, or cancellation', async () => {
  for (const failure of ['process', 'parse', 'cancel']) {
    let work = '';
    const controller = new AbortController();
    const adapter = createCodexAdapter(options, { parse: JSON.parse, async run(command) {
      work = command.cwd;
      if (failure === 'cancel') controller.abort();
      return { code: failure === 'process' ? 1 : 0, stdout: 'invalid JSON', stderr: 'failure' };
    } });
    await assert.rejects(adapter.advisory({ ...request, abort: controller.signal }));
    assert.equal(existsSync(work), false);
  }
});

test('Grok uses file attachments and forwards model, system prompt, schema and cancellation', async () => {
  let work = '';
  const controller = new AbortController();
  const bytes = Buffer.alloc(200_000, 1);
  const adapter = createGrokAdapter(options, {
    parse: JSON.parse,
    headlessArgs: () => ['--no-memory'],
    async imagePromptArgs(dir, prompt, images) {
      assert.equal(prompt, 'Question');
      assert.deepEqual(images, [bytes]);
      await writeFile(join(dir, 'prompt.json'), 'attachment');
      return ['--prompt-file', join(dir, 'prompt.json')];
    },
    async run(command) {
      work = command.cwd;
      assert.equal(command.abort, controller.signal);
      assert.equal(command.stdin, undefined);
      assert.equal(command.args[command.args.indexOf('-m') + 1], 'default-model');
      assert.ok(command.args.includes('Review Do not use tools.'));
      assert.ok(command.args.includes(JSON.stringify(request.schema)));
      assert.ok(command.args.join('').length < 2000);
      assert.ok(existsSync(join(work, 'prompt.json')));
      return { code: 0, stdout: '{"answer":"ok"}', stderr: '' };
    },
  });
  assert.deepEqual(await new CliAdapterRegistry([adapter]).advisory('grok', { ...request, images: [bytes], abort: controller.signal }), { answer: 'ok' });
  assert.equal(existsSync(work), false);
});

test('Cursor forwards ordered images and selected model through its existing runner', async () => {
  const images = [Buffer.from('one'), Buffer.from('two')];
  const abort = new AbortController();
  const adapter = createCursorAdapter(options, { parse: JSON.parse, async prompt(opts) {
    assert.deepEqual(opts.images, images);
    assert.equal(opts.model, 'selected');
    assert.equal(opts.abort, abort.signal);
    assert.match(opts.prompt, /Return JSON matching this schema/);
    return '{"answer":"cursor"}';
  } });
  assert.deepEqual(await new CliAdapterRegistry([adapter]).advisory('cursor', { ...request, images, model: 'selected', abort: abort.signal }), { answer: 'cursor' });
});

const translationOptions = { seriesNotes: '', prior: '', pageLabel: '1' };
const translationBox = { x: 0.1, y: 0.2, w: 0.3, h: 0.4, lineType: 'plain' as const, source: '明日の会議に来てください', literal: '', translation: '', reasoning: '' };

test('translation is optional and rejects unsupported, unknown, unavailable or image-incompatible agents', async () => {
  let calls = 0;
  const translate = async (boxes: DetectedBox[]) => { calls++; return boxes; };
  await assert.rejects(new CliAdapterRegistry([fake()]).translate('custom', [translationBox], translationOptions), /does not support translation/);
  await assert.rejects(new CliAdapterRegistry([]).translate('missing', [translationBox], translationOptions), /Unknown/);
  const registry = new CliAdapterRegistry([fake({ translate })]);
  await assert.rejects(registry.translate('custom', [translationBox], { ...translationOptions, jpeg: Buffer.from('crop') }), /does not support image/);
  await assert.rejects(registry.translate('custom', [translationBox], { ...translationOptions, abort: AbortSignal.abort() }));
  await assert.rejects(new CliAdapterRegistry([fake({ translate, executable: () => null })]).translate('custom', [translationBox], translationOptions), /not found/);
  assert.equal(calls, 0);
});

test('translation forwards context and model selection, and rejects cancellation after execution', async () => {
  const controller = new AbortController();
  const adapter = fake({ supportsImages: true, translate: async (boxes, opts) => {
    assert.deepEqual(opts.lineIndexes, [0]);
    assert.equal(opts.seriesGlossary, 'glossary');
    assert.equal(opts.jpeg?.toString(), 'crop');
    if (opts.model === 'cancel') controller.abort();
    return boxes.map(box => ({ ...box, translation: opts.model! }));
  } });
  const registry = new CliAdapterRegistry([adapter]);
  const opts = { ...translationOptions, lineIndexes: [0], seriesGlossary: 'glossary', jpeg: Buffer.from('crop') };
  assert.equal((await registry.translate('custom', [translationBox], opts))[0].translation, 'default-model');
  assert.equal((await registry.translate('custom', [translationBox], { ...opts, model: 'chosen' }))[0].translation, 'chosen');
  await assert.rejects(registry.translate('custom', [translationBox], { ...opts, model: 'cancel', abort: controller.signal }));
});

test('public translation dispatches all three CLIs and preserves missing-line retries and geometry', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'scan-translation-adapters-'));
  const keys = ['SCAN_ROOT', 'SCAN_DATA_DIR', 'DATABASE_URL', 'GROK_BIN', 'CODEX_BIN', 'CURSOR_BIN'] as const;
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  try {
    process.env.SCAN_ROOT = dir;
    process.env.SCAN_DATA_DIR = join(dir, 'data');
    process.env.DATABASE_URL = join(dir, 'test.db');
    const { translateScriptWithCli } = await import('../src/lib/server/cliTranslate');
    for (const engine of ['grok', 'codex', 'cursor'] as const) {
      const bin = join(dir, engine + '.cjs');
      const log = join(dir, engine + '.json');
      await writeFile(bin, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const log = ${JSON.stringify(log)};
const previous = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, 'utf8')) : [];
const prompt = args.includes('--prompt-file') ? fs.readFileSync(args[args.indexOf('--prompt-file') + 1], 'utf8') : args.includes('--workspace') ? fs.readFileSync(path.join(process.cwd(), 'prompt.txt'), 'utf8') : fs.readFileSync(0, 'utf8');
previous.push({ args, prompt });
fs.writeFileSync(log, JSON.stringify(previous));
const i = previous.length === 1 ? 0 : 1;
const result = JSON.stringify({items:[{i,translation:i === 0 ? 'Please attend tomorrow.' : 'Bring the documents.',literal:'',reasoning:''}]});
if(args.includes('-o')) fs.writeFileSync(args[args.indexOf('-o') + 1], result);
console.log(result);
`, { mode: 0o700 });
      process.env[engine.toUpperCase() + '_BIN'] = bin;
      const boxes = [translationBox, { ...translationBox, x: 0.6, source: '必要な書類を持参してください' }];
      const translated = await translateScriptWithCli(engine, boxes, { ...translationOptions, model: 'fixture-model', seriesGlossary: 'Test glossary' });
      assert.deepEqual(translated.map(box => box.translation), ['Please attend tomorrow.', 'Bring the documents.']);
      assert.deepEqual(translated.map(box => box.x), [0.1, 0.6]);
      assert.deepEqual(translated.map(box => box.source), boxes.map(box => box.source));
      const calls = JSON.parse(await readFile(log, 'utf8'));
      assert.equal(calls.length, 2, `${engine} should retry only once`);
      for (const call of calls) {
        assert.ok(call.args.includes('fixture-model'));
        assert.match(call.prompt, /Test glossary/);
      }
      assert.equal(boxes[0].translation, '');
    }
    await assert.rejects(translateScriptWithCli('chatgpt', [translationBox], translationOptions), /Unknown CLI adapter/);
  } finally {
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

const jpeg = Buffer.from('bubble-jpeg');

test('vision reading is optional and rejects unsupported, unknown, unavailable or image-incompatible agents', async () => {
  let calls = 0;
  const read = async () => { calls++; return { source: 'x', lineType: 'plain' as const }; };
  await assert.rejects(new CliAdapterRegistry([fake()]).read('custom', jpeg), /does not support vision reading/);
  await assert.rejects(new CliAdapterRegistry([]).read('missing', jpeg), /Unknown/);
  const registry = new CliAdapterRegistry([fake({ read })]);
  await assert.rejects(registry.read('custom', jpeg), /does not support image/);
  await assert.rejects(registry.read('custom', jpeg, { abort: AbortSignal.abort() }));
  await assert.rejects(new CliAdapterRegistry([fake({ read, supportsImages: true, executable: () => null })]).read('custom', jpeg), /not found/);
  assert.equal(calls, 0);
});

test('vision reading forwards the crop, language, model and cancellation', async () => {
  const controller = new AbortController();
  const adapter = fake({ supportsImages: true, read: async (crop, opts) => {
    assert.equal(crop, jpeg);
    assert.equal(opts.lang, 'japanese');
    if (opts.model === 'cancel') controller.abort();
    return { source: opts.model || '', lineType: '""' };
  } });
  const registry = new CliAdapterRegistry([adapter]);
  const opts = { lang: 'japanese' as const };
  assert.equal((await registry.read('custom', jpeg, opts)).source, 'default-model');
  assert.equal((await registry.read('custom', jpeg, { ...opts, model: 'chosen' })).source, 'chosen');
  await assert.rejects(registry.read('custom', jpeg, { ...opts, model: 'cancel', abort: controller.signal }));
});

test('public vision reading dispatches all three CLIs with the crop and selected model', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'scan-vision-adapters-'));
  const keys = ['SCAN_ROOT', 'SCAN_DATA_DIR', 'DATABASE_URL', 'GROK_BIN', 'CODEX_BIN', 'CURSOR_BIN'] as const;
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  try {
    process.env.SCAN_ROOT = dir;
    process.env.SCAN_DATA_DIR = join(dir, 'data');
    process.env.DATABASE_URL = join(dir, 'test.db');
    const { readBubbleWithCli } = await import('../src/lib/server/cliTranslate');
    for (const engine of ['grok', 'codex', 'cursor'] as const) {
      const bin = join(dir, engine + '-read.cjs');
      const log = join(dir, engine + '-read.json');
      await writeFile(bin, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const log = ${JSON.stringify(log)};
const prompt = args.includes('--prompt-file') ? fs.readFileSync(args[args.indexOf('--prompt-file') + 1], 'utf8') : args.includes('--workspace') ? fs.readFileSync(path.join(process.cwd(), 'prompt.txt'), 'utf8') : fs.readFileSync(0, 'utf8');
fs.writeFileSync(log, JSON.stringify({ args, prompt, cwd: process.cwd() }));
const result = JSON.stringify({source:'待って',lineType:'plain'});
if(args.includes('-o')) fs.writeFileSync(args[args.indexOf('-o') + 1], result);
console.log(result);
`, { mode: 0o700 });
      process.env[engine.toUpperCase() + '_BIN'] = bin;
      const read = await readBubbleWithCli(engine, jpeg, { lang: 'japanese', model: 'fixture-model' });
      assert.equal(read.source, '待って');
      assert.equal(read.lineType, 'plain');
      const call = JSON.parse(await readFile(log, 'utf8'));
      assert.ok(call.args.includes('fixture-model'));
      assert.match(call.prompt, /Japanese|kana|kanji/i);
      if (engine === 'grok') {
        const payload = JSON.parse(call.prompt);
        assert.equal(payload.content[1].type, 'image');
        assert.equal(Buffer.from(payload.content[1].data, 'base64').toString(), 'bubble-jpeg');
      }
      if (engine === 'codex') {
        assert.ok(call.args.includes('-i'));
        assert.ok(call.args.includes('crop.jpg') || call.args.some((arg: string) => arg.endsWith('crop.jpg')));
      }
      if (engine === 'cursor') assert.match(call.prompt, /Return JSON \{source, lineType\}/);
    }
    await assert.rejects(readBubbleWithCli('chatgpt', jpeg), /Unknown CLI adapter/);
  } finally {
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

const reviewOptions = {
  seriesNotes: 'Keep Taro consistent',
  seriesGlossary: '太郎 → Taro',
  prior: 'Previous page already reviewed',
  pages: 'Page 1: cafe',
  script: 'Complete chapter: 2 lines on 1 pages.',
};

test('chapter review is optional and rejects unsupported, unknown or unavailable agents', async () => {
  let calls = 0;
  const review = async () => { calls++; return { summary: 'x', issues: [], questions: [], notes: '' }; };
  await assert.rejects(new CliAdapterRegistry([fake()]).review('custom', reviewOptions), /does not support chapter review/);
  await assert.rejects(new CliAdapterRegistry([]).review('missing', reviewOptions), /Unknown/);
  await assert.rejects(new CliAdapterRegistry([fake({ review })]).review('custom', { ...reviewOptions, abort: AbortSignal.abort() }));
  await assert.rejects(new CliAdapterRegistry([fake({ review, executable: () => null })]).review('custom', reviewOptions), /not found/);
  assert.equal(calls, 0);
});

test('chapter review forwards pack fields, model and cancellation', async () => {
  const controller = new AbortController();
  const adapter = fake({ review: async (opts) => {
    assert.equal(opts.seriesNotes, reviewOptions.seriesNotes);
    assert.equal(opts.seriesGlossary, reviewOptions.seriesGlossary);
    assert.equal(opts.prior, reviewOptions.prior);
    assert.equal(opts.pages, reviewOptions.pages);
    assert.equal(opts.script, reviewOptions.script);
    assert.equal(opts.lang, 'japanese');
    if (opts.model === 'cancel') controller.abort();
    return { summary: opts.model || '', issues: [], questions: [], notes: opts.script };
  } });
  const registry = new CliAdapterRegistry([adapter]);
  const opts = { ...reviewOptions, lang: 'japanese' as const };
  assert.equal((await registry.review('custom', opts)).summary, 'default-model');
  assert.equal((await registry.review('custom', { ...opts, model: 'chosen' })).summary, 'chosen');
  await assert.rejects(registry.review('custom', { ...opts, model: 'cancel', abort: controller.signal }));
});

test('public chapter review dispatches all three CLIs with the pack and selected model', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'scan-review-adapters-'));
  const keys = ['SCAN_ROOT', 'SCAN_DATA_DIR', 'DATABASE_URL', 'GROK_BIN', 'CODEX_BIN', 'CURSOR_BIN'] as const;
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  try {
    process.env.SCAN_ROOT = dir;
    process.env.SCAN_DATA_DIR = join(dir, 'data');
    process.env.DATABASE_URL = join(dir, 'test.db');
    const { reviewChapterWithCli } = await import('../src/lib/server/cliTranslate');
    for (const engine of ['grok', 'codex', 'cursor'] as const) {
      const bin = join(dir, engine + '-review.cjs');
      const log = join(dir, engine + '-review.json');
      await writeFile(bin, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const log = ${JSON.stringify(log)};
const prompt = args.includes('--prompt-file') ? fs.readFileSync(args[args.indexOf('--prompt-file') + 1], 'utf8') : args.includes('--workspace') ? fs.readFileSync(path.join(process.cwd(), 'prompt.txt'), 'utf8') : fs.readFileSync(0, 'utf8');
fs.writeFileSync(log, JSON.stringify({ args, prompt, cwd: process.cwd() }));
const result = JSON.stringify({summary:'ok',issues:[],questions:[],notes:'fine'});
if(args.includes('-o')) fs.writeFileSync(args[args.indexOf('-o') + 1], result);
console.log(result);
`, { mode: 0o700 });
      process.env[engine.toUpperCase() + '_BIN'] = bin;
      const report = await reviewChapterWithCli(engine, { ...reviewOptions, lang: 'japanese', model: 'fixture-model' });
      assert.equal(report.summary, 'ok');
      assert.deepEqual(report.issues, []);
      assert.deepEqual(report.questions, []);
      assert.equal(report.notes, 'fine');
      const call = JSON.parse(await readFile(log, 'utf8'));
      assert.ok(call.args.includes('fixture-model'));
      assert.match(call.prompt, /Keep Taro consistent/);
      assert.match(call.prompt, /Complete chapter: 2 lines/);
      if (engine === 'grok') assert.ok(call.args.includes('--json-schema'));
      if (engine === 'cursor') assert.match(call.prompt, /Return JSON \{summary/);
    }
    await assert.rejects(reviewChapterWithCli('chatgpt', reviewOptions), /Unknown CLI adapter/);
  } finally {
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

const pageJpeg = Buffer.from('page-jpeg');

test('page description is optional and rejects unsupported, unknown, unavailable or image-incompatible agents', async () => {
  let calls = 0;
  const describe = async () => { calls++; return 'note'; };
  await assert.rejects(new CliAdapterRegistry([fake()]).describe('custom', pageJpeg), /does not support page description/);
  await assert.rejects(new CliAdapterRegistry([]).describe('missing', pageJpeg), /Unknown/);
  const registry = new CliAdapterRegistry([fake({ describe })]);
  await assert.rejects(registry.describe('custom', pageJpeg), /does not support image/);
  await assert.rejects(registry.describe('custom', pageJpeg, { abort: AbortSignal.abort() }));
  await assert.rejects(new CliAdapterRegistry([fake({ describe, supportsImages: true, executable: () => null })]).describe('custom', pageJpeg), /not found/);
  assert.equal(calls, 0);
});

test('page description forwards the jpeg, model and cancellation', async () => {
  const controller = new AbortController();
  const adapter = fake({ supportsImages: true, describe: async (crop, opts) => {
    assert.equal(crop, pageJpeg);
    if (opts.model === 'cancel') controller.abort();
    return opts.model || '';
  } });
  const registry = new CliAdapterRegistry([adapter]);
  assert.equal(await registry.describe('custom', pageJpeg), 'default-model');
  assert.equal(await registry.describe('custom', pageJpeg, { model: 'chosen' }), 'chosen');
  await assert.rejects(registry.describe('custom', pageJpeg, { model: 'cancel', abort: controller.signal }));
});

test('public page description dispatches all three CLIs with the page image and selected model', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'scan-describe-adapters-'));
  const keys = ['SCAN_ROOT', 'SCAN_DATA_DIR', 'DATABASE_URL', 'GROK_BIN', 'CODEX_BIN', 'CURSOR_BIN'] as const;
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  try {
    process.env.SCAN_ROOT = dir;
    process.env.SCAN_DATA_DIR = join(dir, 'data');
    process.env.DATABASE_URL = join(dir, 'test.db');
    const { describePageWithCli } = await import('../src/lib/server/cliTranslate');
    for (const engine of ['grok', 'codex', 'cursor'] as const) {
      const bin = join(dir, engine + '-describe.cjs');
      const log = join(dir, engine + '-describe.json');
      await writeFile(bin, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const log = ${JSON.stringify(log)};
const prompt = args.includes('--prompt-file') ? fs.readFileSync(args[args.indexOf('--prompt-file') + 1], 'utf8') : args.includes('--workspace') ? fs.readFileSync(path.join(process.cwd(), 'prompt.txt'), 'utf8') : fs.readFileSync(0, 'utf8');
fs.writeFileSync(log, JSON.stringify({ args, prompt, cwd: process.cwd() }));
const result = JSON.stringify({caption:'A cafe scene'});
if(args.includes('-o')) fs.writeFileSync(args[args.indexOf('-o') + 1], result);
console.log(result);
`, { mode: 0o700 });
      process.env[engine.toUpperCase() + '_BIN'] = bin;
      const caption = await describePageWithCli(engine, pageJpeg, { model: 'fixture-model' });
      assert.equal(caption, 'A cafe scene');
      const call = JSON.parse(await readFile(log, 'utf8'));
      assert.ok(call.args.includes('fixture-model'));
      assert.match(call.prompt, /translator|written words|caption/i);
      if (engine === 'grok') {
        const payload = JSON.parse(call.prompt);
        assert.equal(payload.content[1].type, 'image');
        assert.equal(Buffer.from(payload.content[1].data, 'base64').toString(), 'page-jpeg');
        assert.ok(call.args.includes('--json-schema'));
      }
      if (engine === 'codex') {
        assert.ok(call.args.includes('-i'));
        assert.ok(call.args.includes('page.jpg') || call.args.some((arg: string) => arg.endsWith('page.jpg')));
      }
      if (engine === 'cursor') assert.match(call.prompt, /Return JSON \{caption\}/);
    }
    await assert.rejects(describePageWithCli('chatgpt', pageJpeg), /Unknown CLI adapter/);
  } finally {
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

const artwork = Buffer.from('artwork-png');
const mask = Buffer.from('mask-png');

test('cleaning is optional, Codex-only, and rejects unsupported, unknown, unavailable or image-incompatible agents', async () => {
  let calls = 0;
  const clean = async () => { calls++; return Buffer.from('out'); };
  await assert.rejects(new CliAdapterRegistry([fake()]).clean('custom', artwork, { mask }), /does not support cleaning/);
  await assert.rejects(new CliAdapterRegistry([]).clean('chatgpt', artwork, { mask }), /Unknown/);
  const registry = new CliAdapterRegistry([fake({ clean })]);
  await assert.rejects(registry.clean('custom', artwork, { mask }), /does not support image/);
  await assert.rejects(registry.clean('custom', artwork, { mask, abort: AbortSignal.abort() }));
  await assert.rejects(new CliAdapterRegistry([fake({ clean, supportsImages: true, executable: () => null })]).clean('custom', artwork, { mask }), /not found/);
  const grokRuntime = { parse: JSON.parse, headlessArgs: () => [], imagePromptArgs: async () => [], run: async () => ({ code: 0, stdout: '{}', stderr: '' }) };
  await assert.rejects(new CliAdapterRegistry([createGrokAdapter(options, grokRuntime)]).clean('grok', artwork, { mask }), /does not support cleaning/);
  await assert.rejects(new CliAdapterRegistry([createCursorAdapter(options, { parse: JSON.parse, prompt: async () => '{}' })]).clean('cursor', artwork, { mask }), /does not support cleaning/);
  assert.equal(calls, 0);
});

test('cleaning forwards the artwork, mask, model and cancellation', async () => {
  const controller = new AbortController();
  const adapter = fake({ supportsImages: true, clean: async (image, opts) => {
    assert.equal(image, artwork);
    assert.equal(opts.mask, mask);
    if (opts.model === 'cancel') controller.abort();
    return Buffer.from(opts.model || '');
  } });
  const registry = new CliAdapterRegistry([adapter]);
  assert.equal((await registry.clean('custom', artwork, { mask })).toString(), 'default-model');
  assert.equal((await registry.clean('custom', artwork, { mask, model: 'chosen' })).toString(), 'chosen');
  await assert.rejects(registry.clean('custom', artwork, { mask, model: 'cancel', abort: controller.signal }));
});

test('public cleaning dispatches Codex only, with artwork, mask and selected model', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'scan-clean-adapters-'));
  const keys = ['SCAN_ROOT', 'SCAN_DATA_DIR', 'DATABASE_URL', 'CODEX_BIN', 'CODEX_MODEL', 'GROK_BIN', 'CURSOR_BIN'] as const;
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  try {
    process.env.SCAN_ROOT = dir;
    process.env.SCAN_DATA_DIR = join(dir, 'data');
    process.env.DATABASE_URL = join(dir, 'test.db');
    process.env.CODEX_MODEL = 'fixture-model';
    const bin = join(dir, 'codex-clean.cjs');
    const log = join(dir, 'codex-clean.json');
    await writeFile(bin, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({
  args,
  prompt: args.at(-1),
  artwork: fs.readFileSync('artwork.png', 'utf8'),
  mask: fs.readFileSync('mask.png', 'utf8'),
}));
fs.writeFileSync('cleaned.png', 'cleaned-png-bytes');
if (args.includes('-o')) fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify({error:''}));
console.log(JSON.stringify({error:''}));
`, { mode: 0o700 });
    process.env.CODEX_BIN = bin;
    const { generateCleaningImageWithCodex } = await import('../src/lib/server/cliTranslate');
    const cleaned = await generateCleaningImageWithCodex({ image: artwork, mask });
    assert.equal(cleaned.toString(), 'cleaned-png-bytes');
    const call = JSON.parse(await readFile(log, 'utf8'));
    assert.ok(call.args.includes('workspace-write'));
    assert.ok(call.args.includes('image_generation'));
    assert.equal(call.args[call.args.indexOf('-m') + 1], 'fixture-model');
    assert.equal(call.artwork, 'artwork-png');
    assert.equal(call.mask, 'mask-png');
    assert.match(call.prompt, /black pixels/);
    assert.doesNotMatch(call.prompt, /missing finger/);
    const withNotes = await generateCleaningImageWithCodex({
      image: artwork,
      mask,
      prompt: "Keep the sleeve. Redraw the missing finger properly.",
    });
    assert.equal(withNotes.toString(), "cleaned-png-bytes");
    const noted = JSON.parse(await readFile(log, "utf8"));
    assert.match(noted.prompt, /Keep the sleeve\. Redraw the missing finger properly\./);
    assert.match(noted.prompt, /black pixels/);
    assert.ok(call.args.some((arg: string) => arg.endsWith('artwork.png')));
    assert.ok(call.args.some((arg: string) => arg.endsWith('mask.png')));
  } finally {
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
