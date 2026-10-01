import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ocrSourceAttribution, reviewOcrSource } from '../src/lib/server/ocrReview';
import { compactSuggestionReason } from '../src/lib/suggestionReason';
import { collapseSuggestions, suggestionMatchesLine } from '../src/lib/regionAi';
import {
  listReviewServerStatuses,
  localChat,
  localTranscription,
  operateReviewServer,
  stopLocalReviewModels,
  waitReviewOperation,
  withLocalReview,
} from '../src/lib/server/localReview';

test('a suggestion that already matches the region is not actionable', () => {
  const line = { source: '待って——！', body: 'Wait-!' };
  assert.equal(suggestionMatchesLine({ kind: 'source-review', body: '待って——！', translation: 'Wait—!' }, line), true);
  assert.equal(suggestionMatchesLine({ kind: 'source-review', body: '待って——！', translation: 'Hold on!' }, line), false);
  assert.equal(suggestionMatchesLine({ kind: 'source-review', body: '別の読み', translation: 'Wait-!' }, line), false);
  assert.equal(suggestionMatchesLine({ kind: 'revise', body: 'Wait—!' }, line), true);
  assert.equal(suggestionMatchesLine({ kind: 'revise', body: 'Hold on!' }, line), false);
  assert.equal(suggestionMatchesLine({ kind: 'source-review', body: '眠そうだな斉藤......', translation: 'You look sleepy, Saito...' }, { source: '眠そうだな斉藤...', body: 'You look sleepy, Saito...' }), true);
});

test('source suggestions that differ only by hyphens or periods collapse into one', () => {
  const merged = collapseSuggestions([
    { id: 'paddle', kind: 'source-review', body: '眠そうだな斉藤......', translation: 'You look sleepy, Saito...', reason: 'PaddleOCR-VL-1.6 · Sugoi v4' },
    { id: 'hayai', kind: 'source-review', body: '眠そうだな斉藤...', translation: 'You look sleepy, Saito...', reason: 'Hayai OCR v2 · Sugoi v4' },
    { id: 'other', kind: 'source-review', body: '別の読み', translation: 'A different line.', reason: 'Hayai OCR v2' },
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].mergedIds, ['paddle', 'hayai']);
  assert.match(merged[0].reason ?? '', /PaddleOCR-VL-1.6/);
  assert.match(merged[0].reason ?? '', /Hayai OCR v2/);
  assert.deepEqual(merged[1].mergedIds, ['other']);
  const punctuation = collapseSuggestions([
    { id: 'bang', kind: 'source-review', body: 'そう！', translation: 'Right!' },
    { id: 'ask', kind: 'source-review', body: 'そう？', translation: 'Right?' },
  ]);
  assert.equal(punctuation.length, 2);
});

test('OCR suggestion reasons name the models and nothing else', () => {
  assert.equal(ocrSourceAttribution('Manga OCR', 'Hy-MT2 1.8B Manga v5'), 'Manga OCR · Hy-MT2 1.8B Manga v5');
  assert.equal(ocrSourceAttribution('Hayai OCR v2', 'Hayai OCR v2'), 'Hayai OCR v2');
  assert.equal(ocrSourceAttribution('PaddleOCR-VL-1.6'), 'PaddleOCR-VL-1.6');
  assert.equal(
    compactSuggestionReason('AI Review · Manga OCR: Transcription by Manga OCR. English translation by Hy-MT2 1.8B Manga v5 from that transcription alone. This OCR model does not assess uncertainty; inspect the crop before accepting.'),
    'AI Review · Manga OCR · Hy-MT2 1.8B Manga v5',
  );
  assert.equal(
    compactSuggestionReason('Hayai OCR v2: Independent OCR transcription. English is from Sugoi v4 Ja→En from this transcription alone. OCR readings do not agree. Run AI Review with the council manually, or choose/edit a reading.'),
    'Hayai OCR v2 · Sugoi v4 Ja→En',
  );
  assert.equal(
    compactSuggestionReason('AI Review · Manga OCR · Hy-MT2 1.8B Manga v5'),
    'AI Review · Manga OCR · Hy-MT2 1.8B Manga v5',
  );
});

