<script lang="ts">
  import { romanize } from "$lib/romanize";

  let { text = "" }: { text?: string } = $props();
  let shown = $state("");

  $effect(() => {
    const source = text ?? "";
    let cancelled = false;
    shown = "";
    void romanize(source).then((value) => {
      if (!cancelled) shown = value;
    });
    return () => {
      cancelled = true;
    };
  });
</script>

{#if shown}
  <p class="source-romaji" lang="en">{shown}</p>
{/if}

<style>
  .source-romaji {
    margin: 2px 0 8px;
    font-size: 12px;
    font-style: italic;
    color: var(--hud-muted, #9a8f7a);
    white-space: pre-wrap;
    line-height: 1.4;
  }
</style>
