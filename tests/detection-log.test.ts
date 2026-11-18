import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'komatose-detection-log-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.DATABASE_URL = join(root, 'data/test.db');
const { sqlite } = await import('../src/lib/server/db');
const { recordDetectionRun, recordDetectedRegion, seriesDetectionReport, detectionRows } = await import('../src/lib/server/detectionLog');
const { deleteRegions, restoreDeletion } = await import('../src/lib/server/regionTrash');
const { fuseDetections } = await import('../src/lib/server/detectFusion');
const { composeDetections } = await import('../src/lib/server/detect');
after(async () => { sqlite.close(); await rm(root, { recursive: true, force: true }); });

sqlite.prepare("INSERT INTO series(id,slug,title,created_at,updated_at) VALUES('s','series','Fixture',1,1)").run();
sqlite.prepare("INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES('e','s','ch1','Chapter 1',1,1)").run();
sqlite.prepare("INSERT INTO images(id,episode_id,filename,original_name,width,height,created_at) VALUES('p','e','p.png','p.png',1000,1000,1)").run();
const line = (id: string, x: number, y: number, w = 0.1, h = 0.1, state = 'readable') =>
	sqlite.prepare("INSERT INTO lines(id,episode_id,image_id,body,x,y,w,h,source_state,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1)")
		.run(id, 'e', 'p', '', x, y, w, h, state);
const region = (x: number, sources: string[], score: number, kind: 'bubble' | 'free' | 'unknown' = 'bubble') => ({
	ocr: { x, y: 0.1, w: 0.1, h: 0.1 }, place: { x, y: 0.1, w: 0.1, h: 0.1, left: 0, top: 0, width: 100, height: 100 },
	kind, score, provenance: { sources, scores: Object.fromEntries(sources.map((s) => [s, score])), score },
}) as never;

test('fusion records each detector\'s score for the lettering it agreed on', () => {
	const fused = fuseDetections([
		{ cls: 'text_bubble', score: 0.9, box: [100, 100, 200, 200], backend: 'rtdetr' },
		{ cls: 'text', score: 0.7, box: [102, 101, 198, 199], backend: 'ctd' },
	], { ran: ['rtdetr', 'ctd'] });
	const text = fused.find((r) => r.sources.length);
	assert.deepEqual(text?.scores, { rtdetr: 0.9, ctd: 0.7 });
	const [composed] = composeDetections({
		rtdetr: [{ cls: 'text_bubble', score: 0.9, box: [100, 100, 200, 200] }],
		ctd: [{ cls: 'text', score: 0.7, box: [102, 101, 198, 199] }],
	}, 1000, 1000);
	assert.deepEqual(composed.provenance?.scores, { rtdetr: 0.9, ctd: 0.7 });
	assert.equal(composed.provenance?.score, 0.9);
	assert.equal(composed.provenance?.cls, 'text_bubble');
});

