import { test } from 'node:test';
import assert from 'node:assert/strict';
import { breakAtSpace, formatLettering } from '../src/lib/letteringBreaks';

test('format breaks after punctuation runs, strips double quotes and trims lines', () => {
	assert.equal(formatLettering('  "Wait, I can do this. Really?! Watch me..."  '), 'Wait,\nI can do this.\nReally?!\nWatch me...');
	assert.equal(formatLettering('“Hey!” she said, “over here.”'), 'Hey!\nshe said,\nover here.');
	assert.equal(formatLettering('It costs 3.5 or 1,000 in the U.S. now'), 'It costs 3.5 or 1,000 in the U.S.\nnow');
	assert.equal(formatLettering('Already,\n  broken.   Here'), 'Already,\nbroken.\nHere');
	assert.equal(formatLettering('No  punctuation   here'), 'No punctuation here');
	assert.equal(formatLettering("It's fine…  isn't it?"), "It's fine…\nisn't it?");
	assert.equal(formatLettering('Hi.\r\n\r\nBye'), 'Hi.\nBye');
});

test('ctrl-click on a space turns the space run into one break', () => {
	assert.deepEqual(breakAtSpace('I can do this', 5), { text: 'I can\ndo this', caret: 6 });
	assert.deepEqual(breakAtSpace('I can   do this', 6), { text: 'I can\ndo this', caret: 6 });
	assert.deepEqual(breakAtSpace('I can do this', 6), { text: 'I can\ndo this', caret: 6 });
	assert.equal(breakAtSpace('I can do this', 3), null);
	assert.deepEqual(breakAtSpace('Hello \nthere', 6), { text: 'Hello\nthere', caret: 5 });
	assert.deepEqual(breakAtSpace(' Hello', 0), { text: 'Hello', caret: 0 });
});
