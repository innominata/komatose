<script lang="ts">
  import { onMount } from "svelte";
  import {
    BRUSH_PRESETS,
    PAGE_BRUSH_MAX,
    PAGE_BRUSH_MIN,
    brushSwatchPx,
    nudgeBrush,
    brushDeltaFromWheel,
  } from "$lib/brush";

  let {
    open = false,
    anchor = null,
    radius = $bindable(8),
    onclose,
  }: {
    open?: boolean;
    anchor?: HTMLElement | null;
    radius?: number;
    onclose?: () => void;
  } = $props();

  let root: HTMLDivElement | undefined;
  let style = $state("");

  function place() {
    if (!open || !anchor || !root) {
      style = "";
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const gap = 8;
    const left = rect.right + gap;
    let top = rect.top;
    const maxTop = window.innerHeight - (root.offsetHeight || 48) - 8;
    top = Math.max(8, Math.min(top, maxTop));
    style = `left:${Math.round(left)}px;top:${Math.round(top)}px`;
  }

  $effect(() => {
    if (!open || !anchor) return;
    const frame = requestAnimationFrame(() => place());
    return () => cancelAnimationFrame(frame);
  });

  onMount(() => {
    const onResize = () => place();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  });

  $effect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || root?.contains(target)) return;
      onclose?.();
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  });

  function onWheel(event: WheelEvent) {
    if (!event.shiftKey) return;
    const step = brushDeltaFromWheel(event);
    if (!step) return;
    event.preventDefault();
    radius = nudgeBrush(radius, step, PAGE_BRUSH_MIN, PAGE_BRUSH_MAX);
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    bind:this={root}
    class="brush-size-toolbar"
    {style}
    role="toolbar"
    aria-label="Brush size"
    onwheel={onWheel}
  >
    <span class="brush-size-label">Size</span>
    {#each BRUSH_PRESETS as size}
      <button
        type="button"
        class="brush-preset"
        title={`Brush ${size}px. Shift-scroll adjusts 1px.`}
        aria-label={`Brush ${size} pixels`}
        aria-pressed={radius === size}
        onclick={() => (radius = size)}
      >
        <span
          class="brush-swatch"
          style={`width:${brushSwatchPx(size)}px;height:${brushSwatchPx(size)}px`}
        ></span>
      </button>
    {/each}
    <span class="brush-size-value" aria-live="polite">{radius}px</span>
  </div>
{/if}

<style>
  .brush-size-toolbar {
    position: fixed;
    z-index: 950;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    background: var(--ed-rail, var(--hud-bg-2));
    border: 1px solid var(--hud-line);
    border-radius: 3px;
    box-shadow: 0 4px 16px #0008;
    user-select: none;
  }
  .brush-size-label {
    color: var(--ed-muted, var(--hud-muted));
    font:
      600 10px "Rajdhani",
      sans-serif;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 0 2px;
  }
  .brush-preset {
    display: grid;
    place-items: center;
    width: 32px;
    height: 30px;
    padding: 0;
    margin: 0;
    border: 1px solid transparent;
    border-radius: 2px;
    background: transparent;
    color: var(--ed-text, var(--hud-text));
    cursor: pointer;
  }
  .brush-preset:hover {
    background: var(--ed-hover, var(--hud-bg-3));
    border-color: var(--hud-teal);
  }
  .brush-preset[aria-pressed="true"] {
    background: var(--ed-active-dim, #1a3a40);
    border-color: var(--ed-active, var(--hud-teal));
    color: var(--ed-active, var(--hud-teal));
  }
  .brush-swatch {
    display: block;
    border-radius: 50%;
    background: currentColor;
    outline: 1px solid currentColor;
  }
  .brush-size-value {
    min-width: 2.5rem;
    text-align: center;
    color: var(--ed-muted, var(--hud-muted));
    font:
      11px/1 "Inter",
      sans-serif;
  }
</style>