test('the report follows each detected region to where it ended up', async () => {
	line('before', 0.9, 0.9); // On the page before detection ran: not drawn by hand.
	const runId = recordDetectionRun({
		seriesId: 's', episodeId: 'e', imageId: 'p', setup: 'rtdetr+sam-ts-l', conf: 0.2, width: 1000, height: 1000,
		outputs: { rtdetr: [{ cls: 'text', score: 0.5, box: [0, 0, 10, 10], polygon: [{ x: 0, y: 0 }] }] },
	});
	assert.equal(JSON.parse((sqlite.prepare('SELECT outputs FROM detection_runs WHERE id=?').get(runId) as { outputs: string }).outputs).rtdetr[0].polygon, undefined, 'contours are not stored');
	const save = (id: string, x: number, sources: string[], score: number, outcome: 'saved' | 'auto-ignored' = 'saved', state = 'readable') => {
		line(id, x, 0.1, 0.1, 0.1, state);
		recordDetectedRegion({ runId, seriesId: 's', episodeId: 'e', imageId: 'p', lineId: id, region: region(x, sources, score), outcome });
	};
	save('kept', 0.0, ['rtdetr', 'ctd'], 0.9);
	save('moved', 0.12, ['rtdetr', 'ctd'], 0.9);
	save('deleted', 0.24, ['ctd'], 0.65);
	save('deleted2', 0.36, ['ctd'], 0.62);
	save('ignored', 0.48, ['sam-ts-l'], 0.5);
	save('cleared', 0.6, ['rtdetr'], 0.8);
	save('restored', 0.72, ['ctd'], 0.66);
	save('quiet', 0.84, ['ctd'], 0.3, 'auto-ignored', 'ignored');
	recordDetectedRegion({ runId, seriesId: 's', episodeId: 'e', imageId: 'p', region: region(0.5, ['sam-ts-l'], 0.5), outcome: 'dropped', reason: 'Lettering mask only' });

	sqlite.prepare("UPDATE lines SET x=0.5, y=0.6 WHERE id='moved'").run();
	sqlite.prepare("UPDATE lines SET source_state='ignored' WHERE id='ignored'").run();
	deleteRegions('e', ['deleted'], 'Delete region');
	deleteRegions('e', ['deleted2'], 'Remove blank regions');
	deleteRegions('e', ['cleared'], 'Remove page regions');
	deleteRegions('e', ['restored'], 'Delete region');
	await restoreDeletion('e');
	line('drawn', 0.3, 0.5); // Drawn by hand after detection: a miss.

	const outcomes = Object.fromEntries(detectionRows('s').map((r) => [r.x.toFixed(2), r.outcome]));
	assert.deepEqual(outcomes, {
		'0.00': 'kept', '0.12': 'reshaped', '0.24': 'removed', '0.36': 'removed', '0.48': 'ignored',
		'0.60': 'cleared', '0.72': 'kept', '0.84': 'auto-ignored', '0.50': 'dropped',
	});
	const report = seriesDetectionReport('s', new Map([['e', 'Chapter 1']]));
	assert.equal(report.totals.shown, 6, 'kept, reshaped, restored, two deleted, one ignored');
	assert.equal(report.totals.rejected, 3);
	assert.equal(report.addedByHand, 1);
	assert.deepEqual(report.setups, [{ setup: 'rtdetr+sam-ts-l', pages: 1 }]);
	const ctd = report.bySources.find((g) => g.key === 'ctd')!;
	assert.equal(ctd.label, 'Comic Text Detector alone');
	assert.deepEqual([ctd.shown, ctd.rejected, ctd['auto-ignored']], [3, 2, 1]);
	assert.equal(report.hotspots[0].label, 'SAM-TS-L mask alone · score 0.4–0.6', 'every shown mask-only region was rejected');
	assert.deepEqual(report.rejectedSamples.map((r) => r.x.toFixed(2)).sort(), ['0.24', '0.36', '0.48']);
	assert.equal(report.byEpisode[0].label, 'Chapter 1');
	assert.equal(report.byEpisode[0].addedByHand, 1);

	// A deleted page drops out of the report.
	sqlite.prepare("DELETE FROM images WHERE id='p'").run();
	assert.equal(seriesDetectionReport('s').totals.total, 0);
});

test('tuning replays the recorded boxes and finds the threshold that drops the false positives', async () => {
	const { tuneFusion, tuningPages } = await import('../src/lib/server/detectionTuning');
	const { FUSION } = await import('../src/lib/server/detectFusion');
	sqlite.prepare("INSERT INTO images(id,episode_id,filename,original_name,width,height,created_at) VALUES('q','e','q.png','q.png',1000,1000,2)").run();
	// Two kept bubbles both detectors agree on, and two lone CTD boxes on the art at 0.65.
	const outputs = {
		rtdetr: [
			{ cls: 'text_bubble', score: 0.9, box: [100, 100, 200, 200] },
			{ cls: 'text_bubble', score: 0.85, box: [400, 100, 500, 200] },
		],
		ctd: [
			{ cls: 'text', score: 0.8, box: [102, 102, 198, 198] },
			{ cls: 'text', score: 0.8, box: [402, 102, 498, 198] },
			{ cls: 'text', score: 0.65, box: [100, 600, 160, 660] },
			{ cls: 'text', score: 0.66, box: [600, 600, 660, 660] },
		],
	};
	recordDetectionRun({ seriesId: 's', episodeId: 'e', imageId: 'q', setup: 'rtdetr', width: 1000, height: 1000, outputs: outputs as never });
	sqlite.prepare("INSERT INTO lines(id,episode_id,image_id,body,x,y,w,h,source_state,updated_at) VALUES('t1','e','q','',0.1,0.1,0.1,0.1,'readable',1),('t2','e','q','',0.4,0.1,0.1,0.1,'readable',1)").run();
	assert.equal(tuningPages('s').length, 0, 'not marked done yet');
	assert.equal(tuningPages('s', { all: true }).length, 1);
	sqlite.prepare("INSERT INTO workflow_docs(id,episode_id,revision,data,undo,redo,updated_at) VALUES('page:q','e',1,?,'[]','[]',1)")
		.run(JSON.stringify({ completed: { translate: 'x' } }));
	const before = { ...FUSION.alone };
	const { baseline, results } = tuneFusion(tuningPages('s'));
	assert.deepEqual({ ...FUSION.alone }, before, 'the shared settings are put back');
	assert.deepEqual([baseline.found, baseline.falsePositives, baseline.missed], [2, 2, 0]);
	assert.equal(results[0].variant.label, 'ctd alone ≥ 0.7');
	assert.deepEqual([results[0].score.found, results[0].score.falsePositives], [2, 0]);
});
