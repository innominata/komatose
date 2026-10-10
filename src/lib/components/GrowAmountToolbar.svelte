<script lang="ts">
  import { onMount } from "svelte";
  import {
    MASK_GROW_DEFAULT,
    MASK_GROW_MAX,
    MASK_GROW_MIN,
  } from "$lib/workflow";

  let {
    open = false,
    anchor = null,
    amount = $bindable(MASK_GROW_DEFAULT),
    onclose,
  }: {
    open?: boolean;
    anchor?: HTMLElement | null;
    amount?: number;
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

  function onAmountInput(event: Event) {
    const raw = (event.currentTarget as HTMLInputElement).value.trim();
    if (!raw) return;
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    amount = Math.min(MASK_GROW_MAX, Math.max(MASK_GROW_MIN, Math.round(value)));
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    bind:this={root}
    class="grow-amount-toolbar"
    {style}
    role="toolbar"
    aria-label="Grow mask"
  >
    <span class="grow-amount-label">Grow</span>
    <input
      class="grow-amount-input"
      type="number"
      min={MASK_GROW_MIN}
      max={MASK_GROW_MAX}
      step="1"
      value={amount}
      oninput={onAmountInput}
      onblur={(e) => (e.currentTarget.value = String(amount))}
      aria-label="Grow mask by (px)"
      title="Pixels to expand the clicked mask section"
    />
    <span class="grow-amount-unit">px</span>
  </div>
{/if}

<style>
  .grow-amount-toolbar {
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
  .grow-amount-label {
    color: var(--ed-muted, var(--hud-muted));
    font:
      600 10px "Manrope",
      sans-serif;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 0 2px;
  }
  .grow-amount-input {
    box-sizing: border-box;
    width: 52px;
    height: 30px;
    margin: 0;
    padding: 0 4px;
    border: 1px solid var(--ed-line, var(--hud-line));
    border-radius: 2px;
    background: transparent;
    color: var(--ed-text, var(--hud-text));
    font:
      12px/1 "Inter",
      sans-serif;
    text-align: center;
  }
  .grow-amount-input:focus-visible {
    outline: 2px solid var(--ed-active, var(--hud-teal));
    outline-offset: -1px;
  }
  .grow-amount-unit {
    color: var(--ed-muted, var(--hud-muted));
    font:
      11px/1 "Inter",
      sans-serif;
  }
</style>
