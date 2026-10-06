import type { PageData } from "../src/lib/workflow";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { readPsd, initializeCanvas } from "ag-psd";
import JSZip from "jszip";
import { deleteRegionNeedsConfirm } from "../src/lib/workflow";
import { orderRegions, placeRegionAfter } from "../src/lib/readingOrder";
import { SaveQueue } from "../src/lib/saveQueue";
import { DEFAULT_STYLE, type FittedLayout } from "../src/lib/workflow";
import type { ImageRow, LineRow } from "../src/lib/types";
import { maskRegion } from "../src/lib/maskRegions";
import { automaticRegionPolygon, bubbleFitPoints, regionOval, regionRectangle } from "../src/lib/regionGeometry";

process.env.LLAMASWAP_API_KEY = "test-fixture-key";
process.env.SCAN_ROOT = await mkdtemp(join(tmpdir(), "scan-tests-"));
process.env.DATABASE_URL = join(process.env.SCAN_ROOT, "data", "test.db");
process.env.SCAN_DATA_DIR = join(process.env.SCAN_ROOT, "data");

// The chat model ships as a launch preset, not a seed: the fixture store gets
// the row an operator adds in Setup → Local models, so the legacy "qwen" host
// resolves to a configured local chat model exactly as it did before.
const { createLocalHttpRow, updateRegistryRow, addCliSlug, upsertRegistryRow } = await import("../src/lib/server/modelRegistryStore");
const chatRow = createLocalHttpRow({
  name: "Qwen 3.8 27B",
  slug: "qwen3.8-27b-q4",
  apiKeyEnv: "LLAMASWAP_API_KEY",
});
updateRegistryRow(chatRow.id, { requestPreset: "qwen-thinking" });
const { fixturePasses } = await import('./local-ocr-fixture');
const { MODEL_TASK_IDS } = await import('../src/lib/modelTasks');
await fixturePasses(chatRow.id, MODEL_TASK_IDS);
for (const slug of ['independent-reviewer','review-fixture','fixture','chapter-engine','glossary-model','description-fixture','vision-fixture','translation-fixture','proofread-fixture','chosen-model','series-model']) {
  await fixturePasses(createLocalHttpRow({name:slug,slug,apiKeyEnv:'LLAMASWAP_API_KEY'}).id, MODEL_TASK_IDS);
}
for (const adapter of ['codex', 'grok'] as const) {
  upsertRegistryRow({ id: `${adapter}-default`, name: adapter, slug: '', access: 'cli', cliAdapter: adapter,
    operations: [...MODEL_TASK_IDS], roles: ['admin', 'translator', 'proofreader', 'typesetter'], seeded: false, operationsLocked: false });
  await fixturePasses(`${adapter}-default`, MODEL_TASK_IDS);
}
for (const slug of ['grok-translator-fixture', 'saved-grok-fixture']) {
  const row = addCliSlug('grok', slug);
  updateRegistryRow(row.id, { disabled: false });
  await fixturePasses(row.id, MODEL_TASK_IDS);
}


test("delete confirms only when a region has source or English", () => {
  const empty = { source: "", body: "" };
  assert.equal(deleteRegionNeedsConfirm(empty), false);
  assert.equal(deleteRegionNeedsConfirm({ source: "  ", body: "\n" }), false);
  assert.equal(deleteRegionNeedsConfirm({ source: "こんにちは", body: "" }), true);
  assert.equal(deleteRegionNeedsConfirm({ source: "", body: "Hello" }), true);
  assert.equal(deleteRegionNeedsConfirm(empty, { draft: { source: "下書き" } }), true);
  assert.equal(deleteRegionNeedsConfirm({ source: "保存済み", body: "Saved" }, { draft: { source: "", body: "" } }), false);
  assert.equal(deleteRegionNeedsConfirm(empty, { pendingSource: true }), true);
});

test("brush presets and inpaint start gating", async () => {
  const { BRUSH_PRESETS, nudgeBrush, brushSwatchPx, usesBrushSize } = await import("../src/lib/brush");
  assert.equal(usesBrushSize("brush"), true);
  assert.equal(usesBrushSize("select"), false);
  const { canStartClean } = await import("../src/lib/cleanMethods");
  assert.deepEqual([...BRUSH_PRESETS], [2, 4, 8, 12, 16, 32]);
  assert.equal(nudgeBrush(8, 1, 1, 200), 9);
  assert.equal(nudgeBrush(1, -1, 1, 200), 1);
  assert.equal(brushSwatchPx(32), 16);
  assert.equal(canStartClean(true, false, false, 3, ""), true);
  assert.equal(canStartClean(true, false, true, 0, ""), true);
  assert.equal(canStartClean(true, false, false, 0, ""), false);
  assert.equal(canStartClean(true, true, true, 0, ""), false);
  assert.equal(canStartClean(true, false, true, 0, "environment missing"), false);
});

test("clone stamp interpolates a brush path in native pixels", async () => {
  const { interpolateBrushPixels } = await import("../src/lib/cloneStamp");
  const line = interpolateBrushPixels([{ x: 0.1, y: 0.5 }, { x: 0.5, y: 0.5 }], 100, 80);
  assert.equal(line[0].x, 10);
  assert.equal(line[0].y, 40);
  assert.equal(line.at(-1)?.x, 50);
  assert.equal(line.at(-1)?.y, 40);
  assert.ok(line.length >= 40);
});

test("blur brush feather falls off to the edge", async () => {
  const { blurSigma, blurFeather } = await import("../src/lib/blurBrush");
  assert.equal(blurSigma(8), 4);
  assert.equal(blurFeather(0, 10), 1);
  assert.equal(blurFeather(10, 10), 0);
  assert.ok(blurFeather(5, 10) > 0.4 && blurFeather(5, 10) < 0.6);
});

test("Review uses the typeset copy unless Show raw is on", async () => {
  const { usesSourceArtwork } = await import("../src/lib/workflow");
  assert.equal(usesSourceArtwork("Review", false, true), false);
  assert.equal(usesSourceArtwork("Review", true, true), true);
  assert.equal(usesSourceArtwork("Review", false, false), true);
  assert.equal(usesSourceArtwork("Typeset", false, true), false);
  assert.equal(usesSourceArtwork("Translate", false, true), true);
  assert.equal(usesSourceArtwork("Prepare", false, true), true);
});

test("raw brush source is the uncleaned prepared page when it differs from the working copy", async () => {
  const { pageArtwork, pageRawArtwork } = await import("../src/lib/workflow");
  assert.equal(pageArtwork({ prepared: "prep", cleaned: "clean" }), "clean");
  assert.equal(pageRawArtwork({ prepared: "prep", cleaned: "clean" }), "prep");
  assert.equal(pageRawArtwork({ prepared: "prep" }), undefined);
  assert.equal(pageRawArtwork({ prepared: "prep", cleanBase: "prep" }), undefined);
});

test("Note is a region type", async () => {
  const { LINE_TYPES, LINE_TYPE_LABELS } = await import("../src/lib/types");
  const { LINE_COLORS } = await import("../src/lib/lineColors");
  const { allTypeStyles } = await import("../src/lib/workflow");
  const { parseTranslation, formatScript } = await import("../src/lib/parser");
  const { normalizeLineType } = await import("../src/lib/server/llm");
  assert.equal(LINE_TYPE_LABELS.note, "Note");
  assert.ok(LINE_TYPES.includes("note"));
  assert.ok(LINE_COLORS.note);
  assert.equal(allTypeStyles(undefined).note.size, allTypeStyles(undefined).plain.size);
  assert.equal(normalizeLineType("Note"), "note");
  assert.equal(parseTranslation("note: Hello").lines[0].lineType, "note");
  assert.match(formatScript([{ body: "Hello", lineType: "note" }]), /^note: Hello/);
});

test("Komatose 27B defaults to ISTA IQ3_S MTP GGUF", async () => {
  const saved = {
    SCAN_LLM_MODEL: process.env.SCAN_LLM_MODEL,
    SCAN_LLM_MMPROJ: process.env.SCAN_LLM_MMPROJ,
    SCAN_LLM_MODELS_DIR: process.env.SCAN_LLM_MODELS_DIR,
    SCAN_GPU_MODE: process.env.SCAN_GPU_MODE,
  };
  delete process.env.SCAN_LLM_MODEL;
  delete process.env.SCAN_LLM_MMPROJ;
  delete process.env.SCAN_LLM_MODELS_DIR;
  process.env.SCAN_GPU_MODE = "komatose";
  try {
    const { gpuClientStatus, qwen38MmprojPath, qwen38ModelPath } = await import("../src/lib/server/gpuMode");
    assert.match(qwen38ModelPath(), /ISTA-DASLab\/Qwen3\.8-27B-GSQ-RCO-GGUF\/Qwen3\.8-27B-GSQ-RCO-IQ3_S-mtp\.gguf$/);
    assert.match(qwen38MmprojPath(), /ISTA-DASLab\/Qwen3\.8-27B-GSQ-RCO-GGUF\/mmproj-Qwen3\.8-27B-BF16\.gguf$/);
    assert.match(gpuClientStatus().llm ?? "", /Managed local models/);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Qwen description models are labeled Qwen3-VL and Qwen 3.8 27B", async () => {
  const {
    QWEN3_VL_ID,
    QWEN_38_27B_ID,
    QWEN3_VL_LABEL,
    QWEN_38_27B_LABEL,
    describeQwenModels,
    isQwen3VlModel,
    qwenModelLabel,
  } = await import("../src/lib/qwenModels");
  const { GEMMA4_CHAT_IDS, gemma4ModelLabel } = await import("../src/lib/gemmaModels");
  assert.equal(qwenModelLabel("qwen3-vl-8b"), QWEN3_VL_LABEL);
  assert.equal(qwenModelLabel("qwen3.8-27b-q4"), QWEN_38_27B_LABEL);
  assert.equal(qwenModelLabel("qwen3.8-27b-q4 (default)"), QWEN_38_27B_LABEL);
  assert.equal(isQwen3VlModel("qwen3-vl-8b"), true);
  assert.equal(isQwen3VlModel(""), false);
  assert.deepEqual(describeQwenModels([{ id: "qwen3.8-27b-q4", label: "raw" }]), [
    { id: QWEN_38_27B_ID, label: QWEN_38_27B_LABEL },
    ...GEMMA4_CHAT_IDS.map((id) => ({ id, label: gemma4ModelLabel(id) })),
    { id: QWEN3_VL_ID, label: QWEN3_VL_LABEL },
  ]);
});

test("Grok, Codex, and Cursor reviewers are on-demand", async () => {
  const { isOnDemandReviewer } = await import("../src/lib/regionAi");
  const { listRegistryRows } = await import("../src/lib/server/modelRegistryStore");
  const live = listRegistryRows();
  assert.equal(isOnDemandReviewer({ engine: "qwen", model: "hayai-ocr-v2" }, live), false);
  // The chat model is configured, not seeded: hydrated to its row id it stays a
  // local reviewer. An engine with no row anywhere reads as on-demand (Run first).
  const chat = live.find((row) => row.id === "qwen3.8-27b-q4");
  assert.ok(chat, "the fixture store holds the configured chat row");
  assert.equal(isOnDemandReviewer({ engine: chat.id, model: "other-qwen" }, live), false);
  assert.equal(isOnDemandReviewer({ engine: "ghost-chat", model: "" }, live), true);
  assert.equal(isOnDemandReviewer({ engine: "grok", model: "grok-4.6" }, live), true);
  assert.equal(isOnDemandReviewer({ engine: "codex", model: "" }, live), true);
  assert.equal(isOnDemandReviewer({ engine: "cursor", model: "composer-2.5" }, live), true);
});

test("proofreaders are page-image proofread only", async () => {
  const { textEngines, isPageImageOnlyEngine } = await import("../src/lib/types");
  const { validateModel } = await import("../src/lib/server/regionAi");
  const { proofreaderOnlyMessage, proofreaderLabel } = await import("../src/lib/proofreaders");
  assert.equal(isPageImageOnlyEngine("proofreader-a"), true);
  assert.equal(isPageImageOnlyEngine("proofreader-b"), true);
  assert.deepEqual(textEngines([
    { id: "qwen" }, { id: "proofreader-a" }, { id: "proofreader-b" }, { id: "codex" },
  ]).map((e) => e.id), ["qwen", "codex"]);
  assert.deepEqual(validateModel({ engine: "proofreader-a", model: "" }), { engine: "proofreader-a", model: "" });
  assert.deepEqual(validateModel({ engine: "proofreader-b", model: "" }), { engine: "proofreader-b", model: "" });
  assert.match(proofreaderOnlyMessage("proofreader-a", "translation"), /only for Proofread raw \+ typeset images/);
  assert.match(proofreaderOnlyMessage("proofreader-b", "translation"), /only for Proofread raw \+ typeset images/);
  assert.equal(proofreaderLabel("proofreader-a"), "Proofreader A");
  assert.equal(proofreaderLabel("proofreader-b"), "Proofreader B");
  const {
    proofreadAttach,
    lastProofreadPageId,
    latestPageProofreadJob,
    unwrapProofreadCritique,
  } = await import("../src/lib/pageProofread");
  assert.equal(unwrapProofreadCritique('{"critique":"Fix the SFX."}'), "Fix the SFX.");
  assert.match(unwrapProofreadCritique("```json\n{\"critique\":\"Shorten panel 2.\"}\n```"), /Shorten panel 2/);
  assert.equal(unwrapProofreadCritique("Plain prose critique."), "Plain prose critique.");
  assert.match(unwrapProofreadCritique('{"critique":{"panel 1":"Shorten the burst."}}'), /Shorten the burst/);
  assert.equal(proofreadAttach("p1", "c1"), "both");
  assert.equal(proofreadAttach("p1", "c1", { imageId: "p1", conversation: "c1" }), "typeset");
  assert.equal(proofreadAttach("p2", "c1", { imageId: "p1", conversation: "c1" }), "both");
  assert.equal(proofreadAttach("p1", "c2", { imageId: "p1", conversation: "c1" }), "both");
  assert.equal(lastProofreadPageId([
    { kind: "page-proofread", state: "completed", payload: { engine: "proofreader-a", imageId: "p2" } },
    { kind: "page-proofread", state: "completed", payload: { engine: "proofreader-a", imageId: "p1" } },
  ]), "p2");
  assert.equal(lastProofreadPageId([
    { kind: "page-proofread", state: "completed", payload: { engine: "proofreader-b", imageId: "p9" } },
  ], "proofreader-b"), "p9");
  assert.equal(latestPageProofreadJob([
    { kind: "translate", id: "t" },
    { kind: "page-proofread", id: "c1" },
    { kind: "page-proofread", id: "c2" },
  ])?.id, "c1");
});

test("series glossary helpers merge lists, lock accepted terms, and flag English mismatches", async () => {
  const {
    mergeGlossaryLists,
    acceptGlossaryTerm,
    glossaryMismatches,
    textHasTerm,
    glossaryPrompt,
    glossaryForSource,
    glossaryHits,
  } = await import("../src/lib/glossary");
  const merged = mergeGlossaryLists(
    [{ source: "太郎", translation: "Taro" }],
    [{ source: "太郎", translation: "Tarou", edited: true }, { source: "東京", translation: "Tokyo", edited: true }],
    [{ source: "東京", translation: "Tōkyō" }],
  );
  assert.deepEqual(merged, [
    { source: "太郎", translation: "Tarou", edited: true },
    { source: "東京", translation: "Tokyo", edited: true },
  ]);
  const locked = acceptGlossaryTerm(merged, "花子", "Hanako");
  assert.equal(locked.changed, true);
  assert.deepEqual(acceptGlossaryTerm(locked.terms, "花子", "Hana").changed, false);
  assert.equal(textHasTerm("待って、太郎！", "太郎"), true);
  assert.equal(textHasTerm("Taro waved", "Taro"), true);
  assert.equal(textHasTerm("Takumi-sama, you need to sleep", "Takumi"), true);
  assert.equal(textHasTerm("Wait!! Takumi-\nkun as a girl!?", "Takumi-kun"), true);
  assert.equal(glossaryMismatches("匠くん", "Takumi-sama, you need to sleep", [{ source: "匠くん", translation: "Takumi", edited: true }]).length, 0);
  assert.equal(glossaryMismatches("匠くん", "Wait!! Takumi-\nkun as a girl!?", [{ source: "匠くん", translation: "Takumi-kun", edited: true }]).length, 0);
  const misses = glossaryMismatches("太郎が来た", "He arrived", [{ source: "太郎", translation: "Taro", edited: true }]);
  assert.equal(misses.length, 1);
  assert.equal(glossaryMismatches("太郎が来た", "Taro arrived", [{ source: "太郎", translation: "Taro", edited: true }]).length, 0);
  assert.match(glossaryPrompt(locked.terms), /太郎 → Tarou/);
  assert.match(glossaryForSource(locked.terms, "太郎が来た"), /太郎 → Tarou/);
  assert.ok(!glossaryForSource(locked.terms, "太郎が来た").includes("東京"));
  assert.equal(glossaryForSource(locked.terms, "誰もいない"), "");
  const chips = glossaryHits(
    [
      { source: "東京駅", translation: "Tokyo Station", edited: true },
      { source: "東京", translation: "Tokyo", edited: true },
      { source: "東京", translation: "Tōkyō" },
      { source: "花子", translation: "Hanako", edited: true },
    ],
    "東京駅の太郎",
  );
  assert.deepEqual(
    chips.map((term) => `${term.source} → ${term.translation}`),
    ["東京駅 → Tokyo Station", "東京 → Tokyo"],
  );
});

test("automatic polygons fall back by area, independent of winding and page scale", () => {
  const line = { x: .2, y: .2, w: .5, h: .5 };
  const rectangle = regionRectangle(line);
  const oval = regionOval(line, 16);
  assert.equal(oval.length, 16);
  assert.ok(oval.every((p) => p.x >= line.x - 1e-9 && p.x <= line.x + line.w + 1e-9));
  assert.ok(oval.every((p) => p.y >= line.y - 1e-9 && p.y <= line.y + line.h + 1e-9));
  const cx = line.x + line.w / 2, cy = line.y + line.h / 2;
  assert.ok(oval.some((p) => Math.abs(p.x - (cx + line.w / 2)) < 1e-9 && Math.abs(p.y - cy) < 1e-9));
  const tiny = [{ x: .3, y: .3 }, { x: .31, y: .3 }, { x: .31, y: .31 }];
  assert.deepEqual(automaticRegionPolygon(line, tiny), rectangle);
  assert.deepEqual(automaticRegionPolygon(line, []), rectangle);
  // A thin triangle has large bounds but very little usable area.
  assert.deepEqual(automaticRegionPolygon(line, [{ x: .2, y: .2 }, { x: .7, y: .7 }, { x: .69, y: .7 }]), rectangle);
  const interior = [{ x: .25, y: .25 }, { x: .65, y: .25 }, { x: .45, y: .65 }];
  assert.deepEqual(automaticRegionPolygon(line, interior), interior);
  assert.deepEqual(automaticRegionPolygon(line, [...interior].reverse()), [...interior].reverse());
  const smallRegion = { x: .3, y: .3, w: .01, h: .01 };
  assert.equal(automaticRegionPolygon(smallRegion, tiny), tiny);
  assert.deepEqual(bubbleFitPoints(line), [{ x: .45, y: .45 }]);
  assert.deepEqual(bubbleFitPoints(line, interior), interior);
});

test("contain mapping uses the letterboxed bitmap, not the full CSS box", async () => {
  const { containDisplayRect, containContentPoint } = await import("../src/lib/containBox");
  const box = { left: 100, top: 50, width: 400, height: 200 };
  const shown = containDisplayRect(box, 100, 100);
  assert.equal(shown.width, 200);
  assert.equal(shown.height, 200);
  assert.equal(shown.left, 200);
  assert.equal(shown.top, 50);
  const center = containContentPoint(300, 150, box, 100, 100);
  assert.equal(center?.x, 50);
  assert.equal(center?.y, 50);
  const leftGutter = containContentPoint(150, 150, box, 100, 100);
  assert.ok(leftGutter && leftGutter.x < 0);
});

test("automask uses saved polygons or explicit boxes and skips ignored/unplaced regions", () => {
  const line = { x: .1, y: .2, w: .3, h: .4, sourceState: "read" as const };
  assert.deepEqual(maskRegion(line), [
    { x: .1, y: .2 }, { x: .4, y: .2 },
    { x: .4, y: .2 + .4 }, { x: .1, y: .2 + .4 },
  ]);
  const polygon = [{ x: .1, y: .2 }, { x: .4, y: .2 }, { x: .2, y: .4 }];
  assert.deepEqual(maskRegion(line, { polygon }), polygon);
  assert.deepEqual(maskRegion({ ...line, sourceState: "ignored" }, { polygon }), []);
  assert.deepEqual(maskRegion({ ...line, x: null }), []);
  assert.deepEqual(maskRegion({ ...line, w: 0 }), []);
});

const { sqlite, db } = await import("../src/lib/server/db/index");
const exportFixtures = join(process.env.SCAN_ROOT, "exports");
await mkdir(exportFixtures, { recursive: true });
const schema = await import("../src/lib/server/db/schema");
const { getDoc, putDoc, suggest, storeAsset, rejectPendingSuggestions, previousSavedArtwork } =
  await import("../src/lib/server/workflowStore");
const { uploadFont, fitText, availableSpan, dictionaryFragments, layoutKey } =
  await import("../src/lib/server/typesetting");
const { renumberPages, acceptSuggestion, preparePage, readiness, fitRegion } =
  await import("../src/lib/server/workflowService");
const { listImages, listLines, getSeries, getEpisode } =
  await import("../src/lib/server/queries");
const { buildExport, captureExport, finishedPsd, pagePng, renderPage } =
  await import("../src/lib/server/finishedExport");
const { saveImageFile, readWorkingOrOrig } = await import("../src/lib/server/storage");

sqlite
  .prepare("INSERT INTO users(id, username, password_hash, role, created_at) VALUES(?,?,?,?,?)")
  .run("u", "test", "unused", "admin", 1);
sqlite
  .prepare(
    "INSERT INTO series(id,slug,title,created_at,updated_at) VALUES('s','series','Test series',1,1)",
  )
  .run();
sqlite
  .prepare(
    "INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES('e','s','chapter','Chapter',1,1)",
  )
  .run();
const source = await sharp(
  Buffer.from(
    '<svg width="600" height="400"><rect width="600" height="400" fill="white"/><ellipse cx="300" cy="200" rx="210" ry="140" fill="white" stroke="black" stroke-width="5"/></svg>',
  ),
)
  .png()
  .toBuffer();
const saved = await saveImageFile({
  seriesSlug: "series",
  episodeSlug: "chapter",
  sortOrder: 0,
  originalName: "original.png",
  bytes: source,
  mime: "image/png",
});
await db.insert(schema.images).values({
  id: "p",
  episodeId: "e",
  originalName: "original.png",
  ...saved,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
});
await db.insert(schema.lines).values({
  id: "l",
  episodeId: "e",
  imageId: "p",
  source: "こんにちは",
  sourceState: "read",
  body: "Hello, my friend!",
  lineType: '""',
  status: "approved",
  placed: true,
  x: 0.2,
  y: 0.25,
  w: 0.6,
  h: 0.5,
  sortOrder: 0,
  updatedAt: 1,
});
const series = (await getSeries("s"))!,
  episode = (await getEpisode("e"))!;

test("paid source reviews require an individual selection of the exact engine and model", async () => {
  const { validateReviewers } = await import("../src/lib/server/regionAi");
  const { hydrateTaskEngine } = await import("../src/lib/modelRegistry");
  const { listRegistryRows } = await import("../src/lib/server/modelRegistryStore");
  const local = { engine: "qwen", model: "" };
  // validateModel hydrates against the live rows: the chat model is operator-
  // added now, so only the store — not the seed table — resolves legacy "qwen".
  const live = listRegistryRows();
  assert.deepEqual(validateReviewers([local]), [hydrateTaskEngine(local, live)]);
  for (const engine of ["grok", "codex", "cursor"]) {
    for (const model of ["", "selected-model"]) {
      const paid = { engine, model };
      for (const selected of [undefined, { ...paid, model: "different-model" }, local])
        assert.throws(() => validateReviewers([paid], selected), /Select a paid reviewer/);
      assert.throws(() => validateReviewers([local, paid], paid), /Select a paid reviewer/);
      assert.deepEqual(validateReviewers([paid], paid), [hydrateTaskEngine(paid, live)]);
    }
  }
  assert.throws(() => validateReviewers([{ engine: "unknown", model: "" }]), /valid engine/);
});

test("review API rejects unselected paid models before accessing the crop or calling any engine", async () => {
  const { POST } = await import("../src/routes/api/episodes/[eid]/region-ai/+server");
  await db.insert(schema.lines).values({ id: "paid-review-guard", episodeId: "e", source: "", body: "",
    lineType: "plain", sortOrder: 0, updatedAt: 1 });
  const line = (await listLines("e")).find(l => l.id === "paid-review-guard")!;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("Unexpected model call"); };
  try {
    for (const engine of ["grok", "codex", "cursor"]) {
      const response = await POST({
        locals: { user: { id: "u", username: "test", role: "admin" } },
        params: { eid: "e" },
        request: new Request("http://local/region-ai", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "review", lineId: line.id, expectedRevision: line.revision,
            reviewers: [{ engine, model: "" }] }) }),
      } as any);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /Select a paid reviewer/);
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.prepare("DELETE FROM lines WHERE id='paid-review-guard'").run();
  }
});

test("blank region cleanup spans a chapter, preserves either text field, and leaves other chapters alone", async () => {
  const { removeBlankRegions } = await import("../src/lib/server/workflowService");
  sqlite.prepare("INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES('blank-e','s','blank','Blank cleanup',1,1)").run();
  sqlite.prepare("INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES('blank-other','s','blank-other','Other chapter',1,1)").run();
  try {
    for (const [id, source, body, episodeId] of [
      ['blank-empty', '', '', 'blank-e'],
      ['blank-space', ' \t\n\u3000', '\r\n\u00a0', 'blank-e'],
      ['blank-source', '未翻訳', '', 'blank-e'],
      ['blank-english', '', 'Translation', 'blank-e'],
      ['blank-both', '原文', 'Text', 'blank-e'],
      ['blank-elsewhere', '', '', 'blank-other'],
    ]) {
      await db.insert(schema.lines).values({ id, episodeId, source, body, updatedAt: 1 });
    }
    await db.insert(schema.comments).values({ id: 'blank-comment', lineId: 'blank-empty', userId: 'u', body: 'False detection', createdAt: 1 });
    putDoc('blank-e', 'region:blank-empty', { geometryApproved: true }, 0);
    assert.deepEqual(removeBlankRegions('blank-e').sort(), ['blank-empty', 'blank-space']);
    assert.deepEqual((await listLines('blank-e')).map(l => l.id).sort(), ['blank-both', 'blank-english', 'blank-source']);
    assert.equal((await listLines('blank-other')).length, 1);
    assert.equal(sqlite.prepare("SELECT id FROM comments WHERE id='blank-comment'").get(), undefined);
    assert.equal(getDoc('region:blank-empty', {}).revision, 1, 'Region history remains available');
    assert.deepEqual(removeBlankRegions('blank-e'), []);
  } finally {
    sqlite.prepare("DELETE FROM episodes WHERE id IN ('blank-e', 'blank-other')").run();
  }
});

test("bulk geometry approval clears chapter geometry issues, preserves other data, and supports undo", async () => {
  const { approveAllGeometry } = await import("../src/lib/server/workflowService");
  await db.insert(schema.episodes).values({
    id: "geometry-e", seriesId: "s", slug: "geometry", title: "Geometry", createdAt: 1, updatedAt: 1,
  });
  try {
    for (let i = 0; i < 2; i++) {
      await db.insert(schema.images).values({
        id: `geometry-page-${i}`, episodeId: "geometry-e", ...saved,
        originalName: "original.png", sortOrder: i, createdAt: 1, updatedAt: 1,
      });
    }
    for (const [id, imageId, sourceState, ignoreReason] of [
      ["geometry-polygon", "geometry-page-0", "read", ""],
      ["geometry-box", "geometry-page-1", "read", ""],
      ["geometry-approved", "geometry-page-0", "read", ""],
      ["geometry-ignored", "geometry-page-1", "ignored", "Decorative text"],
      ["geometry-unassigned", null, "read", ""],
    ] as const) {
      await db.insert(schema.lines).values({
        id, episodeId: "geometry-e", imageId, sourceState, ignoreReason,
        source: "原文", body: "Text", x: .2, y: .2, w: .3, h: .3, updatedAt: 1,
      });
    }
    const original = {
      polygon: regionRectangle({ x: .1, y: .1, w: .5, h: .5 }),
      geometryApproved: false, geometryConfidence: .8, locked: true,
      style: { fontSize: 24 },
    };
    putDoc("geometry-e", "region:geometry-polygon", original, 0);
    const alreadyApproved = putDoc("geometry-e", "region:geometry-approved", { geometryApproved: true }, 0);
    const otherChapter = getDoc("region:l", {});
    const ep = (await getEpisode("geometry-e"))!;
    const imgs = await listImages(ep.id), lns = await listLines(ep.id);
    const before = readiness(series, ep, imgs, lns);
    assert.equal(before.filter(issue => issue.code === "geometry").length, 2);

    assert.equal(approveAllGeometry(ep.id), 2);
    const after = readiness(series, ep, imgs, lns);
    assert.deepEqual(after, before.filter(issue => issue.code !== "geometry"));
    assert.deepEqual(getDoc("region:geometry-polygon", {}).data, { ...original, geometryApproved: true });
    assert.deepEqual(getDoc("region:geometry-box", {}).data, { geometryApproved: true });
    assert.deepEqual(getDoc("region:geometry-approved", {}), alreadyApproved);
    assert.equal(getDoc("region:geometry-ignored", {}).revision, 0);
    assert.equal(getDoc("region:geometry-unassigned", {}).revision, 0);
    assert.deepEqual(getDoc("region:l", {}), otherChapter);
    assert.deepEqual(await listLines(ep.id), lns);
    assert.equal(approveAllGeometry(ep.id), 0, "Repeated approval is a no-op");
    const approved = getDoc("region:geometry-polygon", {});
    assert.deepEqual(putDoc(ep.id, approved.id, {}, approved.revision, "undo").data, original);
  } finally {
    sqlite.prepare("DELETE FROM episodes WHERE id='geometry-e'").run();
  }
});

