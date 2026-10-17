import type { TaskEngine } from "./aiTasks";
import type { LineRow } from "./types";
import type { RegionData } from "./workflow";

export const DIRECTOR_VERSION = 15;
export function currentDirectorPresentation(
  line: LineRow,
  data: RegionData,
  raw: string,
) {
  const evidence = data.directorPresentation;
  return evidence?.raw === raw &&
    evidence.box === JSON.stringify([line.x, line.y, line.w, line.h])
    ? evidence
    : undefined;
}
export const DIRECTOR_STAGES = [
  "prepare",
  "read",
  "classify",
  "translate",
  "clean",
  "typeset",
  "check",
] as const;
export type DirectorStage = (typeof DIRECTOR_STAGES)[number];
export type DirectorFinding = {
  code: string;
  message: string;
  lineId?: string;
  stage: DirectorStage;
  severity: "blocker" | "warning";
  evidence?: string;
  attempts?: number;
};
export type DirectorPolicy = {
  fallbacks: TaskEngine[];
  cleanMethod: string;
  cleanFallbackModel: string;
  maskEngine: string;
  repairCycles: number;
  requestTimeoutMs: number;
};
export const DEFAULT_DIRECTOR_POLICY: DirectorPolicy = {
  fallbacks: [],
  cleanMethod: "auto",
  cleanFallbackModel: "",
  maskEngine: "auto",
  repairCycles: 3,
  requestTimeoutMs: 180_000,
};
export function directorPolicy(
  input: Partial<DirectorPolicy> = {},
): DirectorPolicy {
  return {
    ...DEFAULT_DIRECTOR_POLICY,
    fallbacks: Array.isArray(input.fallbacks)
      ? input.fallbacks
          .filter(
            (x) =>
              x && typeof x.engine === "string" && typeof x.model === "string",
          )
          .slice(0, 3)
      : [],
    cleanMethod:
      typeof input.cleanMethod === "string" ? input.cleanMethod : "auto",
    cleanFallbackModel:
      typeof input.cleanFallbackModel === "string"
        ? input.cleanFallbackModel.trim()
        : "",
    maskEngine:
      typeof input.maskEngine === "string" ? input.maskEngine : "auto",
    repairCycles: Number.isInteger(input.repairCycles)
      ? Math.max(1, Math.min(3, input.repairCycles!))
      : 3,
    requestTimeoutMs: Number.isFinite(input.requestTimeoutMs)
      ? Math.max(1000, Math.min(600_000, input.requestTimeoutMs!))
      : 180_000,
  };
}
export const directorStatusLabel = (state: string) =>
  ({
    pending: "Queued",
    working: "Working",
    waiting: "Waiting to retry",
    passed: "Checks passed",
    unresolved: "Needs attention",
    stale: "Stale",
  })[state] || state;
