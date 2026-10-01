<script lang="ts">
  import type { ImageRow } from "$lib/types";
  import type { PageData, WorkflowDoc } from "$lib/workflow";
  import WorkCredit from "../WorkCredit.svelte";

  let {
    open,
    width,
    images,
    pages = {},
    assetBase = "",
    issues,
    pageId,
    seriesTitle = "",
    filter = "all",
    mark = () => "todo" as "done" | "check" | "todo" | "running",
    onfilter,
    onpage,
    oncontextmenu,
    onhide,
    onshow,
    onresize,
  }: {
    open: boolean;
    width: number;
    images: ImageRow[];
    pages?: Record<string, WorkflowDoc<PageData>>;
    assetBase?: string;
    issues: { imageId?: string }[];
    pageId: string;
    seriesTitle?: string;
    filter?: "all" | "todo" | "done";
    mark?: (imageId: string) => "done" | "check" | "todo" | "running";
    onfilter?: (next: "all" | "todo" | "done") => void;
    onpage: (id: string) => void;
    oncontextmenu: (event: MouseEvent, imageId: string) => void;
    onhide: () => void;
    onshow: () => void;
    onresize: (event: PointerEvent) => void;
  } = $props();

  const shown = $derived(
    images.filter((img) => {
      const state = mark(img.id);
      if (filter === "done") return state === "done";
      if (filter === "todo") return state !== "done";
      return true;
    }),
  );

  function thumbSrc(img: ImageRow) {
    const doc = pages[img.id]?.data;
    if (doc?.thumbnail && doc.thumbnailAt === img.updatedAt && assetBase)
      return `${assetBase}/workflow/assets/${doc.thumbnail}`;
    return `/api/images/${img.id}?v=${img.updatedAt}`;
  }
</script>

