import { reserveModelJob, releaseModelJob } from './modelUsage';
import { resolveAssistant } from '../modelRegistry';
import { listRegistryRows } from './modelRegistryStore';
import { exportJobPayload } from './exportRetention';
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { sqlite } from "./db";
import { broadcast } from "./realtime";

export type JobRow = {
  id: string;
  episode_id: string;
  kind: string;
  state: string;
  payload: string;
  progress: string;
  error: string | null;
  created_at: number;
  updated_at: number;
};

/**
 * A saved job payload as the editor reads it back.
 *
 * Jobs are created with a per-kind shape (see the starters that call `createJob`),
 * so the known fields are declared here and unknown ones stay permitted. Reads go
 * through `listJobs`, which returns this rather than a bare `Record<string, unknown>`
 * so callers get real types instead of an inaccessible union.
 */
export type JobPayload = {
  schemaVersion?: number;
  format?: string;
  draft?: boolean;
  quality?: number;
  includeMetadata?: boolean;
  imageIds?: string[];
  imageId?: string;
  overwrite?: boolean;
  engine?: string;
  model?: string;
  lineId?: string;
  expectedRevision?: number;
  lang?: string;
  prompt?: string;
  followUpOf?: string;
  cuts?: number[];
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  forceVision?: boolean;
  request?: Record<string, unknown>;
  [key: string]: unknown;
};

export type JobLogUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  durationMs?: number;
};

export type JobLogEntry = {
  t: number;
  step?: string;
  imageId?: string;
  engine?: string;
  model?: string;
  request: string;
  response?: string;
  error?: string;
  usage?: JobLogUsage;
  usageText?: string;
};

export type JobContext = {
  jobId: string;
  step?: string;
  imageId?: string;
  engine?: string;
  model?: string;
};

const LOG_CAP = 80;
const TEXT_CAP = 8_000;
const SUMMARY_LOG = 8;
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

const jobAls = new AsyncLocalStorage<JobContext>();

const globalJobs = globalThis as typeof globalThis & {
  __workflowRecovered?: boolean;
};
if (!globalJobs.__workflowRecovered) {
  sqlite
    .prepare(
      "UPDATE workflow_jobs SET state='interrupted',error='Server restarted. Retry resumes completed page results.',updated_at=? WHERE state IN ('running','queued','cancelling')",
    )
    .run(Date.now());
  globalJobs.__workflowRecovered = true;
}

export function jobContext(): JobContext | undefined {
  return jobAls.getStore();
}

export function runWithJob<T>(ctx: JobContext, fn: () => T): T {
  return jobAls.run(ctx, fn);
}

export function clipJobText(value: string, cap = TEXT_CAP): string {
  if (!Number.isFinite(cap) || value.length <= cap) return value;
  return `${value.slice(0, cap)}\n…[truncated ${value.length - cap} chars]`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const tryParse = (raw: string) => {
    try {
      return asRecord(JSON.parse(raw));
    } catch {
      return null;
    }
  };
  const direct = tryParse(trimmed);
  if (direct) return direct;
  const lines = trimmed.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const rec = tryParse(lines[i]);
    if (rec) return rec;
  }
  const start = trimmed.lastIndexOf("{");
  if (start < 0) return null;
  for (let end = trimmed.length; end > start + 1; end--) {
    const rec = tryParse(trimmed.slice(start, end));
    if (rec) return rec;
  }
  return null;
}

function openaiContent(rec: Record<string, unknown>): string | undefined {
  const choices = rec.choices;
  if (!Array.isArray(choices) || !choices.length) return undefined;
  const msg = asRecord(choices[0])?.message;
  const message = asRecord(msg);
  if (!message) {
    return typeof msg === "string" && msg.trim() ? msg.trim() : undefined;
  }
  const content = message.content;
  if (typeof content === "string" && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === "string") return part;
        const nested = asRecord(part);
        return typeof nested?.text === "string" ? nested.text : "";
      })
      .join("\n")
      .trim();
    if (text) return text;
  }
  if (typeof message.reasoning_content === "string" && message.reasoning_content.trim())
    return message.reasoning_content.trim();
  return undefined;
}

