import { and, eq } from "drizzle-orm";
import { acceptedRegionKind } from "$lib/server/workflowService";
import { json } from "@sveltejs/kit";
import { logActivity } from "$lib/server/activity";
import { db } from "$lib/server/db";
import { lines, images } from "$lib/server/db/schema";
import {
  assertEpisodeIdle,
  fail,
  messageOf,
  requireEpisodeAccess,
  requireStickies,
  requireEdit,
  requireUser,
  statusOf,
} from "$lib/server/http";
import { nid, now } from "$lib/server/ids";
import { listLines, toLine } from "$lib/server/queries";
import { reorderPageRegions } from "$lib/server/regionOrder";
import { broadcast } from "$lib/server/realtime";
import type { LineType } from "$lib/types";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  try {
    const user = requireUser(locals.user);
    requireStickies(user);
    const { episode, series } = await requireEpisodeAccess(user, params.eid);
    const body = await request.json();
    if (body.body || body.source || body.status === "approved")
      requireEdit(user);
    if (
      body.imageId != null &&
      !(await db
        .select()
        .from(images)
        .where(
          and(eq(images.id, body.imageId), eq(images.episodeId, episode.id)),
        )
        .get())
    )
      return fail(400, "Page does not belong to this chapter");
    if (body.lineType && !acceptedRegionKind(series.id, body.lineType))
      return fail(400, "Invalid text category");
    if (
      body.status &&
      !["none", "needs_work", "approved"].includes(body.status)
    )
      return fail(400, "Invalid review status");
    if (
      body.sourceState &&
      !["read", "unreadable", "ignored"].includes(body.sourceState)
    )
      return fail(400, "Invalid source state");
    if (
      body.sourceState === "ignored" &&
      !String(body.ignoreReason || "").trim()
    )
      return fail(400, "An ignore reason is required");
    for (const key of ["body", "source", "ignoreReason"])
      if (
        key in body &&
        (typeof body[key] !== "string" || body[key].length > 50000)
      )
        return fail(400, "Invalid text");
    for (const key of ["x", "y", "w", "h"])
      if (
        key in body &&
        body[key] != null &&
        (!Number.isFinite(body[key]) || body[key] < 0 || body[key] > 1)
      )
        return fail(400, "Invalid region bounds");
    const existing = await listLines(episode.id);
    const t = now();
    const row = {
      id: nid(),
      episodeId: episode.id,
      imageId: body.imageId ?? null,
      body: String(body.body || ""),
      source: body.source || "",
      sourceState: body.sourceState || (body.source ? "read" : "unreadable"),
      ignoreReason: body.ignoreReason || "",
      revision: 0,
      lineType: (body.lineType || "plain") as LineType,
      status: body.status || "none",
      placed: Boolean(body.placed),
      invert: body.invert == null ? null : Boolean(body.invert),
      x: body.x ?? null,
      y: body.y ?? null,
      w: body.w ?? null,
      h: body.h ?? null,
      sidebarX: body.sidebarX ?? null,
      sidebarY: body.sidebarY ?? null,
      sidebarW: body.sidebarW ?? 0.9,
      sidebarH: body.sidebarH ?? 0.1,
      sortOrder:
        typeof body.sortOrder === "number" ? body.sortOrder : existing.length,
      createdBy: user.id,
      updatedBy: user.id,
      updatedAt: t,
    };
    await db.insert(lines).values(row);
    const line = toLine(row);
    broadcast(episode.id, { type: "line:upsert", line });
    const entry = await logActivity({
      seriesId: series.id,
      episodeId: episode.id,
      userId: user.id,
      action: "created_line",
      payload: { id: line.id },
    });
    broadcast(episode.id, { type: "activity", entry });
    return json({ line });
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  try {
    const user = requireUser(locals.user);
    requireStickies(user);
    const { episode, series } = await requireEpisodeAccess(user, params.eid);
    const body = await request.json();
    if (body?.action !== "reorder") return fail(400, "Unknown line action");
    if (typeof body.imageId !== "string" || typeof body.regionId !== "string")
      return fail(400, "Reorder needs this page and a region");
    const afterId = body.first === true ? null : body.regionId;
    const movedId = body.first === true ? body.regionId : body.nextId;
    if (afterId != null && typeof movedId !== "string")
      return fail(400, "Reorder needs the selected region and the region that follows it");
    const updated = await reorderPageRegions(episode.id, body.imageId, afterId, movedId);
    const entry = await logActivity({
      seriesId: series.id,
      episodeId: episode.id,
      userId: user.id,
      action: "reordered_regions",
      payload: { imageId: body.imageId, regionId: body.regionId, nextId: body.nextId, first: body.first === true },
    });
    broadcast(episode.id, { type: "activity", entry });
    return json({ lines: updated });
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};
