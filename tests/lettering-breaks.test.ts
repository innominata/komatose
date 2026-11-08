import { test } from 'node:test';
import assert from 'node:assert/strict';
import { breakAtSpace, formatLettering, glossaryNames, sentenceCase } from '../src/lib/letteringBreaks';

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

test('sentence case lowercases shouting but keeps sentence starts and I', () => {
	assert.equal(sentenceCase("WAIT, I CAN DO THIS. REALLY?! WATCH ME..."), 'Wait, I can do this. Really?! Watch me...');
	assert.equal(sentenceCase("I'M FINE,\nI'LL GO.\nI'D SAY I'VE WON!"), "I'm fine,\nI'll go.\nI'd say I've won!");
	assert.equal(sentenceCase('THIS IS IT…\n"NO WAY." (HUH?) OKAY'), 'This is it…\n"No way." (Huh?) Okay');
	assert.equal(sentenceCase('HIT IT, i.e. NOW. KIWI IS IN'), 'Hit it, i.e. now. Kiwi is in');
	assert.equal(sentenceCase('3 THINGS. 4 MORE'), '3 things. 4 more');
	assert.equal(sentenceCase('BACK IN THE U.S. AGAIN'), 'Back in the u.s. again');
});

test('sentence case restores glossary names with their own capitals', () => {
	const names = glossaryNames([
		{ translation: 'Ji-woo', aliases: ['Jiwoo'] },
		{ translation: 'Min-jun Park' },
		{ translation: 'McAllen' },
		{ translation: 'noona' },
		{ translation: '' },
	]);
	assert.deepEqual(names, ['Ji-woo', 'Jiwoo', 'Min-jun Park', 'McAllen']);
	assert.equal(sentenceCase('JI-WOO, MEET MIN-JUN PARK FROM MCALLEN. JIWOO?', names), 'Ji-woo, meet Min-jun Park from McAllen. Jiwoo?');
	// Whole words only, and lowercase-only glossary terms stay lowercase.
	assert.equal(sentenceCase('MCALLENS AND NOONA', names), 'Mcallens and noona');
});
