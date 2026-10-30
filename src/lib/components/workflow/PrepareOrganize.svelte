<script lang="ts">
  import { PAGE_FILE_ACCEPT, isPageFile } from "$lib/pageFiles";
  import type { ImageRow } from "$lib/types";
  import type { CreditKind, SeriesCredits } from "$lib/credits";

  let {
    images,
    assetBase = "",
    pages = {},
    selectedIds = [],
    selectionDisabled = false,
    canUpload = false,
    busy = false,
    numberingStale = false,
    credits = {},
    pageMode = "pages",
    seriesId,
    onopen,
    onselect,
    onselectall,
    onreorder,
    onaddfiles,
    canCombinePages = false,
    oncombine,
    onextract,
    canRemoveRegions = false,
    onremoveregions,
    ondelete,
  }: {
    images: ImageRow[];
    assetBase?: string;
    pages?: Record<string, { data?: { thumbnail?: string; thumbnailAt?: number } }>;
    selectedIds?: string[];
    selectionDisabled?: boolean;
    canUpload?: boolean;
    busy?: boolean;
    numberingStale?: boolean;
    credits?: SeriesCredits;
    pageMode?: "pages" | "strip";
    seriesId: string;
    onopen: (id: string) => void;
    onselect: (id: string, range: boolean) => void;
    onselectall: (selected: boolean) => void;
    onreorder: (order: string[]) => void;
    onaddfiles: (files: File[]) => void;
    canCombinePages?: boolean;
    oncombine: () => void;
    onextract: () => void;
    canRemoveRegions?: boolean;
    onremoveregions: () => void;
    ondelete: () => void;
  } = $props();

  let dragId = $state("");
  let overId = $state("");
  let fileDrag = $state(false);

  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");

  function dropFiles(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    fileDrag = false;
    const files = [...(e.dataTransfer?.files ?? [])].filter(isPageFile);
    if (canUpload && files.length) onaddfiles(files);
  }

  function thumb(img: ImageRow) {
    const doc = pages[img.id]?.data;
    if (doc?.thumbnail && doc.thumbnailAt === img.updatedAt && assetBase)
      return `${assetBase}/workflow/assets/${doc.thumbnail}`;
    return `/api/images/${img.id}?v=${img.updatedAt}`;
  }

  function dropOn(targetId: string) {
    if (!dragId || dragId === targetId) return;
    const order = images.map((img) => img.id);
    const from = order.indexOf(dragId);
    const to = order.indexOf(targetId);
    if (from < 0 || to < 0) return;
    order.splice(from, 1);
    order.splice(to, 0, dragId);
    dragId = "";
    overId = "";
    onreorder(order);
  }

  function move(index: number, delta: -1 | 1) {
    const next = index + delta;
    if (next < 0 || next >= images.length) return;
    const order = images.map((img) => img.id);
    [order[index], order[next]] = [order[next], order[index]];
    onreorder(order);
  }

  const slots: { kind: CreditKind; label: string; role: string }[] = [
    { kind: "pre", label: "Pre-credits", role: "pre-credits" },
    { kind: "post", label: "Post-credits", role: "post-credits" },
  ];
</script>

