<script lang="ts">
  import "./studio-controls.css";
  import type { Snippet } from "svelte";
  import type { CommentRow, LineRow } from "$lib/types";

  let {
    selected,
    comments,
    canEdit,
    pageLines,
    suggestionCount = 0,
    suggestionsBody,
    history = $bindable([]),
    commentText = $bindable(""),
    commentCorrection = $bindable(false),
    splitAt = $bindable(1),
    mergeId = $bindable(""),
    commentsEl = $bindable(),
    boundsEl = $bindable(),
    onedit,
    oncommentinput,
    ondeletecomment,
    onaddcomment,
    onsplit,
    onmerge,
    onshowhistory,
    onrestore,
    subtab = $bindable("suggestions"),
  }: {
    selected: LineRow;
    comments: CommentRow[];
    canEdit: boolean;
    pageLines: LineRow[];
    suggestionCount?: number;
    suggestionsBody?: Snippet;
    history?: { revision: number; data: string }[];
    commentText?: string;
    commentCorrection?: boolean;
    splitAt?: number;
    mergeId?: string;
    commentsEl?: HTMLElement;
    boundsEl?: HTMLElement;
    onedit: (line: LineRow, patch: Record<string, unknown>) => void;
    oncommentinput: (comment: CommentRow, body: string) => void;
    ondeletecomment: (id: string) => void;
    onaddcomment: () => void;
    onsplit: () => void;
    onmerge: () => void;
    onshowhistory: () => void;
    onrestore: (entry: { revision: number; data: string }) => void;
    subtab?: string;
  } = $props();

  function historyBody(data: string) {
    try {
      const parsed = JSON.parse(data);
      return String(parsed.body ?? "") || "(empty)";
    } catch {
      return data;
    }
  }
</script>

