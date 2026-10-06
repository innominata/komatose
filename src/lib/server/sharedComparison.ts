import { randomBytes } from 'node:crypto';
import type { Episode, ImageRow, LineRow, Series } from '../types';
import { regionComparison } from './regionCompare';
import { getDoc, putDoc, readAsset, storeAsset, WorkflowError } from './workflowStore';

type SharedComparison = { apng: string; gif: string };

/** Persist only the rendered comparison animations behind an unguessable public link. */
export async function shareRegionComparison(series: Series, episode: Episode, line: LineRow, page: ImageRow | undefined, exampleTokens: string[] = []) {
  const [apng, gif] = await Promise.all([
    regionComparison(series, episode, line, page, 'apng', undefined, exampleTokens),
    regionComparison(series, episode, line, page, 'gif', undefined, exampleTokens),
  ]);
  const [apngHash, gifHash] = await Promise.all([storeAsset(apng.body), storeAsset(gif.body)]);
  const token = randomBytes(24).toString('hex');
  putDoc<SharedComparison>(episode.id, `shared-comparison:${token}`, { apng: apngHash, gif: gifHash }, 0);
  return { apngSrc: `/p/comparisons/${token}/apng`, gifSrc: `/p/comparisons/${token}/gif` };
}

export async function sharedComparisonResponse(token: string, format: string) {
  if (!/^[a-f0-9]{48}$/.test(token) || !['apng', 'gif'].includes(format))
    throw new WorkflowError('Not found', 404);
  const data = getDoc<Partial<SharedComparison>>(`shared-comparison:${token}`, {}).data;
  const hash = data[format as keyof SharedComparison];
  if (!hash) throw new WorkflowError('Not found', 404);
  const bytes = await readAsset(hash);
  return new Response(new Uint8Array(bytes), { headers: {
    'content-type': format === 'gif' ? 'image/gif' : 'image/apng',
    'content-length': String(bytes.length),
    'content-disposition': `inline; filename="raw-vs-clean.${format === 'gif' ? 'gif' : 'png'}"`,
    'cache-control': 'public, max-age=31536000, immutable',
    'x-robots-tag': 'noindex',
    'x-content-type-options': 'nosniff',
  } });
}
