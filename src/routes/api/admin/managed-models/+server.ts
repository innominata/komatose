import { startPackageOperation } from '$lib/server/modelSupervisor';
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
  fail,
  messageOf,
  requireManageUsers,
  requireUser,
  statusOf,
} from "$lib/server/http";
import {
  listManagedStatuses,
  operateManagedModel,
  launchPreset,
} from "$lib/server/managedModels";
import { gemma4LaunchPreset } from "$lib/server/managedModelConfig";
import { toHomeLaunch } from "$lib/server/homePath";
import { llmListenPort, reservedReviewService, reviewListenPort } from "$lib/server/gpuMode";
import { LOCAL_REVIEW_MODELS } from "$lib/localReviewModels";

export const GET: RequestHandler = async ({ locals }) => {
  try {
    requireManageUsers(requireUser(locals.user));
    return json({
      ok: true,
      models: listManagedStatuses(),
		presets: {
			generic: toHomeLaunch(launchPreset("generic")),
			qwen38: toHomeLaunch(launchPreset("qwen38")),
			gemma4: toHomeLaunch(launchPreset("gemma4")),
			"gemma4-e2b": toHomeLaunch(gemma4LaunchPreset("e2b")),
			"gemma4-12b": toHomeLaunch(gemma4LaunchPreset("12b")),
		},
      chatPort: llmListenPort(),
      reservedReviewPorts: LOCAL_REVIEW_MODELS.map((model) => ({
        id: model.id,
        label: model.label,
        port: reviewListenPort(model.id),
        reserved: Boolean(reservedReviewService(reviewListenPort(model.id))),
      })).filter((row) => row.reserved),
    });
  } catch (error) {
    return fail(statusOf(error), messageOf(error));
  }
};
export const POST: RequestHandler = async ({ locals, request }) => {
  try {
    requireManageUsers(requireUser(locals.user));
    const body = await request.json();
    if (!["start", "stop", "restart"].includes(body.action))
      return fail(400, "Choose Start, Stop, or Restart");
    const result = startPackageOperation(String(body.id || ""), body.action);
    return json({ ok: true, ...result }, { status: 202 });
  } catch (error) {
    return fail(statusOf(error), messageOf(error));
  }
};