function resultText(rec: Record<string, unknown>): string | undefined {
  const openai = openaiContent(rec);
  if (openai) return openai;
  for (const key of ["result", "response", "text", "message", "content", "output"]) {
    const val = rec[key];
    if (typeof val === "string" && val.trim()) return val.trim();
    if (typeof val === "number" || typeof val === "boolean") return String(val);
    const nested = asRecord(val);
    if (nested) {
      if (typeof nested.text === "string" && nested.text.trim()) return nested.text.trim();
      if (typeof nested.content === "string" && nested.content.trim()) return nested.content.trim();
      try {
        return JSON.stringify(val);
      } catch {
        /* ignore */
      }
    }
  }
  return undefined;
}

export function extractJobLogUsage(
  rec: Record<string, unknown>,
  elapsedMs?: number,
): JobLogUsage | undefined {
  const raw = asRecord(rec.usage) ?? rec;
  const details = asRecord(raw.prompt_tokens_details) ?? asRecord(raw.input_tokens_details);
  const usage: JobLogUsage = {
    input: num(raw.inputTokens ?? raw.prompt_tokens ?? raw.input_tokens ?? raw.input),
    output: num(raw.outputTokens ?? raw.completion_tokens ?? raw.output_tokens ?? raw.output),
    cacheRead: num(
      raw.cacheReadTokens ??
        raw.cache_read_tokens ??
        raw.cached_tokens ??
        details?.cached_tokens ??
        details?.cache_read_tokens,
    ),
    cacheWrite: num(raw.cacheWriteTokens ?? raw.cache_write_tokens ?? details?.cache_write_tokens),
    durationMs: num(rec.duration_ms ?? rec.duration_api_ms ?? raw.duration_ms) ?? elapsedMs,
  };
  if (
    usage.input == null &&
    usage.output == null &&
    usage.cacheRead == null &&
    usage.cacheWrite == null &&
    usage.durationMs == null
  )
    return undefined;
  return usage;
}

export function formatJobUsage(usage: JobLogUsage): string {
  const parts: string[] = [];
  if (usage.input != null) parts.push(`Input ${usage.input}`);
  if (usage.output != null) parts.push(`Output ${usage.output}`);
  if (usage.cacheRead != null) parts.push(`Cache Read ${usage.cacheRead}`);
  if (usage.cacheWrite != null) parts.push(`Cache Write ${usage.cacheWrite}`);
  if (usage.durationMs != null) {
    const sec = Math.max(0, usage.durationMs / 1000);
    const shown = Math.round(sec * 10) / 10;
    parts.push(`Time Taken ${Number.isInteger(shown) ? `${shown}s` : `${shown.toFixed(1)}s`}`);
    if (usage.output != null && sec > 0)
      parts.push(`Token/s ${(usage.output / sec).toFixed(1)}tok/s`);
  }
  return parts.join(" ");
}

export function summarizeModelOutput(
  raw: string | undefined,
  elapsedMs?: number,
): { response?: string; usage?: JobLogUsage } {
  if (raw == null || !raw.trim()) return {};
  const rec = parseJsonRecord(raw);
  if (!rec) return { response: raw };
  return { response: resultText(rec) ?? raw, usage: extractJobLogUsage(rec, elapsedMs) };
}

/** Reserve every model reference present in a queued job's saved payload. */
function reserveJobModels(jobId: string, payload: unknown) {
 const rows = listRegistryRows();
 const visit = (value: unknown) => {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach(visit); return; }
  const rec = value as Record<string, unknown>;
  if (typeof rec.engine === 'string') {
   let id: string | undefined;
   try { id = resolveAssistant(rec.engine, typeof rec.model === 'string' ? rec.model : '', rows).row.id; } catch { /* execution reports invalid selections */ }
   if (id) reserveModelJob(id, jobId);
  }
  if (Array.isArray(rec.transcriptionModels)) for (const id of rec.transcriptionModels) if (typeof id === 'string') reserveModelJob(id, jobId);
  Object.values(rec).forEach(visit);
 };
 try { visit(payload); } catch (error) { releaseModelJob(jobId); throw error; }
}

