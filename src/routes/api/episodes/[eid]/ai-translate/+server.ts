import {
  assertEngineReady,
  engineReadiness,
} from "$lib/server/engineReadiness";
import { json } from "@sveltejs/kit";
import { regionAiSettings, resolveTaskModel } from "$lib/regionAi";
import { preferences } from "$lib/server/workflowService";
import {
  cancelAiTranslate,
  cancelRegionQueue,
  enqueueRegionTranslate,
  jobSnapshot,
  regionQueueSnapshot,
  startAiTranslate,
  startFillMissing,
  startRereadBatch,
  startSuggestAlternatives,
} from "$lib/server/aiTranslate";
import {
  parseTranslateEngine,
} from "$lib/server/cliTranslate";
import { listDetectors } from "$lib/server/detect";
import {
  fail,
  messageOf,
  requireEdit,
  requireEpisodeAccess,
  requireFullAi,
  requireUser,
  statusOf,
} from "$lib/server/http";
import { parseOcrLang } from "$lib/server/ocr";
import { listImages } from "$lib/server/queries";
import { OCR_LANGS, OCR_LANG_LABELS } from "$lib/types";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals, params }) => {
  try {
    const user = requireUser(locals.user);
    const { episode, series } = await requireEpisodeAccess(user, params.eid);
    return json({
      job: jobSnapshot(episode.id),
      queue: regionQueueSnapshot(episode.id),
      engines: await engineReadiness(),
      detectors: listDetectors(),
      langs: OCR_LANGS.map((id) => ({ id, label: OCR_LANG_LABELS[id] })),
      lang: preferences(episode.id, series.id).lang,
    });
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
  try {
    const user = requireUser(locals.user);
    const { episode, series } = await requireEpisodeAccess(user, params.eid);
    const imgs = await listImages(episode.id);
    if (!imgs.length)
      return fail(400, "Upload raws before running AI translate");
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const task = body.action === "reread-missing" ||
      (typeof body.imageId === "string" && body.x != null && body.y != null)
      ? "vision" : "translate";
    const selected = resolveTaskModel(preferences(episode.id, series.id).regionAi, task, {
      engine: body.engine == null ? undefined : parseTranslateEngine(body.engine),
      model: typeof body.model === "string" ? body.model : undefined,
    });
    if (body.action === "fill-missing") {
      requireEdit(user);
      if (body.imageId !== undefined && typeof body.imageId !== "string")
        return fail(400, "Invalid page");
      return json(await startFillMissing({
        imageId: body.imageId as string | undefined,
        series, episode, user, engine: selected.engine,
        lang: parseOcrLang(body.lang ?? preferences(episode.id, series.id).lang),
        model: selected.model,
      }), { status: 202 });
    }
    await assertEngineReady(selected.engine, selected.model);
    if (body.action === "reread-missing") {
      requireEdit(user);
      if (body.imageId !== undefined && typeof body.imageId !== "string")
        return fail(400, "Invalid page");
      return json(await startRereadBatch({
        imageId: body.imageId as string | undefined,
        series, episode, user, engine: selected.engine,
        lang: parseOcrLang(body.lang ?? preferences(episode.id, series.id).lang),
        model: selected.model,
      }), { status: 202 });
    }
    if (body.action === "suggest-alternatives") {
      requireEdit(user);
      if (typeof body.lineId !== "string") return fail(400, "Choose a region");
      const savedEnquire = preferences(episode.id, series.id).regionAi?.enquire;
      if (savedEnquire?.engine) await assertEngineReady(savedEnquire.engine, savedEnquire.model);
      return json(
        await startSuggestAlternatives({
          series,
          episode,
          user,
          lineId: body.lineId,
          expectedRevision:
            typeof body.expectedRevision === "number"
              ? body.expectedRevision
              : undefined,
          engine: selected.engine,
          lang: parseOcrLang(body.lang ?? preferences(episode.id, series.id).lang),
          model: selected.model,
        }),
        { status: 202 },
      );
    }
    if (typeof body.imageId === "string" && body.x != null && body.y != null) {
      requireEdit(user);
      const queued = enqueueRegionTranslate({
        series,
        episode,
        user,
        imageId: body.imageId,
        forceVision: body.forceVision === true,
        lineId: typeof body.lineId === "string" ? body.lineId : undefined,
        expectedRevision:
          typeof body.expectedRevision === "number"
            ? body.expectedRevision
            : undefined,
        x: Number(body.x),
        y: Number(body.y),
        w: Number(body.w),
        h: Number(body.h),
        engine: selected.engine,
        lang: parseOcrLang(body.lang ?? preferences(episode.id, series.id).lang),
        model: selected.model,
      });
      return json({ ok: true, ...queued }, { status: 202 });
    }
    requireFullAi(user);
    const pageIds = [
      ...(typeof body.imageId === "string" ? [body.imageId] : []),
      ...(Array.isArray(body.imageIds)
        ? body.imageIds.filter((id): id is string => typeof id === "string")
        : []),
    ];
    const job = startAiTranslate({
      series,
      episode,
      user,
      replace: pageIds.length ? true : Boolean(body.replace),
      engine: selected.engine,
      lang: parseOcrLang(body.lang ?? preferences(episode.id, series.id).lang),
      model: selected.model,
      imageIds: pageIds.length ? pageIds : undefined,
    });
    return json({ ok: true, job }, { status: 202 });
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};

export const DELETE: RequestHandler = async ({ locals, params, url }) => {
  try {
    const user = requireUser(locals.user);
    requireEdit(user);
    const { episode } = await requireEpisodeAccess(user, params.eid);
    if (url.searchParams.get("queue") === "1") {
      return json({ ok: true, queue: cancelRegionQueue(episode.id) });
    }
    return json({ ok: true, job: cancelAiTranslate(episode.id) });
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};
