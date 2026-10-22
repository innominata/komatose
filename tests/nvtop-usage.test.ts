import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectResidents, describeGpuCommand, formatResidentMemory, nameResidents } from '../src/lib/gpuResidents';
import { parseNvtopSnapshot, vulkanNamesByPdev } from '../src/lib/server/nvtopSnapshot';

const TOKEN = 'secret-token-should-not-leak';

test('command descriptions never keep the command line', () => {
	const hayai = describeGpuCommand(
		`/www/komatose/.venv-review/bin/python /www/komatose/ocr/hayai_review.py --port 18083 --token ${TOKEN}`,
	);
	assert.equal(hayai.label, 'Hayai OCR');
	assert.equal(hayai.detail, '.venv-review');
	assert.equal(hayai.kind, 'venv');
	assert.equal(JSON.stringify(hayai).includes(TOKEN), false);

	const editor = describeGpuCommand(
		'/home/inno/stable-diffusion.cpp/build-vulkan/bin/sd-server --diffusion-model /models/qwen-image-edit-2511/qwen-image-edit-2511-Q4_K_M.gguf --listen-port 18092',
	);
	assert.equal(editor.label, 'Qwen-Image-Edit');
	assert.equal(editor.kind, 'edit');

	const chat = describeGpuCommand('/home/inno/llama.cpp/build-vulkan/bin/llama-server -m /models/qwen.gguf -a qwen3.8-27b-q4 --api-key ' + TOKEN);
	assert.equal(chat.label, 'qwen3.8-27b-q4');
	assert.equal(JSON.stringify(chat).includes(TOKEN), false);
});

test('small desktop processes collapse into Other and Komatose processes stay separate', () => {
	const residents = collectResidents([
		{ pid: 1, cmdline: '/www/komatose/.venv-review/bin/python /www/komatose/ocr/hayai_review.py', vramBytes: 0.95 * 1024 ** 3, gttBytes: 0 },
		{ pid: 2, cmdline: '/www/komatose/.venv-review/bin/python /www/komatose/ocr/manga_ocr_review.py', vramBytes: 0.94 * 1024 ** 3, gttBytes: 0 },
		{ pid: 3, cmdline: '/usr/bin/plasmashell', vramBytes: 8 * 1024 ** 2, gttBytes: 200 * 1024 ** 2 },
		{ pid: 4, cmdline: 'sd-server --diffusion-model /models/qwen-image-edit-2511/model.gguf', vramBytes: 12.3 * 1024 ** 3, gttBytes: 6.2 * 1024 ** 3 },
	]);
	assert.deepEqual(
		residents.map((item) => item.label),
		['Qwen-Image-Edit', 'Hayai OCR', 'Manga OCR', 'Other'],
	);
	const editor = residents[0];
	assert.equal(formatResidentMemory(editor), '12 GB · 6.2 GB system');
	assert.equal(residents.at(-1)?.kind, 'other');
});

test('two editors that share a pid stay one line, and a venv keeps its environment name', () => {
	const named = nameResidents(
		[
			{ pid: 9, label: 'Qwen-Image-Edit', kind: 'edit', vramMiB: 12_600, gttMiB: 0 },
			{ pid: 4, label: 'Hayai OCR', detail: '.venv-review', kind: 'venv', vramMiB: 970, gttMiB: 0 },
		],
		[
			{ pid: 9, label: 'Qwen-Image-Edit 2511', kind: 'edit' },
			{ pid: 9, label: 'Qwen-Image-Edit 2511 Lightning', kind: 'edit' },
			{ pid: 4, label: 'Hayai OCR v2', kind: 'ocr' },
		],
	);
	assert.equal(named[0].label, 'Qwen-Image-Edit');
	assert.equal(named[1].label, 'Hayai OCR v2');
	assert.equal(named[1].detail, '.venv-review');
	assert.equal(named[1].kind, 'venv');
});

test('Vulkan devices pair with render nodes by integrated, size and memory in use', () => {
	const names = vulkanNamesByPdev(
		[
			{ minor: 130, pdev: '0000:07:00.0' },
			{ minor: 128, pdev: '0000:12:00.0' },
			{ minor: 129, pdev: '0000:03:00.0' },
		],
		[{ name: 'Vulkan0' }, { name: 'Vulkan1' }, { name: 'Vulkan2' }],
	);
	assert.equal(names.get('0000:12:00.0'), 'Vulkan0');
	assert.equal(names.get('0000:03:00.0'), 'Vulkan1');
	assert.equal(names.get('0000:07:00.0'), 'Vulkan2');

	// RADV lists the iGPU first even though its render node is last; identical cards split by memory in use.
	const measured = vulkanNamesByPdev(
		[
			{ minor: 128, pdev: '0000:03:00.0', totalMiB: 24560, usedMiB: 24204 },
			{ minor: 129, pdev: '0000:07:00.0', totalMiB: 24560, usedMiB: 15501 },
			{ minor: 130, pdev: '0000:12:00.0', totalMiB: 512, usedMiB: 364 },
		],
		[
			{ name: 'Vulkan0', integrated: true, totalMiB: 31945, freeMiB: 30936 },
			{ name: 'Vulkan1', integrated: false, totalMiB: 24560, freeMiB: 355 },
			{ name: 'Vulkan2', integrated: false, totalMiB: 24560, freeMiB: 9058 },
		],
	);
	assert.equal(measured.get('0000:12:00.0'), 'Vulkan0');
	assert.equal(measured.get('0000:03:00.0'), 'Vulkan1');
	assert.equal(measured.get('0000:07:00.0'), 'Vulkan2');

	const parsed = parseNvtopSnapshot(`noise\n[{"pdev":"0000:07:00.0","integrated":false,"mem_total":"25753026560","mem_used":"16591138816","processes":[{"pid":"9","cmdline":"sd-server --diffusion-model /m/qwen-image-edit-2511/w.gguf --token ${TOKEN}","gpu_mem_bytes_alloc":"13244198912","gpu_gtt_bytes":"10485760"}]}]`);
	assert.equal(parsed[0]?.pdev, '0000:07:00.0');
	assert.equal(parsed[0]?.processes?.[0]?.cmdline?.includes(TOKEN), true);
	const residents = collectResidents(
		(parsed[0]?.processes || []).map((proc) => ({
			pid: Number(proc.pid),
			cmdline: proc.cmdline || '',
			vramBytes: Number(proc.gpu_mem_bytes_alloc),
			gttBytes: Number(proc.gpu_gtt_bytes),
		})),
	);
	assert.equal(JSON.stringify(residents).includes(TOKEN), false);
	assert.equal(residents[0]?.label, 'Qwen-Image-Edit');

	const foreign = collectResidents([
		{ pid: 5, cmdline: '/home/u/Strata/engine/strata --serve --pack /home/u/packs/iq2_xs --key secret', vramBytes: 23957 * 1048576, gttBytes: 0 },
		{ pid: 6, cmdline: '/usr/bin/Hyprland', vramBytes: 174 * 1048576, gttBytes: 0 },
	]);
	assert.deepEqual(foreign.map((item) => [item.label, item.kind, item.detail]), [['Strata', 'foreign', 'iq2_xs'], ['Other', 'other', undefined]]);
});