export function createJob(episodeId: string, kind: string, payload: unknown) {
  const id = randomUUID();
  reserveJobModels(id, payload);
  try {
  sqlite
    .prepare(
      "INSERT INTO workflow_jobs(id,episode_id,kind,state,payload,created_at,updated_at) VALUES(?,?,?,'running',?,?,?)",
    )
    .run(id, episodeId, kind, JSON.stringify(payload), Date.now(), Date.now());
  } catch (error) { releaseModelJob(id); throw error; }
  broadcast(episodeId, { type: "job:changed", id });
  return id;
}

function parseProgress(raw: string | null | undefined): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function readJobProgress(id: string): Record<string, unknown> {
  const row = sqlite
    .prepare("SELECT progress FROM workflow_jobs WHERE id=?")
    .get(id) as { progress: string } | undefined;
  return parseProgress(row?.progress);
}

export function updateJob(
  id: string,
  state: string,
  progress: unknown,
  error: string | null = null,
) {
  if (TERMINAL.has(state)) releaseModelJob(id);
  const prev = readJobProgress(id);
  const incoming =
    progress && typeof progress === "object" && !Array.isArray(progress)
      ? (progress as Record<string, unknown>)
      : {};
  const next: Record<string, unknown> = { ...prev };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined) next[key] = value;
  }
  if (incoming.log == null && prev.log != null) next.log = prev.log;
  sqlite
    .prepare(
      "UPDATE workflow_jobs SET state=?,progress=?,error=?,updated_at=? WHERE id=?",
    )
    .run(state, JSON.stringify(next), error, Date.now(), id);
  const j = sqlite
    .prepare("SELECT episode_id FROM workflow_jobs WHERE id=?")
    .get(id) as { episode_id: string } | undefined;
  if (j) broadcast(j.episode_id, { type: "job:changed", id });
}

export function appendJobLog(
  jobId: string,
  entry: Omit<JobLogEntry, "t"> & { t?: number },
) {
  const ctx = jobAls.getStore();
  const id = jobId || ctx?.jobId;
  if (!id) return;
  const prev = readJobProgress(id);
  const log = Array.isArray(prev.log) ? [...(prev.log as JobLogEntry[])] : [];
  const usage = entry.usage;
  const usageText = entry.usageText ?? (usage ? formatJobUsage(usage) : undefined);
  log.push({
    t: entry.t ?? Date.now(),
    step: entry.step ?? ctx?.step,
    imageId: entry.imageId ?? ctx?.imageId,
    engine: entry.engine ?? ctx?.engine,
    model: entry.model ?? ctx?.model,
    request: clipJobText(entry.request || ""),
    response: entry.response != null ? clipJobText(entry.response) : undefined,
    error: entry.error,
    usage,
    usageText,
  });
  prev.log = Number.isFinite(LOG_CAP) ? log.slice(-LOG_CAP) : log;
  sqlite
    .prepare("UPDATE workflow_jobs SET progress=?,updated_at=? WHERE id=?")
    .run(JSON.stringify(prev), Date.now(), id);
  const j = sqlite
    .prepare("SELECT episode_id FROM workflow_jobs WHERE id=?")
    .get(id) as { episode_id: string } | undefined;
  if (j) broadcast(j.episode_id, { type: "job:changed", id });
}

export function sanitizeLlmMessages(messages: unknown): string {
  if (!Array.isArray(messages)) return clipJobText(String(messages ?? ""));
  const parts: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const role = String((msg as { role?: string }).role || "message");
    const content = (msg as { content?: unknown }).content;
    parts.push(`${role}: ${sanitizeLlmContent(content)}`);
  }
  return clipJobText(parts.join("\n\n"));
}

function sanitizeLlmContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return String(part);
      const p = part as { type?: string; text?: string; image_url?: unknown };
      if (p.type === "image_url" || p.image_url) return "[image attached]";
      if (typeof p.text === "string") return p.text;
      return "[attachment]";
    })
    .join("\n");
}

export function pageResult(
  jobId: string,
  imageId: string,
  state: string,
  error: string | null = null,
) {
  sqlite
    .prepare(
      "INSERT INTO job_pages VALUES(?,?,?,?) ON CONFLICT(job_id,image_id) DO UPDATE SET state=excluded.state,error=excluded.error",
    )
    .run(jobId, imageId, state, error);
}

