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
	assert.deepEqual(parseDetectorSetup('ctd+koharu'), { base: 'ctd', coo: false, koharu: true });
	assert.deepEqual(parseDetectorSetup('paddle+coo+koharu'), { base: 'paddle', coo: true, koharu: true });
	assert.equal(detectorSetupId({ base: 'rtdetr', coo: true, koharu: true }), 'rtdetr+coo+koharu');
	assert.deepEqual(parseDetectorSetup('koharu'), { base: 'koharu', coo: false, koharu: false });
	assert.deepEqual(parseDetectorSetup('yolo'), { base: 'yolo', coo: false, koharu: false });
	for (const bad of ['', 'ctd+ctd', 'heuristic+koharu', 'ctd+nope', '../yolo', 'bad id', null]) {
		assert.equal(parseDetectorSetup(bad), undefined, String(bad));
	}
	const ids = allDetectorSetups().map(detectorSetupId);
	assert.equal(new Set(ids).size, ids.length);
	assert.ok(ids.includes('ctd+coo+koharu') && ids.includes('heuristic'));
	assert.match(detectorSetupLabel({ base: 'ctd', coo: false, koharu: true }), /Koharu/);
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
	assert.throws(() => saveDetectorDefaults({ setup: 'heuristic+koharu' }), /Unknown detector setup/);
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

	const request = resolveDetector('ep-own', { setup: { base: 'paddle', coo: false, koharu: false }, conf: 0.5 });
	assert.equal(request.source, 'request');
	assert.equal(request.setup.base, 'paddle');
	assert.equal(request.conf, 0.5);
});

test('add-ons that are not installed are dropped and reported', () => {
	saveDetectorDefaults({ setup: 'ctd+coo+koharu' });
	const resolved = resolveDetector('ep-missing');
	assert.equal(resolved.conf, 0.4, 'saving a setup keeps the saved confidence');
	assert.deepEqual(resolved.setup, { base: 'ctd', coo: false, koharu: false });
	assert.equal(resolved.skipped.length, 2);
});
