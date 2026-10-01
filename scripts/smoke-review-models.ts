/** CPU inference smoke test. Usage: node --import tsx scripts/smoke-review-models.ts crop.jpg */
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const paths = process.argv.slice(2);
assert.ok(paths.length, 'Pass at least one local image crop');
const scratch = await mkdtemp(join(tmpdir(), 'scan-review-smoke-'));
await mkdir(join(scratch, 'data'));
process.env.DATABASE_URL = join(scratch, 'data/test.db');
process.env.SCAN_DATA_DIR = join(scratch, 'data');
const { reviewSource } = await import('../src/lib/server/regionAi');
const { installedLocalReviewModels, stopLocalReviewModels } = await import('../src/lib/server/localReview');
const models = installedLocalReviewModels();
assert.equal(models.length, 3, 'All three local review models must be installed');
try {
  for (const path of paths) {
    const image = await readFile(path);
    for (const model of models) {
      const start = Date.now();
      console.log(`Reviewing ${path} with ${model.id}…`);
      const result = await reviewSource({ engine: 'qwen', model: model.id }, image);
      assert.ok(result.answer);
      assert.ok(result.suggestions[0]?.text, `${model.id} must return a source reading on this text crop`);
      assert.ok(result.suggestions[0]?.translation, `${model.id} must return an English translation`);
      console.log(JSON.stringify({ path, model: model.id, milliseconds: Date.now() - start, ...result }));
    }
  }
} finally { stopLocalReviewModels(); }