<div class="wf-ui details">
  <div class="subtabs" role="tablist">
    <button type="button" role="tab" aria-selected={subtab === "suggestions"} class:on={subtab === "suggestions"} data-find="subtab-suggestions" onclick={() => (subtab = "suggestions")}>Suggestions{#if suggestionCount} <span class="badge">{suggestionCount}</span>{/if}</button>
    <button type="button" role="tab" aria-selected={subtab === "comments"} class:on={subtab === "comments"} data-find="subtab-comments" onclick={() => (subtab = "comments")}>Comments{#if comments.length} <span class="badge">{comments.length}</span>{/if}</button>
    <button type="button" role="tab" aria-selected={subtab === "history"} class:on={subtab === "history"} data-find="subtab-history" onclick={() => { subtab = "history"; onshowhistory(); }}>History</button>
    <button type="button" role="tab" aria-selected={subtab === "details"} class:on={subtab === "details"} data-find="subtab-details" onclick={() => (subtab = "details")}>Order &amp; bounds</button>
  </div>
  <div class="subbody">
    {#if subtab === "comments"}
      <div bind:this={commentsEl} class="subbody" aria-label="Comments & proofreader corrections">
        {#each comments as comment}
          <div class="comment">
            <small>{comment.username}{comment.correction ? " · proofreader correction" : ""}</small>
            <textarea rows="2" value={comment.body} oninput={(e) => oncommentinput(comment, e.currentTarget.value)}></textarea>
            <button class="link" onclick={() => ondeletecomment(comment.id)}>Delete comment</button>
          </div>
        {/each}
        <textarea bind:value={commentText} rows="2" placeholder="Add a comment"></textarea>
        <div class="btn-row">
          <label class="check"><input type="checkbox" bind:checked={commentCorrection} disabled={!canEdit} /> Proofreader correction</label>
          <span class="spacer"></span>
          <button class="small" disabled={!commentText.trim()} onclick={onaddcomment}>Add comment</button>
        </div>
      </div>
    {:else if subtab === "history"}
      {#each history as h}
        <div class="hist">
          <small>Revision {h.revision}</small>
          <p>{historyBody(h.data)}</p>
          <div><button class="small ghost" disabled={!canEdit} onclick={() => onrestore(h)}>Restore revision {h.revision} as draft</button></div>
        </div>
      {:else}
        <p class="muted">No earlier revisions.</p>
      {/each}
    {:else if subtab === "details"}
      <div bind:this={boundsEl} class="subbody" aria-label="Region bounds, split, merge and history">
        <div class="grid2">
          <label>Reading order<input
              type="number"
              aria-label="Order"
              value={pageLines.indexOf(selected) + 1}
              disabled={!canEdit}
              onchange={(e) => onedit(selected, { sortOrder: Number(e.currentTarget.value) })}
            /></label>
          <span></span>
          {#each ["x", "y", "w", "h"] as k}<label
              >{k}<input
                type="number"
                step=".005"
                min="0"
                max="1"
                value={selected[k as "x"] ?? 0}
                onchange={(e) => onedit(selected, { [k]: Number(e.currentTarget.value) })}
              /></label
            >{/each}
        </div>
        <div class="btn-row">
          <label class="grow">Split English at character<input type="number" min="1" bind:value={splitAt} /></label>
          <button class="small" aria-label="Split into two regions" onclick={onsplit}>Split</button>
        </div>
        <div class="btn-row">
          <select class="grow" aria-label="Region to merge" bind:value={mergeId}>
            <option value="">Merge with…</option>
            {#each pageLines.filter((l) => l.id !== selected.id) as l}<option value={l.id}>#{pageLines.indexOf(l) + 1} {l.body.slice(0, 32) || l.source?.slice(0, 24) || "[unreadable]"}</option>{/each}
          </select>
          <button class="small" aria-label="Merge and retain history" disabled={!mergeId} onclick={onmerge}>Merge</button>
        </div>
        <div class="btn-row">
          <input
            class="grow"
            aria-label="Ignore reason"
            placeholder="Reason to ignore"
            value={selected.ignoreReason ?? ""}
            disabled={!canEdit}
            oninput={(e) => onedit(selected, { ignoreReason: e.currentTarget.value })}
          />
          <button
            class="small"
            disabled={!canEdit || (selected.sourceState !== "ignored" && !selected.ignoreReason?.trim())}
            onclick={() => onedit(selected, { sourceState: selected.sourceState === "ignored" ? "unreadable" : "ignored" })}
          >{selected.sourceState === "ignored" ? "Reopen region" : "Explicitly ignore"}</button>
        </div>
      </div>
    {:else}
      {#if suggestionsBody && suggestionCount}
        {@render suggestionsBody()}
      {:else}
        <p class="muted">No pending suggestions. Suggestions from Transcribe, Review Transcription, Review Translation, Proofread and Enquire appear here with their origin.</p>
      {/if}
    {/if}
  </div>
</div>

<style>
  .details { display: grid; gap: 8px; }
  .subtabs { display: flex; gap: 2px; border-bottom: 1px solid var(--hud-line); flex-wrap: wrap; }
  .subtabs button {
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--hud-muted);
    padding: 5px 8px;
    border-bottom: 2px solid transparent;
    font-size: 12px;
    gap: 4px;
  }
  .subtabs button:hover:not(:disabled) { background: transparent; color: var(--hud-text); border-color: transparent; }
  .subtabs button.on { color: var(--hud-text); border-bottom-color: var(--hud-teal); }
  .subbody { display: grid; gap: 8px; }
  .badge {
    display: inline-block;
    min-width: 16px;
    padding: 0 5px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.1);
    font-size: 10.5px;
    line-height: 16px;
    text-align: center;
    color: var(--hud-text);
  }
  .muted { color: var(--hud-muted); font-size: 11.5px; margin: 0; }
  .comment, .hist { display: grid; gap: 2px; padding: 6px 8px; background: rgba(255, 255, 255, 0.03); border-radius: 4px; }
  .comment small, .hist small { color: var(--hud-muted); font-size: 11px; }
  .hist p { margin: 0; color: var(--hud-text); white-space: pre-wrap; }
  .link { border: 0; background: none; color: var(--hud-teal); padding: 0; font-size: 12px; justify-self: start; }
  .link:hover:not(:disabled) { background: none; text-decoration: underline; }
  .btn-row { display: flex; gap: 6px; align-items: flex-end; }
  .grow { flex: 1; min-width: 0; }
  .spacer { flex: 1; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .details :global(label) { margin: 0; }
  .check { align-self: center; color: var(--hud-text); font-size: 11.5px; }
</style>
