import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
	allDetectorSetups,
	clampDetectConf,
	detectorSetupId,
	detectorSetupLabel,
	parseDetectorSetup,
} from '../src/lib/detectorSetup';

const root = await mkdtemp(join(tmpdir(), 'scan-detector-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
delete process.env.SCAN_DETECT_CONF;

const { detectorDefaults, resolveDetector, saveDetectorDefaults } = await import('../src/lib/server/detectorConfig');
const { putDoc } = await import('../src/lib/server/workflowStore');

after(() => rm(root, { recursive: true, force: true }));

test('setup ids round-trip and reject nonsense', () => {
	assert.deepEqual(parseDetectorSetup('ctd+sam-ts-l'), { base: 'ctd', coo: false, samTsL: true });
	assert.deepEqual(parseDetectorSetup('paddle+coo+sam-ts-l'), { base: 'paddle', coo: true, samTsL: true });
	assert.equal(detectorSetupId({ base: 'rtdetr', coo: true, samTsL: true }), 'rtdetr+coo+sam-ts-l');
	assert.deepEqual(parseDetectorSetup('sam-ts-l'), { base: 'sam-ts-l', coo: false, samTsL: false });
	assert.deepEqual(parseDetectorSetup('yolo'), { base: 'yolo', coo: false, samTsL: false });
	// Setups saved before the rename spell the SAM-TS-L add-on `koharu`.
	assert.deepEqual(parseDetectorSetup('rtdetr+koharu'), { base: 'rtdetr', coo: false, samTsL: true });
	assert.equal(detectorSetupId(parseDetectorSetup('ctd+coo+koharu')!), 'ctd+coo+sam-ts-l');
	assert.equal(parseDetectorSetup('ctd+koharu+sam-ts-l'), undefined);
	for (const bad of ['', 'ctd+ctd', 'heuristic+sam-ts-l', 'ctd+nope', '../yolo', 'bad id', null]) {
		assert.equal(parseDetectorSetup(bad), undefined, String(bad));
	}
	const ids = allDetectorSetups().map(detectorSetupId);
	assert.equal(new Set(ids).size, ids.length);
	assert.ok(ids.includes('ctd+coo+sam-ts-l') && ids.includes('heuristic'));
	assert.match(detectorSetupLabel({ base: 'ctd', coo: false, samTsL: true }), /SAM-TS-L/);
});

test('confidence is clamped and blank means "use the default"', () => {
	assert.equal(clampDetectConf(''), undefined);
	assert.equal(clampDetectConf(null), undefined);
	assert.equal(clampDetectConf(2), 0.9);
	assert.equal(clampDetectConf('0.01'), 0.05);
	assert.equal(clampDetectConf('0.35'), 0.35);
});

test('admin default is saved and chapters follow it unless they pick their own', () => {
	assert.equal(detectorDefaults().saved, false);
	assert.throws(() => saveDetectorDefaults({ setup: 'heuristic+sam-ts-l' }), /Unknown detector setup/);
	const saved = saveDetectorDefaults({ setup: 'heuristic', conf: 0.4 });
	assert.equal(saved.saved, true);
	assert.equal(saved.setup, 'heuristic');
	assert.equal(saved.conf, 0.4);

	const onDefault = resolveDetector('ep-default');
	assert.equal(onDefault.source, 'default');
	assert.equal(detectorSetupId(onDefault.setup), 'heuristic');
	assert.equal(onDefault.conf, 0.4);

	putDoc(null, 'chapter:ep-own', { detectorSetup: 'ctd', detectConf: 0.3 }, 0);
	const own = resolveDetector('ep-own');
	assert.equal(own.source, 'chapter');
	assert.equal(detectorSetupId(own.setup), 'ctd');
	assert.equal(own.conf, 0.3);

	const request = resolveDetector('ep-own', { setup: { base: 'paddle', coo: false, samTsL: false }, conf: 0.5 });
	assert.equal(request.source, 'request');
	assert.equal(request.setup.base, 'paddle');
	assert.equal(request.conf, 0.5);
});

test('add-ons that are not installed are dropped and reported', () => {
	saveDetectorDefaults({ setup: 'ctd+coo+sam-ts-l' });
	const resolved = resolveDetector('ep-missing');
	assert.equal(resolved.conf, 0.4, 'saving a setup keeps the saved confidence');
	assert.deepEqual(resolved.setup, { base: 'ctd', coo: false, samTsL: false });
	assert.equal(resolved.skipped.length, 2);
});
