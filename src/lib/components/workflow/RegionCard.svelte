<script lang="ts">
  import "./studio-controls.css";
  import type { Snippet } from "svelte";
  import { collapseSuggestions, isSourceSuggestion } from "$lib/regionAi";
  import { compactSuggestionReason } from "$lib/suggestionReason";
  import SourceRomanization from "../SourceRomanization.svelte";
  import SfxHints from "../SfxHints.svelte";
  import GlossaryChips from "../GlossaryChips.svelte";
  import KanaEntryPanel from "../KanaEntryPanel.svelte";
  import {
    type GlossaryTerm,
    type LineRow,
  } from "$lib/types";
  import { builtinRegionKinds, regionKindOptions, type RegionKind } from "$lib/regionCatalog";

  export type RegionSuggestion = {
    id: string;
    line_id: string;
    kind: string;
    body: string;
    translation?: string;
    reason?: string;
    state: string;
    base_revision?: number;
  };

  let {
    line,
    index,
    pageIndex,
    sourceLabel,
    japanese = false,
    canEdit,
    canChangeType,
    busy,
    aiRunning,
    selected,
    suggestions,
    overflow = false,
    glossary = [],
    regionKinds = builtinRegionKinds(),
    color = "#2de2c5",
    dimensions = "",
    onselect,
    onactions,
    onsettype,
    onedit,
    onreview,
    onrevise,
    onenquire,
    onapprove,
    onsuggest,
    ondecide,
    onreaddrawing,
    children,
  }: {
    line: LineRow;
    index: number;
    pageIndex: number;
    sourceLabel: string;
    japanese?: boolean;
    canEdit: boolean;
    canChangeType: boolean;
    busy: boolean;
    aiRunning: boolean;
    selected: boolean;
    suggestions: RegionSuggestion[];
    overflow?: boolean;
    glossary?: GlossaryTerm[];
    regionKinds?: RegionKind[];
    color?: string;
    dimensions?: string;
    onselect: (id: string, origin: "list") => void;
    onactions: (event: MouseEvent, imageId: string, lineId: string) => void;
    onsettype: (line: LineRow, type: string) => void;
    onedit: (line: LineRow, patch: Record<string, unknown>) => void;
    onreview: (line: LineRow) => void;
    onrevise: (line: LineRow) => void;
    onenquire: (line: LineRow) => void;
    onapprove: (line: LineRow) => void;
    onsuggest: (line: LineRow) => void;
    ondecide: (
      id: string,
      decision: "accept" | "reject",
      force?: boolean,
    ) => void;
    onreaddrawing?: (
      line: LineRow,
      image: string,
      signal: AbortSignal,
    ) => Promise<{ source: string }>;
    children?: Snippet<[Snippet]>;
  } = $props();
  const shown = $derived(collapseSuggestions(suggestions));
  const distinctSourceReadings = $derived(shown.filter((item) => isSourceSuggestion(item.kind)).length);
</script>

