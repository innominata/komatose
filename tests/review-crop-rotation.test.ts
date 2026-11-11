import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { applyLetteringMask, parseReviewRotation, rotateReviewImage } from '../src/lib/server/reviewMask';

test('rotation is parsed to -180..180 degrees', () => {
	assert.equal(parseReviewRotation(undefined), 0);
	assert.equal(parseReviewRotation('90'), 90);
	assert.equal(parseReviewRotation(270), -90);
	assert.equal(parseReviewRotation(-180), 180);
	assert.equal(parseReviewRotation(12.345), 12.3);
	assert.throws(() => parseReviewRotation('sideways'));
	assert.throws(() => parseReviewRotation(720));
});

test('a crop and its mask turned by the same angle stay the same size', async () => {
	const crop = await sharp({ create: { width: 30, height: 10, channels: 3, background: '#808080' } }).jpeg().toBuffer();
	const mask = await sharp({ create: { width: 30, height: 10, channels: 3, background: '#ffffff' } }).greyscale().png().toBuffer();
	const quarter = await sharp(await rotateReviewImage(crop, 90, 'crop')).metadata();
	assert.deepEqual([quarter.width, quarter.height], [10, 30]);
	for (const angle of [90, -35, 12.5]) {
		const c = await sharp(await rotateReviewImage(crop, angle, 'crop')).metadata();
		const m = await sharp(await rotateReviewImage(mask, angle, 'mask')).metadata();
		assert.deepEqual([c.width, c.height], [m.width, m.height], `${angle}°`);
	}
	// The turned mask applies to the turned crop.
	const masked = await applyLetteringMask(await rotateReviewImage(crop, -35, 'crop'), await rotateReviewImage(mask, -35, 'mask'));
	assert.ok(masked.length > 0);
	assert.equal(await rotateReviewImage(crop, 0, 'crop'), crop);
});
