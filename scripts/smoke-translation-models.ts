/** Real inference against a chosen installed model, with isolated persistence. */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { translationModel } from '../src/lib/translationModels';

const model = translationModel(process.argv[2] || 'hy-mt2-manga-v5');
assert.ok(model, 'Choose a registered translation model ID');
process.env.SCAN_TRANSLATION_MODELS_DIR ||= join(process.cwd(), 'data/models/translation');
const scratch = await mkdtemp(join(tmpdir(), 'scan-translation-smoke-'));
process.env.DATABASE_URL = join(scratch, 'test.db');
process.env.SCAN_DATA_DIR = scratch;
const { translateScript } = await import('../src/lib/server/llm');
const { stopTranslationRuntime } = await import('../src/lib/server/translationRuntime');
const language = process.argv[3] || (model.languages.includes('korean') && !model.languages.includes('japanese') ? 'korean' : 'japanese');
assert.ok(language === 'japanese' || language === 'korean', 'Choose japanese or korean');
assert.ok(model.languages.includes(language), `${model.id} does not support ${language}`);
const korean = language === 'korean';
const sources = korean
  ? ['기다려!', '한 명의 환자가 부분 반응을 보였다', '네가\n나를\n사랑한다고\n했잖아!', '기\n다\n려\n!', '말할기회를 주겠다']
  : ['待って！一緒に行こう。', '太郎は部室にいる。'];
const expectEnglish = korean
  ? [/\bwait\b/i, /\bpatient\b/i, /love(?:d)? me/i, /\bwait\b/i, /\b(?:chance|opportunity)\b/i]
  : [/[A-Za-z]/, /Taro|clubroom|[A-Za-z]/];
try {
  const started = Date.now();
  const result = await translateScript(sources.map((source, i) => ({
    id: String(i), source, lineType: '""' as const, x: 0, y: 0, w: 1, h: 1,
    literal: '', translation: '', reasoning: '',
  })), {
    model: model.id, lang: korean ? 'korean' : 'japanese', seriesNotes: '', prior: '', pageLabel: 'Smoke fixture',
    seriesGlossary: korean ? '' : '太郎 → Taro\n部室 → clubroom', abort: AbortSignal.timeout(240_000),
  });
  for (const [i, row] of result.entries()) {
    assert.equal(row.source, sources[i]);
    assert.match(row.translation, expectEnglish[i], `Unexpected translation for ${JSON.stringify(sources[i])}: ${row.translation}`);
    assert.ok(!(korean ? /[\uac00-\ud7af]/u : /[\u3040-\u30ff]/u).test(row.translation),
      'Expected translated output, not echoed source script');
  }
  console.log(JSON.stringify({ model: model.id, elapsedMs: Date.now() - started, result }, null, 2));
} finally { await stopTranslationRuntime(); }
