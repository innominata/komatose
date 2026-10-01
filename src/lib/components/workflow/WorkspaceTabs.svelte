<script lang="ts">
  let {
    steps,
    step,
    disabled,
    onswitch,
  }: {
    steps: string[];
    step: string;
    disabled: boolean;
    onswitch: (next: string) => void;
  } = $props();
</script>

<div class="workspace-tabs">
  <span class="workspace-label">Workspace</span>
  <nav class="ed-steps" aria-label="Chapter workflow">
    {#each steps as item}<button
        class="ed-btn"
        class:active={step === item}
        {disabled}
        onclick={() => onswitch(item)}>{item}</button
      >{/each}
  </nav>
</div>

<style>
  .workspace-tabs {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 10px;
    min-height: 32px;
    background: var(--hud-bg);
    border-bottom: 1px solid var(--line, var(--ed-line, var(--hud-line)));
    flex-shrink: 0;
  }
  .workspace-label {
    color: var(--ed-muted);
    font-size: 11px;
  }
  .workspace-tabs .ed-btn {
    border: 0;
    border-radius: 0;
    background: transparent;
    min-height: 31px;
    padding: 5px 12px;
    border-bottom: 2px solid transparent;
  }
  .workspace-tabs .ed-btn.active {
    background: var(--hud-teal-dim);
    color: var(--hud-teal);
    border-bottom-color: var(--accent, var(--ed-active, var(--hud-teal)));
  }
  .ed-steps {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
    overflow: auto;
  }
  @media (max-width: 760px) {
    .workspace-label {
      display: none;
    }
    .workspace-tabs {
      gap: 4px;
      padding: 0 6px;
    }
    .workspace-tabs .ed-btn {
      padding: 5px 8px;
    }
  }
</style>
