import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maintainPythonRuntime, withPythonRuntime } from '../src/lib/server/pythonRuntimeMaintenance';
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
test('runtime maintenance drains accepted work, holds new work, and permits nested calls', async () => {
  let finish!: () => void;
  const blocker = new Promise<void>(resolve => { finish = resolve; });
  let accepted = false;
  const first = withPythonRuntime('test-drain', async () => {
    accepted = true;
    await blocker;
    return withPythonRuntime('test-drain', async () => 7);
  });
  assert.equal(accepted, true);
  let entered = false;
  const maintenance = maintainPythonRuntime('test-drain');
  const second = withPythonRuntime('test-drain', async () => { entered = true; });
  await tick();
  assert.equal(entered, false);
  finish();
  assert.equal(await first, 7);
  const release = await maintenance;
  assert.equal(entered, false);
  release(); await second;
  assert.equal(entered, true);
});
test('cancelled maintenance releases held work without interrupting accepted work', async () => {
  let finish!: () => void;
  const first = withPythonRuntime('test-cancel', () => new Promise<void>(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const maintenance = maintainPythonRuntime('test-cancel', controller.signal);
  controller.abort();
  await assert.rejects(maintenance);
  const second = withPythonRuntime('test-cancel', async () => 9);
  assert.equal(await second, 9);
  finish(); await first;
});

test('split ROCm launcher omits automatic architecture spoofing and preserves explicit overrides', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { hipWorkerEnv } = await import('../src/lib/server/gpuMode');
  const directory = await mkdtemp(join(tmpdir(), 'komatose-runtime-'));
  try {
    await mkdir(join(directory, 'bin'));
    await writeFile(join(directory, '.komatose-runtime.json'), JSON.stringify({ plan: { profile: 'rocm-split-10.0.0' } }));
    const python = join(directory, 'bin/python');
    assert.equal(hipWorkerEnv({}, python).HSA_OVERRIDE_GFX_VERSION, undefined);
    assert.equal(hipWorkerEnv({ HSA_OVERRIDE_GFX_VERSION: '12.0.0' }, python).HSA_OVERRIDE_GFX_VERSION, '12.0.0');
    assert.equal(hipWorkerEnv({}).HSA_OVERRIDE_GFX_VERSION, '11.0.0');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
