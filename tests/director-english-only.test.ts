import { test } from "node:test";
import assert from "node:assert/strict";

const { latinOrNumbersOnly } = await import("../src/lib/server/directorAutomation");

test("English and number-only lettering needs no translation", () => {
  for (const source of ["1", "V", "BLACK JACK", "GIVE MY REGARDS TO BLACK JACK", "１２０", "No. 3!"])
    assert.equal(latinOrNumbersOnly(source), true, source);
  for (const source of ["", "……", "勤務医は3人……", "ベッド数120", "OK!? ドン", "안녕"])
    assert.equal(latinOrNumbersOnly(source), false, source);
});