test("bulk translation approval marks English as accepted, drops leftover suggestions, and supports a no-op repeat", async () => {
  const { approveAllTranslations } = await import("../src/lib/server/workflowService");
  await db.insert(schema.episodes).values({
    id: "accept-e", seriesId: "s", slug: "accept", title: "Accept", createdAt: 1, updatedAt: 1,
  });
  try {
    await db.insert(schema.images).values({
      id: "accept-page", episodeId: "accept-e", ...saved,
      originalName: "original.png", sortOrder: 0, createdAt: 1, updatedAt: 1,
    });
    for (const [id, imageId, sourceState, ignoreReason, body, status] of [
      ["accept-open", "accept-page", "read", "", "Hello", "needs_work"],
      ["accept-empty", "accept-page", "read", "", "", "none"],
      ["accept-approved", "accept-page", "read", "", "Already fine", "approved"],
      ["accept-ignored", "accept-page", "ignored", "SFX only", "Boom", "none"],
      ["accept-unplaced", null, "read", "", "Off-page", "none"],
    ] as const) {
      await db.insert(schema.lines).values({
        id, episodeId: "accept-e", imageId, sourceState, ignoreReason, source: "原文",
        body, status, x: .2, y: .2, w: .3, h: .3, updatedAt: 1,
      });
    }
    const leftover = suggest("accept-e", "accept-open", 0, "Leftover after accept", "", "translation");
    const other = (await listLines("e"))[0];
    const otherStatus = other.status;
    suggest("e", other.id, other.revision ?? 0, "Other chapter stays pending", "", "translation");
    const ep = (await getEpisode("accept-e"))!;
    const before = readiness(series, ep, await listImages(ep.id), await listLines(ep.id));
    assert.ok(before.some((issue) => issue.code === "review" && issue.lineId === "accept-open"));
    assert.ok(before.some((issue) => issue.code === "review" && issue.lineId === "accept-empty"));

    assert.equal(approveAllTranslations(ep.id, "u"), 2);
    const after = await listLines(ep.id);
    assert.equal(after.find((l) => l.id === "accept-open")?.status, "approved");
    assert.equal(after.find((l) => l.id === "accept-unplaced")?.status, "approved");
    assert.equal(after.find((l) => l.id === "accept-empty")?.status, "none");
    assert.equal(after.find((l) => l.id === "accept-approved")?.status, "approved");
    assert.equal(after.find((l) => l.id === "accept-ignored")?.status, "none");
    assert.equal((sqlite.prepare("SELECT state FROM suggestions WHERE id=?").get(leftover) as { state: string }).state, "rejected");
    assert.equal((await listLines("e")).find((l) => l.id === other.id)?.status, otherStatus);
    assert.equal((sqlite.prepare("SELECT state FROM suggestions WHERE body=?").get("Other chapter stays pending") as { state: string }).state, "pending");
    const issues = readiness(series, ep, await listImages(ep.id), after);
    assert.equal(issues.filter((issue) => issue.code === "review" && issue.lineId === "accept-open").length, 0);
    assert.ok(issues.some((issue) => issue.code === "review" && issue.lineId === "accept-empty"));
    assert.equal(approveAllTranslations(ep.id, "u"), 0, "Repeated acceptance is a no-op");
  } finally {
    sqlite.prepare("DELETE FROM episodes WHERE id='accept-e'").run();
  }
});

test("an explicit ignore is enough for a page without text", async () => {
  await db.insert(schema.episodes).values({
    id: "ignore-e", seriesId: "s", slug: "ignore-page", title: "Ignore",
    createdAt: 1, updatedAt: 1, numberingStale: false,
  });
  try {
    await db.insert(schema.images).values({
      id: "ignore-page", episodeId: "ignore-e", ...saved,
      originalName: "blank.png", sortOrder: 0, pageNumber: 1, createdAt: 1, updatedAt: 1,
    });
    await db.insert(schema.lines).values({
      id: "ignore-line", episodeId: "ignore-e", imageId: "ignore-page",
      sourceState: "ignored", ignoreReason: "No lettering", source: "", body: "",
      x: 0.1, y: 0.1, w: 0.2, h: 0.2, updatedAt: 1,
    });
    sqlite.prepare("UPDATE episodes SET numbering_stale=0 WHERE id='ignore-e'").run();
    renumberPages("ignore-e");
    const ep = (await getEpisode("ignore-e"))!;
    const issues = readiness(series, ep, await listImages(ep.id), await listLines(ep.id));
    assert.deepEqual(issues.filter((issue) => issue.code !== "step-complete").map((issue) => issue.code).sort(), []);
    assert.equal(issues.filter((issue) => issue.code === "step-complete").length, 4);
  } finally {
    sqlite.prepare("DELETE FROM episodes WHERE id='ignore-e'").run();
  }
});

test("keep current layouts accepts stale placements without refitting glyphs", async () => {
  const { keepCurrentLayouts } = await import("../src/lib/server/workflowService");
  await db.insert(schema.episodes).values({
    id: "stale-e", seriesId: "s", slug: "stale-keep", title: "Stale",
    createdAt: 1, updatedAt: 1, numberingStale: false,
  });
  try {
    await db.insert(schema.images).values({
      id: "stale-page", episodeId: "stale-e", ...saved,
      originalName: "page.png", sortOrder: 0, pageNumber: 1, createdAt: 1, updatedAt: 1,
    });
    await db.insert(schema.lines).values({
      id: "stale-line", episodeId: "stale-e", imageId: "stale-page",
      sourceState: "read", source: "原文", body: "Boom", status: "approved",
      x: 0.1, y: 0.1, w: 0.4, h: 0.3, updatedAt: 1,
    });
    const layout = {
      key: "outdated",
      rows: [{ text: "Boom", x: 12, baseline: 40, width: 50 }],
      size: 14,
      dpi: 72,
      width: saved.width,
      height: saved.height,
      svg: "<svg></svg>",
      overflow: false,
      missingGlyphs: [],
      hyphenated: false,
      style: { ...DEFAULT_STYLE },
      font: { id: "x", hash: "x", postscriptName: "Test" },
    };
    putDoc("stale-e", "region:stale-line", { layout }, 0);
    assert.equal(keepCurrentLayouts("stale-e"), 1);
    const kept = getDoc<any>("region:stale-line", {}).data.layout;
    assert.equal(kept.rows[0].text, "Boom");
    assert.equal(kept.size, 14);
    assert.notEqual(kept.key, "outdated");
    assert.equal(keepCurrentLayouts("stale-e"), 0);
  } finally {
    sqlite.prepare("DELETE FROM episodes WHERE id='stale-e'").run();
  }
});

test("source advisory acceptance preserves original punctuation and English until English is accepted", async () => {
  await db.insert(schema.lines).values({ id: 'advisory-line', episodeId: 'e', imageId: 'p',
    source: 'あ', sourceState: 'read', body: 'Keep this English', lineType: 'plain',
    sortOrder: 999, status: 'approved', updatedAt: 1 });
  const line = (await listLines('e')).find(l => l.id === 'advisory-line')!;
  const sourceId = suggest('e', line.id, line.revision!, 'えーっ——？', 'Reviewer A', 'source-review');
  assert.equal(suggest('e', line.id, line.revision!, 'えーっ——？', 'Reviewer B', 'source-review'), sourceId);
  const attribution = (sqlite.prepare('SELECT reason FROM suggestions WHERE id=?').get(sourceId) as any).reason;
  assert.match(attribution, /Reviewer A/); assert.match(attribution, /Reviewer B/);
  const englishId = suggest('e', line.id, line.revision!, 'Really?', 'Chat', 'enquiry');
  acceptSuggestion('e', sourceId, 'u', 'accept');
  const updated = (await listLines('e')).find(l => l.id === line.id)!;
  assert.equal(updated.source, 'えーっ——？');
  assert.equal(updated.body, 'Keep this English');
  assert.equal(updated.status, 'needs_work');
  assert.equal(updated.ocrConfidence, null);
  assert.equal((sqlite.prepare('SELECT state FROM suggestions WHERE id=?').get(englishId) as any).state, 'pending');
  acceptSuggestion('e', englishId, 'u', 'accept');
  const final = (await listLines('e')).find(l => l.id === line.id)!;
  assert.equal(final.body, 'Really?');
  assert.equal(final.source, 'えーっ——？');
  sqlite.prepare('DELETE FROM lines WHERE id=?').run(line.id);
});

test("Enquire uses corrected saved text without resurrecting legacy OCR annotations", async () => {
  const { enquiryContext } = await import('../src/lib/server/regionAi');
  const { DEFAULT_ENQUIRY_CONTEXT } = await import('../src/lib/regionAi');
  await db.insert(schema.lines).values({ id: 'context-corrected', episodeId: 'e', imageId: 'p',
    source: 'Original OCR', body: 'Original English', lineType: 'plain', sortOrder: 999, updatedAt: 1 });
  for (const [i, body] of ['Source: Original OCR', 'Literal: Original literal', 'Note: Original reasoning', 'Keep the speaker polite'].entries())
    await db.insert(schema.comments).values({ id: `context-comment-${i}`, lineId: 'context-corrected', userId: 'u', body, correction: false, createdAt: i });
  const before = (await listLines('e')).find(l => l.id === 'context-corrected')!;
  acceptSuggestion('e', suggest('e', before.id, before.revision!, '訂正済み', '', 'source-review'), 'u', 'accept');
  const sourceCorrected = (await listLines('e')).find(l => l.id === before.id)!;
  acceptSuggestion('e', suggest('e', before.id, sourceCorrected.revision!, 'Corrected English', '', 'enquiry'), 'u', 'accept');
  const line = (await listLines('e')).find(l => l.id === before.id)!;
  const pages = await listImages('e');
  const result = await enquiryContext(series, episode, line, pages[0], pages, DEFAULT_ENQUIRY_CONTEXT);
  const region = JSON.parse(result.text).region;
  assert.equal(region.source, '訂正済み');
  assert.equal(region.english, 'Corrected English');
  assert.deepEqual(region.comments, [{ text: 'Keep the speaker polite', correction: false }]);
  assert.doesNotMatch(result.text, /Original OCR|Original English|Original literal|Original reasoning/);
  assert.equal((sqlite.prepare('SELECT count(*) n FROM comments WHERE line_id=?').get(line.id) as any).n, 4);
  sqlite.prepare('DELETE FROM lines WHERE id=?').run(line.id);
});

test("accepted source corrections retranslate with the configured model and protect concurrent edits", async () => {
  const { acceptRegionSuggestion, startSourceRetranslation, cancelSourceRetranslation } = await import('../src/lib/server/aiTranslate');
  const { listJobs } = await import('../src/lib/server/jobs');
  sqlite.prepare("INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES('correct-e','s','correct','Corrections',1,1)").run();
  const ep = (await getEpisode('correct-e'))!;
  putDoc(ep.id, `chapter:${ep.id}`, { regionAi: { translate: { engine: 'qwen', model: 'corrected-translation-model' },
    vision: { engine: 'qwen', model: 'must-not-read-image' } } }, 0);
  const user = { id: 'u', username: 'test', role: 'admin' as const };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let duringTranslation: (() => void) | undefined;
  let empty = false;
  globalThis.fetch = async (_url, init) => {
    if (!init?.body) return Response.json({ data: [] });
    const payload = JSON.parse(String(init.body));
    calls++;
    assert.equal(payload.model, 'corrected-translation-model');
    assert.match(payload.messages[0].content, /^You translate/);
    assert.match(payload.messages[1].content, /えーっ——？/);
    assert.doesNotMatch(payload.messages[1].content, /Original OCR/);
    duringTranslation?.();
    return Response.json({ choices: [{ message: { content: JSON.stringify({ items: [
      { i: 0, translation: empty ? '' : 'Really?', literal: 'surprise', reasoning: 'Corrected source' },
    ] }) } }] });
  };
  async function settled(jobId: string) {
    for (let i = 0; i < 500; i++) {
      const job = listJobs(ep.id).find(j => j.id === jobId)!;
      if (!['running', 'queued'].includes(job.state)) return job;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Source translation did not finish');
  }
  async function fixture(id: string, kind = 'source-review') {
    await db.insert(schema.lines).values({ id, episodeId: ep.id, source: 'Original OCR', body: 'Old English',
      lineType: 'plain', sourceState: 'read', status: 'approved', sortOrder: 0, updatedAt: 1 });
    const line = (await listLines(ep.id)).find(l => l.id === id)!;
    return { id: suggest(ep.id, id, line.revision!, 'えーっ——？', 'Reviewer', kind), series, episode: ep, user, decision: 'accept' };
  }
  try {
    const input = await fixture('correct-normal');
    const accepted = acceptRegionSuggestion(input);
    assert.ok(accepted.jobId);
    const first = await settled(accepted.jobId);
    assert.equal(first.state, 'completed', first.error || undefined);
    const line = (await listLines(ep.id)).find(l => l.id === 'correct-normal')!;
    assert.equal(line.source, 'えーっ——？');
    assert.equal(line.body, 'Really?');
    assert.equal(line.status, 'needs_work');
    assert.equal(calls, 1);
    assert.deepEqual(acceptRegionSuggestion(input), {}, 'duplicate acceptance must not retranslate');
    assert.deepEqual(acceptRegionSuggestion({ ...input, id: suggest(ep.id, line.id, line.revision!, line.source, '', 'source-review') }), {});
    const pairedInput = await fixture('correct-paired');
    sqlite.prepare("UPDATE suggestions SET translation='Already English' WHERE id=?").run(pairedInput.id);
    assert.deepEqual(acceptRegionSuggestion(pairedInput), {}, 'paired English must not retranslate');
    const pairedLine = (await listLines(ep.id)).find(l => l.id === 'correct-paired')!;
    assert.equal(pairedLine.source, 'えーっ——？');
    assert.equal(pairedLine.body, 'Already English');
    assert.equal(calls, 1);
    const rejected = await fixture('correct-reject');
    assert.deepEqual(acceptRegionSuggestion({ ...rejected, decision: 'reject' }), {});
    assert.equal(calls, 1);
    for (const field of ['body', 'source'] as const) {
      const id = `correct-concurrent-${field}`;
      const input = await fixture(id, 'source-enquiry');
      duringTranslation = () => sqlite.prepare(`UPDATE lines SET ${field}=? WHERE id=?`).run('Concurrent human edit', id);
      const job = acceptRegionSuggestion(input);
      assert.ok(job.jobId);
      assert.equal((await settled(job.jobId)).state, 'failed');
      const kept = (await listLines(ep.id)).find(l => l.id === id)!;
      assert.equal(kept[field], 'Concurrent human edit');
      const suggestion = sqlite.prepare("SELECT id,base_revision,body FROM suggestions WHERE line_id=? AND kind='translation'").get(id) as any;
      assert.ok(suggestion.base_revision < kept.revision!);
      acceptSuggestion(ep.id, suggestion.id, user.id, 'accept');
      assert.equal((await listLines(ep.id)).find(l => l.id === id)!.body, suggestion.body);
    }
    duringTranslation = undefined;
    const stale = await fixture('correct-stale');
    sqlite.prepare("UPDATE lines SET body='Manual edit' WHERE id='correct-stale'").run();
    const started = acceptRegionSuggestion(stale);
    assert.ok(started.jobId);
    assert.equal((await settled(started.jobId)).state, 'completed');
    const failedInput = await fixture('correct-failure');
    empty = true;
    const failed = acceptRegionSuggestion(failedInput);
    assert.ok(failed.jobId);
    const failedJob = await settled(failed.jobId);
    assert.equal(failedJob.state, 'failed');
    const failedLine = (await listLines(ep.id)).find(l => l.id === 'correct-failure')!;
    assert.equal(failedLine.source, 'えーっ——？');
    assert.equal(failedLine.body, 'Old English');
    empty = false;
    // The route replays the stored payload into the starter that saved it.
    const retrySource = () =>
      startSourceRetranslation(
        { ...failedJob.payload, series, episode: ep, user } as Parameters<
          typeof startSourceRetranslation
        >[0],
      );
    const retry = retrySource();
    assert.equal((await settled(retry.jobId)).state, 'completed');
    assert.throws(() => retrySource(), /changed/);
    const cancelledInput = await fixture('correct-cancel');
    const cancelled = acceptRegionSuggestion(cancelledInput);
    assert.ok(cancelled.jobId);
    cancelSourceRetranslation(cancelled.jobId);
    assert.equal((await settled(cancelled.jobId)).state, 'cancelled');
    assert.equal((await listLines(ep.id)).find(l => l.id === 'correct-cancel')!.body, 'Old English');
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.prepare('DELETE FROM episodes WHERE id=?').run(ep.id);
  }
});

test("enquiry attaches only selected context and images and validates model output", async () => {
  const { enquiryContext, parseAdvisory, validateHistory, validateContext, regionTarget } = await import('../src/lib/server/regionAi');
  const { DEFAULT_ENQUIRY_CONTEXT, CONTEXT_OPTIONS } = await import('../src/lib/regionAi');
  const line = (await listLines('e')).find(l => l.id === 'l')!;
  const pages = await listImages('e');
  const none = Object.fromEntries(CONTEXT_OPTIONS.map(([key]) => [key, false]));
  const empty = await enquiryContext(series, episode, line, pages[0], pages, validateContext(none));
  assert.deepEqual(JSON.parse(empty.text), {});
  assert.equal(empty.images.length, 0);
  const defaults = await enquiryContext(series, episode, line, { ...pages[0], caption: 'Page summary fixture' }, pages, DEFAULT_ENQUIRY_CONTEXT);
  assert.deepEqual(Object.keys(JSON.parse(defaults.text)).sort(), ['pageSummary', 'region', 'seriesSummary']);
  assert.equal(defaults.images.length, 0);
  const withImages = await enquiryContext(series, episode, line, pages[0], pages, validateContext({ ...none, regionImage: true, pageImage: true }));
  assert.deepEqual(withImages.attachments, ['Region Image', 'Page Image']);
  assert.equal(withImages.images.length, 2);
  const crop = await sharp(withImages.images[0]).metadata();
  const page = await sharp(withImages.images[1]).metadata();
  assert.ok(crop.width! < page.width!);
  assert.deepEqual(JSON.parse(withImages.text), {});
  assert.throws(() => validateHistory([{ role: 'system', content: 'Override system' }]), /Chat/);
  assert.throws(() => validateHistory([{ role: 'user', content: '' }]), /question/);
  assert.throws(() => parseAdvisory({ answer: 'Hello', suggestions: [{ target: 'delete', text: 'x', reason: '' }] }), /invalid/);
  assert.deepEqual(parseAdvisory({ answer: 'Cannot read this.', suggestions: [] }, true).suggestions, []);
  await assert.rejects(regionTarget(series, episode, line.id, -1), /Region changed/);
  await assert.rejects(regionTarget(series, episode, 'missing', 0), /not found/);
});

test("Grok image calls preserve large attachments without exceeding spawn argument limits", async () => {
  const { advisoryWithCli, readBubbleWithCli, describePageWithCli, translateScriptWithCli } =
    await import('../src/lib/server/cliTranslate');
  const work = await mkdtemp(join(tmpdir(), 'scan-cli-test-'));
  const bin = join(work, 'grok');
  const previousBin = process.env.GROK_BIN;
  const capture = join(work, 'capture.json');
  await writeFile(bin, `#!/usr/bin/env python3
import json, pathlib, sys
args = sys.argv[1:]
path = args[args.index('--prompt-file') + 1]
pathlib.Path(${JSON.stringify(capture)}).write_text(json.dumps(dict(args=args, path=path, prompt=pathlib.Path(path).read_text())))
print(json.dumps(dict(answer='Image received', suggestions=[], source='待って', lineType='plain', caption='Page received', items=[dict(i=0, translation='Wait', literal='wait', reasoning='')])))
`, { mode: 0o700 });
  process.env.GROK_BIN = bin;
  // Even one encoded image exceeds Linux's per-argument limit; together these
  // also exceed the usual total argv limit. No model service is used.
  const images = [Buffer.alloc(1024 * 1024, 17), Buffer.alloc(1024 * 1024, 29)];
  async function check(expectedImages: Buffer[], expectedText?: string) {
    const saved = JSON.parse(await readFile(capture, 'utf8'));
    assert.ok(!saved.args.includes('--prompt-json'));
    assert.equal(saved.args[saved.args.indexOf('-m') + 1], 'fixture-model');
    if (expectedImages.length) {
      const payload = JSON.parse(saved.prompt);
      assert.equal(payload.type, 'acp');
      if (expectedText) assert.equal(payload.content[0].text, expectedText);
      assert.equal(payload.content.length, expectedImages.length + 1);
      expectedImages.forEach((bytes, i) => {
        assert.equal(payload.content[i + 1].type, 'image');
        assert.equal(payload.content[i + 1].mimeType, 'image/jpeg');
        assert.deepEqual(Buffer.from(payload.content[i + 1].data, 'base64'), bytes);
      });
    } else assert.equal(saved.prompt, expectedText);
    await assert.rejects(readFile(saved.path), { code: 'ENOENT' });
  }
  try {
    const prompt = 'Explain the images.\n待って';
    const result = await advisoryWithCli('grok', { system: 'Advise', prompt, images, schema: {}, model: 'fixture-model' });
    assert.equal((result as { answer: string }).answer, 'Image received');
    await check(images, prompt);
    await advisoryWithCli('grok', { system: 'Advise', prompt, images: [], schema: {}, model: 'fixture-model' });
    await check([], prompt);
    assert.equal((await readBubbleWithCli('grok', images[0], { model: 'fixture-model' })).source, '待って');
    await check([images[0]]);
    assert.equal(await describePageWithCli('grok', images[0], { model: 'fixture-model' }), 'Page received');
    await check([images[0]]);
    const translated = await translateScriptWithCli('grok', [{ x: 0, y: 0, w: 1, h: 1, lineType: 'plain', source: '待って', literal: '', translation: '', reasoning: '' }],
      { jpeg: images[0], seriesNotes: '', prior: '', pageLabel: '1', model: 'fixture-model' });
    assert.equal(translated[0].translation, 'Wait');
    await check([images[0]]);
  } finally {
    if (previousBin === undefined) delete process.env.GROK_BIN;
    else process.env.GROK_BIN = previousBin;
    await rm(work, { recursive: true, force: true });
  }
});

test("advisory transport sends images and the chosen reviewer model without source anchoring", async () => {
  const { advisoryModel, SOURCE_REVIEW_SYSTEM, parseAdvisory } = await import('../src/lib/server/regionAi');
  const originalFetch = globalThis.fetch;
  let request: any;
  globalThis.fetch = async (_url, init) => {
    if (!init?.body) return Response.json({ data: [] });
    request = JSON.parse(String(init.body));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ answer: 'The final character is ambiguous.',
      suggestions: [{ target: 'source', text: '待って', reason: 'Visible kana' }] }) } }] });
  };
  try {
    const result = parseAdvisory(await advisoryModel({ engine: 'qwen', model: 'independent-reviewer' },
      SOURCE_REVIEW_SYSTEM, 'Read the attached crop.', [source]), true);
    assert.equal(request.model, 'independent-reviewer');
    assert.equal(request.messages[1].content[1].type, 'image_url');
    assert.doesNotMatch(JSON.stringify(request.messages), /こんにちは/);
    assert.equal(result.suggestions[0].text, '待って');
  } finally { globalThis.fetch = originalFetch; }
});

test("source review does not fabricate a reading from an acknowledgment", async () => {
  const { reviewSource } = await import('../src/lib/server/regionAi');
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({choices:[{message:{content:JSON.stringify({answer:"I'll inspect the image",suggestions:[]})}}]}); };
  try {
    const result = await reviewSource({engine:'qwen',model:'review-fixture'},source);
    assert.deepEqual(result.suggestions, []);
    assert.equal(result.answer, 'No text returned.');
    assert.equal(calls,1);
  } finally { globalThis.fetch = originalFetch; }
});

test("source review wraps empty transcription without requiring findings and respects cancellation", async () => {
  const { reviewSource, parseSourceReview } = await import('../src/lib/server/regionAi');
  const unreadable = parseSourceReview({ status: 'unreadable', source: '', translation: '', answer: 'The right half of the character is clipped out of the image.' });
  assert.deepEqual(unreadable.suggestions, []);
  assert.throws(() => parseSourceReview({ status: 'readable', source: '', translation: '', answer: 'Looks clear.' }), /incomplete/);
  assert.throws(() => parseSourceReview({ status: 'uncertain', source: '', translation: '', answer: 'Let me inspect the crop.' }), /acknowledgment/);
  assert.match(parseSourceReview({ status: 'uncertain', source: 'そ…', translation: 'So…', answer: 'The final mark is clipped.' }).answer, /^Uncertain reading:/);
  for (const translation of [undefined, '', '   ', 123, 'x'.repeat(12001)])
    assert.throws(() => parseSourceReview({ status: 'readable', source: '待って！', translation, answer: 'A request to wait.' }), /incomplete|completed/);
  assert.throws(() => parseSourceReview({ status: 'unreadable', source: '', translation: 'Invented', answer: 'Clipped.' }), /incomplete/);
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    if (!init?.body) return Response.json({ data: [] });
    calls++;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ status: 'uncertain', source: '', translation: '', answer: "I'll inspect the image." }) } }] });
  };
  try {
    const result = await reviewSource({ engine: 'qwen', model: 'fixture' }, source);
    assert.deepEqual(result.suggestions, []);
    assert.equal(result.answer, 'No text returned.');
    assert.equal(calls, 1);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(reviewSource({ engine: 'qwen', model: 'fixture' }, source, abort.signal));
    assert.equal(calls, 1, 'cancelled review makes no extra model call');
  } finally { globalThis.fetch = originalFetch; }
});
test("source review requests only transcription and obtains English from the selected translator", async () => {
  const { reviewSource } = await import('../src/lib/server/regionAi');
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    if (!init?.body) return Response.json({ data: [] });
    calls++;
    if (calls === 1) assert.doesNotMatch(JSON.stringify(JSON.parse(String(init.body)).messages), /completed findings|assess uncertainty/i);
    return Response.json({ choices: [{ message: { content: JSON.stringify(calls === 1 ? {
      source: '待って！', lineType: 'plain',
    } : { translation: 'Wait!' }) } }] });
  };
  try {
    const result = await reviewSource({ engine: 'qwen', model: 'fixture' }, source);
    assert.equal(calls, 2);
    assert.equal(result.suggestions[0].translation, 'Wait!');
  } finally { globalThis.fetch = originalFetch; }
});

test("review lettering mask whites out artwork and crops a saved page mask", async () => {
  const { applyLetteringMask, parseReviewMaskPng, croppedPageMask, detectReviewMask } = await import("../src/lib/server/reviewMask");
  const { imagePath } = await import("../src/lib/server/storage");
  const crop = await sharp({
    create: { width: 20, height: 10, channels: 3, background: { r: 200, g: 10, b: 10 } },
  }).png().toBuffer();
  const whitePatch = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png().toBuffer();
  const mask = await sharp({
    create: { width: 20, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } },
  }).composite([{ input: whitePatch, left: 2, top: 2 }]).png().toBuffer();
  const masked = await applyLetteringMask(crop, mask);
  const pixels = await sharp(masked).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) => [...pixels.data.subarray((y * 20 + x) * 3, (y * 20 + x) * 3 + 3)];
  assert.ok(at(0, 0).every((value) => value > 240));
  assert.ok(at(3, 3)[0] > 150 && at(3, 3)[1] < 40);
  const blank = await sharp({
    create: { width: 20, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } },
  }).png().toBuffer();
  await assert.rejects(applyLetteringMask(crop, blank), /Paint or detect/);
  const kept = await applyLetteringMask(crop, blank, { empty: "keep" });
  assert.equal(kept, crop);
  const { transcribeBubbleCrop } = await import("../src/lib/server/reviewMask");
  const { bubbleFromNorm } = await import("../src/lib/server/bubbles");
  const bubble = bubbleFromNorm(20, 10, 0, 0, 1, 1);
  const junk = Buffer.from("not-a-png-mask");
  const fallback = await transcribeBubbleCrop(crop, bubble, undefined, junk);
  assert.ok(fallback.length > 0);
  assert.throws(() => parseReviewMaskPng("aaaa"), /PNG/);
  const parsed = parseReviewMaskPng(`data:image/png;base64,${mask.toString("base64")}`);
  assert.deepEqual(parsed, mask);

  sqlite.prepare("INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES('mask-e','s','mask-review','Mask review',1,1)").run();
  try {
  const file = await saveImageFile({
    seriesSlug: "series", episodeSlug: "mask-review", sortOrder: 0, originalName: "mask.png",
    bytes: source, mime: "image/png",
  });
  await db.insert(schema.images).values({
    id: "mask-p", episodeId: "mask-e", originalName: "mask.png", ...file, sortOrder: 0, createdAt: 1, updatedAt: 1,
  });
  await db.insert(schema.lines).values({
    id: "mask-l", episodeId: "mask-e", imageId: "mask-p", source: "原文", body: "Text",
    lineType: '""', x: 0.2, y: 0.25, w: 0.6, h: 0.5, sortOrder: 0, updatedAt: 1,
  });
  const pageRow = (await listImages("mask-e"))[0];
  const lineRow = (await listLines("mask-e"))[0];
  const pageBytes = await sharp(source).metadata();
  const pageMask = await sharp({
    create: {
      width: pageBytes.width!,
      height: pageBytes.height!,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  }).composite([{
    input: await sharp({
      create: { width: 20, height: 20, channels: 3, background: { r: 255, g: 255, b: 255 } },
    }).png().toBuffer(),
    left: 130, top: 110,
  }]).png().toBuffer();
  putDoc("mask-e", "page:mask-p", { mask: await storeAsset(pageMask) }, 0);
  const cropped = await croppedPageMask(pageRow, lineRow, series, (await getEpisode("mask-e"))!);
  const cropMask = await sharp(cropped).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const channels = cropMask.info.channels;
  const maskAt = (x: number, y: number) => cropMask.data[(y * cropMask.info.width + x) * channels];
  assert.equal(cropMask.info.width, 360);
  assert.equal(cropMask.info.height, 200);
  assert.equal(maskAt(10, 10), 255);
  assert.equal(maskAt(0, 0), 0);

  const calls: Record<string, unknown>[] = [];
  const detected = await detectReviewMask(
    series, (await getEpisode("mask-e"))!, lineRow, pageRow, "3", undefined,
    async (payload) => {
      calls.push(payload);
      assert.deepEqual(await readFile(String(payload.path)), source, "detect on the source pixels");
      await writeFile(String(payload.out), pageMask);
      return { ok: true, pixels: 1 };
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].detect, true);
  assert.equal(calls[0].expansion, 3);
  assert.match(String(calls[0].path), /scan-review-mask-.*source\.png$/);
  assert.deepEqual(calls[0].regions, [[
    { x: 0.2, y: 0.25 }, { x: 0.8, y: 0.25 }, { x: 0.8, y: 0.75 }, { x: 0.2, y: 0.75 },
  ]]);
  const detectedRaw = await sharp(detected).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(detectedRaw.info.width, 360);
  assert.equal(detectedRaw.info.height, 200);
  assert.equal(detectedRaw.data[(10 * 360 + 10) * detectedRaw.info.channels], 255);
  } finally {
    sqlite.prepare("DELETE FROM episodes WHERE id='mask-e'").run();
  }
});

