<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    numberingStale = false,
    onrenumber,
    conflicts,
    selection,
  }: {
    numberingStale?: boolean;
    onrenumber: () => void;
    conflicts?: Snippet;
    selection?: Snippet;
  } = $props();
</script>

<div class="studio-banners">
  {#if numberingStale}
    <div class="banner warn" role="status" data-find="numbering-banner">
      Page numbering is stale after reordering. Export names will be wrong until you renumber.
      <button type="button" class="ed-btn" data-find="renumber" onclick={onrenumber}>Renumber pages</button>
    </div>
  {/if}
  {@render selection?.()}
  {@render conflicts?.()}
</div>

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin: 8px 10px 0;
    padding: 8px 10px;
    border: 1px solid var(--hud-line);
    background: var(--hud-bg-2);
    font-size: 13px;
  }
  .banner.warn { border-color: #8a6a32; }
</style>
