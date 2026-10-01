import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = await mkdtemp(join(tmpdir(), 'scan-retired-rows-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.DATABASE_URL = join(root, 'data', 'test.db');
mkdirSync(join(root, 'data'), { recursive: true });

const { RETIRED_SEED_IDS, mergeRegistry, ALL_SEED_ROWS } = await import('../src/lib/modelRegistry');
const { modelsOverlayPath, listRegistryRows } = await import('../src/lib/server/modelRegistryStore');

after(() => rm(root, { recursive: true, force: true }));

test('a pre-upgrade overlay naming a removed seed row cannot resurrect it', () => {
	// Exactly what an older install holds: the rows this build stopped seeding,
	// including the chat-model recipes an operator never chose on this machine.
	const legacy = {
		rows: [
			{ id: 'chatgpt', name: 'ChatGPT (browser tab)', slug: 'chatgpt', access: 'browser', operations: ['pageImageProofread'], seeded: true, operationsLocked: true, roles: ['admin'] },
			{ id: 'deepseek', name: 'DeepSeek (browser tab)', slug: 'deepseek', access: 'browser', operations: ['pageImageProofread'], seeded: true, operationsLocked: true, roles: ['admin'] },
			{ id: 'qwen3.8-27b-q4', name: 'Qwen 3.8 27B', slug: 'qwen3.8-27b-q4', access: 'local_http', operations: ['translate'], seeded: true, roles: ['admin'], managedLaunch: { preset: 'qwen38', executable: '~//llama.cpp/build-vulkan/bin/llama-server', modelPath: '~//models/qwen.gguf', port: 18080, device: 'Vulkan1', contextSize: 131072, gpuLayers: 999, slots: 1, startOnBoot: true, extraArgs: [] } },
			{ id: 'gemma-4-26b-a4b-it', name: 'Gemma 4 26B A4B', slug: 'gemma-4-26b-a4b-it', access: 'local_http', operations: ['translate'], seeded: true, roles: ['admin'], managedLaunch: { preset: 'gemma4', executable: '~//llama.cpp/build-vulkan/bin/llama-server', modelPath: '~//models/gemma.gguf', port: 18086, device: 'Vulkan1', contextSize: 131072, gpuLayers: 999, slots: 1, startOnBoot: false, extraArgs: [] } },
			{ id: 'my-remote', name: 'My Remote', slug: 'my-remote', access: 'remote_http', operations: ['translate'], roles: ['admin'] },
		],
	};

	const merged = mergeRegistry(legacy as never);
	for (const id of RETIRED_SEED_IDS) {
		assert.equal(merged.some((row) => row.id === id), false, `${id} must not be recreated`);
		assert.equal(ALL_SEED_ROWS.some((row) => row.id === id), false, `${id} must not be seeded`);
	}
	// An unrelated user row is untouched.
	assert.ok(merged.some((row) => row.id === 'my-remote'));

	// Writing it to disk and loading must prune the file, not just filter in memory.
	writeFileSync(modelsOverlayPath(), JSON.stringify(legacy, null, 2));
	const loaded = listRegistryRows(true);
	for (const id of RETIRED_SEED_IDS) {
		assert.equal(loaded.some((row) => row.id === id), false, `${id} must not load`);
	}
	assert.ok(loaded.some((row) => row.id === 'my-remote'));
	const onDisk = JSON.parse(readFileSync(modelsOverlayPath(), 'utf8')) as { rows: Array<{ id: string; managedLaunch?: { executable?: string } }> };
	assert.deepEqual(onDisk.rows.map((row) => row.id), ['my-remote']);
	// The retired recipes carried this machine's home; pruning drops them whole.
	assert.ok(!readFileSync(modelsOverlayPath(), 'utf8').includes('/home/'));
});
