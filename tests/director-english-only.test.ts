import { test } from "node:test";
import assert from "node:assert/strict";

const { latinOrNumbersOnly } = await import("../src/lib/server/directorAutomation");
const { punctuationOnlyText } = await import("../src/lib/workflow");

test("English and number-only lettering needs no translation", () => {
  for (const source of ["1", "V", "BLACK JACK", "GIVE MY REGARDS TO BLACK JACK", "１２０", "No. 3!"])
    assert.equal(latinOrNumbersOnly(source), true, source);
  for (const source of ["", "……", "勤務医は3人……", "ベッド数120", "OK!? ドン", "안녕"])
    assert.equal(latinOrNumbersOnly(source), false, source);
});

test("punctuation-only lettering is told apart from text that has punctuation", () => {
  for (const source of ["?", "!!", "!?", "……", "...", "？！", " ! ", "♡", "~?"])
    assert.equal(punctuationOnlyText(source), true, source);
  for (const source of ["", "  ", "1", "A!", "어?", "えっ!?", "No. 3!"])
    assert.equal(punctuationOnlyText(source), false, source);
});
