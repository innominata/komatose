import { assertTranslationLanguage, type TranslationModel } from '../translationModels';
import { normalizeTranslation } from '../translationText';
import { sfxTranslateHit, withSfxGlossary } from '../sfx';
import type { DetectedBox, TranslateScriptOpts } from './llm';
import { completeTranslation, type TranslationRequest } from './translationRuntime';
import { appendJobLog, extractJobLogUsage, jobContext } from './jobs';

export function specialistRequest(model: TranslationModel, source: string, opts: TranslateScriptOpts): TranslationRequest {
  const context = [opts.seriesNotes, opts.pageCaption].filter(Boolean).join('\n\n');
  const contextPrefix = context ? `Context only (do not translate this context or print speaker labels):\n${context}\n\n` : '';
  const lang = opts.lang ?? 'japanese';
  assertTranslationLanguage(model, lang);
  // OCR can return vertically stacked Hangul one syllable per line. Preserve
  // the saved source, but present the reconstructed word to the translator.
  const characterLines = source.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lang === 'korean' && characterLines.filter(line => /^[가-힣]$/u.test(line)).length >= 2
      && characterLines.every(line => /^(?:[가-힣]|[!?….,:;~\-]+)$/u.test(line))) source = characterLines.join('');
  if (model.profile === 'hy-manga') {
    const glossary = (opts.seriesGlossary || '').replace(/ → /g, ' translates to ').trim();
    return {
      messages: [{ role: 'user', content:
        contextPrefix + (glossary ? `Reference the following manga translations:\n${glossary}\n\n` : '') +
        'Translate the following text from Japanese into English as natural, concise manga dialogue. Preserve specific nouns, exact meaning, speaker intent, tone, punctuation, and sound effects. Output only the translated result without any explanation:\n\n' + source.trim(),
      }],
      temperature: opts.temperature ?? 0.15, top_k: 20, top_p: 0.6, min_p: 0, repeat_penalty: 1.05,
      samplers: ['penalties', 'top_k', 'top_p', 'temperature'], max_tokens: 512,
    };
  }
  if (model.profile === 'hy-mt') {
    const glossary = (opts.seriesGlossary || '').replace(/ → /g, ' translates to ').trim();
    const instruction = glossary
      ? 'Translate the following text into English. Note that you must ONLY output the translated result without any additional explanation:\n'
      : 'Translate the following text into English. Note that you should only output the translated result without any additional explanation:\n';
    return {
      messages: [{ role: 'user', content:
        contextPrefix + (glossary ? `Reference the following translations:\n${glossary}\n` : '') + instruction + source.trim(),
      }],
      temperature: 0.7, top_k: 20, top_p: 0.8, repeat_penalty: 1.05,
      samplers: ['penalties', 'top_k', 'top_p', 'temperature'], max_tokens: 512,
    };
  }
  if (model.profile === 'cat-translate') {
    return {
      messages: [{ role: 'user', content: `Translate the following Japanese text into English. Output only the translation.\n\n${source.trim()}` }],
      temperature: 0, repeat_penalty: 1, max_tokens: 512,
    };
  }
  if (model.profile === 'translategemma') {
    return {
      messages: [{ role: 'user', content: source.trim() }],
      temperature: 0, repeat_penalty: 1, max_tokens: 512,
      chat_template_kwargs: { source_lang_code: lang === 'korean' ? 'ko' : 'ja', target_lang_code: 'en' },
    };
  }
  if (model.profile === 'shisa') {
    const glossary = (opts.seriesGlossary || '').replace(/ → /g, ' translates to ').trim();
    return {
      messages: [
        { role: 'system', content: 'You are a Japanese-to-English manga translator. Reply with only the English for the given lettering. No speaker names, stage directions, invented sound effects, quotes around the line, or extra sentences.' },
        { role: 'user', content: contextPrefix + (glossary ? `Glossary:\n${glossary}\n\n` : '') + source.trim() },
      ],
      temperature: opts.temperature ?? 0.15, top_k: 20, top_p: 0.6, min_p: 0, repeat_penalty: 1.1,
      samplers: ['penalties', 'top_k', 'top_p', 'temperature'], max_tokens: 96, stop: ['\n\n'],
      chat_template_kwargs: { enable_thinking: false },
    };
  }
  if (model.profile === 'opus-mt-ja-en' || model.profile === 'sugoi-ja-en') {
    return {
      messages: [{ role: 'user', content: source.trim() }],
      temperature: 0, repeat_penalty: 1, max_tokens: 256,
    };
  }
  return {
    messages: [{ role: 'user', content: source.trim() }],
    temperature: 0, repeat_penalty: 1, max_tokens: 128,
  };
}

