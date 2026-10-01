import {
  engineReadiness,
} from "$lib/server/engineReadiness";
import { json } from "@sveltejs/kit";
import {
  cancelAiTranslate,
  jobSnapshot,
  startAiTranscribe,
  startRegionOcr,
} from "$lib/server/aiTranslate";
import { listDetectors, parseDetectConf } from "$lib/server/detect";
import { resolveDetector } from "$lib/server/detectorConfig";
import { parseDetectorSetup } from "$lib/detectorSetup";
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
    const { episode } = await requireEpisodeAccess(user, params.eid);
    return json({
      job: jobSnapshot(episode.id),
      engines: await engineReadiness(),
      detectors: listDetectors(),
      detection: resolveDetector(episode.id),
      langs: OCR_LANGS.map((id) => ({ id, label: OCR_LANG_LABELS[id] })),
      lang: parseOcrLang(undefined),
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
      return fail(400, "Upload raws before running transcription");
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    requireFullAi(user);
    if (typeof body.lineId === "string") {
      return json(
        startRegionOcr({
          series,
          episode,
          user,
          lineId: body.lineId,
          expectedRevision: Number.isInteger(body.expectedRevision)
            ? Number(body.expectedRevision)
            : undefined,
          lang: parseOcrLang(body.lang),
        }),
        { status: 202 },
      );
    }
    const pageIds = [
      ...(typeof body.imageId === "string" ? [body.imageId] : []),
      ...(Array.isArray(body.imageIds)
        ? body.imageIds.filter((id): id is string => typeof id === "string")
        : []),
    ];
    // Normally unset: the chapter's saved setup, else the admin default, runs.
    const detectorSetup = body.detectorSetup == null ? undefined : parseDetectorSetup(body.detectorSetup);
    if (body.detectorSetup != null && !detectorSetup) return fail(400, "Unknown detector setup");
    const job = startAiTranscribe({
      series,
      episode,
      user,
      detectorSetup,
      detectConf: parseDetectConf(body.detectConf),
      lang: parseOcrLang(body.lang),
      imageIds: pageIds.length ? pageIds : undefined,
    });
    return json({ ok: true, job }, { status: 202 });
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  try {
    const user = requireUser(locals.user);
    requireEdit(user);
    const { episode } = await requireEpisodeAccess(user, params.eid);
    return json({ ok: true, job: cancelAiTranslate(episode.id) });
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};
