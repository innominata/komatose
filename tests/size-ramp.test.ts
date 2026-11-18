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
	// Stack spacing pulls the letters closer together (or spreads them), down to a tenth of an em.
	const pitch = (l: typeof stacked) => l.rows[1].baseline - l.rows[0].baseline;
	const tight = await fitText(line, {}, page, { ...style, stacked: true, stackSpacing: -300 }, 72);
	// Per point of size (the tighter column can fit a larger size); 72 dpi, so 1 pt = 1 px.
	assert.ok(Math.abs(pitch(stacked) / stacked.size - pitch(tight) / tight.size - 0.3) < 0.001, `${pitch(stacked)}@${stacked.size} → ${pitch(tight)}@${tight.size}`);
	assert.ok(tight.size >= stacked.size);
	const crushed = await fitText(line, {}, page, { ...style, stacked: true, stackSpacing: -900 }, 72);
	assert.ok(pitch(crushed) >= 0.1 * crushed.size - 1e-6);
	assert.equal('stackSpacing' in validateStyle({ ...style, stackSpacing: -300 }), false, 'only kept on stacked text');
	assert.equal('stackSpacing' in validateStyle({ ...style, stacked: true, stackSpacing: 0 }), false, '0 is not stored');
	assert.equal(validateStyle({ ...style, stacked: true, stackSpacing: -5000 }).stackSpacing, -900);
	assert.equal(layoutKey(line, {}, page, { ...style, stacked: true }, 72), layoutKey(line, {}, page, { ...style, stacked: true, stackSpacing: 0 }, 72));
});

test('a complete style without stacking is still the region\'s own style', () => {
	// Otherwise every state read re-stamps every region's style (and bumps its revision).
	assert.equal(styleIsOwned({ ...DEFAULT_STYLE }), true);
	assert.equal(styleIsOwned({ ...DEFAULT_STYLE, stacked: true }), true);
	assert.equal(styleIsOwned({ ...DEFAULT_STYLE, stacked: true, stackSpacing: -200 }), true);
});

test('leading under 1 tightens lines below the font height; 1 and up are unchanged', async () => {
	const { lineSpacing } = await import('../src/lib/server/typesetting');
	// Glyph height 1.3 em: from 1 up it is the floor, below 1 the floor itself shrinks.
	assert.equal(lineSpacing(130, 100, 1.15), 130);
	assert.equal(lineSpacing(130, 100, 1.5), 150);
	assert.equal(lineSpacing(130, 100, 1), 130);
	assert.equal(lineSpacing(130, 100, 0.8), 104);
	assert.equal(validateStyle({ leading: 0.5 }).leading, 0.7, 'held at the minimum');
	const page = { id: 'p', width: 800, height: 800 } as never;
	const line = { id: 'l', body: 'ONE TWO THREE FOUR', x: 0.2, y: 0.1, w: 0.3, h: 0.8 } as never;
	const style = { ...DEFAULT_STYLE, fontId: font.id, size: 40, minSize: 40 };
	const gap = (l: { rows: { baseline: number }[] }) => l.rows[1].baseline - l.rows[0].baseline;
	const normal = await fitText(line, {}, page, { ...style, leading: 1 }, 72);
	const tight = await fitText(line, {}, page, { ...style, leading: 0.8 }, 72);
	assert.ok(normal.rows.length > 1 && tight.rows.length === normal.rows.length);
	assert.ok(Math.abs(gap(tight) - gap(normal) * 0.8) < 0.01, `${gap(tight)} vs ${gap(normal)}`);
	assert.ok(Math.abs(normal.lineHeightAt1! - gap(normal)) < 0.01, 'records the leading-1 gap for PSD import');
});
