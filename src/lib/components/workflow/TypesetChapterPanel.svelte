<script lang="ts">
  import "./studio-controls.css";

  let {
    canClean,
    busy,
    fitting,
    staleCount = 0,
    ontypesettings,
    onaimodels,
    onreset,
    onfit,
    onkeeplayouts,
  }: {
    canClean: boolean;
    busy: boolean;
    fitting: boolean;
    staleCount?: number;
    ontypesettings: () => void;
    onaimodels?: () => void;
    onreset: () => void;
    onfit: () => void;
    onkeeplayouts?: () => void;
  } = $props();
</script>

<div class="wf-ui">
  <h1>Typeset the chapter</h1>
  <div class="control-row">
    <button type="button" onclick={ontypesettings}>Type settings…</button>
    {#if onaimodels}
      <button type="button" onclick={onaimodels}>AI model settings…</button>
    {/if}
    <button
      type="button"
      disabled={!canClean || busy || fitting}
      onclick={onreset}>Reset all text to series defaults</button
    >
    <button type="button" disabled={!canClean || busy || fitting} onclick={onfit}
      >Auto-fit all text</button
    >{#if onkeeplayouts}<button
        type="button"
        disabled={!canClean || busy || fitting || staleCount < 1}
        onclick={onkeeplayouts}>Keep current layouts</button
      >{/if}
  </div>
</div>
