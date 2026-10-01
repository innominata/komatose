import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { workCredit } from '../workCredit';
import { grantSeriesMembership } from './access';
import { logActivity } from './activity';
import { db } from './db';
import { episodes, images, series } from './db/schema';
import { episodeSlugify, nid, now, slugify } from './ids';
import { listImages, toEpisode, toImage, toSeries, uniqueSlug } from './queries';
import { saveImageFile } from './storage';
import { ensurePageThumbnail } from './workflowService';

export const TEST_PAGES_TITLE = 'Give My Regards to Black Jack';
export const TEST_PAGES_CHAPTER = '1';

export function testPagesDir(): string {
	return join(process.cwd(), 'fixtures/test-pages');
}

export async function listTestPageNames(): Promise<string[]> {
	const names = (await readdir(testPagesDir())).filter((name) => /\.jpe?g$/i.test(name)).sort();
	if (!names.length) throw new Error('No test pages found in fixtures/test-pages');
	return names;
}

export async function addTestPages(userId: string): Promise<{
	seriesId: string;
	episodeId: string;
	title: string;
	added: number;
}> {
	const names = await listTestPageNames();
	const dir = testPagesDir();
	let row = await db.select().from(series).where(eq(series.title, TEST_PAGES_TITLE)).get();
	if (!row) {
		const id = nid();
		const t = now();
		const credit = workCredit(TEST_PAGES_TITLE);
		await db.insert(series).values({
			id,
			slug: await uniqueSlug('series', slugify(TEST_PAGES_TITLE)),
			title: TEST_PAGES_TITLE,
			notes: credit ? `${credit.text}\nVolume 1, pages 1–10, for testing.` : '',
			glossary: '[]',
			createdBy: userId,
			createdAt: t,
			updatedAt: t
		});
		row = await db.select().from(series).where(eq(series.id, id)).get();
		await logActivity({
			seriesId: id,
			userId,
			action: 'created_series',
			payload: { title: TEST_PAGES_TITLE, source: 'test-pages' }
		});
	}
	if (!row) throw new Error('Could not create the test series');
	await grantSeriesMembership(row.id, userId);
	const s = toSeries(row);

	const chapters = await db.select().from(episodes).where(eq(episodes.seriesId, s.id));
	let chapter = chapters.find((ep) => ep.title === TEST_PAGES_CHAPTER);
	if (!chapter) {
		const id = nid();
		const t = now();
		await db.insert(episodes).values({
			id,
			seriesId: s.id,
			slug: await uniqueSlug('episode', episodeSlugify(TEST_PAGES_CHAPTER), s.id),
			title: TEST_PAGES_CHAPTER,
			sortOrder: chapters.length,
			status: 'raws',
			glossary: '[]',
			createdAt: t,
			updatedAt: t
		});
		chapter = await db.select().from(episodes).where(eq(episodes.id, id)).get();
		await logActivity({
			seriesId: s.id,
			episodeId: id,
			userId,
			action: 'created_episode',
			payload: { title: TEST_PAGES_CHAPTER, source: 'test-pages' }
		});
	}
	if (!chapter) throw new Error('Could not create the test chapter');
	const episode = toEpisode(chapter);
	const current = await listImages(episode.id);
	const have = new Set(current.map((img) => img.originalName));
	let sort = current.reduce((max, img) => Math.max(max, img.sortOrder), -1) + 1;
	let added = 0;
	for (const name of names) {
		if (have.has(name)) continue;
		const bytes = await readFile(join(dir, name));
		const saved = await saveImageFile({
			seriesSlug: s.slug,
			episodeSlug: episode.slug,
			sortOrder: sort,
			originalName: name,
			bytes,
			mime: 'image/jpeg'
		});
		const image = {
			id: nid(),
			episodeId: episode.id,
			filename: saved.filename,
			originalName: basename(name),
			sortOrder: sort,
			width: saved.width,
			height: saved.height,
			dpi: saved.dpi,
			caption: '',
			role: 'page',
			createdAt: now(),
			updatedAt: now()
		};
		await db.insert(images).values(image);
		await ensurePageThumbnail(s, episode, toImage(image));
		sort += 1;
		added += 1;
	}
	if (added) {
		await logActivity({
			seriesId: s.id,
			episodeId: episode.id,
			userId,
			action: 'uploaded_images',
			payload: { count: added, source: 'test-pages' }
		});
	}
	return { seriesId: s.id, episodeId: episode.id, title: s.title, added };
}
