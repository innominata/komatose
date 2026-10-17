<script lang="ts">
  let {
    pageIndex,
    pageCount,
    regionVisibility = "shown",
    showMask = false,
    compare = false,
    reviewView,
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
    maskStaysWithCompare = false,
  }: {
    pageIndex: number;
    pageCount: number;
    regionVisibility?: "shown" | "ghost" | "off";
    showMask?: boolean;
    compare?: boolean;
    reviewView?: "normal" | "raw" | "side-by-side";
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
    maskStaysWithCompare?: boolean;
  } = $props();
  const toggles = $derived(showRegionsToggle || showMaskToggle || showCompareToggle);
  const maskOn = $derived(showMask && (maskStaysWithCompare || !compare));
</script>

<div class="viewbar" data-find="viewbar" role="toolbar" aria-label="Page view">
  <button type="button" class="vb" aria-label="Previous page" title="Previous page" disabled={pageIndex <= 1} onclick={() => onpage(-1)}><i class="bi bi-chevron-left" aria-hidden="true"></i></button>
  <span class="vb-txt">Page {pageCount ? pageIndex : "—"} / {pageCount}</span>
  <button type="button" class="vb" aria-label="Next page" title="Next page" disabled={pageIndex >= pageCount} onclick={() => onpage(1)}><i class="bi bi-chevron-right" aria-hidden="true"></i></button>
  {#if toggles}<span class="vsep"></span>{/if}
  {#if showRegionsToggle}
    <button type="button" class="vb" class:on={regionVisibility === "shown"} class:ghost={regionVisibility === "ghost"} data-find="view-regions" aria-label={`Regions: ${regionVisibility}. Next: ${regionVisibility === "shown" ? "ghost" : regionVisibility === "ghost" ? "off" : "shown"}`} title="Cycle region overlay: shown → ghost (10% opacity) → off" onclick={onregions}>
      <i class={`bi ${regionVisibility === "off" ? "bi-eye-slash" : "bi-eye"}`} aria-hidden="true"></i> Regions<span class="vb-state">{regionVisibility}</span>
    </button>
  {/if}
  {#if showMaskToggle}
    <button type="button" class="vb" class:on={maskOn} data-find="view-mask" aria-pressed={maskOn} aria-label={maskLabel} onclick={onmask}><i class="bi bi-transparency" aria-hidden="true"></i> {maskLabel.replace(/^Display /, "").replace(/^./, (c) => c.toUpperCase())}</button>
  {/if}
  {#if showCompareToggle}
    {#if reviewView}
      <button type="button" class="vb" class:on={reviewView === "raw"} class:ghost={reviewView === "side-by-side"} data-find="view-compare"
        aria-label={`Raw view: ${reviewView}. Next: ${reviewView === "normal" ? "raw" : reviewView === "raw" ? "side by side" : "normal"}`}
        title="Cycle artwork: normal → raw → side by side" onclick={oncompare}>
        <i class="bi bi-layers-half" aria-hidden="true"></i> Show raw<span class="vb-state">{reviewView === "side-by-side" ? "side by side" : reviewView}</span>
      </button>
    {:else}
      <button type="button" class="vb" class:on={compare} data-find="view-compare" aria-pressed={compare} aria-label={compareLabel} onclick={oncompare}><i class="bi bi-layers-half" aria-hidden="true"></i> {compareLabel}</button>
    {/if}
  {/if}
  <span class="vsep"></span>
  <button type="button" class="vb" aria-label="Zoom out" title="Zoom out" onclick={() => onzoom(Math.max(25, zoom - 25))}><i class="bi bi-dash" aria-hidden="true"></i></button>
  <button type="button" class="vb vb-txt" title={reviewView === "side-by-side" ? "Fit both pages" : "Fit page width"} onclick={() => onzoom("fit")}>{zoom === 100 ? (reviewView === "side-by-side" ? "Fit both" : "Fit width") : `${zoom}%`}</button>
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
  .vb.ghost { color: var(--hud-text); background: var(--hud-hover); }
  .vb.ghost i { opacity: 0.35; }
  .vb-state { font-size: 10px; opacity: 0.8; }
  .vb-txt { color: var(--hud-text); font-size: 12px; padding: 0 4px; }
  button.vb-txt { padding: 5px 8px; }
  .vsep { width: 1px; align-self: stretch; background: var(--hud-line); margin: 2px 4px; }
</style>
