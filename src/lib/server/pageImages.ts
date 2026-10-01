import { and, asc, eq } from 'drizzle-orm';
import sharp from 'sharp';
import type { Episode, Series } from '../types';
import type { PageData, RegionData } from '../workflow';
import { db, sqlite } from './db';
import { images, lines } from './db/schema';
import { renderPage, type ExportPage } from './finishedExport';
import { toImage, toLine } from './queries';
import { readWorkingOrOrig } from './storage';
import { effectiveDpi, preferences } from './workflowService';
import { getDoc, readAsset, WorkflowError } from './workflowStore';

/** Capture the saved page and layouts together. No auto-fit or export approval is required. */
export async function capturePageImages(series: Series, episode: Episode, imageId: string, typeset = true) {
  const page = sqlite.transaction((): ExportPage => {
    const row = db.select().from(images).where(and(eq(images.id, imageId), eq(images.episodeId, episode.id))).get();
    if (!row) throw new WorkflowError('Page not found', 404);
    const image = toImage(row);
    const doc = getDoc<PageData>(`page:${image.id}`, {});
    const source = doc.data.preparedAt === image.updatedAt ? doc.data : {};
    return { image, source, sourceRevision: doc.revision,
      dpi: effectiveDpi(source, image, preferences(episode.id, series.id)),
      regions: db.select().from(lines).where(and(eq(lines.episodeId, episode.id), eq(lines.imageId, imageId)))
        .orderBy(asc(lines.sortOrder)).all().map(row => {
          const line = toLine(row);
          const region = getDoc<RegionData>(`region:${line.id}`, {});
          return { line, data: region.data, revision: region.revision };
        }),
    };
  })();
  const source = page.source.prepared
    ? await readAsset(page.source.prepared)
    : await readWorkingOrOrig(series.slug, episode.slug, page.image.filename);
  if (!source) throw new WorkflowError('Missing page image', 404);
  const raw = await sharp(source).png().toBuffer();
  const working = typeset ? (await renderPage(page, {
    includeOverflow: true,
    ...(!page.source.prepared ? { base: raw } : {}),
  })).composite : undefined;
  const current = db.select().from(images).where(eq(images.id, imageId)).get();
  if (!current || current.updatedAt !== page.image.updatedAt)
    throw new WorkflowError('Page changed while capturing images. Try again.', 409);
  return { raw, typeset: working, page, capturedAt: Date.now() };
}
