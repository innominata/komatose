export const EXPORT_DOCUMENTS = [
  { id: 'bilingual.txt', label: 'Bilingual script', mime: 'text/plain' },
  { id: 'english.txt', label: 'English script', mime: 'text/plain' },
  { id: 'chapter.json', label: 'Chapter JSON', mime: 'application/json' },
  { id: 'font-manifest.json', label: 'Font manifest', mime: 'application/json' },
  { id: 'DRAFT.txt', label: 'Draft / readiness notes', mime: 'text/plain' },
  { id: 'attribution.txt', label: 'Attribution', mime: 'text/plain' },
] as const;

export type ExportDocumentId = (typeof EXPORT_DOCUMENTS)[number]['id'];
export type ExportDocument = { filename: string; mime: string; text: string };
