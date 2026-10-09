import { EXPORT_DOCUMENTS, type ExportDocument, type ExportDocumentId } from '../exportDocuments';
import { activeRegionKinds, regionKindLabel } from '../regionCatalog';
import type { LineRow } from '../types';
import { workCredit } from '../workCredit';
import { characterLabel, resolveCharacter } from '../characters';
import type { FittedLayout, Preferences, WorkflowDoc } from '../workflow';
import type { ExportSnapshot } from './finishedExport';

function savedDefaults(snapshot: ExportSnapshot): Partial<Preferences> {
  const series = snapshot.defaults.series as WorkflowDoc<Partial<Preferences>>;
  const chapter = snapshot.defaults.chapter as WorkflowDoc<Partial<Preferences>>;
  return { ...series?.data, ...chapter?.data, regionKinds: series?.data?.regionKinds };
}

export function chapterScript(snapshot: ExportSnapshot, bilingual: boolean, includeSceneNotes = true): string {
  const prefs = savedDefaults(snapshot);
  const kinds = activeRegionKinds(prefs.regionKinds);
  const output = [`Series: ${snapshot.series.title}`, `Chapter: ${snapshot.episode.title} [${snapshot.episode.id}]`];
  if (includeSceneNotes && prefs.chapterSummary?.trim()) output.push(`\nChapter scene summary:\n${prefs.chapterSummary.trim()}`);
  const speakers = new Map([...Object.entries(snapshot.speakers ?? {}), ...snapshot.pages.flatMap(page => page.regions.map(region => [region.line.id, region.data.speaker] as const))]);
  const render = (line: LineRow, index: number) => {
    const state = line.sourceState === 'ignored' ? `ignored: ${line.ignoreReason || 'no reason saved'}` : line.status;
    const type = `${regionKindLabel(line.lineType, kinds)} [${line.lineType}]`;
    return [
      `Region ${index + 1} · ${type} · ${state} · ID: ${line.id}`,
      `Speaker: ${characterLabel(resolveCharacter(speakers.get(line.id), snapshot.series.glossary))}`,
      ...(bilingual ? [`Original:\n${line.source?.trim() ? line.source : '[unreadable]'}`] : []),
      `English:\n${line.body?.trim() ? line.body : '[not translated]'}`,
    ].join('\n');
  };
  const included = new Set<string>();
  for (const [index, page] of snapshot.pages.entries()) {
    const number = page.image.pageNumber ?? `${index + 1} (unnumbered)`;
    output.push(`\n--- Page ${number} ---`);
    if (includeSceneNotes) output.push(`Scene notes:\n${page.image.caption?.trim() || '[none saved]'}`);
    const lines = [...page.regions].sort((a, b) => a.line.sortOrder - b.line.sortOrder || a.line.id.localeCompare(b.line.id));
    for (const [i, region] of lines.entries()) {
      included.add(region.line.id);
      output.push(render(region.line, i));
    }
    if (!lines.length) output.push('[No regions]');
  }
  const unplaced = snapshot.lines.filter(line => !included.has(line.id))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  if (unplaced.length) {
    output.push('\n--- Unplaced / no page ---');
    output.push(...unplaced.map(render));
  }
  return `${output.join('\n\n')}\n`;
}

export function exportFontManifest(snapshots: ExportSnapshot[]) {
  const fonts = new Map<string, FittedLayout['font']>();
  for (const snapshot of snapshots) for (const page of snapshot.pages) for (const region of page.regions)
    if (region.data.layout) fonts.set(region.data.layout.font.id, region.data.layout.font);
  return {
    fonts: [...fonts.values()],
    note: 'Install these exact font versions to edit without substitution. Raster appearance is embedded. Target-editor reflow must be checked.',
  };
}

/** Shared by the direct viewer/download and ZIP exports. No image rendering. */
export function exportDocument(snapshots: ExportSnapshot[], id: ExportDocumentId, includeSceneNotes = true): ExportDocument {
  const definition = EXPORT_DOCUMENTS.find(file => file.id === id)!;
  let text: string;
  let filename: string = id;
  if (id === 'bilingual.txt' || id === 'english.txt') {
    text = snapshots.map(snapshot => chapterScript(snapshot, id === 'bilingual.txt', includeSceneNotes)).join('\n\n========== NEXT CHAPTER ==========\n\n');
  } else if (id === 'chapter.json') {
    text = JSON.stringify(snapshots.length === 1 ? snapshots[0] : { chapters: snapshots }, null, 2);
    if (snapshots.length !== 1) filename = 'chapters.json';
  } else if (id === 'font-manifest.json') {
    text = JSON.stringify(exportFontManifest(snapshots), null, 2);
  } else if (id === 'DRAFT.txt') {
    text = snapshots.map(snapshot => `Chapter: ${snapshot.episode.title} [${snapshot.episode.id}]\nDraft export from revision ${snapshot.revision}.\n${JSON.stringify(snapshot.issues, null, 2)}`).join('\n\n');
  } else {
    text = [...new Set(snapshots.map(snapshot => workCredit(snapshot.series.title)?.text).filter(Boolean))].join('\n');
  }
  return { filename, mime: definition.mime, text };
}
