<script lang="ts">
  import type { PlacedAsset } from "$lib/cleanAssets";
  let {
    width,
    height,
    placements,
    selectedId,
    editable = false,
    asset,
    onselect,
    onchange,
  }: {
    width: number;
    height: number;
    placements: PlacedAsset[];
    selectedId: string;
    editable?: boolean;
    asset: (hash: string) => string;
    onselect: (id: string) => void;
    onchange: (items: PlacedAsset[]) => void;
  } = $props();
  let svg: SVGSVGElement;
  let live = $state<PlacedAsset[] | null>(null);
  let drag: {
    kind: string;
    start: { x: number; y: number };
    graphic: PlacedAsset;
    sx: number;
    sy: number;
  } | null = null;
  const shown = $derived(live ?? placements);
  function point(e: PointerEvent) {
    const r = svg.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * width,
      y: ((e.clientY - r.top) / r.height) * height,
    };
  }
  function start(
    e: PointerEvent,
    g: PlacedAsset,
    kind = "move",
    sx = 1,
    sy = 1,
  ) {
    if (!editable || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onselect(g.id);
    live = placements.map((p) => ({ ...p }));
    drag = { kind, start: point(e), graphic: { ...g }, sx, sy };
    svg.setPointerCapture(e.pointerId);
    svg.focus();
  }
  function move(e: PointerEvent) {
    if (!drag || !live) return;
    const p = point(e),
      g = drag.graphic;
    let next = { ...g };
    if (drag.kind === "move") {
      next.x += p.x - drag.start.x;
      next.y += p.y - drag.start.y;
    } else if (drag.kind === "rotate") {
      const angle =
        Math.atan2(p.y - g.y, p.x - g.x) -
        Math.atan2(drag.start.y - g.y, drag.start.x - g.x);
      next.rotation = g.rotation + (angle * 180) / Math.PI;
      if (e.shiftKey) next.rotation = Math.round(next.rotation / 15) * 15;
    } else {
      const r = (g.rotation * Math.PI) / 180,
        c = Math.cos(r),
        s = Math.sin(r),
        dx = p.x - g.x,
        dy = p.y - g.y,
        lx = dx * c + dy * s,
        ly = -dx * s + dy * c;
      const ax = (-drag.sx * g.width) / 2,
        ay = (-drag.sy * g.height) / 2;
      let w = Math.max(1, drag.sx * (lx - ax)),
        h = Math.max(1, drag.sy * (ly - ay));
      if (!e.shiftKey) {
        const scale = Math.max(w / g.width, h / g.height);
        w = g.width * scale;
        h = g.height * scale;
      }
      w = Math.min(30000, w);
      h = Math.min(30000, h);
      const cx = ax + (drag.sx * w) / 2,
        cy = ay + (drag.sy * h) / 2;
      next = {
        ...g,
        width: w,
        height: h,
        x: g.x + cx * c - cy * s,
        y: g.y + cx * s + cy * c,
      };
    }
    live = live.map((item) => (item.id === g.id ? next : item));
  }
  function finish() {
    if (drag && live) {
      const result = live;
      drag = null;
      live = null;
      onchange(result);
    }
  }
  function key(e: KeyboardEvent) {
    if (!editable) return;
    const g = placements.find((p) => p.id === selectedId);
    if (!g) return;
    if (e.key === "Escape") {
      drag = null;
      live = null;
      onselect("");
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      e.stopPropagation();
      onchange(placements.filter((p) => p.id !== g.id));
    }
    const amount = e.shiftKey ? 10 : 1;
    const delta: Record<string, [number, number]> = {
      ArrowUp: [0, -amount],
      ArrowDown: [0, amount],
      ArrowLeft: [-amount, 0],
      ArrowRight: [amount, 0],
    };
    if (delta[e.key]) {
      e.preventDefault();
      e.stopPropagation();
      const [x, y] = delta[e.key];
      onchange(
        placements.map((p) =>
          p.id === g.id ? { ...p, x: p.x + x, y: p.y + y } : p,
        ),
      );
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions (This canvas is a keyboard-operated application surface for moving and deleting graphics.) -->
<svg
  bind:this={svg}
  class="placed-assets"
  style:z-index={editable ? 4 : 0}
  viewBox={`0 0 ${width} ${height}`}
  aria-label="Page graphics"
  role="application"
  tabindex={editable ? 0 : -1}
  onpointermove={move}
  onpointerup={finish}
  onpointercancel={() => {
    drag = null;
    live = null;
  }}
  onkeydown={key}
>
  {#each shown as g (g.id)}<g
      transform={`translate(${g.x} ${g.y}) rotate(${g.rotation})`}
    >
      <image
        href={asset(g.hash)}
        x={-g.width / 2}
        y={-g.height / 2}
        width={g.width}
        height={g.height}
        opacity={g.opacity}
        preserveAspectRatio="none"
        class:editable
        style:pointer-events={editable ? "all" : "none"}
        aria-label={`Move ${g.name}`}
        role="img"
        onpointerdown={(e) => start(e, g)}
      />
      {#if editable && selectedId === g.id}<rect
          x={-g.width / 2}
          y={-g.height / 2}
          width={g.width}
          height={g.height}
          fill="none"
          stroke="#06a78c"
          stroke-width="2"
          vector-effect="non-scaling-stroke"
        />
        <line
          x1="0"
          y1={-g.height / 2}
          x2="0"
          y2={-g.height / 2 - 30}
          stroke="#06a78c"
          stroke-width="2"
          vector-effect="non-scaling-stroke"
        />
        <circle
          cx="0"
          cy={-g.height / 2 - 30}
          r="9"
          fill="white"
          stroke="#06a78c"
          stroke-width="2"
          class="handle rotate"
          role="img"
          aria-label={`Rotate ${g.name}`}
          onpointerdown={(e) => start(e, g, "rotate")}
        />
        {#each [[-1, -1], [1, -1], [-1, 1], [1, 1]] as [sx, sy]}<rect
            x={(sx * g.width) / 2 - 7}
            y={(sy * g.height) / 2 - 7}
            width="14"
            height="14"
            fill="white"
            stroke="#06a78c"
            stroke-width="2"
            class="handle"
            role="img"
            aria-label={`Resize ${g.name}`}
            onpointerdown={(e) => start(e, g, "resize", sx, sy)}
          />{/each}
      {/if}
    </g>{/each}
</svg>

<style>
  .placed-assets {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
    pointer-events: none;
    outline: none;
  }
  .editable {
    cursor: move;
    touch-action: none;
  }
  .handle {
    pointer-events: all;
    cursor: nwse-resize;
    touch-action: none;
  }
  .rotate {
    cursor: grab;
  }
</style>
