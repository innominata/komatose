import { test } from "node:test";
import assert from "node:assert/strict";
import { workCredit } from "../src/lib/workCredit";

const LINES = [
	"ブラックジャックによろしく",
	"佐藤秀峰",
	"Give My Regards to Black Jack",
	"SHUHO SATO",
];

test("official titles use Sato's required credit lines", () => {
	for (const title of [
		"ブラックジャックによろしく",
		"ブラックジャックによろしく 第1巻",
		"Give My Regards to Black Jack",
		"give my regards to black jack",
		"Say Hello to Black Jack",
	]) {
		const credit = workCredit(title);
		assert.ok(credit, title);
		assert.deepEqual([...credit.lines], LINES);
		assert.equal(credit.text, `${LINES.join("\n")}\n`);
	}
});

test("other series, including the sequel and Tezuka's Black Jack, are not credited as this work", () => {
	for (const title of [
		"",
		"Test series",
		"Black Jack",
		"新ブラックジャックによろしく",
		"新 ブラックジャックによろしく",
		"The New Give My Regards to Black Jack",
	]) {
		assert.equal(workCredit(title), null, title);
	}
});
