import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { dilateMask, ghostMask, ghostPixels } from '../src/lib/server/cleaningTouchUp';

test('dilation grows a pixel into a square of the given reach', () => {
	const on = new Uint8Array(7 * 7);
	on[3 * 7 + 3] = 1;
	const grown = dilateMask(on, 7, 7, 2);
	assert.equal(grown.reduce((n, v) => n + v, 0), 25);
	assert.equal(grown[1 * 7 + 1], 1);
	assert.equal(grown[0], 0);
});

test('only faint marks near the original lettering are masked, not texture elsewhere', () => {
	const width = 40, height = 20;
	const grey = new Uint8Array(width * height).fill(60), smooth = new Uint8Array(width * height).fill(60);
	const letters = new Uint8Array(width * height);
	for (let x = 5; x < 15; x++) letters[10 * width + x] = 1; // original stroke on the left
	grey[10 * width + 8] = 110; // ghost left inside it
	grey[10 * width + 30] = 140; // artwork detail far from any lettering
	grey[10 * width + 12] = 70; // within the noise threshold
	const { mask, pixels } = ghostPixels(grey, smooth, letters, width, height, { grow: 1 });
	assert.equal(mask[10 * width + 8], 1);
	assert.equal(mask[10 * width + 30], 0, 'artwork away from the lettering is never touched');
	assert.equal(mask[10 * width + 12], 0);
	assert.equal(pixels, 9);
});

test('a clean candidate yields an empty touch-up mask', async () => {
	const flat = await sharp({ create: { width: 30, height: 30, channels: 3, background: '#3a2440' } }).png().toBuffer();
	const letters = await sharp({ create: { width: 30, height: 30, channels: 3, background: '#ffffff' } }).png().toBuffer();
	assert.equal((await ghostMask(flat, letters)).pixels, 0);
	const ghost = await sharp(flat).composite([{ input: Buffer.from('<svg width="30" height="30"><rect x="14" y="14" width="2" height="2" fill="#9a8aa0"/></svg>'), left: 0, top: 0 }]).png().toBuffer();
	assert.ok((await ghostMask(ghost, letters)).pixels > 0);
});
