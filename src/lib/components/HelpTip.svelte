<script lang="ts">
  import type { Snippet } from "svelte";

  let { label = "Help", children }: { label?: string; children: Snippet } = $props();
</script>

<!-- Hover or focus shows the help; it stays out of the layout until then. -->
<span class="help-tip">
  <button type="button" class="help-mark" aria-label={label}>?</button>
  <span class="help-body" role="tooltip">{@render children()}</span>
</span>

<style>
  .help-tip {
    position: relative;
    display: inline-flex;
  }
  .help-mark {
    width: 20px;
    height: 20px;
    padding: 0;
    border-radius: 50%;
    font-size: 0.75rem;
    line-height: 1;
    display: grid;
    place-items: center;
  }
  .help-body {
    display: none;
    position: absolute;
    z-index: 20;
    top: calc(100% + 6px);
    left: 0;
    width: min(340px, 80vw);
    padding: 0.6rem 0.7rem;
    background: var(--hud-panel);
    color: var(--hud-text);
    border: 1px solid var(--hud-teal-ink);
    border-radius: 2px;
    font-size: 0.8rem;
    line-height: 1.45;
    white-space: normal;
    box-shadow: 0 6px 18px #0008;
  }
  .help-tip:hover .help-body,
  .help-tip:focus-within .help-body {
    display: block;
  }
</style>
