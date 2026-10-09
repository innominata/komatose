import { pageStepStamp, type PageData, type PageStep, type RegionData } from "../workflow";
import { sqlite } from "./db";
import { unlinkAssetFiles, unreferencedAssets } from "./exportRetention";
import { broadcast } from "./realtime";
import { getDoc, putDoc, WorkflowError } from "./workflowStore";

export type PageHistoryStep = PageStep;

const STEPS = new Set<PageHistoryStep>(["translate", "review", "clean", "typeset"]);
const HASH = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g;

/**
 * Drop saved undo and revision history for one page in one workflow step.
 * The current text, artwork, and typesetting stay.
 */
export function forgetPageHistory(episodeId: string, imageId: string, step: string) {
  if (!STEPS.has(step as PageHistoryStep)) throw new WorkflowError("Unknown workflow step");
  const page = sqlite
    .prepare("SELECT 1 FROM images WHERE id=? AND episode_id=?")
    .get(imageId, episodeId);
  if (!page) throw new WorkflowError("Page not found", 404);
  const hashes: string[] = [];
  const removed = sqlite.transaction(() =>
    clearPageStep(episodeId, imageId, step as PageHistoryStep, hashes, true),
  )();
  unlinkAssetFiles(unreferencedAssets(sqlite, hashes));
  broadcast(episodeId, { type: "workflow:changed", id: `page:${imageId}`, revision: 0 });
  return { ok: true, removed };
}

export function completeOutstandingPages(episodeId: string, step?: PageStep) {
  if (step !== undefined && !STEPS.has(step)) throw new WorkflowError("Unknown workflow step");
  const steps = step ? [step] : STEPS;
  const images = sqlite
    .prepare("SELECT id FROM images WHERE episode_id=? ORDER BY sort_order, id")
    .all(episodeId) as { id: string }[];
  if (!images.length) throw new WorkflowError("Upload pages first");
  const removed = sqlite.transaction(() => {
    let count = 0;
    for (const image of images)
      for (const step of steps) {
        if (step === 'clean') finishCleaning(episodeId, image.id);
        if (rememberPageStep(episodeId, image.id, step, false)) count += 1;
      }
    sqlite.prepare("UPDATE episodes SET revision=revision+1 WHERE id=?").run(episodeId);
    return count;
  })();
  broadcast(episodeId, { type: "workflow:changed", id: `page:${images[0].id}`, revision: 0 });
  return { ok: true, removed, pages: images.length };
}

/** Approve and apply saved artwork across a chapter, retaining undo history. */
export function approveAllCleaning(episodeId: string): number {
  return sqlite.transaction(() => {
    const images = sqlite.prepare("SELECT id FROM images WHERE episode_id=?").all(episodeId) as { id: string }[];
    let approved = 0;
    for (const image of images) {
      const doc = getDoc<PageData>(`page:${image.id}`, {});
      if (!doc.data.prepared && !doc.data.cleanBase && !doc.data.cleaned) continue;
      const data = finishedCleaning(doc.data);
      if (JSON.stringify(data) === JSON.stringify(doc.data)) continue;
      putDoc(episodeId, doc.id, data, doc.revision);
      approved++;
    }
    return approved;
  })();
}

function clearPageStep(
  episodeId: string,
  imageId: string,
  step: PageHistoryStep,
  hashes: string[],
  bump: boolean,
) {
  const lineIds = (
    sqlite.prepare("SELECT id FROM lines WHERE episode_id=? AND image_id=?").all(episodeId, imageId) as {
      id: string;
    }[]
  ).map((row) => row.id);
  let count = 0;
  if (step === "clean") {
    finishCleaning(episodeId, imageId, hashes);
    count += blankDoc(episodeId, `page:${imageId}`, hashes);
    count += deleteRevisions(episodeId, [`page:${imageId}`], hashes);
  }
  if (step === "typeset") {
    for (const id of lineIds) count += blankDoc(episodeId, `region:${id}`, hashes);
    count += deleteRevisions(episodeId, lineIds.map((id) => `region:${id}`), hashes);
  }
  if (step === "translate" || step === "review") count += deleteRevisions(episodeId, lineIds, hashes);
  if (step === "review")
    count += deleteRevisions(episodeId, commentIdsFor(lineIds).map((id) => `comment:${id}`), hashes);
  count += rememberPageStep(episodeId, imageId, step, bump) ? 1 : 0;
  return count;
}

/** Apply and approve the visible artwork before discarding masks and stamping completion. */
function finishCleaning(episodeId: string, imageId: string, hashes: string[] = []) {
  const row = sqlite.prepare('SELECT data FROM workflow_docs WHERE id=? AND episode_id=?')
    .get(`page:${imageId}`, episodeId) as { data: string } | undefined;
  if (!row) return;
  const data = finishedCleaning(JSON.parse(row.data) as PageData, hashes);
  sqlite.prepare('UPDATE workflow_docs SET data=? WHERE id=? AND episode_id=?')
    .run(JSON.stringify(data), `page:${imageId}`, episodeId);
}

