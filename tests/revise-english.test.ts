import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  defaultReviseModels,
  FAST_REVISE_SAMPLES,
  isProofreaderTranslator,
  reviseCouncil,
  reviseSampleCount,
} from "../src/lib/regionAi";
import { translationModel } from "../src/lib/translationModels";

const root = await mkdtemp(join(tmpdir(), "scan-revise-"));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, "data");
process.env.DATABASE_URL = join(root, "test.db");

const { specialistRequest } = await import("../src/lib/server/specialistTranslation");
const { FAST_REVISE_TEMPERATURES, uniqueRevisions } = await import("../src/lib/server/reviseEnglish");

const hy = { engine: "hy-mt2-manga-v5", model: "" };
const qwen = { engine: "qwen3.8-27b-q4", model: "" };
const proofreader = { engine: "proofreader-a", model: "" };

test("Hy-MT revision samples several temperatures; thinking models sample once", () => {
  assert.equal(reviseSampleCount(hy), FAST_REVISE_SAMPLES);
  assert.equal(reviseSampleCount(qwen), 1);
  assert.equal(FAST_REVISE_TEMPERATURES.length, FAST_REVISE_SAMPLES);
  const spec = translationModel(hy.engine);
  assert.ok(spec);
  const sampled = specialistRequest(spec, "待って！", {
    seriesNotes: "",
    prior: "",
    pageLabel: "p1",
    seriesGlossary: "太郎 → Taro",
    temperature: FAST_REVISE_TEMPERATURES[2],
  });
  assert.equal(sampled.temperature, 0.65);
  assert.match(sampled.messages[0].content, /太郎 translates to Taro/);
});

test("default revise models keep translation, add proofreading when it is a different text model, and skip a proofreader", () => {
  assert.deepEqual(defaultReviseModels(hy, hy), [hy]);
  assert.deepEqual(defaultReviseModels(hy, qwen), [hy, qwen]);
  assert.deepEqual(defaultReviseModels(hy, proofreader), [hy]);
  assert.equal(isProofreaderTranslator(proofreader), true);
  assert.equal(isProofreaderTranslator({ engine: "proofreader-b", model: "" }), true);
  assert.equal(isProofreaderTranslator(hy), false);
});

test("a saved council replaces the translation and proofreading pair", () => {
  const settings = { translate: hy, proofread: qwen, reviseModels: [] as { engine: string; model: string }[] };
  assert.deepEqual(reviseCouncil(settings), [hy, qwen]);
  assert.deepEqual(reviseCouncil({ ...settings, reviseModels: [qwen, hy, proofreader, qwen] }), [qwen, hy]);
});

test("revision suggestions drop blanks, the current English, and duplicate wording", () => {
  assert.deepEqual(
    uniqueRevisions(
      [
        { text: "Wait!", reason: "a" },
        { text: "  wait!  ", reason: "b" },
        { text: "Hold on!", reason: "c" },
        { text: "", reason: "d" },
        { text: "Hold on!", reason: "e" },
      ],
      "Wait!",
    ),
    [{ text: "Hold on!", reason: "c" }],
  );
});
