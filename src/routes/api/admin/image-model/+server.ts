import { startPackageOperation, operatePackage } from '$lib/server/modelSupervisor';
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
  fail,
  messageOf,
  requireManageUsers,
  requireUser,
  statusOf,
} from "$lib/server/http";
import { DEFAULT_IMAGE_EDIT_MODEL_ID, imageEditModelOf } from "$lib/imageEdit";
import {
  imageEditStatus,
  imageEditStatuses,
  missingImageEditError,
  operateImageEditServer,
  waitImageEditOperation,
} from "$lib/server/imageEdit";

/**
 * 2511 and Lightning share one sd-server. `model` picks which editor an action
 * addresses; omitting it addresses the default editor.
 */
function requestedModel(body: Record<string, unknown>) {
  if (body.model == null || body.model === "") return undefined;
  try {
    return imageEditModelOf(body.model).id;
  } catch {
    // Naming an unknown model is a rejected request, not a silent fall back.
    throw Object.assign(new Error('Unknown image editor model'), { status: 409 });
  }
}

export const GET: RequestHandler = async ({ locals }) => {
  try {
    requireManageUsers(requireUser(locals.user));
    return json({ ok: true, model: imageEditStatus(), models: imageEditStatuses() });
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
    const id = requestedModel(body) ?? DEFAULT_IMAGE_EDIT_MODEL_ID;
    if (body.action !== "stop" && !imageEditStatus(id).installed) throw missingImageEditError(id);
    return json({ ok: true, model: startPackageOperation(id, body.action) }, { status: 202 });
  } catch (error) {
    return fail(statusOf(error), messageOf(error));
  }
};

/** Settles a start/stop before answering; browser check scripts assert on the result. */
export const PUT: RequestHandler = async ({ locals, request }) => {
  try {
    requireManageUsers(requireUser(locals.user));
    const body = await request.json();
    if (!["start", "stop", "restart"].includes(body.action))
      return fail(400, "Choose Start, Stop, or Restart");
    const id = requestedModel(body) ?? DEFAULT_IMAGE_EDIT_MODEL_ID;
    if (body.action !== "stop" && !imageEditStatus(id).installed) throw missingImageEditError(id);
    if (body.action === 'restart') await operatePackage(id, 'stop', request.signal);
    await operatePackage(id, body.action === 'restart' ? 'start' : body.action, request.signal);
    return json({ ok: true, model: imageEditStatus(id), models: imageEditStatuses() });
  } catch (error) {
    return fail(statusOf(error), messageOf(error));
  }
};
