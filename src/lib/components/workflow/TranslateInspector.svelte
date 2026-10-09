<script lang="ts">
  import "./studio-controls.css";
  import type { TranscriptionDecision } from "$lib/decider";
  import PageInspector from "../PageInspector.svelte";
  import RegionCard, { type RegionSuggestion } from "./RegionCard.svelte";
  import RegionDetails from "./RegionDetails.svelte";
  import type { CommentRow, GlossaryTerm, ImageRow, LineRow } from "$lib/types";
  import { builtinRegionKinds, type RegionKind } from "$lib/regionCatalog";
  import { collapseSuggestions } from "$lib/regionAi";

  let {
    page,
    images = [],
    canEdit,
    canChangeType,
    busy,
    aiRunning,
    scriptText = $bindable(""),
    query = $bindable(""),
    unresolvedOnly = $bindable(false),
    unplaced,
    searchHits,
    visibleLines,
    pageLines,
    lineId,
    sourceLabel,
    japanese = false,
    suggestions,
    regionOverflow,
    regionDecision = () => undefined,
    regionDecisionStale = () => false,
    glossary = [],
    speakerFor = () => undefined,
    onassigncharacter,
    regionKinds = builtinRegionKinds(),
    selected,
    comments,
    history = $bindable([]),
    commentText = $bindable(""),
    commentCorrection = $bindable(false),
    splitAt = $bindable(1),
    mergeId = $bindable(""),
    commentsEl = $bindable(),
    boundsEl = $bindable(),
    oncaption,
    ondescribe,
    onimportscript,
    onplace,
    onnextissue,
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
    oncommentinput,
    ondeletecomment,
    onaddcomment,
    onsplit,
    onmerge,
    onshowhistory,
    onrestore,
    onreaddrawing,
    view = "regions",
    queueLines = [],
    subtab = $bindable("suggestions"),
    colorFor = () => "#2de2c5",
  }: {
    page: ImageRow | null;
    images?: ImageRow[];
    canEdit: boolean;
    canChangeType: boolean;
    busy: boolean;
    aiRunning: boolean;
    scriptText?: string;
    query?: string;
    unresolvedOnly?: boolean;
    unplaced: LineRow[];
    searchHits: { line: LineRow; pageNumber: string | number }[];
    visibleLines: LineRow[];
    pageLines: LineRow[];
    lineId: string;
    sourceLabel: string;
    japanese?: boolean;
    suggestions: RegionSuggestion[];
    regionOverflow: (id: string) => boolean;
    regionDecision?: (line: LineRow) => TranscriptionDecision | undefined;
    regionDecisionStale?: (line: LineRow) => boolean;
    glossary?: GlossaryTerm[];
    speakerFor?: (id: string) => import('$lib/characters').CharacterAssignment | undefined;
    onassigncharacter?: (line: LineRow, characterId: string | null) => void;
    regionKinds?: RegionKind[];
    selected: LineRow | undefined;
    comments: CommentRow[];
    history?: { revision: number; data: string }[];
    commentText?: string;
    commentCorrection?: boolean;
    splitAt?: number;
    mergeId?: string;
    commentsEl?: HTMLElement;
    boundsEl?: HTMLElement;
    oncaption: (text: string) => void;
    ondescribe: () => void;
    onimportscript: () => void;
    onplace: (id: string) => void;
    onnextissue: () => void;
    onselect: (id: string, origin: "list") => void;
    onactions: (event: MouseEvent, imageId: string, lineId: string) => void;
    onsettype: (line: LineRow, type: string) => void;
    onedit: (line: LineRow, patch: Record<string, unknown>) => void;
    onreview: (line: LineRow) => void;
    onrevise: (line: LineRow) => void;
    onenquire: (line: LineRow) => void;
    onapprove: (line: LineRow) => void;
    onsuggest: (line: LineRow) => void;
    ondecide: (id: string, decision: "accept" | "reject", force?: boolean) => void;
    oncommentinput: (comment: CommentRow, body: string) => void;
    ondeletecomment: (id: string) => void;
    onaddcomment: () => void;
    onsplit: () => void;
    onmerge: () => void;
    onshowhistory: () => void;
    onrestore: (entry: { revision: number; data: string }) => void;
    onreaddrawing?: (
      line: LineRow,
      image: string,
      signal: AbortSignal,
    ) => Promise<{ source: string }>;
    view?: "regions" | "page" | "queue" | "glossary";
    queueLines?: LineRow[];
    subtab?: string;
    colorFor?: (type: string) => string;
  } = $props();

  function lineState(line: LineRow): { key: string; label: string } {
    if (line.sourceState === "ignored") return { key: "ignored", label: "Ignored" };
    if (regionOverflow(line.id)) return { key: "bad", label: "Overflow" };
    if (!(line.source ?? "").trim()) {
      return suggestions.some((s) => s.line_id === line.id)
        ? { key: "attn", label: "Pick a reading" }
        : { key: "todo", label: "Needs source" };
    }
    if (!line.body.trim()) return { key: "todo", label: "Needs English" };
    if (line.status === "approved") return { key: "ok", label: "Approved" };
    return { key: "attn", label: "Needs review" };
  }
  const trim = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text);
  function regionSize(line: LineRow): string {
    if (!line.placed || line.w == null || line.h == null) return "";
    const image = images.find((item) => item.id === line.imageId) ?? (line.imageId === page?.id ? page : null);
    if (!image?.width || !image.height) return "";
    const width = Math.round(Math.abs(line.w) * image.width);
    const height = Math.round(Math.abs(line.h) * image.height);
    return `${width} × ${height} px`;
  }
  const queueGroups = $derived.by(() => {
    const groups = new Map<string, LineRow[]>();
    for (const line of queueLines) {
      const label = lineState(line).label;
      groups.set(label, [...(groups.get(label) ?? []), line]);
    }
    return [...groups];
  });
