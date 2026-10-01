import { test } from "node:test";
import assert from "node:assert/strict";
import { romanizeKorean } from "../src/lib/romanizeKorean";
import { displayRomanization, needsRomanization, scriptRuns } from "../src/lib/romanizeText";
import { romanizePhrase, romanizePhrases } from "../src/lib/server/romanize";

test("Korean Revised Romanization covers common lettering and liaison", () => {
  assert.equal(romanizeKorean("안녕"), "annyeong");
  assert.equal(romanizeKorean("안녕하세요"), "annyeonghaseyo");
  assert.equal(romanizeKorean("한글"), "hangeul");
  assert.equal(romanizeKorean("한국어"), "hangugeo");
  assert.equal(romanizeKorean("먹어요"), "meogeoyo");
  assert.equal(romanizeKorean("웹툰!"), "weptun!");
});

test("script detection ignores English and splits mixed phrases", () => {
  assert.equal(needsRomanization(""), false);
  assert.equal(needsRomanization("Hello!"), false);
  assert.equal(needsRomanization("待って"), true);
  assert.equal(needsRomanization("안녕"), true);
  assert.deepEqual(
    scriptRuns("「待って」안녕"),
    [
      { script: "other", text: "「" },
      { script: "jp", text: "待って" },
      { script: "other", text: "」" },
      { script: "ko", text: "안녕" },
    ],
  );
  assert.equal(displayRomanization("안녕", "annyeong"), "annyeong");
  assert.equal(displayRomanization("hello", "hello"), "");
});

test("Japanese kanji and kana convert to Hepburn romaji", async () => {
  assert.equal(await romanizePhrase("待って——！"), "matte——！");
  assert.match(await romanizePhrase("こんにちは"), /konnichiwa/i);
  assert.equal(await romanizePhrase("Hello"), "");
  assert.equal(await romanizePhrase("안녕"), "annyeong");
  assert.deepEqual(await romanizePhrases(["待って", "안녕", "待って"]), ["matte", "annyeong", "matte"]);
});
