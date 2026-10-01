export type WorkCredit = {
	id: "black-jack";
	lines: readonly [string, string, string, string];
	text: string;
};

const LINES = [
	"ブラックジャックによろしく",
	"佐藤秀峰",
	"Give My Regards to Black Jack",
	"SHUHO SATO",
] as const;

/**
 * Sato Manga Works requires these title and author strings, unaltered, on
 * every copy of this series. The sequel is a different work and is excluded.
 * https://densho810.com/free/
 */
export function workCredit(title: string): WorkCredit | null {
	const text = title.normalize("NFKC").replace(/\s+/g, " ").trim();
	if (!text || isSequel(text)) return null;
	const japanese = text.includes("ブラックジャックによろしく");
	const english = /give my regards\s*to black jack/i.test(text) || /say hello to black jack/i.test(text);
	if (!japanese && !english) return null;
	return { id: "black-jack", lines: LINES, text: `${LINES.join("\n")}\n` };
}

function isSequel(title: string): boolean {
	if (title.replace(/\s+/g, "").includes("新ブラックジャックによろしく")) return true;
	return /\bnew\b/i.test(title) && /black jack/i.test(title);
}
