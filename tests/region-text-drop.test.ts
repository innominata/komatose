import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanDroppedText, dropFieldFor, regionAtPoint } from '../src/lib/regionTextDrop';

test('the writing system picks source or English', () => {
	assert.equal(dropFieldFor('ここで待って。'), 'source');
	assert.equal(dropFieldFor('여기서 기다려!'), 'source');
	assert.equal(dropFieldFor('夜明けまでに戻る'), 'source');
	assert.equal(dropFieldFor('Wait here.'), 'english');
	assert.equal(dropFieldFor('I will be back before dawn.'), 'english');
	assert.equal(dropFieldFor('待って (wait)'), 'source');
	assert.equal(dropFieldFor('"Wait" — 待って'), 'source');
	assert.equal(dropFieldFor('The SFX ドン should read BOOM'), 'english');
	assert.equal(dropFieldFor('… !?'), null);
});

test('quotes and emphasis wrapping a selection are removed', () => {
	assert.equal(cleanDroppedText('  “Wait here.”\n'), 'Wait here.');
	assert.equal(cleanDroppedText('「ここで待って。」'), 'ここで待って。');
	assert.equal(cleanDroppedText('**"Wait!"**'), 'Wait!');
	assert.equal(cleanDroppedText('"A" and "B"'), '"A" and "B"');
	assert.equal(cleanDroppedText('“A” and “B”'), '“A” and “B”');
	assert.equal(cleanDroppedText('Line one\r\nline two'), 'Line one\nline two');
});

test('the smallest region under the point receives the drop', () => {
	const lines = [
		{ id: 'big', x: 0.1, y: 0.1, w: 0.6, h: 0.6 },
		{ id: 'small', x: 0.3, y: 0.3, w: 0.1, h: 0.1 },
		{ id: 'unplaced', x: null, y: null, w: null, h: null },
	];
	assert.equal(regionAtPoint(lines, { x: 0.35, y: 0.35 })?.id, 'small');
	assert.equal(regionAtPoint(lines, { x: 0.15, y: 0.15 })?.id, 'big');
	assert.equal(regionAtPoint(lines, { x: 0.9, y: 0.9 }), undefined);
});
