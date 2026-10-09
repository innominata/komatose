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
  import KanaEntryPanel from "./KanaEntryPanel.svelte";
  import {
    type GlossaryTerm,
    type LineRow,
    type OcrLang,
    type TranslateEngine,
    type TranslateEngineInfo,
  } from "$lib/types";
  import { isKanaEntryLang } from "$lib/kanaChart";
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
  };
  let dialog: HTMLDialogElement;
  let transcript: HTMLDivElement;
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
  let maskEnabled = $state(true);
  let reviewCropZoom = $state<ReviewCropZoom>(1);
  let originalCropSize = $state({ width: 0, height: 0 });
  let originalCropWrapWidth = $state(0);
  const originalCropScale = $derived(Math.min(1, 360 / (originalCropSize.height || 1),
    (originalCropWrapWidth || originalCropSize.width || 1) / (originalCropSize.width || 1)) * reviewCropZoom);
  let maskReady = $state(false);
  let reviewSession = $state(0);
  let maskExpansion = $state(3);
  let detectingMask = $state(false);
  let kanaOpen = $state(false);
  const pendingReviews = $derived(entries.some((entry) => entry.pending));
  let maskEditor = $state<{ maskDataUrl: () => string; replaceMask: (url: string) => Promise<void> }>();
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
    maskEnabled = true;
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
    if (detectingMask || (maskEnabled && !maskReady)) return;
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
    if (!selected.length || !line || detectingMask || (maskEnabled && !maskReady)) return;
    const targetId = line.id;
    const useMask = maskEnabled;
    const cropScale = reviewCropZoom;
    const mask = useMask ? maskEditor?.maskDataUrl() : undefined;
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
                maskEnabled: useMask,
                cropScale,
                ...(individuallySelected ? { selectedReviewer: model } : {}),
                ...(mask ? { mask } : {}),
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
            });
          } catch (e) {
            if (controller.signal.aborted) return;
            updatePanel(i, {
              role: "assistant",
              label: reviewerLabel(model),
              content: `Review failed: ${e instanceof Error ? e.message : String(e)}`,
              idle: false,
              cropScale,
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
  async function apply(
    card: AiActionCard,
    decision: "accept" | "reject",
  ) {
    error = "";
    busy = true;
    try {
      await decide(card.id, decision);
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
    <h2>{mode === "review" ? "Review Transcription · source & English" : "Enquire"}</h2>
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
    <strong>Current source</strong>
    <p>{currentLine?.source || "(unreadable)"}</p>
    <SourceRomanization text={currentLine?.source ?? ""} />
    {#if mode === "review" && isKanaEntryLang(lang) && currentLine && onedit}
      <button
        type="button"
        disabled={busy}
        aria-pressed={kanaOpen}
        onclick={() => (kanaOpen = !kanaOpen)}
        >{kanaOpen ? "Show reviewers" : "Enter characters"}</button
      >
    {/if}
    <strong>Current English</strong>
    <p>{currentLine?.body || "(empty)"}</p>
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
  {:else}
    {#if line}
      <label class="mask-toggle"
        ><input
          type="checkbox"
          bind:checked={maskEnabled}
          onchange={() => { maskReady = false; }}
          disabled={detectingMask}
        /> Mask crop with detected text</label
      >
      {#if maskEnabled}
        {#key reviewSession}
        <ReviewCropMask
          bind:this={maskEditor}
          cropUrl={cropSrc}
          maskUrl={`${cropSrc}&variant=mask`}
          bind:expansion={maskExpansion}
          bind:zoom={reviewCropZoom}
          disabled={detectingMask}
          detecting={detectingMask}
          autodetect
          ondetect={detectMask}
        />
        {/key}
      {:else}
        <div class="original-crop" bind:clientWidth={originalCropWrapWidth}>
        <img
          class="review-crop"
          src={cropSrc}
          alt="Original text region sent to reviewers"
          onload={e => { const image = e.currentTarget as HTMLImageElement; originalCropSize = { width: image.naturalWidth, height: image.naturalHeight }; }}
          style={originalCropSize.width ? `width:${originalCropSize.width * originalCropScale}px;height:${originalCropSize.height * originalCropScale}px` : undefined}
        />
        </div>
        <span class="zoom-group" role="group" aria-label="Crop zoom">
          {#each REVIEW_CROP_ZOOMS as amount}<button type="button" aria-pressed={reviewCropZoom === amount}
            aria-label={`View crop at ${amount}×`} onclick={() => (reviewCropZoom = amount)}>{amount}×</button>{/each}
        </span>
      {/if}
      <p class="review-hint">Next transcription request: {reviewCropZoom}× crop. Use Resubmit or Run again after changing scale.</p>
    {/if}
    <p class="review-hint">
      Independent readings of the same crop. Agreement is supporting evidence;
      inspect any uncertain characters before accepting.
      Text masking starts automatically, then local models and models with Autorun
      enabled in Admin → Models run on that crop. Brush or erase and resubmit to refine while other
      models are still running, or turn masking off to send the original crop.
      Models without Autorun stay idle until you press Run on their panel.
      Each response includes its English translation.
      Accepting applies both the source and the displayed English as a new draft.
      Hayai and PaddleOCR-VL readings use a separately labelled local translator.
    </p>{/if}
  </div>
  {#if mode === "review" && kanaOpen && isKanaEntryLang(lang) && currentLine && onedit}
    {@const target = currentLine}
    <div class="kana-main" role="region" aria-label="Character entry">
      <KanaEntryPanel
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
  {:else}
  <div class="transcript" class:review-responses={mode === "review"} bind:this={transcript} role="log" aria-label={mode === "review" ? "Reviewer responses" : "Conversation"} aria-live="polite">
    {#each entries as entry, i}<article class:user={entry.role === "user"} class:pending={entry.pending} aria-busy={entry.pending || undefined}>
        <strong>{entry.role === "user" ? "You" : entry.label}</strong>
        {#if mode === 'review' && entry.cropScale}<small class="sent-scale">Sent crop: {entry.cropScale}×</small>{/if}
        <p>{#if entry.pending}<span role="status">{entry.content}</span>{:else}{entry.content}{/if}</p>
        {#if mode === "review" && isNonLocalReviewer(reviewers[i], engines)}
          <div class="actions">
            <button
              disabled={busy || entry.pending || detectingMask || (maskEnabled && !maskReady)}
              onclick={() => void reviewOne(i)}
              >{entry.idle
                ? `Run ${reviewerLabel(reviewers[i])}`
                : `Run ${reviewerLabel(reviewers[i])} again`}</button
            >
          </div>
        {/if}
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
            {#if mode === "enquire"}<small>{card.reason}</small>{/if}
            {#if matchesCurrent}<p>
                Already the current {card.target === "source" ? "source and English" : "English"}.
              </p>{:else if mode === "review" && card.body === currentLine?.source}<p>
                Matches the current source.
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
    {#if busy && mode === "enquire"}<p role="status">Working…</p>{/if}
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
    </form>    {:else if !kanaOpen && automaticReviewerIndexes.length}<button
      disabled={busy || detectingMask || (maskEnabled && !maskReady)}
      onclick={() => void reviewAutomatic()}
      >{automaticAttempted || reviewing || pendingReviews ? "Resubmit" : "Send to automatic reviewers"}</button
    >{/if}
</dialog>

<style>
  dialog {
    color: var(--hud-text);
    background: var(--hud-bg-2);
    border: 1px solid var(--hud-teal);
    border-radius: 2px;
    width: min(1100px, 96vw);
    max-width: 96vw;
    height: 94dvh;
    max-height: 94dvh;
    box-sizing: border-box;
    padding: 1.3rem;
  }
  dialog.review {
    width: min(1500px, 96vw);
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
    margin-bottom: 1rem;
  }
  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  h2 {
    font-size: 1.3rem;
  }
  p {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 0.9rem;
    margin: 0.5rem 0;
  }
  .current {
    flex-shrink: 0;
    background: var(--hud-bg-2);
    padding: 0.7rem;
    max-height: 140px;
    overflow: auto;
  }
  .dialog-content {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    gap: 1rem;
    margin-bottom: 1rem;
  }
  .review .dialog-content {
    display: grid;
    grid-template-columns: minmax(260px, 28%) minmax(0, 1fr);
  }
  .context-panel {
    min-width: 0;
    max-height: 45%;
    overflow-y: auto;
  }
  .review .context-panel {
    max-height: none;
    padding-right: 0.5rem;
  }
  .review .current {
    max-height: none;
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
  .review-crop {
    display: block;
    max-width: 100%;
    max-height: min(360px, 34dvh);
    object-fit: contain;
    margin: 0.6rem auto;
    background: white;
  }
  .original-crop { overflow: auto; max-height: min(70dvh, 640px); background: #111; }
  .original-crop .review-crop { max-width: none; max-height: none; margin: 0; }
  .zoom-group { display: inline-flex; gap: 2px; }
  .zoom-group button[aria-pressed="true"] { background: var(--hud-teal-dim); }
  .sent-scale { display: block; color: var(--hud-muted); margin-top: 3px; }
  .mask-toggle {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.9rem;
    margin: 0.5rem 0 0.2rem;
  }
  .review-hint {
    white-space: normal;
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
  .kana-main :global(.kana-entry) {
    flex: 1;
  }
  .review-responses {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr));
    gap: 1rem;
    align-content: start;
    align-items: start;
  }
  .review-responses article {
    margin: 0;
    min-width: 0;
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
    border: 1px solid var(--hud-teal);
    padding: 0.8rem;
    margin: 0.7rem 0 0;
    border-radius: 2px;
    background: var(--hud-teal-dim);
  }
  .replacement {
    font-size: 1.05rem;
    line-height: 1.6;
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
    dialog {
      padding: 0.8rem;
    }
    .review .dialog-content {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, 28dvh) minmax(0, 1fr);
    }
    .review-crop {
      max-height: 160px;
    }
    .review-responses {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
