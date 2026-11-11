import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySizeRamp, stackText } from '../src/lib/charStyles';
import { parseSizeRamp, rampGeometry } from '../src/lib/sizeRamp';
import { DEFAULT_STYLE, styleIsOwned } from '../src/lib/workflow';

const root = await mkdtemp(join(tmpdir(), 'komatose-size-ramp-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.DATABASE_URL = join(root, 'data/test.db');
const { sqlite } = await import('../src/lib/server/db');
const { uploadFont, fitText, layoutKey, validateStyle } = await import('../src/lib/server/typesetting');
sqlite.prepare("INSERT INTO series(id,slug,title,created_at,updated_at) VALUES('s','series','Fixture',1,1)").run();
const font = (await uploadFont('s', 'Fixture.otf', await readFile('/usr/share/fonts/julietaula-montserrat-fonts/Montserrat-Regular.otf'))).font;
after(async () => { sqlite.close(); await rm(root, { recursive: true, force: true }); });

const sizes = (runs: { start: number; end: number; style: { size?: number } }[], length: number) => {
	const out = new Array<number | undefined>(length).fill(undefined);
	for (const r of runs) for (let i = r.start; i < r.end; i++) out[i] = r.style.size;
	return out;
};

test('a ramp grows consecutive glyphs along each paragraph; spaces follow the next glyph', () => {
	const runs = applySizeRamp([], 'ab c\nxy', { from: 50, to: 100 });
	assert.deepEqual(sizes(runs, 7), [50, 75, 100, 100, undefined, 50, 100]);
	// On top of a character size already set.
	assert.deepEqual(sizes(applySizeRamp([{ start: 1, end: 2, style: { size: 200 } }], 'ab', { from: 50, to: 100 }), 2), [50, 200]);
});

test('stacked text puts each character on its own line with a blank line between words', () => {
	const out = stackText('AB C', [{ start: 1, end: 2, style: { size: 150 } }]);
	assert.equal(out.body, 'A\nB\n\nC');
	assert.deepEqual(sizes(out.runs, out.body.length), [undefined, undefined, 150, undefined, undefined, undefined]);
	assert.equal(stackText('😀a', []).body, '😀\na');
});

test('Shift-dragging a top corner up ramps from the short side to the tall side', () => {
	const rect = [{ x: 0.1, y: 0.4 }, { x: 0.5, y: 0.4 }, { x: 0.5, y: 0.5 }, { x: 0.1, y: 0.5 }];
	const up = rampGeometry(rect, 1, { x: 0.9, y: 0.3 }, false)!;
	assert.deepEqual(up.polygon[1], { x: 0.5, y: 0.3 }, 'the corner only moves vertically');
	assert.deepEqual(up.ramp, { from: 50, to: 100 });
	const left = rampGeometry(rect, 0, { x: 0.1, y: 0.2 }, false)!;
	assert.deepEqual(left.ramp, { from: 100, to: 33.3 });
	assert.equal(rampGeometry(rect, 1, { x: 0.5, y: 0.4 }, false)!.ramp, null, 'equal sides: no ramp');
	// Stacked: a bottom corner pulled out sideways grows the text downwards.
	const stacked = rampGeometry(rect, 2, { x: 0.9, y: 0.9 }, true)!;
	assert.deepEqual(stacked.polygon[2], { x: 0.9, y: 0.5 });
	assert.deepEqual(stacked.ramp, { from: 50, to: 100 });
	assert.equal(parseSizeRamp({ from: 100, to: 100 }), undefined);
	assert.equal(parseSizeRamp('big'), undefined);
});

test('fitted layout: ramped glyphs share a baseline, stacked rows hold one glyph each', async () => {
	const page = { id: 'p', width: 800, height: 400 } as never;
	const line = { id: 'l', body: 'BOOM', x: 0.1, y: 0.25, w: 0.8, h: 0.5 } as never;
	const style = { ...DEFAULT_STYLE, fontId: font.id, size: 200, minSize: 6 };
	const plain = await fitText(line, {}, page, style, 72);
	const ramp = { from: 40, to: 100 };
	const ramped = await fitText(line, { sizeRamp: ramp }, page, style, 72);
	assert.equal(ramped.rows.length, 1);
	assert.deepEqual(ramped.rows[0].pieces?.map((p) => ramped.charStyles![p.style].size), [40, 60, 80, 100]);
	assert.notEqual(layoutKey(line, {}, page, style, 72), layoutKey(line, { sizeRamp: ramp }, page, style, 72));
	// Glyph sizes in the SVG grow left to right.
	const scales = [...ramped.svg.matchAll(/scale\(([\d.]+) /g)].map((m) => Number(m[1]));
	assert.equal(scales.length, 4);
	assert.ok(scales.every((s, i) => i === 0 || s > scales[i - 1]), String(scales));
	assert.ok(plain.rows.length === 1);
	const stacked = await fitText(line, {}, page, { ...style, stacked: true }, 72);
	assert.deepEqual(stacked.rows.map((r) => r.text), ['B', 'O', 'O', 'M']);
	assert.ok(stacked.rows.every((r, i) => i === 0 || r.baseline > stacked.rows[i - 1].baseline));
	assert.equal('stacked' in validateStyle({ ...style, stacked: false }), false, 'off is not stored');
});

test('a complete style without stacking is still the region\'s own style', () => {
	// Otherwise every state read re-stamps every region's style (and bumps its revision).
	assert.equal(styleIsOwned({ ...DEFAULT_STYLE }), true);
	assert.equal(styleIsOwned({ ...DEFAULT_STYLE, stacked: true }), true);
});
