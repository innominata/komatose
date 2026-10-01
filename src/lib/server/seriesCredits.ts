import { eq } from "drizzle-orm";
import sharp from "sharp";
import {
	isCreditKind,
	parseSeriesCredits,
	serializeSeriesCredits,
	type SeriesCreditPage,
	type SeriesCredits,
} from "../credits";
import type { Series } from "../types";
import { db } from "./db";
import { series as seriesTable } from "./db/schema";
import { now } from "./ids";
import { sniffMime } from "./storage";
import { readAsset, storeAsset, WorkflowError } from "./workflowStore";

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export function seriesCreditsOf(series: Pick<Series, "credits">): SeriesCredits {
	return parseSeriesCredits(series.credits ?? {});
}

export async function saveSeriesCredit(
	seriesId: string,
	kind: unknown,
	originalName: string,
	bytes: Buffer,
	mimeHint?: string | null,
): Promise<SeriesCredits> {
	if (!isCreditKind(kind)) throw new WorkflowError("Choose pre or post credits");
	const mime = sniffMime(originalName, mimeHint);
	if (!ALLOWED.has(mime)) throw new WorkflowError("Unsupported image type");
	const png = await sharp(bytes).png().toBuffer();
	const meta = await sharp(png).metadata();
	const width = meta.width || 0;
	const height = meta.height || 0;
	if (width < 1 || height < 1) throw new WorkflowError("Credits image is empty");
	const hash = await storeAsset(png);
	const credit: SeriesCreditPage = {
		hash,
		filename: `${kind}-credits.png`,
		originalName: originalName || `${kind}-credits.png`,
		width,
		height,
	};
	return writeCredits(seriesId, (current) => ({ ...current, [kind]: credit }));
}

export async function clearSeriesCredit(seriesId: string, kind: unknown): Promise<SeriesCredits> {
	if (!isCreditKind(kind)) throw new WorkflowError("Choose pre or post credits");
	return writeCredits(seriesId, (current) => {
		const next = { ...current };
		delete next[kind];
		return next;
	});
}

export async function loadSeriesCreditBytes(series: Series, kind: unknown) {
	if (!isCreditKind(kind)) throw new WorkflowError("Choose pre or post credits", 404);
	const credit = seriesCreditsOf(series)[kind];
	if (!credit) throw new WorkflowError("No credits page saved for this series", 404);
	return { credit, bytes: await readAsset(credit.hash), kind };
}

async function writeCredits(seriesId: string, update: (current: SeriesCredits) => SeriesCredits) {
	const row = await db.select().from(seriesTable).where(eq(seriesTable.id, seriesId)).get();
	if (!row) throw new WorkflowError("Series not found", 404);
	const credits = update(parseSeriesCredits(row.credits));
	await db
		.update(seriesTable)
		.set({ credits: serializeSeriesCredits(credits), updatedAt: now() })
		.where(eq(seriesTable.id, seriesId));
	return credits;
}
