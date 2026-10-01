import { unlinkSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { DATA_DIR } from "./paths";

const LIVE = new Set(["running", "queued", "cancelling"]);

export type ExportJobFields = {
  format: string;
  draft: boolean;
  quality: number;
  includeMetadata: boolean;
};

/** Fields the editor needs after the zip exists. The chapter snapshot stays in memory for this process only. */
export function exportJobPayload(input: {
  format?: unknown;
  draft?: unknown;
  quality?: unknown;
  includeMetadata?: unknown;
}): ExportJobFields {
  return {
    format: typeof input.format === "string" && input.format ? input.format : "png",
    draft: !!input.draft,
    quality: Number.isInteger(input.quality) ? (input.quality as number) : 95,
    includeMetadata: input.includeMetadata === true,
  };
}

function artifactHash(progress: string | null): string {
  try {
    const parsed = JSON.parse(progress || "{}") as { artifact?: unknown };
    return typeof parsed.artifact === "string" ? parsed.artifact : "";
  } catch {
    return "";
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Keep one export job per chapter (the job just finished, or otherwise the newest).
 * Other finished exports are deleted. In-flight exports are left alone.
 * Returns zip hashes and job ids that were deleted.
 */
export function pruneExportJobs(
  db: Database.Database,
  opts: { episodeId?: string; keepJobId?: string } = {},
): { hashes: string[]; jobIds: string[] } {
  const rows = (
    opts.episodeId
      ? db
          .prepare(
            "SELECT id, episode_id, state, payload, progress, created_at FROM workflow_jobs WHERE kind='export' AND episode_id=? ORDER BY created_at DESC, id DESC",
          )
          .all(opts.episodeId)
      : db
          .prepare(
            "SELECT id, episode_id, state, payload, progress, created_at FROM workflow_jobs WHERE kind='export' ORDER BY created_at DESC, id DESC",
          )
          .all()
  ) as {
    id: string;
    episode_id: string;
    state: string;
    payload: string;
    progress: string;
    created_at: number;
  }[];
  const keep = new Map<string, string>();
  if (opts.keepJobId) {
    const pinned = rows.find((row) => row.id === opts.keepJobId);
    if (pinned) keep.set(pinned.episode_id, pinned.id);
  }
  const drop: string[] = [];
  const hashes: string[] = [];
  const slim = db.prepare("UPDATE workflow_jobs SET payload=? WHERE id=?");
  for (const row of rows) {
    if (!keep.has(row.episode_id)) keep.set(row.episode_id, row.id);
    if (row.id === keep.get(row.episode_id)) {
      slim.run(JSON.stringify(exportJobPayload(safeParse(row.payload))), row.id);
      continue;
    }
    if (LIVE.has(row.state)) continue;
    drop.push(row.id);
    const hash = artifactHash(row.progress);
    if (hash) hashes.push(hash);
  }
  for (const ids of chunk(drop, 400)) {
    const marks = ids.map(() => "?").join(",");
    db.prepare(`DELETE FROM job_pages WHERE job_id IN (${marks})`).run(...ids);
    db.prepare(`DELETE FROM workflow_jobs WHERE id IN (${marks})`).run(...ids);
  }
  return { hashes, jobIds: drop };
}

function safeParse(payload: string): ExportJobFields {
  try {
    return exportJobPayload(JSON.parse(payload || "{}"));
  } catch {
    return exportJobPayload({});
  }
}

/** Hashes no longer mentioned by a page, a font, or a remaining job. */
export function unreferencedAssets(db: Database.Database, hashes: string[]): string[] {
  const page = db.prepare(
    "SELECT 1 FROM workflow_docs WHERE id>='page:' AND id<'page;' AND instr(data,?)>0 LIMIT 1",
  );
  const job = db.prepare(
    "SELECT 1 FROM workflow_jobs WHERE instr(progress,?)>0 OR instr(payload,?)>0 LIMIT 1",
  );
  const font = db.prepare(
    "SELECT 1 FROM font_assets WHERE hash=? UNION ALL SELECT 1 FROM global_font_assets WHERE hash=? LIMIT 1",
  );
  const freed: string[] = [];
  for (const hash of new Set(hashes)) {
    if (!/^[a-f0-9]{64}$/.test(hash)) continue;
    if (font.get(hash, hash) || page.get(hash) || job.get(hash, hash)) continue;
    freed.push(hash);
  }
  return freed;
}

export function unlinkAssetFiles(hashes: string[]) {
  for (const hash of hashes) {
    if (!/^[a-f0-9]{64}$/.test(hash)) continue;
    try {
      unlinkSync(join(DATA_DIR, "workflow", "assets", hash));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
