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
/** User-selectable Director tasks. Each runs one or more pipeline stages. */
export const DIRECTOR_TASKS = [
  {
    id: "prepare",
    label: "Prepare",
    description:
      "Renumber pages, transcribe every region and verify region placement",
    stages: ["prepare", "read", "classify"],
  },
  {
    id: "proofread-raw",
    label: "Proofread Raw",
    description: "Send raws for translation and apply it to the regions",
    stages: ["translate"],
  },
  {
    id: "clean-bubbles",
    label: "Clean bubbles",
    description: "Easy bubbles only, using bubble fill",
    stages: ["clean"],
  },
  {
    id: "clean-hard",
    label: "Clean hard bubbles",
    description: "Bubbles that need LaMa Manga",
    stages: ["clean"],
  },
  {
    id: "clean-sfx",
    label: "Clean SFX",
    description: "Lettering over artwork, using LaMa Manga or the image editor",
    stages: ["clean"],
  },
  {
    id: "typeset",
    label: "Typeset",
    description: "Fit and render the English lettering",
    stages: ["typeset"],
  },
  {
    id: "proof",
    label: "Proof",
    description: "Send the typeset page to the proofreader and fix its critique",
    stages: ["check"],
  },
] as const satisfies readonly {
  id: string;
  label: string;
  description: string;
  stages: readonly DirectorStage[];
}[];
export type DirectorTask = (typeof DIRECTOR_TASKS)[number]["id"];
export const ALL_DIRECTOR_TASKS: DirectorTask[] = DIRECTOR_TASKS.map(
  (task) => task.id,
);
export function directorTaskStages(tasks: readonly DirectorTask[]) {
  return new Set<DirectorStage>(
    DIRECTOR_TASKS.filter((task) => tasks.includes(task.id)).flatMap(
      (task) => task.stages,
    ),
  );
}
export type CleanScope = { easy: boolean; hard: boolean; sfx: boolean };
export const cleanScope = (tasks: readonly DirectorTask[]): CleanScope => ({
  easy: tasks.includes("clean-bubbles"),
  hard: tasks.includes("clean-hard"),
  sfx: tasks.includes("clean-sfx"),
});
export const fullDirectorTasks = (tasks: readonly DirectorTask[]) =>
  ALL_DIRECTOR_TASKS.every((task) => tasks.includes(task));
export type DirectorFinding = {
  code: string;
  message: string;
  lineId?: string;
  stage: DirectorStage;
  severity: "blocker" | "warning";
  evidence?: string;
  attempts?: number;
};
/** Stable identity for a finding, so a reviewer's dismissal survives reruns that report it again. */
export const directorFindingKey = (finding: DirectorFinding) =>
  JSON.stringify([finding.code, finding.lineId ?? "", finding.message]);
/** Page state and detail after Director finishes a page. Warnings never block. */
export function directorPageOutcome(findings: DirectorFinding[], full: boolean) {
  const blockers = findings.filter((f) => f.severity === "blocker");
  const warnings = findings.length - blockers.length;
  if (blockers.length)
    return { state: "unresolved", detail: blockers.map((f) => f.message).join("; ") };
  const note = warnings ? ` · ${warnings} warning${warnings === 1 ? "" : "s"} to review` : "";
  return full
    ? { state: "passed", detail: `Automated checks passed; human approval is still required${note}` }
    : { state: "partial", detail: `Selected Director tasks finished${note}` };
}
export type DirectorPolicy = {
  fallbacks: TaskEngine[];
  cleanMethod: string;
  cleanFallbackModel: string;
  maskEngine: string;
  repairCycles: number;
  requestTimeoutMs: number;
  tasks: DirectorTask[];
};
export const DEFAULT_DIRECTOR_POLICY: DirectorPolicy = {
  fallbacks: [],
  cleanMethod: "auto",
  cleanFallbackModel: "",
  maskEngine: "auto",
  repairCycles: 3,
  requestTimeoutMs: 180_000,
  tasks: ALL_DIRECTOR_TASKS,
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
    tasks: Array.isArray(input.tasks)
      ? ALL_DIRECTOR_TASKS.filter((task) => input.tasks!.includes(task))
      : ALL_DIRECTOR_TASKS,
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
    partial: "Selected tasks done",
  })[state] || state;
