import {
  GOLD_PAGES, GOLD_SERIES, GOLD_SERIES_NOTES, GOLD_GLOSSARY,
  type GoldPage,
} from './benchmarkGold';
import koreanPages from '../../fixtures/manhwa-pages/gold.json';

export type BenchmarkDataset = {
  id: string;
  version: number;
  label: string;
  series: string;
  lang: 'japanese' | 'korean';
  direction: 'rtl' | 'ltr';
  referenceLabel: 'official' | 'reference';
  fixtureDir: string;
  seriesNotes: string;
  glossary: string;
  pages: GoldPage[];
};

export const BENCHMARK_DATASETS: BenchmarkDataset[] = [
  {
    id: 'manga-ja', version: 1, label: 'Japanese · Manga', series: GOLD_SERIES,
    lang: 'japanese', direction: 'rtl', referenceLabel: 'official',
    fixtureDir: 'fixtures/test-pages', seriesNotes: GOLD_SERIES_NOTES,
    glossary: GOLD_GLOSSARY, pages: GOLD_PAGES,
  },
  {
    id: 'manhwa-ko', version: 1, label: 'Korean · Manhwa', series: 'ManhwaFixture',
    lang: 'korean', direction: 'ltr', referenceLabel: 'reference',
    fixtureDir: 'fixtures/manhwa-pages',
    seriesNotes: 'Synthetic Korean school-life comic scenes. Each page is a self-contained scene; do not assume a continuous plot between pages.',
    glossary: '', pages: koreanPages as GoldPage[],
  },
];

export function benchmarkDataset(id = 'manga-ja'): BenchmarkDataset {
  const dataset = BENCHMARK_DATASETS.find(item => item.id === id);
  if (!dataset) throw Object.assign(new Error(`Unknown benchmark dataset ${id}`), { status: 400 });
  return dataset;
}