</script>

{#snippet row(l: LineRow, queue: boolean)}
  {@const st = lineState(l)}
  <button
    type="button"
    class="rrow"
    class:sel={lineId === l.id}
    aria-label={`#${pageLines.indexOf(l) + 1} ${l.source?.trim() || "no source yet"}`}
    onclick={() => onselect(l.id, "list")}
    oncontextmenu={(e) => l.imageId && onactions(e, l.imageId, l.id)}
  >
    <span class="rnum" style={`--c:${colorFor(l.lineType)}`}>{pageLines.indexOf(l) + 1 || "·"}</span>
    <span class="rtext">
      <b>{trim(l.source?.trim() || "[no source yet]", queue ? 22 : 26)}</b>
      <small>{trim(l.body.trim() || "— no English —", 38)}</small>
    </span>
    {#if !queue}<span class={`chip chip-${st.key}`}>{st.label}</span>{/if}
  </button>
{/snippet}

{#snippet card(l: LineRow, i: number)}
  <RegionCard
    line={l}
    index={i}
    pageIndex={pageLines.indexOf(l) + 1}
    {sourceLabel}
    {japanese}
    {canEdit}
    {canChangeType}
    {busy}
    {aiRunning}
    selected={lineId === l.id}
    suggestions={suggestions.filter((s) => s.line_id === l.id)}
    overflow={regionOverflow(l.id)}
    decision={regionDecision(l)}
    decisionStale={regionDecisionStale(l)}
    {glossary}
    speaker={speakerFor(l.id)}
    {onassigncharacter}
    {regionKinds}
    color={colorFor(l.lineType)}
    dimensions={regionSize(l)}
    {onselect}
    {onactions}
    {onsettype}
    {onedit}
    {onreview}
    {onrevise}
    {onenquire}
    {onapprove}
    {onsuggest}
    {ondecide}
    {onreaddrawing}
  >
    {#snippet children(suggestionList)}
    <RegionDetails
      selected={l}
      suggestionsBody={suggestionList}
      {comments}
      {canEdit}
      {pageLines}
      suggestionCount={collapseSuggestions(suggestions.filter((s) => s.line_id === l.id)).length}
      bind:history
      bind:commentText
      bind:commentCorrection
      bind:splitAt
      bind:mergeId
      bind:commentsEl
      bind:boundsEl
      {onedit}
      {oncommentinput}
      {ondeletecomment}
      {onaddcomment}
      {onsplit}
      {onmerge}
      {onshowhistory}
      {onrestore}
      bind:subtab
    />
    {/snippet}
  </RegionCard>
{/snippet}

<div class="wf-ui insp-pane">
  {#if view === "page"}
    <section class="sec" data-find="refresh-scene">
      <h3>Scene note <span class="scope">translators see this</span></h3>
      <PageInspector
        image={page}
        {canEdit}
        canDescribe={false}
        describing={busy || aiRunning}
        {oncaption}
        {ondescribe}
      />
    </section>
    <section class="sec" data-find="import-script">
      <h3>Import a script</h3>
      <textarea
        bind:value={scriptText}
        rows="4"
        placeholder="Paste a chapter script. Lines without a box land in Unplaced."
        disabled={!canEdit}></textarea>
      <div><button class="small" disabled={!canEdit || !scriptText.trim()} onclick={onimportscript}>Import script</button></div>
    </section>
    <section class="sec" data-find="unplaced">
      <h3>Unplaced lines <span class="badge">{unplaced.length}</span></h3>
      {#each unplaced as item}
        <div class="unplaced">
          <span>{item.body.slice(0, 70) || "[empty]"}</span>
          <button class="small" onclick={() => onplace(item.id)}>Draw to place</button>
        </div>
      {:else}
        <p class="muted small">No unplaced lines.</p>
      {/each}
    </section>
  {:else if view === "queue"}
    <div class="searchbar" data-find="tab-review-queue">
      <span class="muted small">{queueLines.length} left in this chapter</span>
      <span class="spacer"></span>
      <button class="small ghost" onclick={onnextissue}>Next <i class="bi bi-arrow-right" aria-hidden="true"></i></button>
    </div>
    {#if selected}{@render card(selected, pageLines.indexOf(selected))}{/if}
    <div class="queue" data-find="queue">
      {#each queueGroups as [label, lines] (label)}
        <h4>{label} <span class="badge">{lines.length}</span></h4>
        {#each lines as l (l.id)}{@render row(l, true)}{/each}
      {:else}
        <p class="empty"><i class="bi bi-check-circle" aria-hidden="true"></i> Everything is approved.</p>
      {/each}
    </div>
  {:else if view !== "glossary"}
    <div class="searchbar">
      <div class="search">
        <i class="bi bi-search" aria-hidden="true"></i>
        <input
          data-find="search"
          aria-label="Search source and English"
          type="search"
          bind:value={query}
          placeholder="Search source & English in this chapter"
        />
      </div>
      <label class="check" data-find="unresolved"><input type="checkbox" bind:checked={unresolvedOnly} /> Unresolved</label>
    </div>
    {#if query.trim()}
      <div class="hits" aria-label="Chapter search results">
        {#each searchHits as hit}
          <button onclick={() => onselect(hit.line.id, "list")}
            ><b>p{hit.pageNumber}</b> {trim(hit.line.source || "[unreadable]", 22)} <small>{trim(hit.line.body, 32)}</small></button
          >
        {/each}
      </div>
    {/if}
    <div class="rlist">
      {#each visibleLines as l, i (l.id)}
        {#if lineId === l.id || suggestions.some((s) => s.line_id === l.id)}
          {@render card(l, i)}
        {:else}
          <div id={`region-card-${l.id}`}>{@render row(l, false)}</div>
        {/if}
      {:else}
        <p class="empty">No regions on this page. Transcribe it or draw a region (R).</p>
      {/each}
    </div>
  {/if}
</div>

<style>
  .insp-pane { font-size: 13px; }
  .muted { color: var(--hud-muted); }
  .small { font-size: 11.5px; }
  .spacer { flex: 1; }
  .sec { padding: 12px 14px; border-bottom: 1px solid var(--hud-line); display: grid; gap: 8px; }
  .sec h3 {
    margin: 0;
    font: 700 12.5px Rajdhani, sans-serif;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--hud-text);
  }
  .sec :global(label) { margin: 0; }
  .scope {
    font: 500 10px Inter, sans-serif;
    letter-spacing: 0;
    text-transform: none;
    padding: 1px 6px;
    border-radius: 8px;
    border: 1px solid rgba(244, 247, 251, 0.18);
    color: var(--hud-muted);
  }
  .badge {
    display: inline-block;
    min-width: 16px;
    padding: 0 5px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.1);
    font: 500 10.5px/16px Inter, sans-serif;
    text-align: center;
    color: var(--hud-text);
  }
  .unplaced { display: flex; gap: 8px; align-items: center; justify-content: space-between; font-size: 12px; padding: 5px 0; border-bottom: 1px dashed var(--hud-line); }
  .searchbar { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-bottom: 1px solid var(--hud-line); }
  .search {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    background: rgba(8, 10, 14, 0.7);
    border: 1px solid rgba(244, 247, 251, 0.18);
    border-radius: 4px;
    padding: 0 8px;
    color: var(--hud-muted);
  }
  .search input { border: 0; background: transparent; padding: 5px 0; }
  .search input:focus { box-shadow: none; }
  .check { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--hud-text); font-size: 11.5px; white-space: nowrap; }
  .hits { display: grid; max-height: 180px; overflow: auto; border-bottom: 1px solid var(--hud-line); }
  .hits button { justify-content: flex-start; text-align: left; border: 0; border-radius: 0; background: transparent; padding: 5px 12px; font-size: 12px; }
  .hits small { color: var(--hud-muted); }
  .rlist { display: flex; flex-direction: column; }
  .rrow {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    text-align: left;
    padding: 7px 12px;
    background: transparent;
    border: 0;
    border-radius: 0;
    border-bottom: 1px solid var(--hud-line);
    color: var(--hud-text);
    white-space: normal;
  }
  .rrow:hover:not(:disabled) { background: rgba(255, 255, 255, 0.04); border-color: var(--hud-line); color: var(--hud-text); }
  .rrow.sel, .rrow.sel:hover { background: var(--hud-teal-dim); }
  .rnum {
    flex: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--c);
    color: #000;
    display: grid;
    place-items: center;
    font-size: 10.5px;
    font-weight: 700;
  }
  .rtext { flex: 1; min-width: 0; display: grid; }
  .rtext b, .rtext small { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rtext b { font-weight: 500; font-size: 12.5px; }
  .rtext small { color: var(--hud-muted); font-size: 11.5px; }
  .chip { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 10.5px; font-weight: 500; white-space: nowrap; }
  .chip-ok { background: rgba(94, 227, 154, 0.14); color: #5ee39a; }
  .chip-attn { background: rgba(245, 184, 92, 0.15); color: #f5b85c; }
  .chip-bad { background: rgba(255, 93, 115, 0.15); color: #ff5d73; }
  .chip-todo { background: rgba(125, 211, 252, 0.12); color: #7dd3fc; }
  .chip-ignored { background: rgba(255, 255, 255, 0.07); color: var(--hud-muted); }
  .queue h4 {
    margin: 0;
    padding: 9px 12px 4px;
    font: 700 11px Rajdhani, sans-serif;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: #f5b85c;
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .empty { color: var(--hud-muted); padding: 16px; text-align: center; }
</style>
