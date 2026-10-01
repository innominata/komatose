export type KanaScript = "hiragana" | "katakana";

export type KanaKey = {
	glyph: string;
	romaji: string;
	empty?: boolean;
};

export type KanaMode = {
	script: KanaScript;
	diacritic: boolean;
	digraph: boolean;
};

type Cell = { hira: string; romaji: string };

const EMPTY: KanaKey = { glyph: "", romaji: "", empty: true };

const GOJUON: (Cell | null)[][] = [
	[
		{ hira: "あ", romaji: "a" },
		{ hira: "い", romaji: "i" },
		{ hira: "う", romaji: "u" },
		{ hira: "え", romaji: "e" },
		{ hira: "お", romaji: "o" },
	],
	[
		{ hira: "か", romaji: "ka" },
		{ hira: "き", romaji: "ki" },
		{ hira: "く", romaji: "ku" },
		{ hira: "け", romaji: "ke" },
		{ hira: "こ", romaji: "ko" },
	],
	[
		{ hira: "さ", romaji: "sa" },
		{ hira: "し", romaji: "shi" },
		{ hira: "す", romaji: "su" },
		{ hira: "せ", romaji: "se" },
		{ hira: "そ", romaji: "so" },
	],
	[
		{ hira: "た", romaji: "ta" },
		{ hira: "ち", romaji: "chi" },
		{ hira: "つ", romaji: "tsu" },
		{ hira: "て", romaji: "te" },
		{ hira: "と", romaji: "to" },
	],
	[
		{ hira: "な", romaji: "na" },
		{ hira: "に", romaji: "ni" },
		{ hira: "ぬ", romaji: "nu" },
		{ hira: "ね", romaji: "ne" },
		{ hira: "の", romaji: "no" },
	],
	[
		{ hira: "は", romaji: "ha" },
		{ hira: "ひ", romaji: "hi" },
		{ hira: "ふ", romaji: "fu" },
		{ hira: "へ", romaji: "he" },
		{ hira: "ほ", romaji: "ho" },
	],
	[
		{ hira: "ま", romaji: "ma" },
		{ hira: "み", romaji: "mi" },
		{ hira: "む", romaji: "mu" },
		{ hira: "め", romaji: "me" },
		{ hira: "も", romaji: "mo" },
	],
	[
		{ hira: "や", romaji: "ya" },
		null,
		{ hira: "ゆ", romaji: "yu" },
		null,
		{ hira: "よ", romaji: "yo" },
	],
	[
		{ hira: "ら", romaji: "ra" },
		{ hira: "り", romaji: "ri" },
		{ hira: "る", romaji: "ru" },
		{ hira: "れ", romaji: "re" },
		{ hira: "ろ", romaji: "ro" },
	],
	[
		{ hira: "わ", romaji: "wa" },
		null,
		null,
		null,
		{ hira: "を", romaji: "o" },
	],
];

const N: Cell = { hira: "ん", romaji: "n" };

const DAKUTEN: Record<string, Cell> = {
	う: { hira: "ゔ", romaji: "vu" },
	か: { hira: "が", romaji: "ga" },
	き: { hira: "ぎ", romaji: "gi" },
	く: { hira: "ぐ", romaji: "gu" },
	け: { hira: "げ", romaji: "ge" },
	こ: { hira: "ご", romaji: "go" },
	さ: { hira: "ざ", romaji: "za" },
	し: { hira: "じ", romaji: "ji" },
	す: { hira: "ず", romaji: "zu" },
	せ: { hira: "ぜ", romaji: "ze" },
	そ: { hira: "ぞ", romaji: "zo" },
	た: { hira: "だ", romaji: "da" },
	ち: { hira: "ぢ", romaji: "ji" },
	つ: { hira: "づ", romaji: "zu" },
	て: { hira: "で", romaji: "de" },
	と: { hira: "ど", romaji: "do" },
	は: { hira: "ば", romaji: "ba" },
	ひ: { hira: "び", romaji: "bi" },
	ふ: { hira: "ぶ", romaji: "bu" },
	へ: { hira: "べ", romaji: "be" },
	ほ: { hira: "ぼ", romaji: "bo" },
};

