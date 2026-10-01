import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OcrLang, ReviewReport, TranslateEngine } from '../types';
import { reviewChapterWithCli } from './cliTranslate';
import { reviewChapterScript } from './llm';
import { formatChapterScript, loadChapterPack } from './proofread';
import { episodeDir } from './storage';
import { runChapterReview, type ChapterReviewHandlers } from './chapterReview';

/** The real chapter-review handlers — exported so model probes run the very same path. */
export const chapterReviewHandlers: ChapterReviewHandlers = {
	cli: reviewChapterWithCli,
	local: reviewChapterScript,
};

export function reviewPath(seriesSlug: string, episodeSlug: string): string {
	return join(episodeDir(seriesSlug, episodeSlug), 'review.json');
}

export async function readSavedReview(seriesSlug: string, episodeSlug: string): Promise<ReviewReport | null> {
	try {
		const raw = await readFile(reviewPath(seriesSlug, episodeSlug), 'utf8');
		const parsed = JSON.parse(raw) as ReviewReport;
		if (!parsed || typeof parsed.summary !== 'string') return null;
		return parsed;
	} catch {
		return null;
	}
}

export async function reviewChapter(opts: {
	seriesId: string;
	episodeId: string;
	engine: TranslateEngine;
	model?: string;
	lang?: OcrLang;
	abort?: AbortSignal;
	onProgress?: (message: string) => void;
}): Promise<ReviewReport> {
	const pack = await loadChapterPack(opts);
	if (!pack.items.length) throw new Error('No translations to review. Run AI translate first.');
	opts.onProgress?.(`Reviewing ${pack.items.length} lines…`);
	const payload = {
		seriesNotes: pack.seriesNotes,
		seriesGlossary: pack.seriesGlossary,
		prior: pack.prior,
		pages: pack.pages,
		script: `Complete chapter: ${pack.items.length} lines on ${pack.imgs.length} pages.\n\n${formatChapterScript(pack.items)}`,
		abort: opts.abort,
		lang: opts.lang,
		model: opts.model
	};
	const parsed = await runChapterReview(opts.engine, payload);
	const report: ReviewReport = {
		...parsed,
		engine: opts.engine,
		model: opts.model || '',
		createdAt: Date.now()
	};
	await writeFile(reviewPath(pack.series.slug, pack.episode.slug), JSON.stringify(report, null, 2), 'utf8');
	return report;
}