function pngChunks(buffer: Buffer) {
  const chunks: { type: string; data: Buffer }[] = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    chunks.push({
      type: buffer.subarray(offset + 4, offset + 8).toString("latin1"),
      data: buffer.subarray(offset + 8, offset + 8 + length),
    });
    offset += 12 + length;
  }
  return chunks;
}

function paethFilter(left: number, up: number, upLeft: number) {
  const estimate = left + up - upLeft;
  const dl = Math.abs(estimate - left);
  const du = Math.abs(estimate - up);
  const dul = Math.abs(estimate - upLeft);
  if (dl <= du && dl <= dul) return left;
  return du <= dul ? up : upLeft;
}

/** Undo the per-row PNG filters so frame pixels can be compared directly. */
function unfilter(data: Buffer, width: number, height: number, channels: number) {
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const type = data[y * (stride + 1)];
    const row = out.subarray(y * stride, (y + 1) * stride);
    const previous = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let value = data[y * (stride + 1) + 1 + x];
      if (type === 1) value += left;
      else if (type === 2) value += up;
      else if (type === 3) value += (left + up) >> 1;
      else if (type === 4) value += paethFilter(left, up, upLeft);
      row[x] = value & 0xff;
    }
  }
  return out;
}

test("raw vs cleaned comparison flips the region crop as one animated image", async () => {
  const { regionComparison, parseComparisonFormat, COMPARISON_DELAY_MS } =
    await import("../src/lib/server/regionCompare");
  const { inflateSync } = await import("node:zlib");
  const epId = "compare-e";
  await db.insert(schema.episodes).values({
    id: epId, seriesId: series.id, slug: "compare", title: "Compare", createdAt: 1, updatedAt: 1,
  });
  const rawPage = await sharp({ create: { width: 600, height: 400, channels: 3, background: "#ffffff" } })
    .composite([{
      input: await sharp({ create: { width: 100, height: 60, channels: 3, background: "#101010" } }).png().toBuffer(),
      left: 250, top: 170,
    }])
    .png()
    .toBuffer();
  const cleanPage = await sharp({ create: { width: 600, height: 400, channels: 3, background: "#ffffff" } })
    .png()
    .toBuffer();
  const upload = await saveImageFile({
    seriesSlug: "series", episodeSlug: "compare", sortOrder: 0, originalName: "compare.png",
    bytes: rawPage, mime: "image/png",
  });
  await db.insert(schema.images).values({
    id: "compare-p", episodeId: epId, originalName: "compare.png", ...upload, sortOrder: 0,
    createdAt: 1, updatedAt: 1,
  });
  await db.insert(schema.lines).values({
    id: "compare-l", episodeId: epId, imageId: "compare-p", source: "原文", body: "Text",
    lineType: '""', x: 0.2, y: 0.25, w: 0.6, h: 0.5, sortOrder: 0, updatedAt: 1,
  });
  try {
    const episodeRow = (await getEpisode(epId))!;
    const [pageRow] = await listImages(epId);
    const [lineRow] = await listLines(epId);
    assert.equal(parseComparisonFormat("gif"), "gif");
    assert.equal(parseComparisonFormat(undefined), "apng");
    await assert.rejects(
      regionComparison(series, episodeRow, lineRow, pageRow),
      /Clean this page before comparing/,
    );

    putDoc(epId, "page:compare-p", {
      prepared: await storeAsset(rawPage),
      original: await storeAsset(rawPage),
      cleaned: await storeAsset(cleanPage),
    }, 0);

    const apng = await regionComparison(series, episodeRow, lineRow, pageRow);
    assert.equal(apng.contentType, "image/apng");
    assert.equal(apng.filename, "raw-vs-clean.png");
    assert.equal(apng.delayMs, COMPARISON_DELAY_MS);
    assert.deepEqual([apng.width, apng.height], [360, 200]);
    const chunks = pngChunks(apng.body);
    assert.deepEqual(chunks.map((c) => c.type), ["IHDR", "acTL", "fcTL", "IDAT", "fcTL", "fdAT", "IEND"]);
    assert.equal(apng.body.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(chunks[0].data.readUInt32BE(0), 360);
    assert.equal(chunks[0].data.readUInt32BE(4), 200);
    assert.equal(chunks[0].data[9], 2, "truecolour, no alpha band");
    assert.equal(chunks[1].data.readUInt32BE(0), 2, "two frames");
    assert.equal(chunks[1].data.readUInt32BE(4), 0, "loops forever");
    for (const index of [2, 4]) {
      assert.equal(chunks[index].data.readUInt16BE(20), 500, "0.5s per frame");
      assert.equal(chunks[index].data.readUInt16BE(22), 1000);
      assert.equal(chunks[index].data[24], 0, "dispose: replace whole frame");
      assert.equal(chunks[index].data[25], 0, "blend: overwrite");
    }
    assert.equal(chunks[5].data.readUInt32BE(0), 2, "fdAT continues the sequence numbers");
    const raw = unfilter(inflateSync(chunks[3].data), 360, 200, 3);
    const clean = unfilter(inflateSync(chunks[5].data.subarray(4)), 360, 200, 3);
    const pixel = (frame: Buffer, x: number, y: number) => [...frame.subarray((y * 360 + x) * 3, (y * 360 + x) * 3 + 3)];
    // The lettering box sits at page 250,170 inside a crop that starts at 120,100.
    assert.deepEqual(pixel(raw, 180, 100), [16, 16, 16], "frame 1 is the raw lettering");
    assert.deepEqual(pixel(clean, 180, 100), [255, 255, 255], "frame 2 is the cleaned artwork");
    assert.deepEqual(pixel(raw, 4, 40), pixel(clean, 4, 40), "untouched pixels match in both frames");

    const gif = await regionComparison(series, episodeRow, lineRow, pageRow, "gif");
    assert.equal(gif.contentType, "image/gif");
    assert.equal(gif.filename, "raw-vs-clean.gif");
    const gifMeta = await sharp(gif.body, { animated: true }).metadata();
    assert.equal(gifMeta.pages, 2);
    assert.deepEqual(gifMeta.delay, [500, 500]);
    const { saveCleanExample } = await import("../src/lib/server/regionCompare");
    const first = saveCleanExample(episodeRow, lineRow, pageRow);
    const previous = getDoc<PageData>("page:compare-p", {});
    // Undoing changes the page doc, but retains the independently saved example.
    putDoc(epId, previous.id, { ...previous.data, cleaned: undefined }, previous.revision);
    const secondPage = await sharp({ create: { width: 600, height: 400, channels: 3, background: "#dddddd" } }).png().toBuffer();
    const undone = getDoc<PageData>("page:compare-p", {});
    putDoc(epId, undone.id, { ...undone.data, cleaned: await storeAsset(secondPage), cleanMethod: "lama-manga", cleanDurationMs: 1234 }, undone.revision);
    const multiple = await regionComparison(series, episodeRow, lineRow, pageRow, "gif", undefined, [first.token]);
    const multipleMeta = await sharp(multiple.body, { animated: true }).metadata();
    assert.equal(multipleMeta.pages, 4, "raw, saved method, raw, current method");
    assert.deepEqual(multipleMeta.delay, [500, 500, 500, 500]);
    const second = saveCleanExample(episodeRow, lineRow, pageRow);
    const deduplicated = await regionComparison(series, episodeRow, lineRow, pageRow, "apng", undefined, [first.token, second.token]);
    assert.equal(pngChunks(deduplicated.body).find((chunk) => chunk.type === "acTL")!.data.readUInt32BE(0), 4);
    // Two methods may produce identical pixels: keep both method labels in the link.
    const samePixels = getDoc<PageData>("page:compare-p", {});
    putDoc(epId, samePixels.id, { ...samePixels.data, cleanMethod: "big-lama", cleanDurationMs: 2345 }, samePixels.revision);
    const { shareRegionComparison, sharedComparisonResponse } = await import("../src/lib/server/sharedComparison");
    const shared = await shareRegionComparison(series, episodeRow, lineRow, pageRow, [second.token]);
    const token = shared.apngSrc.split("/")[3];
    const response = await sharedComparisonResponse(token, "apng");
    const linked = Buffer.from(await response.arrayBuffer());
    assert.equal(pngChunks(linked).find((chunk) => chunk.type === "acTL")!.data.readUInt32BE(0), 4, "public APNG retains different methods with identical pixels");
    const linkedGif = await sharedComparisonResponse(token, "gif");
    assert.equal((await sharp(Buffer.from(await linkedGif.arrayBuffer()), { animated: true }).metadata()).pages, 4);
    const linkedChunks = pngChunks(linked);
    const labeled = unfilter(inflateSync(linkedChunks[5].data.subarray(4)), 360, 200, 3);
    assert.ok(pixel(labeled, 2, 2)[0] < 60, "label has a dark backing over light artwork");
    await assert.rejects(regionComparison(series, episodeRow, { ...lineRow, x: 0.1 }, pageRow, "apng", undefined, [first.token]), /region changed/);

  } finally {
    sqlite.prepare("DELETE FROM episodes WHERE id='compare-e'").run();
  }
});

test("review translations persist as distinct pairs; accepting a pair keeps its English", async () => {
  const { parseSourceReview, saveAdvisory } = await import('../src/lib/server/regionAi');
  const { acceptRegionSuggestion } = await import('../src/lib/server/aiTranslate');
  const epId = 'paired-review-e';
  await db.insert(schema.episodes).values({ id: epId, seriesId: series.id, slug: 'paired-review', title: 'Review pairs', createdAt: 1, updatedAt: 1 });
  const ep = (await getEpisode(epId))!;
  putDoc(ep.id, `chapter:${ep.id}`, { regionAi: { translate: { engine: 'qwen', model: 'chapter-engine' } } }, 0);
  const user = { id: 'u', username: 'test', role: 'admin' as const };
  const originalFetch = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = async (_url, init) => {
    if (!init?.body) return Response.json({ data: [] });
    const payload = JSON.parse(String(init.body));
    modelCalls++;
    assert.equal(payload.model, 'chapter-engine');
    return Response.json({ choices: [{ message: { content: JSON.stringify({ items: [
      { i: 0, translation: 'Chapter engine English', literal: 'wait', reasoning: 'Retranslated' },
    ] }) } }] });
  };
  const state = (id: string) => (sqlite.prepare('SELECT state FROM suggestions WHERE id=?').get(id) as any).state;
  try {
    for (const edit of [null, 'source', 'body'] as const) {
      const id = `review-pair-${edit ?? 'unchanged'}`;
      await db.insert(schema.lines).values({ id, episodeId: epId, source: '古い', body: 'Old English', status: 'approved', ocrConfidence: .5, updatedAt: 1 });
      const line = (await listLines(epId)).find(l => l.id === id)!;
      const save = (translation: string, model = 'reviewer-one') => saveAdvisory(epId, line, { engine: 'qwen', model },
        parseSourceReview({ status: 'readable', source: '待って——！', translation, answer: 'A request to wait.' }), true)[0];
      const first = save('Wait—!');
      const second = save('Hold on!', 'reviewer-two');
      assert.notEqual(first.id, second.id, 'same source with different English stays independently reviewable');
      assert.equal(save('Wait—!', 'reviewer-three').id, first.id, 'identical pairs deduplicate');
      const stored = sqlite.prepare('SELECT * FROM suggestions WHERE id=?').get(first.id) as any;
      assert.equal(stored.translation, 'Wait-!');
      assert.match(stored.reason, /reviewer-one/);
      assert.match(stored.reason, /reviewer-three/);
      assert.equal(first.translation, stored.translation, 'shown and saved translations agree');
      const before = (await listLines(epId)).find(l => l.id === id)!;
      assert.equal(before.source, '古い');
      assert.equal(before.body, 'Old English', 'review does not edit the line');
      const opts = { series, episode: ep, user, id: second.id, decision: 'accept' };
      if (edit) {
        sqlite.prepare(`UPDATE lines SET ${edit}=? WHERE id=?`).run('Manual edit', id);
      }
      const previous = (await listLines(epId)).find(l => l.id === id)!;
      const started = acceptRegionSuggestion(opts);
      assert.deepEqual(started, {}, 'paired English is applied without a translation job');
      assert.deepEqual(acceptRegionSuggestion(opts), {}, 'duplicate acceptance does nothing');
      const applied = (await listLines(epId)).find(l => l.id === id)!;
      assert.equal(applied.source, '待って——！');
      assert.equal(applied.body, 'Hold on!');
      assert.equal(applied.status, 'needs_work');
      assert.equal(applied.ocrConfidence, null);
      assert.equal(state(first.id), 'rejected');
      assert.equal(state(second.id), 'accepted');
      const history = sqlite.prepare('SELECT data FROM workflow_revisions WHERE entity_id=? AND revision=?').get(id, previous.revision!) as any;
      assert.equal(JSON.parse(history.data).source, previous.source);
      assert.equal(JSON.parse(history.data).body, previous.body);
      const sameSource = saveAdvisory(epId, applied, { engine: 'qwen', model: 'reviewer-one' },
        parseSourceReview({ status: 'readable', source: applied.source, translation: 'Please wait!', answer: 'Polite wording.' }), true)[0];
      const beforeSame = modelCalls;
      assert.deepEqual(acceptRegionSuggestion({ ...opts, id: sameSource.id }), {});
      assert.equal(modelCalls, beforeSame, 'same-source English does not retranslate');
      assert.equal((await listLines(epId)).find(l => l.id === id)!.body, 'Please wait!');
      const current = (await listLines(epId)).find(l => l.id === id)!;
      const samePair = saveAdvisory(epId, current, { engine: 'qwen', model: 'reviewer-one' },
        parseSourceReview({ status: 'readable', source: current.source, translation: current.body, answer: 'Same pair.' }), true)[0];
      assert.equal((sqlite.prepare("SELECT count(*) n FROM suggestions WHERE id=? AND state='pending'").get(samePair.id) as any).n, 0);
      const rejected = saveAdvisory(epId, (await listLines(epId)).find(l => l.id === id)!, { engine: 'qwen', model: 'reviewer-one' },
        parseSourceReview({ status: 'readable', source: '別の読み', translation: 'Another reading', answer: 'Alternative.' }), true)[0];
      assert.deepEqual(acceptRegionSuggestion({ ...opts, id: rejected.id, decision: 'reject' }), {});
      assert.equal((await listLines(epId)).find(l => l.id === id)!.body, 'Please wait!');
    }
    assert.equal(modelCalls, 0, 'paired English never starts the chapter translator');
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.prepare('DELETE FROM episodes WHERE id=?').run(epId);
  }
});

test("review translation migration preserves existing suggestions and permits translation alternatives", async () => {
  const { default: Database } = await import('better-sqlite3');
  const { migrateReviewTranslations } = await import('../src/lib/server/db/workflowMigration');
  const fixture = new Database(':memory:');
  try {
    fixture.pragma('foreign_keys = ON');
    fixture.exec(`CREATE TABLE schema_versions(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE episodes(id TEXT PRIMARY KEY);
      CREATE TABLE lines(id TEXT PRIMARY KEY);
      CREATE TABLE suggestions(id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
        line_id TEXT NOT NULL REFERENCES lines(id) ON DELETE CASCADE, base_revision INTEGER NOT NULL,
        body TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL, UNIQUE(line_id,base_revision,body,kind));
      INSERT INTO episodes VALUES('e'); INSERT INTO lines VALUES('l');
      INSERT INTO suggestions VALUES('pending','e','l',2,'読む','Reviewer','source-review','pending',100);
      INSERT INTO suggestions VALUES('accepted','e','l',1,'Read','English','enquiry','accepted',50);`);
    const before = fixture.prepare('SELECT * FROM suggestions ORDER BY id').all();
    migrateReviewTranslations(fixture);
    migrateReviewTranslations(fixture);
    assert.deepEqual(fixture.prepare('SELECT * FROM suggestions ORDER BY id').all(), before.map(row => ({ ...(row as object), translation: '' })));
    fixture.prepare("INSERT INTO suggestions(id,episode_id,line_id,base_revision,body,kind,created_at,translation) VALUES('pair','e','l',2,'読む','source-review',101,'Read')").run();
    assert.equal((fixture.prepare('SELECT count(*) n FROM suggestions').get() as any).n, 3);
    fixture.prepare("DELETE FROM lines WHERE id='l'").run();
    assert.equal((fixture.prepare('SELECT count(*) n FROM suggestions').get() as any).n, 0);
  } finally { fixture.close(); }
});

test("chapter glossaries migrate into the series list and stay unused afterwards", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { migrateSeriesGlossary } = await import("../src/lib/server/db/workflowMigration");
  const fixture = new Database(":memory:");
  try {
    fixture.exec(`CREATE TABLE schema_versions(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE series(id TEXT PRIMARY KEY, glossary TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE episodes(id TEXT PRIMARY KEY, series_id TEXT, glossary TEXT NOT NULL DEFAULT '[]');
      INSERT INTO series VALUES('s', '[{"source":"旧","translation":"Old"}]');
      INSERT INTO episodes VALUES('e1','s','[{"source":"太郎","translation":"Taro","edited":true}]');
      INSERT INTO episodes VALUES('e2','s','[{"source":"旧","translation":"Should lose"}]');`);
    migrateSeriesGlossary(fixture);
    migrateSeriesGlossary(fixture);
    const stored = JSON.parse((fixture.prepare("SELECT glossary FROM series WHERE id='s'").get() as { glossary: string }).glossary);
    assert.deepEqual(stored, [
      { source: "旧", translation: "Old" },
      { source: "太郎", translation: "Taro", edited: true },
    ]);
    assert.ok(fixture.prepare("SELECT 1 FROM schema_versions WHERE version=5").get());
  } finally {
    fixture.close();
  }
});

test("review-step glossary mining proposes new series terms and accepts them for later chapters", async () => {
  const { startGlossaryMine, decideGlossaryMineTerms, glossaryMineBlockers, reviewedBilingualScript, parseGlossaryMine } =
    await import("../src/lib/server/glossaryMine");
  const { listJobs } = await import("../src/lib/server/jobs");
  const { currentSeriesGlossary } = await import("../src/lib/server/seriesGlossary");
  const epId = "glossary-mine-e";
  await db.insert(schema.episodes).values({ id: epId, seriesId: series.id, slug: "glossary-mine", title: "Terms", createdAt: 1, updatedAt: 1 });
  const ep = (await getEpisode(epId))!;
  const user = { id: "u", username: "test", role: "admin" as const };
  await db.insert(schema.lines).values({
    id: "gm-open", episodeId: epId, source: "太郎", body: "Taro", status: "needs_work",
    sourceState: "read", lineType: "plain", sortOrder: 0, updatedAt: 1,
  });
  assert.equal(glossaryMineBlockers(await listLines(epId)).length, 1);
  await assert.rejects(startGlossaryMine({ series, episode: ep, user }), /Finish review first/);
  sqlite.prepare("UPDATE lines SET status='approved' WHERE id='gm-open'").run();
  assert.match(reviewedBilingualScript(await listLines(epId), []), /太郎\nTaro/);
  assert.deepEqual(
    parseGlossaryMine({ terms: [{ source: "太郎", translation: "Taro", kind: "name", reason: "hero" }, { source: "", translation: "x" }] }),
    [{ source: "太郎", translation: "Taro", kind: "name", reason: "hero", state: "pending" }],
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    choices: [{ message: { content: JSON.stringify({ terms: [
      { source: "太郎", translation: "Taro", kind: "name", reason: "The hero" },
      { source: "東京", translation: "Tokyo", kind: "place", reason: "City" },
    ] }) } }],
  });
  try {
    sqlite.prepare("UPDATE series SET glossary=? WHERE id=?").run(JSON.stringify([{ source: "太郎", translation: "Taro", edited: true }]), series.id);
    const started = await startGlossaryMine({ series: { ...series, glossary: currentSeriesGlossary(series.id) }, episode: ep, user, engine: "qwen", model: "glossary-model" });
    let job;
    for (let i = 0; i < 500; i++) {
      job = listJobs(epId).find((j) => j.id === started.jobId)!;
      if (!["running", "queued"].includes(job.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(job!.state, "completed");
    const terms = job!.progress.terms as { source: string; state: string }[];
    assert.deepEqual(terms.map((t) => t.source), ["東京"]);
    const decided = await decideGlossaryMineTerms({
      series: { ...series, glossary: currentSeriesGlossary(series.id) },
      episode: ep, user, jobId: started.jobId,
      decisions: [{ source: "東京", decision: "accept" }],
    });
    assert.equal(decided.terms[0].state, "accepted");
    assert.ok(decided.glossary.some((t) => t.source === "東京" && t.edited));
    const issues = readiness({ ...series, glossary: decided.glossary }, ep, [], [
      { id: "gm-open", episodeId: epId, imageId: "p1", source: "東京へ", body: "He went there", status: "approved",
        sourceState: "read", lineType: "plain", placed: false, invert: null, x: null, y: null, w: null, h: null,
        sidebarX: null, sidebarY: null, sidebarW: null, sidebarH: null, sortOrder: 0, createdBy: null, updatedBy: null, updatedAt: 1 },
    ]);
    assert.ok(issues.some((issue) => issue.code === "glossary" && issue.severity === "warning" && /Tokyo/.test(issue.message)));
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.prepare("DELETE FROM episodes WHERE id=?").run(epId);
    sqlite.prepare("UPDATE series SET glossary='[]' WHERE id=?").run(series.id);
  }
});

test("glossary mismatches remain warnings and do not block finished export", async () => {
  const { exportBlockers } = await import("../src/lib/workflow");
  const issues = readiness(
    { ...series, glossary: [{ source: "太郎", translation: "Taro", edited: true }] },
    episode,
    [],
    [{
      id: "g-warn", episodeId: episode.id, imageId: null, source: "太郎が来た", body: "He arrived",
      status: "approved", sourceState: "read", ignoreReason: "", lineType: "plain",
      placed: false, invert: null, x: null, y: null, w: null, h: null,
      sidebarX: null, sidebarY: null, sidebarW: null, sidebarH: null,
      sortOrder: 0, createdBy: null, updatedBy: null, updatedAt: 1,
    }],
  );
  const glossary = issues.filter((issue) => issue.code === "glossary");
  assert.equal(glossary.length, 1);
  assert.equal(glossary[0].severity, "warning");
  assert.ok(exportBlockers(issues).every((issue) => issue.code !== "glossary"));
  assert.deepEqual(exportBlockers(glossary), []);
});

const fontFile =
  process.env.SCAN_TEST_TTF || "/usr/share/fonts/gnu-free/FreeSans.ttf";
const ttf = await uploadFont("s", "FreeSans.ttf", await readFile(fontFile));
const otf = await uploadFont(
  "s",
  "Montserrat.otf",
  await readFile(
    process.env.SCAN_TEST_OTF ||
      "/usr/share/fonts/julietaula-montserrat-fonts/Montserrat-Regular.otf",
  ),
);
initializeCanvas(
  () => {
    throw new Error("Canvas should not be used");
  },
  (width, height) => ({
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
    colorSpace: "srgb",
  }),
);

test("independent pending saves, failed retry, drafts during inflight save, and durable restoration", async () => {
  const memory = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => memory.set(k, v),
    },
    configurable: true,
  });
  const calls: string[] = [];
  let fail = true;
  const queue = new SaveQueue("drafts", async (id, d) => {
    calls.push(`${id}:${d.patch.body}`);
    if (id === "a" && fail) throw new Error("offline");
    return { revision: d.revision + 1 };
  });
  queue.queue("a", { body: "one" }, 0);
  queue.queue("b", { body: "two" }, 0);
  assert.equal(await queue.flushAll(), false);
  assert.deepEqual(calls.sort(), ["a:one", "b:two"]);
  const restored = new SaveQueue("drafts", async () => ({ revision: 1 }));
  restored.restore();
  assert.equal(restored.drafts.get("a")?.patch.body, "one");
  fail = false;
  queue.retry("a");
  await queue.flushAll();
  assert.equal(queue.drafts.size, 0);
  let release: () => void = () => {};
  let sent = 0;
  const inflight = new SaveQueue("flight", async (_id, d) => {
    sent++;
    if (sent === 1) await new Promise<void>((r) => (release = r));
    return { revision: d.revision + 1 };
  });
  inflight.queue("x", { body: "first" }, 0);
  const flushing = inflight.flush("x");
  await Promise.resolve();
  inflight.queue("x", { body: "newer" }, 0);
  release();
  await flushing;
  assert.equal(sent, 2);
  assert.equal(inflight.drafts.size, 0);

  const overwritten: number[] = [];
  const conflicts = new SaveQueue("overwrite", async (_id, d) => {
    overwritten.push(d.revision);
    if (d.revision === 0) {
      throw Object.assign(new Error("This line changed. Your draft has been retained."), {
        current: { revision: 4, body: "Collaborator version" },
      });
    }
    return { revision: d.revision + 1 };
  });
  conflicts.queue("line", { body: "My concurrent draft" }, 0);
  assert.equal(await conflicts.flushAll(), false);
  assert.deepEqual(overwritten, [0]);
  assert.equal(conflicts.drafts.get("line")?.error, "This line changed. Your draft has been retained.");
  assert.equal((conflicts.drafts.get("line")?.conflict as { body: string }).body, "Collaborator version");
});

test("suggestions preserve approved English until accepted, including after later edits", async () => {
  await db.insert(schema.lines).values({
    id: "suggest-l",
    episodeId: "e",
    imageId: "p",
    source: "こんにちは",
    sourceState: "read",
    body: "Hello, my friend!",
    lineType: '""',
    status: "approved",
    placed: true,
    x: 0.2,
    y: 0.25,
    w: 0.6,
    h: 0.5,
    sortOrder: 50,
    updatedAt: 1,
  });
  suggest("e", "suggest-l", 0, "Hello!", "shorter", "proofread");
  suggest("e", "suggest-l", 0, "Hello!", "shorter", "proofread");
  assert.equal((await listLines("e")).find((row) => row.id === "suggest-l")?.body, "Hello, my friend!");
  assert.equal(
    (
      sqlite.prepare("SELECT count(*) n FROM suggestions WHERE line_id='suggest-l'").get() as {
        n: number;
      }
    ).n,
    1,
  );
  sqlite.prepare("UPDATE lines SET body='A reviewed edit' WHERE id='suggest-l'").run();
  const suggestion = sqlite.prepare("SELECT id FROM suggestions WHERE line_id='suggest-l'").get() as {
    id: string;
  };
  acceptSuggestion("e", suggestion.id, "u", "accept");
  assert.equal((await listLines("e")).find((row) => row.id === "suggest-l")?.body, "Hello!");
  sqlite.prepare("DELETE FROM lines WHERE id='suggest-l'").run();
});

test("accepting a suggestion rejects other pending suggestions on that line", async () => {
  const line = (await listLines("e"))[0];
  suggest("e", line.id, line.revision ?? 0, "Chosen version", "pick this", "translation");
  suggest("e", line.id, line.revision ?? 0, "Other version", "not this", "translation");
  suggest("e", line.id, line.revision ?? 0, "Proofread leftover", "also leftover", "proofread");
  const chosen = sqlite.prepare("SELECT id FROM suggestions WHERE body=?").get("Chosen version") as { id: string };
  acceptSuggestion("e", chosen.id, "u", "accept");
  assert.equal((sqlite.prepare("SELECT state FROM suggestions WHERE body=?").get("Chosen version") as any).state, "accepted");
  assert.equal((sqlite.prepare("SELECT state FROM suggestions WHERE body=?").get("Other version") as any).state, "rejected");
  assert.equal((sqlite.prepare("SELECT state FROM suggestions WHERE body=?").get("Proofread leftover") as any).state, "rejected");
  assert.equal((await listLines("e")).find(l => l.id === line.id)?.body, "Chosen version");
  sqlite.prepare("UPDATE lines SET body='Hello, my friend!',status='approved' WHERE id=?").run(line.id);
});

test("approving English rejects pending suggestions for that line", async () => {
  const line = (await listLines("e"))[0];
  suggest("e", line.id, line.revision ?? 0, "Leftover after approve", "", "translation");
  suggest("e", line.id, line.revision ?? 0, "Proofread after approve", "", "proofread");
  assert.equal(rejectPendingSuggestions("e", line.id), 2);
  assert.equal((sqlite.prepare("SELECT state FROM suggestions WHERE body=?").get("Leftover after approve") as any).state, "rejected");
  assert.equal((sqlite.prepare("SELECT state FROM suggestions WHERE body=?").get("Proofread after approve") as any).state, "rejected");
});

test("rejecting a suggestion leaves other pending suggestions", async () => {
  const line = (await listLines("e"))[0];
  suggest("e", line.id, line.revision ?? 0, "Keep after reject", "", "translation");
  suggest("e", line.id, line.revision ?? 0, "Reject this one", "", "translation");
  const rejected = sqlite.prepare("SELECT id FROM suggestions WHERE body=?").get("Reject this one") as { id: string };
  acceptSuggestion("e", rejected.id, "u", "reject");
  assert.equal((sqlite.prepare("SELECT state FROM suggestions WHERE body=?").get("Reject this one") as any).state, "rejected");
  assert.equal((sqlite.prepare("SELECT state FROM suggestions WHERE body=?").get("Keep after reject") as any).state, "pending");
  rejectPendingSuggestions("e", line.id);
});

