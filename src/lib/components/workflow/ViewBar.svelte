<script lang="ts">
  let {
    pageIndex,
    pageCount,
    showRegions = false,
    showMask = false,
    compare = false,
    maskLabel = "Mask",
    compareLabel = "Compare",
    zoom = 100,
    onpage,
    onregions,
    onmask,
    oncompare,
    onzoom,
    showRegionsToggle = true,
    showMaskToggle = false,
    showCompareToggle = false,
  }: {
    pageIndex: number;
    pageCount: number;
    showRegions?: boolean;
    showMask?: boolean;
    compare?: boolean;
    maskLabel?: string;
    compareLabel?: string;
    zoom?: number;
    onpage: (dir: -1 | 1) => void;
    onregions: () => void;
    onmask: () => void;
    oncompare: () => void;
    onzoom: (next: number | "fit") => void;
    showRegionsToggle?: boolean;
    showMaskToggle?: boolean;
    showCompareToggle?: boolean;
  } = $props();
  const toggles = $derived(showRegionsToggle || showMaskToggle || showCompareToggle);
</script>

<div class="viewbar" data-find="viewbar" role="toolbar" aria-label="Page view">
  <button type="button" class="vb" aria-label="Previous page" title="Previous page" disabled={pageIndex <= 1} onclick={() => onpage(-1)}><i class="bi bi-chevron-left" aria-hidden="true"></i></button>
  <span class="vb-txt">Page {pageCount ? pageIndex : "—"} / {pageCount}</span>
  <button type="button" class="vb" aria-label="Next page" title="Next page" disabled={pageIndex >= pageCount} onclick={() => onpage(1)}><i class="bi bi-chevron-right" aria-hidden="true"></i></button>
  {#if toggles}<span class="vsep"></span>{/if}
  {#if showRegionsToggle}
    <button type="button" class="vb" class:on={showRegions} data-find="view-regions" aria-pressed={showRegions} aria-label={showRegions ? "Hide region overlay" : "Show region overlay"} title="Show or hide region outlines" onclick={onregions}>
      <i class={`bi ${showRegions ? "bi-eye" : "bi-eye-slash"}`} aria-hidden="true"></i> Regions
    </button>
  {/if}
  {#if showMaskToggle}
    <button type="button" class="vb" class:on={showMask && !compare} data-find="view-mask" aria-pressed={showMask && !compare} aria-label={maskLabel} onclick={onmask}><i class="bi bi-transparency" aria-hidden="true"></i> {maskLabel.replace(/^Display /, "").replace(/^./, (c) => c.toUpperCase())}</button>
  {/if}
  {#if showCompareToggle}
    <button type="button" class="vb" class:on={compare} data-find="view-compare" aria-pressed={compare} aria-label={compareLabel} title="Hold-to-compare also works with the \ key" onclick={oncompare}><i class="bi bi-layers-half" aria-hidden="true"></i> {compareLabel}</button>
  {/if}
  <span class="vsep"></span>
  <button type="button" class="vb" aria-label="Zoom out" title="Zoom out" onclick={() => onzoom(Math.max(25, zoom - 25))}><i class="bi bi-dash" aria-hidden="true"></i></button>
  <button type="button" class="vb vb-txt" title="Fit page width" onclick={() => onzoom("fit")}>{zoom === 100 ? "Fit width" : `${zoom}%`}</button>
  <button type="button" class="vb" aria-label="Zoom in" title="Zoom in" onclick={() => onzoom(Math.min(2000, zoom + 25))}><i class="bi bi-plus" aria-hidden="true"></i></button>
</div>

<style>
  .viewbar {
    position: absolute;
    left: 50%;
    bottom: 12px;
    transform: translateX(-50%);
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px;
    border-radius: 999px;
    background: var(--hud-bg-2);
    border: 1px solid var(--hud-line);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
    backdrop-filter: blur(6px);
    white-space: nowrap;
    max-width: calc(100% - 24px);
    font-family: Inter, system-ui, sans-serif;
  }
  .vb {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 0;
    background: transparent;
    border-radius: 999px;
    padding: 5px 10px;
    font: 500 12px Inter, system-ui, sans-serif;
    letter-spacing: 0;
    text-transform: none;
    color: var(--hud-muted);
    cursor: pointer;
  }
  .vb:hover:not(:disabled) { color: var(--hud-text); background: var(--hud-hover); border: 0; }
  .vb:disabled { opacity: 0.35; cursor: default; }
  .vb.on { color: var(--hud-teal-ink); background: var(--hud-teal-dim); }
  .vb-txt { color: var(--hud-text); font-size: 12px; padding: 0 4px; }
  button.vb-txt { padding: 5px 8px; }
  .vsep { width: 1px; align-self: stretch; background: var(--hud-line); margin: 2px 4px; }
</style>
