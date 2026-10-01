import type { RegionData, WorkflowDoc } from './workflow';

/** The studio indexes regions by line ID; stored documents use region:<id>. */
export function mergeRegionDoc(
  regions: Record<string, WorkflowDoc<RegionData>>,
  doc: WorkflowDoc<RegionData>,
): Record<string, WorkflowDoc<RegionData>> {
  if (!doc.id.startsWith('region:')) return regions;
  const id = doc.id.slice(7);
  if (!id || (regions[id] && regions[id].revision >= doc.revision)) return regions;
  return { ...regions, [id]: doc };
}
