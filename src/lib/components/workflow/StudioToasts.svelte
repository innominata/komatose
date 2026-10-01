<script lang="ts">
  let {
    error,
    toasts,
    ondismisserror,
    ondismiss,
  }: {
    error: string;
    toasts: { id: number; text: string }[];
    ondismisserror: () => void;
    ondismiss: (id: number) => void;
  } = $props();
</script>

{#if error || toasts.length}
  <div class="toasts" aria-live="polite">
    {#if error}
      <div class="toast err" role="alert">
        <pre class="notice-body">{error}</pre>
        <button type="button" onclick={ondismisserror} aria-label="Dismiss error"
          >×</button
        >
      </div>
    {/if}
    {#each toasts as t (t.id)}
      <div class="toast" role="status">
        <p>{t.text}</p>
        <button type="button" onclick={() => ondismiss(t.id)} aria-label="Dismiss"
          >×</button
        >
      </div>
    {/each}
  </div>
{/if}

<style>
  .toasts {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 1200;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: min(360px, calc(100vw - 24px));
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    background: var(--hud-bg-2);
    border: 1px solid var(--ed-line, var(--hud-line));
    border-left: 3px solid var(--ed-active, #2de2c5);
    box-shadow: 0 10px 28px #0008;
    color: var(--ed-text, var(--hud-text));
    font-size: 12px;
    line-height: 1.4;
  }
  .toast.err {
    border-left-color: var(--ed-danger, #ff5d73);
  }
  .toast p {
    margin: 0;
    flex: 1;
    min-width: 0;
  }
  .toast button {
    flex-shrink: 0;
    padding: 0 4px;
    border: 0;
    background: transparent;
  }
  .notice-body {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font:
      12px/1.45 ui-monospace,
      monospace;
    flex: 1;
    min-width: 0;
  }
</style>
