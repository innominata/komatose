import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
	CLI_PROVIDER_IDS,
	PROVIDER_CATALOG,
	PROVIDER_IDS,
	isProofreaderProvider,
	isCliProvider,
	isKnownProvider,
	providerById,
	providerSupports,
	providersForOperation,
	selectProvidersForOperation,
	providerRunGate,
} from '../src/lib/providerCatalog';
import { enginesForRegionAiField, REGION_AI_FIELD_OPERATIONS } from '../src/lib/regionAi';
import { TRANSLATE_ENGINE_LABELS, TRANSLATE_ENGINES, isPageImageOnlyEngine, textEngines } from '../src/lib/types';
import { CLI_TRANSLATION_ENGINES } from '../src/lib/server/translationTask';
import { assertGeneralModel, translationModel } from '../src/lib/translationModels';
import { proofreaderLabel } from '../src/lib/proofreaders';
import { localReviewModel } from '../src/lib/localReviewModels';

const live = [
	{ id: 'qwen', label: 'Qwen · GPU', available: true, operations: ['translate', 'describe', 'vision', 'advisory', 'sourceReview', 'pageImageProofread'] },
	{ id: 'grok', label: 'Grok CLI', available: true, operations: ['translate', 'describe', 'vision', 'advisory', 'sourceReview', 'pageImageProofread'] },
	{ id: 'codex', label: 'Codex CLI', available: false, reason: 'CLI executable not found', operations: ['translate', 'describe', 'vision'] },
	{ id: 'cursor', label: 'Cursor CLI', available: true, operations: ['translate', 'describe', 'vision', 'advisory', 'sourceReview', 'pageImageProofread'] },
	{ id: 'proofreader-a', label: 'Proofreader A', available: true, reason: 'Tab connected', operations: ['pageImageProofread'] },
	{ id: 'proofreader-b', label: 'Proofreader B', available: true, reason: 'Tab connected', operations: ['pageImageProofread'] },
];

test('catalog lists only the existing providers and matches types.ts exports', () => {
	assert.deepEqual([...PROVIDER_IDS], ['qwen', 'grok', 'codex', 'cursor', 'proofreader-a', 'proofreader-b']);
	assert.deepEqual(TRANSLATE_ENGINES, [...PROVIDER_IDS]);
	assert.equal(TRANSLATE_ENGINE_LABELS['proofreader-a'], providerById('proofreader-a')?.label);
	assert.equal(TRANSLATE_ENGINE_LABELS['proofreader-b'], providerById('proofreader-b')?.label);
	assert.equal(TRANSLATE_ENGINE_LABELS.qwen, 'Local HTTP');
	assert.equal(PROVIDER_CATALOG.length, 6);
	assert.equal(isKnownProvider('qwen'), true);
	assert.equal(isKnownProvider('claude'), false);
	assert.equal(providerById('unknown'), undefined);
	assert.equal(providerSupports('unknown', 'translate'), false);
	assert.equal(isCliProvider('unknown'), false);
	assert.equal(isProofreaderProvider('unknown'), false);
});

test('CLI classification is derived from catalog transport, not a second ID list', () => {
	assert.deepEqual(CLI_PROVIDER_IDS, ['grok', 'codex', 'cursor']);
	assert.deepEqual([...CLI_TRANSLATION_ENGINES], [...CLI_PROVIDER_IDS]);
	assert.equal(isCliProvider('grok'), true);
	assert.equal(isCliProvider('codex'), true);
	assert.equal(isCliProvider('cursor'), true);
	assert.equal(isCliProvider('qwen'), false);
	assert.equal(isCliProvider('proofreader-a'), false);
	assert.equal(isCliProvider('proofreader-b'), false);
	assert.equal(isProofreaderProvider('proofreader-a'), true);
	assert.equal(isProofreaderProvider('proofreader-b'), true);
	assert.equal(isPageImageOnlyEngine('proofreader-a'), true);
	assert.equal(isPageImageOnlyEngine('proofreader-b'), true);
	assert.equal(isPageImageOnlyEngine('qwen'), false);
	assert.deepEqual(textEngines(live).map((engine) => engine.id), ['qwen', 'grok', 'codex', 'cursor']);
});

