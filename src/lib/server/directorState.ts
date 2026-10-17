import { createHash } from 'node:crypto';
import { sqlite } from './db';
import { directorEvent } from './directorAudit';
import { broadcast, withDeferredBroadcasts } from './realtime';
import { getDoc, putDoc, WorkflowError } from './workflowStore';
import { pageStepStamp, type PageData } from '../workflow';

type Row = Record<string, any>;
type Doc = { id: string; data: string; revision: number };
export type PageSnapshot = { image: Row; episodeStatus: string; lines: Row[]; docs: Doc[]; suggestions: Row[] };

const lineFields = ['image_id', 'source', 'body', 'line_type', 'source_state', 'ignore_reason',
  'ocr_confidence', 'status', 'sort_order', 'placed', 'invert', 'x', 'y', 'w', 'h',
  'sidebar_x', 'sidebar_y', 'sidebar_w', 'sidebar_h'] as const;
const lineValues = (row: Row) => Object.fromEntries(lineFields.map(key => [key, row[key] ?? null]));

export function storyImages(episodeId: string): Row[] {
  return sqlite.prepare("SELECT * FROM images WHERE episode_id=? AND role NOT IN ('pre-credits','post-credits') ORDER BY sort_order,created_at,id")
    .all(episodeId) as Row[];
}

export function cleanComplete(episodeId: string, imageId: string): boolean {
  const image = sqlite.prepare("SELECT id FROM images WHERE episode_id=? AND id=? AND role NOT IN ('pre-credits','post-credits')")
    .get(episodeId, imageId);
  if (!image) return false;
  const page = getDoc<PageData>(`page:${imageId}`, {}).data;
  return page.cleanApproved === true && page.completed?.clean === pageStepStamp('clean', page, [], [], []);
}

export function cleanBlockers(episodeId: string, imageId?: string): string[] {
  return storyImages(episodeId).filter(image => (!imageId || image.id === imageId) && !cleanComplete(episodeId, image.id))
    .map(image => image.id as string);
}

export function snapshotPage(episodeId: string, imageId: string): PageSnapshot {
  const image = sqlite.prepare('SELECT * FROM images WHERE episode_id=? AND id=?').get(episodeId, imageId) as Row | undefined;
  if (!image) throw new WorkflowError('Page not found', 404);
  const episodeStatus=(sqlite.prepare('SELECT status FROM episodes WHERE id=?').get(episodeId) as {status:string}).status;
  const lines = sqlite.prepare('SELECT * FROM lines WHERE episode_id=? AND image_id=? ORDER BY id').all(episodeId, imageId) as Row[];
  const docIds = [`page:${imageId}`, ...lines.map(line => `region:${line.id}`)];
  const docs = docIds.map(id => sqlite.prepare('SELECT id,data,revision FROM workflow_docs WHERE id=? AND episode_id=?')
    .get(id, episodeId) as Doc | undefined).filter((doc): doc is Doc => !!doc);
  const suggestions = lines.flatMap(line => sqlite.prepare('SELECT * FROM suggestions WHERE line_id=? ORDER BY id').all(line.id) as Row[]);
  return { image, episodeStatus, lines, docs, suggestions };
}

function comparable(snapshot: PageSnapshot) {
  return {
    episodeStatus: snapshot.episodeStatus,
    image: { page_number: snapshot.image.page_number, caption: snapshot.image.caption },
    lines: snapshot.lines.map(line => ({ id: line.id, ...lineValues(line) })),
    docs: snapshot.docs.map(doc => ({ id: doc.id, data: JSON.parse(doc.data) })),
    suggestions: snapshot.suggestions.map(row => ({ id: row.id, state: row.state, body: row.body,
      reason: row.reason, translation: row.translation, kind: row.kind })),
  };
}

