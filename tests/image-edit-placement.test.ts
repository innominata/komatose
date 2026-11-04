import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placeImageEditModules, type ImageEditDeviceBudget } from '../src/lib/server/imageEdit';

/** Qwen-Image-Edit 2511 Q4 diffusion, Q5 text encoder + mmproj, bf16 VAE. */
const qwen = { diffusion: 12631, te: 6484, vae: 242 };

const cards = (free: { igpu: number; gpu1: number; gpu2: number }): ImageEditDeviceBudget[] => [
	{ name: 'Vulkan0', freeMiB: free.igpu, integrated: true },
	{ name: 'Vulkan1', freeMiB: free.gpu1, integrated: false },
	{ name: 'Vulkan2', freeMiB: free.gpu2, integrated: false },
];

test('overflow from a busy card goes to the empty discrete GPU, not the iGPU', () => {
	// GPU 1 held the diffusion model; GPU 2 was empty; the iGPU reported the most free memory.
	const plan = placeImageEditModules('Vulkan1', qwen, cards({ igpu: 27931, gpu1: 17807, gpu2: 24491 }));
	assert.equal(plan.backend, 'diffusion=Vulkan1,vae=Vulkan1,te=Vulkan2');
	assert.equal(plan.maxVram, 'Vulkan0=-1024');
});

test('a card with room keeps the diffusion model, text encoder, and VAE together', () => {
	const plan = placeImageEditModules('Vulkan2', qwen, cards({ igpu: 27931, gpu1: 17807, gpu2: 24491 }));
	assert.equal(plan.backend, 'diffusion=Vulkan2,vae=Vulkan2,te=Vulkan2');
	assert.equal(plan.maxVram, 'Vulkan0=-1024');
});

test('an iGPU is never a spill target just because it reports the most memory', () => {
	const plan = placeImageEditModules('Vulkan2', qwen, cards({ igpu: 40000, gpu1: 20000, gpu2: 5000 }));
	assert.equal(plan.backend.includes('Vulkan0'), false);
	assert.equal(plan.backend, 'diffusion=Vulkan1,vae=Vulkan2,te=Vulkan2');
	assert.equal(plan.maxVram, 'Vulkan0=-1024');
});

test('choosing the iGPU keeps it, and does not hide that card', () => {
	const plan = placeImageEditModules('Vulkan0', qwen, cards({ igpu: 27931, gpu1: 1000, gpu2: 1000 }));
	assert.equal(plan.backend, 'diffusion=Vulkan0,vae=Vulkan0,te=Vulkan0');
	assert.equal(plan.maxVram, '');
});

test('a module that fits on no card stays on the chosen one', () => {
	const plan = placeImageEditModules('Vulkan2', qwen, cards({ igpu: 27669, gpu1: 8895, gpu2: 4724 }));
	assert.equal(plan.backend.startsWith('diffusion=Vulkan2'), true);
	assert.equal(plan.backend.includes('Vulkan0'), false);
	assert.equal(plan.maxVram, 'Vulkan0=-1024');
});

test('a module that fits nowhere runs on the CPU when the chosen card has no room to compute', () => {
	// FLUX 3 Klein on a card another program had filled; GPU 2 took the diffusion model and VAE.
	const flux = { diffusion: 5866, te: 4076, vae: 320 };
	const plan = placeImageEditModules('Vulkan1', flux, cards({ igpu: 28612, gpu1: 96, gpu2: 12290 }));
	assert.equal(plan.backend, 'diffusion=Vulkan2,vae=Vulkan2,te=cpu');
	assert.equal(plan.maxVram, 'Vulkan0=-1024');
});

test('a rejected edit is explained from the sd-server log', async () => {
	const { editFailureReason } = await import('../src/lib/server/imageEdit');
	const log = '[W] model manager cannot make enough memory available on Vulkan1: need 909.25 MB device / 397.25 MB budget, available 96.50 MB device / unlimited budget\n[E] failed to encode prompt';
	assert.match(editFailureReason('flux-3-image-klein', 'x', log), /^Vulkan1 is out of memory: an edit needs 909 MB and only 97 MB is free/);
	assert.match(editFailureReason('flux-3-image-klein', 'x', '[E] failed to encode prompt'), /text encoder could not run/);
	assert.equal(editFailureReason('flux-3-image-klein', 'The local image editor returned HTTP 500: busy', ''), 'Edits fail: HTTP 500: busy');
});

test('GPU memory from DRM fdinfo counts each client once per card', async () => {
	const { parseDrmFdinfo } = await import('../src/lib/server/computeDevices');
	const fd = (client: number, pdev: string, kib: number) => `drm-driver:\tamdgpu\ndrm-client-id:\t${client}\ndrm-pdev:\t${pdev}\ndrm-memory-vram:\t${kib} KiB\n`;
	const used = parseDrmFdinfo([fd(1, '0000:03:00.0', 2048 * 1024), fd(1, '0000:03:00.0', 2048 * 1024), fd(2, '0000:07:00.0', 1024)]);
	assert.equal(used.get('0000:03:00'), 2048);
	assert.equal(used.get('0000:07:00'), 1);
});