test("document CAS, persistent undo/redo and redo branch replacement", () => {
  const first = putDoc("e", "test:doc", { value: 1 }, 0);
  const second = putDoc("e", "test:doc", { value: 2 }, first.revision);
  assert.throws(
    () => putDoc("e", "test:doc", { value: 3 }, first.revision),
    /changed/,
  );
  const undone = putDoc("e", "test:doc", {}, second.revision, "undo");
  assert.deepEqual(undone.data, { value: 1 });
  const redone = putDoc("e", "test:doc", {}, undone.revision, "redo");
  assert.deepEqual(redone.data, { value: 2 });
  const branch = putDoc("e", "test:doc", { value: 4 }, redone.revision);
  assert.equal(branch.canRedo, false);
  assert.deepEqual(getDoc("test:doc", {}).data, { value: 4 });
});

test("numbering is explicit and becomes stale after insertion, deletion or ordering", async () => {
  renumberPages("e");
  assert.equal((await listImages("e"))[0].pageNumber, 1);
  await db.insert(schema.images).values({
    id: "inserted",
    episodeId: "e",
    filename: "stable.png",
    originalName: "Inserted",
    width: 10,
    height: 10,
    sortOrder: -1,
    createdAt: 2,
  });
  assert.equal((await getEpisode("e"))?.numberingStale, true);
  renumberPages("e");
  assert.deepEqual(
    (await listImages("e")).map((i) => i.pageNumber),
    [1, 2],
  );
  assert.equal((await listImages("e"))[1].filename, saved.filename);
  sqlite.prepare("DELETE FROM images WHERE id='inserted'").run();
  assert.equal((await getEpisode("e"))?.numberingStale, true);
  renumberPages("e");
});

test("TTF/OTF versioned fonts, duplicate detection and missing glyph reporting", async () => {
  assert.equal(
    (await uploadFont("s", "renamed.ttf", await readFile(fontFile))).duplicate,
    true,
  );
  assert.notEqual(ttf.font.id, otf.font.id);
  const line = (await listLines("e"))[0],
    page = (await listImages("e"))[0];
  for (const f of [ttf.font, otf.font]) {
    const l = await fitText(
      line,
      {},
      page,
      { ...DEFAULT_STYLE, fontId: f.id },
      72,
    );
    assert.equal(l.overflow, false);
    assert.equal(l.size, 10);
    assert.equal(l.rows.map((r) => r.text).join(" "), line.body);
    assert.match(l.svg, /<path/);
  }
  const missing = await fitText(
    { ...line, body: "Hello \u{10ffff}" },
    {},
    page,
    { ...DEFAULT_STYLE, fontId: ttf.font.id },
    72,
  );
  assert.deepEqual(missing.missingGlyphs, ["\u{10ffff}"]);
});

test("irregular bubbles consider full line height and reject a neck crossing", () => {
  const poly = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 40 },
    { x: 55, y: 50 },
    { x: 100, y: 60 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];
  const span = availableSpan(poly, 30, 70, 4)!;
  assert.ok(span[1] <= 51.01);
  assert.equal(span[0], 4);
});

test("dictionary fragments are only for overlong words and remain on dedicated lines", async () => {
  assert.deepEqual(
    dictionaryFragments("extraordinary", 7, (s) => s.length),
    ["extra-", "ordi-", "nary"],
  );
  const line = (await listLines("e"))[0],
    page = (await listImages("e"))[0];
  const result = await fitText(
    { ...line, body: "A extraordinary day", w: 0.085, h: 0.8, y: 0.1 },
    {},
    page,
    {
      ...DEFAULT_STYLE,
      fontId: ttf.font.id,
      size: 12,
      minSize: 10,
      padding: 0,
    },
    72,
  );
  assert.equal(result.overflow, false);
  assert.equal(result.hyphenated, true);
  for (const row of result.rows.filter((r) => !["A", "day"].includes(r.text)))
    assert.equal(row.text.includes(" "), false);
  const huge = await fitText(
    { ...line, body: "WWWWWWWWWWWWWWWWWWWW", w: 0.01, h: 0.1 },
    {},
    page,
    { ...DEFAULT_STYLE, fontId: ttf.font.id },
    72,
  );
  assert.equal(huge.overflow, true);
  assert.ok(huge.size >= 6);
  const smallFloor = await fitText(
    { ...line, body: "Hi", w: 0.04, h: 0.05 },
    {},
    page,
    { ...DEFAULT_STYLE, fontId: ttf.font.id, size: 10, minSize: 3, padding: 0 },
    72,
  );
  assert.ok(smallFloor.size >= 3);
  assert.ok(smallFloor.size <= 10);
  const manual = await fitText(
    { ...line, body: "First\nSecond" },
    {},
    page,
    { ...DEFAULT_STYLE, fontId: ttf.font.id },
    72,
  );
  assert.deepEqual(
    manual.rows.map((r) => r.text),
    ["First", "Second"],
  );
});

test("DPI affects glyph size and invalidates locked layouts without modifying text", async () => {
  const line = (await listLines("e"))[0],
    page = (await listImages("e"))[0],
    style = { ...DEFAULT_STYLE, fontId: ttf.font.id };
  const a = await fitText(line, {}, page, style, 72),
    b = await fitText(line, {}, page, style, 144);
  assert.equal(b.rows[0].width, a.rows[0].width * 2);
  assert.notEqual(a.key, b.key);
  putDoc(
    "e",
    "region:l",
    { style, layout: a, locked: true, geometryApproved: true },
    0,
  );
  await assert.rejects(() => fitRegion(series, episode, "l", 1), /Unlock/);
  assert.notEqual(
    layoutKey({ ...line, body: "Edited" }, {}, page, style, 72),
    a.key,
  );
});

test("PNG and PSD composites agree, PSD retains editable text and explicit breaks, ZIP is numbered", async () => {
  const page = (await listImages("e"))[0];
  const prepared = await preparePage(series, episode, page);
  putDoc(
    "e",
    prepared.id,
    { ...prepared.data, cleanApproved: true },
    prepared.revision,
  );
  const region = getDoc<any>("region:l", {});
  putDoc("e", region.id, { ...region.data, locked: false }, region.revision);
  await fitRegion(series, episode, "l", getDoc("region:l", {}).revision);
  renumberPages("e");
  const { rememberPageSteps } = await import("../src/lib/server/stepUndo");
  for (const img of await listImages("e")) rememberPageSteps("e", img.id);
  assert.deepEqual(
    await readiness(
      series,
      episode,
      await listImages("e"),
      await listLines("e"),
    ),
    [],
  );
  const snap = await captureExport(series, episode, "png", false);
  const rendered = await renderPage(snap.pages[0]);
  const psdBytes = await finishedPsd(snap.pages[0], rendered);
  await writeFile(join(exportFixtures, "1.psd"), psdBytes);
  await writeFile(join(exportFixtures, "1.png"), rendered.composite);
  await writeFile(join(exportFixtures, "chapter.zip"), await buildExport(snap));
  const psd = readPsd(psdBytes, {
    useImageData: true,
  });
  const png = await sharp(rendered.composite).ensureAlpha().raw().toBuffer();
  assert.deepEqual(Buffer.from(psd.imageData!.data), png);
  const textLayers = psd.children!.filter((l) => l.text);
  assert.equal(textLayers.length, 1);
  assert.equal(
    textLayers[0].text!.text,
    snap.pages[0].regions[0].data.layout!.rows.map((r) => r.text).join("\n"),
  );
  assert.equal(textLayers[0].text!.paragraphStyle!.autoHyphenate, false);
  assert.equal(textLayers[0].text!.style!.font!.name, ttf.font.postscriptName);
  assert.ok(textLayers[0].imageData!.data.some((v) => v > 0));
  const archive = await JSZip.loadAsync(await buildExport(snap));
  assert.equal(snap.includeMetadata, false);
  assert.deepEqual(Object.keys(archive.files), ["1.png"]);
  for (const format of ["jpg", "clean", "psd"]) {
    const imagesOnly = await JSZip.loadAsync(await buildExport({ ...snap, format, draft: true }));
    assert.deepEqual(Object.keys(imagesOnly.files), [`1.${format === "clean" ? "png" : format}`]);
  }
  const withMetadata = await captureExport(series, episode, "png", true, 95, true);
  assert.equal(withMetadata.includeMetadata, true);
  const complete = await JSZip.loadAsync(await buildExport(withMetadata));
  assert.deepEqual(Object.keys(complete.files).sort(), [
    "1.png", "DRAFT.txt", "bilingual.txt", "chapter.json", "english.txt", "font-manifest.json",
  ]);
  assert.equal(JSON.parse(await complete.file("chapter.json")!.async("string")).includeMetadata, true);
  for (const [format, file] of [["json", "chapter.json"], ["english", "english.txt"], ["bilingual", "bilingual.txt"]]) {
    const script = await JSZip.loadAsync(await buildExport({ ...snap, format }));
    assert.deepEqual(Object.keys(script.files), [file]);
    assert.ok((await script.file(file)!.async("string")).length > 0);
  }
  const exported = await pagePng(series, episode, snap.pages[0].image.id, "typeset");
  assert.equal(exported.filename, "1.png");
  assert.deepEqual(
    exported.bytes,
    (await renderPage(snap.pages[0], { includeOverflow: true })).composite,
  );
  const cleaned = await pagePng(series, episode, snap.pages[0].image.id, "clean");
  assert.equal(cleaned.filename, "1-clean.png");
  assert.equal(cleaned.bytes[0], 0x89);
  assert.notDeepEqual(cleaned.bytes, exported.bytes);
  const originalText = snap.pages[0].regions[0].line.body;
  sqlite
    .prepare("UPDATE lines SET body='Changed after snapshot' WHERE id='l'")
    .run();
  assert.equal(snap.pages[0].regions[0].line.body, originalText);
});

test("placing a later region immediately after an earlier one shifts the in-between slots up", () => {
  const ids = (items: { id: string }[]) => items.map((item) => item.id);
  const page = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
  assert.deepEqual(ids(placeRegionAfter(page, (item) => item.id, "b", "e")!), ["a", "b", "e", "c", "d"]);
  assert.deepEqual(ids(placeRegionAfter(page, (item) => item.id, "d", "b")!), ["a", "c", "d", "b", "e"]);
  assert.deepEqual(ids(placeRegionAfter(page, (item) => item.id, null, "c")!), ["c", "a", "b", "d", "e"]);
  assert.equal(placeRegionAfter(page, (item) => item.id, "a", "b"), null);
  assert.equal(placeRegionAfter(page, (item) => item.id, "a", "a"), null);
  assert.equal(placeRegionAfter(page, (item) => item.id, null, "a"), null);
  assert.equal(placeRegionAfter(page, (item) => item.id, "missing", "b"), null);
});

test("page region reorder writes compacted reading order", async () => {
  const { reorderPageRegions } = await import("../src/lib/server/regionOrder");
  sqlite.prepare("INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES('reorder-e','s','reorder','Reorder',1,1)").run();
  await db.insert(schema.images).values({
    id: "reorder-p", episodeId: "reorder-e", filename: "reorder.png", originalName: "reorder.png",
    width: 10, height: 10, sortOrder: 0, createdAt: 1, updatedAt: 1,
  });
  await db.insert(schema.lines).values(
    ["r1", "r2", "r3", "r4"].map((id, i) => ({
      id, episodeId: "reorder-e", imageId: "reorder-p", body: "", lineType: '""' as const, sortOrder: i, updatedAt: 1,
    })),
  );
  const updated = await reorderPageRegions("reorder-e", "reorder-p", "r1", "r4");
  assert.deepEqual(updated.map((line) => line.id), ["r1", "r4", "r2", "r3"]);
  assert.deepEqual(updated.map((line) => line.sortOrder), [1, 2, 3, 4]);
  await assert.rejects(reorderPageRegions("reorder-e", "reorder-p", "r1", "r4"), /already next/);
  const first = await reorderPageRegions("reorder-e", "reorder-p", null, "r3");
  assert.deepEqual(first.map((line) => line.id), ["r3", "r1", "r4", "r2"]);
  assert.deepEqual(first.map((line) => line.sortOrder), [1, 2, 3, 4]);
});

test("Japanese detection bands read right-to-left without interleaving lower rows", () => {
  const boxes = [
    { id: "left", x: 0.1, y: 0.1, w: 0.2, h: 0.15 },
    { id: "lower", x: 0.6, y: 0.5, w: 0.2, h: 0.15 },
    { id: "right", x: 0.65, y: 0.11, w: 0.2, h: 0.15 },
  ];
  assert.deepEqual(
    orderRegions(boxes, (b) => b, "rtl").map((b) => b.id),
    ["right", "left", "lower"],
  );
  assert.deepEqual(
    orderRegions(boxes, (b) => b, "ltr").map((b) => b.id),
    ["left", "right", "lower"],
  );
});

test("versioned migrations preserve source comments and are safe to run again", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { migrateWorkflow, migrateWorkflowV2 } =
    await import("../src/lib/server/db/workflowMigration");
  const legacy = new Database(":memory:");
  legacy.exec(`
    CREATE TABLE series(id TEXT PRIMARY KEY);
    CREATE TABLE episodes(id TEXT PRIMARY KEY);
    CREATE TABLE images(id TEXT PRIMARY KEY,episode_id TEXT,sort_order REAL,width INT,height INT,updated_at INT,caption TEXT);
    CREATE TABLE lines(id TEXT PRIMARY KEY,episode_id TEXT,image_id TEXT,body TEXT,line_type TEXT,status TEXT,x REAL,y REAL,w REAL,h REAL,sort_order REAL);
    CREATE TABLE comments(id TEXT PRIMARY KEY,line_id TEXT,body TEXT,correction INT,created_at INT);
    INSERT INTO episodes VALUES('e');
    INSERT INTO lines VALUES('l','e',NULL,'Approved English','plain','approved',0,0,1,1,0);
    INSERT INTO comments VALUES('old','l','Source: 古い',0,1),('new','l','Source: 最新',0,2),('note','l','Keep this history',0,3);
  `);
  migrateWorkflow(legacy);
  migrateWorkflowV2(legacy);
  migrateWorkflow(legacy);
  migrateWorkflowV2(legacy);
  assert.deepEqual(
    legacy.prepare("SELECT source,body,status FROM lines").get(),
    { source: "最新", body: "Approved English", status: "approved" },
  );
  assert.equal(
    (legacy.prepare("SELECT count(*) n FROM comments").get() as any).n,
    3,
  );
  legacy
    .prepare("UPDATE comments SET body='Edited note' WHERE id='note'")
    .run();
  assert.equal(
    (
      legacy
        .prepare("SELECT revision FROM comments WHERE id='note'")
        .get() as any
    ).revision,
    1,
  );
  assert.match(
    (
      legacy
        .prepare(
          "SELECT data FROM workflow_revisions WHERE entity_id='comment:note'",
        )
        .get() as any
    ).data,
    /Keep this history/,
  );
  legacy.close();
});

test("server restart marks unfinished jobs interrupted and keeps unique page results", async () => {
  const { createJob, pageResult, updateJob } =
    await import("../src/lib/server/jobs");
  const id = createJob("e", "translate", { imageIds: ["p", "p2"] });
  pageResult(id, "p", "completed");
  pageResult(id, "p", "completed");
  const done = createJob("e", "export", {});
  updateJob(done, "completed", { artifact: "retained" });
  const { spawnSync } = await import("node:child_process");
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--eval", "import('./src/lib/server/jobs.ts')"],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(
    (
      sqlite
        .prepare("SELECT state FROM workflow_jobs WHERE id=?")
        .get(id) as any
    ).state,
    "interrupted",
  );
  assert.equal(
    (
      sqlite
        .prepare("SELECT count(*) n FROM job_pages WHERE job_id=?")
        .get(id) as any
    ).n,
    1,
  );
  assert.equal(
    (
      sqlite
        .prepare("SELECT state FROM workflow_jobs WHERE id=?")
        .get(done) as any
    ).state,
    "completed",
  );
});

test("workflow lists every job including older cleaning runs", async () => {
  const { createJob, listJobs } = await import("../src/lib/server/jobs");
  for (let i = 0; i < 45; i++)
    createJob("e", i % 2 ? "clean" : "mask", { imageId: "p", n: i });
  const jobs = listJobs("e");
  assert.ok(jobs.length >= 45);
  assert.ok(jobs.some((j) => j.kind === "clean"));
  assert.ok(jobs.some((j) => j.kind === "mask"));
});

test("outlined and rotated shaped preview agrees with cropped export pixels", async () => {
  const img = (await listImages("e"))[0];
  const original = (await listLines("e"))[0];
  const sourceDoc = await preparePage(series, episode, img);
  for (const { rotation, skewX = 0, skewY = 0 } of [
    { rotation: 0 },
    { rotation: 35 },
    { rotation: -90 },
    { rotation: 20, skewX: 25, skewY: -10 },
  ]) {
    const label = `Rotation ${rotation} skew ${skewX}/${skewY}`;
    const line = {
      ...original,
      body: "Wait! Why?",
      x: 0.02,
      y: 0.05,
      w: 0.6,
      h: 0.75,
    };
    const region = {
      style: {
        ...DEFAULT_STYLE,
        fontId: ttf.font.id,
        size: 18,
        rotation,
        skewX,
        skewY,
        outlineWidth: 2,
        fill: "#662233",
      },
    };
    const layout = await fitText(line, region, img, region.style, 72);
    assert.equal(layout.overflow, false, label);
        if (skewX || skewY)
      assert.match(layout.svg, new RegExp(`rotate\\(${rotation} [^)]+\\) translate\\([^)]+\\) skewX\\(${skewX}\\) skewY\\(${skewY}\\)`), label);
    else assert.doesNotMatch(layout.svg, /skew/, label);
    const page = {
      image: img,
      source: sourceDoc.data,
      sourceRevision: sourceDoc.revision,
      dpi: 72,
      regions: [{ line, data: { ...region, layout }, revision: 1 }],
    };
    const rendered = await renderPage(page);
    const expected = await sharp(rendered.base)
      .composite([{ input: Buffer.from(layout.svg), left: 0, top: 0 }])
      .ensureAlpha()
      .raw()
      .toBuffer();
    const actual = await sharp(rendered.composite)
      .ensureAlpha()
      .raw()
      .toBuffer();
    assert.deepEqual(actual, expected, label);
    const psdBytes = await finishedPsd(page, rendered);
    const fixture = `rotation-${rotation}${skewX || skewY ? `-skew-${skewX}-${skewY}` : ""}`;
    await writeFile(join(exportFixtures, `${fixture}.psd`), psdBytes);
    await writeFile(join(exportFixtures, `${fixture}.png`), rendered.composite);
    const psd = readPsd(psdBytes, {
      useImageData: true,
    });
    const layer = psd.children!.find((c) => c.text)!;
    assert.equal(layer.text!.style!.strokeFlag, false);
    assert.equal(layer.effects!.stroke![0].size!.value, 2);
    // Photoshop's 2×3 affine, computed independently: R(rotation) · skewX · skewY about the
    // region centre. At 72 dpi text points equal page pixels, so no unit scaling applies.
    const rad = (deg: number) => (deg * Math.PI) / 180;
    const cos = Math.cos(rad(rotation)), sin = Math.sin(rad(rotation));
    const kx = Math.tan(rad(skewX)), ky = Math.tan(rad(skewY));
    const cx = (line.x + line.w / 2) * img.width, cy = (line.y + line.h / 2) * img.height;
    const a = cos * (1 + kx * ky) - sin * ky, b = sin * (1 + kx * ky) + cos * ky;
    const c = cos * kx - sin, d = sin * kx + cos;
    const wanted = [a, b, c, d, cx - a * cx - c * cy, cy - b * cx - d * cy];
    const transform = layer.text!.transform!;
    assert.equal(transform.length, 6, label);
    for (const [i, v] of wanted.entries())
      assert.ok(Math.abs(transform[i] - v) < 1e-6, `${label}: transform[${i}] ${transform[i]} ≠ ${v}`);
    // The centre is the pivot, so the matrix maps it onto itself.
    assert.ok(Math.abs(transform[0] * cx + transform[2] * cy + transform[4] - cx) < 1e-6, label);
    assert.ok(Math.abs(transform[1] * cx + transform[3] * cy + transform[5] - cy) < 1e-6, label);
  }
});

test("Arc warp preview moves glyphs and PSD stores Warp Text", async () => {
  const img = (await listImages("e"))[0];
  const original = (await listLines("e"))[0];
  const sourceDoc = await preparePage(series, episode, img);
  const line = {
    ...original,
    body: "BOOM",
    x: 0.05,
    y: 0.1,
    w: 0.7,
    h: 0.4,
  };
  const region = {
    style: {
      ...DEFAULT_STYLE,
      fontId: ttf.font.id,
      size: 22,
      warpStyle: "arc" as const,
      warpBend: 40,
      fill: "#112233",
    },
  };
  const layout = await fitText(line, region, img, region.style, 72);
  assert.equal(layout.overflow, false);
  const flat = await fitText(
    line,
    { style: { ...region.style, warpStyle: "none", warpBend: 0 } },
    img,
    { ...region.style, warpStyle: "none", warpBend: 0 },
    72,
  );
  assert.notEqual(layout.svg, flat.svg);
  assert.doesNotMatch(layout.svg, /scale\([^)]+\)/);
  assert.match(layout.svg, /<path d="M[\d.-]+ [\d.-]+L/);
  const page = {
    image: img,
    source: sourceDoc.data,
    sourceRevision: sourceDoc.revision,
    dpi: 72,
    regions: [{ line, data: { ...region, layout }, revision: 1 }],
  };
  const rendered = await renderPage(page);
  const psdBytes = await finishedPsd(page, rendered);
  await writeFile(join(exportFixtures, "warp-arc.psd"), psdBytes);
  await writeFile(join(exportFixtures, "warp-arc.png"), rendered.composite);
  const psd = readPsd(psdBytes, { useImageData: true });
  const layer = psd.children!.find((c) => c.text)!;
  assert.equal(layer.text!.warp!.style, "arc");
  assert.equal(layer.text!.warp!.value, 40);
  assert.equal(layer.text!.warp!.rotate, "horizontal");
});

console.log(`Export acceptance fixtures: ${exportFixtures}`);

test("detection retains narrow text bounds instead of expanding to the enclosing bubble", async () => {
  const { regionsFromDetection } = await import("../src/lib/server/detect");
  const regions = regionsFromDetection(
    [
      { cls: "text_bubble", box: [430, 130, 470, 290], score: 0.95 },
      { cls: "bubble", box: [300, 70, 650, 350], score: 0.9 },
    ],
    1000,
    1000,
  );
  assert.equal(regions.length, 1);
  assert.ok(
    regions[0].place.width < 60,
    "A narrow vertical text column must not become a 350px balloon box",
  );
  assert.ok(regions[0].ocr.width < 60);
});

test("image-model reread bypasses OCR, describes missing context first, and updates exactly the selected region", async () => {
  const mask = await (await import("./local-ocr-fixture")).localMaskFixture();
  const { translateRegion } = await import("../src/lib/server/aiTranslate");
  sqlite.prepare("UPDATE images SET caption='' WHERE id='p'").run();
  const line = (await listLines("e"))[0];
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    const system = payload.messages[0].content;
    let response: string;
    if (system.startsWith("You read")) {
      calls.push("read");
      assert.ok(
        payload.messages[1].content.some((c: any) => c.type === "image_url"),
      );
      response = JSON.stringify({ source: "ここで待って。", lineType: '""' });
    } else if (system.startsWith("You translate")) {
      calls.push("translate");
      assert.match(payload.messages[1].content, /Alice waits beside the gate/);
      response = JSON.stringify({
        items: [
          {
            i: 0,
            translation: "Wait here.",
            literal: "Wait here.",
            reasoning: "Scene context confirms the speaker.",
          },
        ],
      });
    } else {
      calls.push("describe");
      response = "Alice waits beside the gate and asks her friend to stay.";
    }
    return Response.json({ choices: [{ message: { content: response } }] });
  };
  try {
    const result = await translateRegion({
      series,
      episode,
      user: { id: "u", username: "test", role: "admin" },
      imageId: "p",
      lineId: line.id,
      expectedRevision: line.revision,
      x: line.x!,
      y: line.y!,
      w: line.w!,
      h: line.h!,
      engine: "qwen",
      model: "fixture",
      lang: "japanese",
      forceVision: true,
    });
    assert.deepEqual(calls, ["describe", "read", "translate"]);
    assert.equal(result.id, line.id);
    assert.equal(result.body, "Wait here.");
    assert.equal(result.source, "ここで待って。");
    assert.equal(result.status, "needs_work");
    assert.equal(result.w, line.w);
    assert.equal((await listLines("e")).length, 1);
  } finally {
    mask.restore();
    globalThis.fetch = originalFetch;
  }
});

test("reread preserves a concurrent edit and retains model output as a suggestion", async () => {
  const mask = await (await import("./local-ocr-fixture")).localMaskFixture();
  const { translateRegion } = await import("../src/lib/server/aiTranslate");
  const line = (await listLines("e"))[0];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    const reading = payload.messages[0].content.startsWith("You read");
    if (!reading)
      sqlite
        .prepare("UPDATE lines SET body='Collaborator correction' WHERE id=?")
        .run(line.id);
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify(
              reading
                ? { source: "待って", lineType: '""' }
                : {
                    items: [
                      {
                        i: 0,
                        translation: "Please wait.",
                        literal: "Wait",
                        reasoning: "",
                      },
                    ],
                  },
            ),
          },
        },
      ],
    });
  };
  try {
    await assert.rejects(
      () =>
        translateRegion({
          series,
          episode,
          user: { id: "u", username: "test", role: "admin" },
          imageId: "p",
          lineId: line.id,
          expectedRevision: line.revision,
          x: line.x!,
          y: line.y!,
          w: line.w!,
          h: line.h!,
          engine: "qwen",
          model: "fixture",
          lang: "japanese",
          forceVision: true,
        }),
      /changed during rereading/,
    );
    assert.equal((await listLines("e"))[0].body, "Collaborator correction");
    assert.ok(
      sqlite
        .prepare(
          "SELECT 1 FROM suggestions WHERE line_id=? AND body='Please wait.'",
        )
        .get(line.id),
    );
  } finally {
    mask.restore();
    globalThis.fetch = originalFetch;
  }
});

test("redetection tightens untouched AI drafts but preserves English and manually edited bounds", async () => {
  const { insertSticky } = await import("../src/lib/server/aiTranslate");
  const { ensureAiUser } = await import("../src/lib/server/aiUser");
  await ensureAiUser();
  await db
    .insert(schema.lines)
    .values({
      id: "bounds-draft",
      episodeId: "e",
      imageId: "p",
      body: "Existing draft",
      source: "テスト",
      sourceState: "read",
      lineType: '""',
      status: "none",
      placed: true,
      x: 0.01,
      y: 0.01,
      w: 0.15,
      h: 0.12,
      sortOrder: 5,
      updatedBy: "ai-ocr",
      updatedAt: 1,
    });
  const box = {
    x: 0.04,
    y: 0.02,
    w: 0.05,
    h: 0.09,
    source: "テスト",
    translation: "Existing draft",
    lineType: '""' as const,
    literal: "",
    reasoning: "",
  };
  const narrowed = await insertSticky({
    episodeId: "e",
    imageId: "p",
    box,
    sortOrder: 5,
  });
  assert.equal(narrowed.id, "bounds-draft");
  assert.equal(narrowed.w, 0.05);
  assert.equal(narrowed.body, "Existing draft");
  sqlite
    .prepare("UPDATE lines SET w=.12,updated_by='u' WHERE id='bounds-draft'")
    .run();
  const manual = await insertSticky({
    episodeId: "e",
    imageId: "p",
    box,
    sortOrder: 5,
  });
  assert.equal(manual.w, 0.12);
  assert.equal(manual.body, "Existing draft");
});

test("translation hits never copy source and attach by line id at the sent revision", async () => {
  const { applyTranslationHits } = await import("../src/lib/server/llm");
  const { applyLineTranslation } = await import("../src/lib/server/aiTranslate");
  const boxes = [
    { x: 0, y: 0, w: 0.2, h: 0.1, lineType: '""' as const, source: "待って", literal: "", translation: "", reasoning: "" },
    { x: 0.5, y: 0.5, w: 0.2, h: 0.1, lineType: '""' as const, source: "行け", literal: "", translation: "", reasoning: "" },
  ];
  const partial = applyTranslationHits(boxes, new Map([[0, { literal: "wait", translation: "Wait!", reasoning: "imperative" }]]));
  assert.equal(partial[0].translation, "Wait!");
  assert.equal(partial[1].translation, "", "omitted lines stay blank instead of copying source");
  assert.equal(partial[1].source, "行け");

  sqlite.prepare("INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES('tr-e','s','tr','Translate identity',1,1)").run();
  await db.insert(schema.images).values({
    id: "tr-p", episodeId: "tr-e", originalName: "tr.png", ...saved, sortOrder: 0, createdAt: 1, updatedAt: 1,
  });
  await db.insert(schema.lines).values({
    id: "tr-a", episodeId: "tr-e", imageId: "tr-p", source: "待って", sourceState: "read",
    body: "", lineType: '""', status: "none", placed: true, x: 0.1, y: 0.1, w: 0.2, h: 0.1,
    sortOrder: 0, updatedBy: "u", updatedAt: 1,
  });
  await db.insert(schema.lines).values({
    id: "tr-b", episodeId: "tr-e", imageId: "tr-p", source: "行け", sourceState: "read",
    body: "", lineType: '""', status: "none", placed: true, x: 0.6, y: 0.6, w: 0.2, h: 0.1,
    sortOrder: 1, updatedBy: "u", updatedAt: 1,
  });
  const a = (await listLines("tr-e")).find((line) => line.id === "tr-a")!;
  applyLineTranslation({
    episodeId: "tr-e", lineId: "tr-a", expectedRevision: a.revision ?? 0,
    expectedSource: "待って", translation: "Wait!", reasoning: "imperative", userId: "u",
  });
  assert.equal((await listLines("tr-e")).find((line) => line.id === "tr-a")!.body, "Wait!");
  applyLineTranslation({
    episodeId: "tr-e", lineId: "tr-b", expectedRevision: 0,
    expectedSource: "行け", translation: "",
  });
  assert.equal((await listLines("tr-e")).find((line) => line.id === "tr-b")!.body, "");
  sqlite.prepare("UPDATE lines SET source=?,x=0.7,y=0.7 WHERE id='tr-b'").run("新しい");
  const afterMove = (await listLines("tr-e")).find((line) => line.id === "tr-b")!;
  applyLineTranslation({
    episodeId: "tr-e", lineId: "tr-b", expectedRevision: 0, expectedSource: "行け",
    translation: "Go!", reasoning: "late",
  });
  const moved = (await listLines("tr-e")).find((line) => line.id === "tr-b")!;
  assert.equal(moved.body, "", "stale translation must not overwrite a later source");
  assert.equal(moved.source, "新しい");
  const suggestion = sqlite.prepare("SELECT body,base_revision FROM suggestions WHERE line_id='tr-b' AND kind='translation'").get() as { body: string; base_revision: number };
  assert.equal(suggestion.body, "Go!");
  assert.equal(suggestion.base_revision, 0);
  assert.equal((await listLines("tr-e")).length, 2, "translation must not create a second region for a moved box");
  assert.notEqual(afterMove.revision, 0);
});

