import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findSfxInText,
  lookupStandaloneSfx,
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

test('standalone hits supply lettering-ready English without a model', () => {
  const hit = sfxTranslateHit('ドンッ');
  assert.equal(hit?.translation, 'thud');
  assert.match(hit?.reasoning || '', /SFX dictionary/);
  assert.equal(sfxTranslateHit('待って！'), null);
  assert.equal(sfxTranslateHit(''), null);
});
