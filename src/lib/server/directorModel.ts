import { sqlite } from "./db";
import { setTimeout as delay } from "node:timers/promises";
import type { TaskEngine } from "../aiTasks";
import type { DirectorPolicy } from "../director";
import { ModelTaskError } from "../modelTasks";
import { executeModelTask } from "./modelTaskRunner";
import { resolveLiveAssistant } from "./assistantRoute";
import {
  directorContext,
  directorEvent,
  directorTraceValue,
} from "./directorAudit";

const unavailable = new Map<
  string,
  Map<string, { until: number; error: Error }>
>();
export function forgetDirectorModelState(runId: string) {
  unavailable.delete(runId);
}
const transient =
  /timeout|timed out|fetch failed|network|ECONN|429|50[0234]|temporar|rate limit/i;

export type DirectorModelCall = <T>(
  purpose: string,
  system: string,
  data: unknown,
  images: Buffer[],
  schema: any,
) => Promise<T>;
export function directorModel(
  selected: TaskEngine,
  policy: DirectorPolicy,
  signal: AbortSignal,
): DirectorModelCall {
  return async <T>(
    purpose: string,
    system: string,
    data: unknown,
    images: Buffer[],
    schema: any,
  ): Promise<T> => {
    let last: unknown;
    let failedModel: TaskEngine | undefined;
    const candidates = [selected, ...policy.fallbacks].filter(
      (model, index, all) =>
        all.findIndex(
          (x) => x.engine === model.engine && x.model === model.model,
        ) === index,
    );
    const ctx = directorContext();
    const event = (kind: string, detail: unknown) =>
      ctx &&
      directorEvent(
        ctx.runId,
        ctx.episodeId,
        ctx.imageId || null,
        kind,
        detail,
      );
    for (const [candidate, model] of candidates.entries()) {
      const key = `${model.engine}:${model.model}`;
      const cooldown = ctx && unavailable.get(ctx.runId)?.get(key);
      if (cooldown && cooldown.until > Date.now()) {
        last = cooldown.error;
        failedModel = model;
        continue;
      }
      if (candidate > 0 && last)
        event("automation:fallback", {
          purpose,
          from: failedModel || selected,
          to: model,
          reason: last instanceof Error ? last.message : String(last),
        });
      let correction = "";
      let timedOut = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted();
        const deadline = AbortSignal.timeout(policy.requestTimeoutMs);
        const requestSignal = AbortSignal.any([signal, deadline]);
        try {
          if (ctx?.imageId)
            sqlite
              .prepare(
                "UPDATE director_pages SET state='working' WHERE episode_id=? AND image_id=?",
              )
              .run(ctx.episodeId, ctx.imageId);
          const row = resolveLiveAssistant(model.engine, model.model).row;
          const input = {
            system,
            prompt: JSON.stringify({
              purpose,
              data,
              ...(correction ? { correction } : {}),
            }),
            images,
            schema,
            model: model.model,
            thinking: false,
          };
          event("automation:request", {
            purpose,
            model,
            attempt,
            candidate,
            input: ctx ? await directorTraceValue(input, ctx.runId) : undefined,
          });
          const output = await executeModelTask(row, "director", input, {
            abort: requestSignal,
          });
          event("automation:response", { purpose, model, output });
          if (ctx) unavailable.get(ctx.runId)?.delete(key);
          return output as T;
        } catch (error) {
          signal.throwIfAborted();
          failedModel = model;
          timedOut = deadline.aborted;
          const message = deadline.aborted
            ? `${model.engine} timed out after ${policy.requestTimeoutMs / 1000} seconds during ${purpose}`
            : error instanceof Error
              ? error.message
              : String(error);
          last = deadline.aborted ? new Error(message) : error;
          event("automation:error", {
            purpose,
            model,
            attempt,
            error: message,
          });
          // Repeating the same over-budget request immediately does not help.
          // Only an explicitly configured fallback may handle this failure.
          if (deadline.aborted) break;
          if (
            error instanceof ModelTaskError &&
            error.outcome === "failed_validation" &&
            !correction
          ) {
            correction = `Your last response was invalid: ${message}. Return exactly the requested JSON schema.`;
            continue;
          }
          if (attempt === 2 || !transient.test(message)) break;
          if (ctx?.imageId)
            sqlite
              .prepare(
                "UPDATE director_pages SET state='waiting' WHERE episode_id=? AND image_id=?",
              )
              .run(ctx.episodeId, ctx.imageId);
          event("retry", {
            purpose,
            attempt: attempt + 1,
            delayMs: 1000 * 2 ** attempt,
            error: message,
          });
          await delay(1000 * 2 ** attempt, undefined, { signal });
        }
      }
      if (
        ctx &&
        !timedOut &&
        last instanceof Error &&
        transient.test(last.message)
      ) {
        const failures = unavailable.get(ctx.runId) || new Map();
        failures.set(key, { until: Date.now() + 60_000, error: last });
        unavailable.set(ctx.runId, failures);
      }
    }
    throw last instanceof Error
      ? last
      : new Error(String(last || "No Director model available"));
  };
}

export const stringField = { type: "string", maxLength: 5000 };
export const requiredString = { ...stringField, minLength: 1 };
export const stringList = {
  type: "array",
  maxItems: 50,
  items: requiredString,
};
export const objectSchema = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
