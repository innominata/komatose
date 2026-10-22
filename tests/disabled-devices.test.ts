import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'komatose-devices-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.SCAN_REVIEW_LLAMA_SERVER = join(root, 'no-llama-server');
delete process.env.SCAN_REVIEW_PYTHON;

const card = (index: number, bus: string, totalMiB: number, integrated = false) => ({
	name: `cuda:${index}`, index, label: integrated ? 'AMD Radeon Graphics' : 'AMD Radeon RX 7900 XTX',
	backend: 'rocm' as const, totalMiB, integrated, pdev: `0000:${bus}:00`,
});
// Seed the cached probes so no Python or llama-server runs.
(globalThis as any).__komatoseHardware = {
	ggml: { at: Date.now() + 3_600_000, bin: process.env.SCAN_REVIEW_LLAMA_SERVER, devices: [] },
	torch: new Map([['env-review', {
		env: 'env-review', path: '', backend: 'rocm', at: Date.now(),
		devices: [card(0, '03', 24560), card(1, '07', 24560), card(2, '12', 512, true)],
	}]]),
	torchPending: new Map(),
};

const { resolveDevice, setDeviceDisabled, disabledDevices } = await import('../src/lib/server/computeDevices');
const { deviceOptions } = await import('../src/lib/computeDevices');

test('a turned-off card is never chosen, by Auto or by hand, and comes back when turned on', () => {
	const auto = () => resolveDevice('torch', 'auto', 1024, { env: 'env-review' });
	assert.equal(auto().kind === 'gpu' && auto().name, 'cuda:1', 'Auto takes the largest discrete card');

	setDeviceDisabled('0000:07:00.0', true);
	assert.deepEqual([...disabledDevices()], ['0000:07:00']);
	assert.equal(auto().kind === 'gpu' && auto().name, 'cuda:0');

	const pinned = resolveDevice('torch', 'cuda:1', 1024, { env: 'env-review' });
	assert.equal(pinned.kind === 'gpu' && pinned.name, 'cuda:0', 'a model pinned to the card falls back to Auto');
	assert.match(pinned.reason, /turned off; using Auto/);

	setDeviceDisabled('0000:03:00', true);
	assert.equal(auto().kind, 'cpu', 'with both discrete cards off, Auto never falls back to the iGPU');

	setDeviceDisabled('0000:12:00', true);
	const hw: any = { llama: { devices: [] }, torch: [{ env: 'env-review', devices: [card(0, '03', 24560), card(2, '12', 512, true)] }], disabled: [...disabledDevices()] };
	assert.deepEqual(deviceOptions('torch', hw, 'env-review').map((option) => option.value), ['auto', 'cpu'], 'pickers hide turned-off cards');

	setDeviceDisabled('0000:07:00', false);
	setDeviceDisabled('0000:03:00', false);
	assert.equal(auto().kind === 'gpu' && auto().name, 'cuda:1');
});
