<script lang="ts">
  import type { DirectorFinding } from "$lib/director";

  type Warning = DirectorFinding & { key: string };
  let {
    apiBase,
    pageId,
    canEdit,
    refreshKey,
    onregion,
  }: {
    apiBase: string;
    pageId: string | null;
    canEdit: boolean;
    /** Changes when Director starts or stops, so finished runs show their warnings. */
    refreshKey: unknown;
    onregion?: (lineId: string) => void;
  } = $props();

  let warnings = $state<Warning[]>([]);
  let open = $state(false);
  let error = $state("");
  let dismissing = $state("");

  async function load(id: string) {
    try {
      const response = await fetch(`${apiBase}/director?warnings=${encodeURIComponent(id)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load Director warnings");
      if (id === pageId) { warnings = data.warnings; error = ""; }
    } catch (e) {
      if (id === pageId) error = e instanceof Error ? e.message : String(e);
    }
  }
  $effect(() => {
    void refreshKey;
    const id = pageId;
    warnings = [];
    if (!id) { open = false; return; }
    void load(id);
  });
  $effect(() => { if (!warnings.length && !error) open = false; });

  async function dismiss(warning: Warning) {
    if (!pageId) return;
    dismissing = warning.key;
    try {
      const response = await fetch(`${apiBase}/director`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "dismiss-warning", imageId: pageId, key: warning.key }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not dismiss warning");
      warnings = data.warnings;
      error = "";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      dismissing = "";
    }
  }
</script>

{#if warnings.length || error}
  <div class="dw">
    <button type="button" class="ed-btn dw-toggle" data-find="director-warnings" aria-expanded={open}
      aria-label={`${warnings.length} Director warning${warnings.length === 1 ? "" : "s"} on this page`}
      title="Director warnings: minor concerns it did not repair" onclick={() => (open = !open)}>
      <span class="dw-mark" aria-hidden="true">!</span>{warnings.length || ""}
    </button>
    {#if open}
      <div class="dw-pop" role="region" aria-label="Director warnings">
        <header><strong>Director warnings</strong><small>Minor concerns Director did not repair. Dismiss once checked.</small></header>
        {#if error}<p class="dw-error" role="alert">{error}</p>{/if}
        {#each warnings as warning (warning.key)}
          <div class="dw-item">
            <p>{warning.message}</p>
            {#if warning.evidence}<p class="dw-evidence">{warning.evidence}</p>{/if}
            <div class="dw-actions">
              {#if warning.lineId}<button type="button" onclick={() => { open = false; onregion?.(warning.lineId!); }}>Show region</button>{/if}
              <button type="button" disabled={!canEdit || dismissing === warning.key} onclick={() => void dismiss(warning)}>Dismiss</button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .dw { position: relative; }
  .dw-toggle { border-color: #c9a24a !important; }
  .dw-mark {
    display: inline-grid; place-items: center; width: 16px; height: 16px; border-radius: 50%;
    background: #c9a24a; color: #1b1405; font-weight: 800; font-size: 11px; line-height: 1;
  }
  .dw-pop {
    position: absolute; top: calc(100% + 6px); left: 0; z-index: 50; width: min(380px, calc(100vw - 32px));
    max-height: 60vh; overflow: auto; padding: 10px; border-radius: 8px;
    border: 1px solid var(--hud-line); background: var(--hud-bg); color: var(--hud-text);
    box-shadow: 0 10px 30px #0006; display: grid; gap: 8px;
  }
  header { display: grid; gap: 2px; }
  header small, .dw-evidence { color: var(--hud-muted, #999); font-size: 12px; }
  .dw-item { border: 1px solid var(--hud-line); border-left: 3px solid #c9a24a; border-radius: 6px; padding: 7px 9px; display: grid; gap: 5px; }
  .dw-item p { margin: 0; font-size: 13px; overflow-wrap: anywhere; }
  .dw-actions { display: flex; gap: 6px; justify-content: flex-end; }
  .dw-actions button {
    font: inherit; font-size: 12px; padding: 3px 9px; border-radius: 999px; cursor: pointer;
    border: 1px solid var(--hud-line); background: var(--hud-btn-bg); color: var(--hud-text);
  }
  .dw-actions button:disabled { opacity: .5; cursor: default; }
  .dw-error { color: #e0806e; margin: 0; font-size: 12px; }
</style>
