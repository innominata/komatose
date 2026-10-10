import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HANGUL_INITIALS, HANGUL_VOWELS, HANGUL_FINALS, composeHangul, isCharacterEntryLang, koreanGlossaryTerms, replaceEntrySelection, deleteEntrySelection } from '../src/lib/hangulEntry';

test('modern Hangul includes every initial, vowel and final, in Unicode order', () => {
  assert.equal(HANGUL_INITIALS.length, 19);
  assert.equal(HANGUL_VOWELS.length, 21);
  assert.equal(HANGUL_FINALS.length, 28);
  const syllable = (a: string, b: string, c = '') => composeHangul(
    HANGUL_INITIALS.findIndex(k => k.glyph === a), HANGUL_VOWELS.findIndex(k => k.glyph === b), HANGUL_FINALS.findIndex(k => k.glyph === c));
  assert.equal(syllable('ㅎ', 'ㅏ', 'ㄴ'), '한');
  assert.equal(syllable('ㄲ', 'ㅘ', 'ㄱ'), '꽉');
  assert.equal(syllable('ㅇ', 'ㅣ', 'ㄺ'), '읽');
  assert.equal(syllable('ㄱ', 'ㅗ', 'ㅄ'), '곲');
  assert.equal(syllable('ㅇ', 'ㅏ'), '아');
  assert.equal(composeHangul(0, 0), '가');
  assert.equal(composeHangul(18, 20, 27), '힣');
  assert.equal(HANGUL_INITIALS.find(k => k.glyph === 'ㅋ')?.reading, 'k');
});

test('incomplete or invalid selections cannot insert a syllable', () => {
  for (const [a, b, c] of [[-1, 0, 0], [0, -1, 0], [19, 0, 0], [0, 21, 0], [0, 0, 28], [0, 0, -1], [NaN, 0, 0], [0, 0.5, 0]])
    assert.equal(composeHangul(a, b, c), '');
  assert.equal(isCharacterEntryLang('korean'), true);
  assert.equal(isCharacterEntryLang('japanese'), true);
  assert.equal(isCharacterEntryLang(undefined), false);
  assert.equal(isCharacterEntryLang('english'), false);
});

test('draft edits replace selections without normalizing nearby text; delete handles emoji', () => {
  assert.deepEqual(replaceEntrySelection('A나다Z', 1, 3, '한'), { text: 'A한Z', caret: 2 });
  assert.deepEqual(replaceEntrySelection('AB', 1, 1, 'ㅋㅋ'), { text: 'AㅋㅋB', caret: 3 });
  assert.deepEqual(deleteEntrySelection('한😀글', 3, 3), { text: '한글', caret: 1 });
  assert.deepEqual(deleteEntrySelection('한글', 1, 1), { text: '글', caret: 0 });
  assert.deepEqual(deleteEntrySelection('한글', 0, 0), { text: '한글', caret: 0 });
  assert.deepEqual(deleteEntrySelection('한글', 0, 2), { text: '', caret: 0 });
});

test('Korean glossary shortcuts filter terms and prefer edited duplicates', () => {
  assert.deepEqual(koreanGlossaryTerms([
    { source: ' 민수 ', translation: 'Minsu' }, { source: '민수', translation: 'Min-su', edited: true },
    { source: '太郎', translation: 'Taro' }, { source: 'Wait', translation: 'Wait' }, { source: 'ㅋㅋ', translation: 'Laugh' },
  ]), [{ source: '민수', translation: 'Min-su', edited: true }, { source: 'ㅋㅋ', translation: 'Laugh' }]);
});
