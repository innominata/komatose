<script lang="ts">
  import { DEFAULT_CHAT_MODEL_ID } from "$lib/modelDefaults";
  import { tick } from "svelte";
  import ReviewCropMask from "./ReviewCropMask.svelte";
  import { REVIEW_CROP_ZOOMS, type ReviewCropZoom } from '$lib/brush';
  import AiModelPicker from "./AiModelPicker.svelte";
  import {
    assistantDisplayName,
    isLocalOcrReviewer,
  } from "$lib/modelRegistry";
  import {
    CONTEXT_OPTIONS,
    DEFAULT_ENQUIRY_CONTEXT,
    enginesForRegionAiField,
    isOnDemandReviewer,
    isNonLocalReviewer,
    suggestionMatchesLine,
    type AiActionCard,
    type EnquiryContext,
  } from "$lib/regionAi";
  import { providerRunGate } from "$lib/providerCatalog";
  import type { TaskEngine, EngineModelOption } from "$lib/aiTasks";
  import SourceRomanization from "./SourceRomanization.svelte";
  import CharacterEntryPanel from "./CharacterEntryPanel.svelte";
  import HelpTip from "./HelpTip.svelte";
  import {
    type GlossaryTerm,
    type LineRow,
    type OcrLang,
    type TranslateEngine,
    type TranslateEngineInfo,
  } from "$lib/types";
  import { isCharacterEntryLang } from "$lib/hangulEntry";
  import { sfxEnglishChoices } from "$lib/sfx";
  let {
    engines,
    prepare,
    call,
    decide,
    defaultModel,
    suggestions,
    imageBase,
    currentLines,
    jobs,
    lang = "japanese",
    glossary = [],
    onedit,
    onopensettings,
  }: {
    engines: TranslateEngineInfo[];
    defaultModel: TaskEngine;
    imageBase: string;
    currentLines: LineRow[];
    lang?: OcrLang;
    glossary?: GlossaryTerm[];
    onedit?: (line: LineRow, patch: Record<string, unknown>) => void;
    jobs: { kind: string; state: string; error?: string | null; progress: { lineId?: string; message?: string } }[];
    prepare: (id: string) => Promise<LineRow>;
    call: (body: Record<string, unknown>, signal: AbortSignal) => Promise<any>;
    decide: (
      id: string,
      decision: "accept" | "reject",
      force?: boolean,
      english?: string,
    ) => Promise<void>;
    suggestions: { id: string; state: string; base_revision?: number }[];
    onopensettings?: () => void;
  } = $props();
  type Entry = {
    role: "user" | "assistant";
    content: string;
    cards?: AiActionCard[];
    label?: string;
    pending?: boolean;
    idle?: boolean;
    cropScale?: ReviewCropZoom;
    /** What the reviewer was shown: crop, mask, silhouette, or trace. */
    sent?: string;
  };
  type ReviewView = "crop" | "mask" | "trace";
  const VIEWS: { id: ReviewView; label: string }[] = [
    { id: "crop", label: "Crop" },
    { id: "mask", label: "Mask" },
    { id: "trace", label: "Trace" },
  ];
  let dialog: HTMLDialogElement;
  let transcript = $state<HTMLDivElement>();
  let line = $state<LineRow | null>(null);
  const currentLine = $derived(currentLines.find(l => l.id === line?.id) ?? line);
  const translationJob = $derived(jobs.find(j => j.kind === "source-translation" && j.progress.lineId === line?.id));
  let mode = $state<"review" | "enquire">("enquire");
  let model = $state<TaskEngine>({ engine: DEFAULT_CHAT_MODEL_ID, model: "" });
  let context = $state<EnquiryContext>({ ...DEFAULT_ENQUIRY_CONTEXT });
  let entries = $state<Entry[]>([]);
  let question = $state("");
  let busy = $state(false);
  let error = $state("");
  let models = $state<Partial<Record<TranslateEngine, EngineModelOption[]>>>(
    {},
  );
  let abort: AbortController | undefined;
  const inflight = new Set<AbortController>();
  let reviewers = $state<TaskEngine[]>([]);
  let reviewing = $state(false);
  let automaticAttempted = $state(false);
  const automaticReviewerIndexes = $derived(
    reviewers.flatMap((model, i) => (isOnDemandReviewer(model, engines) ? [] : [i])),
  );
  let view = $state<ReviewView>("mask");
  const maskEnabled = $derived(view === "mask");
  /** Mask view sends the mask as black shapes instead of masked pixels. */
  let silhouette = $state(false);
  let traced = $state(false);
  let reviewCropZoom = $state<ReviewCropZoom>(1);
  let originalCropSize = $state({ width: 0, height: 0 });
  let originalCropWrapWidth = $state(0);
  let originalCropWrapHeight = $state(0);
  const originalCropScale = $derived(Math.min(4,
    Math.max(1, originalCropWrapHeight - 16) / (originalCropSize.height || 1),
    Math.max(1, originalCropWrapWidth - 16) / (originalCropSize.width || 1)) * reviewCropZoom);
  let maskReady = $state(false);
  let reviewSession = $state(0);
  let maskExpansion = $state(3);
  let detectingMask = $state(false);
  let kanaOpen = $state(false);
  const pendingReviews = $derived(entries.some((entry) => entry.pending));
  let maskEditor = $state<{ maskDataUrl: () => string; replaceMask: (url: string) => Promise<void> }>();
  let traceEditor = $state<{ maskDataUrl: () => string; hasStrokes: () => boolean }>();
  /** Why the current view cannot be sent yet, or "" when it can. */
  const viewBlocked = $derived(
    detectingMask ? "Detecting text…"
      : view === "mask" && !maskReady ? "Waiting for the mask"
      : view === "trace" && !traced ? "Trace the text first"
      : "");
  const sentLabel = $derived(view === "mask" && silhouette ? "silhouette" : view);
  const cropSrc = $derived(
    line
      ? `${imageBase}?lineId=${encodeURIComponent(line.id)}&revision=${line.revision}`
      : "",
  );
  const enquireGate = $derived(providerRunGate(model.engine, "advisory", engines));
  function reviewerLabel(model: TaskEngine) {
    // The live engine catalog knows display names for models this machine
    // discovered (CLI agents like "Grok 4.6" ship no seed row), so prefer it
    // over the seed-row registry, which can only fall back to the raw id.
    return (
      engines.find((row) => row.id === model.engine)?.label ||
      assistantDisplayName(model.engine, model.model)
    );
  }
  function idlePanels(list: TaskEngine[]): Entry[] {
    return list.map((model) => {
      const onDemand = isOnDemandReviewer(model, engines);
      return {
        role: "assistant" as const,
        label: reviewerLabel(model),
        content: onDemand
          ? `Not run automatically. Use Run to request ${reviewerLabel(model)}.`
          : "Waiting for text detection, then this model will run.",
        pending: false,
        idle: onDemand,
      };
    });
  }
  function abortReviews() {
    abort?.abort();
    abort = undefined;
    for (const controller of inflight) controller.abort();
    inflight.clear();
    reviewing = false;
    detectingMask = false;
    entries = entries.map((entry, i) => entry.pending
      ? { ...entry, pending: false, idle: isOnDemandReviewer(reviewers[i], engines), content: "Review cancelled. Run again to retry." }
      : entry);
  }
  const sessions = new Map<
    string,
    { entries: Entry[]; context: EnquiryContext; model: TaskEngine }
  >();
  function remember() {
    if (mode === "enquire" && line)
      sessions.set(line.id, {
        entries: $state.snapshot(entries),
        context: $state.snapshot(context),
        model: $state.snapshot(model),
      });
  }
  function close() {
    abortReviews();
    remember();
    kanaOpen = false;
    dialog.close();
  }
  export async function open(
    target: LineRow,
    nextMode: "review" | "enquire",
    selectedReviewers: TaskEngine[] = [],
  ) {
    abortReviews();
    mode = nextMode;
    line = target;
    reviewers = selectedReviewers.map(model => ({ ...model }));
    error = "";
    question = "";
    busy = false;
    reviewing = false;
    automaticAttempted = false;
    view = "mask";
    silhouette = false;
    traced = false;
    reviewCropZoom = 1;
    originalCropSize = { width: 0, height: 0 };
    maskReady = false;
    reviewSession++;
    detectingMask = false;
    kanaOpen = false;
    maskExpansion = 3;
    const session = mode === "enquire" ? sessions.get(target.id) : undefined;
    entries = session?.entries ?? (nextMode === "review" ? idlePanels(selectedReviewers) : []);
    context = session?.context ?? { ...DEFAULT_ENQUIRY_CONTEXT };
    model = session?.model ?? { ...defaultModel };
    dialog.showModal();
    if (mode !== "review") {
      try {
        const r = await fetch("/api/ai/engines");
        if (r.ok) models = (await r.json()).models;
      } catch {
        /* Allow manual IDs. */
      }
    }
  }
  export function setReviewers(selectedReviewers: TaskEngine[]) {
    // Cancel requests before changing panel indexes or the model behind a Run button.
    if (mode === "review") abortReviews();
    const next = selectedReviewers.map(model => ({ ...model }));
    const prev = reviewers;
    const previous = [...entries];
    reviewers = next;
    if (mode !== "review") return;
    entries = next.map((model) => {
      const old = prev.findIndex(
        (item) => item.engine === model.engine && item.model === model.model,
      );
      if (old >= 0 && previous[old]) return previous[old];
      return idlePanels([model])[0];
    });
  }
  async function scroll() {
    await tick();
    transcript?.scrollTo({ top: transcript.scrollHeight, behavior: "smooth" });
  }
  async function reviewAutomatic() {
    if (!automaticReviewerIndexes.length) {
      error =
        "Choose a local reviewer or enable Autorun for a model in Admin → Models. You can also use its Run button.";
      return;
    }
    if (viewBlocked) return;
    abortReviews();
    automaticAttempted = true;
    await runReviewers(automaticReviewerIndexes);
  }
  async function reviewOne(index: number) {
    if (!reviewers[index] || entries[index]?.pending) return;
    await runReviewers([index], true);
  }
  async function runReviewers(indexes: number[], individuallySelected = false) {
    // Freeze the selection before saving drafts or refreshing chapter settings.
    const selected = indexes.map(i => ({ i, model: { ...reviewers[i] } }))
      .filter(({ model }) => individuallySelected || !isOnDemandReviewer(model, engines));
    if (!selected.length || !line || viewBlocked) return;
    const targetId = line.id;
    const sentView = view;
    const sent = sentLabel;
    const useSilhouette = sentView === "mask" && silhouette;
    const cropScale = reviewCropZoom;
    const mask = sentView === "mask" ? maskEditor?.maskDataUrl() : undefined;
    const trace = sentView === "trace" ? traceEditor?.maskDataUrl() : undefined;
    error = "";
    const controller = new AbortController();
    inflight.add(controller);
    const runningAutomatic = selected.some(({ model }) => !isOnDemandReviewer(model, engines));
    if (runningAutomatic) reviewing = true;
    if (entries.length !== reviewers.length) entries = idlePanels(reviewers);
    const updatePanel = (index: number, entry: Entry) => {
      if (!controller.signal.aborted)
        entries = entries.map((current, i) => i === index ? entry : current);
    };
    for (const { i, model } of selected) {
      updatePanel(i, {
        role: "assistant",
        label: reviewerLabel(model),
        content:
          isLocalOcrReviewer(model.engine, model.model)
            ? "Queued for local review…"
            : "Waiting for response…",
        pending: true,
        idle: false,
        cropScale,
        sent,
      });
    }
    await tick();
    transcript?.scrollTo({ top: 0 });
    try {
      controller.signal.throwIfAborted();
      const current = await prepare(targetId);
      controller.signal.throwIfAborted();
      line = current;
      await Promise.all(
        selected.map(async ({ i, model }) => {
          try {
            const result = await call(
              {
                action: "review",
                lineId: current.id,
                expectedRevision: current.revision,
                reviewers: [model],
                view: sentView,
                maskEnabled: sentView === "mask",
                cropScale,
                ...(useSilhouette ? { silhouette: true } : {}),
                ...(individuallySelected ? { selectedReviewer: model } : {}),
                ...(mask ? { mask } : {}),
                ...(trace ? { trace } : {}),
              },
              controller.signal,
            );
            controller.signal.throwIfAborted();
            const r = result.results?.[0] ?? {};
            updatePanel(i, {
              role: "assistant",
              label: reviewerLabel(r.model ?? model),
              content: r.error
                ? `Review failed: ${r.error}`
                : r.answer || "Review failed: empty response",
              cards: r.cards,
              idle: false,
              cropScale,
              sent,
            });
          } catch (e) {
            if (controller.signal.aborted) return;
            updatePanel(i, {
              role: "assistant",
              label: reviewerLabel(model),
              content: `Review failed: ${e instanceof Error ? e.message : String(e)}`,
              idle: false,
              cropScale,
              sent,
            });
          }
        }),
      );
    } catch (e) {
      if (!controller.signal.aborted) {
        error = String(e);
        for (const { i } of selected) {
          if (entries[i]?.pending) {
            updatePanel(i, {
              ...entries[i],
              pending: false,
              idle: false,
              content: `Review failed: ${error}`,
            });
          }
        }
      }
    } finally {
      inflight.delete(controller);
      if (runningAutomatic && !controller.signal.aborted) {
        reviewing = entries.some(
          (entry, i) => entry.pending && !isOnDemandReviewer(reviewers[i], engines),
        );
      }
    }
  }
  async function detectMask() {
    if (!line || detectingMask) return;
    abortReviews();
    error = "";
    const controller = new AbortController();
    abort = controller;
    detectingMask = true;
    let succeeded = false;
    try {
      const current = await prepare(line.id);
      controller.signal.throwIfAborted();
      line = current;
      const result = await call(
        {
          action: "detect-mask",
          lineId: line.id,
          expectedRevision: line.revision,
          expansion: Number.isFinite(Number(maskExpansion)) ? Number(maskExpansion) : 3,
        },
        controller.signal,
      );
      controller.signal.throwIfAborted();
      if (typeof result.mask !== "string" || !result.mask)
        throw new Error("Text detection returned no mask");
      await maskEditor?.replaceMask(result.mask);
      succeeded = true;
    } catch (e) {
      if (!controller.signal.aborted) error = String(e);
    } finally {
      if (abort === controller) {
        detectingMask = false;
        // After a detection error, the editor remains available for a manual mask or retry.
        maskReady = !controller.signal.aborted;
      }
    }
    if (
      succeeded &&
      abort === controller &&
      maskEnabled &&
      automaticReviewerIndexes.length
    )
      await reviewAutomatic();
  }
  async function send() {
    if (busy || !question.trim() || !enquireGate.ok) return;
    busy = true;
    error = "";
    const controller = new AbortController();
    abort = controller;
    const text = question.trim();
    try {
      const current = await prepare(line!.id);
      controller.signal.throwIfAborted();
      line = current;
      const history = [
        ...entries.map(({ role, content, cards }) => ({
          role,
          content:
            content +
            (cards?.length
              ? `\nReplacement suggestions: ${JSON.stringify(cards.map((c) => ({ target: c.target, text: c.body, reason: c.reason, state: suggestions.find((s) => s.id === c.id)?.state || "pending" })))}`
              : ""),
        })),
        { role: "user", content: text },
      ];
      const result = await call(
        {
          action: "enquire",
          lineId: line.id,
          expectedRevision: line.revision,
          model: $state.snapshot(model),
          context: $state.snapshot(context),
          history,
        },
        controller.signal,
      );
      controller.signal.throwIfAborted();
      entries = [
        ...entries,
        { role: "user", content: text },
        {
          role: "assistant",
          content: result.answer,
          label: reviewerLabel(model),
          cards: result.cards,
        },
      ];
      question = "";
      remember();
      await scroll();
    } catch (e) {
      if (!controller.signal.aborted) error = String(e);
    } finally {
      if (abort === controller) busy = false;
    }
  }
  function suggestionChanged(cardId: string) {
    const row = suggestions.find((s) => s.id === cardId);
    return (
      !!row &&
      row.state === "pending" &&
      row.base_revision != null &&
      row.base_revision !== currentLine?.revision
    );
  }
  /** Sound-effect English like "soft/float" is applied one alternative at a time. */
  function englishChoices(card: AiActionCard) {
    const lineType = currentLine?.lineType;
    return card.target === "source"
      ? sfxEnglishChoices(card.body, card.translation ?? "", lineType)
      : sfxEnglishChoices(currentLine?.source ?? "", card.body, lineType);
  }
  async function apply(
    card: AiActionCard,
    decision: "accept" | "reject",
    english?: string,
  ) {
    error = "";
    busy = true;
    try {
      await decide(card.id, decision, false, english);
      line = await prepare(line!.id);
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
</script>


<dialog
  class="hud-dialog-controls"
  bind:this={dialog}
  class:review={mode === "review"}
  aria-label={mode === "review" ? "AI source review" : "Enquire about region"}
  oncancel={close}
  onclose={() => {
    abortReviews();
    remember();
  }}
>
  <header>
    <h2>{mode === "review" ? "Review Transcription" : "Enquire"}</h2>
    <div class="header-actions">
      {#if onopensettings}
        <button type="button" onclick={onopensettings}>AI model settings…</button>
      {/if}
      <button aria-label="Close AI dialog" onclick={close}>×</button>
    </div>
  </header>
  <div class="dialog-content">
  <div class="context-panel">
  <div class="current">
    <div class="current-row">
      <span class="current-label">Source</span>
      <div class="current-text">
        <p>{currentLine?.source || "(unreadable)"}</p>
        <SourceRomanization text={currentLine?.source ?? ""} />
      </div>
      {#if mode === "review" && isCharacterEntryLang(lang) && currentLine && onedit}
        <button
          type="button"
          class="small"
          disabled={busy}
          aria-pressed={kanaOpen}
          onclick={() => (kanaOpen = !kanaOpen)}
          >{kanaOpen ? "Show reviewers" : "Enter characters"}</button
        >
      {/if}
    </div>
    <div class="current-row">
      <span class="current-label">English</span>
      <p class="current-text">{currentLine?.body || "(empty)"}</p>
    </div>
  </div>
  {#if mode === "enquire" && translationJob}
    <p role="status">{translationJob.state === "failed" || translationJob.state === "cancelled" || translationJob.state === "interrupted"
      ? `Source translation ${translationJob.state}. ${translationJob.error || ""} See Jobs to retry.`
      : translationJob.progress.message}</p>
  {/if}
  {#if mode === "enquire"}
    <AiModelPicker
      label="Chat"
      bind:value={model}
      engines={enginesForRegionAiField("enquire", engines, model.engine)}
      {models}
      disabled={busy || entries.length > 0}
    />
    <fieldset disabled={busy || entries.length > 0}>
      <legend>Context to include</legend>
      {#each CONTEXT_OPTIONS as [key, label]}<label
          ><input type="checkbox" bind:checked={context[key]} />{label}</label
        >{/each}
    </fieldset>
    {#if entries.length}<button
        disabled={busy}
        onclick={() => {
          entries = [];
          remember();
        }}>New conversation / change context</button
      >{/if}
  {:else if line}
    <div class="modes">
      <span class="mode-tabs" role="tablist" aria-label="What reviewers are sent">
        {#each VIEWS as item (item.id)}
          <button
            type="button"
            role="tab"
            aria-selected={view === item.id}
            disabled={detectingMask && item.id !== view}
            onclick={() => (view = item.id)}>{item.label}</button
          >
        {/each}
      </span>
      {#if view === "mask"}
        <label class="check" title="Send the mask as black shapes on white instead of the masked crop. Helps with outlined or screentone-filled sound effects."
          ><input type="checkbox" bind:checked={silhouette} /> Silhouette</label
        >
      {/if}
      <HelpTip label="Review help">
        Independent readings of the same crop. Agreement is supporting evidence; inspect any
        uncertain characters before accepting.<br /><br />
        <strong>Crop</strong> sends the region as it is. <strong>Mask</strong> detects the lettering
        automatically and sends only those pixels; <em>Silhouette</em> sends the mask itself as black
        shapes, which often reads better for stylized sound effects. <strong>Trace</strong> lets you
        write the text over a faded crop and sends only your strokes.<br /><br />
        Local models and models with Autorun enabled in Admin → Models run as soon as the mask is
        ready; the others wait for their Run button. Change the view or brush the mask, then
        Resubmit. Each reading includes its English translation; ✓ applies both as a new draft.
        Hayai and PaddleOCR-VL readings use a separately labelled local translator.
      </HelpTip>
    </div>
    <div class="mode-body">
      {#key reviewSession}
        <div class="mode-pane" hidden={view !== "crop"}>
          <div class="original-crop" bind:clientWidth={originalCropWrapWidth} bind:clientHeight={originalCropWrapHeight}>
            <img
              class="review-crop"
              src={cropSrc}
              alt="Original text region sent to reviewers"
              onload={e => { const image = e.currentTarget as HTMLImageElement; originalCropSize = { width: image.naturalWidth, height: image.naturalHeight }; }}
              style={originalCropSize.width ? `width:${originalCropSize.width * originalCropScale}px;height:${originalCropSize.height * originalCropScale}px` : undefined}
            />
          </div>
          <div class="crop-tools">
            <span class="zoom-group" role="group" aria-label="Crop zoom">
              {#each REVIEW_CROP_ZOOMS as amount}<button type="button" aria-pressed={reviewCropZoom === amount}
                aria-label={`View crop at ${amount}×`} title={`View at ${amount}× and send a ${amount}× crop on the next transcription request`}
                onclick={() => (reviewCropZoom = amount)}>{amount}×</button>{/each}
            </span>
          </div>
        </div>
        <div class="mode-pane" hidden={view !== "mask"}>
          <ReviewCropMask
            bind:this={maskEditor}
            cropUrl={cropSrc}
            maskUrl={`${cropSrc}&variant=mask`}
            {silhouette}
            bind:expansion={maskExpansion}
            bind:zoom={reviewCropZoom}
            disabled={detectingMask}
            detecting={detectingMask}
            autodetect
            ondetect={detectMask}
          />
        </div>
        <div class="mode-pane" hidden={view !== "trace"}>
          <ReviewCropMask
            bind:this={traceEditor}
            variant="trace"
            cropUrl={cropSrc}
            bind:zoom={reviewCropZoom}
            onchange={() => (traced = traceEditor?.hasStrokes() ?? false)}
          />
        </div>
      {/key}
    </div>
    {#if !kanaOpen && automaticReviewerIndexes.length}
      <div class="send-row">
        <button
          class="primary"
          disabled={busy || !!viewBlocked}
          title={viewBlocked || undefined}
          onclick={() => void reviewAutomatic()}
          >{automaticAttempted || reviewing || pendingReviews ? "Resubmit" : "Send to automatic reviewers"}</button
        >
        <small>{viewBlocked || `Sends ${sentLabel} · ${reviewCropZoom}×`}</small>
      </div>
    {/if}
  {/if}
  </div>
  {#if mode === "review" && kanaOpen && isCharacterEntryLang(lang) && currentLine && onedit}
    {@const target = currentLine}
    <div class="kana-main" role="region" aria-label="Character entry">
      <CharacterEntryPanel
        {lang}
        embedded
        source={target.source ?? ""}
        {glossary}
        canEdit={!busy}
        onapply={(text) =>
          onedit(target, {
            source: text,
            sourceState: text.trim() ? "read" : "unreadable",
          })}
        oncancel={() => (kanaOpen = false)}
        onreadDrawing={(image, signal) =>
          call(
            {
              action: "read-drawing",
              lineId: target.id,
              expectedRevision: target.revision,
              image,
            },
            signal,
          )}
      />
    </div>
  {:else if mode === "review"}
  <div class="readings" bind:this={transcript} role="log" aria-label="Reviewer responses" aria-live="polite">
    <div class="reading-head" aria-hidden="true">
      <span>Model</span><span>Source</span><span>English</span><span></span>
    </div>
    {#each entries as entry, i}
      {@const runnable = isNonLocalReviewer(reviewers[i], engines)}
      {@const cards = entry.pending ? [] : entry.cards ?? []}
      <div class="reading-group" class:pending={entry.pending} aria-busy={entry.pending || undefined}>
        <div class="reading-model">
          <strong>{entry.label}</strong>
          {#if entry.sent}<small>{entry.sent} · {entry.cropScale ?? 1}×</small>{/if}
        </div>
        {#if !cards.length}
          <p class="reading-status" class:failed={entry.content.startsWith("Review failed")}
            >{#if entry.pending}<span role="status">{entry.content}</span>{:else}{entry.content}{/if}</p>
          <div class="reading-actions">
            {#if runnable}
              <button
                type="button"
                class="icon"
                disabled={busy || entry.pending || !!viewBlocked}
                aria-label={entry.idle ? `Run ${reviewerLabel(reviewers[i])}` : `Run ${reviewerLabel(reviewers[i])} again`}
                title={entry.idle ? "Run" : "Run again"}
                onclick={() => void reviewOne(i)}>{entry.idle ? "▶" : "↻"}</button
              >
            {/if}
          </div>
        {/if}
        {#each cards as card, c (card.id)}
          {@const state = suggestions.find((s) => s.id === card.id)?.state}
          {@const matchesCurrent = currentLine && suggestionMatchesLine({
            kind: card.target === "source" ? "source-review" : "enquiry",
            body: card.body,
            translation: card.translation,
          }, currentLine)}
          <div class="reading-cell source" class:first={c === 0}>
            {#if card.target === "source"}
              <span class="replacement">{card.body}</span>
              <SourceRomanization text={card.body} />
            {:else}<span class="muted">—</span>{/if}
          </div>
          {@const choices = englishChoices(card)}
          {@const open = !(state && state !== "pending") && !matchesCurrent}
          <div class="reading-cell english" class:first={c === 0}>
            {#if choices.length && open}
              <span class="choices" role="group" aria-label="English alternatives">
                {#each choices as choice (choice)}<button
                    type="button"
                    class="choice"
                    disabled={busy}
                    title={card.target === "source" ? `Use source & “${choice}”` : `Use “${choice}”`}
                    onclick={() => apply(card, "accept", choice)}>✓ {choice}</button
                  >{/each}
              </span>
            {:else}
              {card.target === "source" ? card.translation || "" : card.body}
            {/if}
          </div>
          <div class="reading-actions" class:first={c === 0}>
            {#if state && state !== "pending"}
              <span class="tag">{state === "accepted" ? "Applied" : "Rejected"}</span>
            {:else if matchesCurrent}
              <span class="tag">Current</span>
            {:else}
              {#if suggestionChanged(card.id)}<span class="stale" title="The region changed since this suggestion. Accepting replaces the current text.">!</span>{/if}
              {#if !choices.length}<button
                type="button"
                class="icon accept"
                disabled={busy}
                aria-label={card.target === "source"
                  ? card.translation ? "Use source & English" : "Use source text"
                  : "Use English"}
                title={card.target === "source"
                  ? card.translation ? "Use source & English" : "Use source text"
                  : "Use English"}
                onclick={() => apply(card, "accept")}>✓</button
              >{/if}
              <button
                type="button"
                class="icon reject"
                disabled={busy}
                aria-label="Reject"
                title="Reject"
                onclick={() => apply(card, "reject")}>✕</button
              >
            {/if}
            {#if runnable && c === 0}
              <button
                type="button"
                class="icon"
                disabled={busy || entry.pending || !!viewBlocked}
                aria-label={`Run ${reviewerLabel(reviewers[i])} again`}
                title="Run again"
                onclick={() => void reviewOne(i)}>↻</button
              >
            {/if}
          </div>
          {#if c < cards.length - 1}<span class="reading-model spacer"></span>{/if}
        {/each}
      </div>
    {/each}
  </div>
  {:else}
  <div class="transcript" bind:this={transcript} role="log" aria-label="Conversation" aria-live="polite">
    {#each entries as entry}<article class:user={entry.role === "user"} class:pending={entry.pending} aria-busy={entry.pending || undefined}>
        <strong>{entry.role === "user" ? "You" : entry.label}</strong>
        <p>{#if entry.pending}<span role="status">{entry.content}</span>{:else}{entry.content}{/if}</p>
        {#each entry.cards ?? [] as card}
          {@const state = suggestions.find((s) => s.id === card.id)?.state}
          {@const matchesCurrent = currentLine && suggestionMatchesLine({
            kind: card.target === "source" ? "source-review" : "enquiry",
            body: card.body,
            translation: card.translation,
          }, currentLine)}
          <section class="action-card">
            <strong
              >{card.target === "source"
                ? "Source reading"
                : "English suggestion"}</strong
            >
            <p class="replacement">{card.body}</p>
            {#if card.target === "source"}
              <SourceRomanization text={card.body} />
            {/if}
            {#if card.translation}
              <strong>English translation</strong>
              <p class="replacement translation">{card.translation}</p>
            {/if}
            <small>{card.reason}</small>
            {#if matchesCurrent}<p>
                Already the current {card.target === "source" ? "source and English" : "English"}.
              </p>{/if}
            {#if !matchesCurrent || (state && state !== "pending")}
            <div class="actions">
              {#if state && state !== "pending"}<span
                  >{state === "accepted" ? "Applied" : "Rejected"}</span
                >{:else}
                <button disabled={busy} onclick={() => apply(card, "accept")}
                  >{card.target === "source"
                    ? card.translation ? "Use source & English" : "Use source text"
                    : "Use English"}</button
                >
                <button disabled={busy} onclick={() => apply(card, "reject")}
                  >Reject</button
                >{/if}
            </div>
            {#if suggestionChanged(card.id)}
              <p class="stale-warning">
                The region changed since this suggestion. Accepting replaces the current text.
              </p>
            {/if}
            {/if}
          </section>{/each}
      </article>{/each}
    {#if busy}<p role="status">Working…</p>{/if}
  </div>
  {/if}
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if mode === "enquire"}<form
      onsubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <label class="question"
        >Your question<textarea
          bind:value={question}
          disabled={busy}
          rows="3"
          maxlength="12000"
          placeholder="Would a different translation fit better here?"
        ></textarea></label
      >
      <button disabled={busy || !question.trim() || !enquireGate.ok} title={enquireGate.reason || undefined} type="submit">Send</button>
      {#if !enquireGate.ok}<p role="status">{enquireGate.reason}</p>{/if}
    </form>{/if}
</dialog>

<style>
  dialog {
    color: var(--hud-text);
    background: var(--hud-bg-2);
    border: 1px solid var(--hud-teal-ink);
    border-radius: 2px;
    /* Full screen: the crop editor and every reading need the room. */
    width: 100vw;
    max-width: 100vw;
    height: 100dvh;
    max-height: 100dvh;
    margin: 0;
    box-sizing: border-box;
    padding: 0.6rem 0.8rem;
  }
  dialog[open] {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  dialog::backdrop {
    background: #000b;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-shrink: 0;
    gap: 1rem;
    margin-bottom: 0.5rem;
  }
  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  h2 {
    font-size: 1.1rem;
    margin: 0;
  }
  p {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 0.9rem;
    margin: 0.5rem 0;
  }
  .current {
    flex-shrink: 0;
    display: grid;
    gap: 0.25rem;
    padding: 0.4rem 0.5rem;
    background: var(--hud-panel);
    border: 1px solid var(--hud-line);
    max-height: 22dvh;
    overflow: auto;
  }
  .current-row {
    display: grid;
    grid-template-columns: 4rem minmax(0, 1fr) auto;
    gap: 0.5rem;
    align-items: start;
  }
  .current-label {
    font-size: 0.75rem;
    color: var(--hud-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding-top: 0.15rem;
  }
  .current-text,
  .current-text p {
    margin: 0;
    font-size: 0.9rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .dialog-content {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    gap: 0.8rem;
  }
  .review .dialog-content {
    display: grid;
    grid-template-columns: minmax(300px, 34%) minmax(0, 1fr);
  }
  .context-panel {
    min-width: 0;
    max-height: 45%;
    overflow-y: auto;
  }
  .review .context-panel {
    max-height: none;
    /* Short screens scroll the panel instead of overlapping its rows. */
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .modes {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
    flex-shrink: 0;
  }
  .mode-tabs {
    display: inline-flex;
    border: 1px solid var(--hud-line);
  }
  .mode-tabs button {
    border: 0;
    border-radius: 0;
    padding: 0.3rem 0.9rem;
    font-size: 0.8rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .mode-tabs button[aria-selected="true"] {
    background: var(--hud-teal-ink);
    color: var(--hud-bg-2);
  }
  .check {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.8rem;
  }
  .mode-body {
    flex: 1 1 0;
    min-height: 240px;
    display: flex;
    flex-direction: column;
  }
  .mode-pane {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .mode-pane[hidden] {
    display: none;
  }
  .original-crop {
    flex: 1 1 0;
    min-height: 120px;
    overflow: auto;
    background: #111;
    display: grid;
    place-items: safe center;
  }
  .review-crop {
    display: block;
    background: white;
  }
  .crop-tools {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-shrink: 0;
  }
  .zoom-group { display: inline-flex; gap: 2px; }
  .zoom-group button { padding: 0.2rem 0.5rem; font-size: 0.8rem; }
  .zoom-group button[aria-pressed="true"] { background: var(--hud-teal-dim); }
  .send-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-shrink: 0;
  }
  .send-row small {
    color: var(--hud-muted);
  }
  fieldset {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
    margin: 0.8rem 0;
  }
  legend {
    font-size: 0.9rem;
  }
  fieldset label {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.85rem;
  }
  .readings {
    min-height: 0;
    min-width: 0;
    overflow-y: auto;
    align-content: start;
    display: grid;
    grid-template-columns: minmax(9rem, 13rem) minmax(0, 1fr) minmax(0, 1fr) auto;
    border-top: 1px solid var(--hud-line);
  }
  .reading-head,
  .reading-group {
    display: contents;
  }
  .reading-head span {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--hud-bg-2);
    font-size: 0.7rem;
    color: var(--hud-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 0.3rem 0.5rem;
    border-bottom: 1px solid var(--hud-line);
  }
  .reading-model,
  .reading-cell,
  .reading-status,
  .reading-actions {
    padding: 0.35rem 0.5rem;
    border-bottom: 1px solid var(--hud-line);
    min-width: 0;
  }
  .reading-model {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    font-size: 0.85rem;
  }
  .reading-model small {
    color: var(--hud-muted);
    font-size: 0.7rem;
  }
  .reading-model.spacer {
    border-bottom: 1px solid var(--hud-line);
  }
  .reading-status {
    grid-column: span 2;
    margin: 0;
    font-size: 0.85rem;
    color: var(--hud-muted);
    white-space: normal;
  }
  .reading-status.failed {
    color: var(--hud-danger);
  }
  .pending .reading-status {
    font-style: italic;
  }
  .reading-cell {
    font-size: 0.9rem;
    overflow-wrap: anywhere;
  }
  .reading-cell.english {
    color: var(--hud-suggestion-en);
  }
  .replacement {
    font-size: 1.05rem;
    line-height: 1.5;
  }
  .reading-actions {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    justify-content: flex-end;
    white-space: nowrap;
  }
  .icon {
    width: 28px;
    height: 28px;
    padding: 0;
    display: grid;
    place-items: center;
    font-size: 0.95rem;
    line-height: 1;
  }
  .icon.accept:not(:disabled):hover {
    background: var(--hud-teal-dim);
    color: var(--hud-teal-ink);
  }
  .icon.reject:not(:disabled):hover {
    color: var(--hud-danger);
  }
  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .choice {
    padding: 0.15rem 0.55rem;
    font-size: 0.85rem;
    color: var(--hud-suggestion-en);
  }
  .choice:not(:disabled):hover {
    background: var(--hud-teal-dim);
    color: var(--hud-teal-ink);
  }
  .tag {
    font-size: 0.75rem;
    color: var(--hud-muted);
  }
  .stale {
    color: #ffc283;
    font-weight: 700;
    padding: 0 0.2rem;
    cursor: help;
  }
  .muted {
    color: var(--hud-muted);
  }
  .transcript,
  .kana-main {
    flex: 1;
    min-height: 100px;
    overflow-y: auto;
    min-width: 0;
    padding-right: 0.4rem;
  }
  .kana-main {
    display: flex;
    flex-direction: column;
  }
  .kana-main :global(.kana-entry),
  .kana-main :global(.korean-entry) {
    flex: 1;
  }
  article {
    padding: 0.8rem;
    margin: 0.5rem 0;
    background: var(--hud-bg-2);
    border-radius: 2px;
  }
  article.user {
    background: var(--hud-teal-dim);
  }
  article.pending p {
    color: var(--hud-muted);
    font-style: italic;
  }
  .action-card {
    border: 1px solid var(--hud-teal-ink);
    padding: 0.8rem;
    margin: 0.7rem 0 0;
    border-radius: 2px;
    background: var(--hud-teal-dim);
  }
  .action-card .replacement {
    margin-bottom: 1rem;
  }
  small {
    color: var(--hud-muted);
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.5rem;
    flex-wrap: wrap;
  }
  .question {
    display: grid;
    gap: 0.3rem;
  }
  textarea {
    width: 100%;
    background: var(--hud-input-bg);
    color: var(--hud-text);
    border: 1px solid var(--hud-line);
    border-radius: 2px;
    padding: 0.6rem;
  }
  button {
    padding: 0.4rem 0.7rem;
  }
  button.small {
    padding: 0.15rem 0.5rem;
    font-size: 0.75rem;
  }
  button:disabled {
    opacity: 0.5;
  }
  .error {
    color: #ffb5a9;
    max-height: 15dvh;
    overflow-y: auto;
    flex-shrink: 0;
  }
  .stale-warning {
    color: #ffc283;
  }
  @media (max-width: 800px) {
    /* Phones: one scrolling column, crop editor at a fixed height. */
    .review .dialog-content {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto auto;
      overflow-y: auto;
    }
    .review .context-panel {
      overflow: visible;
    }
    .mode-body {
      flex: none;
      height: 38dvh;
      min-height: 0;
    }
    .readings {
      overflow: visible;
    }
    .readings {
      grid-template-columns: minmax(6rem, 8rem) minmax(0, 1fr) minmax(0, 1fr) auto;
    }
  }
</style>