const HANDAKU_HA: Cell[] = [
	{ hira: "ぱ", romaji: "pa" },
	{ hira: "ぴ", romaji: "pi" },
	{ hira: "ぷ", romaji: "pu" },
	{ hira: "ぺ", romaji: "pe" },
	{ hira: "ぽ", romaji: "po" },
];

type YoonRow = {
	hira: [string, string, string];
	romaji: [string, string, string];
};

const YOON: YoonRow[] = [
	{ hira: ["きゃ", "きゅ", "きょ"], romaji: ["kya", "kyu", "kyo"] },
	{ hira: ["しゃ", "しゅ", "しょ"], romaji: ["sha", "shu", "sho"] },
	{ hira: ["ちゃ", "ちゅ", "ちょ"], romaji: ["cha", "chu", "cho"] },
	{ hira: ["にゃ", "にゅ", "にょ"], romaji: ["nya", "nyu", "nyo"] },
	{ hira: ["ひゃ", "ひゅ", "ひょ"], romaji: ["hya", "hyu", "hyo"] },
	{ hira: ["みゃ", "みゅ", "みょ"], romaji: ["mya", "myu", "myo"] },
	{ hira: ["りゃ", "りゅ", "りょ"], romaji: ["rya", "ryu", "ryo"] },
];

const YOON_VOICED: YoonRow[] = [
	{ hira: ["ぎゃ", "ぎゅ", "ぎょ"], romaji: ["gya", "gyu", "gyo"] },
	{ hira: ["じゃ", "じゅ", "じょ"], romaji: ["ja", "ju", "jo"] },
	{ hira: ["ぢゃ", "ぢゅ", "ぢょ"], romaji: ["dya", "dyu", "dyo"] },
	{ hira: ["びゃ", "びゅ", "びょ"], romaji: ["bya", "byu", "byo"] },
	{ hira: ["ぴゃ", "ぴゅ", "ぴょ"], romaji: ["pya", "pyu", "pyo"] },
];

export function hiraganaToKatakana(text: string) {
	return [...text]
		.map((ch) => {
			const code = ch.codePointAt(0) ?? 0;
			if (code >= 0x3041 && code <= 0x3096) return String.fromCodePoint(code + 0x60);
			return ch;
		})
		.join("");
}

function keyFor(cell: Cell, script: KanaScript): KanaKey {
	return {
		glyph: script === "katakana" ? hiraganaToKatakana(cell.hira) : cell.hira,
		romaji: cell.romaji,
	};
}

function voiced(cell: Cell): Cell {
	return DAKUTEN[cell.hira] ?? cell;
}

function yoonKeys(rows: YoonRow[], script: KanaScript): KanaKey[][] {
	return rows.map((row) =>
		row.hira.map((hira, i) => keyFor({ hira, romaji: row.romaji[i] }, script)),
	);
}

export function kanaGrid(mode: KanaMode): KanaKey[][] {
	if (mode.digraph) {
		return mode.diacritic
			? yoonKeys(YOON_VOICED, mode.script)
			: yoonKeys(YOON, mode.script);
	}
	const rows = GOJUON.map((row) =>
		row.map((cell) => {
			if (!cell) return EMPTY;
			return keyFor(mode.diacritic ? voiced(cell) : cell, mode.script);
		}),
	);
	if (mode.diacritic) rows.push(HANDAKU_HA.map((cell) => keyFor(cell, mode.script)));
	rows.push([keyFor(N, mode.script), EMPTY, EMPTY, EMPTY, EMPTY]);
	return rows;
}

export function extraKana(mode: Pick<KanaMode, "script">): KanaKey[] {
	return [keyFor({ hira: "っ", romaji: "small tsu" }, mode.script), { glyph: "ー", romaji: "-" }];
}

export function baseHiraganaGlyphs() {
	return [...GOJUON.flatMap((row) => row.filter((cell): cell is Cell => !!cell).map((cell) => cell.hira)), N.hira];
}

export function kanaGlyphs(mode: KanaMode) {
	return kanaGrid(mode)
		.flat()
		.filter((key) => !key.empty)
		.map((key) => key.glyph);
}

export function isKanaEntryLang(lang?: string | null) {
	return lang === "japanese";
}
