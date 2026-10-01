import { isSourceSuggestion, suggestionMatchesLine } from "../regionAi";
import { normalizeTranslation } from "../translationText";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sqlite } from "./db";
import { DATA_DIR } from "./paths";
import { broadcast } from "./realtime";
import { pageArtwork, type PageData, type WorkflowDoc } from "../workflow";

export class WorkflowError extends Error {
  constructor(
    message: string,
    public status = 400,
    public current?: unknown,
  ) {
    super(message);
  }
}
type Stored = {
  id: string;
  revision: number;
  data: string;
  undo: string;
  redo: string;
};
export function getDoc<T>(id: string, fallback: T): WorkflowDoc<T> {
  const row = sqlite
    // History may contain megabytes of glyph outlines. Reading the current
    // document needs only flags, not deserializing every historical layout.
    .prepare("SELECT revision,data,undo != '[]' AS canUndo,redo != '[]' AS canRedo FROM workflow_docs WHERE id=?")
    .get(id) as { revision: number; data: string; canUndo: number; canRedo: number } | undefined;
  return row
    ? {
        id,
        revision: row.revision,
        data: JSON.parse(row.data),
        canUndo: !!row.canUndo,
        canRedo: !!row.canRedo,
      }
    : { id, revision: 0, data: fallback, canUndo: false, canRedo: false };
}

export function peekUndo<T>(id: string): T[] {
  const row = sqlite
    .prepare("SELECT undo FROM workflow_docs WHERE id=?")
    .get(id) as Stored | undefined;
  return row ? JSON.parse(row.undo) : [];
}

/** Artwork the restore brush should paint. Pins across consecutive restore strokes. */
export function previousSavedArtwork(id: string, data: PageData): string | undefined {
  const current = pageArtwork(data);
  if (data.previousArtwork && data.previousArtwork !== current) return data.previousArtwork;
  for (const snapshot of peekUndo<PageData>(id).reverse()) {
    const hash = pageArtwork(snapshot ?? {});
    if (hash && hash !== current) return hash;
  }
  if (data.prepared && data.prepared !== current) return data.prepared;
}

export function withPreviousArtwork(
  id: string,
  previous: PageData,
  next: PageData,
  mode: "keep" | "replace",
): PageData {
  const current = pageArtwork(previous);
  const previousArtwork =
    mode === "replace" ? current : previousSavedArtwork(id, previous) ?? current;
  return previousArtwork ? { ...next, previousArtwork } : { ...next, previousArtwork: undefined };
}
export function putDoc<T>(
  episodeId: string | null,
  id: string,
  data: T,
  expected: number,
  action: "save" | "undo" | "redo" = "save",
): WorkflowDoc<T> {
  const result = sqlite.transaction(() => {
    const row = sqlite
      .prepare("SELECT * FROM workflow_docs WHERE id=?")
      .get(id) as Stored | undefined;
    const current = getDoc(id, {});
    if (!Number.isInteger(expected) || current.revision !== expected)
      throw new WorkflowError(
        "This record changed. Review the current version before saving.",
        409,
        current,
      );
    let undo = JSON.parse(row?.undo ?? "[]");
    let redo = JSON.parse(row?.redo ?? "[]");
    let next: unknown = data;
    if (action === "undo") {
      if (!undo.length) throw new WorkflowError("Nothing to undo");
      next = undo.pop();
      redo.push(current.data);
    } else if (action === "redo") {
      if (!redo.length) throw new WorkflowError("Nothing to redo");
      next = redo.pop();
      undo.push(current.data);
    } else {
      undo.push(current.data);
      redo = [];
    }
    const revision = current.revision + 1;
    sqlite
      .prepare(
        "INSERT INTO workflow_docs(id,episode_id,revision,data,undo,redo,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data,undo=excluded.undo,redo=excluded.redo,updated_at=excluded.updated_at",
      )
      .run(
        id,
        episodeId,
        revision,
        JSON.stringify(next),
        JSON.stringify(undo),
        JSON.stringify(redo),
        Date.now(),
      );
    if (episodeId) {
      sqlite
        .prepare("UPDATE episodes SET revision=revision+1 WHERE id=?")
        .run(episodeId);
      sqlite
        .prepare(
          "INSERT INTO workflow_revisions(episode_id,entity_id,revision,data,created_at) VALUES(?,?,?,?,?)",
        )
        .run(episodeId, id, revision, JSON.stringify(next), Date.now());
    }
    return getDoc<T>(id, data);
  })();
  if (episodeId)
    broadcast(episodeId, {
      type: "workflow:changed",
      id,
      revision: result.revision,
    });
  return result;
}
export function hash(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}
export function assetPath(id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new WorkflowError("Invalid asset");
  return join(DATA_DIR, "workflow", "assets", id);
}

