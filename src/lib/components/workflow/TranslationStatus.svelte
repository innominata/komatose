<script lang="ts">
  import "./studio-controls.css";

  let {
    job,
    canEdit,
    canUpload,
    busy,
    aiRunning,
    onstop,
    onretry,
    onreview,
    ondismiss,
  }: {
    job: {
      id: string;
      kind: string;
      state: string;
      progress?: { message?: string; completed?: number; total?: number };
    };
    canEdit: boolean;
    canUpload: boolean;
    busy: boolean;
    aiRunning: boolean;
    onstop: () => void;
    onretry: () => void;
    onreview: () => void;
    ondismiss?: () => void;
  } = $props();

  const active = $derived(["running", "queued"].includes(job.state));
  const counts = $derived(job.progress?.total ? `${job.progress.completed ?? 0}/${job.progress.total}` : "");
  const message = $derived.by(() => {
    const text = job.progress?.message || job.state;
    return active && /complete/i.test(text) ? "Finishing…" : text;
  });
</script>

<div class="translation-status wf-ui" role="status" data-state={job.state} title={job.progress?.message || job.state}>
  {#if active}<i class="bi bi-arrow-repeat spin" aria-hidden="true"></i>{/if}
  <strong>{job.kind === "transcribe" ? "Transcribe" : "Translate"}</strong>
  <span class="msg">{message}{#if counts} · {counts}{/if}</span>
  {#if active}
    <button disabled={!canEdit} onclick={onstop}>Stop</button>
  {:else if ["failed", "interrupted", "cancelled"].includes(job.state)}
    <button disabled={busy || aiRunning || !canUpload} onclick={onretry}>Retry unfinished</button>
  {:else}
    <button onclick={onreview}>Review</button>
  {/if}
  {#if ondismiss}<button class="x" aria-label="Hide job status" onclick={ondismiss}>×</button>{/if}
</div>

<style>
  .translation-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 380px;
    padding: 2px 4px 2px 10px;
    border-radius: 999px;
    background: var(--hud-teal-dim);
    color: var(--hud-text);
    font-size: 11.5px;
  }
  .translation-status[data-state="failed"] { background: rgba(200, 80, 80, 0.2); }
  .msg { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--hud-muted); }
  button { padding: 2px 8px; font-size: 11.5px; }
  .x { padding: 2px 6px; background: transparent; border: 0; }
  .spin { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