test("HTTP translation retries omitted indexes and leaves the rest blank", async () => {
  const { translateScript } = await import("../src/lib/server/llm");
  const boxes = [0, 1].map((i) => ({
    x: 0, y: i * 0.2, w: 0.2, h: 0.1, lineType: '""' as const,
    source: i ? "行け" : "待って", literal: "", translation: "", reasoning: "",
  }));
  const originalFetch = globalThis.fetch;
  const prompts: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    prompts.push(payload.messages[1].content);
    const first = prompts.length === 1;
    const items = first
      ? [{ i: 0, literal: "wait", translation: "Wait!", reasoning: "ok" }]
      : [{ i: 1, literal: "go", translation: "Go!", reasoning: "ok" }];
    return Response.json({ choices: [{ message: { content: JSON.stringify({ items }) } }] });
  };
  try {
    const translated = await translateScript(boxes, {
      seriesNotes: "", prior: "", pageLabel: "page 1", model: "translate-fixture",
    });
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /\[1\]/);
    assert.equal(translated[0].translation, "Wait!");
    assert.equal(translated[1].translation, "Go!");
    prompts.length = 0;
    globalThis.fetch = async () =>
      Response.json({ choices: [{ message: { content: JSON.stringify({ items: [] }) } }] });
    const blank = await translateScript(boxes, {
      seriesNotes: "", prior: "", pageLabel: "page 1", model: "translate-fixture",
    });
    assert.equal(blank[0].translation, "");
    assert.equal(blank[1].translation, "");
    assert.equal(blank[0].source, "待って");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("one exception queue walks OCR, blank English, unapproved translations, then masks, then overflow", async () => {
  const { chapterExceptions, nextException, nextTranslationReview } = await import("../src/lib/exceptions");
  const { failedOcrConsensus } = await import("../src/lib/ocrConsensus");
  const failed = failedOcrConsensus("Paint or detect lettering before sending a masked crop");
  assert.equal(failed.agreed, false);
  assert.equal(failed.readings.length, 2);
  assert.ok(failed.readings.every((reading) => reading.error?.includes("Paint or detect")));
  const line = (id: string, imageId: string, extra: Record<string, unknown> = {}): LineRow => ({
    id, episodeId: "e", imageId, body: "", source: "", sourceState: "read", ignoreReason: "",
    lineType: '""', status: "none", placed: true, invert: null, x: 0, y: 0, w: 0.1, h: 0.1,
    sidebarX: null, sidebarY: null, sidebarW: 0, sidebarH: 0, sortOrder: 0,
    createdBy: "u", updatedBy: "u", updatedAt: 1, ...extra,
  });
  const image = (id: string, sortOrder: number): ImageRow => ({
    id, episodeId: "e", filename: `${id}.png`, originalName: `${id}.png`, sortOrder,
    width: 100, height: 100, caption: "", role: "page", createdAt: 1, updatedAt: 1,
  });
  const list = chapterExceptions({
    images: [image("p0", 0), image("p1", 1)],
    lines: [
      line("l0", "p0", { sortOrder: 0, source: "", sourceState: "unreadable" }),
      line("l1", "p0", { sortOrder: 1, source: "待って", body: "" }),
      line("l2", "p0", { sortOrder: 2, source: "待て", body: "Wait.", status: "approved" }),
      line("l3", "p1", { sortOrder: 0, source: "行け", body: "Go!" }),
    ],
    pages: {
      p0: { data: { mask: "mask-asset", maskApproved: false } },
      p1: { data: {} },
    },
    regions: {
      l2: { data: { layout: { overflow: true } as FittedLayout } },
    },
    suggestions: [{ line_id: "l0", state: "pending", kind: "source-review" }],
  });
  assert.deepEqual(list.map((item) => item.kind), ["ocr", "english", "english", "mask", "overflow"]);
  assert.deepEqual(list.map((item) => item.lineId ?? item.imageId), ["l0", "l1", "l3", "p0", "l2"]);
  assert.equal(list[1].label, "Missing English");
  assert.equal(list[2].label, "Needs review");
  assert.equal(nextException(list)?.id, list[0].id);
  assert.equal(nextException(list, list[0])?.id, list[1].id);
  assert.equal(nextException(list, list[1])?.id, list[2].id);
  assert.equal(nextException(list, list[4])?.id, list[0].id);
  const reviewOrder = [
    line("l1", "p0", { sortOrder: 1, source: "待って", body: "Wait." }),
    line("l2", "p0", { sortOrder: 2, source: "待て", body: "Hold on.", status: "approved" }),
    line("l3", "p1", { sortOrder: 0, source: "行け", body: "Go!" }),
  ];
  assert.equal(nextTranslationReview(reviewOrder, "l1")?.id, "l3");
  assert.equal(nextTranslationReview(reviewOrder, "l3")?.id, "l1");
  assert.equal(nextTranslationReview([reviewOrder[1]], "l2"), undefined);
});

test("review flags regions that have no source or English text", async () => {
  const { missingRegionCopy, missingRegionCopyLabel } = await import("../src/lib/exceptions");
  const line = (extra: Record<string, unknown> = {}) => ({
    sourceState: "read",
    source: "待って",
    body: "Wait.",
    ...extra,
  });
  assert.equal(missingRegionCopy(line()), null);
  assert.equal(missingRegionCopy(line({ source: "  " })), "source");
  assert.equal(missingRegionCopy(line({ body: "\n" })), "english");
  assert.equal(missingRegionCopy(line({ source: "", body: "  " })), "both");
  assert.equal(missingRegionCopy(line({ source: "", body: "", sourceState: "ignored" })), null);
  assert.equal(missingRegionCopyLabel("source"), "No source text");
  assert.equal(missingRegionCopyLabel("english"), "No English text");
  assert.equal(missingRegionCopyLabel("both"), "No source or English text");
});

test("previous saved artwork pins across restore strokes and skips the current image", async () => {
  const id = "page:restore-source-fixture";
  const prepared = putDoc("e", id, { prepared: "prep" }, 0);
  const inpainted = putDoc("e", id, { prepared: "prep", cleaned: "codex" }, prepared.revision);
  assert.equal(previousSavedArtwork(id, inpainted.data), "prep");
  const restored = putDoc(
    "e",
    id,
    { prepared: "prep", cleaned: "partial", previousArtwork: "prep" },
    inpainted.revision,
  );
  assert.equal(previousSavedArtwork(id, restored.data), "prep");
  assert.equal(
    previousSavedArtwork(id, { prepared: "prep", cleaned: "partial" }),
    "codex",
  );
  const empty = putDoc("e", "page:restore-empty-fixture", { prepared: "prep" }, 0);
  assert.equal(previousSavedArtwork(empty.id, empty.data), undefined);
  assert.equal(getDoc<{ previousArtwork?: string }>(id, {}).data.previousArtwork, "prep");
});

test("applied cleaning starts a fresh pass without changing sources and supports undo", async () => {
  const { applyCleaning } = await import("../src/lib/server/workflowService");
  const id = "page:clean-pass-fixture";
  const first = putDoc("e", id, {
    original: "raw", prepared: "prepared", preparedAt: 1,
    cleaned: "first-result", mask: "first-mask", maskApproved: true,
    cleanApproved: true,
  }, 0);
  const applied = applyCleaning("e", "clean-pass-fixture", first.revision);
  assert.equal(applied.data.cleanBase, "first-result");
  assert.equal(applied.data.original, "raw");
  assert.equal(applied.data.prepared, "prepared");
  assert.equal(applied.data.mask, undefined);
  assert.equal(applied.data.cleaned, undefined);
  assert.equal(applied.data.maskApproved, false);
  assert.equal(applied.data.cleanApproved, false);
  assert.throws(() => applyCleaning("e", "clean-pass-fixture", applied.revision), /Run cleaning/);
  const next = putDoc("e", id, { ...applied.data, cleaned: "second-result", mask: "touchup-mask" }, applied.revision);
  assert.throws(() => applyCleaning("e", "clean-pass-fixture", first.revision), /changed/);
  const second = applyCleaning("e", "clean-pass-fixture", next.revision);
  assert.equal(second.data.cleanBase, "second-result");
  assert.equal(second.data.original, "raw");
  const undone = putDoc("e", id, second.data, second.revision, "undo");
  assert.equal(undone.data.cleanBase, "first-result");
  assert.equal(undone.data.cleaned, "second-result");
  assert.equal(undone.data.mask, "touchup-mask");
});

test("page write conflicts expose the current revision for a retry", async () => {
  const { pageWriteConflict } = await import("../src/lib/pageConflict");
  const current = { id: "page:p", revision: 10, data: { maskApproved: false }, canUndo: true, canRedo: false };
  const stale = Object.assign(new Error("Page changed. Reload the current version."), {
    status: 409,
    current,
  });
  assert.equal(pageWriteConflict(stale)?.revision, 10);
  assert.equal(pageWriteConflict(new Error("Page changed. Reload the current version.")), null);
  assert.equal(pageWriteConflict(Object.assign(new Error("changed"), { status: 409 })), null);
});

test("shared fonts and defaults work across series without exposing private fonts", async () => {
  const { listFonts, loadFont } = await import("../src/lib/server/typesetting");
  const { resolveStyle, preferences } = await import("../src/lib/server/workflowService");
  const bytes = await readFile(fontFile);
  const global = await uploadFont(null, "Shared.ttf", bytes);
  assert.equal((await uploadFont(null, "Again.ttf", bytes)).duplicate, true);
  assert.ok(listFonts("another-series").some(f => f.id === global.font.id));
  assert.ok(!listFonts("another-series").some(f => f.id === ttf.font.id));
  assert.equal((await loadFont(global.font.id)).metadata.familyName, global.font.familyName);
  const before = getDoc("series:another-series", {});
  putDoc(null, before.id, { style: { fontId: global.font.id, size: 22 } }, before.revision);
  const line = (await listLines("e"))[0];
  assert.equal(resolveStyle(line, {}, "unused-chapter", "another-series").fontId, global.font.id);
  assert.equal(preferences("unused-chapter", "another-series").styles?.[line.lineType]?.size, 22);
  assert.equal(resolveStyle(line, { style: { ...DEFAULT_STYLE, fontId: ttf.font.id } }, "e", "s").fontId, ttf.font.id);
});

test("font categories group pickers, the inspector lists glyphs, and removal is safe", async () => {
  const { listFonts, setFontCategory, deleteFont, fontUsage, fontGlyphs } =
    await import("../src/lib/server/typesetting");
  const { assetPath } = await import("../src/lib/server/workflowStore");
  const { groupFontsByCategory, FONT_CATEGORIES } = await import("../src/lib/fontCategories");
  const { existsSync } = await import("node:fs");
  const bytes = await readFile("/usr/share/fonts/julietaula-montserrat-fonts/Montserrat-Regular.otf");
  // The series font "s" copy of these bytes (uploaded above) must keep its file when this shared copy goes.
  const shared = await uploadFont(null, "Montserrat-Shared.otf", bytes, "sfx");
  assert.equal(shared.font.category, "sfx");
  assert.equal(listFonts(null).find(f => f.id === shared.font.id)?.shared, true);
  assert.equal(listFonts("s").find(f => f.id === otf.font.id)?.shared, false);
  // Fonts without a stored category, or with a bogus one, read as "other".
  assert.equal(listFonts("s").find(f => f.id === ttf.font.id)?.category, "other");

  // Categories: validated, applied in bulk, and grouped in the fixed category order.
  assert.throws(() => setFontCategory(null, [shared.font.id], "nonsense"), /valid font category/);
  assert.throws(() => setFontCategory(null, ["missing"], "sfx"), /not found/);
  assert.throws(() => setFontCategory(null, [otf.font.id], "sfx"), /not found/, "a series font is not editable as a shared font");
  setFontCategory("s", [ttf.font.id], "handwriting");
  const groups = groupFontsByCategory(listFonts("s"));
  const order = FONT_CATEGORIES.map(c => c.id as string);
  assert.deepEqual(groups.map(g => g.id), [...groups.map(g => g.id)].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
  assert.ok(groups.find(g => g.id === "handwriting")!.fonts.some(f => f.id === ttf.font.id));
  assert.ok(groups.find(g => g.id === "sfx")!.fonts.some(f => f.id === shared.font.id));
  setFontCategory("s", [ttf.font.id], "other");

  // Inspector data: every mapped character plus file details.
  const glyphs = await fontGlyphs("s", ttf.font.id);
  assert.ok(glyphs.codepoints.includes("A".codePointAt(0)!));
  assert.deepEqual(glyphs.codepoints, [...glyphs.codepoints].sort((a, b) => a - b));
  assert.ok(glyphs.info.glyphCount >= glyphs.codepoints.length);
  await assert.rejects(fontGlyphs(null, otf.font.id), /not found/);

  // Removal: refused while a style uses the font, and force clears that choice.
  const doc = getDoc("series:font-removal-series", {});
  putDoc(null, doc.id, { style: { fontId: shared.font.id, size: 12 } }, doc.revision);
  assert.equal(fontUsage(shared.font.id).total, 1);
  assert.throws(
    () => deleteFont(null, shared.font.id),
    (e: any) => e.status === 409 && /used by 1 style/.test(e.message) && e.current.usage.total === 1,
  );
  assert.ok(listFonts(null).some(f => f.id === shared.font.id));
  const removed = deleteFont(null, shared.font.id, true);
  assert.equal(removed.cleared, 1);
  const after = getDoc<{ style?: { fontId?: string } }>("series:font-removal-series", {});
  assert.equal(after.data.style?.fontId, "");
  assert.ok(after.revision > doc.revision);
  assert.ok(!listFonts(null).some(f => f.id === shared.font.id));
  assert.ok(existsSync(assetPath(otf.font.hash)), "bytes still used by a series font are kept");
  assert.throws(() => deleteFont(null, shared.font.id), (e: any) => e.status === 404);
  assert.throws(() => deleteFont(null, otf.font.id), (e: any) => e.status === 404, "shared scope cannot remove a series font");
});

test("series type settings apply per text type and reset clears region overrides", async () => {
  const { resolveStyle, saveSeriesTypeSettings, resetRegionStyles } =
    await import("../src/lib/server/workflowService");
  const line = (await listLines("e"))[0];
  const seriesDoc = getDoc("series:s", {});
  const previous = seriesDoc.data;
  try {
    putDoc(
      null,
      seriesDoc.id,
      {
        style: { fontId: ttf.font.id, size: 8, minSize: 6 },
        styles: {
          '""': { fontId: ttf.font.id, size: 8, minSize: 6 },
          "::": { fontId: ttf.font.id, size: 7, minSize: 6 },
        },
      },
      seriesDoc.revision,
    );
    assert.equal(resolveStyle(line, {}, "e", "s").size, 8);
    assert.equal(
      resolveStyle({ ...line, lineType: "::" }, {}, "e", "s").size,
      7,
    );
    await db.insert(schema.lines).values({
      id: "type-reset",
      episodeId: "e",
      imageId: "p",
      source: "text",
      sourceState: "read",
      body: "Reset me",
      lineType: '""',
      status: "approved",
      placed: true,
      x: 0.2,
      y: 0.25,
      w: 0.6,
      h: 0.5,
      sortOrder: 9,
      updatedAt: 1,
    });
    const baked = putDoc(
      "e",
      "region:type-reset",
      { style: { ...DEFAULT_STYLE, fontId: ttf.font.id, size: 12 } },
      0,
    );
    assert.equal(
      resolveStyle(
        (await listLines("e")).find((l) => l.id === "type-reset")!,
        baked.data,
        "e",
        "s",
      ).size,
      12,
    );
    const reset = resetRegionStyles("e", { imageId: "p" });
    assert.ok(reset.cleared >= 1);
    assert.equal(getDoc<{ style?: unknown }>("region:type-reset", {}).data.style, undefined);
    assert.equal(
      resolveStyle(
        (await listLines("e")).find((l) => l.id === "type-reset")!,
        getDoc("region:type-reset", {}).data,
        "e",
        "s",
      ).size,
      8,
    );
    const saved = saveSeriesTypeSettings("s", getDoc("series:s", {}).revision, {
      style: { fontId: ttf.font.id, size: 9, minSize: 6 },
      styles: {
        '""': { fontId: ttf.font.id, size: 9, minSize: 6 },
        "::": { fontId: ttf.font.id, size: 6.5, minSize: 6 },
      },
    });
    assert.equal(saved.data.styles?.['""']?.size, 9);
    assert.equal(saved.data.styles?.["::"]?.size, 6.5);
    assert.equal(resolveStyle(line, {}, "e", "s").size, 9);
  } finally {
    putDoc(null, "series:s", previous, getDoc("series:s", {}).revision);
  }
});

test("series text styles round trip for region types the series added", async () => {
  const {
    resolveStyle,
    preferences,
    saveSeriesRegionKinds,
    saveSeriesTypeSettings,
  } = await import("../src/lib/server/workflowService");
  const { activeRegionKinds } = await import("../src/lib/regionCatalog");
  const { allTypeStyles, typeStyle } = await import("../src/lib/workflow");
  const canonical = activeRegionKinds(undefined);
  const custom = [...canonical, { id: "sfx-2", label: "Impact SFX", color: "#00ff00" }];
  const seriesDoc = getDoc("series:s", {});
  const previous = seriesDoc.data;
  try {
    saveSeriesRegionKinds("s", getDoc("series:s", {}).revision, custom);
    const saved = saveSeriesTypeSettings("s", getDoc("series:s", {}).revision, {
      style: { fontId: ttf.font.id, size: 8, minSize: 6 },
      styles: {
        "sfx-2": { fontId: ttf.font.id, size: 21, minSize: 6 },
      },
    });
    // The added type's style is stored, not silently dropped.
    assert.equal(saved.data.styles?.["sfx-2"]?.size, 21);
    // It loads for a region using the added id.
    const line = (await listLines("e"))[0];
    assert.equal(
      resolveStyle(
        { ...line, lineType: "sfx-2" as typeof line.lineType },
        {},
        "e",
        "s",
      ).size,
      21,
    );
    // It reaches the editor's preferences and type settings window.
    assert.equal(preferences("e", "s").styles?.["sfx-2"]?.size, 21);
    const doc = getDoc<Partial<import("../src/lib/workflow").Preferences>>("series:s", {});
    assert.equal(allTypeStyles(doc.data)["sfx-2"]?.size, 21);
    assert.equal(typeStyle(doc.data, "sfx-2").size, 21);
  } finally {
    putDoc(null, "series:s", previous, getDoc("series:s", {}).revision);
  }
});

test("fitting with resetStyle drops region overrides and uses the current type", async () => {
  const seriesDoc = getDoc("series:s", {});
  const previous = seriesDoc.data;
  try {
    putDoc(
      null,
      seriesDoc.id,
      {
        style: { fontId: ttf.font.id, size: 16, minSize: 6, autoContrast: false },
        styles: {
          '""': { fontId: ttf.font.id, size: 16, minSize: 6, autoContrast: false },
          "::": { fontId: ttf.font.id, size: 8, minSize: 6, autoContrast: false },
        },
      },
      seriesDoc.revision,
    );
    await db.insert(schema.lines).values({
      id: "type-refit",
      episodeId: "e",
      imageId: "p",
      source: "ドン",
      sourceState: "read",
      body: "BOOM",
      lineType: '""',
      status: "approved",
      placed: true,
      x: 0.2,
      y: 0.25,
      w: 0.6,
      h: 0.5,
      sortOrder: 10,
      updatedAt: 1,
    });
    const baked = putDoc(
      "e",
      "region:type-refit",
      { style: { fontId: ttf.font.id, size: 24, autoContrast: false } },
      0,
    );
    const kept = await fitRegion(series, episode, "type-refit", baked.revision);
    assert.equal(kept.data.layout?.style.size, 24);
    sqlite.prepare("UPDATE lines SET line_type=? WHERE id=?").run("::", "type-refit");
    const reset = await fitRegion(series, episode, "type-refit", kept.revision, { resetStyle: true });
    assert.equal(reset.data.style?.size, undefined);
    assert.equal(reset.data.layout?.style.size, 8);
    const changed = await fitRegion(series, episode, "type-refit", reset.revision, {
      style: { size: 12, autoContrast: false },
    });
    assert.equal(changed.revision, reset.revision + 1, "style and fitted layout share one save");
    assert.equal(changed.data.style?.size, 12);
    assert.equal(changed.data.layout?.style.size, 12);
    const { PATCH } = await import("../src/routes/api/episodes/[eid]/lines/[lid]/+server");
    const current = (await listLines("e")).find(l => l.id === "type-refit")!;
    const response = await PATCH({
      locals: { user: { id: "u", username: "test", role: "admin" } },
      params: { eid: "e", lid: current.id },
      request: new Request("http://local/lines/type-refit", { method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "NEW TEXT", expectedRevision: current.revision, refit: true }) }),
    } as any);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.line.body, "NEW TEXT");
    assert.ok(result.doc.data.layout.rows.map((row: {text: string}) => row.text).join(" ").includes("NEW TEXT"));
    assert.equal(result.doc.revision, changed.revision + 1);
  } finally {
    sqlite.prepare("DELETE FROM lines WHERE id='type-refit'").run();
    sqlite.prepare("DELETE FROM workflow_docs WHERE id='region:type-refit'").run();
    putDoc(null, "series:s", previous, getDoc("series:s", {}).revision);
  }
});

test("setting a polygon to region bounds refits placed text", async () => {
  sqlite.prepare(
    `INSERT INTO lines(id,episode_id,image_id,source,source_state,body,line_type,status,placed,x,y,w,h,sort_order,updated_at)
     VALUES('bounds-refit','e','p','あ','read','Hello there friend','""','approved',1,.2,.2,.2,.12,11,1)`,
  ).run();
  try {
    const tight = [{ x: .22, y: .22 }, { x: .28, y: .22 }, { x: .25, y: .30 }];
    const baked = putDoc(
      "e",
      "region:bounds-refit",
      { polygon: tight, style: { fontId: ttf.font.id, autoContrast: false } },
      0,
    );
    const fitted = await fitRegion(series, episode, "bounds-refit", baked.revision);
    const rectangle = putDoc(
      "e",
      "region:bounds-refit",
      { ...fitted.data, polygon: regionRectangle({ x: .2, y: .2, w: .2, h: .12 }) },
      fitted.revision,
    );
    const reflowed = await fitRegion(series, episode, "bounds-refit", rectangle.revision);
    assert.notEqual(reflowed.data.layout?.key, fitted.data.layout?.key);
    assert.equal(reflowed.data.layout?.overflow, false);
  } finally {
    sqlite.prepare("DELETE FROM lines WHERE id='bounds-refit'").run();
    sqlite.prepare("DELETE FROM workflow_docs WHERE id='region:bounds-refit'").run();
  }
});

test("series AI model settings win over leftover chapter models", async () => {
  const { preferences, saveSeriesRegionAi } = await import("../src/lib/server/workflowService");
  const { regionAiSettings } = await import("../src/lib/regionAi");
  const seriesDoc = getDoc("series:s", {});
  const chapterDoc = getDoc("chapter:e", {});
  const previousSeries = seriesDoc.data;
  const previousChapter = chapterDoc.data;
  try {
    putDoc(
      "e",
      chapterDoc.id,
      {
        ...chapterDoc.data,
        regionAi: regionAiSettings(undefined, { engine: "qwen", model: "chapter-leftover" }),
      },
      getDoc("chapter:e", {}).revision,
    );
    assert.equal(preferences("e", "s").regionAi?.translate?.model, "chapter-leftover");
    const saved = saveSeriesRegionAi(
      "s",
      getDoc("series:s", {}).revision,
      regionAiSettings(undefined, { engine: "grok", model: "series-model" }),
    );
    assert.equal(saved.data.regionAi?.translate?.model, "series-model");
    assert.equal(preferences("e", "s").regionAi?.translate?.engine, "grok");
    assert.equal(preferences("e", "s").regionAi?.translate?.model, "series-model");
  } finally {
    putDoc(null, "series:s", previousSeries, getDoc("series:s", {}).revision);
    putDoc("e", "chapter:e", previousChapter, getDoc("chapter:e", {}).revision);
  }
});

test("legacy styles below the size floor still load", async () => {
  const { resolveStyle } = await import("../src/lib/server/workflowService");
  const line = (await listLines("e"))[0];
  const style = resolveStyle(
    line,
    { style: { fontId: ttf.font.id, size: 10, minSize: 3 } },
    "e",
    "s",
  );
  assert.equal(style.minSize, 3);
  assert.equal(style.size, 10);
  const clamped = resolveStyle(
    line,
    { style: { fontId: ttf.font.id, size: 10, minSize: 0.25 } },
    "e",
    "s",
  );
  assert.equal(clamped.minSize, 1);
});

test("batch typesetting fits detected and existing interiors, skips locks, and falls back for open boundaries", async () => {
  const { typesetRegions } = await import("../src/lib/server/workflowService");
  const { listFonts } = await import("../src/lib/server/typesetting");
  const img = (await listImages("e"))[0];
  await preparePage(series, episode, img);
  const polygon = [{ x: .15, y: .15 }, { x: .85, y: .15 }, { x: .85, y: .85 }, { x: .15, y: .85 }];
  const ids = ["batch-detect", "batch-existing", "batch-locked", "batch-open"];
  for (const id of ids) {
    await db.insert(schema.lines).values({ id, episodeId: "e", imageId: img.id, source: "text", sourceState: "read", body: "Hello", lineType: '\"\"', status: "approved", placed: true, x: .2, y: .2, w: .5, h: .5, sortOrder: 0, updatedAt: 1 });
    putDoc("e", `region:${id}`, {
      style: { ...DEFAULT_STYLE, fontId: listFonts(null)[0].id },
      ...(id === "batch-existing" ? { polygon, geometryApproved: true } : {}),
      locked: id === "batch-locked",
    }, 0);
  }
  const targets = ids.map(id => (sqlite.prepare("SELECT id FROM lines WHERE id=?").get(id) as {id: string}).id);
  const rows = await listLines("e");
  let calls = 0;
  const result = await typesetRegions(series, episode, [img], targets.map(id => rows.find(l => l.id === id)!), new AbortController().signal, () => {}, async (payload) => {
    calls++;
    if (payload.method === "split") {
      assert.deepEqual(payload.polygon, polygon);
      assert.ok(Array.isArray(payload.neighbors));
      return { polygon, split: false };
    }
    assert.equal(payload.method, "opencv");
    assert.deepEqual(payload.points, [{ x: .45, y: .45 }]);
    return calls === 1 ? { polygon, confidence: .85 } : { polygon: [], message: "Open boundary" };
  });
  assert.equal(calls, 3);
  assert.equal(result.completed, 3);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.errors, []);
  const fallback = getDoc<any>("region:batch-open", {}).data;
  assert.ok(fallback.layout);
  assert.deepEqual(fallback.polygon, [{ x: .2, y: .2 }, { x: .7, y: .2 }, { x: .7, y: .7 }, { x: .2, y: .7 }]);
  assert.ok(getDoc<any>("region:batch-detect", {}).data.layout);
  assert.equal(getDoc<any>("region:batch-detect", {}).data.geometryApproved, false);
  assert.deepEqual(getDoc<any>("region:batch-existing", {}).data.polygon, polygon);
  assert.equal(getDoc<any>("region:batch-locked", {}).revision, 1);
  const divided = [{ x: .2, y: .2 }, { x: .5, y: .2 }, { x: .5, y: .8 }, { x: .2, y: .8 }];
  const repaired = await typesetRegions(series, episode, [img], [rows.find(l => l.id === "batch-existing")!], new AbortController().signal, () => {}, async (payload) => {
    assert.equal(payload.method, "split");
    return { polygon: divided, split: true, confidence: .85 };
  });
  assert.equal(repaired.completed, 1);
  assert.deepEqual(getDoc<any>("region:batch-existing", {}).data.polygon, divided);
  assert.equal(getDoc<any>("region:batch-existing", {}).data.geometryApproved, false);
  const tiny = [{ x: .3, y: .3 }, { x: .31, y: .3 }, { x: .31, y: .31 }];
  const smallSplit = await typesetRegions(series, episode, [img], [rows.find(l => l.id === "batch-existing")!], new AbortController().signal, () => {}, async () => ({ polygon: tiny, split: true, confidence: .85 }));
  assert.equal(smallSplit.completed, 1);
  assert.deepEqual(getDoc<any>("region:batch-existing", {}).data.polygon, fallback.polygon);
  assert.equal(getDoc<any>("region:batch-existing", {}).data.geometryConfidence, 0);
  const openDoc = getDoc<any>("region:batch-open", {});
  putDoc("e", openDoc.id, { ...openDoc.data, polygon: undefined }, openDoc.revision);
  const smallDetected = await typesetRegions(series, episode, [img], [rows.find(l => l.id === "batch-open")!], new AbortController().signal, () => {}, async () => ({ polygon: tiny, confidence: .85 }));
  assert.equal(smallDetected.completed, 1);
  assert.deepEqual(getDoc<any>("region:batch-open", {}).data.polygon, fallback.polygon);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(typesetRegions(series, episode, [img], rows, controller.signal, () => {}), /Cancelled/);
});

