import { test } from "node:test";
import assert from "node:assert/strict";
import {
	baseHiraganaGlyphs,
	extraKana,
	hiraganaToKatakana,
	isKanaEntryLang,
	kanaGlyphs,
	kanaGrid,
} from "../src/lib/kanaChart";
import { glossaryKanjiTerms } from "../src/lib/glossary";

test("gojūon table is the 46 basic hiragana with Hepburn labels", () => {
	const glyphs = baseHiraganaGlyphs();
	assert.equal(glyphs.length, 46);
	assert.deepEqual(glyphs.slice(0, 5), ["あ", "い", "う", "え", "お"]);
	assert.ok(glyphs.includes("ん"));
	assert.ok(glyphs.includes("を"));
	assert.ok(glyphs.includes("も"));
	assert.ok(!glyphs.includes("が"));
	assert.ok(!glyphs.includes("キャ"));
	const keys = kanaGrid({ script: "hiragana", diacritic: false, digraph: false }).flat();
	assert.equal(keys.find((key) => key.glyph === "し")?.romaji, "shi");
	assert.equal(keys.find((key) => key.glyph === "ん")?.romaji, "n");
	assert.ok(keys.some((key) => key.empty));
});

test("diacritic and digraph modes cover dakuten, handakuten, and yōon", () => {
	const voiced = kanaGlyphs({ script: "hiragana", diacritic: true, digraph: false });
	for (const glyph of ["が", "じ", "だ", "ば", "ぱ", "ゔ"]) assert.ok(voiced.includes(glyph), glyph);
	assert.ok(!voiced.includes("か"));
	const yoon = kanaGlyphs({ script: "hiragana", diacritic: false, digraph: true });
	assert.deepEqual(
		yoon,
		["きゃ", "きゅ", "きょ", "しゃ", "しゅ", "しょ", "ちゃ", "ちゅ", "ちょ", "にゃ", "にゅ", "にょ", "ひゃ", "ひゅ", "ひょ", "みゃ", "みゅ", "みょ", "りゃ", "りゅ", "りょ"],
	);
	const both = kanaGlyphs({ script: "hiragana", diacritic: true, digraph: true });
	assert.ok(both.includes("ぎゃ"));
	assert.ok(both.includes("じゃ"));
	assert.ok(both.includes("ぴょ"));
	assert.ok(!both.includes("きゃ"));
});

test("katakana toggle maps the whole grid and extras", () => {
	assert.equal(hiraganaToKatakana("あいう"), "アイウ");
	assert.equal(hiraganaToKatakana("きゃ"), "キャ");
	const kata = kanaGlyphs({ script: "katakana", diacritic: false, digraph: false });
	assert.ok(kata.includes("ア"));
	assert.ok(kata.includes("ン"));
	assert.ok(!kata.includes("あ"));
	assert.deepEqual(
		extraKana({ script: "katakana" }).map((key) => key.glyph),
		["ッ", "ー"],
	);
	assert.equal(extraKana({ script: "hiragana" })[0].romaji, "small tsu");
});

test("kana entry is Japanese-only", () => {
	assert.equal(isKanaEntryLang("japanese"), true);
	assert.equal(isKanaEntryLang("korean"), false);
	assert.equal(isKanaEntryLang(""), false);
	assert.equal(isKanaEntryLang(undefined), false);
});

test("glossary kanji keys keep 太郎, drop kana and Latin, and prefer edited", () => {
	const terms = glossaryKanjiTerms([
		{ source: "太郎", translation: "Taro" },
		{ source: "太郎", translation: "Tarou", edited: true },
		{ source: "ドン", translation: "boom" },
		{ source: "hello", translation: "hello" },
		{ source: "待って", translation: "Wait" },
		{ source: "", translation: "empty" },
	]);
	assert.deepEqual(
		terms.map((term) => `${term.source}:${term.translation}:${term.edited ? "edited" : ""}`),
		["太郎:Tarou:edited", "待って:Wait:"],
	);
});
