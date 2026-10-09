<script lang="ts">
  let {
    pageNumber,
    info,
    attention = 0,
    done = false,
    stepLabel,
    canEdit = true,
    busy = false,
    showMark = true,
    undoLabel = 'Undo saved edit (Ctrl+Z)',
    undoVerbose = false,
    undoEnabled = true,
    showRedo = true,
    onundo,
    onredo,
    onmark,
    onnext,
  }: {
    pageNumber: string | number;
    info: string;
    attention?: number;
    done?: boolean;
    stepLabel: string;
    canEdit?: boolean;
    busy?: boolean;
    showMark?: boolean;
    undoLabel?: string;
    undoVerbose?: boolean;
    undoEnabled?: boolean;
    showRedo?: boolean;
    onundo: () => void;
    onredo: () => void;
    onmark: () => void;
    onnext: () => void;
  } = $props();
</script>

<div class="pagefoot">
  <div class="pf-info"><strong>Page {pageNumber}</strong> · {info}{#if attention} · <span class="warn">{attention} need attention</span>{/if}</div>
  <div class="pf-actions">
    <button type="button" class="pf-btn ghost" class:icon-only={!undoVerbose} class:verbose={undoVerbose} data-find="undo" disabled={busy || !undoEnabled} title={undoLabel} aria-label={undoLabel} onclick={onundo}><i class="bi bi-arrow-counterclockwise" aria-hidden="true"></i>{#if undoVerbose}{undoLabel}{/if}</button>
    {#if showRedo}<button type="button" class="pf-btn ghost icon-only" title="Redo (Ctrl+Shift+Z)" aria-label="Redo (Ctrl+Shift+Z)" onclick={onredo}><i class="bi bi-arrow-clockwise" aria-hidden="true"></i></button>{/if}
    {#if showMark}
      {#if done}
        <span class="done-chip" data-find="mark-done" title="Editing this page in {stepLabel} reopens it"><i class="bi bi-check-circle-fill" aria-hidden="true"></i> Done in {stepLabel}</span>
      {:else}
        <button
          type="button"
          class="pf-btn mark"
          data-find="mark-done"
          disabled={!canEdit || busy}
          title="Records this page as finished for {stepLabel} and clears its saved undo history.{stepLabel === 'Clean' ? ' Applies cleaning, approves the final artwork, clears pending masks and draft strokes, then advances to the next page.' : stepLabel === 'Typeset' ? ' Advances to the next page not marked done.' : ''} Text and artwork stay. Editing again reopens it."
          onclick={onmark}
        ><i class="bi bi-check-circle" aria-hidden="true"></i> Mark page done</button>
      {/if}
    {/if}
    <button type="button" class="pf-btn" onclick={onnext}>Next page <i class="bi bi-arrow-right" aria-hidden="true"></i></button>
  </div>
</div>

<style>
  .pagefoot {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 12px;
    min-height: 44px;
    border-top: 1px solid var(--hud-line);
    background: var(--hud-bg);
    font-family: Inter, system-ui, sans-serif;
  }
  .pf-info { color: var(--hud-muted); font-size: 12px; }
  .pf-info strong { color: var(--hud-text); }
  .warn { color: #f5b85c; }
  .pf-actions { margin-left: auto; display: flex; align-items: center; gap: 6px; }
  .pf-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border: 1px solid rgba(244, 247, 251, 0.18);
    border-radius: 5px;
    background: rgba(255, 255, 255, 0.04);
    color: var(--hud-text);
    font: 500 12.5px Inter, system-ui, sans-serif;
    letter-spacing: 0;
    text-transform: none;
    white-space: nowrap;
    cursor: pointer;
  }
  .pf-btn:hover:not(:disabled) { border-color: var(--hud-teal); background: var(--hud-teal-dim); }
  .pf-btn:disabled { opacity: 0.4; cursor: default; }
  .pf-btn.ghost { background: transparent; border-color: transparent; }
  .pf-btn.ghost:hover:not(:disabled) { border-color: rgba(244, 247, 251, 0.18); background: rgba(255, 255, 255, 0.05); }
  .pf-btn.icon-only { padding: 5px 7px; }
  .pf-btn.verbose { max-width: 420px; white-space: normal; text-align: left; }
  .pf-btn.mark { border-color: rgba(94, 227, 154, 0.5); color: #5ee39a; }
  .done-chip { display: inline-flex; gap: 6px; align-items: center; color: #5ee39a; font-size: 12.5px; padding: 0 8px; }
</style>