export function pageFingerprint(episodeId: string, imageId: string): string {
  const snap = snapshotPage(episodeId, imageId);
  const content = { image: { filename:snap.image.filename, updatedAt:snap.image.updated_at, caption:snap.image.caption, pageNumber:snap.image.page_number },
    lines:snap.lines.map(line => { const {status:_status,...data}=lineValues(line); return {id:line.id,...data}; }),
    docs:snap.docs.map(doc => {
      const {completed:_done,cleanApproved:_clean,maskApproved:_mask,geometryApproved:_geometry,thumbnail:_thumb,thumbnailAt:_thumbAt,...data}=JSON.parse(doc.data);
      return {id:doc.id,data};
    }) };
  // Machine evidence is independent of human approval and completion.
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/** Journal before asynchronous work so a crash after saving content remains undoable. */
export async function auditedDirectorOperation<T>(runId:string,episodeId:string,imageId:string,label:string,fn:()=>Promise<T>|T):Promise<T> {
  const before=snapshotPage(episodeId,imageId);
  const id=Number(sqlite.prepare('INSERT INTO director_operations(run_id,episode_id,image_id,label,before_json) VALUES(?,?,?,?,?)')
    .run(runId,episodeId,imageId,label,JSON.stringify(before)).lastInsertRowid);
  try { return await fn(); }
  finally { finishDirectorOperation(id); }
}
function finishDirectorOperation(id:number) {
  sqlite.transaction(()=>{
    const row=sqlite.prepare('SELECT * FROM director_operations WHERE id=? AND finished=0').get(id) as any;
    if (!row) return;
    recordPageChange(row.run_id,row.episode_id,row.image_id,row.label,JSON.parse(row.before_json),snapshotPage(row.episode_id,row.image_id));
    sqlite.prepare('UPDATE director_operations SET finished=1 WHERE id=?').run(id);
  })();
}
export function recoverDirectorOperations(runId:string) {
  const rows=sqlite.prepare('SELECT id FROM director_operations WHERE run_id=? AND finished=0 ORDER BY id').all(runId) as {id:number}[];
  for (const row of rows) finishDirectorOperation(row.id);
}

export function recordPageChange(runId: string, episodeId: string, imageId: string, label: string,
  before: PageSnapshot, after: PageSnapshot): number | null {
  if (JSON.stringify(comparable(before)) === JSON.stringify(comparable(after))) return null;
  const id = Number(sqlite.prepare(`INSERT INTO director_changes(run_id,episode_id,image_id,label,before_json,after_json,created_at)
    VALUES(?,?,?,?,?,?,?)`).run(runId, episodeId, imageId, label, JSON.stringify(before), JSON.stringify(after), Date.now()).lastInsertRowid);
  directorEvent(runId, episodeId, imageId, 'change', { id, label, before: comparable(before), after: comparable(after) });
  return id;
}

export function recordNumberingChange(runId: string, episodeId: string, before: Row[], after: Row[], staleBefore: number, staleAfter: number): number | null {
  const first = { pages: before.map(row => ({ id: row.id, page_number: row.page_number })), stale: staleBefore };
  const second = { pages: after.map(row => ({ id: row.id, page_number: row.page_number })), stale: staleAfter };
  if (JSON.stringify(first) === JSON.stringify(second)) return null;
  const id = Number(sqlite.prepare(`INSERT INTO director_changes(run_id,episode_id,image_id,label,before_json,after_json,created_at)
    VALUES(?,?,?,?,?,?,?)`).run(runId, episodeId, null, 'Renumber pages', JSON.stringify(first), JSON.stringify(second), Date.now()).lastInsertRowid);
  directorEvent(runId, episodeId, null, 'change', { id, label: 'Renumber pages', before: first, after: second });
  return id;
}

type ChangeRow = { id: number; run_id: string; episode_id: string; image_id: string | null; label: string;
  before_json: string; after_json: string; undone: number };

function assertSame(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new WorkflowError(`${label} changed after Director. Review it before undoing.`, 409);
}

export function undoDirectorChange(episodeId: string, changeId: number): void {
  const change = sqlite.prepare('SELECT * FROM director_changes WHERE id=? AND episode_id=?').get(changeId, episodeId) as ChangeRow | undefined;
  if (!change) throw new WorkflowError('Director change not found', 404);
  if (change.undone) return;
  const before = JSON.parse(change.before_json);
  const after = JSON.parse(change.after_json);
  withDeferredBroadcasts(() => sqlite.transaction(() => {
    if (!change.image_id) {
      const rows = sqlite.prepare('SELECT id,page_number FROM images WHERE episode_id=? ORDER BY sort_order,created_at,id').all(episodeId) as Row[];
      const stale = (sqlite.prepare('SELECT numbering_stale FROM episodes WHERE id=?').get(episodeId) as Row).numbering_stale;
      assertSame({ pages: rows, stale }, after, 'Page numbering');
      for (const page of before.pages) sqlite.prepare('UPDATE images SET page_number=? WHERE id=? AND episode_id=?')
        .run(page.page_number, page.id, episodeId);
      sqlite.prepare('UPDATE episodes SET numbering_stale=?,revision=revision+1 WHERE id=?').run(before.stale, episodeId);
    } else {
      const current = snapshotPage(episodeId, change.image_id);
      assertSame(comparable(current), comparable(after), change.label);
      const beforeLines = new Map<string, Row>(before.lines.map((row: Row) => [row.id, row]));
      const currentLines = new Map(current.lines.map(row => [row.id, row]));
      for (const row of current.lines) if (!beforeLines.has(row.id)) {
        sqlite.prepare('DELETE FROM lines WHERE id=? AND episode_id=?').run(row.id, episodeId);
        broadcast(episodeId, { type: 'line:delete', id: row.id });
      }
      const assignments = lineFields.map(field => `${field}=?`).join(',');
      for (const row of before.lines as Row[]) {
        if (!currentLines.has(row.id)) throw new WorkflowError('A Director line was deleted; restore it manually.', 409);
        sqlite.prepare(`UPDATE lines SET ${assignments},updated_at=? WHERE id=? AND episode_id=?`)
          .run(...lineFields.map(field => row[field] ?? null), Date.now(), row.id, episodeId);
      }
      const beforeDocs = new Map<string, Doc>((before.docs as Doc[]).map(doc => [doc.id, doc]));
      for (const doc of current.docs) {
        const prior = beforeDocs.get(doc.id);
        if (prior) putDoc(episodeId, doc.id, JSON.parse(prior.data), doc.revision);
        else sqlite.prepare('DELETE FROM workflow_docs WHERE id=? AND episode_id=?').run(doc.id, episodeId);
      }
      const beforeSuggestions = new Set((before.suggestions as Row[]).map(row => row.id));
      for (const suggestion of current.suggestions) if (!beforeSuggestions.has(suggestion.id))
        sqlite.prepare('DELETE FROM suggestions WHERE id=?').run(suggestion.id);
      for (const suggestion of before.suggestions as Row[]) if (beforeSuggestions.has(suggestion.id))
        sqlite.prepare('UPDATE suggestions SET state=?,body=?,reason=?,translation=? WHERE id=? AND episode_id=?')
          .run(suggestion.state, suggestion.body, suggestion.reason, suggestion.translation, suggestion.id, episodeId);
      if (current.image.caption !== before.image.caption)
        sqlite.prepare('UPDATE images SET caption=? WHERE id=? AND episode_id=?').run(before.image.caption, change.image_id, episodeId);
      if (current.image.page_number !== before.image.page_number)
        sqlite.prepare('UPDATE images SET page_number=? WHERE id=? AND episode_id=?').run(before.image.page_number, change.image_id, episodeId);
      if (current.episodeStatus !== before.episodeStatus) {
        sqlite.prepare('UPDATE episodes SET status=?,updated_at=?,revision=revision+1 WHERE id=?')
          .run(before.episodeStatus,Date.now(),episodeId);
        broadcast(episodeId,{type:'episode:status',status:before.episodeStatus,updatedAt:Date.now()});
      }
      broadcast(episodeId, { type: 'workflow:changed', id: `page:${change.image_id}`, revision: 0 });
    }
    sqlite.prepare('UPDATE director_changes SET undone=1 WHERE id=?').run(change.id);
    sqlite.prepare("UPDATE director_pages SET state='stale',fingerprint=NULL,detail='Director edits were undone',updated_at=? WHERE episode_id=? AND image_id=?")
      .run(Date.now(), episodeId, change.image_id);
  })());
  directorEvent(change.run_id, episodeId, change.image_id, 'undo', { changeId: change.id, label: change.label });
}

export function undoDirectorScope(episodeId: string, runId: string, imageId?: string): number {
  const rows = sqlite.prepare(`SELECT id FROM director_changes WHERE episode_id=? AND run_id=? AND undone=0
    ${imageId ? 'AND image_id=?' : ''} ORDER BY id DESC`).all(...(imageId ? [episodeId, runId, imageId] : [episodeId, runId])) as { id: number }[];
  withDeferredBroadcasts(() => sqlite.transaction(() => {
    for (const row of rows) undoDirectorChange(episodeId, row.id);
  })());
  return rows.length;
}
