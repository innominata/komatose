import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	assignTorchPdevs,
	cardLabel,
	deviceOptions,
	gpuNumbers,
	gpuTitles,
	pciKey,
	shownDevice,
	type HardwareSnapshot,
	type TorchDevice,
} from '../src/lib/computeDevices';

const llama = [
	{ name: 'Vulkan0', label: 'AMD Ryzen 9 7950X', backend: 'vulkan' as const, totalMiB: 31437, freeMiB: 28000, integrated: true, pdev: '0000:12:00' },
	{ name: 'Vulkan1', label: 'AMD Radeon RX 7900 XTX', backend: 'vulkan' as const, totalMiB: 24560, freeMiB: 1000, integrated: false, pdev: '0000:03:00' },
	{ name: 'Vulkan2', label: 'AMD Radeon RX 7900 XTX', backend: 'vulkan' as const, totalMiB: 24560, freeMiB: 20000, integrated: false, pdev: '0000:07:00' },
];
const torch: TorchDevice[] = [
	{ name: 'cuda:0', index: 0, label: 'AMD Ryzen 9 7950X 16-Core Processor', backend: 'rocm', totalMiB: 31437, integrated: true },
	{ name: 'cuda:1', index: 1, label: 'AMD Radeon Graphics (gfx1100, bus 3)', backend: 'rocm', totalMiB: 24560, integrated: false },
	{ name: 'cuda:2', index: 2, label: 'AMD Radeon Graphics (gfx1100, bus 7)', backend: 'rocm', totalMiB: 24560, integrated: false },
];

function snapshot(devices = assignTorchPdevs(torch, llama)): HardwareSnapshot {
	return {
		cpu: { model: 'cpu', cores: 1 },
		ram: { totalMiB: 1, freeMiB: 1 },
		llama: { bin: 'llama', found: true, devices: llama },
		imageServer: { bin: 'sd', found: true },
		torch: [{ env: 'env-workflow', path: '.venv', backend: 'rocm', devices, at: 0 }],
		usage: [],
		nvidia: false,
		rocm: true,
		at: 0,
	};
}

test('PCI keys line up a lspci address with PyTorch bus numbers', () => {
	assert.equal(pciKey('0000:03:00.0'), '0000:03:00');
	assert.equal(pciKey({ domain: 0, bus: 3, device: 0 }), '0000:03:00');
	assert.equal(pciKey({ bus: 18 }), '0000:12:00');
	assert.equal(pciKey('not a bus'), '');
});

test('GPU numbers follow PCI address order and are shared by both runtimes', () => {
	const numbers = gpuNumbers(['0000:12:00.0', '0000:03:00.0', '0000:07:00']);
	assert.equal(numbers.get('0000:03:00'), 1);
	assert.equal(numbers.get('0000:07:00'), 2);
	assert.equal(numbers.get('0000:12:00'), 3);

	const hw = snapshot();
	const titles = gpuTitles(hw);
	assert.equal(titles.get('Vulkan1'), 'GPU 1');
	assert.equal(titles.get('cuda:1'), 'GPU 1');
	assert.equal(titles.get('Vulkan2'), 'GPU 2');
	assert.equal(titles.get('cuda:2'), 'GPU 2');
	assert.equal(titles.get('Vulkan0'), 'GPU 3');
	assert.equal(titles.get('cuda:0'), 'GPU 3');
	assert.equal(shownDevice(hw, 'Vulkan2 · AMD Radeon RX 7900 XTX'), 'GPU 2');
	assert.equal(cardLabel('AMD Radeon Graphics (gfx1100, bus 3)'), 'AMD Radeon Graphics (gfx1100)');
});

test('device pickers list GPU 1 before the iGPU for both llama and PyTorch', () => {
	const hw = snapshot();
	const llamaOptions = deviceOptions('llama', hw).filter((option) => option.value !== 'auto' && option.value !== 'cpu');
	const torchOptions = deviceOptions('torch', hw, 'env-workflow').filter((option) => option.value !== 'auto' && option.value !== 'cpu');
	assert.deepEqual(llamaOptions.map((option) => option.label), ['GPU 1', 'GPU 2', 'GPU 3']);
	assert.deepEqual(torchOptions.map((option) => option.label), ['GPU 1', 'GPU 2', 'GPU 3']);
	assert.equal(llamaOptions[0].value, 'Vulkan1');
	assert.equal(torchOptions[0].value, 'cuda:1');
	assert.match(torchOptions[0].detail || '', /gfx1100/);
	assert.equal((torchOptions[0].detail || '').includes('bus 3'), false);
});
