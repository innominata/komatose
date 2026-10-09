/** Controlled d1 diagnostics: image/text language, simple vision, OCR and CPU/GPU comparison. */
import sharp from 'sharp';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
const data = process.env.SCAN_DATA_DIR || join(process.cwd(), 'data');
const runtime = process.env.SCAN_DECIDER_RUNTIME_DIR || join(data, 'runtimes/llama-decider');
const models = join(process.env.SCAN_DECIDER_MODELS_DIR || join(data, 'models/deciders'), 'd1-3b');
const scratch = await mkdtemp(join(tmpdir(), 'komatose-d1-diagnostic-'));
process.env.SCAN_DATA_DIR = scratch;
process.env.DATABASE_URL = join(scratch, 'smoke.db');
const socket = createServer();
await new Promise<void>(r => socket.listen(0, '127.0.0.1', r));
const port = (socket.address() as { port: number }).port;
await new Promise<void>(r => socket.close(() => r()));
const device = process.argv[2] || 'Vulkan2';
const cpu = device === 'CPU';
const env = { ...process.env, GGML_VK_ALLOW_GRAPHICS_QUEUE: '1', GGML_VK_DISABLE_FUSION: '1', MTMD_BACKEND_DEVICE: device, LD_LIBRARY_PATH: `${join(runtime, 'build/bin')}:${process.env.LD_LIBRARY_PATH || ''}` };
for (const key of Object.keys(env)) if (key.startsWith('LLAMA_ARG_')) delete (env as Record<string, string | undefined>)[key];
if (cpu) delete (env as Record<string, string | undefined>).MTMD_BACKEND_DEVICE;
const child = spawn(join(runtime, 'build/bin/llama-server'), ['-m', join(models, 'd1-3B-Q8_0.gguf'),
  '--mmproj', join(models, 'mmproj-d1-3B-F16.gguf'), '-a', 'd1-3b', '--host', '127.0.0.1', '--port', String(port),
  '--device', cpu ? 'none' : device, '-ngl', cpu ? '0' : '999', '-c', '8192', '-np', '1', '--log-verbose', ...(cpu ? ['--no-mmproj-offload'] : [])], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-1024 * 1024); });
