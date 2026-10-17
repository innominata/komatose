import { sqlite } from './db';
import { WorkflowError } from './workflowStore';

const state = globalThis as typeof globalThis & {
  __seriesMaintenance?: Map<string, string>;
  __seriesWrites?: Map<string, number>;
};
const locks = state.__seriesMaintenance ??= new Map();
const writes = state.__seriesWrites ??= new Map();

export function seriesMaintenanceMessage(seriesId: string) {
  return locks.get(seriesId);
}

export function trackSeriesWrite(seriesId: string) {
  const locked = locks.get(seriesId);
  if (locked) throw new WorkflowError(locked, 409);
  writes.set(seriesId, (writes.get(seriesId) ?? 0) + 1);
  return () => {
    const remaining = (writes.get(seriesId) ?? 1) - 1;
    if (remaining) writes.set(seriesId, remaining);
    else writes.delete(seriesId);
  };
}

export function lockSeries(seriesId: string, operation: 'backup' | 'restore') {
  if (locks.has(seriesId) || writes.get(seriesId))
    throw new WorkflowError('The series is being edited. Wait for current changes to finish and try again.', 409);
  locks.set(seriesId, `Series ${operation} in progress. Try again when it finishes.`);
  return () => locks.delete(seriesId);
}

/** Resolve the series for routes that can read or change its saved files/data. */
export function requestSeriesId(path: string): string | undefined {
  const series = /^\/(?:api\/)?series\/([^/]+)/.exec(path);
  if (series) return decodeURIComponent(series[1]);
  const episode = /^\/api\/episodes\/([^/]+)/.exec(path);
  if (episode) return (sqlite.prepare('SELECT series_id FROM episodes WHERE id=?').get(decodeURIComponent(episode[1])) as { series_id: string } | undefined)?.series_id;
  const image = /^\/api\/images\/([^/]+)/.exec(path) ?? /^\/p\/[^/]+\/i\/([^/]+)/.exec(path);
  if (image) return (sqlite.prepare('SELECT e.series_id FROM images i JOIN episodes e ON e.id=i.episode_id WHERE i.id=?').get(decodeURIComponent(image[1])) as { series_id: string } | undefined)?.series_id;
}
