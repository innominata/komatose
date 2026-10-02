import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mmprojDeviceEnv } from '../src/lib/server/gpuMode';

test('projector device follows the designated card and is cleared for CPU', () => {
	const pinned = mmprojDeviceEnv({ MTMD_BACKEND_DEVICE: 'Vulkan1', PATH: '/bin' }, 'Vulkan2');
	assert.equal(pinned.MTMD_BACKEND_DEVICE, 'Vulkan2');
	assert.equal(pinned.PATH, '/bin');

	const cpu = mmprojDeviceEnv({ MTMD_BACKEND_DEVICE: 'Vulkan1' }, undefined);
	assert.equal('MTMD_BACKEND_DEVICE' in cpu, false);

	const none = mmprojDeviceEnv({}, 'none');
	assert.equal('MTMD_BACKEND_DEVICE' in none, false);
});