test('transport catalog cannot establish task capabilities', () => {
  for (const id of PROVIDER_IDS) {
    assert.equal(providerSupports(id, 'translate'), false);
    assert.equal(providerSupports(id, 'pageImageProofread'), false);
  }
  assert.deepEqual(providersForOperation('vision'), []);
  assert.equal(REGION_AI_FIELD_OPERATIONS.reviewers, 'sourceReview');
});

test('specialist and local OCR models are not providers, and their tests decide their tasks', () => {
	assert.equal(isKnownProvider('hy-mt2-manga-v5'), false);
	assert.equal(isKnownProvider('imsbee-ko-en-translator'), false);
	assert.equal(providerSupports('hy-mt2-manga-v5', 'vision'), false);
	assert.ok(translationModel('hy-mt2-manga-v5'));
	assert.ok(translationModel('imsbee-ko-en-translator'));
	assert.throws(() => assertGeneralModel('hy-mt2-manga-v5'), /text translation model/);
	const jobs = [
		{ id: 'qwen', label: 'Qwen', available: true, operations: ['translate', 'describe', 'vision', 'advisory', 'proofreadEnglish'] },
		{ id: 'hy-mt2-manga-v5', label: 'Hy-MT', available: true, operations: ['translate'] },
	];
	assert.equal(enginesForRegionAiField('translate', jobs).some((engine) => engine.id === 'hy-mt2-manga-v5' && engine.available), true);
	for (const field of ['describe', 'vision', 'proofread', 'enquire', 'reviewers'] as const) {
		assert.equal(enginesForRegionAiField(field, jobs).some((engine) => engine.id === 'hy-mt2-manga-v5'), false, field);
	}
	const passedDescribe = [
		{ id: 'hy-mt2-manga-v5', label: 'Hy-MT', available: true, operations: ['translate', 'describe'] },
	];
	assert.equal(enginesForRegionAiField('describe', passedDescribe).some((engine) => engine.id === 'hy-mt2-manga-v5' && engine.available), true);
	assert.equal(enginesForRegionAiField('describe', jobs, 'hy-mt2-manga-v5').some((engine) => engine.id === 'hy-mt2-manga-v5' && !engine.available), true);
	assert.ok(localReviewModel('hayai-ocr-v2'));
	assert.equal(isKnownProvider('hayai-ocr-v2'), false);
});

test('an unsupported saved selection stays visible and is not replaced', () => {
	const describe = enginesForRegionAiField('describe', live, 'proofreader-a');
	assert.deepEqual(describe.map((engine) => engine.id), ['qwen', 'grok', 'codex', 'cursor', 'proofreader-a']);
	const saved = describe.find((engine) => engine.id === 'proofreader-a');
	assert.equal(saved?.available, false);
	assert.match(saved?.reason || '', /current passing test/);
	assert.equal(live.find((engine) => engine.id === 'proofreader-a')?.available, true);

	const validDescribe = enginesForRegionAiField('describe', live, 'qwen');
	assert.deepEqual(validDescribe.map((engine) => engine.id), ['qwen', 'grok', 'codex', 'cursor']);

	const proofread = enginesForRegionAiField('proofread', live, 'proofreader-a');
	assert.ok(proofread.some((engine) => engine.id === 'proofreader-a' && engine.available === true));
	assert.ok(proofread.some((engine) => engine.id === 'proofreader-b' && engine.available === true));

	const missingSupported = enginesForRegionAiField(
		'proofread',
		live.filter((engine) => engine.id !== 'proofreader-a'),
		'proofreader-a',
		[],
	);
	assert.equal(missingSupported.at(-1)?.id, 'proofreader-a');
	assert.equal(missingSupported.at(-1)?.available, false);
	assert.equal(missingSupported.at(-1)?.label, proofreaderLabel('proofreader-a'));
	assert.match(missingSupported.at(-1)?.reason || '', /current passing test/i);

	const unknown = selectProvidersForOperation(live, 'translate', 'claude');
	assert.equal(unknown.at(-1)?.id, 'claude');
	assert.equal(unknown.at(-1)?.available, false);
	assert.match(unknown.at(-1)?.reason || '', /Unknown provider/);
});

