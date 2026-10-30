import { sqlite } from "./db";
import { nid } from "./ids";
import { broadcast } from "./realtime";
import { listLines } from "./queries";
import { WorkflowError } from "./workflowStore";

/**
 * Deleting regions keeps what the deletion takes with it, so it can be undone: the region
 * rows, and the comments and suggestions that cascade away with them. A region's layout and
 * style document is never removed with the row, so restoring the row brings it all back.
 * The newest batches per chapter are kept.
 */

const KEEP = 30;
type Row = Record<string, unknown>;
type Batch = { lines: Row[]; comments: Row[]; suggestions: Row[] };

const tableColumns = new Map<string, string[]>();
function columns(table: string) {
  if (!tableColumns.has(table))
    tableColumns.set(table, (sqlite.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name));
  return tableColumns.get(table)!;
}
function insert(table: string, row: Row) {
  const cols = columns(table).filter((c) => c in row);
  sqlite
    .prepare(`INSERT OR IGNORE INTO "${table}"(${cols.map((c) => `"${c}"`).join(",")}) VALUES(${cols.map(() => "?").join(",")})`)
    .run(...cols.map((c) => row[c] as never));
}

/** Deletes the regions `ids` of a chapter, keeping them for undo. Returns the removed ids. */
export function deleteRegions(episodeId: string, ids: string[], label: string): string[] {
  if (!ids.length) return [];
  const removed = sqlite.transaction(() => {
    const marks = ids.map(() => "?").join(",");
    const lines = sqlite.prepare(`SELECT * FROM lines WHERE episode_id=? AND id IN (${marks})`).all(episodeId, ...ids) as Row[];
    if (!lines.length) return [];
    const found = lines.map((l) => l.id as string);
    const fm = found.map(() => "?").join(",");
    const batch: Batch = {
      lines,
      comments: sqlite.prepare(`SELECT * FROM comments WHERE line_id IN (${fm})`).all(...found) as Row[],
      suggestions: sqlite.prepare(`SELECT * FROM suggestions WHERE line_id IN (${fm})`).all(...found) as Row[],
    };
    sqlite.prepare("INSERT INTO deleted_regions(id,episode_id,label,payload,created_at) VALUES(?,?,?,?,?)")
      .run(nid(), episodeId, label, JSON.stringify(batch), Date.now());
    sqlite.prepare(`DELETE FROM lines WHERE episode_id=? AND id IN (${fm})`).run(episodeId, ...found);
    sqlite.prepare(
      `DELETE FROM deleted_regions WHERE episode_id=? AND id NOT IN (SELECT id FROM deleted_regions WHERE episode_id=? ORDER BY created_at DESC LIMIT ${KEEP})`,
    ).run(episodeId, episodeId);
    return found;
  })();
  for (const id of removed) broadcast(episodeId, { type: "line:delete", id });
  return removed;
}

/** The newest deletion that can be undone in a chapter, for the Undo label. */
export function lastDeletion(episodeId: string) {
  const row = sqlite.prepare("SELECT id,label,payload,created_at FROM deleted_regions WHERE episode_id=? ORDER BY created_at DESC LIMIT 1")
    .get(episodeId) as { id: string; label: string; payload: string; created_at: number } | undefined;
  if (!row) return null;
  return { id: row.id, label: row.label, count: (JSON.parse(row.payload) as Batch).lines.length, at: row.created_at };
}

/** Puts back the newest deleted batch (or `batchId`): rows, comments and suggestions. */
export async function restoreDeletion(episodeId: string, batchId?: string) {
  const row = (batchId
    ? sqlite.prepare("SELECT * FROM deleted_regions WHERE episode_id=? AND id=?").get(episodeId, batchId)
    : sqlite.prepare("SELECT * FROM deleted_regions WHERE episode_id=? ORDER BY created_at DESC LIMIT 1").get(episodeId)) as
    | { id: string; label: string; payload: string }
    | undefined;
  if (!row) throw new WorkflowError("Nothing deleted to restore", 404);
  const batch = JSON.parse(row.payload) as Batch;
  const pages = new Set((sqlite.prepare("SELECT id FROM images WHERE episode_id=?").all(episodeId) as { id: string }[]).map((r) => r.id));
  sqlite.transaction(() => {
    for (const line of batch.lines) {
      // A region whose page was deleted since comes back unplaced rather than not at all.
      insert("lines", line.image_id && !pages.has(line.image_id as string) ? { ...line, image_id: null } : line);
    }
    for (const c of batch.comments) insert("comments", c);
    for (const s of batch.suggestions) insert("suggestions", s);
    sqlite.prepare("DELETE FROM deleted_regions WHERE id=?").run(row.id);
    sqlite.prepare("UPDATE episodes SET revision=revision+1 WHERE id=?").run(episodeId);
  })();
  const ids = new Set(batch.lines.map((l) => l.id as string));
  for (const line of (await listLines(episodeId)).filter((l) => ids.has(l.id))) broadcast(episodeId, { type: "line:upsert", line });
  return { ids: [...ids], label: row.label };
}