export function jobPollStamp(episodeId: string) {
  const row = sqlite
    .prepare(
      `SELECT revision,
        COALESCE((SELECT MAX(updated_at) FROM workflow_jobs WHERE episode_id=episodes.id), 0) AS jobsAt
       FROM episodes WHERE id=?`,
    )
    .get(episodeId) as { revision: number; jobsAt: number } | undefined;
  return { revision: row?.revision ?? 0, jobsAt: row?.jobsAt ?? 0 };
}

function clientPayload(
  job: JobRow,
  payload: JobPayload,
  summary: boolean,
  keepMaskStrokes: boolean,
): JobPayload {
  if (!summary) return payload;
  if (job.kind === "export") return exportJobPayload(payload);
  if (job.kind === "mask" && !keepMaskStrokes && payload.request && typeof payload.request === "object") {
    const request = { ...(payload.request as Record<string, unknown>) };
    delete request.strokes;
    return { ...payload, request };
  }
  return payload;
}

function clientProgress(progress: Record<string, any>, summary: boolean): Record<string, any> & { logCount: number; log: JobLogEntry[] } {
  const log = Array.isArray(progress.log) ? (progress.log as JobLogEntry[]) : [];
  if (!summary) return { ...progress, log, logCount: log.length };
  const { log: _log, ...rest } = progress;
  return {
    ...rest,
    log: log.slice(-SUMMARY_LOG),
    logCount: log.length,
  };
}

export function listJobs(episodeId: string, scope: "full" | "summary" = "full") {
  const rows = sqlite
    .prepare(
      "SELECT * FROM workflow_jobs WHERE episode_id=? ORDER BY created_at DESC",
    )
    .all(episodeId) as JobRow[];
  const pages = sqlite
    .prepare(
      "SELECT job_pages.* FROM job_pages JOIN workflow_jobs ON workflow_jobs.id=job_pages.job_id WHERE workflow_jobs.episode_id=?",
    )
    .all(episodeId) as { job_id: string }[];
  const pagesByJob = new Map<string, typeof pages>();
  for (const page of pages) {
    const list = pagesByJob.get(page.job_id) ?? [];
    list.push(page);
    pagesByJob.set(page.job_id, list);
  }
  let latestMask = "";
  let latestMaskAt = -1;
  for (const row of rows) {
    if (row.kind === "mask" && (latestMask === "" || row.updated_at > latestMaskAt)) {
      latestMask = row.id;
      latestMaskAt = row.updated_at;
    }
  }
  const summary = scope === "summary";
  return rows.map((j) => {
    const payload = JSON.parse(j.payload || "{}") as JobPayload;
    return {
      ...j,
      payload: clientPayload(j, payload, summary, j.id === latestMask),
      progress: clientProgress(JSON.parse(j.progress || "{}"), summary),
      pages: pagesByJob.get(j.id) ?? [],
    };
  });
}

/** Remove every job for the episode, including running/queued ones (their rows only; work is not aborted). */
export function clearAllJobs(episodeId: string) {
  const ids = (
    sqlite.prepare("SELECT id FROM workflow_jobs WHERE episode_id=?").all(episodeId) as { id: string }[]
  ).map((r) => r.id);
  if (!ids.length) return 0;
  const marks = ids.map(() => "?").join(",");
  for (const id of ids) releaseModelJob(id);
  sqlite.prepare(`DELETE FROM job_pages WHERE job_id IN (${marks})`).run(...ids);
  sqlite.prepare(`DELETE FROM workflow_jobs WHERE id IN (${marks})`).run(...ids);
  broadcast(episodeId, { type: "job:changed", id: ids[0] });
  return ids.length;
}

export function clearFinishedJobs(episodeId: string) {
  const rows = sqlite
    .prepare("SELECT id,state FROM workflow_jobs WHERE episode_id=?")
    .all(episodeId) as { id: string; state: string }[];
  const ids = rows.filter((r) => TERMINAL.has(r.state)).map((r) => r.id);
  if (!ids.length) return 0;
  const marks = ids.map(() => "?").join(",");
  sqlite.prepare(`DELETE FROM job_pages WHERE job_id IN (${marks})`).run(...ids);
  sqlite.prepare(`DELETE FROM workflow_jobs WHERE id IN (${marks})`).run(...ids);
  broadcast(episodeId, { type: "job:changed", id: ids[0] });
  return ids.length;
}