{#snippet suggestionList()}
  {#each shown as suggestion}
    <div class="sugg suggestion">
      <div class="sugg-head">
        <strong
          >{isSourceSuggestion(suggestion.kind)
            ? "Source"
            : suggestion.kind === "proofread"
              ? "Proofreading model"
              : suggestion.kind === "revise"
                ? "English revision"
                : suggestion.kind} suggestion</strong
        >
        {#if suggestion.reason}<small>{compactSuggestionReason(suggestion.reason)}</small>{/if}
      </div>
      <p lang={isSourceSuggestion(suggestion.kind) ? "ja" : undefined}>{suggestion.body || "No text returned"}</p>
      {#if isSourceSuggestion(suggestion.kind)}
        <SourceRomanization text={suggestion.body} />
      {/if}
      {#if suggestion.translation}
        <p class="sugg-en">{suggestion.translation}</p>
      {/if}
      {#if suggestion.base_revision != null && suggestion.base_revision !== line.revision}
        <p class="warning">The region changed since this suggestion. Accepting replaces the current draft.</p>
      {/if}
      <div class="btn-row">
        <button
          class="small accent"
          disabled={!canEdit || !suggestion.body.trim()}
          onclick={() => ondecide(suggestion.mergedIds[0], "accept")}
          >{suggestion.translation ? "Use source & English" : "Use this version"}</button
        ><button class="small ghost" disabled={!canEdit} onclick={() => { for (const id of suggestion.mergedIds) ondecide(id, "reject"); }}>Reject</button>
      </div>
    </div>
  {/each}
{/snippet}

<article
  class="wf-ui rcard"
  id={`region-card-${line.id}`}
  class:selected
  data-find="region-card"
  style={`--c:${color}`}
  onfocusin={(e) => {
    if (!selected && (e.target as HTMLElement).matches("textarea, input, select")) onselect(line.id, "list");
  }}
  role="group"
  aria-label={`Bilingual region ${index + 1}${overflow ? ", text overflow" : ""}`}
  oncontextmenu={(e) => onactions(e, line.imageId!, line.id)}
>
  <header>
    <div class="type-col">
      <select
        class="type-pick"
        aria-label="Region type"
        title="Region type"
        data-find="region-type"
        value={line.lineType}
        disabled={!canChangeType}
        onchange={(e) => onsettype(line, e.currentTarget.value)}
        >{#each regionKindOptions(regionKinds, line.lineType) as t}<option value={t.id}>{t.label}</option
          >{/each}</select
      >
      {#if dimensions}<span class="dims" data-find="region-size">{dimensions}</span>{/if}
    </div>
    <span class="muted small">{line.ocrConfidence == null ? "Image / manual source" : `OCR ${Math.round(line.ocrConfidence * 100)}%`}</span>
    <span class="spacer"></span>
    <button type="button" class="rid" onclick={() => onselect(line.id, "list")}>#{pageIndex}</button>
    <button class="icon-btn" aria-label="Region actions" title="Region actions" data-find="region-actions" onclick={(e) => onactions(e, line.imageId!, line.id)}><i class="bi bi-three-dots" aria-hidden="true"></i></button>
  </header>
  {#if line.sourceState === "ignored"}
    <div class="alert muted"><i class="bi bi-slash-circle" aria-hidden="true"></i> Ignored{line.ignoreReason ? `: ${line.ignoreReason}` : ""}</div>
  {/if}
  {#if !(line.source ?? "").trim() && distinctSourceReadings > 1}
    <div class="alert attn"><i class="bi bi-signpost-split" aria-hidden="true"></i> The readers disagree. Pick a reading below, or ask for an Review Transcription.</div>
  {/if}
  {#if overflow}
    <div class="alert bad" role="alert"><i class="bi bi-exclamation-triangle" aria-hidden="true"></i> Text overflow · lettering does not fit at the minimum size</div>
  {/if}
  <div class="field">
    <div class="field-head">
      <span class="flabel">{sourceLabel}</span>
      <button
        class="small"
        disabled={!canEdit || busy || aiRunning || !line.placed || line.sourceState === "ignored"}
        data-find="ai-review"
        title="Independent readings from your transcription reviewers"
        onclick={() => onreview(line)}><i class="bi bi-people" aria-hidden="true"></i> Review Transcription</button
      >
    </div>
    <textarea
      aria-label={sourceLabel}
      rows="2"
      lang={japanese ? "ja" : "ko"}
      placeholder="Type or pick a reading"
      value={line.source ?? ""}
      disabled={!canEdit}
      oninput={(e) =>
        onedit(line, {
          source: e.currentTarget.value,
          sourceState: e.currentTarget.value.trim() ? "read" : "unreadable",
        })}
    ></textarea>
    <SourceRomanization text={line.source ?? ""} />
    <div class="helpers">
      {#if japanese}
        <div data-find="kana" class="kana-wrap">
          <KanaEntryPanel
            source={line.source ?? ""}
            {glossary}
            canEdit={canEdit && !busy && line.sourceState !== "ignored"}
            onapply={(text) =>
              onedit(line, {
                source: text,
                sourceState: text.trim() ? "read" : "unreadable",
              })}
            onreadDrawing={onreaddrawing ? (image, signal) => onreaddrawing(line, image, signal) : undefined}
          />
        </div>
      {/if}
      <GlossaryChips source={line.source ?? ""} english={line.body} terms={glossary} />
      <SfxHints source={line.source ?? ""} current={line.body} disabled={!canEdit} onpick={(meaning) => onedit(line, { body: meaning })} />
    </div>
  </div>
  <div class="field">
    <div class="field-head">
      <label class="flabel" for={`english-${line.id}`}>English</label>
      <button
        class="small"
        disabled={!canEdit || busy || aiRunning || line.sourceState === "ignored" || !(line.source ?? "").trim()}
        data-find="revise"
        title={(line.source ?? "").trim() ? undefined : "Needs source first"}
        onclick={() => onrevise(line)}><i class="bi bi-magic" aria-hidden="true"></i> Review Translation</button
      >
    </div>
    <textarea
      id={`english-${line.id}`}
      aria-label="English"
      rows="3"
      placeholder={(line.source ?? "").trim() ? "Translate, or type English" : "Needs source first"}
      value={line.body}
      disabled={!canEdit}
      oninput={(e) => onedit(line, { body: e.currentTarget.value })}
    ></textarea>
  </div>
  <div class="btn-row wrap">
    <button class="primary" disabled={!canEdit || !line.body.trim()} data-find="approve-next" onclick={() => onapprove(line)}
      ><i class="bi bi-check2" aria-hidden="true"></i> Approve &amp; next</button
    ><button disabled={!canEdit} data-find="needs-work" onclick={() => onedit(line, { status: "needs_work" })}>Needs work</button
    ><button
      class="ghost"
      disabled={!canEdit || busy || aiRunning || line.sourceState === "ignored"}
      data-find="suggest-alt"
      onclick={() => onsuggest(line)}>Suggest alternative</button
    ><button class="ghost" disabled={!canEdit || busy} onclick={() => onenquire(line)} data-find="enquire"
      ><i class="bi bi-chat-dots" aria-hidden="true"></i> Enquire</button
    >
  </div>
  {#if children}
    {@render children(suggestionList)}
  {:else}
    {@render suggestionList()}
  {/if}
</article>

<style>
  .rcard {
    margin: 8px;
    border: 1px solid rgba(45, 226, 197, 0.45);
    border-radius: 7px;
    background: #1a2030;
    padding: 10px;
    display: grid;
    gap: 10px;
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.35);
  }
  header { display: flex; align-items: center; gap: 8px; }
  .type-col { display: grid; justify-items: start; gap: 2px; }
  .type-pick { width: auto; border-left: 4px solid var(--c); padding: 3px 6px; font-size: 12px; }
  .dims { color: var(--hud-muted); font-size: 11px; line-height: 1.2; padding-left: 4px; }
  .muted { color: var(--hud-muted); }
  .small { font-size: 11.5px; }
  .spacer { flex: 1; }
  .rid { border: 0; background: none; padding: 0 2px; color: var(--hud-muted); font-size: 11px; }
  .rid:hover { color: var(--hud-teal); }
  .icon-btn { border: 0; background: transparent; color: var(--hud-muted); padding: 3px 5px; border-radius: 4px; }
  .icon-btn:hover:not(:disabled) { color: var(--hud-text); background: rgba(255, 255, 255, 0.07); }
  .alert { display: flex; gap: 7px; align-items: flex-start; padding: 6px 8px; border-radius: 4px; font-size: 12px; }
  .alert.attn { background: rgba(245, 184, 92, 0.12); color: #f8d49c; }
  .alert.bad { background: rgba(255, 93, 115, 0.12); color: #ffb3bf; }
  .alert.muted { background: rgba(255, 255, 255, 0.05); }
  .field { display: grid; gap: 5px; }
  .field-head { display: flex; align-items: center; justify-content: space-between; }
  .flabel { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--hud-muted); margin: 0; }
  .helpers { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .kana-wrap { width: 100%; }
  .btn-row { display: flex; gap: 6px; align-items: center; }
  .btn-row.wrap { flex-wrap: wrap; }
  button.accent { color: var(--hud-teal); border-color: rgba(45, 226, 197, 0.45); }
  .sugg {
    border-left: 3px solid #f5b85c;
    background: rgba(245, 184, 92, 0.06);
    padding: 8px 10px;
    border-radius: 0 4px 4px 0;
    display: grid;
    gap: 5px;
  }
  .sugg-head { display: flex; justify-content: space-between; gap: 8px; }
  .sugg-head small { color: var(--hud-muted); font-size: 11px; text-align: right; white-space: pre-line; }
  .sugg p { margin: 0; white-space: pre-wrap; color: var(--hud-text); }
  .sugg .sugg-en { color: #ecddbd; }
</style>
