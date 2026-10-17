import { AsyncLocalStorage } from 'node:async_hooks';
import { sqlite } from './db';
import { broadcast } from './realtime';
import { storeAsset } from './workflowStore';

export type DirectorContext = { runId: string; episodeId: string; imageId?: string };
const context = new AsyncLocalStorage<DirectorContext>();
const runtime = globalThis as typeof globalThis & { __directorRecovered?: boolean };
if (!runtime.__directorRecovered) {
  sqlite.prepare("UPDATE director_runs SET state=CASE WHEN state='pausing' THEN 'paused' WHEN state='stopping' THEN 'cancelled' WHEN version>=2 THEN 'recovering' ELSE 'interrupted' END,message='Server restarted; recovering saved progress.',updated_at=? WHERE state IN ('running','pausing','stopping')").run(Date.now());
  sqlite.prepare("UPDATE director_pages SET state='unresolved',detail='Director was interrupted',updated_at=? WHERE state='working'").run(Date.now());
  runtime.__directorRecovered = true;
}

export function withDirector<T>(ctx: DirectorContext, fn: () => T): T { return context.run(ctx, fn); }
export function directorContext(): DirectorContext | undefined { return context.getStore(); }
export function directorLocked(episodeId: string): boolean {
  return !!sqlite.prepare("SELECT 1 FROM director_runs WHERE episode_id=? AND state IN ('running','recovering','pausing','stopping') LIMIT 1").get(episodeId);
}

export function directorEvent(runId: string, episodeId: string, imageId: string | null, kind: string, detail: unknown): number {
  const result = sqlite.prepare('INSERT INTO director_events(run_id,episode_id,image_id,kind,detail,created_at) VALUES(?,?,?,?,?,?)')
    .run(runId, episodeId, imageId, kind, JSON.stringify(detail), Date.now());
  const id = Number(result.lastInsertRowid);
  broadcast(episodeId, { type: 'director:changed', runId, eventId: id });
  return id;
}

export function directorJobLog(entry: { step?: string; imageId?: string; engine?: string; model?: string;
  request: string; response?: string; error?: string; usage?: unknown }): void {
  const ctx = directorContext();
  if (!ctx) return;
  directorEvent(ctx.runId, ctx.episodeId, entry.imageId || ctx.imageId || null, 'model', entry);
}

export function directorAsset(runId: string, hash: string): void {
  sqlite.prepare('INSERT OR IGNORE INTO director_assets(run_id,hash) VALUES(?,?)').run(runId, hash);
}

/** Keep the actual submitted image bytes alongside every app-visible model call. */
export async function directorTraceValue(value: unknown, runId: string): Promise<unknown> {
  if (Buffer.isBuffer(value)) {
    const hash=await storeAsset(value);
    directorAsset(runId,hash);
    return {imageAsset:hash,bytes:value.length};
  }
  if (Array.isArray(value)) return Promise.all(value.map(item=>directorTraceValue(item,runId)));
  if (value instanceof Map) return Promise.all([...value.entries()].map(async ([key,item])=>[key,await directorTraceValue(item,runId)]));
  if (value && typeof value==='object') {
    const entries=await Promise.all(Object.entries(value).map(async ([key,item])=>[key,await directorTraceValue(item,runId)]));
    return Object.fromEntries(entries);
  }
  return value;
}
