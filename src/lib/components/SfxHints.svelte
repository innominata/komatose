<script lang="ts">
  import { lookupStandaloneSfx } from "$lib/sfx";

  let {
    source = "",
    current = "",
    disabled = false,
    onpick,
  }: {
    source?: string;
    current?: string;
    disabled?: boolean;
    onpick: (meaning: string) => void;
  } = $props();

  const match = $derived(lookupStandaloneSfx(source));
  const selected = $derived(current.trim().toLowerCase());
</script>

{#if match}
  <div class="sfx-hints">
    <small>SFX · {match.source}</small>
    <div class="sfx-meanings">
      {#each match.meanings as meaning}
        <button
          type="button"
          class:active={selected === meaning.toLowerCase()}
          {disabled}
          onclick={() => onpick(meaning)}>{meaning}</button
        >
      {/each}
    </div>
  </div>
{/if}

<style>
  .sfx-hints {
    margin: 0 0 8px;
  }
  .sfx-hints small {
    display: block;
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--hud-muted, #9a8f7a);
    margin-bottom: 4px;
  }
  .sfx-meanings {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .sfx-hints :global(button) {
    text-transform: none;
    letter-spacing: 0;
    font-weight: 500;
    padding: 2px 8px;
    font-size: 12px;
  }
  .sfx-hints :global(button.active) {
    color: var(--accent, var(--ed-active, var(--hud-teal)));
    border-color: var(--accent, var(--ed-active, var(--hud-teal)));
  }
</style>
