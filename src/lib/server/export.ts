import type { Episode, ImageRow, Series } from '../types';

function fileSafe(name: string, fallback: string): string {
	return name.replace(/[/\\?%*:|"<>]/g, '').replace(/\s+/g, ' ').trim() || fallback;
}

export function chapterNumber(episode: Episode): string {
	return fileSafe(episode.title || episode.slug, episode.slug);
}

/** `1` — 1-based page in the chapter. */
export function imageStem(img: ImageRow): string {
	if (!img.pageNumber) throw new Error('Renumber pages before export');
	return String(img.pageNumber);
}

/** `Rascal does not dream of a siscon idol-10` */
export function exportZipBasename(series: Series, episode: Episode): string {
	return `${fileSafe(series.title || series.slug, series.slug)}-${chapterNumber(episode)}`;
}

export function attachmentFilename(name: string): string {
	const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