function finishedCleaning(page: PageData, hashes: string[] = []): PageData {
  const data = { ...page };
  if (data.cleaned) {
    data.cleanBase = data.cleaned;
    delete data.cleaned;
    delete data.cleanMethod;
    delete data.backend;
  }
  data.cleanApproved = true;
  if (data.mask) collectHashes(data.mask, hashes);
  delete data.mask;
  delete data.maskDiagnostics;
  delete data.strokes;
  delete data.expansion;
  data.maskApproved = false;
  return data;
}

export function rememberPageSteps(episodeId: string, imageId: string) {
  for (const step of STEPS) rememberPageStep(episodeId, imageId, step);
}

function rememberPageStep(episodeId: string, imageId: string, step: PageHistoryStep, bump = true) {
  const id = `page:${imageId}`;
  const row = sqlite
    .prepare("SELECT revision, data FROM workflow_docs WHERE id=? AND episode_id=?")
    .get(id, episodeId) as { revision: number; data: string } | undefined;
  const data = (row ? JSON.parse(row.data) : {}) as PageData;
  const previous = data.completed?.[step];
  const stamp = currentStamp(episodeId, imageId, step, data);
  data.completed = { ...data.completed, [step]: stamp };
  const json = JSON.stringify(data);
  if (row)
    sqlite
      .prepare("UPDATE workflow_docs SET data=?, revision=revision+1, updated_at=? WHERE id=?")
      .run(json, Date.now(), id);
  else
    sqlite
      .prepare(
        "INSERT INTO workflow_docs(id, episode_id, revision, data, undo, redo, updated_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(id, episodeId, 1, json, "[]", "[]", Date.now());
  if (bump) sqlite.prepare("UPDATE episodes SET revision=revision+1 WHERE id=?").run(episodeId);
  return previous !== stamp;
}

function currentStamp(episodeId: string, imageId: string, step: PageHistoryStep, page: PageData) {
  const lines = sqlite
    .prepare(
      "SELECT id, source, body, source_state AS sourceState, status, ignore_reason AS ignoreReason FROM lines WHERE episode_id=? AND image_id=?",
    )
    .all(episodeId, imageId) as {
    id: string;
    source: string;
    body: string;
    sourceState: string;
    status: string;
    ignoreReason: string;
  }[];
  const comments = lines.length
    ? (sqlite
        .prepare(
          `SELECT id, line_id AS lineId, body, correction FROM comments WHERE line_id IN (${lines.map(() => "?").join(",")})`,
        )
        .all(...lines.map((line) => line.id)) as {
        id: string;
        lineId: string;
        body: string;
        correction: number;
      }[])
    : [];
  const regions = lines.map((line) => ({
    id: line.id,
    data: getDoc<RegionData>(`region:${line.id}`, {}).data,
  }));
  return pageStepStamp(
    step,
    page,
    lines,
    comments.map((comment) => ({ ...comment, correction: !!comment.correction })),
    regions,
  );
}

function commentIdsFor(lineIds: string[]) {
  const ids: string[] = [];
  for (const group of chunk(lineIds, 200)) {
    const marks = group.map(() => "?").join(",");
    const rows = sqlite
      .prepare(`SELECT id FROM comments WHERE line_id IN (${marks})`)
      .all(...group) as { id: string }[];
    ids.push(...rows.map((row) => row.id));
  }
  return ids;
}

function blankDoc(episodeId: string, id: string, hashes: string[]) {
  const row = sqlite
    .prepare("SELECT undo, redo FROM workflow_docs WHERE id=? AND episode_id=?")
    .get(id, episodeId) as { undo: string; redo: string } | undefined;
  if (!row || (row.undo === "[]" && row.redo === "[]")) return 0;
  collectHashes(row.undo, hashes);
  collectHashes(row.redo, hashes);
  sqlite
    .prepare("UPDATE workflow_docs SET undo='[]', redo='[]' WHERE id=? AND episode_id=?")
    .run(id, episodeId);
  return 1;
}

function deleteRevisions(episodeId: string, entityIds: string[], hashes: string[]) {
  let count = 0;
  for (const group of chunk(entityIds.filter(Boolean), 200)) {
    const marks = group.map(() => "?").join(",");
    const rows = sqlite
      .prepare(
        `SELECT data FROM workflow_revisions WHERE episode_id=? AND entity_id IN (${marks})`,
      )
      .all(episodeId, ...group) as { data: string }[];
    for (const row of rows) collectHashes(row.data, hashes);
    const result = sqlite
      .prepare(
        `DELETE FROM workflow_revisions WHERE episode_id=? AND entity_id IN (${marks})`,
      )
      .run(episodeId, ...group);
    count += result.changes;
  }
  return count;
}

function collectHashes(text: string, into: string[]) {
  for (const match of text.match(HASH) ?? []) into.push(match);
}

function chunk<T>(items: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
