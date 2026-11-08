<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    conflicts,
    selection,
  }: {
    conflicts?: Snippet;
    selection?: Snippet;
  } = $props();
</script>

<div class="studio-banners">
  {@render selection?.()}
  {@render conflicts?.()}
</div>