/** Current page documents first. The id range keeps the lookup on the covering index, off the undo blobs. */
export function episodeOwnsAsset(episodeId: string, hash: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(hash)) return false;
  const doc = sqlite.prepare(
    "SELECT 1 FROM workflow_docs WHERE episode_id=? AND id>=? AND id<? AND instr(data,?)>0 LIMIT 1",
  );
  for (const prefix of ["page:", "region:", "chapter:", "series:"]) {
    const end = prefix.slice(0, -1) + ";";
    if (doc.get(episodeId, prefix, end, hash)) return true;
  }
  if (
    sqlite
      .prepare("SELECT 1 FROM workflow_revisions WHERE episode_id=? AND instr(data,?)>0 LIMIT 1")
      .get(episodeId, hash)
  )
    return true;
  return !!sqlite
    .prepare(
      "SELECT 1 FROM workflow_jobs WHERE episode_id=? AND (instr(progress,?)>0 OR instr(payload,?)>0) LIMIT 1",
    )
    .get(episodeId, hash, hash);
}
export async function storeAsset(bytes: Buffer) {
  const id = hash(bytes);
  await mkdir(join(DATA_DIR, "workflow", "assets"), { recursive: true });
  try {
    await writeFile(assetPath(id), bytes, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  return id;
}
export const readAsset = (id: string) => readFile(assetPath(id));
export function suggest(
  episodeId: string,
  lineId: string,
  revision: number,
  body: string,
  reason: string,
  kind: string,
  translation = "",
) {
  body = isSourceSuggestion(kind) ? body.trim() : normalizeTranslation(body);
  translation = kind === "source-review" ? normalizeTranslation(translation.trim()) : "";
  // Reviewers can agree on the source while offering different English.
  const id = hash(translation
    ? JSON.stringify([lineId, revision, kind, body, translation])
    : `${lineId}:${revision}:${kind}:${body}`);
  const line = sqlite.prepare("SELECT source, body FROM lines WHERE id=?").get(lineId) as
    | { source: string | null; body: string | null }
    | undefined;
  const matchesLine = Boolean(line && suggestionMatchesLine({ kind, body, translation }, line));
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO suggestions(id,episode_id,line_id,base_revision,body,reason,kind,created_at,translation) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run(
      id,
      episodeId,
      lineId,
      revision,
      body,
      reason,
      kind,
      Date.now(),
      translation,
    );
  if (matchesLine)
    sqlite.prepare("UPDATE suggestions SET state='rejected' WHERE id=? AND state='pending'").run(id);
  if (kind === "source-review" && reason) {
    const existing = sqlite.prepare("SELECT reason FROM suggestions WHERE id=?").get(id) as { reason: string };
    if (!existing.reason.includes(reason))
      sqlite.prepare("UPDATE suggestions SET reason=? WHERE id=?").run(`${existing.reason}\n${reason}`, id);
  }
  broadcast(episodeId, { type: "suggestion:changed", lineId });
  return id;
}

export function rejectPendingSuggestions(episodeId: string, lineId: string) {
  const result = sqlite
    .prepare(
      "UPDATE suggestions SET state='rejected' WHERE episode_id=? AND line_id=? AND state='pending'",
    )
    .run(episodeId, lineId);
  if (result.changes)
    broadcast(episodeId, { type: "suggestion:changed", lineId });
  return result.changes;
}
