<script lang="ts">
  import "./studio-controls.css";
  import { type LineRow } from "$lib/types";
  import { builtinRegionKinds, regionKindOptions, type RegionKind } from "$lib/regionCatalog";
  import { groupFontsByCategory } from "$lib/fontCategories";
  import {
    MIN_STYLE_SIZE,
    TEXT_WARP_STYLE_LABELS,
    TEXT_WARP_STYLES,
    type FontAsset,
    type RegionData,
    type TextStyle,
    type WorkflowDoc,
  } from "$lib/workflow";

  let {
    selected,
    regionDoc,
    regionIndex,
    canEdit,
    canClean,
    canUpload,
    busy,
    regionStyle = $bindable(),
    fonts,
    stale,
    regionKinds = builtinRegionKinds(),
    onedit,
    onsettype,
    onapplystyle,
    onresetstyle,
    onrefitcategory,
    categoryLabel = 'category',
    fitting = false,
    onfit,
    onlock,
    onrectangle,
    onfitbubble,
    onapprovegeometry,
    canSegmentBubble = false,
    onrefinebubble,
    tab = "text",
  }: {
    selected: LineRow | undefined;
    regionDoc: WorkflowDoc<RegionData> | undefined;
    regionIndex: number;
    canEdit: boolean;
    canClean: boolean;
    canUpload: boolean;
    busy: boolean;
    regionStyle: TextStyle;
    fonts: FontAsset[];
    stale: boolean;
    regionKinds?: RegionKind[];
    onedit: (line: LineRow, patch: Record<string, unknown>) => void;
    onsettype: (line: LineRow, lineType: string) => void;
    onapplystyle: (scope?: string) => void;
    onresetstyle: () => void;
    onrefitcategory: () => void;
    categoryLabel?: string;
    fitting?: boolean;
    onfit?: () => void;
    onlock?: () => void;
    onrectangle?: () => void;
    onfitbubble?: () => void;
    onapprovegeometry?: () => void;
    canSegmentBubble?: boolean;
    onrefinebubble?: () => void;
    tab?: "text" | "style" | "shape";
  } = $props();

  const fontGroups = $derived(groupFontsByCategory(fonts));
  const fontChoices = $derived(fontGroups.flatMap(group => group.fonts));

  function cycleFont(direction: -1 | 1) {
    if (!canClean || busy || !regionDoc || regionDoc.data.locked || !fontChoices.length) return;
    const current = fontChoices.findIndex(font => font.id === regionStyle.fontId);
    const next = current < 0
      ? direction === 1 ? 0 : fontChoices.length - 1
      : (current + direction + fontChoices.length) % fontChoices.length;
    if (fontChoices[next].id === regionStyle.fontId) return;
    regionStyle.fontId = fontChoices[next].id;
    void onapplystyle();
  }
</script>

