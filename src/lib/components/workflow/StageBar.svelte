<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    step,
    scope,
    pageLabel,
    showScope = true,
    note = "",
    onscope,
    children,
    right,
  }: {
    step: string;
    scope: "page" | "chapter";
    pageLabel: string;
    showScope?: boolean;
    note?: string;
    onscope: (next: "page" | "chapter") => void;
    children?: Snippet;
    right?: Snippet;
  } = $props();
</script>

<div class="stagebar" aria-label={`${step} actions`} role="toolbar">
  <div class="sb-actions stage-actions">
    {#if showScope}
      <div class="scope" role="group" aria-label="Run on" data-find="scope" title="Choose what the run buttons apply to">
        <button type="button" class:on={scope === "page"} onclick={() => onscope("page")}>{pageLabel}</button>
        <button type="button" class:on={scope === "chapter"} title={note || undefined} onclick={() => onscope("chapter")}>Whole chapter{#if note}&nbsp;<i class="bi bi-info-circle" aria-hidden="true"></i>{/if}</button>
      </div>
    {/if}
    {@render children?.()}
  </div>
  {#if right}<div class="sb-right">{@render right()}</div>{/if}
</div>

<style>
  .stagebar {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    padding: 5px 10px;
    flex-wrap: wrap;
    row-gap: 6px;
    border-bottom: 1px solid var(--hud-line);
    background: var(--hud-bg);
    font-family: Inter, system-ui, sans-serif;
  }
  .sb-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    flex-wrap: wrap;
  }
  .sb-right { margin-left: auto; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .stagebar :global(.ed-btn) {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: Inter, system-ui, sans-serif;
    font-weight: 500;
    letter-spacing: 0;
    text-transform: none;
    font-size: 12.5px;
    line-height: 1.3;
    white-space: nowrap;
    padding: 5px 10px;
    border-radius: 999px;
    border: 1px solid var(--hud-line);
    background: var(--hud-btn-bg);
    color: var(--hud-text);
    flex: 0 0 auto;
  }
  .stagebar :global(.ed-btn:hover:not(:disabled)) {
    border-color: var(--hud-teal-ink);
    background: var(--hud-teal-dim);
  }
  .stagebar :global(.ed-btn.primary) {
    background: transparent;
    border-color: var(--hud-teal-ink);
    color: var(--hud-teal-ink);
    font-weight: 600;
  }
  .stagebar :global(.ed-btn.primary:hover:not(:disabled)) { background: var(--hud-teal-dim); }
  .stagebar :global(.ed-btn.forward) {
    background: var(--hud-primary);
    border-color: var(--hud-primary);
    color: var(--hud-on-primary);
  }
  .stagebar :global(.ed-btn.forward:hover:not(:disabled)) {
    background: var(--hud-primary);
    color: var(--hud-on-primary);
    filter: brightness(1.08);
  }
  .stagebar :global(.ed-btn.ghost) { background: transparent; border-color: transparent; }
  .stagebar :global(.ed-btn.ghost:hover:not(:disabled)) { border-color: var(--hud-line); background: var(--hud-hover); }
  .stagebar :global(.ed-btn.icon-only) { padding: 5px 7px; }
  .stagebar :global(.ed-btn:disabled) { opacity: 0.4; cursor: default; }
  .stagebar :global(.model-chip) {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border: 1px dashed var(--hud-line);
    background: transparent;
    border-radius: 999px;
    padding: 4px 10px;
    font: 500 11.5px Inter, system-ui, sans-serif;
    letter-spacing: 0;
    text-transform: none;
    color: var(--hud-muted);
  }
  .stagebar :global(.model-chip:hover) { color: var(--hud-text); border-color: var(--hud-teal-ink); background: transparent; }
  .scope {
    display: inline-flex;
    border: 1px solid var(--hud-line);
    border-radius: 999px;
    overflow: hidden;
    flex: 0 0 auto;
  }
  .scope button {
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--hud-muted);
    padding: 5px 10px;
    font: 500 12px Inter, system-ui, sans-serif;
    letter-spacing: 0;
    text-transform: none;
  }
  .scope button + button { border-left: 1px solid var(--hud-line); }
  .scope button.on {
    background: var(--hud-teal-dim);
    color: var(--hud-teal-ink);
  }
</style>
