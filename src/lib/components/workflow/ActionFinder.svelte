<script lang="ts">
  import { searchStudioActions, type StudioAction } from "$lib/studioActions";

  let {
    open = $bindable(false),
    query = $bindable(""),
    onpick,
  }: {
    open?: boolean;
    query?: string;
    onpick: (action: StudioAction) => void;
  } = $props();

  let cursor = $state(0);
  const results = $derived(searchStudioActions(query).slice(0, 60));

  $effect(() => {
    query;
    cursor = 0;
  });

  function move(dir: number) {
    if (!results.length) return;
    cursor = (cursor + dir + results.length) % results.length;
  }

  function choose(index = cursor) {
    const action = results[index];
    if (!action) return;
    open = false;
    onpick(action);
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      open = false;
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose();
    }
  }}
/>

{#if open}
  <div class="finder-backdrop" role="presentation" onclick={() => (open = false)}></div>
  <div class="finder" role="dialog" aria-label="Find an action">
    <input
      bind:value={query}
      placeholder="Find an action, or an old name"
      aria-label="Find an action"
      autofocus
    />
    <div class="finder-list" role="listbox">
      {#each results as action, index (action.id)}
        <button
          type="button"
          role="option"
          aria-selected={index === cursor}
          class:on={index === cursor}
          onclick={() => choose(index)}
        >
          <span>{action.label}</span>
          <small>{action.where}</small>
          {#if action.was && action.was !== "(new)"}<em>was: {action.was}</em>{/if}
        </button>
      {:else}
        <p>No match. {searchStudioActions("").length} actions indexed.</p>
      {/each}
    </div>
  </div>
{/if}

<style>
  .finder-backdrop { position: fixed; inset: 0; z-index: 70; background: rgba(0, 0, 0, 0.35); }
  .finder {
    position: fixed;
    z-index: 71;
    left: 50%;
    top: 12vh;
    transform: translateX(-50%);
    width: min(640px, calc(100vw - 24px));
    background: var(--hud-bg-2);
    border: 1px solid var(--hud-line);
    border-radius: 10px;
    overflow: hidden;
  }
  .finder input {
    width: 100%;
    border: 0;
    border-bottom: 1px solid var(--hud-line);
    background: transparent;
    color: var(--hud-text);
    padding: 12px 14px;
    font-size: 15px;
  }
  .finder-list { max-height: 50vh; overflow: auto; }
  .finder-list button {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    width: 100%;
    text-align: left;
    border: 0;
    background: transparent;
    color: var(--hud-text);
    padding: 8px 14px;
  }
  .finder-list button.on { background: var(--hud-teal-dim); }
  .finder-list small, .finder-list em { color: var(--hud-muted); font-size: 11px; font-style: normal; }
  .finder-list p { margin: 0; padding: 12px 14px; color: var(--hud-muted); }
</style>