test("Codex read schema omits line-type enums that break structured outputs", async () => {
  const { READ_OUTPUT_SCHEMA } = await import("../src/lib/server/cliTranslate");
  assert.equal("enum" in READ_OUTPUT_SCHEMA.properties.lineType, false);
  assert.doesNotMatch(JSON.stringify(READ_OUTPUT_SCHEMA), /\\"/);
});

test("bulk reread eligibility uses missing text and a strict 95 percent cutoff", async () => {
  const { needsReread } = await import("../src/lib/server/aiTranslate");
  const line = { ...(await listLines("e"))[0], source: "source", body: "English", sourceState: "read" };
  assert.equal(needsReread({ ...line, ocrConfidence: 0.949 }), true);
  assert.equal(needsReread({ ...line, ocrConfidence: 0.95 }), false);
  assert.equal(needsReread({ ...line, ocrConfidence: null }), false);
  assert.equal(needsReread({ ...line, source: "  " }), true);
  assert.equal(needsReread({ ...line, source: undefined }), true);
  assert.equal(needsReread({ ...line, body: "" }), true);
  assert.equal(needsReread({ ...line, sourceState: "ignored", body: "", ocrConfidence: 0.2 }), false);
});

test("bulk accepts one current translation per line and rejects leftover suggestions on that line", async () => {
  const { acceptTranslationSuggestions } = await import("../src/lib/server/workflowService");
  const line = (await listLines("e"))[0];
  suggest("e", line.id, (line.revision ?? 0) - 1, "Stale bulk result", "", "translation");
  suggest("e", line.id, line.revision ?? 0, "Bulk draft result", "", "translation");
  suggest("e", line.id, line.revision ?? 0, "Proofread stays pending", "", "proofread");
  const result = acceptTranslationSuggestions("e", "u");
  assert.ok(result.accepted >= 1);
  const current = (await listLines("e")).find(l => l.id === line.id)!;
  assert.equal(current.body, "Bulk draft result");
  assert.equal(current.status, "needs_work");
  for (const body of ["Stale bulk result", "Proofread stays pending"]) {
    assert.equal((sqlite.prepare("SELECT state FROM suggestions WHERE body=?").get(body) as any).state, "rejected");
  }
  assert.equal(acceptTranslationSuggestions("e", "u").accepted, 0);
});

test("bulk reread logs progress and cancellation stops before saving output", async () => {
  const { startRereadBatch, cancelRereadBatch, isRegionQueueBusy } = await import("../src/lib/server/aiTranslate");
  const { listJobs } = await import("../src/lib/server/jobs");
  const line = (await listLines("e"))[0];
  sqlite.prepare("UPDATE lines SET ocr_confidence=0.5 WHERE id=?").run(line.id);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    if (init?.signal?.aborted) throw new Error("Cancelled");
    await new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
    });
    throw new Error("Cancelled");
  };
  try {
    const result = await startRereadBatch({
      series, episode, user: { id: "u", username: "test", role: "admin" },
      engine: "qwen", model: "fixture", lang: "japanese",
    });
    assert.ok(result.total > 0);
    assert.equal(isRegionQueueBusy("e"), true);
    assert.equal(listJobs("e").find(j => j.id === result.jobId)?.progress.total, result.total);
    cancelRereadBatch("e");
    for (let i = 0; i < 100 && isRegionQueueBusy("e"); i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(listJobs("e").find(j => j.id === result.jobId)?.state, "cancelled");
    assert.equal((await listLines("e")).find(l => l.id === line.id)?.body, line.body);
  } finally {
    cancelRereadBatch("e");
    globalThis.fetch = originalFetch;
  }
});

test("page bulk acceptance leaves another page's translation suggestions pending", async () => {
  const { acceptTranslationSuggestions } = await import("../src/lib/server/workflowService");
  const original = (await listLines("e"))[0];
  const image = await db.select().from(schema.images).get();
  await db.insert(schema.images).values({ ...image!, id: "bulk-other-page" });
  const row = await db.select().from(schema.lines).get();
  await db.insert(schema.lines).values({ ...row!, id: "bulk-other-line", imageId: "bulk-other-page" });
  const current = (await listLines("e")).find(l => l.id === original.id)!;
  const other = (await listLines("e")).find(l => l.id === "bulk-other-line")!;
  suggest("e", current.id, current.revision ?? 0, "Page-only draft", "", "translation");
  suggest("e", other.id, other.revision ?? 0, "Other page draft", "", "translation");
  assert.equal(acceptTranslationSuggestions("e", "u", current.imageId!).accepted, 1);
  assert.equal((await listLines("e")).find(l => l.id === other.id)?.body, other.body);
  assert.equal((sqlite.prepare("SELECT state FROM suggestions WHERE body=?").get("Other page draft") as any).state, "pending");
  assert.throws(() => acceptTranslationSuggestions("e", "u", "unknown-page"), /Page not found/);
});

test("page reread rejects an unknown page and does not include eligible segments elsewhere", async () => {
  const { startRereadBatch } = await import("../src/lib/server/aiTranslate");
  sqlite.prepare("UPDATE lines SET source='source',body='English',ocr_confidence=1 WHERE image_id='p'").run();
  sqlite.prepare("UPDATE lines SET source='',body='',ocr_confidence=0.4 WHERE image_id='bulk-other-page'").run();
  const opts = { series, episode, user: { id: "u", username: "test", role: "admin" as const } };
  await assert.rejects(startRereadBatch({ ...opts, imageId: "p" }), /No eligible segments/);
  await assert.rejects(startRereadBatch({ ...opts, imageId: "unknown-page" }), /Page not found/);
});

test("explicit bulk replacement accepts stale suggestions and retires older alternatives only on the selected page", async () => {
  const { acceptTranslationSuggestions } = await import("../src/lib/server/workflowService");
  const current = (await listLines("e")).find(l => l.imageId === "p")!;
  const other = (await listLines("e")).find(l => l.imageId === "bulk-other-page")!;
  suggest("e", current.id, 0, "Older replacement", "", "translation");
  suggest("e", current.id, 0, "Latest replacement", "", "translation");
  sqlite.prepare("UPDATE suggestions SET created_at=9999999999998 WHERE body='Older replacement'").run();
  sqlite.prepare("UPDATE suggestions SET created_at=9999999999999 WHERE body='Latest replacement'").run();
  sqlite.prepare("UPDATE lines SET body='Manually edited English',status='approved' WHERE id=?").run(current.id);
  const result = acceptTranslationSuggestions("e", "u", "p");
  assert.ok(result.accepted >= 1);
  const saved = (await listLines("e")).find(l => l.id === current.id)!;
  assert.equal(saved.body, "Latest replacement");
  assert.equal(saved.status, "needs_work");
  assert.equal((sqlite.prepare("SELECT state FROM suggestions WHERE body='Older replacement'").get() as any).state, "rejected");
  assert.equal((sqlite.prepare("SELECT state FROM suggestions WHERE body='Latest replacement'").get() as any).state, "accepted");
  assert.equal((await listLines("e")).find(l => l.id === other.id)?.body, other.body);
  assert.equal((sqlite.prepare("SELECT state FROM suggestions WHERE body='Other page draft'").get() as any).state, "pending");
  assert.equal(acceptTranslationSuggestions("e", "u", "p").accepted, 0);
  assert.equal((await listLines("e")).find(l => l.id === current.id)?.body, "Latest replacement");
});

test("text rotation dragging uses image aspect ratio and wraps angles", async () => {
  const { draggedRotation, normalizeRotation } = await import("../src/lib/textRotation");
  const center = { x: 0.5, y: 0.5 };
  const start = { x: 0.5, y: 0.25 };
  assert.equal(draggedRotation(0, start, { x: 0.75, y: 0.5 }, center, 600, 1200), 90);
  assert.equal(draggedRotation(0, start, { x: 0.75, y: 0.375 }, center, 600, 1200), 45);
  assert.equal(draggedRotation(170, start, { x: 0.75, y: 0.5 }, center, 600, 1200), -100);
  assert.equal(draggedRotation(37, start, center, center, 600, 1200), 37);
  assert.equal(normalizeRotation(-181), 179);
  assert.equal(normalizeRotation(361), 1);
});

