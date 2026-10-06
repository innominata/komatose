import { shareRegionComparison } from '$lib/server/sharedComparison';
import { holdManagedModel } from '$lib/server/managedModels';
import { resolveLiveAssistant } from '$lib/server/assistantRoute';
import { json } from "@sveltejs/kit";
import {
  requireUser,
  requireEdit,
  requireEpisodeAccess,
  fail,
  statusOf,
  messageOf,
} from "$lib/server/http";
import {
  advisoryModel,
  ENQUIRY_SYSTEM,
  reviewSource,
  validateModel,
  validateReviewers,
  validateHistory,
  validateContext,
  regionTarget,
  regionImage,
  enquiryContext,
  parseAdvisory,
  saveAdvisory,
} from "$lib/server/regionAi";
import { reviseEnglish } from "$lib/server/reviseEnglish";
import {
  croppedPageMask,
  detectReviewMask,
  parseReviewMaskPng,
  regionReviewCrop,
} from "$lib/server/reviewMask";
import { saveCleanExample, parseComparisonFormat, regionComparison } from "$lib/server/regionCompare";
import { WorkflowError } from "$lib/server/workflowStore";
import { preferences } from "$lib/server/workflowService";
import { regionAiSettings } from "$lib/regionAi";
import { glossaryPrompt } from "$lib/glossary";
import { readHandwriting } from "$lib/server/handwriteOcr";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const releases: Array<() => void> = [];
  const reserve = async (models: Array<{ engine: string; model: string }>) => {
    for (const model of models) {
      const resolved = resolveLiveAssistant(model.engine, model.model);
      releases.push(await holdManagedModel(resolved.row.id, Boolean(resolved.row.managedLaunch), request.signal));
    }
  };
  try {
    const user = requireUser(locals.user);
    requireEdit(user);
    const { series, episode } = await requireEpisodeAccess(user, params.eid);
    const payload: unknown = await request.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new WorkflowError("Invalid AI request");
    const b = payload as Record<string, unknown>;
    const { line, page, pages } = await regionTarget(
      series,
      episode,
      b.lineId,
      b.expectedRevision,
    );
    if (b.action === "save-clean-example") return json(saveCleanExample(episode, line, page));
    if (b.action === "share-comparison") {
      const tokens = Array.isArray(b.exampleTokens) ? b.exampleTokens.filter((v): v is string => typeof v === "string") : [];
      return json(await shareRegionComparison(series, episode, line, page, tokens));
    }
    if (b.action === "detect-mask") {
      if (!page) throw new WorkflowError("Region needs image bounds");
      const expansion = b.expansion == null ? 3 : Number(b.expansion);
      const mask = await detectReviewMask(series, episode, line, page, expansion, request.signal);
      return json({ mask: `data:image/png;base64,${mask.toString("base64")}` });
    }
    if (b.action === "review") {
      const reviewers = validateReviewers(b.reviewers, b.selectedReviewer);
      await reserve(reviewers);
      if (!page) throw new WorkflowError("Region needs image bounds");
      const mask = b.mask != null ? parseReviewMaskPng(b.mask)
        : b.maskEnabled === false ? undefined
        : await detectReviewMask(series, episode, line, page, b.expansion, request.signal);
      const crop = await regionReviewCrop(series, episode, line, page, mask);
      const results = [];
      // Sequential calls also support local servers that load one model at a time.
      for (const model of reviewers) {
        try {
          request.signal.throwIfAborted();
          const prefs = preferences(episode.id, series.id);
          const translate = regionAiSettings(prefs.regionAi).translate;
          const result = await reviewSource(model, crop, request.signal, prefs.lang, {
            engine: translate.engine,
            model: translate.model,
            lang: prefs.lang,
            seriesGlossary: glossaryPrompt(series.glossary || [], 80),
            seriesNotes: [series.notes, prefs.aliases, prefs.translationPreferences].filter(Boolean).join("\n"),
          });
          request.signal.throwIfAborted();
          results.push({
            model,
            answer: result.answer,
            cards: saveAdvisory(episode.id, line, model, result, true),
          });
        } catch (e) {
          if (request.signal.aborted) throw e;
          results.push({ model, error: messageOf(e), cards: [] });
        }
      }
      return json({ results });
    }
    if (b.action === "read-drawing") {
      const prefs = preferences(episode.id, series.id);
      if (prefs.lang !== "japanese")
        throw new WorkflowError("Handwritten kanji entry is only available for Japanese chapters.");
      const result = await readHandwriting(b.image, request.signal, { model: regionAiSettings(prefs.regionAi).vision });
      return json(result);
    }
    if (b.action === "revise") {
      const model = validateModel(b.model);
      await reserve([model]);
      const samples = b.samples == null ? undefined : Number(b.samples);
      if (samples != null && (!Number.isInteger(samples) || samples < 1 || samples > 5))
        throw new WorkflowError("Choose 1 to 5 revision samples");
      const result = await reviseEnglish({
        series,
        episode,
        line,
        model,
        samples,
        selected: b.selected === true,
        abort: request.signal,
      });
      return json(result);
    }
    if (b.action !== "enquire") throw new WorkflowError("Unknown AI action");
    const model = validateModel(b.model);
    await reserve([model]);
    const history = validateHistory(b.history);
    const context = await enquiryContext(
      series,
      episode,
      line,
      page,
      pages,
      validateContext(b.context),
    );
    const result = parseAdvisory(
      await advisoryModel(
        model,
        ENQUIRY_SYSTEM,
        `Selected context: ${context.text}\nAttached images, in order: ${JSON.stringify(context.attachments)}\nConversation: ${JSON.stringify(history)}`,
        context.images,
        request.signal,
      ),
    );
    request.signal.throwIfAborted();
    return json({
      answer: result.answer,
      cards: saveAdvisory(episode.id, line, model, result),
    });
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  } finally { for (const release of releases) release(); }
};

export const GET: RequestHandler = async ({ locals, params, url }) => {
  try {
    const user = requireUser(locals.user);
    const { series, episode } = await requireEpisodeAccess(user, params.eid);
    const { line, page } = await regionTarget(
      series,
      episode,
      url.searchParams.get("lineId"),
      Number(url.searchParams.get("revision")),
    );
    const variant = url.searchParams.get("variant");
    if (variant === "comparison") {
      if (!page) throw new WorkflowError("Region needs image bounds");
      const comparison = await regionComparison(
        series,
        episode,
        line,
        page,
        parseComparisonFormat(url.searchParams.get("format")),
      );
      return new Response(new Uint8Array(comparison.body), {
        headers: {
          "content-type": comparison.contentType,
          "cache-control": "private, no-store",
          "content-disposition": `inline; filename="${comparison.filename}"`,
        },
      });
    }
    const crop = await regionImage(series, episode, line, page);
    if (variant === "mask") {
      if (!page) throw new WorkflowError("Region needs image bounds");
      const mask = await croppedPageMask(page, line, series, episode);
      return new Response(new Uint8Array(mask), {
        headers: {
          "content-type": "image/png",
          "cache-control": "private, no-store",
        },
      });
    }
    return new Response(new Uint8Array(crop), {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "private, no-store",
      },
    });
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};
