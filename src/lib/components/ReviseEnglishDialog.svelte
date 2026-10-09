<script lang="ts">
  import { tick } from "svelte";
  import AiModelPicker from "./AiModelPicker.svelte";
  import { assistantDisplayName } from "$lib/modelRegistry";
  import {
    enginesForRegionAiField,
    isProofreaderTranslator,
    isOnDemandReviewer,
    isNonLocalReviewer,
    reviseSampleCount,
    sameReviseModel,
    suggestionMatchesLine,
    type AiActionCard,
  } from "$lib/regionAi";
    import { proofreaderOnlyMessage } from '$lib/proofreaders';
  import { providerRunGate } from "$lib/providerCatalog";
  import type { TaskEngine } from "$lib/aiTasks";
  import SourceRomanization from "./SourceRomanization.svelte";
  import type { LineRow, TranslateEngineInfo } from "$lib/types";

  let {
    engines,
    prepare,
    call,
    decide,
    suggestions,
    currentLines,
    onopensettings,
  }: {
    engines: TranslateEngineInfo[];
    currentLines: LineRow[];
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
    role: "assistant";
    content: string;
    cards?: AiActionCard[];
    label?: string;
    pending?: boolean;
    idle?: boolean;
  };

  let dialog: HTMLDialogElement;
  let transcript: HTMLDivElement;
  let line = $state<LineRow | null>(null);
  const currentLine = $derived(currentLines.find((l) => l.id === line?.id) ?? line);
  let translators = $state<TaskEngine[]>([]);
  let extras = $state<TaskEngine[]>([]);
  let extraDraft = $state<TaskEngine>({ engine: "", model: "" });
  let entries = $state<Entry[]>([]);
  let busy = $state(false);
  let revising = $state(false);
  let automaticAttempted = $state(false);
  let error = $state("");
  const inflight = new Set<AbortController>();
  const automaticIndexes = $derived(
    translators.flatMap((model, i) => (isOnDemandReviewer(model, engines) ? [] : [i])),
  );
  const extraEngines = $derived(
    enginesForRegionAiField("translate", engines, extraDraft.engine).filter(
      (engine) => !engine.pageImageOnly,
    ),
  );
  const extraGate = $derived(providerRunGate(extraDraft.engine, "translate", engines));

  function modelLabel(model: TaskEngine) {
    return engines.find((row) => row.id === model.engine)?.label
      || assistantDisplayName(model.engine, model.model);
  }
  function uniqueModels(list: TaskEngine[]): TaskEngine[] {
    const out: TaskEngine[] = [];
    for (const model of list) {
      if (!model.engine || isProofreaderTranslator(model)) continue;
      if (out.some((item) => sameReviseModel(item, model))) continue;
      out.push({ engine: model.engine, model: model.model || "" });
    }
    return out;
  }
  function idlePanels(list: TaskEngine[]): Entry[] {
    return list.map((model) => {
      const onDemand = isOnDemandReviewer(model, engines);
      const samples = reviseSampleCount(model);
      return {
        role: "assistant" as const,
        label: modelLabel(model),
        content: onDemand
          ? `Not run automatically. Use Run to request ${modelLabel(model)}.`
          : samples > 1
            ? `Waiting to sample ${samples} fast translations.`
            : "Waiting to translate with glossary and nearby lines.",
        pending: false,
        idle: onDemand,
      };
    });
  }
  function abortRuns() {
    for (const controller of inflight) controller.abort();
    inflight.clear();
    revising = false;
    entries = entries.map((entry, i) =>
      entry.pending
        ? {
            ...entry,
            pending: false,
            idle: isOnDemandReviewer(translators[i], engines),
            content: "Revision cancelled. Run again to retry.",
          }
        : entry,
    );
  }
  function close() {
    abortRuns();
    dialog.close();
  }
  export function setCouncil(selected: TaskEngine[]) {
    abortRuns();
    const base = uniqueModels(selected);
    extras = extras.filter((extra) => !base.some((model) => sameReviseModel(model, extra)));
    const next = uniqueModels([...base, ...extras]);
    const prev = translators;
    const previous = [...entries];
    translators = next;
    entries = next.map((model) => {
      const old = prev.findIndex((item) => sameReviseModel(item, model));
      if (old >= 0 && previous[old]) return previous[old];
      return idlePanels([model])[0];
    });
  }
  export async function open(target: LineRow, council: TaskEngine[]) {
    abortRuns();
    error = "";
    busy = false;
    revising = false;
    automaticAttempted = false;
    line = target;
    translators = uniqueModels([...council, ...extras]);
    if (!extraDraft.engine && extraEngines[0])
      extraDraft = { engine: extraEngines[0].id, model: "" };
    entries = idlePanels(translators);
    dialog.showModal();
    if (!target.source?.trim()) {
      error = "Add source text before revising English.";
      return;
    }
    if (automaticIndexes.length) await reviseAutomatic();
  }
  async function reviseAutomatic() {
    if (!automaticIndexes.length) {
      error =
        "Choose a local translator or enable Autorun for a model in Admin → Models. You can also use its Run button.";
      return;
    }
    automaticAttempted = true;
    await runModels(automaticIndexes);
  }
  async function reviseOne(index: number) {
    if (!translators[index] || entries[index]?.pending) return;
    await runModels([index], true);
  }
  async function addExtra() {
    if (!extraDraft.engine || !extraGate.ok) return;
    if (isProofreaderTranslator(extraDraft)) {
      error = proofreaderOnlyMessage(extraDraft.engine, "revise English");
      return;
    }
    const next = { engine: extraDraft.engine, model: extraDraft.model || "" };
    if (translators.some((model) => sameReviseModel(model, next))) return;
    extras = uniqueModels([...extras, next]);
    translators = uniqueModels([...translators, next]);
    entries = [...entries, ...idlePanels([next])];
    const index = translators.findIndex((model) => sameReviseModel(model, next));
    if (index >= 0 && !isOnDemandReviewer(next, engines)) await runModels([index]);
  }
  async function runModels(indexes: number[], individuallySelected = false) {
    const selected = indexes
      .map((i) => ({ i, model: { ...translators[i] } }))
      .filter(({ model }) => individuallySelected || !isOnDemandReviewer(model, engines));
    if (!selected.length || !line) return;
    const targetId = line.id;
    error = "";
    const controller = new AbortController();
    inflight.add(controller);
    const runningAutomatic = selected.some(({ model }) => !isOnDemandReviewer(model, engines));
    if (runningAutomatic) revising = true;
    if (entries.length !== translators.length) entries = idlePanels(translators);
    const updatePanel = (index: number, entry: Entry) => {
      if (!controller.signal.aborted)
        entries = entries.map((current, i) => (i === index ? entry : current));
    };
    for (const { i, model } of selected) {
      updatePanel(i, {
        role: "assistant",
        label: modelLabel(model),
        content:
          reviseSampleCount(model) > 1
            ? "Sampling fast translations…"
            : "Waiting for translation…",
        pending: true,
        idle: false,
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
                action: "revise",
                lineId: current.id,
                expectedRevision: current.revision,
                model,
                samples: reviseSampleCount(model),
                ...(individuallySelected ? { selected: true } : {}),
              },
              controller.signal,
            );
            controller.signal.throwIfAborted();
            const cards = result.cards ?? [];
            const failed = result.error as string | undefined;
            updatePanel(i, {
              role: "assistant",
              label: result.label || modelLabel(model),
              content: failed
                ? `Revision failed: ${failed}`
                : cards.length
                  ? `${cards.length} distinct English draft${cards.length === 1 ? "" : "s"}.`
                  : "No new wording — this model matched the current English or returned empty text.",
              cards,
              idle: false,
            });
          } catch (e) {
            if (controller.signal.aborted) return;
            updatePanel(i, {
              role: "assistant",
              label: modelLabel(model),
              content: `Revision failed: ${e instanceof Error ? e.message : String(e)}`,
              idle: false,
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
              content: `Revision failed: ${error}`,
            });
          }
        }
      }
    } finally {
      inflight.delete(controller);
      if (runningAutomatic && !controller.signal.aborted) {
        revising = entries.some(
          (entry, i) => entry.pending && !isOnDemandReviewer(translators[i], engines),
        );
      }
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
  async function apply(card: AiActionCard, decision: "accept" | "reject") {
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
  class="hud-dialog-controls review"
  bind:this={dialog}
  aria-label="Review Translation translation"
  oncancel={close}
  onclose={abortRuns}
>
  <header>
    <h2>Review Translation</h2>
    <div class="header-actions">
      {#if onopensettings}
        <button type="button" onclick={onopensettings}>Council settings…</button>
      {/if}
      <button aria-label="Close revise English dialog" onclick={close}>×</button>
    </div>
  </header>
  <div class="dialog-content">
    <div class="context-panel">
      <div class="current">
        <strong>Current source</strong>
        <p>{currentLine?.source || "(unreadable)"}</p>
        <SourceRomanization text={currentLine?.source ?? ""} />
        <strong>Current English</strong>
        <p>{currentLine?.body || "(empty)"}</p>
      </div>
      <p class="review-hint">
        The council is the set in Council settings. Until you save one, it is
        the Translation model plus the Proofreading model when that is a different
        text translator. Fast models (Hy-MT) sample several wordings. Thinking
        models translate once from this source, using matching glossary terms, the
        current draft, nearby lines, and scene notes. Proofreaders stay on
        page-image proofreading. Non-local models run automatically when Autorun
        is enabled in Admin → Models; otherwise use their Run button.
      </p>
      <div class="extra-row">
        <AiModelPicker
          label="Add another translator"
          bind:value={extraDraft}
          engines={extraEngines}
          disabled={busy || revising}
        />
        <button
          type="button"
          disabled={busy || revising || !extraDraft.engine || !extraGate.ok}
          title={extraGate.reason || undefined}
          onclick={() => void addExtra()}>Add</button
        >
      </div>
      {#if !extraGate.ok && extraDraft.engine}
        <p role="status">{extraGate.reason}</p>
      {/if}
    </div>
    <div
      class="transcript review-responses"
      bind:this={transcript}
      role="log"
      aria-label="Revision suggestions"
      aria-live="polite"
    >
      {#each entries as entry, i}
        <article class:pending={entry.pending} aria-busy={entry.pending || undefined}>
          <strong>{entry.label}</strong>
          <p>
            {#if entry.pending}<span role="status">{entry.content}</span>{:else}{entry.content}{/if}
          </p>
          {#if isNonLocalReviewer(translators[i], engines)}
            <div class="actions">
              <button
                disabled={busy || entry.pending}
                onclick={() => void reviseOne(i)}
                >{entry.idle
                  ? `Run ${modelLabel(translators[i])}`
                  : `Run ${modelLabel(translators[i])} again`}</button
              >
            </div>
          {/if}
          {#each entry.cards ?? [] as card}
            {@const state = suggestions.find((s) => s.id === card.id)?.state}
            {@const matchesCurrent = currentLine && suggestionMatchesLine({ kind: "revise", body: card.body }, currentLine)}
            <section class="action-card">
              <strong>English suggestion</strong>
              <p class="replacement">{card.body}</p>
              {#if matchesCurrent}<p>Already the current English.</p>{/if}
              <small>{card.reason}</small>
              {#if !matchesCurrent || (state && state !== "pending")}
              <div class="actions">
                {#if state && state !== "pending"}<span
                    >{state === "accepted" ? "Applied" : "Rejected"}</span
                  >{:else}
                  <button disabled={busy} onclick={() => apply(card, "accept")}
                    >Use English</button
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
            </section>
          {/each}
        </article>
      {/each}
    </div>
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if automaticIndexes.length}
    <button
      disabled={busy || revising}
      onclick={() => void reviseAutomatic()}
      >{automaticAttempted ? "Revise with automatic models again" : "Send to automatic translators"}</button
    >
  {/if}
</dialog>

<style>
  dialog {
    color: var(--hud-text);
    background: var(--hud-bg-2);
    border: 1px solid var(--hud-teal);
    border-radius: 2px;
    width: min(1500px, 96vw);
    max-width: 96vw;
    height: 94dvh;
    max-height: 94dvh;
    box-sizing: border-box;
    padding: 1.3rem;
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
    overflow: auto;
  }
  .dialog-content {
    display: grid;
    grid-template-columns: minmax(260px, 28%) minmax(0, 1fr);
    flex: 1;
    min-height: 0;
    gap: 1rem;
    margin-bottom: 1rem;
  }
  .context-panel {
    min-width: 0;
    overflow-y: auto;
    padding-right: 0.5rem;
  }
  .review-hint {
    white-space: normal;
  }
  .extra-row {
    display: flex;
    gap: 0.5rem;
    align-items: end;
    flex-wrap: wrap;
  }
  .extra-row :global(.model-picker) {
    flex: 1;
  }
  .transcript {
    flex: 1;
    min-height: 100px;
    overflow-y: auto;
    min-width: 0;
    padding-right: 0.4rem;
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
    .dialog-content {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, 28dvh) minmax(0, 1fr);
    }
    .review-responses {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