child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-1024 * 1024); });
let spawnError: Error | undefined;
child.on('error', error => { spawnError = error; });
try {
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const deadline = Date.now() + 300_000;
  while (true) {
    if (spawnError) throw spawnError;
    if (child.exitCode != null) throw new Error(`Server exited ${child.exitCode}: ${logs.slice(-5000)}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`Server did not become ready: ${logs.slice(-5000)}`);
    await new Promise(r => setTimeout(r, 250));
  }

  const results: any[] = [];
  const texts = [
    { name: 'japanese-kana', text: 'こんにちは', expected: 'Japanese' },
    { name: 'japanese-kanji-kana', text: '待ってください', expected: 'Japanese' },
    { name: 'korean-greeting', text: '안녕하세요', expected: 'Korean' },
    { name: 'korean-wait', text: '기다려 주세요', expected: 'Korean' },
    { name: 'english-greeting', text: 'HELLO THERE', expected: 'English' },
    { name: 'english-wait', text: 'PLEASE WAIT', expected: 'English' },
  ];
  const render = async (inner: string) => sharp(Buffer.from(`<svg width="800" height="300" xmlns="http://www.w3.org/2000/svg"><rect width="800" height="300" fill="white"/>${inner}</svg>`)).jpeg({ quality: 95 }).toBuffer();
  const language = ['Japanese', 'Korean', 'English', 'No readable text'];
  const choices = (values: string[]) => Object.fromEntries(values.map((value, index) => [String.fromCharCode(65 + index), value]));
  const ask = async (name: string, state: any, image: Buffer | undefined, instructions: string, values: string[], expected: string) => {
    const criteria = choices(values);
    const response = await fetch(`${baseUrl}/systemone`, { method: 'POST', headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(cpu ? 120_000 : 30_000), body: JSON.stringify({ state,
        ...(image ? { images: [`data:image/jpeg;base64,${image.toString('base64')}`] } : {}),
        questions: { test: { type: 'choice', instructions, criteria } } }) });
    const payload = await response.json();
    if (!response.ok || !payload.answers?.test) throw new Error(JSON.stringify(payload));
    const answer = payload.answers.test;
    const selected = criteria[answer.choice];
    const record = { name, expected, selected, correct: selected === expected,
      probabilities: Object.fromEntries(Object.entries(answer.probabilities).map(([key, p]) => [criteria[key], p])), usage: payload.usage };
    results.push(record);
    console.log(JSON.stringify(record));
  };
  for (const item of texts) {
    const jpeg = await render(`<text x="400" y="180" text-anchor="middle" font-family="Noto Sans CJK JP" font-size="80" fill="black">${item.text}</text>`);
    await writeFile(join(scratch, `${item.name}.jpg`), jpeg);
    await ask(`text-state:${item.name}`, item.text, undefined, 'What language is this text written in?', language, item.expected);
    const orders = cpu ? [language] : [language, [...language.slice(1), language[0]], [...language].reverse()];
    for (const [i, order] of orders.entries())
      await ask(`image-language:${item.name}:order${i}`, null, jpeg, 'What language is the text visible in this image written in?', order, item.expected);
    await ask(`image-has-text:${item.name}`, null, jpeg, 'Is there visible text in this image?', ['There is text', 'There is no text'], 'There is text');
  }
  const blank = await render('');
  await ask('blank-has-text', null, blank, 'Is there visible text in this image?', ['There is text', 'There is no text'], 'There is no text');
  await ask('blank-language', null, blank, 'What language is the text visible in this image written in?', language, 'No readable text');
  for (const colour of ['red', 'blue', 'green']) {
    const jpeg = await render(`<rect x="150" y="40" width="500" height="220" fill="${colour}"/>`);
    await ask(`colour:${colour}`, null, jpeg, 'What is the colour of the large rectangle?', ['Red', 'Blue', 'Green'], colour[0].toUpperCase() + colour.slice(1));
  }
  for (const shape of ['circle', 'square']) {
    const jpeg = await render(shape === 'circle' ? '<circle cx="400" cy="150" r="100" fill="black"/>' : '<rect x="300" y="50" width="200" height="200" fill="black"/>');
    await ask(`shape:${shape}`, null, jpeg, 'What shape is visible?', ['A circle', 'A square'], `A ${shape}`);
  }
  const { VISION_PROBE_JPEG } = await import('../src/lib/server/fixtures/visionProbe');
  await ask('original-probe-language', null, VISION_PROBE_JPEG, 'What language is the text visible in this image written in?', language, 'Japanese');
  for (const [name, values] of [
    ['japanese-exact-two', ['待って', '持って']],
    ['japanese-obvious-two', ['待って', 'こんにちは']],
    ['japanese-vs-english', ['待って', 'HELLO']],
    ['japanese-exact-abstentions', ['待って', '持って', 'None of these candidates matches', 'The text is too unclear']],
  ] as const) await ask(name, null, VISION_PROBE_JPEG, 'Which transcription matches the text visible in the image?', [...values], '待って');
  const totals = Object.fromEntries(['text-state:', 'image-language:', 'image-has-text:', 'colour:', 'shape:', 'japanese-'].map(prefix => {
    const group = results.filter(r => r.name.startsWith(prefix));
    return [prefix, { correct: group.filter(r => r.correct).length, total: group.length }];
  }));
  await writeFile(join(scratch, 'results.json'), JSON.stringify({ device, totals, results }, null, 2));
  await writeFile(join(scratch, 'server.log'), logs);
  console.log('TOTALS', JSON.stringify(totals));
  console.log('Artifacts:', scratch);
  console.log('GPU offload:', /offloaded 31\/31 layers to GPU/.test(logs));

} catch (e) {
  await writeFile(join(scratch, 'server.log'), logs);
  console.error('Diagnostic log:', join(scratch, 'server.log'));
  throw e;
} finally {
  if (child.exitCode === null && child.signalCode === null && !spawnError) {
    const closed = new Promise<void>(r => child.once('close', () => r()));
    child.kill('SIGTERM');
    const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await closed;
    clearTimeout(killer);
  }
  // Retain generated controls and machine-readable results for inspection.
}
