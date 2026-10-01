import assert from 'node:assert/strict';
import { test } from 'node:test';
import { effectiveTranslateModel } from '../src/lib/regionAi';
import { singleAvailableEngineFor } from '../src/lib/providerCatalog';
import type { LiveProviderEngine } from '../src/lib/providerCatalog';

const CHAT = ['translate', 'vision', 'describe', 'proofreadEnglish'];

function engine(id: string, extra: Partial<LiveProviderEngine> = {}): LiveProviderEngine {
	return { id, label: id, available: true, operations: CHAT, ...extra };
}

test('the single available translator becomes the default', () => {
	const engines = [
		engine('qwen3.8-27b-q4', { available: false, reason: 'Endpoint not responding' }),
		engine('hy-mt2-manga-v5', { operations: ['translate'] }),
		engine('hayai-ocr-v2', { operations: ['vision'], available: false }),
	];
	const result = effectiveTranslateModel(undefined, engines);
	assert.equal(result.engine, 'hy-mt2-manga-v5');
});

test('several available translators keep the saved default', () => {
	const engines = [
		engine('qwen3.8-27b-q4', { available: false }),
		engine('hy-mt2-manga-v5', { operations: ['translate'] }),
		engine('grok-4.6', { operations: CHAT, access: 'cli' }),
	];
	const result = effectiveTranslateModel({ engine: 'qwen3.8-27b-q4', model: '' }, engines);
	assert.deepEqual(result, { engine: 'qwen3.8-27b-q4', model: '' });
});

test('an available saved choice is never flipped away', () => {
	const engines = [
		engine('qwen3.8-27b-q4'),
		engine('hy-mt2-manga-v5', { operations: ['translate'] }),
	];
	const result = effectiveTranslateModel({ engine: 'qwen3.8-27b-q4', model: '' }, engines);
	assert.equal(result.engine, 'qwen3.8-27b-q4');
});

test('the one available translator keeps a saved model override', () => {
	const engines = [engine('hy-mt2-manga-v5', { operations: ['translate'] })];
	const result = effectiveTranslateModel({ engine: 'hy-mt2-manga-v5', model: 'custom' }, engines);
	assert.deepEqual(result, { engine: 'hy-mt2-manga-v5', model: 'custom' });
});

test('no available translator keeps the saved default instead of inventing one', () => {
	const engines = [
		engine('qwen3.8-27b-q4', { available: false }),
		engine('hy-mt2-manga-v5', { operations: ['translate'], available: false }),
	];
	const result = effectiveTranslateModel({ engine: 'qwen3.8-27b-q4', model: '' }, engines);
	assert.deepEqual(result, { engine: 'qwen3.8-27b-q4', model: '' });
	assert.deepEqual(
		effectiveTranslateModel({ engine: 'qwen3.8-27b-q4', model: '' }, []),
		{ engine: 'qwen3.8-27b-q4', model: '' },
	);
});

test('page-image proofreaders do not count as translators', () => {
	const engines = [
		engine('qwen3.8-27b-q4', { available: false }),
		engine('proofreader-a', { operations: ['pageImageProofread'], pageImageOnly: true }),
	];
	const result = effectiveTranslateModel({ engine: 'qwen3.8-27b-q4', model: '' }, engines);
	assert.equal(result.engine, 'qwen3.8-27b-q4');
});

test('singleAvailableEngineFor returns the one available engine for the operation', () => {
	const engines = [
		engine('qwen3.8-27b-q4', { available: false, reason: 'Endpoint not responding' }),
		engine('grok-4.6', { operations: ['chapterReview'] }),
		engine('gpt-5.4', { operations: ['chapterReview'], available: false }),
	];
	assert.equal(singleAvailableEngineFor(engines, 'chapterReview'), 'grok-4.6');
	// The single review model is not also a translator: only the unavailable
	// chat model can translate.
	assert.equal(singleAvailableEngineFor(engines, 'translate'), undefined);
});

test('two available engines for one operation leave the default alone', () => {
	const engines = [
		engine('grok-4.6', { operations: ['chapterReview'] }),
		engine('gpt-5.4', { operations: ['chapterReview'] }),
	];
	assert.equal(singleAvailableEngineFor(engines, 'chapterReview'), undefined);
});

test('specialists and proofreaders are never the single review default', () => {
	const engines = [
		engine('hy-mt2-manga-v5', { operations: ['translate'] }),
		engine('proofreader-a', { operations: ['pageImageProofread'], pageImageOnly: true }),
	];
	assert.equal(singleAvailableEngineFor(engines, 'chapterReview'), undefined);
});

test('unavailable explicit translator is preserved', () => {
 const saved = {engine:'missing-reader',model:'saved-revision'};
 assert.deepEqual(effectiveTranslateModel(saved, [engine('available')]), saved);
});
