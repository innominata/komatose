<script lang="ts">
  import { MIN_SLICE_HEIGHT, MAX_SLICE_HEIGHT, type ResliceSizing } from "$lib/reslice";

  let {
    sizing = $bindable<ResliceSizing>("pages"),
    maxHeight = $bindable<number | undefined>(2048),
    disabled = false,
  }: {
    sizing?: ResliceSizing;
    maxHeight?: number;
    disabled?: boolean;
  } = $props();
</script>

<div class="slice-size">
  <label>Slice size
    <select bind:value={sizing} {disabled} aria-label="Strip slice size">
      <option value="pages">Normal pages (1.5× width)</option>
      <option value="custom">Custom height</option>
      <option value="strips">Tall strips (16,000 px)</option>
    </select>
  </label>
  {#if sizing === "custom"}
    <label>Target height
      <input type="number" min={MIN_SLICE_HEIGHT} max={MAX_SLICE_HEIGHT} step="1"
        bind:value={maxHeight} {disabled} aria-label="Target slice height" /> px
    </label>
  {/if}
</div>

<style>
  .slice-size { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font: 12px Inter, system-ui, sans-serif; }
  label { display: inline-flex; align-items: center; gap: 6px; margin: 0; color: var(--hud-muted); }
  select, input { border: 1px solid var(--hud-line); border-radius: 5px; padding: 4px 6px; background: var(--hud-bg); color: var(--hud-text); font: inherit; }
  input { width: 80px; }
</style>
