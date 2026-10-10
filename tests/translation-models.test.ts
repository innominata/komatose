import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { translationModel, assertGeneralModel } from '../src/lib/translationModels';
import { sanitizeModelId } from '../src/lib/aiTasks';
import { QWEN_38_27B_ID } from '../src/lib/qwenModels';
import type { DetectedBox, TranslateScriptOpts } from '../src/lib/server/llm';
import { fixturePasses } from './local-ocr-fixture';

const root = await mkdtemp(join(tmpdir(), 'scan-translation-tests-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.DATABASE_URL = join(root, 'test.db');
await mkdir(join(root, 'data'), { recursive: true });
// Chat rows are no longer seeded. The legacy qwen host resolves only when this machine has one.
await writeFile(join(root, 'data', 'models.json'), JSON.stringify({
  rows: [{
    id: 'qwen3.8-27b-q4',
    name: 'Qwen 3.8 27B',
    slug: 'qwen3.8-27b-q4',
    access: 'local_http',
    runtime: 'llamacpp',
    seeded: false,
  }],
}));
for (const name of ['SCAN_TRANSLATION_HY_URL', 'SCAN_TRANSLATION_KOEN_URL', 'SCAN_TRANSLATION_HY_GGUF', 'SCAN_TRANSLATION_KOEN_CKPT', 'SCAN_TRANSLATION_SHISA_URL', 'SCAN_TRANSLATION_SHISA_GGUF', 'SCAN_TRANSLATION_SUGOI_URL', 'SCAN_TRANSLATION_SUGOI_CKPT', 'SCAN_TRANSLATION_MODELS_DIR']) delete process.env[name];
const { specialistRequest, parseSpecialistTranslation, translateWithSpecialist } = await import('../src/lib/server/specialistTranslation');
const { completeTranslation, stopTranslationRuntime, listTranslationModels, translationModelConfig, translationModelReadiness } = await import('../src/lib/server/translationRuntime');
const { translateScript, chatCompletions } = await import('../src/lib/server/llm');
const { assertEngineReady } = await import('../src/lib/server/engineReadiness');
const { ocrTranslatorLabel, translateOcrSource } = await import('../src/lib/server/ocrReview');
const hy = translationModel('hy-mt2-manga-v5')!;
const koen = translationModel('Imsbee/ko-en-translator')!;
const opus = translationModel('opus-mt-ja-en')!;
const shisa = translationModel('shisa-ai/shisa-v2.1-qwen3-8b')!;
const sugoi = translationModel('sugoi-translator')!;
const opts: TranslateScriptOpts = { seriesNotes: 'Scene notes', prior: '', pageLabel: 'Page 1', lang: 'japanese', seriesGlossary: '太郎 → Taro' };
const box = (source: string, id = 'r1'): DetectedBox => ({ id, x: .1, y: .2, w: .3, h: .1, source, translation: 'Existing', literal: '', reasoning: '', lineType: '""' });
const reply = (content: string, finish_reason = 'stop') => ({ choices: [{ finish_reason, message: { content } }], usage: { prompt_tokens: 20, completion_tokens: 3 } });
after(async () => { await stopTranslationRuntime(); });

test('publisher IDs resolve to stable saved IDs without losing namespace characters', async () => {
  assert.equal(sanitizeModelId('fumetoday/Hy-MT2-1.8B-JP-Manga-Finetune-v5'), hy.id);
  assert.equal(sanitizeModelId('Imsbee/ko-en-translator'), koen.id);
  const { validateModel } = await import('../src/lib/server/regionAi');
  assert.deepEqual(validateModel({ engine: 'qwen', model: koen.repository }), {
    engine: koen.id,
    model: '',
  });
  assert.equal(sanitizeModelId('org/model:tag'), 'org/model:tag');
  assert.deepEqual(validateModel({ engine: 'qwen', model: 'org/model:tag' }), {
    engine: QWEN_38_27B_ID,
    model: 'org/model:tag',
  });
  assert.throws(() => validateModel({ engine: 'qwen', model: 'bad model' }));
});

test('native requests use plain text, correct languages, glossary and sampling', () => {
  const request = specialistRequest(hy, '太郎、待って！', opts);
  assert.equal(request.messages.length, 1);
  assert.match(request.messages[0].content, /太郎 translates to Taro/);
  assert.ok(request.messages[0].content.endsWith('太郎、待って！'));
  assert.equal(request.temperature, .15);
  assert.equal(request.min_p, 0);
  assert.deepEqual(request.samplers, ['penalties', 'top_k', 'top_p', 'temperature']);
  assert.equal('response_format' in request, false);
  assert.equal('chat_template_kwargs' in request, false);
  assert.throws(() => specialistRequest(hy, '안녕', { ...opts, lang: 'korean' }), /does not support korean/);
  const korean = specialistRequest(koen, '기다려!\n잠깐!', { ...opts, lang: 'korean' });
  assert.equal(korean.messages[0].content, '기다려!\n잠깐!');
  assert.equal(korean.temperature, 0);
  assert.equal(korean.repeat_penalty, 1);
  assert.throws(() => specialistRequest(koen, '待って！', opts), /does not support japanese/);
  const jaFast = specialistRequest(opus, '待って！', opts);
  assert.equal(jaFast.messages[0].content, '待って！');
  assert.equal(jaFast.temperature, 0);
  assert.equal(jaFast.max_tokens, 256);
  assert.throws(() => specialistRequest(opus, '안녕', { ...opts, lang: 'korean' }), /does not support korean/);
  assert.equal(shisa.id, 'shisa-v2.1-qwen3-8b-q4');
  const shisaRequest = specialistRequest(shisa, '太郎、待って！', opts);
  assert.equal(shisaRequest.messages[0].role, 'system');
  assert.match(shisaRequest.messages[1].content, /太郎 translates to Taro/);
  assert.ok(shisaRequest.messages[1].content.endsWith('太郎、待って！'));
  assert.equal(shisaRequest.temperature, 0.15);
  assert.equal(shisaRequest.max_tokens, 96);
  assert.deepEqual(shisaRequest.stop, ['\n\n']);
  assert.deepEqual(shisaRequest.chat_template_kwargs, { enable_thinking: false });
  assert.throws(() => specialistRequest(shisa, '안녕', { ...opts, lang: 'korean' }), /does not support korean/);
  const cat = translationModel('cyberagent/CAT-Translate-7b')!;
  assert.equal(cat.id, 'cat-translate-7b-q4');
  const catRequest = specialistRequest(cat, '太郎、待って！', opts);
  assert.equal(catRequest.messages[0].content, 'Translate the following Japanese text into English. Output only the translation.\n\n太郎、待って！');
  assert.equal(catRequest.temperature, 0);
  const hy7 = translationModel('hy-mt2-7b-q4')!;
  const hy7Request = specialistRequest(hy7, '太郎、待って！', opts);
  assert.match(hy7Request.messages[0].content, /Reference the following translations/);
  assert.match(hy7Request.messages[0].content, /太郎 translates to Taro/);
  assert.match(hy7Request.messages[0].content, /ONLY output the translated result/);
  assert.ok(hy7Request.messages[0].content.endsWith('太郎、待って！'));
  assert.equal(hy7Request.temperature, 0.7);
  assert.equal(hy7Request.top_p, 0.8);
  const gemma = translationModel('translategemma-12b-q4')!;
  const gemmaRequest = specialistRequest(gemma, '太郎、待って！', opts);
  assert.equal(gemmaRequest.messages.length, 1);
  assert.equal(gemmaRequest.messages[0].content, '太郎、待って！');
  assert.equal(gemmaRequest.temperature, 0);
  assert.deepEqual(gemmaRequest.chat_template_kwargs, { source_lang_code: 'ja', target_lang_code: 'en' });
  assert.deepEqual(specialistRequest(gemma, '안녕', { ...opts, lang: 'korean' }).chat_template_kwargs,
    { source_lang_code: 'ko', target_lang_code: 'en' });
  assert.equal(sugoi.id, 'sugoi-v4-ja-en');
  const sugoiRequest = specialistRequest(sugoi, '待って！', opts);
  assert.equal(sugoiRequest.messages[0].content, '待って！');
  assert.equal(sugoiRequest.temperature, 0);
  assert.equal(sugoiRequest.max_tokens, 256);
  assert.throws(() => specialistRequest(sugoi, '안녕', { ...opts, lang: 'korean' }), /does not support korean/);
});

test('translation-only models cannot silently use the generic vision/chat endpoint', async () => {
  assert.throws(() => assertGeneralModel(hy.id), /Translation only/);
  await assert.rejects(chatCompletions([], { model: koen.id }), /Translation only/);
});

test('stock HY-MT2 and TranslateGemma translate Korean without changing Japanese-only fine-tunes', async () => {
  for (const id of ['hy-mt2-1.8b-q4', 'hy-mt2-7b-q4', 'translategemma-4b-q4', 'translategemma-12b-q4']) {
    const model = translationModel(id)!;
    assert.ok(model.languages.includes('korean'));
    const request = specialistRequest(model, '기다려 주세요', { ...opts, lang: 'korean', seriesGlossary: '' });
    assert.ok(request.messages[0].content.endsWith('기다려 주세요'));
    assert.doesNotMatch(request.messages[0].content, /Japanese|日本語/);
    const vertical = specialistRequest(model, '기\n다\n려\n!', { ...opts, lang: 'korean', seriesGlossary: '' });
    assert.ok(vertical.messages[0].content.endsWith('기다려!'));
    assert.ok(specialistRequest(model, '네가\n나를\n사랑한다고\n했잖아!', { ...opts, lang: 'korean', seriesGlossary: '' }).messages[0].content.endsWith('네가\n나를\n사랑한다고\n했잖아!'));
    if (model.profile === 'translategemma') assert.equal(request.chat_template_kwargs?.source_lang_code, 'ko');
    const result = await translateWithSpecialist(model, [box('기다려 주세요')], { ...opts, lang: 'korean' }, async () => reply('Please wait.'));
    assert.equal(result[0].translation, 'Please wait.');
    assert.equal(result[0].source, '기다려 주세요');
  }
  const rows = (await import('../src/lib/server/modelRegistryStore')).listRegistryRows();
  for (const id of ['hy-mt2-1.8b-q4', 'hy-mt2-7b-q4', 'translategemma-4b-q4', 'translategemma-12b-q4'])
    assert.deepEqual(rows.find(r => r.id === id)?.languages, ['japanese', 'korean']);
  assert.throws(() => specialistRequest(hy, '기다려 주세요', { ...opts, lang: 'korean' }), /does not support korean/);
});

test('Imsbee stays unavailable until installed or an explicit runtime is configured', () => {
  assert.equal(translationModelReadiness(koen).available, false);
  assert.match(translationModelReadiness(koen).reason, /Not installed/);
  process.env.SCAN_TRANSLATION_KOEN_URL = 'https://koen.fixture/v1';
  assert.equal(listTranslationModels().find(model => model.id === koen.id)?.available, true);
  delete process.env.SCAN_TRANSLATION_KOEN_URL;
});

test('a partial Imsbee download is not treated as ready', async () => {
  const dir = join(process.env.SCAN_DATA_DIR!, 'models/translation', koen.id, 'sentence-base');
  await mkdir(dir, { recursive: true });
  const ckpt = join(dir, 'best.pt');
  await writeFile(ckpt, 'PARTIAL');
  try {
    assert.equal(translationModelConfig(koen).path, ckpt);
    assert.equal(translationModelReadiness(koen).available, false);
    assert.match(translationModelReadiness(koen).reason, /Incomplete|Not installed/);
  } finally {
    await rm(ckpt);
  }
});

test('standalone Japanese SFX skip inference and mixed SFX are added to the glossary', async () => {
  const calls: string[] = [];
  const output = await translateWithSpecialist(hy, [
    box('ドキドキ'),
    box('ドキドキする', 'r2'),
    box('', 'r3'),
  ], opts, async (_model, request) => {
    calls.push(request.messages[0].content);
    return reply('My heart is pounding!');
  });
  assert.equal(output[0].translation, 'thump thump');
  assert.match(output[0].reasoning, /SFX dictionary/);
  assert.equal(output[1].translation, 'My heart is pounding!');
  assert.equal(output[2].translation, 'Existing');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /ドキドキ translates to thump thump/);
  assert.match(calls[0], /ドキドキする/);
  assert.doesNotMatch(calls[0], /Translate the following[\s\S]*ドキドキ\n/);
});

test('OCR English uses the SFX dictionary without calling the translator', async () => {
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json(reply('doki doki')); };
  try {
    assert.equal(await translateOcrSource('ドーン！', new AbortController().signal, {
      engine: 'qwen', model: hy.id, lang: 'japanese',
    }), 'BOOM');
    assert.equal(await translateOcrSource('하아', new AbortController().signal, {
      engine: 'qwen', model: hy.id, lang: 'korean',
    }), 'sigh');
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('each region retains its identity, source and geometry; empty source does not run inference', async () => {
  const input = [box('待って！'), box('行け！', 'r2'), box('', 'r3')];
  const before = structuredClone(input);
  const calls: string[] = [];
  const output = await translateWithSpecialist(hy, input, opts, async (_model, request) => {
    calls.push(request.messages[0].content);
    return reply(calls.length === 1 ? 'Wait!' : 'Go!');
  });
  assert.deepEqual(input, before);
  assert.deepEqual(output.map(row => [row.id, row.source, row.translation, row.x]), [
    ['r1', '待って！', 'Wait!', .1], ['r2', '行け！', 'Go!', .1], ['r3', '', 'Existing', .1],
  ]);
  assert.equal(calls.length, 2);
});

test('empty, truncated, refusal and reasoning-only results fail without mutating caller text', async () => {
  for (const payload of [reply(''), reply('Wait', 'length'), reply('blocked', 'content_filter'), reply('<think>draft</think>')]) {
    assert.throws(() => parseSpecialistTranslation(payload));
    const input = [box('待って！')];
    await assert.rejects(translateWithSpecialist(hy, input, opts, async () => payload));
    assert.equal(input[0].translation, 'Existing');
  }
  assert.equal(parseSpecialistTranslation(reply('<think>\n\n</think>\n\nWait!')), 'Wait!');
});

test('translation dispatch uses the configured specialist endpoint and preserves opaque endpoint model IDs', async () => {
  process.env.SCAN_TRANSLATION_KOEN_URL = 'https://koen.fixture/v1';
  process.env.SCAN_TRANSLATION_KOEN_MODEL = 'Imsbee/ko-en-translator';
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://koen.fixture/v1/chat/completions');
    const request = JSON.parse(String(init?.body));
    assert.equal(request.model, koen.repository);
    assert.equal(request.messages[0].content, '기다려!');
    assert.equal('response_format' in request, false);
    return Response.json(reply('Wait!'));
  };
  try {
    await assertEngineReady('qwen', koen.id);
    const result = await translateScript([box('기다려!')], { ...opts, lang: 'korean', model: koen.id });
    assert.equal(result[0].translation, 'Wait!');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = oldFetch;
    delete process.env.SCAN_TRANSLATION_KOEN_URL;
    delete process.env.SCAN_TRANSLATION_KOEN_MODEL;
  }
});

test('cancelled queued requests return promptly and never reach the endpoint', async () => {
  process.env.SCAN_TRANSLATION_KOEN_URL = 'https://koen.fixture/v1';
  const oldFetch = globalThis.fetch;
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  globalThis.fetch = async () => { calls++; entered(); await gate; return Response.json(reply('Wait!')); };
  try {
    const first = completeTranslation(koen, specialistRequest(koen, '기다려!', { ...opts, lang: 'korean' }));
    await started;
    const abort = new AbortController();
    const second = completeTranslation(koen, specialistRequest(koen, '가!', { ...opts, lang: 'korean' }), abort.signal);
    abort.abort(new Error('Cancelled queued translation'));
    await assert.rejects(second, /Cancelled queued/);
    release();
    await first;
    assert.equal(calls, 1);
  } finally { release(); globalThis.fetch = oldFetch; delete process.env.SCAN_TRANSLATION_KOEN_URL; }
});

test('managed runtime reports executable startup errors without hanging', async () => {
  const executable = join(root, 'missing-interpreter');
  const weights = join(root, 'fixture.gguf');
  await writeFile(executable, '#!/no/such/interpreter\n', { mode: 0o755 });
  await writeFile(weights, 'GGUF');
  process.env.SCAN_TRANSLATION_HY_GGUF = weights;
  process.env.SCAN_TRANSLATION_LLAMA_SERVER = executable;
  try {
    await assert.rejects(completeTranslation(hy, specialistRequest(hy, '待って！', opts)), /ENOENT/);
  } finally {
    await stopTranslationRuntime();
    delete process.env.SCAN_TRANSLATION_HY_GGUF;
    delete process.env.SCAN_TRANSLATION_LLAMA_SERVER;
  }
});

test('OCR English uses the selected specialist instead of Qwen3-VL-8B', async () => {
  process.env.SCAN_TRANSLATION_KOEN_URL = 'https://koen.fixture/v1';
  process.env.SCAN_TRANSLATION_KOEN_MODEL = 'Imsbee/ko-en-translator';
  await fixturePasses(koen.id, ['translate']);
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://koen.fixture/v1/chat/completions');
    const request = JSON.parse(String(init?.body));
    assert.match(request.messages[0].content, /기다려!/);
    return Response.json(reply('Wait!'));
  };
  try {
    assert.match(ocrTranslatorLabel('qwen', koen.id), /Imsbee/);
    assert.equal(await translateOcrSource('기다려!', new AbortController().signal, {
      engine: 'qwen', model: koen.id, lang: 'korean',
    }), 'Wait!');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = oldFetch;
    delete process.env.SCAN_TRANSLATION_KOEN_URL;
    delete process.env.SCAN_TRANSLATION_KOEN_MODEL;
  }
});

test('OCR English for a general translation model uses that model, not Qwen3-VL-8B', async () => {
  process.env.LLAMASWAP_API_KEY ??= 'fixture';
  await fixturePasses(QWEN_38_27B_ID, ['translate']);
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const request = JSON.parse(String(init?.body));
    assert.equal(request.model, 'translation-fixture');
    assert.match(request.messages[0].content, /Translate the supplied/);
    assert.doesNotMatch(String(_url), /qwen3-vl-8b/);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ translation: 'Wait!' }) } }] });
  };
  try {
    assert.equal(ocrTranslatorLabel('qwen', 'translation-fixture'), 'translation-fixture');
    assert.equal(await translateOcrSource('待って！', new AbortController().signal, {
      engine: 'qwen', model: 'translation-fixture', lang: 'japanese',
    }), 'Wait!');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