{#if open}
  <aside class="pages" aria-label="Pages in chapter order" style={`width:${width}px`}>
    <div class="pane-title">
      {images.length} pages
      <button class="ed-btn" type="button" title="Hide pages" onclick={onhide}>‹</button>
    </div>
    <div class="strip-filter" data-find="strip-filter" role="group" aria-label="Filter pages">
      {#each [["all", "All"], ["todo", "To do"], ["done", "Done"]] as [id, label] (id)}
        <button type="button" class:on={filter === id} onclick={() => onfilter?.(id as "all" | "todo" | "done")}>{label}</button>
      {/each}
    </div>
    <div class="strip-legend"><i class="mark done"></i>done <i class="mark check"></i>check <i class="mark todo"></i>to do</div>
    {#each shown as img (img.id)}
      {@const index = images.indexOf(img)}
      {@const state = mark(img.id)}
      <button
        class:selected={img.id === pageId}
        aria-label={`Open page ${index + 1}${img.role === "pre-credits" ? ", pre-credits" : img.role === "post-credits" ? ", post-credits" : ""}`}
        data-find={img.id === pageId ? "thumb-current" : undefined}
        oncontextmenu={(e) => oncontextmenu(e, img.id)}
        onclick={() => onpage(img.id)}
        ><img
          src={thumbSrc(img)}
          alt=""
          loading="lazy"
        /><span class="pn">{img.pageNumber ?? "—"}</span><i class="mark {state}" title={state}></i
        >{#if issues.some((it) => it.imageId === img.id)}<i class="review-dot" title="Needs review">●</i
          >{/if}</button
      >{/each}
    {#if seriesTitle}<WorkCredit title={seriesTitle} />{/if}
  </aside>
  <div
    class="splitter"
    role="separator"
    tabindex="0"
    aria-orientation="vertical"
    aria-label="Resize pages"
    onpointerdown={onresize}
    ondblclick={onhide}
  ></div>
{:else}
  <button class="edge-tab left" type="button" onclick={onshow}>Pages</button>
{/if}

<style>
  .pages {
    flex: 0 0 auto;
    border-right: 1px solid var(--line, var(--ed-line, var(--hud-line)));
    padding: 6px;
    min-height: 0;
    overflow: auto;
    background: var(--ed-panel, var(--hud-bg-2));
  }
  .pane-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11px;
    color: var(--ed-muted, var(--hud-muted));
    margin: 4px 2px 8px;
  }
  .strip-filter {
    display: flex;
    margin-bottom: 6px;
    border: 1px solid var(--hud-line);
    border-radius: 5px;
    overflow: hidden;
  }
  .strip-filter button {
    width: auto;
    flex: 1;
    margin: 0;
    padding: 3px 0;
    font: 500 11.5px Inter, system-ui, sans-serif;
    letter-spacing: 0;
    text-transform: none;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--hud-muted);
  }
  .strip-filter button + button { border-left: 1px solid var(--hud-line); }
  .strip-filter button.on { background: var(--hud-teal-dim); color: var(--hud-teal); }
  .strip-legend { font-size: 10px; color: var(--hud-muted); margin: 0 0 6px; }
  .mark {
    display: inline-block;
    width: 7px;
    height: 7px;
    margin-left: 4px;
    border-radius: 50%;
    vertical-align: middle;
  }
  .mark.done { background: #3dd68c; }
  .mark.check { background: #e8b15a; }
  .mark.todo { background: transparent; box-shadow: inset 0 0 0 1px var(--hud-muted); }
  .mark.running { background: var(--hud-teal); }
  .pages button {
    position: relative;
    display: block;
    width: 100%;
    text-align: left;
    margin: 0 0 6px;
    padding: 4px;
    background: var(--hud-bg);
    border: 1px solid var(--line, var(--ed-line, var(--hud-line)));
    border-radius: 2px;
    color: var(--ink, var(--ed-text, var(--hud-text)));
    cursor: pointer;
  }
  .pages button.selected {
    border-color: var(--accent, var(--ed-active, var(--hud-teal)));
  }
  .pane-title button {
    width: auto;
    margin: 0;
  }
  .pages button.batch-selected {
    border-color: var(--accent, var(--ed-active, var(--hud-teal)));
    background: var(--hud-teal-dim);
    box-shadow: inset 0 0 0 1px var(--accent, var(--ed-active, var(--hud-teal)));
  }
  .page-checkbox {
    position: relative;
    display: block;
    height: 0;
    margin: 0;
  }
  .page-checkbox input {
    position: absolute;
    z-index: 1;
    top: 7px;
    left: 7px;
    width: 18px;
    height: 18px;
    margin: 0;
    accent-color: var(--ed-active, var(--hud-teal));
    cursor: pointer;
  }
  .selection-controls {
    margin-bottom: 8px;
  }
  .selection-controls small {
    display: block;
    font-size: 10px;
    color: var(--ed-muted, var(--hud-muted));
  }
  .pages img {
    display: block;
    width: 100%;
    aspect-ratio: 1414 / 2000;
    height: auto;
    object-fit: cover;
    border-radius: 2px;
    background: var(--hud-canvas);
  }
  .pages button:not(.chapter-tile) > .pn {
    position: absolute;
    left: 5px;
    bottom: 5px;
    display: block;
    width: auto;
    margin: 0;
    padding: 0 5px;
    border-radius: 3px;
    background: rgba(0, 0, 0, 0.75);
    font-size: 11px;
    font-weight: 600;
  }
  .pages button > .mark {
    position: absolute;
    right: 5px;
    top: 5px;
    width: 10px;
    height: 10px;
    margin: 0;
  }
  .pages .review-dot {
    position: absolute;
    right: 6px;
    top: 6px;
    color: #eeba7c;
  }
  .splitter {
    flex: 0 0 5px;
    cursor: col-resize;
    background: var(--ed-line, var(--hud-line));
  }
  .splitter:hover,
  .splitter:active {
    background: var(--accent, var(--ed-active, var(--hud-teal)));
  }
  .edge-tab {
    position: absolute;
    top: 40%;
    z-index: 5;
    writing-mode: vertical-rl;
    padding: 10px 4px;
    border: 1px solid var(--line, var(--ed-line, var(--hud-line)));
    background: var(--ed-panel, var(--hud-bg-2));
    color: var(--ed-muted, var(--hud-muted));
    font-size: 11px;
  }
  .edge-tab.left {
    left: 0;
    border-radius: 0 4px 4px 0;
  }
  .pages button.chapter-tile {
    display: block;
    min-height: 80px;
    padding: 4px;
    overflow: hidden;
    text-align: center;
  }
  .pages button.chapter-tile .chapter-icon {
    display: grid;
    place-items: center;
    width: 100%;
    height: 72px;
    margin: 0;
    padding: 0;
    font-size: 1.75rem;
    line-height: 1;
    color: var(--ed-muted, var(--hud-muted));
    background: var(--hud-canvas);
  }
  .pages button.chapter-tile .chapter-icon::before {
    display: block;
    line-height: 1;
    vertical-align: 0;
  }
  .pages button.chapter-tile.selected .chapter-icon {
    color: var(--accent, var(--ed-active, var(--hud-teal)));
  }
  @media (max-width: 760px) {
    .pages img,
    .pages button.chapter-tile .chapter-icon {
      height: 56px;
    }
    .pages button.chapter-tile {
      min-height: 64px;
    }
  }
</style>