test('specialist reviews preserve the original reading even if the translator proposes a correction', async () => {
  const source = '匠～\nさっきのさぁ あれって！';
  const result = await reviewOcrSource('Hayai OCR v2', async () => source, async input => {
    assert.equal(input, source);
    return { source: 'Invented correction', translation: 'Takumi, about that earlier…' };
  }, new AbortController().signal);
  assert.equal(result.suggestions[0].text, source);
  assert.equal(result.suggestions[0].translation, 'Takumi, about that earlier…');
  assert.match(result.answer, /Hayai OCR v2 · /);
  assert.equal(result.suggestions[0].reason, result.answer);
});

test('empty OCR does not invoke a translator, and cancellation prevents further inference', async () => {
  const unexpected = async () => { throw new Error('Translator must not run'); };
  assert.deepEqual((await reviewOcrSource('PaddleOCR-VL', async () => '', unexpected,
    new AbortController().signal)).suggestions, []);
  const controller = new AbortController();
  await assert.rejects(reviewOcrSource('Hayai', async () => {
    controller.abort();
    return '안녕';
  }, unexpected, controller.signal), { name: 'AbortError' });
});

test('specialist reviews reject missing or malformed English instead of making an incomplete paired suggestion', async () => {
  for (const value of [null, {}, { translation: '' }, { translation: 42 }]) {
    await assert.rejects(reviewOcrSource('Hayai', async () => '안녕', async () => value,
      new AbortController().signal), /no English translation/);
  }
});

test('CPU reviews run sequentially and cancelled queued requests never start', async () => {
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = withLocalReview(async () => { events.push('first'); await gate; events.push('done'); });
  await Promise.resolve();
  const controller = new AbortController();
  const cancelled = withLocalReview(async () => { events.push('cancelled'); }, controller.signal);
  const rejection = assert.rejects(cancelled, { name: 'AbortError' });
  controller.abort();
  await rejection;
  const last = withLocalReview(async () => { events.push('last'); });
  assert.deepEqual(events, ['first']);
  release();
  await Promise.all([first, last]);
  assert.deepEqual(events, ['first', 'done', 'last']);
  stopLocalReviewModels();
});

test('a local review started inside another shares its slot instead of waiting on itself', async () => {
  const controller = new AbortController();
  let innerSignal: AbortSignal | undefined;
  const result = await Promise.race([
    withLocalReview(async outer => withLocalReview(async inner => {
      innerSignal = inner;
      return `nested ${outer.aborted}`;
    }), controller.signal),
    new Promise(resolve => setTimeout(() => resolve('deadlock'), 2000)),
  ]);
  assert.equal(result, 'nested false');
  controller.abort();
  assert.equal(innerSignal?.aborted, true, 'cancelling the outer review cancels the nested one');
  const after = withLocalReview(async () => 'queue still moves');
  assert.equal(await after, 'queue still moves');
  stopLocalReviewModels();
});

