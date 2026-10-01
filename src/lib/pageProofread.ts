import { isProofreaderId, type ProofreaderId } from './proofreaders';

export const PAGE_PROOFREAD_LABEL = "Proofread raw + typeset images";
export const TYPESET_FOLLOWUP_LABEL = "Proofread updated typeset (follow-up)";

export type ProofreadCursor = { imageId: string; conversation: string };

export function proofreadAttach(
  imageId: string,
  conversation = "",
  cursor?: ProofreadCursor | null,
): "both" | "typeset" {
  return cursor?.imageId === imageId && cursor.conversation === conversation ? "typeset" : "both";
}

export function lastProofreadPageId(
  jobs: Array<{ kind?: string; state?: string; payload?: Record<string, unknown> | null }>,
  engine?: string,
): string {
  const hit = jobs.find((job) =>
    job.kind === "page-proofread" &&
    job.state === "completed" &&
    (engine ? job.payload?.engine === engine : isProofreaderId(String(job.payload?.engine || ""))));
  return typeof hit?.payload?.imageId === "string" ? hit.payload.imageId : "";
}

export function latestPageProofreadJob<T extends { kind?: string }>(jobs: T[]): T | undefined {
  return jobs.find((job) => job.kind === "page-proofread");
}

export type PageProofreadSnapshot = {
  raw: string;
  typeset: string;
  capturedAt: number;
  imageId: string;
  pageLabel: string;
  followUpImages?: string[];
};
export type PageProofreadJob = {
  id: string;
  kind: string;
  state: string;
  error?: string | null;
  payload?: Record<string, unknown>;
  progress?: {
    message?: string;
    critique?: string;
    prompt?: string;
    snapshot?: PageProofreadSnapshot;
  };
};

export type ProofreadFollowUpImage = { mime: string; data: string };

export function isProofreadEngine(engine: unknown): engine is ProofreaderId {
  return isProofreaderId(String(engine || ""));
}

function jsonObjectEnd(s: string, start: number): number {
  if (s[start] !== "{") return -1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (!depth) return i + 1;
    }
  }
  return -1;
}

function firstJsonRecord(text: string): Record<string, unknown> | null {
  const s = text.replace(/```(?:json)?/gi, "").replace(/```/g, "");
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    const end = jsonObjectEnd(s, i);
    if (end < 0) continue;
    try {
      const rec = JSON.parse(s.slice(i, end)) as unknown;
      if (rec && typeof rec === "object" && !Array.isArray(rec)) return rec as Record<string, unknown>;
    } catch {
      /* skip this candidate */
    }
  }
  return null;
}

function jsonAsMarkdown(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => {
      const inner = jsonAsMarkdown(item);
      if (item && typeof item === "object") return inner;
      return inner ? `- ${inner}` : "";
    }).filter(Boolean).join("\n");
  }
  if (!value || typeof value !== "object") return "";
  return Object.entries(value as Record<string, unknown>).map(([key, val]) => {
    const heading = key.replace(/[_-]+/g, " ");
    const inner = jsonAsMarkdown(val);
    if (!inner) return "";
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
      return `**${heading}:** ${inner}`;
    }
    return `**${heading}**\n\n${inner}`;
  }).filter(Boolean).join("\n\n");
}

/** Pull the readable critique out of a model JSON blob, including fenced `{critique}` replies. */
export function unwrapProofreadCritique(text: string): string {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  const rec = firstJsonRecord(trimmed);
  if (!rec) return trimmed;
  if (typeof rec.critique === "string" && rec.critique.trim()) {
    const inner = rec.critique.trim();
    return inner !== trimmed ? unwrapProofreadCritique(inner) : inner;
  }
  if (rec.critique && typeof rec.critique === "object") return jsonAsMarkdown(rec.critique);
  const stripped = trimmed.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  if (stripped.startsWith("{") && firstJsonRecord(stripped) === rec) return jsonAsMarkdown(rec);
  return trimmed;
}
