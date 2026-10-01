<script lang="ts">
  import { onMount } from 'svelte';
  type Status = {
    id: string;
    label: string;
    installed: boolean;
    state: string;
    port?: number;
    pid?: number;
    device?: string;
    served?: string;
    error?: string;
    operationId?: string;
    busy: boolean;
  };
  let models = $state<Status[]>([]);
  let error = $state('');
  let busyId = $state('');
  let ready = $state(false);
  async function api(url: string, body?: unknown) {
    const response = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || 'Review server operation failed');
    return data;
  }
  async function refresh() {
    const data = await api('/api/admin/review-models');
    models = data.models;
  }
  onMount(() => {
    ready = true;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(); } catch (e) { if (!disposed) error = String((e as Error).message); }
      if (!disposed) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  });
  async function lifecycle(id: string, action: string) {
    busyId = `${id}:${action}`;
    error = '';
    try {
      await api('/api/admin/review-models', { id, action });
      await refresh();
    } catch (e) { error = String((e as Error).message); }
    finally { busyId = ''; }
  }
  function canStop(row: Status) {
    if (row.busy || row.state === 'starting' || row.state === 'stopping' || !row.pid) return false;
    return !row.served || row.served === row.id;
  }
</script>

<section class="review-servers mb-4" aria-label="Local OCR / review servers">
  <h3>Local OCR / review servers</h3>
  <p class="hud-muted">
    Hayai, PaddleOCR-VL, and Qwen3-VL are separate loopback services. Status checks the process and the model it actually serves, so a chat model on the same port is reported instead of a false ready state.
    After <code>killall llama-server</code>, use Stop/Start here rather than assuming the OCR server is still up.
  </p>
  {#if !ready}
    <p class="hud-muted">Loading review servers…</p>
  {:else}
    <div class="list">
      {#each models as row}
        <article class="row">
          <div>
            <strong>{row.label}</strong>
            <div class="hud-muted" role="status">
              {row.state}{row.device ? ` · ${row.device}` : ''}{row.port ? ` · port ${row.port}` : ''}{row.pid ? ` · pid ${row.pid}` : ''}
              {#if row.served && row.served !== row.id} · serving {row.served}{/if}
              {#if !row.installed} · not installed{/if}
            </div>
            {#if row.error}<div class="alert-hud mt-2">{row.error}</div>{/if}
          </div>
          <div class="d-flex flex-wrap gap-2">
            <button class="btn-hud-ghost" disabled={!!busyId || !row.installed || row.state === 'starting' || row.state === 'stopping'} onclick={() => lifecycle(row.id, 'start')}>Start</button>
            <button class="btn-hud-ghost" disabled={!!busyId || !canStop(row)} onclick={() => lifecycle(row.id, 'stop')}>Stop</button>
            <button class="btn-hud-ghost" disabled={!!busyId || !row.installed || row.busy || row.state === 'starting' || row.state === 'stopping'} onclick={() => lifecycle(row.id, 'restart')}>Restart</button>
          </div>
        </article>
      {/each}
    </div>
  {/if}
  {#if error}<div role="alert" class="alert-hud mt-2">{error}</div>{/if}
</section>
<style>
  .review-servers { border: 1px solid var(--hud-border, #555); padding: 1rem; border-radius: .5rem; }
  .list { display: grid; gap: .75rem; }
  .row { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .75rem; align-items: start; }
</style>
