/** Real GPU smoke test. Uses an isolated data directory and an owned temporary server. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
const data = process.env.SCAN_DATA_DIR || join(process.cwd(), 'data');
const runtime = process.env.SCAN_DECIDER_RUNTIME_DIR || join(data, 'runtimes/llama-decider');
const models = join(process.env.SCAN_DECIDER_MODELS_DIR || join(data, 'models/deciders'), 'd1-3b');
const scratch = await mkdtemp(join(tmpdir(), 'komatose-d1-smoke-'));
process.env.SCAN_DATA_DIR = scratch;
process.env.DATABASE_URL = join(scratch, 'smoke.db');
const socket = createServer();
await new Promise<void>(r => socket.listen(0, '127.0.0.1', r));
const port = (socket.address() as { port: number }).port;
await new Promise<void>(r => socket.close(() => r()));
const device = process.argv[2] || 'Vulkan2';
const env = { ...process.env, GGML_VK_ALLOW_GRAPHICS_QUEUE: '1', GGML_VK_DISABLE_FUSION: '1', MTMD_BACKEND_DEVICE: device, LD_LIBRARY_PATH: `${join(runtime, 'build/bin')}:${process.env.LD_LIBRARY_PATH || ''}` };
for (const key of Object.keys(env)) if (key.startsWith('LLAMA_ARG_')) delete (env as Record<string, string | undefined>)[key];
const child = spawn(join(runtime, 'build/bin/llama-server'), ['-m', join(models, 'd1-3B-Q8_0.gguf'),
  '--mmproj', join(models, 'mmproj-d1-3B-F16.gguf'), '-a', 'd1-3b', '--host', '127.0.0.1', '--port', String(port),
  '--device', device, '-ngl', '999', '-c', '8192', '-np', '1', '--log-verbose'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-1024 * 1024); });
child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-1024 * 1024); });
let spawnError: Error | undefined;
let passed = false;
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
  const { VISION_PROBE_JPEG } = await import('../src/lib/server/fixtures/visionProbe');
  const { invokeDecider } = await import('../src/lib/server/transcriptionDecider');
  const { probeModelRow } = await import('../src/lib/server/modelProbe');
  const row = { id: 'd1-3b', name: 'Liquid AI d1-3B Q8', slug: 'd1-3b', access: 'local_http' as const,
    http: { baseUrl, apiKeyEnv: '' }, operations: ['sourceDecide' as const], roles: ['admin' as const], seeded: false, operationsLocked: false };
  const first = await invokeDecider(row, { jpeg: VISION_PROBE_JPEG, lang: 'japanese',
    candidates: [{ id: 'A', source: '待って' }, { id: 'B', source: '持って' }] }, AbortSignal.timeout(60_000));
  console.log('Japanese crop decision:', JSON.stringify(first));
  assert.ok(Object.keys(first.probabilities).length === 4, 'Expected validated candidate/abstention probabilities');
  const reversed = await invokeDecider(row, { jpeg: VISION_PROBE_JPEG, lang: 'japanese',
    candidates: [{ id: 'A', source: '持って' }, { id: 'B', source: '待って' }] }, AbortSignal.timeout(60_000));
  console.log('Reversed labels:', JSON.stringify(reversed));
  const probe = await probeModelRow(row, 'sourceDecide');
  console.log('Two-order integration check:', JSON.stringify(probe));
  console.log(probe.ok ? 'OCR qualification passed.' : `OCR qualification failed; keep this model gated: ${probe.reason}`);
  if (process.argv.includes('--require-qualified')) assert.equal(probe.ok, true, probe.reason);
  assert.match(logs, /offloaded \d+\/\d+ layers to GPU/);
  assert.match(logs, /AMD Radeon RX 7900 XTX/);
  console.log('GPU offload confirmed on', device);
  passed = true;
} catch (e) {
  await writeFile(join(scratch, 'server.log'), logs);
  console.error('Smoke log:', join(scratch, 'server.log'));
  throw e;
} finally {
  if (child.exitCode === null && child.signalCode === null && !spawnError) {
    const closed = new Promise<void>(r => child.once('close', () => r()));
    child.kill('SIGTERM');
    const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await closed;
    clearTimeout(killer);
  }
  if (passed) await rm(scratch, { recursive: true, force: true });
}
