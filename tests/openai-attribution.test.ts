import assert from 'node:assert/strict';
import test from 'node:test';
import { appAttributionHeaders } from '../src/lib/server/openaiHttp';

test('OpenRouter requests name Komatose; other endpoints get no extra headers', () => {
	assert.equal(appAttributionHeaders('https://openrouter.ai/api/v1')['X-Title'], 'Komatose');
	assert.deepEqual(appAttributionHeaders('https://api.deepseek.com/v1'), {});
	assert.deepEqual(appAttributionHeaders('http://127.0.0.1:8081/v1'), {});
	assert.deepEqual(appAttributionHeaders('not a url'), {});
});