test('resident inference tokens are read from llama-server and Hayai argv', async () => {
  const { aliasFromArgs, flagValue } = await import('../src/lib/server/residentInference');
  assert.equal(flagValue(['--api-key', 'secret-one', '--port', '18080'], ['--api-key', '--token']), 'secret-one');
  assert.equal(flagValue(['--token', 'hayai-token'], ['--api-key', '--token']), 'hayai-token');
  assert.equal(flagValue(['--api-key=inline'], ['--api-key']), 'inline');
  assert.equal(flagValue(['--host', '127.0.0.1'], ['--api-key', '--token']), '');
  assert.equal(aliasFromArgs(['--alias', 'paddleocr-vl-1.6', '--api-key', 'secret']), 'paddleocr-vl-1.6');
  assert.equal(aliasFromArgs(['-a', 'qwen3.8-27b-q4', '--port', '18081']), 'qwen3.8-27b-q4');
  assert.equal(aliasFromArgs(['/usr/bin/python', 'ocr/hayai_review.py', '--token', 'x']), 'hayai-ocr-v2');
  assert.equal(aliasFromArgs(['/usr/bin/python', 'ocr/manga_ocr_review.py', '--token', 'x']), 'manga-ocr');
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test('review servers refuse a chat model on the OCR port and recover a live API key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scan-review-lifecycle-'));
  const fake = join(root, 'fake-llama.mjs');
  const prev = {
    SCAN_ROOT: process.env.SCAN_ROOT,
    SCAN_GPU_MODE: process.env.SCAN_GPU_MODE,
    SCAN_REVIEW_MODELS_DIR: process.env.SCAN_REVIEW_MODELS_DIR,
    SCAN_REVIEW_PYTHON: process.env.SCAN_REVIEW_PYTHON,
    SCAN_REVIEW_LLAMA_SERVER: process.env.SCAN_REVIEW_LLAMA_SERVER,
    SCAN_REVIEW_PADDLE_PORT: process.env.SCAN_REVIEW_PADDLE_PORT,
    SCAN_REVIEW_QWEN_PORT: process.env.SCAN_REVIEW_QWEN_PORT,
    SCAN_REVIEW_HAYAI_PORT: process.env.SCAN_REVIEW_HAYAI_PORT,
  };
  const paddlePort = await freePort();
  const qwenPort = await freePort();
  const hayaiPort = await freePort();
  const files = {
    'hayai-ocr-v2': ['model.safetensors', 'config.json', 'modeling_hayai.py', 'configuration_hayai.py', 'tokenizer.json'],
    'paddleocr-vl-1.6': ['PaddleOCR-VL-1.6-GGUF.gguf', 'PaddleOCR-VL-1.6-GGUF-mmproj.gguf', 'chat_template.jinja'],
    'qwen3-vl-8b': ['Qwen3-VL-8B-Instruct-Q8_0.gguf', 'mmproj-F16.gguf'],
  };
  await writeFile(fake, `#!${process.execPath}
import {createServer} from 'node:http';
const args=process.argv.slice(2).filter(a=>!String(a).endsWith('.py'));
const flag=n=>args.includes(n)?args[args.indexOf(n)+1]:'';
const port=Number(flag('--port'));
const token=flag('--api-key')||flag('--token');
const alias=flag('--alias')||flag('-a')||'hayai-ocr-v2';
createServer((req,res)=>{
  res.setHeader('content-type','application/json');
  const auth=req.headers.authorization==='Bearer '+token;
  if(req.url==='/health'){
    if(alias==='hayai-ocr-v2' && !auth){res.statusCode=401;return res.end(JSON.stringify({error:'Unauthorized'}));}
    return res.end(JSON.stringify({status:'ok',model:alias}));
  }
  if(req.url==='/v1/models') return res.end(JSON.stringify({data:[{id:alias}]}));
  if(!auth){res.statusCode=401;return res.end(JSON.stringify({error:{message:'Invalid API Key',type:'authentication_error',code:401}}));}
  if(req.url==='/ocr') return res.end(JSON.stringify({source:'안녕'}));
  res.end(JSON.stringify({choices:[{message:{content:'안녕'}}]}));
}).listen(port,'127.0.0.1');
`, { mode: 0o755 });
  const occupant = spawn(process.execPath, [fake, '-a', 'qwen3.8-27b-q4', '--port', String(paddlePort), '--api-key', 'qwen-secret'], { detached: true, stdio: 'ignore' });
  occupant.unref();
  const waitListen = async (port: number) => {
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(200) });
        if (res.ok) return;
      } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`fake server on ${port} did not start`);
  };
  Object.assign(process.env, {
    SCAN_ROOT: root,
    SCAN_GPU_MODE: 'komatose',
    SCAN_REVIEW_MODELS_DIR: join(root, 'models'),
    SCAN_REVIEW_PYTHON: fake,
    SCAN_REVIEW_LLAMA_SERVER: fake,
    SCAN_REVIEW_PADDLE_PORT: String(paddlePort),
    SCAN_REVIEW_QWEN_PORT: String(qwenPort),
    SCAN_REVIEW_HAYAI_PORT: String(hayaiPort),
  });
  const globalState = (globalThis as typeof globalThis & { __scanLocalReview?: { services: Map<string, unknown>; lifecycle: Map<string, unknown>; starting: Map<string, unknown> } }).__scanLocalReview;
  try {
    await waitListen(paddlePort);
    for (const [id, names] of Object.entries(files)) {
      await mkdir(join(root, 'models', id), { recursive: true });
      for (const name of names) await writeFile(join(root, 'models', id, name), 'fixture');
    }
    await writeFile(join(root, 'models', 'installed.json'), JSON.stringify(Object.fromEntries(Object.keys(files).map(id => [id, true]))));
    globalState?.services.clear();
    globalState?.lifecycle.clear();
    globalState?.starting.clear();

    const statuses = await listReviewServerStatuses();
    const paddle = statuses.find((row) => row.id === 'paddleocr-vl-1.6');
    assert.equal(paddle?.state, 'error');
    assert.match(paddle?.error || '', /qwen3\.8-27b-q4/);
    assert.match(paddle?.error || '', /18080|SCAN_LLM_PORT/);
    await assert.rejects(
      localTranscription('paddleocr-vl-1.6', Buffer.from('jpeg'), new AbortController().signal, 'korean'),
      /qwen3\.8-27b-q4/,
    );
    operateReviewServer('paddleocr-vl-1.6', 'stop');
    await waitReviewOperation('paddleocr-vl-1.6');
    assert.equal(occupant.exitCode, null, 'stop must not kill a chat model on the review port');

    try { process.kill(occupant.pid!, 'SIGKILL'); } catch { /* already gone */ }
    for (let i = 0; i < 30 && occupant.exitCode === null && occupant.signalCode === null; i++)
      await new Promise((r) => setTimeout(r, 50));

    operateReviewServer('paddleocr-vl-1.6', 'start');
    await waitReviewOperation('paddleocr-vl-1.6');
    const running = (await listReviewServerStatuses()).find((row) => row.id === 'paddleocr-vl-1.6');
    assert.equal(running?.state, 'running');
    assert.equal(running?.served, 'paddleocr-vl-1.6');
    assert.equal(
      await localTranscription('paddleocr-vl-1.6', Buffer.from('jpeg'), new AbortController().signal, 'korean'),
      '안녕',
    );

    const { writeSavedToken } = await import('../src/lib/server/residentInference');
    writeSavedToken('paddleocr-vl-1.6', 'stale-token-from-killed-process');
    globalState?.services.delete('paddleocr-vl-1.6');
    assert.equal(
      await localTranscription('paddleocr-vl-1.6', Buffer.from('jpeg'), new AbortController().signal, 'korean'),
      '안녕',
    );

    operateReviewServer('paddleocr-vl-1.6', 'stop');
    await waitReviewOperation('paddleocr-vl-1.6');
    const stopped = (await listReviewServerStatuses()).find((row) => row.id === 'paddleocr-vl-1.6');
    assert.equal(stopped?.state, 'stopped');
  } finally {
    try { if (occupant.pid) process.kill(occupant.pid, 'SIGKILL'); } catch { /* gone */ }
    stopLocalReviewModels();
    try {
      operateReviewServer('paddleocr-vl-1.6', 'stop');
      await waitReviewOperation('paddleocr-vl-1.6');
    } catch { /* not running */ }
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('a managed Qwen3-VL row serves the review path too — one model, one server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scan-review-managed-'));
  const fake = join(root, 'fake-llama.mjs');
  const log = join(root, 'calls.jsonl');
  const prev = {
    SCAN_ROOT: process.env.SCAN_ROOT,
    SCAN_DATA_DIR: process.env.SCAN_DATA_DIR,
    SCAN_GPU_MODE: process.env.SCAN_GPU_MODE,
    SCAN_REVIEW_MODELS_DIR: process.env.SCAN_REVIEW_MODELS_DIR,
    SCAN_REVIEW_PYTHON: process.env.SCAN_REVIEW_PYTHON,
    SCAN_REVIEW_LLAMA_SERVER: process.env.SCAN_REVIEW_LLAMA_SERVER,
    SCAN_REVIEW_QWEN_PORT: process.env.SCAN_REVIEW_QWEN_PORT,
  };
  const managedPort = await freePort();
  let reviewPort = await freePort();
  while (reviewPort === managedPort) reviewPort = await freePort();
  await writeFile(fake, `#!${process.execPath}
import {createServer} from 'node:http';
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2).filter(a=>!String(a).endsWith('.py'));
const flag=n=>args.includes(n)?args[args.indexOf(n)+1]:'';
const port=Number(flag('--port'));
const token=flag('--api-key')||flag('--token');
const alias=flag('--alias')||flag('-a')||'hayai-ocr-v2';
createServer((req,res)=>{
  appendFileSync(${JSON.stringify(log)}, port+'\\t'+req.url+'\\n');
  res.setHeader('content-type','application/json');
  if(req.url==='/health') return res.end(JSON.stringify({status:'ok',model:alias}));
  if(req.url==='/v1/models') return res.end(JSON.stringify({data:[{id:alias}]}));
  if(token && req.headers.authorization!=='Bearer '+token){
    res.statusCode=401;
    return res.end(JSON.stringify({error:{message:'Invalid API Key',type:'authentication_error',code:401}}));
  }
  res.end(JSON.stringify({choices:[{message:{content:'안녕'}}]}));
}).listen(port,'127.0.0.1');
`, { mode: 0o755 });
  Object.assign(process.env, {
    SCAN_ROOT: root,
    SCAN_DATA_DIR: join(root, 'data'),
    SCAN_GPU_MODE: 'komatose',
    SCAN_REVIEW_MODELS_DIR: join(root, 'models'),
    SCAN_REVIEW_PYTHON: fake,
    SCAN_REVIEW_LLAMA_SERVER: fake,
    SCAN_REVIEW_QWEN_PORT: String(reviewPort),
  });
  await mkdir(join(root, 'models', 'qwen3-vl-8b'), { recursive: true });
  for (const name of ['Qwen3-VL-8B-Instruct-Q8_0.gguf', 'mmproj-F16.gguf'])
    await writeFile(join(root, 'models', 'qwen3-vl-8b', name), 'fixture');
  await writeFile(join(root, 'models', 'installed.json'), JSON.stringify({ 'qwen3-vl-8b': true }));
  const globalState = (globalThis as typeof globalThis & { __scanLocalReview?: { services: Map<string, unknown>; lifecycle: Map<string, unknown>; starting: Map<string, unknown> } }).__scanLocalReview;
  globalState?.services.clear();
  globalState?.lifecycle.clear();
  globalState?.starting.clear();
  // The launch the Qwen3-VL 8B install writes onto the one seeded reader row.
  const store = await import('../src/lib/server/modelRegistryStore');
  const reader = store.findRegistryRow('qwen3-vl-8b')!;
  store.upsertRegistryRow({ ...reader, managedLaunch: {
    preset: 'generic' as const,
    executable: fake,
    modelPath: join(root, 'models', 'qwen3-vl-8b', 'Qwen3-VL-8B-Instruct-Q8_0.gguf'),
    projectorPath: join(root, 'models', 'qwen3-vl-8b', 'mmproj-F16.gguf'),
    port: managedPort,
    device: 'cpu',
    contextSize: 16384,
    gpuLayers: 0,
    slots: 2,
    startOnBoot: false,
    extraArgs: [],
  } });
  try {
    // The review path rides the managed server instead of starting a second copy.
    assert.equal(await localChat('qwen3-vl-8b', [{ role: 'user', content: 'hi' }], new AbortController().signal), '안녕');
    const calls = (await readFile(log, 'utf8')).trim().split('\n');
    assert.ok(calls.some((line) => line.startsWith(`${managedPort}\t/v1/chat/completions`)), 'the managed server served the read');
    assert.ok(!calls.some((line) => line.startsWith(`${reviewPort}\t`)), 'no second copy of the weights was started');

    // The model is listed once — as the managed model, not also a review service.
    const statuses = await listReviewServerStatuses();
    assert.ok(!statuses.some((item) => item.id === 'qwen3-vl-8b'));

    // And the Setup stop button stops that managed model.
    operateReviewServer('qwen3-vl-8b', 'stop');
    await waitReviewOperation('qwen3-vl-8b');
    const { managedModelStatus } = await import('../src/lib/server/managedModels');
    assert.equal(managedModelStatus(store.findRegistryRow('qwen3-vl-8b')!).state, 'stopped');
  } finally {
    stopLocalReviewModels();
    try {
      operateReviewServer('qwen3-vl-8b', 'stop');
      await waitReviewOperation('qwen3-vl-8b');
    } catch { /* not running */ }
    store.upsertRegistryRow({ ...store.findRegistryRow('qwen3-vl-8b')!, managedLaunch: null });
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
