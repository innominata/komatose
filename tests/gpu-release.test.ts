import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectGpuServices, mayKillGpuProcess, residentControl, runningGpuStops } from '../src/lib/gpuRelease';

const services = collectGpuServices({
	rows: [
		{ id: 'qwen3.8-27b-q4', name: 'Qwen 3.8 27B', slug: 'qwen3.8-27b-q4', managedLaunch: {}, managed: { state: 'running', pid: 10 } },
		{ id: 'gemma4-e2b', name: 'Gemma 4 E2B', slug: 'gemma4-e2b', managedLaunch: {}, managed: { state: 'running', pid: 11 } },
		{ id: 'idle-chat', name: 'Idle', slug: 'idle', managedLaunch: {}, managed: { state: 'stopped' } },
	],
	reviewServers: [{ id: 'hayai-ocr-v2', label: 'Hayai OCR', state: 'running', pid: 12 }],
	editors: [
		{ id: 'qwen-image-edit-2511', label: 'Qwen-Image-Edit 2511', state: 'running', pid: 14 },
		{ id: 'qwen-image-edit-2511-lightning', label: 'Qwen-Image-Edit Lightning', state: 'running', pid: 14 },
	],
	workers: [
		{ id: 'cleaning-worker', label: 'Cleaning worker', running: true, pid: 13 },
		{ id: 'ocr-worker', label: 'OCR worker', running: false },
		{ id: 'translation-worker', label: 'Translation worker', running: true, pid: 15, detail: 'Hy-MT2' },
	],
});

test('every running GPU model can stop, including Qwen 3.8 27B', () => {
	assert.deepEqual(
		runningGpuStops(services).map((service) => service.id),
		['qwen3.8-27b-q4', 'gemma4-e2b', 'hayai-ocr-v2', 'qwen-image-edit-2511', 'cleaning-worker', 'translation-worker'],
	);
});

test('a GPU card can stop Qwen, workers, and other residents', () => {
	assert.deepEqual(residentControl({ pid: 10, label: 'Qwen 3.8 27B' }, services), { stop: { kind: 'managed', id: 'qwen3.8-27b-q4' } });
	assert.deepEqual(residentControl({ pid: 13, label: 'Cleaning worker' }, services), { stop: { kind: 'worker', id: 'cleaning-worker' } });
	assert.deepEqual(residentControl({ pid: 99, label: 'OCR worker' }, services), { stop: { kind: 'worker', id: 'ocr-worker' } });
	assert.deepEqual(residentControl({ pid: 77, label: 'hayai_review' }, []), { stop: { kind: 'pid', id: '77' } });
	assert.deepEqual(residentControl({ label: 'Other' }, services), {});
});

test('only Komatose GPU processes can be signalled', () => {
	assert.equal(mayKillGpuProcess(13, 'Cleaning worker', '/www/komatose/.venv-workflow/bin/python /www/komatose/ocr/workflow.py'), true);
	assert.equal(mayKillGpuProcess(10, 'qwen3.8-27b-q4', 'llama-server -m /models/Qwen3.8-27B.gguf -a qwen3.8-27b-q4 --api-key secret'), true);
	assert.equal(mayKillGpuProcess(5, 'plasmashell', '/usr/bin/plasmashell'), false);
	assert.equal(mayKillGpuProcess(1, 'llama-server', '', 1), false);
});
