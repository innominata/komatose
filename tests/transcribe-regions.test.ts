import assert from "node:assert/strict";
import test from "node:test";
import {
  dropRedundantTranscriptions,
  isAlreadyEnglish,
  type TranscriptRegion,
} from "../src/lib/transcribeRegions";

function box(id: string, source: string, x: number, y: number, w: number, h: number, english = false): TranscriptRegion {
  return { id, source, x, y, w, h, english };
}

test("latin lettering is English; source script, digits, and single letters are not", () => {
  assert.equal(isAlreadyEnglish("GIVE MY REGARDS"), true);
  assert.equal(isAlreadyEnglish("ＳＡＴＯ"), true);
  assert.equal(isAlreadyEnglish("ブラックジャック"), false);
  assert.equal(isAlreadyEnglish("안녕하세요"), false);
  assert.equal(isAlreadyEnglish("Hello世界"), false);
  assert.equal(isAlreadyEnglish("1"), false);
  assert.equal(isAlreadyEnglish("A"), false);
  assert.equal(isAlreadyEnglish("<UNK_SPAN>"), false);
  assert.equal(isAlreadyEnglish(""), false);
});

test("title page drops the English logo and boxes that repeat text already in a larger reading", () => {
  const regions: TranscriptRegion[] = [
    box("0", "<UNK_SPAN>", 0.799, 0, 0.13, 0.058),
    box("1", "1", 0.756, 0.226, 0.148, 0.171),
    box("2", "REGARDS", 0.67, 0.354, 0.1, 0.06, true),
    box("3", "MY", 0.644, 0.362, 0.044, 0.027, true),
    box("4", "GIVE", 0.613, 0.328, 0.062, 0.037, true),
    box("5", "", 0.343, 0.307, 0.037, 0.025),
    box("6", "JACK", 0.762, 0.448, 0.061, 0.041, true),
    box("7", "", 0.73, 0.416, 0.08, 0.048),
    box("8", "", 0.701, 0.413, 0.041, 0.025),
    box("9", "", 0.699, 0.411, 0.127, 0.081),
    box("10", "GIVE\nMY\nREGARDS\nTO\nBLA K\nJACK", 0.596, 0.324, 0.238, 0.172, true),
    box("11", "", 0.833, 0.519, 0.048, 0.02),
    box("12", "に", 0.493, 0.875, 0.136, 0.079),
    box("13", "クに", 0.489, 0.789, 0.142, 0.167),
    box("14", "", 0.485, 0.783, 0.284, 0.172),
    box("15", "よろしく", 0.347, 0.551, 0.138, 0.301),
    box("16", "", 0.221, 0.772, 0.113, 0.173),
    box("17", "完全版", 0.212, 0.557, 0.127, 0.219),
    box("18", "ブラックジャックによろしく完全版佐藤秀峰", 0.205, 0.543, 0.597, 0.423),
    box("19", "", 0.049, 0.549, 0.764, 0.056),
    box("20", "", 0.047, 0.793, 0.093, 0.085),
    box("21", "", 0.022, 0.791, 0.171, 0.175),
  ];
  const drop = dropRedundantTranscriptions(regions);
  assert.equal(drop.has("18"), false);
  assert.equal(drop.has("1"), false);
  for (const id of ["2", "3", "4", "6", "10", "12", "13", "15", "17"])
    assert.equal(drop.has(id), true, id);
  for (const id of ["7", "8", "9", "14", "16", "19"])
    assert.equal(drop.has(id), true, `blank ${id}`);
  assert.equal(drop.has("5"), false);
  assert.equal(drop.has("20"), false);
});

test("separate balloons stay when a larger box only repeats them", () => {
  const regions = [
    box("a", "待って", 0.1, 0.1, 0.2, 0.1),
    box("b", "行くぞ", 0.1, 0.22, 0.2, 0.1),
    box("c", "待って行くぞ", 0.08, 0.08, 0.26, 0.28),
  ];
  const drop = dropRedundantTranscriptions(regions);
  assert.deepEqual([...drop], ["c"]);
});

test("nested side lettering with different text stays", () => {
  const regions = [
    box("bubble", "待って", 0.1, 0.1, 0.4, 0.4),
    box("side", "行け", 0.12, 0.12, 0.05, 0.1),
  ];
  assert.equal(dropRedundantTranscriptions(regions).size, 0);
});

test("the same text in two overlapping boxes keeps the tighter box", () => {
  const regions = [
    box("loose", "待って", 0.1, 0.1, 0.4, 0.4),
    box("tight", "待って", 0.12, 0.12, 0.08, 0.12),
  ];
  const drop = dropRedundantTranscriptions(regions);
  assert.equal(drop.has("loose"), true);
  assert.equal(drop.has("tight"), false);
});

test("a fragment inside one reading is dropped", () => {
  const regions = [
    box("part", "に", 0.49, 0.87, 0.13, 0.08),
    box("column", "クに", 0.48, 0.78, 0.15, 0.18),
  ];
  const drop = dropRedundantTranscriptions(regions);
  assert.equal(drop.has("part"), true);
  assert.equal(drop.has("column"), false);
});

test("English regions are kept only when the chapter asks for them", () => {
  const regions = [
    box("word", "JACK", 0.76, 0.45, 0.06, 0.04, true),
    box("logo", "GIVE MY REGARDS TO BLACK JACK", 0.6, 0.32, 0.24, 0.17, true),
    box("title", "よろしく", 0.35, 0.55, 0.14, 0.3),
  ];
  const off = dropRedundantTranscriptions(regions);
  assert.equal(off.has("word"), true);
  assert.equal(off.has("logo"), true);
  assert.equal(off.has("title"), false);
  const on = dropRedundantTranscriptions(regions, { includeEnglish: true });
  assert.equal(on.has("logo"), false);
  assert.equal(on.has("word"), true);
  assert.equal(on.has("title"), false);
});