{#snippet creditSlot(slot: { kind: CreditKind; label: string; role: string })}
  {@const present = images.some((img) => img.role === slot.role)}
  {@const credit = credits[slot.kind]}
  {#if !present}
    <div class="gcard ghost-slot" data-find="add-credits">
      <div class="gslot">
        {#if credit}
          <img class="credit-img" src={`/api/series/${seriesId}/credits/${slot.kind}?v=${credit.hash}`} alt="" />
        {:else}
          <i class="bi bi-award" aria-hidden="true"></i>
        {/if}
        <strong>{slot.label}</strong>
        {#if credit}
          <small>Series default · included in export</small>
        {:else}
          <small>No series {slot.label.toLowerCase()} page saved.</small>
        {/if}
      </div>
    </div>
  {/if}
{/snippet}

<div class="organize" class:strip={pageMode === "strip"} data-find="organize" role="region" aria-label="Pages"
  ondragover={(e) => { if (canUpload && hasFiles(e)) e.preventDefault(); }}
  ondrop={(e) => { if (hasFiles(e)) dropFiles(e); }}>
  <div class="grid-hint">
    <span><i class="bi bi-arrows-move" aria-hidden="true"></i> {pageMode === "strip" ? "Strip · top to bottom" : "Pages · reading order"} · Drag to reorder · Shift-click to select a range · Paste images anywhere</span>
    <span class:warning={numberingStale}>
      {numberingStale ? "Numbering is stale. Renumber after organizing." : "Numbering is current. Export names: 1, 2, 3…"}
    </span>
    <span class="spacer"></span>
    {#if canUpload && !selectedIds.length}
      <button type="button" class="ed-btn small ghost" onclick={() => onselectall(selectedIds.length !== images.length)}>
        {selectedIds.length === images.length && images.length ? "Clear selection" : "Select all"}
      </button>
    {/if}
  </div>
  {#if selectedIds.length}
    <div class="sel-bar" role="region" aria-label="Selected page actions">
      <i class="bi bi-check2-square" aria-hidden="true"></i>
      <strong>{selectedIds.length} selected</strong>
      {#if canCombinePages}
        <button type="button" class="ed-btn small" data-find="combine-spread" title={pageMode === "strip" ? "Join the selected consecutive strips top to bottom" : "Place adjacent pages side by side in the series reading direction"} disabled={selectionDisabled} onclick={oncombine}>{pageMode === "strip" ? "Join strips" : "Combine into spread"}</button>
      {/if}
      <button type="button" class="ed-btn small" disabled={selectionDisabled} onclick={onextract}>Extract to chapter…</button>
      <button type="button" class="ed-btn small danger" disabled={selectionDisabled || !canRemoveRegions} onclick={onremoveregions}>Remove all regions…</button>
      <button type="button" class="ed-btn small danger" disabled={selectionDisabled} onclick={ondelete}>Delete selected pages…</button>
      <button type="button" class="ed-btn small ghost" onclick={() => onselectall(false)}>Clear selection</button>
    </div>
  {/if}
  <div class="grid">
    {@render creditSlot(slots[0])}
    {#each images as img, index (img.id)}
      <div
        class="gcard"
        class:picked={selectedIds.includes(img.id)}
        class:dragging={dragId === img.id}
        class:drop-before={overId === img.id && dragId !== img.id && images.findIndex((i) => i.id === dragId) > index}
        class:drop-after={overId === img.id && dragId !== img.id && images.findIndex((i) => i.id === dragId) < index}
        role="listitem"
        draggable={canUpload && !selectionDisabled}
        ondragstart={(e) => {
          dragId = img.id;
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", img.id);
          }
        }}
        ondragend={() => { dragId = ""; overId = ""; }}
        ondragover={(e) => {
          if (!dragId) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
          overId = img.id;
        }}
        ondrop={(e) => {
          if (!dragId) return;
          e.preventDefault();
          dropOn(img.id);
        }}
      >
        {#if canUpload}
          <label class="gcheck" title="Select (Shift-click for a range)">
            <input
              type="checkbox"
              aria-label={`Select page ${index + 1}`}
              checked={selectedIds.includes(img.id)}
              disabled={selectionDisabled}
              onclick={(e) => onselect(img.id, e.shiftKey)}
            />
          </label>
        {/if}
        <!-- Not a <button>: Firefox will not start a drag from inside one. -->
        <div role="button" tabindex="0" class="gimg" aria-label={`Open page ${index + 1}`} title={`Open page ${index + 1} for editing · drag to reorder`}
          onclick={(e) => {
            if (canUpload && (e.shiftKey || e.ctrlKey || e.metaKey)) onselect(img.id, e.shiftKey);
            else onopen(img.id);
          }}
          onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onopen(img.id); } }}>
          <img src={thumb(img)} alt="" draggable="false" />
        </div>
        <div class="gmeta">
          <strong>{index + 1}</strong>
          <span>{img.role === "pre-credits" ? "Pre-credits" : img.role === "post-credits" ? "Post-credits" : img.filename ?? ""}</span>
          {#if canUpload}
            <div class="move-actions">
              <button type="button" class="ed-btn small" aria-label={`Move image ${index + 1} earlier`} disabled={selectionDisabled || index === 0} onclick={() => move(index, -1)}>↑</button>
              <button type="button" class="ed-btn small" aria-label={`Move image ${index + 1} later`} disabled={selectionDisabled || index === images.length - 1} onclick={() => move(index, 1)}>↓</button>
            </div>
          {/if}
        </div>
      </div>
    {/each}
    {@render creditSlot(slots[1])}
    {#if canUpload}
      <label class="gcard drop" class:over={fileDrag} data-find="upload"
        ondragover={(e) => { if (!hasFiles(e)) return; e.preventDefault(); fileDrag = true; }}
        ondragleave={() => (fileDrag = false)}
        ondrop={(e) => { if (hasFiles(e)) dropFiles(e); }}>
        <div class="gslot">
          <i class="bi bi-cloud-arrow-up" aria-hidden="true"></i>
          <strong>Add images</strong>
          <small>Drop, choose, or paste · order is previewed before upload</small>
          <input type="file" accept={PAGE_FILE_ACCEPT} multiple onchange={(e) => onaddfiles([...(e.currentTarget.files ?? [])])} />
        </div>
      </label>
    {/if}
  </div>
</div>

<style>
  .organize { flex: 1; min-height: 0; overflow: auto; padding: 14px 18px 24px; background: var(--hud-canvas); font-family: Inter, system-ui, sans-serif; }
  .grid-hint { display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center; color: var(--hud-muted); font-size: 12px; margin-bottom: 12px; }
  .warning { color: #f5b85c; }
  .spacer { flex: 1; }
  .sel-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    margin: 0 0 12px;
    padding: 7px 12px;
    border-radius: 5px;
    background: rgba(125, 211, 252, 0.08);
    font-size: 12.5px;
  }
  .sel-bar > .bi { font-size: 15px; color: #7dd3fc; }
  .ed-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    border: 1px solid var(--hud-line);
    border-radius: 5px;
    background: var(--hud-hover);
    color: var(--hud-text);
    font: 500 12px Inter, system-ui, sans-serif;
    letter-spacing: 0;
    text-transform: none;
    white-space: nowrap;
    cursor: pointer;
  }
  .ed-btn:hover:not(:disabled) { border-color: var(--hud-teal-ink); background: var(--hud-teal-dim); }
  .ed-btn:disabled { opacity: 0.4; cursor: default; }
  .ed-btn.ghost { background: transparent; border-color: transparent; }
  .ed-btn.accent { color: var(--hud-teal-ink); border-color: rgba(45, 226, 197, 0.45); }
  .ed-btn.danger { color: #ff5d73; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 14px; }
  .gcard { position: relative; background: var(--hud-bg-2); border: 1px solid var(--hud-line); border-radius: 6px; overflow: hidden; }
  .gcard.picked { border-color: var(--hud-teal-ink); box-shadow: 0 0 0 2px var(--hud-teal); }
  .gcheck { position: absolute; left: 7px; top: 7px; z-index: 2; background: var(--hud-bg-2); padding: 4px; border-radius: 6px; border: 1px solid var(--hud-line); display: block; margin: 0; line-height: 0; }
  .gcheck input { width: 15px; height: 15px; margin: 0; accent-color: var(--hud-teal-ink); }
  .gimg { display: block; width: 100%; padding: 0; border: 0; border-radius: 0; background: var(--hud-canvas); cursor: pointer; }
  .gimg img { display: block; width: 100%; aspect-ratio: 1414 / 2000; object-fit: contain; background: var(--hud-canvas); }
  .gmeta { display: flex; align-items: center; gap: 6px; padding: 5px 6px 5px 9px; font-size: 11.5px; }
  .gmeta span { color: var(--hud-muted); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .move-actions { display: flex; gap: 2px; }
  .strip .grid { grid-template-columns: minmax(0, 1fr); max-width: 720px; gap: 8px; }
  .strip .gcard:not(.ghost-slot):not(.drop) { display: grid; grid-template-columns: 128px minmax(0, 1fr); min-height: 158px; }
  .strip .gimg img { height: 158px; aspect-ratio: auto; }
  .strip .gmeta { padding: 12px; align-items: flex-start; flex-wrap: wrap; }
  .strip .gmeta strong { font-size: 18px; min-width: 30px; }
  .strip .gslot { min-height: 120px; aspect-ratio: auto; }
  .ghost-slot { border-style: dashed; background: transparent; }
  .gslot { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 6px; padding: 14px; min-height: 100%; aspect-ratio: 1414 / 2150; color: var(--hud-muted); }
  .gslot > .bi { font-size: 26px; }
  .gslot strong { color: var(--hud-text); }
  .gslot small { font-size: 11px; }
  .credit-img { width: 70%; max-height: 110px; object-fit: contain; }
  .gcard[draggable="true"] .gimg { cursor: grab; }
  .gcard.dragging { opacity: 0.4; }
  .gcard.drop-before { box-shadow: -4px 0 0 var(--hud-teal); }
  .gcard.drop-after { box-shadow: 4px 0 0 var(--hud-teal); }
  .strip .gcard.drop-before { box-shadow: 0 -4px 0 var(--hud-teal); }
  .strip .gcard.drop-after { box-shadow: 0 4px 0 var(--hud-teal); }
  .drop.over { border-style: solid; border-color: var(--hud-teal); }
  .drop { cursor: pointer; border-color: rgba(45, 226, 197, 0.5); background: var(--hud-teal-dim); display: block; color: var(--hud-text); margin: 0; }
  .drop input { display: none; }
  .drop .bi { color: var(--hud-teal-ink); }
</style>