<div class="wf-ui ts-insp">
  {#if selected && regionDoc}
    {#if regionDoc.data.layout?.overflow}
      <p class="overflow-alert" role="alert">Text overflow · lettering does not fit at the minimum size</p>
    {/if}
    <h2>Region {regionIndex}</h2>
    <div class="control-row">
      <button
        type="button"
        aria-label={regionDoc.data.locked ? "Unlock layout" : "Lock layout"}
        disabled={!canClean}
        onclick={() => onlock?.()}
      >{regionDoc.data.locked ? "Unlock layout" : "Lock layout"}</button>
      <button type="button" disabled={!canClean || busy || regionDoc.data.locked} onclick={() => onrectangle?.()}>Set polygon to region bounds</button>
    </div>
    {#if tab === "text"}
    <div data-find="autofit-region">
    <label
      >English · manual breaks<textarea
        rows="4"
        value={selected.body}
        disabled={!canEdit}
        oninput={(e) => onedit(selected, { body: e.currentTarget.value })}
      ></textarea></label
    >
    <label
      >Region type<select
        aria-label="Region type"
        value={selected.lineType}
        disabled={!canEdit && !canClean}
        onchange={(e) =>
          onsettype(selected, e.currentTarget.value)}
        >{#each regionKindOptions(regionKinds, selected.lineType) as t}<option value={t.id}>{t.label}</option
        >{/each}</select
      ></label
    >
    </div>
    {/if}
    {#if tab === "style"}
    <p class="panel-hint" data-find="style">Category defaults come from the series across all chapters. Changes here override this region; Use series style removes those overrides.</p>
    <details open>
      <summary>Character · override series style</summary>
      <fieldset
        disabled={!canClean || busy || regionDoc.data.locked}
        onchange={() => void onapplystyle()}
      >
        <div class="font-picker">
          <label for="region-font-face">Font face</label>
          <div class="font-controls">
            <select id="region-font-face" aria-label="Font face" bind:value={regionStyle.fontId}
            ><option value="">Select uploaded font</option
            >{#each fontGroups as group}<optgroup label={group.label}
                >{#each group.fonts as f}<option value={f.id}
                    >{f.familyName} · {f.subfamilyName}</option
                  >{/each}</optgroup
              >{/each}</select
            >
            <button type="button" aria-label="Previous font" title="Previous font" disabled={!fontChoices.length} onclick={() => cycleFont(-1)}><i class="bi bi-chevron-left" aria-hidden="true"></i></button>
            <button type="button" aria-label="Next font" title="Next font" disabled={!fontChoices.length} onclick={() => cycleFont(1)}><i class="bi bi-chevron-right" aria-hidden="true"></i></button>
          </div>
        </div>
        <div class="style-grid">
          {#each [["size", "Default size (pt)"], ["minSize", "Minimum size (pt)"], ["leading", "Leading multiplier"], ["padding", "Padding (pt)"], ["outlineWidth", "Outline (pt)"], ["rotation", "Rotation (°)"], ["skewX", "Skew H (°)"], ["skewY", "Skew V (°)"]] as [k, label]}<label
              >{label}<input
                type="number"
                step={k === "skewX" || k === "skewY" ? 1 : ".25"}
                min={k === "size" || k === "minSize"
                  ? MIN_STYLE_SIZE
                  : k === "skewX" || k === "skewY"
                    ? -75
                    : undefined}
                max={k === "skewX" || k === "skewY" ? 75 : undefined}
                bind:value={regionStyle[k as "size"]}
              /></label
            >{/each}<label
            >Warp (Photoshop)<select
              aria-label="Warp style"
              bind:value={regionStyle.warpStyle}
              onchange={() => {
                if (regionStyle.warpStyle !== "none" && !regionStyle.warpBend)
                  regionStyle.warpBend = 50;
              }}
              >{#each TEXT_WARP_STYLES as w}<option value={w}
                >{TEXT_WARP_STYLE_LABELS[w]}</option
              >{/each}</select
            ></label
          ><label
            >Bend (%)<input
              type="number"
              aria-label="Bend (%)"
              step="1"
              min="-100"
              max="100"
              disabled={regionStyle.warpStyle === "none"}
              bind:value={regionStyle.warpBend}
            /></label
          ><label
            >Alignment<select bind:value={regionStyle.align}
              ><option>center</option><option>left</option><option>right</option
              ></select
            ></label
          ><label
            >Emphasis<select bind:value={regionStyle.emphasis}
              ><option>normal</option><option>bold</option><option>italic</option
              ></select
            ></label
          ><label
            ><input type="checkbox" bind:checked={regionStyle.autoContrast} /> Automatic
            black / white contrast</label
          ><label
            >Fill<input
              type="color"
              disabled={regionStyle.autoContrast !== false}
              bind:value={regionStyle.fill}
            /></label
          ><label
            >Outline color<input type="color" bind:value={regionStyle.outline} /></label
          >
        </div>
      </fieldset>
      <small>Changes save and update placed text automatically.</small>
      <div class="control-row">
        <button type="button" disabled={!canClean || busy || regionDoc?.data.locked} onclick={() => onfit?.()}>Auto-fit</button>
        <button type="button" disabled={!canClean || busy || regionDoc.data.locked}
          onclick={onresetstyle}>Use series style</button
        >{#if canUpload}<button type="button" disabled={!canClean || busy || regionDoc.data.locked} onclick={() => onapplystyle("series")}
            >Save as series {categoryLabel} style…</button
          >{/if}
        <button type="button" data-find="refit-category" disabled={!canClean || busy || fitting}
          onclick={onrefitcategory}>Refit {categoryLabel} in chapter…</button>
      </div>
      <small>Category refit uses the saved series style and existing geometry. Locked layouts are skipped; individual placement transforms and text masks stay.</small>
    </details>
    {/if}
    {#if tab === "shape"}
      <section class="sec" data-find="bubble-shape">
        <h3>Bubble geometry</h3>
        <p class="panel-hint">Draw a rectangle, oval, or polygon on the Geometry rail tools. Fit bubble traces the speech bubble; approve once the outline matches the art.</p>
        <div class="control-row">
          <button type="button" disabled={busy || !canClean || regionDoc.data.locked} data-find="fit-bubble" onclick={() => onfitbubble?.()}><i class="bi bi-crosshair" aria-hidden="true"></i> Fit bubble (enclosed interior)</button>
          {#if canSegmentBubble}
            <button type="button" disabled={busy || !canClean || regionDoc.data.locked} onclick={() => onrefinebubble?.()}><i class="bi bi-bounding-box-circles" aria-hidden="true"></i> Refine with model points</button>
          {/if}
          <button type="button" disabled={busy || !canClean || regionDoc.data.locked} onclick={() => onrectangle?.()}><i class="bi bi-bounding-box" aria-hidden="true"></i> Set polygon to region bounds</button>
          <button type="button" disabled={busy || !canClean} data-find="approve-geometry" onclick={() => onapprovegeometry?.()}><i class="bi bi-check2-square" aria-hidden="true"></i> Approve geometry</button>
        </div>
        {#if regionDoc.data.geometryApproved}
          <p class="muted">Geometry approved{#if regionDoc.data.geometryConfidence != null} · confidence {Math.round(regionDoc.data.geometryConfidence * 100)}%{/if}</p>
        {:else}
          <p class="muted">Needs geometry approval</p>
        {/if}
      </section>
      <p data-find="text-mask">Text mask brush and erase are on the rail. Knock out and clear text mask are on the region menu.</p>
    {/if}
    {#if tab === "text" && regionDoc.data.layout}
      <p class:warning={regionDoc.data.layout.overflow || stale}>
        {regionDoc.data.layout.size} pt · {regionDoc.data.layout.dpi} DPI · {regionDoc
          .data.layout.overflow
          ? "OVERFLOW"
          : stale
            ? "STALE"
            : "Fitted"}{regionDoc.data.layout.hyphenated
          ? " · dictionary hyphenation used"
          : ""}
      </p>
      <pre>{regionDoc.data.layout.rows.map((r) => r.text).join("\n")}</pre>
      {#if regionDoc.data.layout.missingGlyphs.length}
        <p class="warning">
          Missing glyphs: {regionDoc.data.layout.missingGlyphs.join(" ")}
        </p>
      {/if}
    {/if}
  {:else}
    <p>Select a numbered region to set type.</p>
  {/if}
</div>

<style>
  .ts-insp { padding: 12px 14px; display: grid; gap: 8px; border-bottom: 1px solid var(--hud-line); }
  .ts-insp :global(label) { margin: 0; display: grid; gap: 4px; }
  .ts-insp p { margin: 0; color: var(--hud-muted); font-size: 12px; }
  .control-row { display: flex; gap: 6px; flex-wrap: wrap; }
  .font-picker { display: grid; gap: 4px; }
  .font-controls { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 4px; }
  .font-controls select { min-width: 0; }
  .font-controls button { justify-content: center; padding: 5px 8px; }
  .ts-insp details { border: 1px solid var(--hud-line); border-radius: 5px; padding: 8px 10px; display: grid; gap: 8px; }
  .ts-insp summary { cursor: pointer; font-size: 12px; color: var(--hud-text); }
  .ts-insp fieldset { border: 0; padding: 0; margin: 8px 0; display: grid; gap: 8px; }
  .ts-insp pre { margin: 0; padding: 8px; background: var(--hud-bg); border-radius: 4px; font-size: 11.5px; white-space: pre-wrap; }
  h2 {
    font:
      700 12px "Manrope", sans-serif;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0;
  }
  .style-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
  }
  .sec { display: grid; gap: 8px; }
  .sec h3 {
    font: 700 12px "Manrope", sans-serif;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0;
  }
</style>
