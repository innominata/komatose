<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  export type PaletteId =
    | "select"
    | "region"
    | "read-area"
    | "reorder"
    | "style-brush"
    | "assign-character"
    | "brush"
    | "erase"
    | "bubble-fill"
    | "clone-stamp"
    | "blur"
    | "restore"
    | "raw"
    | "mask-grow"
    | "polygon"
    | "rectangle"
    | "oval"
    | "crop"
    | "split"
    | "reslice"
    | "zoom";

  export type PaletteAction = {
    id: string;
    icon: string;
    title: string;
    active?: boolean;
    disabled?: boolean;
  };

  type ToolDef = { id: PaletteId; icon: string; title: string; key?: string };

  const ALL: Record<PaletteId, ToolDef> = {
    'assign-character': { id: 'assign-character', icon: 'bi-person-badge', title: 'Assign character' },
    select: { id: "select", icon: "bi-cursor", title: "Select (V)", key: "V" },
    region: {
      id: "region",
      icon: "bi-bounding-box",
      title: "Draw region (R)",
      key: "R",
    },
    "read-area": {
      id: "read-area",
      icon: "bi-eye",
      title: "Read area with image model",
    },
    reorder: {
      id: "reorder",
      icon: "bi-arrow-down-up",
      title: "Reorder reading flow (O)",
      key: "O",
    },
    brush: { id: "brush", icon: "bi-brush", title: "Mask brush (B)", key: "B" },
    "style-brush": {
      id: "style-brush",
      icon: "bi-brush-fill",
      title: "Style brush",
    },
    erase: {
      id: "erase",
      icon: "bi-eraser",
      title: "Erase mask (E)",
      key: "E",
    },
    "bubble-fill": {
      id: "bubble-fill",
      icon: "bi-paint-bucket",
      title: "Fill speech bubble (F)",
      key: "F",
    },
    "clone-stamp": {
      id: "clone-stamp",
      icon: "bi-copy",
      title: "Clone stamp (C)",
      key: "C",
    },
    blur: { id: "blur", icon: "bi-droplet-half", title: "Blur (L)", key: "L" },
    restore: {
      id: "restore",
      icon: "bi-clock-history",
      title: "Restore (H)",
      key: "H",
    },
    raw: {
      id: "raw",
      icon: "bi-image",
      title: "Paint raw (S)",
      key: "S",
    },
    "mask-grow": {
      id: "mask-grow",
      icon: "bi-arrows-angle-expand",
      title: "Grow mask (G)",
      key: "G",
    },
    polygon: { id: "polygon", icon: "bi-pentagon", title: "Draw polygon" },
    rectangle: { id: "rectangle", icon: "bi-square", title: "Draw rectangle" },
    oval: { id: "oval", icon: "bi-circle", title: "Draw oval" },
    crop: { id: "crop", icon: "bi-crop", title: "Crop" },
    split: { id: "split", icon: "bi-vr", title: "Split page" },
    reslice: { id: "reslice", icon: "bi-hr", title: "Reslice strips" },
    zoom: { id: "zoom", icon: "bi-zoom-in", title: "Zoom (Z)", key: "Z" },
  };

  let {
    step,
    tool,
    canEdit = true,
    canClean = true,
    canUpload = true,
    showPolygon = false,
    canCopyStyle = false,
    docked = $bindable(true),
    dockRef = $bindable(null as HTMLDivElement | null),
    actions = [],
    commands,
    polygonCount = 0,
    onselect,
    onaction,
    onCompletePolygon,
  }: {
    step: string;
    tool: string;
    canEdit?: boolean;
    canClean?: boolean;
    canUpload?: boolean;
    showPolygon?: boolean;
    canCopyStyle?: boolean;
    docked?: boolean;
    dockRef?: HTMLDivElement | null;
    actions?: PaletteAction[];
    commands?: Snippet;
    polygonCount?: number;
    onselect: (id: PaletteId) => void;
    onaction?: (id: string) => void;
    onCompletePolygon?: () => void;
  } = $props();
  let x = $state(80);
  let y = $state(80);
  let dragging = $state(false);
  let paletteEl: HTMLDivElement;
  let dragOffset = { x: 0, y: 0 };

  $effect(() => {
    dockRef = paletteEl ?? null;
  });

  const tools = $derived.by((): ToolDef[] => {
    const zoom = ALL.zoom;
    if (step === "Prepare")
      return [
        ...[ALL.select, ALL.crop, ALL.split, ALL.reslice].filter(
          (t) => t.id === "select" || canUpload,
        ),
        zoom,
      ];
    if (step === "Translate" || step === "Review")
      return canEdit
        ? [ALL.select, ALL.region, ALL.reorder, ...(step === 'Review' ? [ALL['assign-character']] : []), ALL["read-area"], zoom]
        : [ALL.select, zoom];
    if (step === "Clean")
      return canClean
        ? [
            ALL.select,
            ALL.brush,
            ALL.erase,
            ALL["bubble-fill"],
            ALL["clone-stamp"],
            ALL.blur,
            ALL.restore,
            ALL.raw,
            ALL["mask-grow"],
            zoom,
          ]
        : [ALL.select, zoom];
    if (step === "Typeset")
      return canClean
        ? [
            ALL.select,
            ALL["style-brush"],
            ALL.brush,
            ALL.erase,
            ...(showPolygon ? [ALL.polygon, ALL.rectangle, ALL.oval] : []),
            zoom,
          ]
        : [ALL.select, zoom];
    if (step === "Export") return [zoom];
    return [zoom];
  });

  function persist() {
    try {
      localStorage.setItem("scan.palette", JSON.stringify({ docked, x, y }));
    } catch {
      /* ignore */
    }
  }

  onMount(() => {
    try {
      const raw = localStorage.getItem("scan.palette");
      const saved = JSON.parse(raw || "{}") as {
        docked?: boolean;
        x?: number;
        y?: number;
      };
      if (typeof saved.docked === "boolean") docked = saved.docked;
      if (Number.isFinite(saved.x)) x = saved.x as number;
      if (Number.isFinite(saved.y)) y = saved.y as number;
    } catch {
      /* ignore */
    }
    if (window.matchMedia("(max-width: 760px)").matches) docked = false;
    clamp();
    window.addEventListener("resize", clamp);
    const observer = new ResizeObserver(() => {
      if (!docked) clamp();
    });
    if (paletteEl) observer.observe(paletteEl);
    return () => {
      window.removeEventListener("resize", clamp);
      observer.disconnect();
    };
  });

  function clamp() {
    x = Math.max(
      8,
      Math.min(x, window.innerWidth - (paletteEl?.offsetWidth ?? 80) - 8),
    );
    y = Math.max(
      8,
      Math.min(
        y,
        window.innerHeight -
          Math.min(paletteEl?.offsetHeight ?? 80, window.innerHeight - 16) -
          8,
      ),
    );
  }

  function onHandleDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = paletteEl.getBoundingClientRect();
    const left = rect.left;
    const top = rect.top;
    dragging = true;
    docked = false;
    dragOffset = { x: e.clientX - left, y: e.clientY - top };
    x = left;
    y = top;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (!dragging) return;
      x = ev.clientX - dragOffset.x;
      y = ev.clientY - dragOffset.y;
      clamp();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!dragging) return;
      dragging = false;
      persist();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function snap() {
    docked = true;
    persist();
  }

  const visible = $derived(tools.length > 0);
  const style = $derived(docked ? "" : `left:${x}px;top:${y}px`);
