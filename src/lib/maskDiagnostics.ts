import { maskRegion } from './maskRegions';
import type { LineRow } from './types';
import type { PageData, RegionData } from './workflow';

export function maskInputs(lines: LineRow[], region: (id: string) => { data: RegionData; revision: number }) {
  return lines.map((line, index) => {
    const doc = region(line.id);
    return { id: line.id, number: index + 1, revision: doc.revision, polygon: maskRegion(line, doc.data) };
  }).filter(row => row.polygon.length >= 3);
}

export function currentMaskDiagnostics(page: PageData, signature: string) {
  const diagnostics = page.maskDiagnostics;
  return diagnostics && diagnostics.mask === page.mask &&
    diagnostics.source === (page.cleanBase || page.prepared) &&
    diagnostics.regions === signature ? diagnostics : undefined;
}
