import type { ImageRow, Series } from "./types";

export const CREDIT_KINDS = ["pre", "post"] as const;
export type CreditKind = (typeof CREDIT_KINDS)[number];

export const PAGE_ROLES = ["page", "pre-credits", "post-credits"] as const;
export type PageRole = (typeof PAGE_ROLES)[number];

export type SeriesCreditPage = {
	hash: string;
	filename: string;
	originalName: string;
	width: number;
	height: number;
};

export type SeriesCredits = {
	pre?: SeriesCreditPage;
	post?: SeriesCreditPage;
};

const HASH = /^[a-f0-9]{64}$/;

export function isCreditKind(value: unknown): value is CreditKind {
	return value === "pre" || value === "post";
}

export function isCreditsPage(img: { role?: string | null }): boolean {
	return img.role === "pre-credits" || img.role === "post-credits";
}

export function creditRole(kind: CreditKind): PageRole {
	return kind === "pre" ? "pre-credits" : "post-credits";
}

export function parsePageRole(value: unknown): PageRole {
	return value === "pre-credits" || value === "post-credits" ? value : "page";
}

function parseCreditPage(raw: unknown): SeriesCreditPage | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const row = raw as Record<string, unknown>;
	const hash = typeof row.hash === "string" ? row.hash : "";
	const width = Number(row.width);
	const height = Number(row.height);
	if (!HASH.test(hash) || !Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1)
		return undefined;
	return {
		hash,
		filename: typeof row.filename === "string" && row.filename ? row.filename : `${hash}.png`,
		originalName: typeof row.originalName === "string" && row.originalName ? row.originalName : "credits.png",
		width: Math.round(width),
		height: Math.round(height),
	};
}

export function parseSeriesCredits(raw: unknown): SeriesCredits {
	if (raw == null || raw === "") return {};
	let value: unknown = raw;
	if (typeof raw === "string") {
		try {
			value = JSON.parse(raw);
		} catch {
			return {};
		}
	}
	if (!value || typeof value !== "object") return {};
	const row = value as Record<string, unknown>;
	const credits: SeriesCredits = {};
	const pre = parseCreditPage(row.pre);
	const post = parseCreditPage(row.post);
	if (pre) credits.pre = pre;
	if (post) credits.post = post;
	return credits;
}

export function serializeSeriesCredits(credits: SeriesCredits): string {
	const out: SeriesCredits = {};
	if (credits.pre) out.pre = credits.pre;
	if (credits.post) out.post = credits.post;
	return JSON.stringify(out);
}

export function storyPages<T extends { role?: string | null }>(imgs: T[]): T[] {
	return imgs.filter((img) => !isCreditsPage(img));
}

/** Id of the stand-in page for a series credits image that a chapter has not added itself. */
export function seriesCreditImageId(kind: CreditKind, episodeId: string) {
	return `series-credit:${kind}:${episodeId}`;
}

export function parseSeriesCreditImageId(id: string): { kind: CreditKind; episodeId: string } | null {
	const [prefix, kind, ...rest] = id.split(":");
	if (prefix !== "series-credit" || !isCreditKind(kind) || !rest.length) return null;
	return { kind, episodeId: rest.join(":") };
}

/**
 * Chapter pages with the series' default credits added at either end, as the finished export
 * does, unless the chapter already has its own credits page of that kind. Like the export, the
 * added credits are sized to the widest story page.
 */
export function withSeriesCreditImages(
	pages: ImageRow[],
	series: Pick<Series, "credits" | "createdAt" | "updatedAt">,
	episodeId: string,
): ImageRow[] {
	const out = [...pages];
	const storyWidth = Math.max(0, ...pages.filter((page) => page.role === "page").map((page) => page.width));
	for (const kind of CREDIT_KINDS) {
		const credit = series.credits[kind];
		if (!credit || pages.some((page) => page.role === creditRole(kind))) continue;
		const image: ImageRow = {
			id: seriesCreditImageId(kind, episodeId),
			episodeId,
			filename: credit.filename,
			originalName: credit.originalName,
			width: storyWidth || credit.width,
			height: storyWidth ? Math.round((credit.height * storyWidth) / credit.width) : credit.height,
			sortOrder: kind === "pre" ? -1 : pages.length,
			pageNumber: null,
			dpi: 72,
			caption: "",
			role: creditRole(kind),
			createdAt: series.createdAt,
			updatedAt: series.updatedAt,
		};
		if (kind === "pre") out.unshift(image);
		else out.push(image);
	}
	return out;
}