test("polygon edge handles and skew dragging match Photoshop side-handle convention", async () => {
  const { draggedSkew, polygonEdgeHandle, clampSkew, deltaTextTransform } = await import("../src/lib/textTransform");
  const rect = [{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.6 }, { x: 0.1, y: 0.6 }];
  assert.deepEqual(polygonEdgeHandle(rect, "right"), { x: 0.5, y: 0.4 });
  assert.deepEqual(polygonEdgeHandle(rect, "bottom"), { x: 0.3, y: 0.6 });
  const center = { x: 0.3, y: 0.4 };
  const bottom = { x: 0.3, y: 0.6 };
  const right = { x: 0.5, y: 0.4 };
  // Bottom handle dragged right by half the distance from centre → 45° horizontal skew.
  assert.equal(draggedSkew("x", 0, bottom, { x: 0.5, y: 0.6 }, center, 200, 200), 45);
  // Right handle dragged down by the same amount → 45° vertical skew.
  assert.equal(draggedSkew("y", 0, right, { x: 0.5, y: 0.6 }, center, 200, 200), 45);
  assert.equal(clampSkew(90), 75);
  assert.equal(clampSkew(-90), -75);
  const from = { ...DEFAULT_STYLE, rotation: 30 };
  const to = { ...from, skewX: 20 };
  assert.match(deltaTextTransform(from, to, 120, 80), /matrix\(/);
  assert.equal(deltaTextTransform(from, { ...from, rotation: 10 }, 120, 80), "rotate(-20 120 80)");
});

test("moving and resetting placed text preserves glyph layout without refitting", async () => {
  const { transformPlacedText } = await import("../src/lib/server/placedText");
  const line = { ...(await listLines("e"))[0], x: 0.1, y: 0.2, w: 0.2, h: 0.2 };
  const page = { ...(await db.select().from(schema.images).get())!, width: 600, height: 400 } as any;
  const style = { ...DEFAULT_STYLE, rotation: 30 };
  const region: any = { style, polygon: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.2 }, { x: 0.3, y: 0.4 }],
    layout: { rows: [{ text: "Keep these words", x: 70, baseline: 100, width: 90 }],
      size: 14, dpi: 96, width: 600, height: 400, style,
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><g transform="rotate(30 120 120)"><path d="M0 0L1 1"/></g></svg>' } };
  region.layout.key = layoutKey(line, region, page, style, 96);
  const moved = transformPlacedText(line, region, page, 0.2, 0.3);
  assert.equal(moved.layout!.size, 14);
  assert.equal(moved.layout!.rows[0].text, "Keep these words");
  assert.equal(moved.layout!.rows[0].x, 130);
  assert.equal(moved.layout!.rows[0].baseline, 140);
  assert.equal(moved.layout!.style.rotation, 30);
  assert.match(moved.layout!.svg, /translate\(60 /);
  const movedLine = { ...line, x: 0.2, y: 0.3 };
  assert.equal(moved.layout!.key, layoutKey(movedLine, moved, page, style, 96));
  const reset = transformPlacedText(movedLine, moved, page, 0.2, 0.3, 0);
  assert.equal(reset.style!.rotation, 0);
  assert.equal(reset.layout!.style.rotation, 0);
  assert.deepEqual(reset.layout!.rows, moved.layout!.rows);
  assert.equal(reset.layout!.size, 14);
  assert.match(reset.layout!.svg, /rotate\(-30 /);
  assert.equal(reset.layout!.key, layoutKey(movedLine, reset, page, reset.layout!.style, 96));
  const skewed = transformPlacedText(movedLine, reset, page, 0.2, 0.3, undefined, 25);
  assert.equal(skewed.layout!.style.skewX, 25);
  assert.equal(skewed.layout!.style.rotation, 0);
  assert.deepEqual(skewed.layout!.rows, reset.layout!.rows);
  assert.match(skewed.layout!.svg, /matrix\(/);
});

test("crop and negative nudge move hitboxes, bubble geometry and placed glyphs, and undo restores them", async () => {
  const { cropPage, nudgePage, undoPageOp } = await import("../src/lib/server/pageEdit");
  const { listImages } = await import("../src/lib/server/queries");
  const ctx = { series, episode, user: { id: "u", username: "test", role: "admin" as const } };
  const page = (await listImages("e")).find(p => p.id === "p")!;
  const line = (await listLines("e")).find(l => l.imageId === page.id)!;
  sqlite.prepare("UPDATE lines SET x=0.25,y=0.25,w=0.25,h=0.25,placed=1 WHERE id=?").run(line.id);
  const beforeLine = (await listLines("e")).find(l => l.id === line.id)!;
  const doc = getDoc<any>(`region:${line.id}`, {});
  const region: any = { polygon: [{ x: 0.25, y: 0.25 }, { x: 0.5, y: 0.25 }, { x: 0.5, y: 0.5 }],
    layout: { style: DEFAULT_STYLE, dpi: 96, size: 14, rows: [{ text: "Stay aligned", x: page.width / 4, baseline: page.height / 4, width: 50 }],
      width: page.width, height: page.height, svg: `<svg width="${page.width}" height="${page.height}" viewBox="0 0 ${page.width} ${page.height}"><path d="M0 0L1 1"/></svg>` } };
  region.layout.key = layoutKey(beforeLine, region, page, DEFAULT_STYLE, 96);
  putDoc("e", doc.id, region, doc.revision);
  const pageDoc = getDoc<any>(`page:${page.id}`, {});
  const layer = await storeAsset(await sharp({ create: { width: page.width, height: page.height, channels: 3, background: "white" } }).png().toBuffer());
  putDoc("e", pageDoc.id, { prepared: layer, preparedAt: page.updatedAt, mask: layer, cleaned: layer,
    strokes: [{ points: [{ x: 0.25, y: 0.25 }], radius: 5, erase: false }] }, pageDoc.revision);
  const cropped = await cropPage(ctx, page.id, { x: 10, y: 20, w: page.width - 20, h: page.height - 40 });
  const transformedPage = getDoc<any>(pageDoc.id, {}).data;
  const { readAsset } = await import("../src/lib/server/workflowStore");
  assert.equal((await sharp(await readAsset(transformedPage.mask)).metadata()).width, cropped.width);
  assert.equal(transformedPage.preparedAt, cropped.updatedAt);
  assert.ok(Math.abs(transformedPage.strokes[0].points[0].x - (page.width / 4 - 10) / cropped.width) < 1e-10);
  let moved = (await listLines("e")).find(l => l.id === line.id)!;
  assert.ok(Math.abs(moved.x! - (page.width / 4 - 10) / cropped.width) < 1e-10);
  let geom = getDoc<any>(doc.id, {}).data;
  assert.equal(geom.layout.rows[0].x, page.width / 4 - 10);
  assert.equal(geom.layout.size, 14);
  assert.match(geom.layout.svg, /translate\(-10 -20\)/);
  assert.ok(Math.abs(geom.polygon[0].x - moved.x!) < 1e-10);
  assert.equal(
    geom.layout.key,
    layoutKey(moved, geom, cropped, geom.layout.style, geom.layout.dpi),
  );
  const afterCrop = structuredClone(geom);
  await nudgePage(ctx, page.id, -5, 7, "white");
  geom = getDoc<any>(doc.id, {}).data;
  assert.equal(geom.layout.rows[0].x, page.width / 4 - 15);
  assert.equal(geom.layout.rows[0].baseline, page.height / 4 - 13);
  await undoPageOp(ctx);
  assert.deepEqual(getDoc<any>(doc.id, {}).data, afterCrop);
  await undoPageOp(ctx);
  moved = (await listLines("e")).find(l => l.id === line.id)!;
  assert.equal(moved.x, 0.25);
  assert.equal(moved.y, 0.25);
  assert.deepEqual(getDoc<any>(doc.id, {}).data, region);
});

test("auto-align padding uses white for mixed edges and preserves each solid edge color across page layers", async () => {
  const { autoAlignPages, contentBBox, undoPageOp } = await import("../src/lib/server/pageEdit");
  const { readAsset } = await import("../src/lib/server/workflowStore");
  const epId = "padding-e", slug = "padding";
  sqlite.prepare("INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES(?,?,?,?,1,1)")
    .run(epId, series.id, slug, "Padding");
  const ctx = { series, episode: (await getEpisode(epId))!, user: { id: "u", username: "test", role: "admin" as const } };
  const white = [255, 255, 255];
  const fixtures = [
    { id: "wide", width: 100, height: 100 },
    { id: "mixed", width: 44, height: 68 },
    { id: "colored", width: 60, height: 68, left: [18, 52, 86], right: [250, 244, 220], margin: 6 },
    { id: "black", width: 44, height: 68, left: [0, 0, 0], right: [0, 0, 0] },
    { id: "gray", width: 44, height: 68, left: [168, 168, 168], right: [168, 168, 168] },
  ];
  const originals = new Map<string, Buffer>();
  const crops = new Map<string, { x: number; y: number; w: number; h: number }>();
  try {
    for (const [index, fixture] of fixtures.entries()) {
      const pixels = Buffer.alloc(fixture.width * fixture.height * 3);
      const margin = fixture.margin ?? 0;
      for (let y = 0; y < fixture.height; y++) for (let x = 0; x < fixture.width; x++) {
        const shade = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 32 : 224;
        const color = x < margin || x >= fixture.width - margin ? [80, 40, 40]
          : x === margin && fixture.left ? fixture.left
          : x === fixture.width - margin - 1 && fixture.right ? fixture.right
          : [shade, shade, shade];
        pixels.set(color, (y * fixture.width + x) * 3);
      }
      const raw = await sharp(pixels, { raw: { width: fixture.width, height: fixture.height, channels: 3 } }).png().toBuffer();
      originals.set(fixture.id, raw);
      crops.set(fixture.id, await contentBBox(raw));
      const saved = await saveImageFile({ seriesSlug: series.slug, episodeSlug: slug, sortOrder: index,
        originalName: `${fixture.id}.png`, bytes: raw, mime: "image/png" });
      await db.insert(schema.images).values({ ...saved, id: `padding-${fixture.id}`, episodeId: epId,
        originalName: `${fixture.id}.png`, sortOrder: index, createdAt: 1, updatedAt: 1 });
      const asset = await storeAsset(raw);
      const mask = await storeAsset(await sharp({ create: { width: fixture.width, height: fixture.height,
        channels: 3, background: "white" } }).png().toBuffer());
      putDoc(epId, `page:padding-${fixture.id}`, { prepared: asset, original: asset, cleanBase: asset, cleaned: asset, mask }, 0);
    }
    assert.equal(crops.get("colored")!.x, 6, "sample the retained edge, after trimming the old margin");
    const aligned = await autoAlignPages(ctx);
    for (const fixture of fixtures) {
      const img = aligned.find(img => img.id === `padding-${fixture.id}`)!;
      assert.equal(img.width, 100);
      assert.equal(img.height, 100);
      const bytes = (await readWorkingOrOrig(series.slug, slug, img.filename))!;
      const actual = await sharp(bytes).removeAlpha().raw().toBuffer();
      const box = crops.get(fixture.id)!;
      const left = Math.round((100 - box.w) / 2), top = Math.round((100 - box.h) / 2);
      const original = await sharp(originals.get(fixture.id)!).extract({ left: box.x, top: box.y, width: box.w, height: box.h })
        .removeAlpha().raw().toBuffer();
      for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
        const i = (y * 100 + x) * 3;
        const originalIndex = ((y - top) * box.w + x - left) * 3;
        const expected = x < left ? fixture.left ?? white
          : x >= left + box.w ? fixture.right ?? white
          : y < top || y >= top + box.h ? white
          : [...original.subarray(originalIndex, originalIndex + 3)];
        assert.deepEqual([...actual.subarray(i, i + 3)], expected, `${fixture.id} at ${x},${y}`);
      }
      const page = getDoc<any>(`page:${img.id}`, {}).data;
      for (const key of ["prepared", "original", "cleanBase", "cleaned"]) {
        assert.deepEqual(await sharp(await readAsset(page[key])).removeAlpha().raw().toBuffer(), actual, `${fixture.id} ${key}`);
      }
      const mask = await sharp(await readAsset(page.mask)).removeAlpha().raw().toBuffer();
      assert.deepEqual([...mask.subarray(0, 3)], fixture.id === "wide" ? white : [0, 0, 0], "mask padding stays black");
    }
    await undoPageOp(ctx);
    for (const img of await listImages(epId)) {
      const originalId = img.id.replace("padding-", "");
      assert.deepEqual(await readWorkingOrOrig(series.slug, slug, img.filename), originals.get(originalId));
    }
  } finally {
    sqlite.prepare("DELETE FROM episodes WHERE id=?").run(epId);
  }
});

test("English dash normalization covers inserts, edits and suggestions without changing source text", async () => {
  const { normalizeTranslation, TRANSLATION_DASHES } = await import("../src/lib/translationText");
  assert.equal(normalizeTranslation(TRANSLATION_DASHES.join("")), "-".repeat(TRANSLATION_DASHES.length));
  assert.equal(normalizeTranslation("Wait... re-read!"), "Wait... re-read!");
  const original = await db.select().from(schema.lines).get();
  await db.insert(schema.lines).values({ ...original!, id: "dash-test", body: "Wait—what? 1–2", source: "ソースー—" });
  let line = (await listLines("e")).find(l => l.id === "dash-test")!;
  assert.equal(line.body, "Wait-what? 1-2");
  assert.equal(line.source, "ソースー—");
  sqlite.prepare("UPDATE lines SET body=? WHERE id=?").run("Non‑breaking − minus", line.id);
  line = (await listLines("e")).find(l => l.id === line.id)!;
  assert.equal(line.body, "Non-breaking - minus");
  suggest("e", line.id, line.revision ?? 0, "Better—English", "", "translation");
  const suggestion = sqlite.prepare("SELECT id,body FROM suggestions WHERE line_id=?").get(line.id) as any;
  assert.equal(suggestion.body, "Better-English");
  acceptSuggestion("e", suggestion.id, "u", "accept");
  assert.equal((await listLines("e")).find(l => l.id === line.id)?.body, "Better-English");
});

test("automatic text contrast samples inside the bubble and ignores sparse foreground lettering", async () => {
  const { contrastingText } = await import("../src/lib/server/textContrast");
  const polygon = [{ x: .25, y: .25 }, { x: .75, y: .25 }, { x: .75, y: .75 }, { x: .25, y: .75 }];
  for (const [background, bubble, expected] of [["black", "white", "#000000"], ["white", "black", "#ffffff"]]) {
    const bytes = await sharp(Buffer.from(`<svg width="200" height="200"><rect width="200" height="200" fill="${background}"/><rect x="50" y="50" width="100" height="100" fill="${bubble}"/><rect x="95" y="80" width="10" height="40" fill="${background}"/></svg>`)).png().toBuffer();
    assert.equal(await contrastingText(bytes, polygon), expected);
  }
});

test("automatic recognition uses OCR only for bubbles and retries uncertain OCR with vision", async () => {
  const { recognizeRegion } = await import("../src/lib/server/autoTranslation");
  let ocrCalls = 0, visionCalls = 0;
  let score = 0.99;
  const readers = {
    ocr: async () => { ocrCalls++; return { source: "こんにちは", score }; },
    vision: async () => { visionCalls++; return { source: "ドーン", lineType: "::" as const }; },
  };
  for (const kind of ["free", "unknown"] as const) {
    const read = await recognizeRegion(kind, readers);
    assert.equal(read.lineType, "::");
    assert.equal(read.ocrConfidence, undefined);
  }
  assert.equal(ocrCalls, 0, "non-bubble text must never reach OCR");
  assert.equal(visionCalls, 2);
  assert.equal((await recognizeRegion("bubble", readers)).ocrConfidence, 0.99);
  assert.equal(visionCalls, 2);
  score = 0.8;
  assert.equal((await recognizeRegion("bubble", readers)).source, "ドーン");
  assert.equal(visionCalls, 3);
  await recognizeRegion("bubble", { ...readers, ocr: async () => { throw new Error("OCR unavailable"); } });
  assert.equal(visionCalls, 4);
  const unreadable = await recognizeRegion("free", { ...readers, vision: async () => ({ source: "", lineType: "::" }) });
  assert.equal(unreadable.source, "");
  const controller = new AbortController();
  await assert.rejects(recognizeRegion("bubble", { ...readers, abort: controller.signal,
    ocr: async () => { controller.abort(); throw new Error("cancelled"); },
  }));
  assert.equal(visionCalls, 4, "cancellation must not start a vision fallback");
});

test("CLI proofreading keeps chapter IDs across pages and chunks and counts only selected lines", async () => {
  const { proofreadChapter } = await import('../src/lib/server/proofread');
  const fixture = join(process.env.SCAN_ROOT!, 'proofread-cli.cjs');
  await writeFile(fixture, `#!/usr/bin/env node
const fs = require('node:fs');
const prompt = fs.readFileSync(0, 'utf8').split('Rewrite these:\\n')[1];
const items = [...prompt.matchAll(/^\\[(\\d+)\\][^\\n]*\\n(?:source:[^\\n]*\\n)?(?:literal:[^\\n]*\\n)?current: ([^\\n]*)/gm)]
  .map(([, id, current]) => ({ i: Number(id), literal: '', translation: current.replace('recieve', 'receive').replace('What for reason', 'Why'), reasoning: 'Correct spelling and awkward phrasing' })).reverse();
fs.writeFileSync(process.argv[process.argv.indexOf('-o') + 1], JSON.stringify({items}));
`, { mode: 0o700 });
  const oldBin = process.env.CODEX_BIN;
  process.env.CODEX_BIN = fixture;
  sqlite.prepare("INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES('proof-e','s','proof','Proofreading',1,1)").run();
  for (let page = 0; page < 2; page++) {
    await db.insert(schema.images).values({ id: `proof-p${page}`, episodeId: 'proof-e', originalName: 'proof.png',
      ...saved, sortOrder: page, createdAt: 1, updatedAt: 1 });
    for (let i = 0; i < (page ? 35 : 2); i++)
      await db.insert(schema.lines).values({ id: `proof-l${page}-${i}`, episodeId: 'proof-e', imageId: `proof-p${page}`,
        source: '', body: `What for reason did I recieve letter ${page}-${i}?`, lineType: 'plain', sortOrder: i, updatedAt: 1 });
  }
  try {
    const result = await proofreadChapter({ seriesId: 's', episodeId: 'proof-e', engine: 'codex', imageIds: ['proof-p1'] });
    assert.deepEqual(result, { changed: 35, total: 35 });
    const suggestions = sqlite.prepare("SELECT line_id,body FROM suggestions WHERE episode_id='proof-e'").all() as { line_id: string; body: string }[];
    assert.equal(suggestions.length, 35);
    for (let i = 0; i < 35; i++)
      assert.equal(suggestions.find(s => s.line_id === `proof-l1-${i}`)?.body, `Why did I receive letter 1-${i}?`);
    assert.ok((await listLines('proof-e')).every(line => line.body.includes('recieve')), 'corrections remain suggestions');
    await writeFile(fixture, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.argv[process.argv.indexOf('-o') + 1], JSON.stringify({items: []}));\n`, { mode: 0o700 });
    await assert.rejects(proofreadChapter({ seriesId: 's', episodeId: 'proof-e', engine: 'codex', imageIds: ['proof-p0'] }), /Proofreading returned no text/);
  } finally {
    if (oldBin === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = oldBin;
    sqlite.prepare("DELETE FROM episodes WHERE id='proof-e'").run();
  }
});

test("HTTP proofreading validates complete output instead of silently treating missing lines as checked", async () => {
  const { proofreadScript } = await import('../src/lib/server/llm');
  const items = [32, 40].map(i => ({ i, page: 'page 2', lineType: 'plain' as const, source: '', literal: '', current: 'I recieve it.', notes: '' }));
  const opts = { seriesNotes: '', seriesGlossary: '', prior: '', pages: '', settled: '', model: 'proofread-fixture' };
  const originalFetch = globalThis.fetch;
  let output: unknown = { items: [40, 32].map(i => ({ i, translation: 'I receive it.', reasoning: 'Spelling' })) };
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.model, 'proofread-fixture');
    assert.match(payload.messages[1].content, /misspelled words/);
    assert.match(payload.messages[1].content, /unnatural word order/);
    return Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] });
  };
  try {
    const corrections = await proofreadScript(items, opts);
    assert.equal(corrections.get(32)?.translation, 'I receive it.');
    assert.equal(corrections.get(40)?.translation, 'I receive it.');
    for (const rows of [[], [{ i: 32, translation: 'I receive it.' }], [{ i: 32, translation: '' }, { i: 40, translation: 'I receive it.' }]]) {
      output = { items: rows };
      await assert.rejects(proofreadScript(items, opts), /Proofreading returned no text/);
    }
    for (const ids of [[0, 1], [32, 32]]) {
      output = { items: ids.map(i => ({ i, translation: 'I receive it.' })) };
      await assert.rejects(proofreadScript(items, opts), /invalid or duplicate line IDs/);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("automatic proofreading publishes one polished draft and preserves missing corrections", async () => {
  const { polishTranslation } = await import("../src/lib/server/autoTranslation");
  const boxes = Array.from({ length: 35 }, (_, i) => ({
    x: 0, y: 0, w: 0.1, h: 0.1, source: "こんにちは", lineType: '""' as const,
    translation: `Draft ${i}`, literal: "Hello", reasoning: "Translation note",
  }));
  const batches: number[][] = [];
  const polished = await polishTranslation(boxes, async items => {
    batches.push(items.map(item => item.i));
    return new Map([[items[0].i, { translation: "Hello!", reasoning: "Natural dialogue" }],
      [items[1].i, { translation: " ", reasoning: "" }],
      [999, { translation: "unrelated", reasoning: "" }]]);
  });
  assert.equal(batches.length, 2);
  assert.equal(polished[0].translation, "Hello!");
  assert.equal(polished[32].translation, "Hello!");
  assert.equal(polished[1].translation, "Draft 1");
  assert.equal(boxes[0].translation, "Draft 0", "do not mutate original output");
  assert.match(polished[0].reasoning, /Proofread: Natural dialogue/);
  await assert.rejects(polishTranslation(boxes, async () => { throw new Error("model unavailable"); }), /model unavailable/);
  const abort = new AbortController();
  await assert.rejects(polishTranslation(boxes, async () => { abort.abort(); return new Map(); }, abort.signal));
});

test("detection confidence is clamped", async () => {
  const { parseDetectConf } = await import("../src/lib/server/detect");
  assert.equal(parseDetectConf(undefined), undefined);
  assert.equal(parseDetectConf("nope"), undefined);
  assert.equal(parseDetectConf(0.4), 0.4);
  assert.equal(parseDetectConf(0.01), 0.05);
  assert.equal(parseDetectConf(2), 0.9);
});

test("transcribe compares both OCR models for every region, leaves disagreements for manual review, and translation skips them", async () => {
  const { startAiTranscribe, startAiTranslate, jobSnapshot } = await import("../src/lib/server/aiTranslate");
  const { listJobs } = await import("../src/lib/server/jobs");
  const { sceneNotesForPage } = await import("../src/lib/server/proofread");
  const { DESCRIBE_SYSTEM } = await import("../src/lib/server/llm");
  assert.match(DESCRIBE_SYSTEM, /Never quote/);
  const nearby = sceneNotesForPage(
    [
      { id: "a", caption: "Park walk." },
      { id: "b", caption: "They reach the gate." },
      { id: "c", caption: "Rooftop chase." },
    ] as never,
    "b",
    "Castle courtyard at dusk.",
  );
  assert.match(nearby, /Castle courtyard at dusk/);
  assert.match(nearby, /Park walk/);
  assert.match(nearby, /They reach the gate/);
  assert.doesNotMatch(nearby, /Rooftop chase/);

  const fixtureWorker = join(process.env.SCAN_ROOT!, "auto-worker.py");
  const workerLog = join(process.env.SCAN_ROOT!, "auto-worker-calls.txt");
  await writeFile(fixtureWorker, `import sys,json
print('{"ready":true}',flush=True)
for line in sys.stdin:
    msg=json.loads(line)
    with open(${JSON.stringify(workerLog)},'a') as log: log.write(msg['cmd']+(' '+str(msg.get('conf')) if msg['cmd']=='detect' else '')+'\\n')
    out={'id':msg['id'],'ok':True}
    if msg['cmd']=='detect': out.update(width=600,height=400,regions=[{'cls':'text_bubble','score':.99,'box':[30,30,100,100]},{'cls':'text_free','score':.99,'box':[400,250,550,350]},{'cls':'text_bubble','score':.99,'box':[120,200,200,280]}])
    if msg['cmd']=='ocr': out.update(text='こんにちは',score=.99)
    print(json.dumps(out),flush=True)
`);
  const oldPython = process.env.PADDLEOCR_PYTHON, oldWorker = process.env.PADDLEOCR_WORKER;
  process.env.PADDLEOCR_PYTHON = "/usr/bin/python3";
  process.env.PADDLEOCR_WORKER = fixtureWorker;
  sqlite.prepare("INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES('auto-e','s','auto-chapter','Auto chapter',1,1)").run();
  const image = await saveImageFile({ seriesSlug: "series", episodeSlug: "auto-chapter", sortOrder: 1,
    originalName: "auto.png", bytes: source, mime: "image/png" });
  const prevFile = await saveImageFile({ seriesSlug: "series", episodeSlug: "auto-chapter", sortOrder: 0,
    originalName: "prev.png", bytes: source, mime: "image/png" });
  const laterFile = await saveImageFile({ seriesSlug: "series", episodeSlug: "auto-chapter", sortOrder: 2,
    originalName: "later.png", bytes: source, mime: "image/png" });
  await db.insert(schema.images).values({ id: "auto-prev", episodeId: "auto-e", originalName: "prev.png", ...prevFile,
    sortOrder: 0, caption: "Previous park scene.", createdAt: 1, updatedAt: 1 });
  await db.insert(schema.images).values({ id: "auto-p", episodeId: "auto-e", originalName: "auto.png", ...image,
    sortOrder: 1, caption: "Alice meets Bob beside the gate.", createdAt: 1, updatedAt: 1 });
  await db.insert(schema.images).values({ id: "auto-later", episodeId: "auto-e", originalName: "later.png", ...laterFile,
    sortOrder: 2, caption: "Later rooftop chase.", createdAt: 1, updatedAt: 1 });
  putDoc("auto-e", "chapter:auto-e", { chapterSummary: "Castle courtyard at dusk.", regionAi: {
    describe: { engine: "qwen", model: "description-fixture" },
    vision: { engine: "qwen", model: "vision-fixture" },
    translate: { engine: "qwen", model: "translation-fixture" },
    proofread: { engine: "qwen", model: "proofread-fixture" },
  } }, 0);
  const { fixturePasses, localOcrFixture } = await import("./local-ocr-fixture");
  const restoreOcr = await localOcrFixture();
  await fixturePasses("rtdetr", ["detect"]);
  let hayaiCalls = 0, paddleCalls = 0;
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    if (String(_url).includes('ocr.fixture/hayai-ocr-v2')) {
      calls.push('hayai');
      return Response.json({ source: ++hayaiCalls === 3 ? 'こんばんは' : 'こんにちは' });
    }
    if (String(_url).includes('ocr.fixture/paddleocr-vl-1.6')) {
      calls.push('paddle');
      return Response.json({ choices: [{ message: { content: ++paddleCalls === 3 ? 'こんばんわ' : 'こんにちは' } }] });
    }
    if (String(_url).includes('ocr.fixture/qwen3-vl-8b')) {
      throw new Error('Qwen3-VL-8B must not translate Hayai/Paddle readings');
    }
    const system = payload.messages[0].content;
    let response;
    if (system.startsWith("Translate the supplied")) {
      assert.equal(payload.model, "translation-fixture");
      calls.push("ocr-translate");
      const transcription = JSON.parse(payload.messages[1].content).transcription;
      return Response.json({ choices: [{ message: { content: JSON.stringify({ translation: `EN ${transcription}` }) } }] });
    }
    if (system.startsWith("You translate")) {
      assert.equal(payload.model, "translation-fixture");
      calls.push("translate");
      const user = payload.messages[1].content;
      assert.match(user, /Alice meets Bob/);
      assert.match(user, /Previous park scene/);
      assert.match(user, /Castle courtyard at dusk/);
      assert.doesNotMatch(user, /Later rooftop chase/);
      response = JSON.stringify({ items: [0, 1].map(i => ({ i, translation: `Draft ${i}`, literal: "Hello", reasoning: "" })) });
    } else if (system.startsWith("You are a scanlation editor")) {
      calls.push("proofread");
      throw new Error("proofread must not run automatically");
    } else if (system.startsWith("You write a short scanlation")) {
      calls.push("context");
      throw new Error("describe must not run from transcribe or translate");
    } else {
      throw new Error(`unexpected model call: ${system.slice(0, 80)}`);
    }
    return Response.json({ choices: [{ message: { content: response } }] });
  };
  try {
    startAiTranscribe({ series, episode: (await getEpisode("auto-e"))!, user: { id: "u", username: "test", role: "admin" },
      detectorSetup: { base: "rtdetr", coo: false, koharu: false }, detectConf: 0.4, lang: "japanese", imageIds: ["auto-p"] });
    const deadline = Date.now() + 10000;
    while (jobSnapshot("auto-e")?.running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(jobSnapshot("auto-e")?.running, false);
    assert.equal(jobSnapshot("auto-e")?.error, undefined);
    assert.deepEqual(calls, ["hayai", "paddle", "ocr-translate", "hayai", "paddle", "ocr-translate", "hayai", "paddle", "ocr-translate", "ocr-translate"]);
    const commands = (await readFile(workerLog, "utf8")).trim().split("\n");
    assert.ok(commands.includes("detect 0.4"), "detector confidence is forwarded");
    assert.equal(commands.filter(cmd => cmd === "ocr").length, 0, "legacy Paddle recognizer is not used");
    const drafts = await listLines("auto-e");
    assert.equal(drafts.length, 3);
    assert.deepEqual(drafts.map(l => l.source).sort(), ["", "こんにちは", "こんにちは"]);
    assert.deepEqual(drafts.map(l => l.body).sort(), ["", "EN こんにちは", "EN こんにちは"]);

    const uncertain = drafts.find(line => !line.source)!;
    assert.equal(uncertain.sourceState, 'unreadable');
    const suggestions = sqlite.prepare("SELECT * FROM suggestions WHERE line_id=? AND state='pending'").all(uncertain.id) as any[];
    assert.deepEqual(suggestions.map(s => [s.body, s.translation]).sort(), [['こんばんは', 'EN こんばんは'], ['こんばんわ', 'EN こんばんわ']].sort());
    assert.ok(suggestions.every(s => s.kind === 'source-review' && /translation-fixture/.test(s.reason)));
    assert.ok(listJobs('auto-e').every(j => j.kind === 'transcribe'), 'no automatic council or chapter translation');

    startAiTranslate({ series, episode: (await getEpisode("auto-e"))!, user: { id: "u", username: "test", role: "admin" },
      replace: false, lang: "japanese", imageIds: ["auto-p"] });
    const translateDeadline = Date.now() + 10000;
    while (jobSnapshot("auto-e")?.running && Date.now() < translateDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(jobSnapshot("auto-e")?.running, false);
    assert.equal(jobSnapshot("auto-e")?.error, undefined);
    assert.deepEqual(calls, ["hayai", "paddle", "ocr-translate", "hayai", "paddle", "ocr-translate", "hayai", "paddle", "ocr-translate", "ocr-translate", "translate"]);
    const translated = await listLines("auto-e");
    assert.deepEqual(translated.map(l => l.body).sort(), ["", "EN こんにちは", "EN こんにちは"]);
    assert.ok(translated.every(l => l.status !== "approved"));
    assert.equal((sqlite.prepare("SELECT count(*) AS n FROM suggestions WHERE episode_id='auto-e' AND kind='proofread'").get() as { n: number }).n, 0);
    assert.ok(listJobs("auto-e").some(j => j.kind === "translate" && j.state === "completed"));

    sqlite.prepare("UPDATE lines SET body='Human wording',updated_by='u',status='approved' WHERE id=?").run(translated[0].id);
    sqlite.prepare("UPDATE lines SET source_state='ignored',ignore_reason='Decorative mark' WHERE id=?").run(translated[1].id);
    await db.insert(schema.lines).values([
      { id: "auto-prev-l", episodeId: "auto-e", imageId: "auto-prev", source: "x", sourceState: "read", body: "", lineType: '""', sortOrder: 0, updatedAt: 1 },
      { id: "auto-later-l", episodeId: "auto-e", imageId: "auto-later", source: "x", sourceState: "read", body: "", lineType: '""', sortOrder: 0, updatedAt: 1 },
    ]);
    startAiTranscribe({ series, episode: (await getEpisode("auto-e"))!, user: { id: "u", username: "test", role: "admin" },
      detectorSetup: { base: "rtdetr", coo: false, koharu: false }, lang: "japanese" });
    const skipDeadline = Date.now() + 10000;
    while (jobSnapshot("auto-e")?.running && Date.now() < skipDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(jobSnapshot("auto-e")?.running, false);
    assert.equal(jobSnapshot("auto-e")?.error, undefined);
    const ocrAfterSkip = (await readFile(workerLog, "utf8")).trim().split("\n").filter(cmd => cmd === "ocr").length;
    assert.equal(ocrAfterSkip, 0);
    assert.equal(hayaiCalls, 3, "chapter transcribe skips pages that already have regions");

    startAiTranslate({ series, episode: (await getEpisode("auto-e"))!, user: { id: "u", username: "test", role: "admin" },
      replace: false, lang: "japanese", imageIds: ["auto-p"] });
    const retryDeadline = Date.now() + 10000;
    while (jobSnapshot("auto-e")?.running && Date.now() < retryDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(jobSnapshot("auto-e")?.running, false);
    assert.equal(jobSnapshot("auto-e")?.error, undefined);
    const repeated = (await listLines("auto-e")).filter(l => l.imageId === "auto-p");
    assert.equal(repeated.length, 3);
    assert.equal(repeated.find(l => l.id === translated[0].id)?.body, "Human wording");
    assert.equal(repeated.find(l => l.id === translated[0].id)?.status, "approved");
    assert.equal(repeated.find(l => l.id === translated[1].id)?.sourceState, "ignored");
    const savedLine = repeated.find(l => l.id === translated[0].id)!;
    const translationSuggestions = sqlite.prepare("SELECT body, base_revision FROM suggestions WHERE episode_id='auto-e' AND kind='translation' AND line_id=?").all(savedLine.id) as { body: string; base_revision: number }[];
    assert.equal(translationSuggestions.filter(s => s.base_revision === savedLine.revision).length, 1, JSON.stringify(translationSuggestions));
    assert.equal(translationSuggestions.filter(s => s.base_revision === savedLine.revision)[0].body, "Draft 0");
  } finally {
    restoreOcr();
    globalThis.fetch = originalFetch;
    if (oldPython === undefined) delete process.env.PADDLEOCR_PYTHON; else process.env.PADDLEOCR_PYTHON = oldPython;
    if (oldWorker === undefined) delete process.env.PADDLEOCR_WORKER; else process.env.PADDLEOCR_WORKER = oldWorker;
    (globalThis as any).__scanOcr?.proc.kill();
  }
});

test("chapter translation honors Grok requests over saved Qwen settings", async () => {
  const { startAiTranslate, jobSnapshot } = await import("../src/lib/server/aiTranslate");
  const { listJobs } = await import("../src/lib/server/jobs");
  const { regionAiSettings, resolveTaskModel } = await import("../src/lib/regionAi");
  const work = await mkdtemp(join(tmpdir(), "scan-model-choice-"));
  const worker = join(work, "worker.py");
  const bin = join(work, "grok");
  const log = join(work, "models.jsonl");
  const fail = join(work, "fail");
  await writeFile(worker, `import sys,json
print('{"ready":true}',flush=True)
for line in sys.stdin:
    msg=json.loads(line)
    print(json.dumps(dict(id=msg['id'],ok=True,width=600,height=400,regions=[dict(cls='text_free',score=.99,box=[60,60,240,160])])),flush=True)
`);
  await writeFile(bin, `#!/usr/bin/env python3
import json,pathlib,sys
args=sys.argv[1:]
with open(${JSON.stringify(log)},'a') as f: f.write(json.dumps(args[args.index('-m')+1])+'\\n')
if pathlib.Path(${JSON.stringify(fail)}).exists():
    print('Fixture Grok failure',file=sys.stderr)
    sys.exit(1)
print(json.dumps(dict(source='待って',lineType='plain',items=[dict(i=0,translation='Wait here.',literal='wait',reasoning='Fixture Grok result')])))
`, { mode: 0o700 });
  const previous = { bin: process.env.GROK_BIN, python: process.env.PADDLEOCR_PYTHON, worker: process.env.PADDLEOCR_WORKER };
  const originalFetch = globalThis.fetch;
  let qwenCalls = 0;
  process.env.GROK_BIN = bin;
  process.env.PADDLEOCR_PYTHON = "/usr/bin/python3";
  process.env.PADDLEOCR_WORKER = worker;
  globalThis.fetch = async () => { qwenCalls++; throw new Error("Qwen must not be called"); };
  const eid = "model-choice-e";
  sqlite.prepare("INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES(?,?,?,?,1,1)")
    .run(eid, "s", "model-choice", "Model choice");
  const ep = (await getEpisode(eid))!;
  const file = await saveImageFile({ seriesSlug: series.slug, episodeSlug: ep.slug, sortOrder: 0,
    originalName: "page.png", bytes: source, mime: "image/png" });
  await db.insert(schema.images).values({ id: "model-choice-p", episodeId: eid, ...file,
    originalName: "page.png", sortOrder: 0, createdAt: 1, updatedAt: 1 });
  const qwen = regionAiSettings(undefined, { engine: "qwen", model: "saved-qwen-model" });
  putDoc(eid, `chapter:${eid}`, { regionAi: qwen }, 0);
  assert.deepEqual(resolveTaskModel(qwen, "translate", { engine: "grok" }), { engine: "grok", model: "" });
  assert.deepEqual(resolveTaskModel(qwen, "vision"), qwen.vision);
  const common = { series, episode: ep, user: { id: "u", username: "test", role: "admin" as const }, imageIds: ["model-choice-p"] };
  async function finished() {
    const deadline = Date.now() + 10000;
    while (jobSnapshot(eid)?.running && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(jobSnapshot(eid)?.running, false);
    return jobSnapshot(eid)!;
  }
  try {
    await db.insert(schema.lines).values({ id: "model-choice-l", episodeId: eid, imageId: "model-choice-p",
      source: "待って", sourceState: "read", body: "", updatedBy: 'ai-ocr', lineType: "plain", x: .1, y: .15, w: .3, h: .25, placed: true, sortOrder: 0, updatedAt: 1 });
    assert.deepEqual((await listLines(eid)).map(line => line.source), ["待って"]);
    startAiTranslate({ ...common, replace: false, engine: "grok", model: "grok-translator-fixture" });
    assert.equal((await finished()).error, undefined);
    assert.deepEqual((await listLines(eid)).map(line => line.body), ["Wait here."]);
    for (const job of listJobs(eid)) {
      assert.equal(job.payload.engine, "grok");
      assert.equal(job.progress.engine, "grok");
      assert.equal(job.payload.model, "grok-translator-fixture");
    }
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line)), ["grok-translator-fixture"]);

    // Saved defaults are captured at start, so subsequent settings edits cannot switch an active job.
    let chapter = getDoc<any>(`chapter:${eid}`, {});
    putDoc(eid, chapter.id, { regionAi: regionAiSettings(undefined, { engine: "grok", model: "saved-grok-fixture" }) }, chapter.revision);
    const started = startAiTranslate({ ...common, replace: false });
    assert.equal(started.engine, "grok");
    assert.equal(started.model, "saved-grok-fixture");
    chapter = getDoc<any>(`chapter:${eid}`, {});
    putDoc(eid, chapter.id, { regionAi: qwen }, chapter.revision);
    assert.equal((await finished()).error, undefined);
    assert.equal(JSON.parse((await readFile(log, "utf8")).trim().split("\n").at(-1)!), "saved-grok-fixture");

    await writeFile(fail, "fail");
    startAiTranslate({ ...common, replace: false, engine: "grok", model: "grok-translator-fixture" });
    assert.ok((await finished()).error);
    assert.ok(listJobs(eid).some(job => job.state === "failed" &&
      job.pages.some((page: any) => /Grok.*failure/i.test(page.error ?? ""))));
    assert.equal(qwenCalls, 0, "Grok failures must not fall back to Qwen");
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of [["GROK_BIN", previous.bin], ["PADDLEOCR_PYTHON", previous.python], ["PADDLEOCR_WORKER", previous.worker]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
    (globalThis as any).__scanOcr?.proc.kill();
    await rm(work, { recursive: true, force: true });
  }
});

test("compact scene notes keep standing setting once and drop lettering", async () => {
  const { compactSceneNotes } = await import("../src/lib/server/llm");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    assert.match(payload.messages[0].content, /Never quote/);
    assert.match(payload.messages[1].content, /Do not quote/);
    return Response.json({
      choices: [{
        message: {
          content: JSON.stringify({
            chapter: "Night market alley.",
            pages: [
              { i: 0, caption: "Two runners enter." },
              { i: 1, caption: "The stall keeper points left." },
            ],
          }),
        },
      }],
    });
  };
  try {
    const result = await compactSceneNotes([
      { i: 0, caption: "Night market alley. Two runners enter. A sign says OPEN." },
      { i: 1, caption: "Night market alley. The stall keeper points left and shouts wait." },
    ]);
    assert.equal(result.chapter, "Night market alley.");
    assert.equal(result.pages[0].caption, "Two runners enter.");
    assert.equal(result.pages[1].caption, "The stall keeper points left.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("suggest alternative re-translates with chapter context then offers English phrasings", async () => {
  const { alternativesPrompt } = await import("../src/lib/server/llm");
  const { startSuggestAlternatives } = await import("../src/lib/server/aiTranslate");
  const { listJobs } = await import("../src/lib/server/jobs");
  assert.match(
    alternativesPrompt({
      seriesNotes: "Keep Alice wary.",
      seriesGlossary: "アリス → Alice",
      prior: "",
      pages: "Rainy rooftop chase.",
      script: "source: こんにちは",
      source: "こんにちは",
      current: "Hello, my friend!",
      fresh: "Hey there, pal!",
      lineType: '""',
      page: "page 1/1",
      lang: "japanese",
    }),
    /at least 4 different English letterings/,
  );
  assert.match(
    alternativesPrompt({
      seriesNotes: "",
      seriesGlossary: "",
      prior: "",
      pages: "Rainy rooftop chase.",
      script: "",
      source: "こんにちは",
      current: "Hello, my friend!",
      fresh: "Hey there, pal!",
      lineType: '""',
      page: "page 1/1",
      lang: "japanese",
    }),
    /transcription: こんにちは[\s\S]*current English: Hello, my friend![\s\S]*scene description:\nRainy rooftop chase\./,
  );
  assert.doesNotMatch(
    alternativesPrompt({
      seriesNotes: "",
      seriesGlossary: "",
      prior: "",
      pages: "",
      script: "",
      source: "こんにちは",
      current: "Hello",
      fresh: "Hey there, pal!",
      lineType: '""',
      page: "page 1/1",
      lang: "japanese",
    }),
    /Hey there, pal!/,
  );
  sqlite
    .prepare(
      "INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES('alt-e','s','alt-chapter','Alt chapter',1,1)",
    )
    .run();
  sqlite
    .prepare("UPDATE series SET glossary=? WHERE id='s'")
    .run(JSON.stringify([{ source: "アリス", translation: "Alice", edited: true }]));
  const image = await saveImageFile({
    seriesSlug: "series",
    episodeSlug: "alt-chapter",
    sortOrder: 0,
    originalName: "alt.png",
    bytes: source,
    mime: "image/png",
  });
  await db.insert(schema.images).values({
    id: "alt-p",
    episodeId: "alt-e",
    originalName: "alt.png",
    ...image,
    sortOrder: 0,
    caption: "Rainy rooftop chase. Alice is hiding from Bob.",
    createdAt: 1,
    updatedAt: 1,
  });
  await db.insert(schema.lines).values([
    {
      id: "alt-l",
      episodeId: "alt-e",
      imageId: "alt-p",
      source: "こんにちは",
      sourceState: "read",
      body: "Hello, my friend!",
      lineType: '""',
      status: "approved",
      placed: true,
      x: 0.2,
      y: 0.25,
      w: 0.6,
      h: 0.5,
      sortOrder: 1,
      updatedAt: 1,
    },
    {
      id: "alt-near",
      episodeId: "alt-e",
      imageId: "alt-p",
      source: "待って",
      sourceState: "read",
      body: "Wait!",
      lineType: '""',
      status: "approved",
      placed: true,
      x: 0.2,
      y: 0.05,
      w: 0.4,
      h: 0.15,
      sortOrder: 0,
      updatedAt: 1,
    },
    {
      id: "alt-ignored",
      episodeId: "alt-e",
      imageId: "alt-p",
      source: "装飾",
      sourceState: "ignored",
      ignoreReason: "Decorative mark",
      body: "",
      lineType: "::",
      status: "none",
      placed: true,
      x: 0.8,
      y: 0.8,
      w: 0.1,
      h: 0.1,
      sortOrder: 2,
      updatedAt: 1,
    },
  ]);
  const user = { id: "u", username: "test", role: "admin" as const };
  const altEpisode = (await getEpisode("alt-e"))!;
  await assert.rejects(
    startSuggestAlternatives({ series, episode: altEpisode, user, lineId: "alt-ignored" }),
    /ignored/,
  );
  await assert.rejects(
    startSuggestAlternatives({
      series,
      episode: altEpisode,
      user,
      lineId: "alt-l",
      expectedRevision: 999,
    }),
    /changed/,
  );
  const oldNotes = (sqlite.prepare("SELECT notes FROM series WHERE id='s'").get() as { notes: string }).notes;
  sqlite.prepare("UPDATE series SET notes=? WHERE id='s'").run("Keep Alice wary.");
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const prompts: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    const system = String(payload.messages[0].content);
    const userPrompt = String(payload.messages[1].content);
    prompts.push(userPrompt);
    let response;
    if (system.startsWith("You translate")) {
      calls.push("translate");
      assert.match(userPrompt, /Rainy rooftop chase/);
      assert.match(userPrompt, /Keep Alice wary/);
      assert.match(userPrompt, /アリス → Alice/);
      assert.match(userPrompt, /待って → Wait!/);
      response = JSON.stringify({
        items: [{ i: 0, translation: "Hey there, pal!", literal: "hello", reasoning: "Natural greeting" }],
      });
    } else if (system.includes("Propose alternative")) {
      calls.push("alternatives");
      if (userPrompt.includes("transcription: こんにちは")) {
        assert.match(userPrompt, /at least 4/);
        assert.match(userPrompt, /transcription: こんにちは/);
        assert.match(userPrompt, /current English: Hello, my friend!/);
        assert.match(userPrompt, /scene description:/);
        assert.doesNotMatch(userPrompt, /Hey there, pal!/);
        assert.match(userPrompt, /Rainy rooftop chase/);
        assert.match(userPrompt, /Keep Alice wary/);
        assert.match(userPrompt, /待って/);
      }
      response = JSON.stringify({
        items: [
          { i: 0, translation: "Hi, buddy.", literal: "hello", reasoning: "Shorter voice" },
          { i: 1, translation: "Hello there.", literal: "hello", reasoning: "Calmer greeting" },
          { i: 2, translation: "Hey there, pal!", literal: "hello", reasoning: "duplicate" },
        ],
      });
    } else {
      calls.push("unexpected");
      response = "";
    }
    return Response.json({ choices: [{ message: { content: response } }] });
  };
  try {
    const { jobId } = await startSuggestAlternatives({
      series,
      episode: altEpisode,
      user,
      lineId: "alt-l",
      engine: "qwen",
      lang: "japanese",
      model: "fixture",
    });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const job = listJobs("alt-e").find((j) => j.id === jobId);
      if (job && job.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const job = listJobs("alt-e").find((j) => j.id === jobId);
    assert.equal(job?.kind, "suggest");
    assert.equal(job?.state, "completed", job?.error ?? "");
    assert.deepEqual(calls, ["translate", "alternatives"]);
    assert.match(prompts[0], /こんにちは/);
    assert.match(prompts[1], /こんにちは/);
    assert.match(prompts[1], /Hello, my friend!/);
    const kept = (await listLines("alt-e")).find((l) => l.id === "alt-l")!;
    assert.equal(kept.body, "Hello, my friend!");
    assert.equal(kept.status, "approved");
    const rows = sqlite
      .prepare("SELECT kind,body,reason FROM suggestions WHERE episode_id='alt-e' AND line_id='alt-l'")
      .all() as { kind: string; body: string; reason: string }[];
    assert.deepEqual(
      rows.filter((r) => r.kind === "translation").map((r) => r.body),
      ["Hey there, pal!"],
    );
    assert.deepEqual(
      rows.filter((r) => r.kind === "alternative").map((r) => r.body).sort(),
      ["Hello there.", "Hi, buddy."],
    );
    assert.match(rows.find((r) => r.kind === "translation")!.reason, /Natural greeting|chapter context/);
    await db.insert(schema.lines).values({
      id: "alt-empty",
      episodeId: "alt-e",
      imageId: "alt-p",
      source: "ありがとう",
      sourceState: "read",
      body: "",
      lineType: '""',
      status: "none",
      placed: true,
      x: 0.1,
      y: 0.7,
      w: 0.3,
      h: 0.15,
      sortOrder: 3,
      updatedAt: 1,
    });
    const emptyJob = await startSuggestAlternatives({
      series,
      episode: (await getEpisode("alt-e"))!,
      user,
      lineId: "alt-empty",
      engine: "qwen",
      lang: "japanese",
      model: "fixture",
    });
    const emptyDeadline = Date.now() + 10000;
    while (Date.now() < emptyDeadline) {
      const next = listJobs("alt-e").find((j) => j.id === emptyJob.jobId);
      if (next && next.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const filled = (await listLines("alt-e")).find((l) => l.id === "alt-empty")!;
    const emptyDone = listJobs("alt-e").find((j) => j.id === emptyJob.jobId);
    assert.equal(emptyDone?.state, "completed", emptyDone?.error ?? "");
    assert.equal(filled.body, "Hey there, pal!");
    assert.equal(filled.status, "needs_work");
    const emptySuggestions = sqlite
      .prepare("SELECT kind,body FROM suggestions WHERE line_id='alt-empty'")
      .all() as { kind: string; body: string }[];
    assert.equal(emptySuggestions.every((r) => r.kind === "alternative"), true);
    assert.deepEqual(emptySuggestions.map((r) => r.body).sort(), ["Hello there.", "Hi, buddy."]);
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.prepare("UPDATE series SET notes=?, glossary='[]' WHERE id='s'").run(oldNotes);
  }
});

const testUser = { id: "u", username: "test", role: "admin" as const };

async function waitForJob(episodeId: string, jobId: string) {
  const { listJobs } = await import("../src/lib/server/jobs");
  for (let i = 0; i < 800; i++) {
    const job = listJobs(episodeId).find((j) => j.id === jobId);
    if (job && !["running", "queued", "cancelling"].includes(job.state)) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`job ${jobId} did not finish`);
}

async function llmReply(content: string, delay = 0, signal?: AbortSignal | null) {
  if (delay) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, delay);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        },
        { once: true },
      );
    });
  }
  return Response.json({ choices: [{ message: { content } }] });
}

test("describe creates a job, records LLM I/O, and completes", async () => {
  sqlite
    .prepare(
      "INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES('describe-e','s','describe','Describe',1,1)",
    )
    .run();
  const ep = (await getEpisode("describe-e"))!;
  const bytes = await sharp({
    create: { width: 80, height: 80, channels: 3, background: { r: 240, g: 240, b: 240 } },
  })
    .png()
    .toBuffer();
  const saved = await saveImageFile({
    seriesSlug: "series",
    episodeSlug: "describe",
    sortOrder: 0,
    originalName: "scene.png",
    bytes,
    mime: "image/png",
  });
  await db.insert(schema.images).values({
    id: "describe-p",
    episodeId: ep.id,
    originalName: "scene.png",
    ...saved,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  });
  const { startDescribePages } = await import("../src/lib/server/pageEdit");
  const { listJobs, sanitizeLlmMessages } = await import("../src/lib/server/jobs");
  assert.match(
    sanitizeLlmMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this page" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
        ],
      },
    ]),
    /\[image attached\]/,
  );
  assert.doesNotMatch(
    sanitizeLlmMessages([
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,SECRET" } }] },
    ]),
    /SECRET/,
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => llmReply("A quiet street at dusk.", 0, init?.signal);
  try {
    const { jobId } = startDescribePages(
      { series, episode: ep, user: testUser },
      ["describe-p"],
      true,
      "qwen",
      "fixture-describe",
    );
    const job = await waitForJob(ep.id, jobId);
    assert.equal(job.kind, "describe");
    assert.equal(job.state, "completed");
    assert.equal(job.progress.total, 1);
    assert.equal(job.progress.completed, 1);
    assert.ok(Array.isArray(job.progress.log) && job.progress.log.length >= 1);
    const log = job.progress.log[0];
    assert.match(log.request, /\[image attached\]/);
    assert.doesNotMatch(log.request, /data:image\/jpeg;base64,/);
    assert.match(log.response || "", /quiet street/);
    const img = (await listImages(ep.id))[0];
    assert.equal(img.caption, "A quiet street at dusk.");
    assert.equal(listJobs(ep.id).find((j) => j.id === jobId)?.kind, "describe");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("describe with Qwen3-VL uses the local VL server, not the 27B", async () => {
  sqlite
    .prepare(
      "INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES('describe-vl-e','s','describe-vl','Describe VL',1,1)",
    )
    .run();
  const ep = (await getEpisode("describe-vl-e"))!;
  const bytes = await sharp({
    create: { width: 80, height: 80, channels: 3, background: { r: 18, g: 24, b: 48 } },
  })
    .png()
    .toBuffer();
  const saved = await saveImageFile({
    seriesSlug: "series",
    episodeSlug: "describe-vl",
    sortOrder: 0,
    originalName: "night.png",
    bytes,
    mime: "image/png",
  });
  await db.insert(schema.images).values({
    id: "describe-vl-p",
    episodeId: ep.id,
    originalName: "night.png",
    ...saved,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  });
  const { fixturePasses, localOcrFixture } = await import("./local-ocr-fixture");
  const restoreOcr = await localOcrFixture();
  await fixturePasses("qwen3-vl-8b", ["describe"]);
  const { startDescribePages } = await import("../src/lib/server/pageEdit");
  const { listJobs } = await import("../src/lib/server/jobs");
  const originalFetch = globalThis.fetch;
  let vlCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("ocr.fixture/qwen3-vl-8b")) {
      vlCalls += 1;
      const payload = JSON.parse(String(init?.body || "{}"));
      assert.equal(payload.model, "qwen3-vl-8b");
      assert.match(JSON.stringify(payload.messages), /Visuals and action only/);
      return llmReply("A rooftop at night.");
    }
    const payload = JSON.parse(String(init?.body || "{}"));
    if (String(payload.messages?.[0]?.content || "").startsWith("You edit scanlation scene notes"))
      return llmReply(JSON.stringify({ chapter: "", pages: [{ i: 0, caption: "A rooftop at night." }] }));
    throw new Error(`Qwen 3.8 27B must not describe when Qwen3-VL is selected: ${url}`);
  };
  try {
    const { jobId } = startDescribePages(
      { series, episode: ep, user: testUser },
      ["describe-vl-p"],
      true,
      "qwen",
      "qwen3-vl-8b",
    );
    const job = await waitForJob(ep.id, jobId);
    assert.equal(job.state, "completed");
    assert.equal(vlCalls, 1);
    assert.equal((await listImages(ep.id))[0].caption, "A rooftop at night.");
    assert.equal(listJobs(ep.id).find((j) => j.id === jobId)?.payload.model, "qwen3-vl-8b");
  } finally {
    globalThis.fetch = originalFetch;
    restoreOcr();
  }
});

test("describe cancel and retry still work", async () => {
  sqlite
    .prepare(
      "INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES('describe-cancel-e','s','describe-cancel','Describe cancel',1,1)",
    )
    .run();
  const ep = (await getEpisode("describe-cancel-e"))!;
  const bytes = await sharp({
    create: { width: 40, height: 40, channels: 3, background: { r: 200, g: 200, b: 200 } },
  })
    .png()
    .toBuffer();
  const saved = await saveImageFile({
    seriesSlug: "series",
    episodeSlug: "describe-cancel",
    sortOrder: 0,
    originalName: "page.png",
    bytes,
    mime: "image/png",
  });
  await db.insert(schema.images).values({
    id: "describe-cancel-p",
    episodeId: ep.id,
    originalName: "page.png",
    ...saved,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  });
  const { startDescribePages, cancelDescribePages } = await import("../src/lib/server/pageEdit");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => llmReply("Should not land", 400, init?.signal);
  try {
    const first = startDescribePages(
      { series, episode: ep, user: testUser },
      ["describe-cancel-p"],
      true,
      "qwen",
    );
    cancelDescribePages(ep.id);
    const cancelled = await waitForJob(ep.id, first.jobId);
    assert.equal(cancelled.state, "cancelled");
    globalThis.fetch = async (_url, init) => llmReply("Retry scene note", 0, init?.signal);
    const retry = startDescribePages(
      { series, episode: ep, user: testUser },
      ["describe-cancel-p"],
      true,
      "qwen",
    );
    const done = await waitForJob(ep.id, retry.jobId);
    assert.equal(done.state, "completed");
    assert.equal((await listImages(ep.id))[0].caption, "Retry scene note");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("clear-finished deletes terminal jobs and leaves running ones", async () => {
  sqlite
    .prepare(
      "INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES('clear-e','s','clear-jobs','Clear',1,1)",
    )
    .run();
  const { createJob, updateJob, pageResult, listJobs, clearFinishedJobs } =
    await import("../src/lib/server/jobs");
  const running = createJob("clear-e", "translate", { keep: true });
  const completed = createJob("clear-e", "describe", {});
  const failed = createJob("clear-e", "reslice", {});
  const cancelled = createJob("clear-e", "export", {});
  pageResult(completed, "p", "completed");
  updateJob(completed, "completed", { message: "done" });
  updateJob(failed, "failed", { message: "nope" }, "nope");
  updateJob(cancelled, "cancelled", { message: "stop" });
  const removed = clearFinishedJobs("clear-e");
  assert.equal(removed, 3);
  const left = listJobs("clear-e");
  assert.equal(left.length, 1);
  assert.equal(left[0].id, running);
  assert.equal(left[0].state, "running");
});

test("job log caps history and compact summaries omit older entries", async () => {
  const { createJob, runWithJob, appendJobLog, listJobs, clipJobText, updateJob } =
    await import("../src/lib/server/jobs");
  const id = createJob("e", "describe", {});
  runWithJob({ jobId: id, step: "describe", engine: "qwen" }, () => {
    for (let i = 0; i < 90; i++)
      appendJobLog(id, { request: `call ${i}`, response: `out ${i}` });
    appendJobLog(id, {
      request: "x".repeat(9000),
      response: "data:image/jpeg;base64,SHOULD_NOT_MATTER",
    });
  });
  const full = listJobs("e").find((j) => j.id === id)!;
  assert.equal(full.progress.log.length, 80);
  assert.equal(full.progress.logCount, 80);
  assert.equal(full.progress.log[0].request, "call 11");
  const last = full.progress.log.at(-1)!;
  assert.match(last.request, /truncated/);
  assert.ok(last.request.length < 9000);
  updateJob(id, "completed", {
    image: "data:image/png;base64," + "A".repeat(2000),
    mask: "data:image/png;base64," + "B".repeat(2000),
    message: "done",
  });
  const stored = listJobs("e").find((j) => j.id === id)!;
  assert.equal(stored.progress.image, undefined);
  assert.equal(stored.progress.mask, undefined);
  assert.equal(stored.progress.message, "done");
  const summary = listJobs("e", "summary").find((j) => j.id === id)!;
  assert.equal(summary.progress.log.length, 8);
  assert.equal(summary.progress.logCount, 80);
  assert.equal(summary.progress.image, undefined);
  assert.ok(clipJobText("a".repeat(9000)).includes("truncated"));
});

test("job log unwraps Cursor envelopes into prompt, result, and usage", async () => {
  const { summarizeModelOutput, formatJobUsage, createJob, runWithJob, appendJobLog, listJobs } =
    await import("../src/lib/server/jobs");
  const envelope = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 47739,
    duration_api_ms: 47739,
    result:
      'Reading `prompt.txt` and `image.jpg`.\n\n{"caption": "A muscular green orc confronts two humans at night."}',
    session_id: "f8954a36-df8e-4b3b-9bc9-aa95251e7da9",
    usage: {
      inputTokens: 7029,
      outputTokens: 1280,
      cacheReadTokens: 20349,
      cacheWriteTokens: 0,
    },
  });
  const summary = summarizeModelOutput(envelope);
  assert.match(summary.response ?? "", /muscular green orc/);
  assert.doesNotMatch(summary.response ?? "", /"type":"result"/);
  assert.equal(summary.usage?.input, 7029);
  assert.equal(summary.usage?.output, 1280);
  assert.equal(summary.usage?.cacheRead, 20349);
  assert.equal(summary.usage?.cacheWrite, 0);
  assert.equal(summary.usage?.durationMs, 47739);
  assert.equal(
    formatJobUsage(summary.usage!),
    "Input 7029 Output 1280 Cache Read 20349 Cache Write 0 Time Taken 47.7s Token/s 26.8tok/s",
  );
  const openai = summarizeModelOutput(
    JSON.stringify({
      choices: [{ message: { content: "A quiet street at dusk." } }],
      usage: { prompt_tokens: 12, completion_tokens: 8 },
    }),
    2000,
  );
  assert.equal(openai.response, "A quiet street at dusk.");
  assert.equal(openai.usage?.input, 12);
  assert.equal(openai.usage?.output, 8);
  assert.equal(openai.usage?.durationMs, 2000);
  const id = createJob("e", "describe", {});
  runWithJob({ jobId: id, step: "describe", engine: "cursor" }, () => {
    appendJobLog(id, {
      request: "Describe this page.\n[image attached]",
      response: summary.response,
      usage: summary.usage,
    });
  });
  const logged = listJobs("e").find((j) => j.id === id)!.progress.log[0];
  assert.match(logged.request, /Describe this page/);
  assert.match(logged.response || "", /muscular green orc/);
  assert.match(logged.usageText || "", /Input 7029/);
  assert.match(logged.usageText || "", /Token\/s 26\.8tok\/s/);
});

test("reslice packs at the last white band before 16k and force-cuts solid art", async () => {
  const { findWhiteRowBands, chooseCuts, RESLICE_MAX_H } = await import(
    "../src/lib/server/reslice"
  );
  const width = 32;
  const height = 80;
  const raw = Buffer.alloc(width * height * 3, 20);
  for (let y = 40; y < 56; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[i] = raw[i + 1] = raw[i + 2] = 255;
    }
  }
  const bands = findWhiteRowBands(raw, width, height, 3);
  assert.equal(bands.length, 1);
  assert.ok(bands[0].y >= 40 && bands[0].y <= 56);
  const packed = chooseCuts(400, [{ top: 80, bottom: 90, y: 85 }, { top: 250, bottom: 270, y: 260 }], 300);
  assert.deepEqual(packed.cuts, [260]);
  assert.deepEqual(packed.forced, []);
  const forced = chooseCuts(400, [], 300);
  assert.deepEqual(forced.cuts, [300]);
  assert.deepEqual(forced.forced, [300]);
  const over = chooseCuts(RESLICE_MAX_H + 50, [], RESLICE_MAX_H);
  assert.deepEqual(over.cuts, [RESLICE_MAX_H]);
  assert.deepEqual(over.forced, [RESLICE_MAX_H]);
});

test("reslice keeps a dark block that straddled the old page boundary", async () => {
  sqlite
    .prepare(
      "INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES('slice-e','s','slice','Slice',1,1)",
    )
    .run();
  const ep = (await getEpisode("slice-e"))!;
  const ctx = { series, episode: ep, user: testUser };
  async function pageBytes(height: number, paint: (y: number) => number) {
    const width = 24;
    const raw = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      const v = paint(y);
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3;
        raw[i] = raw[i + 1] = raw[i + 2] = v;
      }
    }
    return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
  }
  const first = await saveImageFile({
    seriesSlug: "series",
    episodeSlug: "slice",
    sortOrder: 0,
    originalName: "a.png",
    bytes: await pageBytes(200, () => 18),
    mime: "image/png",
  });
  const second = await saveImageFile({
    seriesSlug: "series",
    episodeSlug: "slice",
    sortOrder: 1,
    originalName: "b.png",
    bytes: await pageBytes(200, (y) => (y < 80 ? 18 : 255)),
    mime: "image/png",
  });
  await db.insert(schema.images).values([
    {
      id: "slice-a",
      episodeId: ep.id,
      originalName: "a.png",
      ...first,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "slice-b",
      episodeId: ep.id,
      originalName: "b.png",
      ...second,
      sortOrder: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  ]);
  await db.insert(schema.lines).values({
    id: "slice-line",
    episodeId: ep.id,
    imageId: "slice-a",
    source: "bubble",
    sourceState: "read",
    body: "Hi",
    lineType: '""',
    status: "none",
    placed: true,
    x: 0.1,
    y: 0.9,
    w: 0.3,
    h: 0.08,
    sortOrder: 0,
    updatedAt: 1,
  });
  const { reslicePages } = await import("../src/lib/server/reslice");
  const result = await reslicePages(ctx, { imageIds: ["slice-a", "slice-b"] });
  assert.equal(result.forced.length, 0);
  const pages = await listImages(ep.id);
  assert.equal(pages.length, 1);
  assert.ok(pages[0].height <= 16000);
  assert.equal(pages[0].height, 400);
  const { data, info } = await sharp(
    (await readWorkingOrOrig("series", "slice", pages[0].filename))!,
  )
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const sample = (y: number) => data[(y * info.width + 2) * info.channels];
  assert.ok(sample(10) < 40, "block top stays dark");
  assert.ok(sample(270) < 40, "block continues past the old boundary");
  assert.ok(sample(350) > 240, "white band after the block");
  const moved = (await listLines(ep.id)).find((l) => l.id === "slice-line")!;
  assert.equal(moved.imageId, pages[0].id);
});

test("the reslice preview keeps a tall stitch legible and names its page bands", async () => {
  const { previewScale, previewReslice, PREVIEW_MAX_PIXELS } = await import(
    "../src/lib/server/reslice"
  );
  // The regression this guards: scaling by the long edge turned an 800px-wide, 30k-tall
  // strip into a ~50px-wide preview, which the canvas then blew back up to screen width.
  assert.equal(previewScale(800, 29650), 1);
  assert.equal(previewScale(800, 16000), 1);
  assert.equal(previewScale(1200, 900), 1);
  // A stitch past the pixel budget still shrinks, but by the budget rather than the edge.
  const huge = previewScale(2400, 60000);
  assert.ok(huge < 1, "an oversized stitch is scaled down");
  assert.ok(
    2400 * huge * 60000 * huge <= PREVIEW_MAX_PIXELS + 1,
    "the pixel budget bounds the preview",
  );
  assert.ok(2400 * huge >= 800, "even an oversized stitch keeps a usable width");

  sqlite
    .prepare(
      "INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES('prev-e','s','prev','Prev',1,1)",
    )
    .run();
  const ep = (await getEpisode("prev-e"))!;
  const ctx = { series, episode: ep, user: testUser };
  const tall = (grey: number) =>
    sharp({ create: { width: 32, height: 9000, channels: 3, background: { r: grey, g: grey, b: grey } } })
      .png()
      .toBuffer();
  for (const [i, grey] of [200, 120, 60].entries()) {
    const saved = await saveImageFile({
      seriesSlug: "series",
      episodeSlug: "prev",
      sortOrder: i,
      originalName: `p${i}.png`,
      bytes: await tall(grey),
      mime: "image/png",
    });
    await db.insert(schema.images).values({
      id: `prev-${i}`,
      episodeId: ep.id,
      originalName: `p${i}.png`,
      ...saved,
      sortOrder: i,
      createdAt: 1,
      updatedAt: 1,
    });
  }
  const preview = await previewReslice(ctx, ["prev-0", "prev-1", "prev-2"]);
  assert.equal(preview.width, 32);
  assert.equal(preview.height, 27000);
  // Offsets are cumulative in page order; numbering itself is the client's job, because the
  // sidebar numbers by position and the stored page number can be stale.
  assert.deepEqual(
    preview.pages.map((p) => ({ id: p.id, top: p.top, height: p.height })),
    [
      { id: "prev-0", top: 0, height: 9000 },
      { id: "prev-1", top: 9000, height: 9000 },
      { id: "prev-2", top: 18000, height: 9000 },
    ],
  );
  // The preview is the stitch itself, so a click's fraction of height still maps 1:1.
  const meta = await sharp(Buffer.from(preview.preview.split(",")[1], "base64")).metadata();
  assert.equal(meta.width, 32);
  assert.equal(meta.height, 27000);
});

test("reslice force-cuts when a solid block is taller than 16k", async () => {
  sqlite
    .prepare(
      "INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES('force-e','s','force','Force',1,1)",
    )
    .run();
  const ep = (await getEpisode("force-e"))!;
  const bytes = await sharp({
    create: {
      width: 16,
      height: 16100,
      channels: 3,
      background: { r: 12, g: 12, b: 12 },
    },
  })
    .png()
    .toBuffer();
  const saved = await saveImageFile({
    seriesSlug: "series",
    episodeSlug: "force",
    sortOrder: 0,
    originalName: "tall.png",
    bytes,
    mime: "image/png",
  });
  await db.insert(schema.images).values({
    id: "force-p",
    episodeId: ep.id,
    originalName: "tall.png",
    ...saved,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  });
  const { reslicePages, RESLICE_MAX_H } = await import("../src/lib/server/reslice");
  const result = await reslicePages(
    { series, episode: ep, user: testUser },
    { imageIds: ["force-p"] },
  );
  assert.deepEqual(result.forced, [RESLICE_MAX_H]);
  const pages = await listImages(ep.id);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].height, RESLICE_MAX_H);
  assert.equal(pages[1].height, 100);
  assert.ok(pages.every((p) => p.height <= RESLICE_MAX_H));
});

test("reslice keeps its slices together and names them after the page they came from", async () => {
  sqlite
    .prepare(
      "INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES('ord-e','s','ord','Ord',1,1)",
    )
    .run();
  const ep = (await getEpisode("ord-e"))!;
  const ctx = { series, episode: ep, user: testUser };
  // Five pages, three of them selected: cutting those into five slices leaves more pages out
  // than went in, which is what used to scatter the leftovers between the new slices.
  for (let i = 0; i < 5; i++) {
    const saved = await saveImageFile({
      seriesSlug: "series",
      episodeSlug: "ord",
      sortOrder: i,
      originalName: `page-${i + 1}.png`,
      bytes: await sharp({
        create: {
          width: 24,
          height: 100,
          channels: 3,
          background: { r: 30 + i * 40, g: 30, b: 30 },
        },
      })
        .png()
        .toBuffer(),
      mime: "image/png",
    });
    await db.insert(schema.images).values({
      id: `ord-${i}`,
      episodeId: ep.id,
      originalName: `page-${i + 1}.png`,
      ...saved,
      sortOrder: i,
      createdAt: 1,
      updatedAt: 1,
    });
  }
  const { reslicePages } = await import("../src/lib/server/reslice");
  // Cuts at 50/100/150/200 split the 300px stitch into five slices: two from each of the
  // first two pages, one from the third.
  await reslicePages(ctx, {
    imageIds: ["ord-0", "ord-1", "ord-2"],
    cuts: [50, 100, 150, 200],
  });

  const pages = await listImages(ep.id);
  // Every slice is named for the page it started in, numbered from 1 on that page, and the
  // pages that followed the window stay behind the run instead of landing inside it.
  assert.deepEqual(
    pages.map((p) => p.originalName),
    [
      "page-1-1.png",
      "page-1-2.png",
      "page-2-1.png",
      "page-2-2.png",
      "page-3-1.png",
      "page-4.png",
      "page-5.png",
    ],
  );
  assert.deepEqual(pages.map((p) => p.id).slice(5), ["ord-3", "ord-4"]);
  assert.deepEqual(
    pages.map((p) => p.sortOrder),
    [0, 1, 2, 3, 4, 5, 6],
  );
  // The file name carries the position each slice landed in.
  assert.deepEqual(
    pages.slice(0, 5).map((p) => p.filename),
    [
      "01-page-1-1.png",
      "02-page-1-2.png",
      "03-page-2-1.png",
      "04-page-2-2.png",
      "05-page-3-1.png",
    ],
  );

  const { undoPageOp } = await import("../src/lib/server/pageEdit");
  await undoPageOp(ctx);
  const restored = await listImages(ep.id);
  assert.deepEqual(
    restored.map((p) => p.id),
    ["ord-0", "ord-1", "ord-2", "ord-3", "ord-4"],
  );
  assert.deepEqual(
    restored.map((p) => p.sortOrder),
    [0, 1, 2, 3, 4],
  );
});

test("public preview mint rotate revoke and guest PNG", async () => {
  const { POST } = await import("../src/routes/api/episodes/[eid]/preview/+server");
  const { GET } = await import("../src/routes/p/[token]/i/[id]/+server");
  const { renderGuestPage } = await import("../src/lib/server/finishedExport");
  const { workflowState } = await import("../src/lib/server/workflowService");
  const locals = { user: testUser };
  const minted = await POST({
    locals,
    params: { eid: "e" },
    request: new Request("http://local/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  } as any);
  const first = await minted.json();
  assert.ok(first.token && first.token.length >= 20);
  const state = await workflowState(series, episode);
  assert.equal(state.previewToken, first.token);
  await preparePage(series, episode, (await listImages("e"))[0]);
  const png = await renderGuestPage(series, episode, (await listImages("e"))[0]);
  assert.equal(png[0], 0x89);
  assert.equal(png[1], 0x50);
  const guest = await GET({
    params: { token: first.token, id: "p" },
  } as any);
  assert.equal(guest.status, 200);
  assert.equal(guest.headers.get("content-type"), "image/png");
  const rotated = await POST({
    locals,
    params: { eid: "e" },
    request: new Request("http://local/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rotate: true }),
    }),
  } as any);
  const next = await rotated.json();
  assert.ok(next.token);
  assert.notEqual(next.token, first.token);
  const stale = await GET({ params: { token: first.token, id: "p" } } as any);
  assert.equal(stale.status, 404);
  const revoked = await POST({
    locals,
    params: { eid: "e" },
    request: new Request("http://local/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revoke: true }),
    }),
  } as any);
  assert.equal((await revoked.json()).token, null);
  const gone = await GET({ params: { token: next.token, id: "p" } } as any);
  assert.equal(gone.status, 404);
});

test("episode page no longer honors ?legacy=1", async () => {
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const page = await readFile(
    join(process.cwd(), "src/routes/series/[id]/episodes/[eid]/+page.svelte"),
    "utf8",
  );
  const server = await readFile(
    join(process.cwd(), "src/routes/series/[id]/episodes/[eid]/+page.server.ts"),
    "utf8",
  );
  assert.match(page, /Workflow/);
  assert.doesNotMatch(page, /legacy/i);
  assert.doesNotMatch(page, /Editor/);
  assert.doesNotMatch(server, /legacy/i);
  assert.equal(existsSync(join(process.cwd(), "src/lib/components/Editor.svelte")), false);
});

test("typeset text masks hide overlapping balloons and survive PSD as layer masks", async () => {
  const {
    applyTextMaskEdits,
    applyTextMaskToLayer,
    overlappingHoles,
    saveRegionTextMask,
  } = await import("../src/lib/server/textMask");
  const { readAsset } = await import("../src/lib/server/workflowStore");
  const behind = { id: "sfx", x: 0, y: 0, w: 1, h: 1, sourceState: "read" as const };
  const balloon = { id: "dlg", x: 0.25, y: 0.25, w: 0.5, h: 0.5, sourceState: "read" as const };
  const ignored = { id: "ign", x: 0, y: 0, w: 1, h: 1, sourceState: "ignored" as const };
  const holes = overlappingHoles(behind as any, [behind, balloon, ignored] as any, new Map([
    ["dlg", { polygon: [{ x: 0.25, y: 0.25 }, { x: 0.75, y: 0.25 }, { x: 0.75, y: 0.75 }, { x: 0.25, y: 0.75 }] }],
  ]));
  assert.equal(holes.length, 1);
  const punched = await applyTextMaskEdits({ width: 40, height: 40, holes });
  const gray = await sharp(punched).greyscale().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(gray.data[20 * 40 + 20], 0, "balloon interior conceals text");
  assert.ok(gray.data[2] > 200, "outside the balloon still reveals text");
  const restored = await applyTextMaskEdits({
    width: 40,
    height: 40,
    existing: punched,
    strokes: [{ points: [{ x: 0.5, y: 0.5 }], radius: 8, erase: true }],
  });
  const afterErase = await sharp(restored).greyscale().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.ok(afterErase.data[20 * 40 + 20] > 200, "erase restores visibility");

  const red = await sharp({
    create: { width: 40, height: 40, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  }).png().toBuffer();
  const clipped = await applyTextMaskToLayer(red, punched, 0, 0, 40, 40);
  const px = await sharp(clipped).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(px.data[(20 * 40 + 20) * 4 + 3], 0, "hidden pixels lose alpha");
  assert.ok(px.data[2 * 4 + 3] > 200, "visible pixels keep alpha");

  sqlite.prepare("INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES('text-mask-e','s','text-mask','Mask',1,1)").run();
  try {
    const art = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 255, b: 255 } },
    }).png().toBuffer();
    const artHash = await storeAsset(art);
    await db.insert(schema.images).values({
      id: "text-mask-p", episodeId: "text-mask-e", filename: "mask.png", originalName: "mask.png",
      width: 64, height: 64, sortOrder: 0, createdAt: 1, updatedAt: 1,
    });
    await db.insert(schema.lines).values({
      id: "text-mask-sfx", episodeId: "text-mask-e", imageId: "text-mask-p", body: "BOOM",
      lineType: "::", sourceState: "read", placed: true, x: 0, y: 0, w: 1, h: 1, sortOrder: 0, updatedAt: 1,
    });
    await db.insert(schema.lines).values({
      id: "text-mask-dlg", episodeId: "text-mask-e", imageId: "text-mask-p", body: "Hello",
      lineType: '""', sourceState: "read", placed: true, x: 0.25, y: 0.25, w: 0.5, h: 0.5, sortOrder: 1, updatedAt: 1,
    });
    const sfx = (await listLines("text-mask-e")).find((l) => l.id === "text-mask-sfx")!;
    const img = { id: "text-mask-p", episodeId: "text-mask-e", filename: "mask.png", originalName: "mask.png",
      width: 64, height: 64, sortOrder: 0, createdAt: 1, updatedAt: 1 } as any;
    const saved = await saveRegionTextMask("text-mask-e", sfx, img, 0, { knockout: true });
    assert.ok(saved.data.textMask);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" fill="#ff0000"/></svg>`;
    const page = {
      image: img,
      source: { original: artHash, prepared: artHash, cleaned: artHash },
      sourceRevision: 1,
      dpi: 72,
      regions: [{
        line: sfx,
        revision: saved.revision,
        data: {
          textMask: saved.data.textMask,
          layout: {
            key: "mask-test",
            rows: [{ text: "BOOM", x: 8, baseline: 32, width: 40 }],
            size: 18,
            dpi: 72,
            width: 64,
            height: 64,
            svg,
            overflow: false,
            missingGlyphs: [],
            hyphenated: false,
            style: { ...DEFAULT_STYLE, fontId: "test" },
            font: { id: "test", hash: "x", postscriptName: "Test" },
          },
        },
      }],
    };
    const rendered = await renderPage(page as any);
    const composite = await sharp(rendered.composite).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const hole = (32 * 64 + 32) * 4;
    assert.ok(
      composite.data[hole] > 200 && composite.data[hole + 1] > 200 && composite.data[hole + 2] > 200,
      "flattened export knocks out the balloon",
    );
    const visible = (2 * 64 + 2) * 4;
    assert.ok(composite.data[visible] > 200 && composite.data[visible + 1] < 40, "visible text area stays red");
    const psd = readPsd(await finishedPsd(page as any, rendered), { useImageData: true });
    const text = psd.children!.find((layer) => layer.text);
    assert.ok(text?.mask?.imageData, "PSD keeps an editable layer mask");
    assert.equal(text!.mask!.defaultColor, 255);
    const cleared = await saveRegionTextMask("text-mask-e", sfx, img, saved.revision, { clear: true });
    assert.equal(cleared.data.textMask, undefined);
    assert.ok(await readAsset(saved.data.textMask!));
  } finally {
    sqlite.prepare("DELETE FROM episodes WHERE id='text-mask-e'").run();
  }
});

test("saving a cleaning sample writes incrementing raw and clean images", async () => {
  const { saveCleaningSample, cleaningSamplesDir } = await import("../src/lib/server/cleaningSamples");
  const raw = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ff0000" } }).png().toBuffer();
  const clean = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#00ff00" } }).png().toBuffer();
  const rawHash = await storeAsset(raw);
  const cleanHash = await storeAsset(clean);
  putDoc("e", "page:sample-p", { prepared: rawHash, original: rawHash, cleaned: cleanHash }, 0);
  const series = { id: "s", slug: "series", title: "Test", notes: "", glossary: [], createdAt: 1, updatedAt: 1 };
  const episode = { id: "e", seriesId: "s", slug: "chapter", title: "Chapter", sortOrder: 0, status: "cleaning" as const, glossary: [], createdAt: 1, updatedAt: 1 };
  const image = { id: "sample-p", episodeId: "e", filename: "p.png", originalName: "p.png",
    sortOrder: 0, width: 8, height: 8, caption: "", createdAt: 1, updatedAt: 1 };
  const first = await saveCleaningSample(series as any, episode as any, image as any);
  assert.equal(first.id, 1);
  assert.equal(first.raw, "001-raw.png");
  const dir = cleaningSamplesDir();
  const firstRaw = await sharp(join(dir, first.raw)).raw().toBuffer();
  const firstClean = await sharp(join(dir, first.clean)).raw().toBuffer();
  assert.ok(firstRaw[0] > 200 && firstRaw[1] < 40, "raw keeps lettering-page pixels");
  assert.ok(firstClean[1] > 200 && firstClean[0] < 40, "clean is the cleaned artwork");
  await writeFile(join(dir, "005-raw.png"), raw);
  const second = await saveCleaningSample(series as any, episode as any, image as any);
  assert.equal(second.id, 6);
  assert.equal(second.raw, "006-raw.png");
  await readFile(join(dir, "006-clean.png"));
  await readFile(join(dir, "001.json"));
  const current = getDoc("page:sample-p", {});
  putDoc("e", current.id, { prepared: rawHash, original: rawHash }, current.revision);
  await assert.rejects(() => saveCleaningSample(series as any, episode as any, image as any), /Clean the page/);
});