function specialistText(content: string): string {
  return normalizeTranslation(
    content.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim(),
  );
}

export function parseSpecialistTranslation(result: unknown): string {
  const payload = result as { choices?: { finish_reason?: string; message?: { content?: unknown } }[] };
  const choice = payload?.choices?.[0];
  if (choice?.finish_reason === 'length')
    throw new Error('Translation reached its output limit. Split this source region and retry; existing text was preserved.');
  if (choice?.finish_reason && choice.finish_reason !== 'stop')
    throw new Error(`Translation did not complete (${choice.finish_reason}); existing text was preserved.`);
  if (typeof choice?.message?.content !== 'string') throw new Error('Translation model returned no text');
  const text = specialistText(choice.message.content);
  if (!text || /<\/?think>|<\|im_start\|>|<\|im_end\|>/i.test(text))
    throw new Error('Translation model returned empty or invalid output; existing text was preserved.');
  return text;
}

function logSpecialist(model: TranslationModel, request: string, response?: string, error?: string, usage?: ReturnType<typeof extractJobLogUsage>) {
  const ctx = jobContext();
  if (!ctx) return;
  appendJobLog(ctx.jobId, { engine: model.id, model: model.id, request, response, error, usage });
}

/** Native text output, one region per request: no JSON grammar or guessed line alignment. */
export async function translateWithSpecialist(
  model: TranslationModel,
  boxes: DetectedBox[],
  opts: TranslateScriptOpts,
  complete: typeof completeTranslation = completeTranslation,
): Promise<DetectedBox[]> {
  const nextOpts = { ...opts, seriesGlossary: withSfxGlossary(opts.seriesGlossary, boxes.map((box) => box.source)) };
  const translated: DetectedBox[] = [];
  const needModel = boxes.some((box) => box.source.trim() && !sfxTranslateHit(box.source));
  if (needModel) assertTranslationLanguage(model, opts.lang ?? 'japanese');
  for (const box of boxes) {
    opts.abort?.throwIfAborted();
    if (!box.source.trim()) { translated.push({ ...box }); continue; }
    const sfx = sfxTranslateHit(box.source);
    if (sfx) {
      translated.push({ ...box, ...sfx });
      logSpecialist(model, box.source, sfx.translation, undefined, { durationMs: 0 });
      continue;
    }
    const request = specialistRequest(model, box.source, box.speaker ? {
      ...nextOpts, pageCaption: [nextOpts.pageCaption, `Speaker of this region (not necessarily the person addressed): ${box.speaker}`].filter(Boolean).join('\n\n'),
    } : nextOpts);
    const started = Date.now();
    let raw: unknown;
    let body: string | undefined;
    let failure: string | undefined;
    try {
      raw = await complete(model, request, opts.abort);
      opts.abort?.throwIfAborted();
      body = parseSpecialistTranslation(raw);
      translated.push({ ...box, translation: body, literal: '', reasoning: `Translated by ${model.label}.` });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      logSpecialist(
        model,
        request.messages.map((message) => `${message.role}: ${message.content}`).join('\n\n'),
        body ?? (raw == null ? undefined : JSON.stringify(raw)),
        failure,
        extractJobLogUsage(raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}, Date.now() - started),
      );
    }
  }
  return translated;
}
