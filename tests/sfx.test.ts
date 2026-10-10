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

test('Korean SFX match exact, punctuated, elongated, and repeated forms', () => {
  assert.equal(lookupStandaloneSfx('두근두근')?.meanings[0], 'thump thump');
  assert.equal(lookupStandaloneSfx('하아..')?.meanings[0], 'sigh');
  assert.equal(lookupStandaloneSfx('하아아아')?.source, '하아');
  assert.equal(lookupStandaloneSfx('휙')?.meanings[0], 'swish');
  assert.equal(lookupStandaloneSfx('탁')?.meanings[0], 'tap');
  assert.equal(lookupStandaloneSfx('흠칫')?.meanings[0], 'flinch');
  assert.equal(lookupStandaloneSfx('슥')?.meanings[0], 'slide');
  assert.equal(lookupStandaloneSfx('하하')?.meanings[0], 'haha');
  assert.equal(lookupStandaloneSfx('하하하')?.source, '하하');
  assert.equal(lookupStandaloneSfx('헉!')?.meanings[0], 'gasp');
  assert.equal(lookupStandaloneSfx('헉ㅋㅋ')?.source, '헉');
  assert.equal(lookupStandaloneSfx('띠링')?.meanings[0], 'ding');
  assert.equal(lookupStandaloneSfx('벌컥!')?.meanings[0], 'burst');
  assert.equal(lookupStandaloneSfx('힐끔…')?.meanings[0], 'glance');
  assert.equal(lookupStandaloneSfx('화끈…')?.meanings[0], 'flush');
  assert.equal(lookupStandaloneSfx('쭈뼛…')?.meanings[0], 'fidget');
  assert.equal(lookupStandaloneSfx('쿵쿵쿵')?.source, '쿵쿵');
  assert.equal(lookupStandaloneSfx('두근두근두근')?.source, '두근두근');
  assert.equal(lookupStandaloneSfx('크아아아악')?.source, '크아');
  assert.equal(lookupStandaloneSfx('ㅋㅋㅋ')?.source, 'ㅋㅋ');
  assert.equal(lookupStandaloneSfx('휘이잉')?.source, '휘이');
  assert.equal(sfxTranslateHit('탁!')?.translation, 'tap');
});

test('Korean matching stays on the sound and does not swallow ordinary words', () => {
  assert.equal(lookupStandaloneSfx('탁자'), null);
  assert.equal(lookupStandaloneSfx('기다려'), null);
  assert.equal(lookupStandaloneSfx('사람'), null);
  assert.equal(lookupStandaloneSfx('나아'), null);
  assert.equal(findSfxInText('오늘은 말이라도 걸어볼까').length, 0);
  assert.equal(findSfxInText('탁자를 봤다').length, 0);
  assert.equal(findSfxInText('확 달라졌다').length, 0);
  assert.deepEqual(findSfxInText('심장이 두근두근 뛰었다').map((e) => e.source), ['두근두근']);
  assert.deepEqual(findSfxInText('사람이 하아 하고 쉬었다').map((e) => e.source), ['하아']);
  const extra = sfxGlossaryPrompt(['심장이 두근두근 뛰었다', '기다려!']);
  assert.match(extra, /두근두근 → thump thump/);
  assert.doesNotMatch(extra, /쾅 →/);
  assert.equal(lookupStandaloneSfx('ドキドキ')?.source, 'ドキドキ');
});

test('Korean region type follows the dictionary, and hangul sentences stay speech', () => {
  assert.equal(classifyRegionLineType('bubble', '두근두근'), '::');
  assert.equal(classifyRegionLineType('bubble', '하아……'), '::');
  assert.equal(classifyRegionLineType('bubble', '탁'), '::');
  assert.equal(classifyRegionLineType('bubble', '기다려 주세요'), '""');
  assert.equal(classifyRegionLineType('free', '오늘은 학교 분위기가 어수선하다'), '//');
  assert.equal(classifyRegionLineType('free', '응!', { sfxDetector: true }), '//');
  assert.equal(classifyRegionLineType('free', '미안. 나도 어떻게 말해야 할지 잘 몰랐어.', { sfxDetector: true }), '//');
  assert.equal(classifyRegionLineType('unknown', '다다다'), '::');
  assert.equal(classifyRegionLineType('unknown', '기다려'), '""');
  assert.equal(looksLikeDialogue('기다려'), true);
  assert.equal(looksLikeDialogue('두근두근'), false);
  assert.equal(looksLikeDialogue('하아'), false);
  assert.equal(looksLikeOnomatopoeia('쿵쿵쿵'), true);
  assert.equal(looksLikeOnomatopoeia('기다려 주세요'), false);
});
