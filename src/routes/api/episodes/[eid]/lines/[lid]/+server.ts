import { acceptedRegionKind } from "$lib/server/workflowService";
import { json } from "@sveltejs/kit";
import { and, eq } from "drizzle-orm";
import { logActivity } from "$lib/server/activity";
import { db } from "$lib/server/db";
import { images, lines } from "$lib/server/db/schema";
import {
  assertEpisodeIdle,
  fail,
  messageOf,
  requireEpisodeAccess,
  requireEdit,
  requireStickies,
  requireUser,
  statusOf,
} from "$lib/server/http";
import { now } from "$lib/server/ids";
import { toLine } from "$lib/server/queries";
import { broadcast } from "$lib/server/realtime";
import { getDoc, rejectPendingSuggestions } from "$lib/server/workflowStore";
import { fitRegion } from "$lib/server/workflowService";
import type { RegionData } from "$lib/workflow";
import type { RequestHandler } from "./$types";

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  try {
    const user = requireUser(locals.user);
    requireStickies(user);
    const { episode, series } = await requireEpisodeAccess(user, params.eid);
    const existing = await db
      .select()
      .from(lines)
      .where(and(eq(lines.id, params.lid), eq(lines.episodeId, episode.id)))
      .get();
    if (!existing) return fail(404, "Line not found");
    const body = await request.json();
    if (
      [
        "body",
        "source",
        "sourceState",
        "ignoreReason",
        "status",
        "ocrConfidence",
      ].some((key) => key in body)
    )
      requireEdit(user);
    if (!Number.isInteger(body.expectedRevision))
      return fail(428, "A base revision is required");
    if (body.expectedRevision !== existing.revision)
      return fail(409, "This line changed. Your draft has been retained.", {
        current: toLine(existing),
      });
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
    for (const key of ["x", "y", "w", "h"])
      if (
        key in body &&
        body[key] !== null &&
        (!Number.isFinite(body[key]) || body[key] < 0 || body[key] > 1)
      )
        return fail(400, "Invalid region bounds");
    if (
      "lineType" in body &&
      body.lineType !== existing.lineType &&
      !acceptedRegionKind(episode.seriesId, body.lineType)
    )
      return fail(400, "Invalid text category");
    if (
      "ocrConfidence" in body &&
      body.ocrConfidence != null &&
      (!Number.isFinite(body.ocrConfidence) ||
        body.ocrConfidence < 0 ||
        body.ocrConfidence > 1)
    )
      return fail(400, "Invalid OCR confidence");
    if ("sortOrder" in body && !Number.isFinite(body.sortOrder))
      return fail(400, "Invalid reading order");
    if (
      "status" in body &&
      !["none", "needs_work", "approved"].includes(body.status)
    )
      return fail(400, "Invalid review status");
    if (
      "sourceState" in body &&
      !["read", "unreadable", "ignored"].includes(body.sourceState)
    )
      return fail(400, "Invalid source status");
    if (
      body.sourceState === "ignored" &&
      !String(body.ignoreReason ?? existing.ignoreReason).trim()
    )
      return fail(400, "An ignore reason is required");
    for (const key of ["body", "source", "ignoreReason"])
      if (
        key in body &&
        (typeof body[key] !== "string" || body[key].length > 50000)
      )
        return fail(400, "Invalid text");
    const patch: Record<string, unknown> = {
      updatedBy: user.id,
      updatedAt: now(),
    };
    for (const key of [
      "body",
      "source",
      "ocrConfidence",
      "sourceState",
      "ignoreReason",
      "lineType",
      "status",
      "placed",
      "invert",
      "imageId",
      "x",
      "y",
      "w",
      "h",
      "sidebarX",
      "sidebarY",
      "sidebarW",
      "sidebarH",
      "sortOrder",
    ]) {
      if (key in body)
        patch[key] =
          key === "invert"
            ? body.invert == null
              ? null
              : Boolean(body.invert)
            : body[key];
    }
    if (
      ("body" in body && body.body !== existing.body) ||
      ("source" in body && body.source !== existing.source)
    )
      patch.status = body.status === "approved" ? "approved" : "needs_work";
    const result = await db
      .update(lines)
      .set(patch)
      .where(
        and(
          eq(lines.id, existing.id),
          eq(lines.revision, body.expectedRevision),
        ),
      );
    if (!result.changes) return fail(409, "This line changed during saving");
    const updated = await db
      .select()
      .from(lines)
      .where(eq(lines.id, existing.id))
      .get();
    const line = toLine(updated!);
    if (patch.status === "approved")
      rejectPendingSuggestions(episode.id, line.id);
    broadcast(episode.id, { type: "line:upsert", line });
    if (body.log !== false) {
      const entry = await logActivity({
        seriesId: series.id,
        episodeId: episode.id,
        userId: user.id,
        action:
          body.placed === true
            ? "placed_line"
            : body.placed === false
              ? "unplaced_line"
              : "updated_line",
        payload: { id: line.id },
      });
      broadcast(episode.id, { type: "activity", entry });
    }
    // Save and reflow in one round trip. A missing font or concurrent geometry
    // edit must never turn an already-saved text edit into a failed save.
    if (body.refit === true && "body" in body) {
      const region = getDoc<RegionData>(`region:${line.id}`, {});
      if (!region.data.locked && (line.placed || region.data.layout)) {
        try {
          return json({ line, doc: await fitRegion(series, episode, line.id, region.revision) });
        } catch (e) {
          return json({ line, fitError: messageOf(e) });
        }
      }
    }
    return json({ line });
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  try {
    const user = requireUser(locals.user);
    requireStickies(user);
    const { episode, series } = await requireEpisodeAccess(user, params.eid);
    assertEpisodeIdle(episode.id);
    await db
      .delete(lines)
      .where(and(eq(lines.id, params.lid), eq(lines.episodeId, episode.id)));
    broadcast(episode.id, { type: "line:delete", id: params.lid });
    const entry = await logActivity({
      seriesId: series.id,
      episodeId: episode.id,
      userId: user.id,
      action: "deleted_line",
      payload: { id: params.lid },
    });
    broadcast(episode.id, { type: "activity", entry });
    return json({ ok: true });
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};
