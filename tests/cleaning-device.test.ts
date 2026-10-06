import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eligibleCleaningDevices, type BackendInfo } from '../src/lib/server/localWorker';

test('resident Big LaMa remains on GPU when its weights reduce free VRAM', () => {
  const resident = { id: 'cuda:0', name: 'GPU', backend: 'ROCm', free: 1024 ** 3, total: 8 * 1024 ** 3 };
  const info: BackendInfo = { devices: [resident], errors: [], cpu: true, sam: true,
    bigLama: true, koharu: true, bigLamaDevice: resident.id };
  assert.deepEqual(eligibleCleaningDevices(info, 'big-lama'), [resident]);
  assert.deepEqual(eligibleCleaningDevices(info, 'auto'), [resident]);
  assert.deepEqual(eligibleCleaningDevices(info, 'aot'), []);
  assert.deepEqual(eligibleCleaningDevices({ ...info, bigLamaDevice: null }, 'big-lama'), []);
});

test('resident native LaMa Manga stays on its GPU when free VRAM drops', () => {
  const resident = { id: 'cuda:1', name: 'GPU', backend: 'ROCm', free: 1024 ** 3, total: 8 * 1024 ** 3 };
  const info: BackendInfo = { devices: [resident], errors: [], cpu: true, sam: true,
    bigLama: true, koharu: false, lamaDevice: resident.id };
  assert.deepEqual(eligibleCleaningDevices(info, 'lama'), [resident]);
  assert.deepEqual(eligibleCleaningDevices({ ...info, lamaDevice: null }, 'lama'), []);
});
