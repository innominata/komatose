import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRegionLineType,
  findSfxInText,
  looksLikeDialogue,
  looksLikeOnomatopoeia,
  lookupStandaloneSfx,
  sfxClassificationSource,
  sfxGlossaryPrompt,
  sfxTranslateHit,
  withSfxGlossary,
} from '../src/lib/sfx';

test('standalone SFX matches exact, punctuated, kana, and elongated forms', () => {
  assert.equal(lookupStandaloneSfx('ドキドキ')?.meanings[0], 'thump thump');
  assert.equal(lookupStandaloneSfx('ドキッ！')?.meanings[0], 'thump');
  assert.equal(lookupStandaloneSfx('どきどき')?.source, 'ドキドキ');
  assert.equal(lookupStandaloneSfx('ドーン…')?.meanings[0], 'BOOM');
  assert.equal(lookupStandaloneSfx('ドオオーン')?.meanings[0], 'BOOM');
  assert.equal(lookupStandaloneSfx('しーん')?.meanings[0], 'silence');
  assert.equal(lookupStandaloneSfx('ふわっ')?.meanings[0], 'float');
  assert.equal(lookupStandaloneSfx('フワッ')?.meanings[0], 'float');
  assert.equal(lookupStandaloneSfx('忍び足')?.meanings[0], 'tiptoe');
});

test('repeated SFX collapse to the dictionary stem', () => {
  assert.equal(lookupStandaloneSfx('ドキドキドキドキ')?.source, 'ドキドキ');
  assert.equal(lookupStandaloneSfx('ゴゴゴゴゴ')?.source, 'ゴゴゴ');
  assert.equal(lookupStandaloneSfx('ドンドンドン')?.source, 'ドン');
});

test('in-text matching uses kana runs and ignores short false positives', () => {
  assert.deepEqual(findSfxInText('ドキドキする').map((e) => e.source), ['ドキドキ']);
  assert.deepEqual(findSfxInText('心臓がドキドキした').map((e) => e.source), ['ドキドキ']);
  assert.equal(findSfxInText('ワンルーム').length, 0);
  assert.equal(findSfxInText('おおきい').length, 0);
  assert.equal(findSfxInText('太郎、待って！').length, 0);
  assert.equal(findSfxInText('リンリン')[0]?.source, 'リンリン');
});

test('glossary addendum includes only SFX that appear in the current sources', () => {
  const extra = sfxGlossaryPrompt(['ドキドキする', '待って！']);
  assert.match(extra, /ドキドキ → thump thump \/ pounding heartbeat/);
  assert.doesNotMatch(extra, /ワン →/);
  assert.doesNotMatch(extra, /ドーン →/);
  const merged = withSfxGlossary('太郎 → Taro', ['ドーン！', '太郎、待って！']);
  assert.match(merged, /太郎 → Taro/);
  assert.match(merged, /ドーン → BOOM/);
  assert.equal(withSfxGlossary('太郎 → Taro', ['待って！']), '太郎 → Taro');
});

test('meanings keep internal slashes and only split on spaced delimiters', () => {
  assert.deepEqual(lookupStandaloneSfx('スラスラ')?.meanings, ['write/read fluently']);
});

test('region type follows the dictionary and the detector prior', () => {
  assert.equal(classifyRegionLineType('bubble', 'ドキドキ'), '::');
  assert.equal(classifyRegionLineType('unknown', 'どきどき！'), '::');
  assert.equal(classifyRegionLineType('free', '待って！'), '//');
  assert.equal(classifyRegionLineType('free', 'こんにちは'), '//');
  assert.equal(classifyRegionLineType('free', 'ズギャーン'), '::');
  assert.equal(classifyRegionLineType('bubble', 'ズギャーン'), '""');
  assert.equal(classifyRegionLineType('free', ''), '::');
  assert.equal(looksLikeDialogue('ふわっ'), false);
  assert.equal(
    sfxClassificationSource('', [
      { source: 'ドーン' },
      { source: 'ドンッ' },
    ]),
    'ドーン',
  );
  assert.equal(
    sfxClassificationSource('', [
      { source: 'ドーン' },
      { source: '待って' },
    ]),
    '',
  );
});

test('a detector that cannot place the text is judged by the shape of the reading', () => {
  for (const sfx of ['ズバババ', 'ババババ', 'ちゅううううう', 'ちゅるるっ', 'ズバズバ', 'ハンハッ', 'チッ', 'バシャッ'])
    assert.equal(classifyRegionLineType('unknown', sfx), '::', sfx);
  for (const speech of ['はい！', 'ホラ斉藤！', 'えー？でもさっき出てないって言ってたよね？', 'そうだっ', 'ハーイ', 'ありがとう', ''])
    assert.equal(classifyRegionLineType('unknown', speech), '""', speech);
  assert.equal(looksLikeOnomatopoeia('待って待って'), false);
  assert.equal(looksLikeOnomatopoeia('はいはい'), false);
  // A hiragana sigh inside a bubble is speech; katakana lettering inside one is still SFX.
  assert.equal(classifyRegionLineType('bubble', 'はあ……'), '""');
  assert.equal(classifyRegionLineType('bubble', 'ドキドキ'), '::');
  assert.equal(classifyRegionLineType('bubble', 'ちゅううううう'), '::');
  // Inside a detected bubble only the dictionary decides.
  assert.equal(classifyRegionLineType('bubble', 'ババババ'), '""');
});

test('the sound-effect detector outranks a misread that looks like a word, but not a sentence', () => {
  assert.equal(classifyRegionLineType('free', '家族', { sfxDetector: true }), '::');
  assert.equal(classifyRegionLineType('free', '', { sfxDetector: true }), '::');
  assert.equal(classifyRegionLineType('bubble', 'ズバババ', { sfxDetector: true }), '::');
  assert.equal(classifyRegionLineType('free', '眠そうだな斉藤……', { sfxDetector: true }), '//');
  assert.equal(classifyRegionLineType('free', 'うんさっきまで当直だったから', { sfxDetector: true }), '//');
});

test('speech lettered outside a bubble is an aside, not dialogue and not SFX', () => {
  // Free text that the box detector found, read as a sentence.
  assert.equal(classifyRegionLineType('free', '昼休みにポストしてくれるなんて天使すぎる'), '//');
  // A short spoken word in a margin that the SFX detector also fired on.
  assert.equal(classifyRegionLineType('free', 'そう！', { sfxDetector: true }), '//');
  assert.equal(classifyRegionLineType('free', 'はい', { sfxDetector: true }), '//');
  // Inside a bubble the same words are dialogue.
  assert.equal(classifyRegionLineType('bubble', 'そう！'), '""');
  assert.equal(classifyRegionLineType('bubble', '昼休みにポストしてくれるなんて天使すぎる'), '""');
  // Sounds stay SFX outside a bubble, including short hiragana ones.
  for (const sfx of ['ザワッ', 'フン', 'ぐわ', 'かさ', 'ふわっ', 'ババババ'])
    assert.equal(classifyRegionLineType('free', sfx, { sfxDetector: true }), '::', sfx);
});

test('standalone hits supply lettering-ready English without a model', () => {
  const hit = sfxTranslateHit('ドンッ');
  assert.equal(hit?.translation, 'thud');
  assert.match(hit?.reasoning || '', /SFX dictionary/);
  assert.equal(sfxTranslateHit('待って！'), null);
  assert.equal(sfxTranslateHit(''), null);
});
