<script lang="ts">
  import { tick } from "svelte";
  import {
    currentBreaks,
    normalizeBreaks,
    oversizedSlices,
    type StripPage,
    type StripRange,
  } from "$lib/stripBreaks";

  export type StripLayoutView = {
    width: number;
    height: number;
    pages: (StripPage & { prepared?: string; updatedAt: number })[];
    bands: StripRange[];
    protected: (StripRange & { id: string })[];
    autoCuts: number[];
    maxHeight: number;
    allowedHeight: number;
    revisionToken: string;
  };
  type Point = { x: number; y: number };

  let {
    layout,
    breaks = $bindable([]),
    tool,
    zoom,
    zooming = false,
    disabled = false,
    selectedId = "",
    pageSrc,
    pageNumber,
    onselectpage,
    oncrop,
    onzoom,
    scrollEl = $bindable(),
    scrollAction = () => {},
  }: {
    layout: StripLayoutView;
    breaks?: number[];
    tool: string;
    zoom: number;
    zooming?: boolean;
    disabled?: boolean;
    selectedId?: string;
    pageSrc: (page: StripLayoutView["pages"][number]) => string;
    pageNumber: (id: string) => number;
    onselectpage: (id: string) => void;
    oncrop: (rect: { imageId: string; x: number; y: number; w: number; h: number }) => void;
    onzoom: (dir: 1 | -1, at?: { clientX: number; clientY: number }) => void;
    scrollEl?: HTMLDivElement;
    scrollAction?: (node: HTMLElement) => { destroy?: () => void } | void;
  } = $props();

  /** Screen pixels within which a dragged or added break snaps into a solid-colour gap. */
  const SNAP_PX = 24;
  let strip = $state<HTMLDivElement>();
  let dragIndex = $state<number | null>(null);
  let focusIndex = $state<number | null>(null);
  let hoverY = $state<number | null>(null);
  let crop = $state<{ imageId: string; start: Point; end: Point } | null>(null);

  const original = $derived(currentBreaks(layout.pages));
  const originalSet = $derived(new Set(original));
  const pendingSet = $derived(new Set(breaks));
  const removed = $derived(original.filter((b) => !pendingSet.has(b)));
  const oversized = $derived(oversizedSlices(layout.height, normalizeBreaks(breaks, layout.height), layout.allowedHeight));
  const pct = (y: number) => `${(y / layout.height) * 100}%`;
  const inBand = (y: number) => layout.bands.some((b) => y >= b.top && y < b.bottom);
  const blockedBy = (y: number) => originalSet.has(y) ? undefined : layout.protected.find((r) => y > r.top && y < r.bottom);
  const stateOf = (y: number) => blockedBy(y) ? "blocked" : originalSet.has(y) ? "kept" : inBand(y) ? "added" : "forced";
  const label = { kept: "Current break", added: "New break", forced: "New break through artwork", blocked: "Break crosses a region" } as const;

  /** Strip pixels per screen pixel, so snapping feels the same at every zoom. */
  function scale() {
    const box = strip?.getBoundingClientRect();
    return box && box.height ? layout.height / box.height : 1;
  }
  function stripPoint(e: PointerEvent | MouseEvent): Point {
    const box = strip!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(layout.width, ((e.clientX - box.left) / box.width) * layout.width)),
      y: Math.max(0, Math.min(layout.height, ((e.clientY - box.top) / box.height) * layout.height)),
    };
  }
  /** Prefer the middle of a nearby gutter; a tall flat area keeps the pointer position. */
  function snap(y: number, free: boolean) {
    const at = Math.round(y);
    if (free) return at;
    const reach = SNAP_PX * scale();
    let best: number | null = null;
    for (const b of layout.bands) {
      const tall = b.bottom - b.top > 2 * reach;
      const target = at >= b.top && at < b.bottom
        ? (tall ? at : Math.round((b.top + b.bottom) / 2))
        : tall ? (at < b.top ? b.top : b.bottom - 1) : Math.round((b.top + b.bottom) / 2);
      const distance = at >= b.top && at < b.bottom ? 0 : Math.min(Math.abs(at - b.top), Math.abs(at - (b.bottom - 1)));
      if (distance <= reach && (best === null || Math.abs(target - at) < Math.abs(best - at))) best = target;
    }
    return best ?? at;
  }
  const valid = (y: number) => y > 0 && y < layout.height;
  function commit(next: number[]) {
    breaks = normalizeBreaks(next, layout.height);
  }
  function pageAt(p: Point) {
    return layout.pages.find((page) => p.y >= page.top && p.y < page.top + page.height) ?? layout.pages.at(-1)!;
  }
  /** A break the pointer is on, in screen pixels. */
  function breakNear(p: Point) {
    const reach = 6 * scale();
    let best = -1;
    breaks.forEach((b, i) => {
      if (Math.abs(b - p.y) <= reach && (best < 0 || Math.abs(b - p.y) < Math.abs(breaks[best] - p.y))) best = i;
    });
    return best < 0 ? null : best;
  }

  function startDrag(e: PointerEvent, index: number) {
    if (disabled || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    dragIndex = index;
    focusIndex = index;
    strip!.setPointerCapture(e.pointerId);
  }
  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    if (zooming) { onzoom(e.altKey ? -1 : 1, e); return; }
    const p = stripPoint(e);
    const near = breakNear(p);
    if (near !== null && !disabled && tool !== "crop") { startDrag(e, near); return; }
    if (tool === "add-break") {
      if (disabled) return;
      const y = snap(p.y, e.altKey);
      if (!valid(y) || pendingSet.has(y)) return;
      commit([...breaks, y]);
      focusIndex = breaks.indexOf(y);
      return;
    }
    const page = pageAt(p);
    if (tool === "crop") {
      if (disabled) return;
      if (page.id !== selectedId) onselectpage(page.id);
      strip!.setPointerCapture(e.pointerId);
      crop = { imageId: page.id, start: p, end: p };
      return;
    }
    focusIndex = null;
    if (page.id !== selectedId) { followSelection = false; onselectpage(page.id); }
  }
  function move(e: PointerEvent) {
    const p = stripPoint(e);
    if (dragIndex !== null) {
      const y = snap(p.y, e.altKey);
      if (valid(y)) breaks = breaks.map((b, i) => (i === dragIndex ? y : b));
      return;
    }
    if (crop) { crop = { ...crop, end: p }; return; }
    hoverY = tool === "add-break" && !disabled ? snap(p.y, e.altKey) : null;
  }
  function up() {
    if (dragIndex !== null) {
      const y = breaks[dragIndex];
      commit(breaks);
      focusIndex = breaks.indexOf(y);
      dragIndex = null;
    }
    if (crop) {
      const page = layout.pages.find((pg) => pg.id === crop!.imageId)!;
      const left = (layout.width - page.width) / 2;
      const clampX = (x: number) => Math.max(0, Math.min(page.width, x - left));
      const clampY = (y: number) => Math.max(0, Math.min(page.height, y - page.top));
      const x1 = clampX(crop.start.x), x2 = clampX(crop.end.x), y1 = clampY(crop.start.y), y2 = clampY(crop.end.y);
      const rect = { imageId: page.id, x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
      crop = null;
      if (rect.w >= 16 && rect.h >= 16) oncrop(rect);
    }
  }
  function remove(index: number) {
    if (disabled) return;
    commit(breaks.filter((_, i) => i !== index));
    focusIndex = null;
  }
  function restore(y: number) {
    if (disabled) return;
    commit([...breaks, y]);
  }
  function key(e: KeyboardEvent, index: number) {
    // The studio's shortcuts would otherwise delete or move the selected region.
    if (["Delete", "Backspace", "ArrowUp", "ArrowDown"].includes(e.key)) e.stopPropagation();
    if (disabled) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      remove(index);
      return;
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const y = breaks[index] + (e.key === "ArrowUp" ? -1 : 1) * (e.shiftKey ? 10 : 1);
    if (!valid(y) || breaks.some((b, i) => i !== index && b === y)) return;
    const next = breaks.map((b, i) => (i === index ? y : b));
    commit(next);
    focusIndex = breaks.indexOf(y);
    void tick().then(() => (strip?.querySelector(`[data-break-index="${focusIndex}"]`) as HTMLElement | null)?.focus());
  }

  /** Follow the sidebar: scroll a page picked elsewhere into view, but not one clicked here. */
  let followSelection = true;
  let scrolledFor = "";
  $effect(() => {
    const id = selectedId, height = layout.height;
    const target = `${id}:${height}`;
    if (!id || target === scrolledFor) return;
    scrolledFor = target;
    if (!followSelection) { followSelection = true; return; }
    void tick().then(() => scrollToY(layout.pages.find((p) => p.id === id)?.top ?? 0));
  });
  export function scrollToY(y: number) {
    if (!scrollEl || !strip) return;
    const s = scrollEl.getBoundingClientRect(), box = strip.getBoundingClientRect();
    scrollEl.scrollTo({ top: Math.max(0, scrollEl.scrollTop + box.top - s.top + (y / layout.height) * box.height - 24) });
  }

  const sliceLabels = $derived.by(() => {
    const bounds = [0, ...normalizeBreaks(breaks, layout.height), layout.height];
    return bounds.slice(1).map((bottom, i) => ({ top: bounds[i], bottom, height: bottom - bounds[i] }));
  });
</script>

<div class="canvas-scroll strip-scroll" class:zoom-mode={zooming} bind:this={scrollEl} use:scrollAction>
  <div
    bind:this={strip}
    class="strip"
    class:add-mode={tool === "add-break" && !disabled}
    class:crop-mode={tool === "crop" && !disabled}
    class:zoom-tool={zooming}
    class:dragging={dragIndex !== null}
    style={`aspect-ratio:${layout.width}/${layout.height};width:min(${zoom}%, ${(layout.width * zoom) / 100}px)`}
    role="application"
    aria-label="Chapter strip with page breaks"
    data-find="strip-breaks"
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={() => { dragIndex = null; crop = null; }}
    onpointerleave={() => (hoverY = null)}
  >
    {#each layout.pages as page (page.id)}
      <img
        class="strip-page"
        class:selected={page.id === selectedId}
        src={pageSrc(page)}
        alt={`Page ${pageNumber(page.id)}`}
        loading="lazy"
        draggable="false"
        style={`top:${pct(page.top)};height:${pct(page.height)};width:${(page.width / layout.width) * 100}%;left:${((layout.width - page.width) / 2 / layout.width) * 100}%`}
      />
      <span class="page-label" style={`top:${pct(page.top)}`}>Page {pageNumber(page.id)}</span>
    {/each}

    {#each oversized as slice}
      <div class="oversized" style={`top:${pct(slice.top)};height:${pct(slice.bottom - slice.top)}`} title={`Taller than ${layout.allowedHeight}px; add a break`}></div>
    {/each}
    {#if dragIndex !== null || tool === "add-break"}
      {#each layout.protected as range}
        <div class="protected" style={`top:${pct(range.top)};height:${pct(range.bottom - range.top)}`}></div>
      {/each}
    {/if}

    {#each removed as y}
      <div class="break removed" style={`top:${pct(y)}`}>
        <button type="button" class="restore" disabled={disabled} onpointerdown={(e) => e.stopPropagation()} onclick={() => restore(y)}
          aria-label={`Restore the break at ${y}px`} title="Restore this break"><i class="bi bi-arrow-counterclockwise" aria-hidden="true"></i></button>
      </div>
    {/each}

    {#each breaks as y, i (i)}
      {@const state = stateOf(y)}
      {@const conflict = blockedBy(y)}
      {#if conflict}
        <div class="conflict" style={`top:${pct(conflict.top)};height:${pct(conflict.bottom - conflict.top)}`}></div>
      {/if}
      <div
        class={`break ${state}`}
        class:focused={focusIndex === i}
        style={`top:${pct(y)}`}
        role="slider"
        tabindex="0"
        data-break-index={i}
        aria-label={`${label[state]} at ${y}px`}
        aria-valuemin="1"
        aria-valuemax={layout.height - 1}
        aria-valuenow={y}
        onfocus={() => (focusIndex = i)}
        onkeydown={(e) => key(e, i)}
        onpointerdown={(e) => startDrag(e, i)}
      >
        <span class="grip" aria-hidden="true"><i class="bi bi-grip-horizontal"></i></span>
        <span class="tag">{y}px{state === "forced" ? " · through artwork" : state === "blocked" ? " · crosses a region" : ""}</span>
        <button type="button" class="remove" disabled={disabled} onpointerdown={(e) => e.stopPropagation()} onclick={() => remove(i)}
          aria-label={`Remove the break at ${y}px`} title="Remove this break (Delete)"><i class="bi bi-x-lg" aria-hidden="true"></i></button>
      </div>
    {/each}

    {#each sliceLabels as slice}
      <span class="slice-height" class:over={slice.height > layout.allowedHeight} style={`top:${pct(slice.top + slice.height / 2)}`}>{slice.height.toLocaleString()} px</span>
    {/each}

    {#if hoverY !== null && dragIndex === null}
      <div class="break ghost" style={`top:${pct(hoverY)}`} aria-hidden="true"><span class="tag">+ {hoverY}px</span></div>
    {/if}
    {#if crop}
      <div class="crop-draft" style={`left:${(Math.min(crop.start.x, crop.end.x) / layout.width) * 100}%;top:${pct(Math.min(crop.start.y, crop.end.y))};width:${(Math.abs(crop.start.x - crop.end.x) / layout.width) * 100}%;height:${pct(Math.abs(crop.start.y - crop.end.y))}`}></div>
    {/if}
  </div>
</div>

<style>
  .canvas-scroll {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    scrollbar-gutter: stable;
    display: flex;
    background: var(--hud-canvas);
    padding: 18px 64px 96px;
  }
  .canvas-scroll.zoom-mode { overflow: hidden; }
  .strip {
    position: relative;
    flex: none;
    margin: 0 auto auto;
    background: white;
    box-shadow: 0 6px 30px rgba(0, 0, 0, 0.6);
    line-height: 0;
    user-select: none;
    touch-action: none;
    cursor: default;
  }
  .strip.add-mode { cursor: copy; }
  .strip.crop-mode { cursor: crosshair; }
  .strip.zoom-tool { cursor: zoom-in; }
  .strip.dragging { cursor: row-resize; }
  .strip-page {
    position: absolute;
    display: block;
    object-fit: fill;
    pointer-events: none;
  }
  .strip-page.selected { outline: 2px solid var(--hud-teal-ink, #4fc3a8); outline-offset: -2px; z-index: 1; }
  .page-label {
    position: absolute;
    left: 4px;
    margin-top: 14px;
    padding: 2px 6px;
    border-radius: 4px;
    background: rgba(16, 22, 31, 0.78);
    color: #dfe6ee;
    font: 600 11px/1.2 Inter, system-ui, sans-serif;
    pointer-events: none;
    white-space: nowrap;
    z-index: 2;
  }
  .oversized {
    position: absolute;
    left: 0;
    right: 0;
    background: repeating-linear-gradient(135deg, #ffa53a22 0 10px, transparent 10px 20px);
    box-shadow: inset 3px 0 0 #ffa53a, inset -3px 0 0 #ffa53a;
    pointer-events: none;
  }
  .protected, .conflict {
    position: absolute;
    left: 0;
    right: 0;
    pointer-events: none;
    background: repeating-linear-gradient(45deg, #ff335522 0 6px, transparent 6px 12px);
  }
  .conflict { background: #ff22443a; outline: 2px solid #f24; }
  .break {
    position: absolute;
    left: -10px;
    right: -10px;
    height: 0;
    border-top: 2px solid #8b93a3;
    z-index: 3;
    cursor: row-resize;
    outline: none;
  }
  .break::before {
    /* A generous hit area around the 2px line. */
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    top: -7px;
    height: 14px;
  }
  .break.added { border-top-color: var(--hud-teal-ink, #3fc2a4); }
  .break.forced { border-top-color: #ff9d2e; }
  .break.blocked { border-top: 3px solid #ff3355; }
  .break.removed { border-top: 2px dashed #8b93a399; cursor: default; }
  .break.ghost { border-top: 2px dashed var(--hud-teal-ink, #3fc2a4); pointer-events: none; }
  .break.focused, .break:focus-visible { filter: drop-shadow(0 0 3px #fff) drop-shadow(0 0 2px var(--hud-teal-ink, #3fc2a4)); }
  .grip, .tag, .remove, .restore {
    position: absolute;
    transform: translateY(-50%);
    top: -1px;
    font: 600 11px/1 Inter, system-ui, sans-serif;
  }
  .grip {
    left: -22px;
    width: 22px;
    height: 18px;
    display: grid;
    place-items: center;
    border-radius: 5px 0 0 5px;
    background: #8b93a3;
    color: white;
  }
  .added .grip { background: var(--hud-teal-ink, #3fc2a4); }
  .forced .grip { background: #ff9d2e; }
  .blocked .grip { background: #ff3355; }
  .tag {
    left: 6px;
    padding: 3px 6px;
    border-radius: 4px;
    background: #20232ad9;
    color: white;
    white-space: nowrap;
    pointer-events: none;
  }
  .remove, .restore {
    right: -26px;
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 1px solid var(--hud-line, #555);
    border-radius: 50%;
    background: var(--hud-bg-2, #30343d);
    color: var(--hud-text, #eee);
    cursor: pointer;
  }
  .remove:hover:not(:disabled) { background: #ff3355; color: white; }
  .restore:hover:not(:disabled) { background: var(--hud-teal-dim); color: var(--hud-teal-ink); }
  .remove:disabled, .restore:disabled { opacity: .45; cursor: default; }
  .slice-height {
    position: absolute;
    right: -60px;
    transform: translateY(-50%);
    font: 600 11px/1.2 Inter, system-ui, sans-serif;
    color: var(--hud-muted, #aaa);
    pointer-events: none;
    white-space: nowrap;
    max-width: 56px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .slice-height.over { color: #ff9d2e; }
  .crop-draft {
    position: absolute;
    border: 2px solid #68dac5;
    background: #68dac533;
    pointer-events: none;
    z-index: 4;
  }
</style>