test('settings field mapping keeps live availability for supported providers', () => {
	const vision = enginesForRegionAiField('vision', live, 'codex');
	assert.equal(vision.find((engine) => engine.id === 'codex')?.available, false);
	assert.equal(vision.find((engine) => engine.id === 'codex')?.reason, 'CLI executable not found');
	assert.equal(vision.find((engine) => engine.id === 'qwen')?.label, 'Qwen · GPU');
	assert.ok(!vision.some((engine) => engine.id === 'proofreader-a'));
	assert.ok(!vision.some((engine) => engine.id === 'proofreader-b'));

	const reviewers = enginesForRegionAiField(
		'reviewers',
		live.filter((engine) => engine.id !== 'proofreader-a'),
		'proofreader-a',
		live,
	);
	assert.equal(reviewers.at(-1)?.id, 'proofreader-a');
	assert.equal(reviewers.at(-1)?.available, false);
});

test('run gates require evidence and separate readiness from capabilities', () => {
  assert.equal(providerRunGate('proofreader-a', 'translate', live).ok, false);
  assert.equal(providerRunGate('proofreader-a', 'pageImageProofread').ok, false);
  assert.equal(providerRunGate('proofreader-a', 'pageImageProofread', live).ok, true);
  assert.equal(providerRunGate('codex', 'translate', live).ok, true);
  assert.equal(providerRunGate('', 'translate', live).ok, false);
});

test('live registry operations let custom rows be selected and gated', () => {
	const snapshot = [
		{ id: 'review-qualified', label: 'Review Qualified', available: true, operations: ['translate', 'advisory'], access: 'remote_http' },
		{ id: 'vision-only-remote', label: 'Vision Only', available: true, operations: ['vision'], access: 'remote_http' },
		{ id: 'turned-off', label: 'Turned Off', available: false, operations: ['translate'], reason: 'Disabled' },
	];
	const translate = selectProvidersForOperation(snapshot, 'translate');
	assert.ok(translate.some((engine) => engine.id === 'review-qualified' && engine.available === true));
	assert.ok(!translate.some((engine) => engine.id === 'vision-only-remote'));
	assert.equal(translate.find((engine) => engine.id === 'turned-off')?.available, false);

	const savedVision = selectProvidersForOperation(snapshot, 'translate', 'vision-only-remote');
	assert.equal(savedVision.some((engine) => engine.id === 'vision-only-remote' && !engine.available), true);

	assert.equal(providerRunGate('review-qualified', 'translate').ok, false);
	assert.match(providerRunGate('review-qualified', 'translate').reason, /Unknown provider/);
	assert.equal(providerRunGate('review-qualified', 'translate', snapshot).ok, true);
	assert.equal(providerRunGate('vision-only-remote', 'translate', snapshot).ok, false);

	const enquire = enginesForRegionAiField('enquire', snapshot, 'review-qualified');
	assert.ok(enquire.some((engine) => engine.id === 'review-qualified' && engine.available === true));
});

test('Region AI settings and translation picker use the catalog field helper', () => {
	const settings = readFileSync(new URL('../src/lib/components/RegionAiSettings.svelte', import.meta.url), 'utf8');
	const translation = readFileSync(new URL('../src/lib/components/TranslationModelPicker.svelte', import.meta.url), 'utf8');
	assert.match(settings, /enginesForRegionAiField/);
	assert.match(settings, /fieldEngines\("describe"/);
	assert.match(settings, /fieldEngines\("vision"/);
	assert.match(settings, /fieldEngines\("proofread"/);
	assert.match(settings, /fieldEngines\("enquire"/);
	assert.match(settings, /fieldEngines\("reviewers"/);
	assert.match(translation, /enginesForRegionAiField\(\s*'translate'/);
	assert.match(settings, /engines=\{enginesSnapshot\}/);
	assert.match(settings, /lockEngineList/);
	assert.doesNotMatch(settings, /textEngines/);
});