</script>

{#if visible}
  <div
    bind:this={paletteEl}
    class="palette"
    class:docked
    class:dragging
    {style}
    role="toolbar"
    aria-label="Tools"
  >
    <button
      class="handle"
      type="button"
      title="Drag to float Tools · double-click to pin as a panel"
      aria-label="Move Tools palette"
      ondblclick={snap}
      onpointerdown={onHandleDown}
    >
      <i class="bi bi-grip-horizontal" aria-hidden="true"></i><span>Tools</span>
    </button>
    <div class="tool-grid" role="group" aria-label="Canvas tools">
      {#each tools as item}
        {#if item.id === "polygon" && tool === "polygon"}
          <button
            class="ed-rail-btn active"
            type="button"
            title="Save polygon"
            aria-label="Save polygon"
            disabled={!canClean || polygonCount < 3}
            onclick={() => onCompletePolygon?.()}
          >
            <i class="bi bi-check2"></i>
          </button>
        {:else}
        <button
          class="ed-rail-btn"
          class:active={tool === item.id}
          type="button"
          title={item.id === "style-brush"
            ? tool === item.id
              ? "Click regions to apply the copied style. Click again or press Esc to stop."
              : "Style brush · copy the selected region’s fitted text style"
            : item.id === "bubble-fill"
              ? "Fill speech bubble (F) · click the empty interior"
            : item.id === "clone-stamp"
              ? "Clone stamp (C) · right-click source, then click and drag to paint"
            : item.id === "blur"
              ? "Blur (L) · paint to blend inpainted patches into a gradient"
            : item.id === "restore"
              ? "Restore (H) · paint previous-save pixels back with a soft edge"
            : item.id === "raw"
              ? "Paint raw (S) · paint uncleaned source pixels onto the working page"
            : item.id === "mask-grow"
              ? "Grow mask (G) · click a mask region to expand it by the set amount"
            : item.title}
          aria-label={item.title}
          aria-pressed={tool === item.id}
          disabled={(["polygon", "rectangle", "oval"].includes(item.id) && !canClean) ||
            (item.id === "style-brush" && tool !== item.id && !canCopyStyle)}
          onclick={() => onselect(item.id)}
        >
          <i class="bi {item.icon}"></i>
        </button>
        {/if}
      {/each}
    </div>
    {#if actions.length}
      <div class="tool-grid action-grid" role="group" aria-label="Page actions">
        {#each actions as item}
          <button
            class="ed-rail-btn"
            class:active={item.active}
            type="button"
            title={item.title}
            aria-label={item.title}
            aria-pressed={item.active}
            disabled={item.disabled}
            onclick={() => onaction?.(item.id)}
          >
            <i class="bi {item.icon}"></i>
          </button>
        {/each}
      </div>
    {/if}
    {@render commands?.()}
    {#if !docked}
      <button
        class="ed-rail-btn"
        type="button"
        title="Pin as a panel between pages and the image"
        aria-label="Pin as a panel"
        onclick={snap}
      >
        <i class="bi bi-pin-angle" aria-hidden="true"></i>
      </button>
    {/if}
  </div>
{/if}

<style>
  .palette {
    box-sizing: border-box;
    z-index: 900;
    width: 78px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    padding: 0 4px 4px;
    background: var(--ed-rail, var(--hud-bg-2));
    border: 1px solid var(--hud-line);
    scrollbar-width: thin;
    user-select: none;
  }
  .palette:not(.docked) {
    position: fixed;
    max-height: calc(100dvh - 64px);
    border-radius: 3px;
    box-shadow: 0 4px 16px #0008;
  }
  .palette.docked {
    position: relative;
    z-index: 2;
    flex: 1 1 auto;
    height: 100%;
    max-height: none;
    border-radius: 0;
    border-top: 0;
    border-bottom: 0;
    box-shadow: none;
  }
  .palette.dragging {
    opacity: 0.92;
  }
  .handle {
    flex-shrink: 0;
    width: 100%;
    height: 22px;
    border: 0;
    border-bottom: 1px solid var(--ed-line);
    background: transparent;
    color: var(--ed-text);
    cursor: grab;
    touch-action: none;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    font:
      10px "Inter",
      sans-serif;
  }
  .handle:active {
    cursor: grabbing;
  }
  .tool-grid,
  .palette :global(.palette-command-group) {
    display: grid;
    grid-template-columns: repeat(2, 32px);
    gap: 2px;
    padding: 4px 0;
  }
  @media (max-width: 760px) {
    .palette {
      width: 48px;
    }
    .tool-grid,
    .palette :global(.palette-command-group) {
      grid-template-columns: 32px;
    }
    .handle span {
      display: none;
    }
  }
  .action-grid,
  .palette :global(.palette-command-group) {
    border-top: 1px solid var(--ed-line);
  }
  .palette :global(.palette-group-name) {
    grid-column: 1 / -1;
    color: var(--ed-muted);
    font:
      600 10px "Manrope",
      sans-serif;
    text-align: center;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding-bottom: 2px;
  }
  .palette .ed-rail-btn,
  .palette :global(.palette-command) {
    display: grid;
    place-items: center;
    width: 32px;
    height: 30px;
    padding: 0;
    margin: 0;
    border: 1px solid transparent;
    border-radius: 2px;
    background: transparent;
    color: var(--ed-text);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
  }
  .palette .ed-rail-btn:hover:not(:disabled),
  .palette :global(.palette-command:hover:not(:disabled)) {
    background: var(--ed-hover);
    border-color: var(--hud-teal-ink);
  }
  .palette .ed-rail-btn.active,
  .palette :global(.palette-command[aria-pressed="true"]) {
    background: var(--ed-active-dim);
    border-color: var(--ed-active);
    color: var(--ed-active);
  }
  .palette button:focus-visible,
  .palette :global(.palette-command:focus-visible) {
    outline: 2px solid var(--ed-active);
    outline-offset: -2px;
  }
  .palette button:disabled,
  .palette :global(.palette-command:disabled) {
    opacity: 0.35;
    cursor: default;
  }
</style>
