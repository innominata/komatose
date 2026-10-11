<script lang="ts">
  import { renderSafeMarkdown } from '$lib/safeMarkdown';
  import { pageProofreadCall, unwrapProofreadCritique, type PageProofreadJob } from '$lib/pageProofread';

  let { job, onclose }: { job: PageProofreadJob; onclose: () => void } = $props();
  let x = $state(90);
  let y = $state(90);
  let dragging = $state<{ pointer: number; x: number; y: number } | null>(null);
  const reply = $derived(renderSafeMarkdown(unwrapProofreadCritique(job.progress?.critique || ''), { breaks: true }));

  function startDrag(event: PointerEvent) {
    if ((event.target as HTMLElement).closest('button')) return;
    dragging = { pointer: event.pointerId, x: event.clientX - x, y: event.clientY - y };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }
  function moveDrag(event: PointerEvent) {
    if (!dragging || dragging.pointer !== event.pointerId) return;
    x = Math.max(0, Math.min(window.innerWidth - 100, event.clientX - dragging.x));
    y = Math.max(0, Math.min(window.innerHeight - 40, event.clientY - dragging.y));
  }
  function stopDrag(event: PointerEvent) {
    if (dragging?.pointer === event.pointerId) dragging = null;
  }
</script>

<div class="saved-proofread-window" role="dialog" aria-label={`Saved ${pageProofreadCall(job)} proofreader reply`} style:left={`${x}px`} style:top={`${y}px`}>
  <header role="toolbar" aria-label="Move saved reply" onpointerdown={startDrag} onpointermove={moveDrag} onpointerup={stopDrag} onpointercancel={stopDrag}>
    <div><strong>{pageProofreadCall(job)} proofread reply</strong><small>{new Date(job.created_at ?? Date.now()).toLocaleString()}</small></div>
    <button type="button" aria-label="Close saved reply" onclick={onclose}>Close</button>
  </header>
  <div class="body">
    {#if job.progress?.prompt}<p class="prompt"><strong>You:</strong> {job.progress.prompt}</p>{/if}
    <div class="reply">{@html reply}</div>
  </div>
</div>

<style>
  .saved-proofread-window { position: fixed; z-index: 2100; width: min(620px, 85vw); height: min(510px, 75vh); min-width: 280px; min-height: 180px; resize: both; overflow: hidden; display: flex; flex-direction: column; color: var(--hud-text); background: var(--hud-bg-2); border: 1px solid var(--hud-line); box-shadow: 0 12px 38px #0009; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 9px 12px; border-bottom: 1px solid var(--hud-line); cursor: move; touch-action: none; user-select: none; }
  header div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  small { color: var(--hud-muted); font-size: 11px; }
  .body { flex: 1; min-height: 0; overflow: auto; padding: 12px 16px; user-select: text; }
  .prompt { white-space: pre-wrap; overflow-wrap: anywhere; border-bottom: 1px solid var(--hud-line); padding-bottom: 12px; }
  .reply { line-height: 1.55; overflow-wrap: anywhere; }
  .reply :global(p) { margin: 0 0 12px; }
  .reply :global(ul), .reply :global(ol) { padding-left: 1.4em; }
</style>
