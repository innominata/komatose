import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { dilate, wandSelect, wandWindow } from '../src/lib/maskWand';
import { applyTextMaskWand } from '../src/lib/server/textMask';

/** 10×10 white page with a black ring (a balloon outline) from 2..7 and a grey pixel inside it. */
function ringPage() {
	const w = 10, h = 10, px = new Uint8Array(w * h * 3).fill(255);
	for (let y = 2; y <= 7; y++)
		for (let x = 2; x <= 7; x++)
			if (x === 2 || x === 7 || y === 2 || y === 7) px.fill(0, (y * w + x) * 3, (y * w + x) * 3 + 3);
	px.fill(200, (5 * w + 5) * 3, (5 * w + 5) * 3 + 3);
	return { w, h, px };
}
const count = (sel: Uint8Array) => sel.reduce((n, v) => n + v, 0);

test('wand selects only the connected area within tolerance', () => {
	const { w, h, px } = ringPage();
	assert.equal(count(wandSelect(px, w, h, 3, 2, 2, 10)), 20, 'the ring');
	assert.equal(count(wandSelect(px, w, h, 3, 4, 4, 10)), 15, 'inside, without the grey pixel');
	assert.equal(count(wandSelect(px, w, h, 3, 4, 4, 60)), 16, 'inside, grey within tolerance');
	assert.equal(count(wandSelect(px, w, h, 3, 0, 0, 10)), 64, 'outside the ring');
});

test('grow covers neighbouring pixels', () => {
	const sel = new Uint8Array(25);
	sel[12] = 1;
	assert.equal(count(dilate(sel, 5, 5, 1)), 9);
	assert.equal(count(dilate(sel, 5, 5, 2)), 25);
});

test('the wand window pads the region and stays on the page', () => {
	assert.deepEqual(wandWindow({ x: 0.4, y: 0.4, w: 0.1, h: 0.1 }, 1000, 1000), { left: 350, top: 350, width: 200, height: 200 });
	assert.deepEqual(wandWindow({ x: 0, y: 0, w: 1, h: 1 }, 100, 50), { left: 0, top: 0, width: 100, height: 50 });
});

test('applyTextMaskWand masks and unmasks the clicked outline', async () => {
	const { w, h, px } = ringPage();
	const artwork = await sharp(Buffer.from(px), { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
	const bounds = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
	const masked = await applyTextMaskWand({ width: w, height: h, artwork, bounds,
		wand: { x: 0.25, y: 0.25, tolerance: 10, grow: 0, erase: false } });
	const raw = await sharp(masked!).extractChannel(0).raw().toBuffer();
	assert.equal(raw.reduce((n, v) => n + (v === 0 ? 1 : 0), 0), 20, 'the ring is masked (black)');
	const unmasked = await applyTextMaskWand({ width: w, height: h, artwork, bounds, existing: masked!,
		wand: { x: 0.25, y: 0.25, tolerance: 10, grow: 0, erase: true } });
	assert.ok((await sharp(unmasked!).extractChannel(0).raw().toBuffer()).every((v) => v === 255), 'erasing restores it');
});
