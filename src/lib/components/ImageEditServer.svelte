<script lang="ts">
  import { onMount } from 'svelte';
  import { IMAGE_EDIT_MODELS, type ImageEditModelId } from '$lib/imageEdit';
  type ModelStatus = {
    id: ImageEditModelId;
    label: string;
    method: string;
    installed: boolean;
    quant?: string;
    active: boolean;
  };
  type Status = {
    id: ImageEditModelId | null;
    label: string;
    installed: boolean;
    quant?: string;
    state: string;
    device: string;
    port: number;
    pid?: number;
    error?: string;
    displaced: string[];
    evicted: string[];
    foreign: { pid: number; label: string }[];
    loras?: string[];
    models: ModelStatus[];
    busy: boolean;
  };
  let model = $state<Status | null>(null);
  let error = $state('');
  let busy = $state('');
  let ready = $state(false);
  async function api(url: string, body?: unknown) {
    const response = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || 'Image editor operation failed');
    return data;
  }
  async function refresh() {
    const data = await api('/api/admin/image-model');
    model = data.model;
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
  /** Naming the model swaps the resident editor: same card, same port, other weights. */
  async function lifecycle(action: string, id?: ImageEditModelId) {
    busy = id || action; error = '';
    try { await api('/api/admin/image-model', { action, ...(id ? { model: id } : {}) }); await refresh(); }
    catch (e) { error = String((e as Error).message); }
    finally { busy = ''; }
  }
  /** Starting a chat model on the shared card unloads the editor on its own. */
  async function handBack(id: string) {
    busy = id; error = '';
    try { await api('/api/admin/managed-models', { id, action: 'start' }); await refresh(); }
    catch (e) { error = String((e as Error).message); }
    finally { busy = ''; }
  }
  const settled = $derived(!model || !['starting', 'stopping'].includes(model.state));
  const installScript = (id: ImageEditModelId) =>
    id === 'qwen-image-edit-2511-lightning'
      ? 'scripts/install-image-edit-model.py --lightning'
      : 'scripts/install-image-edit-model.py';
</script>

<section class="image-edit mb-4" aria-label="Local image editor">
  <h3>Local image editor</h3>
  <p class="hud-muted">
    The local editors repaint masked lettering from a crop and a prompt, like Codex cleaning but local.
    Qwen-Image-Edit 2511 and its Lightning LoRA load the same weights in one process, and they share
    {model?.device || 'the chat card'} with the chat model. Starting the chat model unloads that process.
    Start here to keep the chosen editor loaded; a cleaning run starts it on demand and releases the card after a few idle minutes.
  </p>
  {#if !ready}
    <p class="hud-muted">Loading image editor…</p>
  {:else if model}
    <div class="row">
      <div>
        <strong>{model.label}</strong>
        <div class="hud-muted" role="status">
          {model.state}{model.quant ? ` · ${model.quant.toUpperCase()}` : ''} · {model.device} · port {model.port}{model.pid ? ` · pid ${model.pid}` : ''}
          {#if !model.installed} · no editor loaded{/if}
          {#if model.busy} · cleaning in progress{/if}
        </div>
        {#if model.displaced.length && model.state !== 'running'}
          <div class="hud-muted">Starting unloads {model.displaced.join(', ')} from {model.device}.</div>
        {/if}
        {#if model.foreign.length}
          <div class="hud-muted">
            {model.device} also holds {model.foreign.map((row) => row.label).join(', ')}, which this app does not manage.
            Starting the editor streams its weights from RAM until those stop.
          </div>
        {/if}
        {#if model.loras?.length}
          <div class="hud-muted">
            Applying {model.loras.join(', ')} from the LoRA directory. Restart after adding weights.
          </div>
        {/if}
        {#if model.error}<div class="alert-hud mt-2">{model.error}</div>{/if}
      </div>
      <div class="d-flex flex-wrap gap-2">
        <button class="btn-hud-ghost" disabled={!!busy || !settled || !model.pid} onclick={() => lifecycle('stop')}>Stop</button>
        <button class="btn-hud-ghost" disabled={!!busy || !model.installed || !settled || model.busy} onclick={() => lifecycle('restart')}>Restart</button>
      </div>
    </div>

    <ul class="editor-list">
      {#each model.models as editor (editor.id)}
        <li class="editor" class:active={editor.active}>
          <div>
            <strong>{editor.label}</strong>
            <div class="hud-muted">
              {#if !editor.installed}
                not installed
              {:else}
                {editor.quant ? editor.quant.toUpperCase() : 'installed'} · cleaning method “{IMAGE_EDIT_MODELS.find((m) => m.id === editor.id)?.methodLabel || editor.method}”
              {/if}
              {#if editor.active} · resident{/if}
            </div>
            {#if !editor.installed}
              <div class="hud-muted">Run <code>.venv-review/bin/python {installScript(editor.id)}</code>.</div>
            {:else}
              <div class="hud-muted">
                {IMAGE_EDIT_MODELS.find((m) => m.id === editor.id)?.summary}
              </div>
            {/if}
          </div>
          <button
            class="btn-hud-ghost"
            disabled={!!busy || !editor.installed || !settled || editor.active || model.busy}
            onclick={() => lifecycle('start', editor.id)}
          >{editor.active ? 'Loaded' : 'Load'}</button>
        </li>
      {/each}
    </ul>
    <p class="hud-muted">
      Building stable-diffusion.cpp with <code>-DSD_VULKAN=ON</code> provides the server this editor runs on.
    </p>
    {#if model.evicted.length}
      <div class="row">
        <div class="hud-muted">
          Holding the card after unloading {model.evicted.join(', ')}. Starting one of those hands the card back.
        </div>
        <div class="d-flex flex-wrap gap-2">
          {#each model.evicted as id}
            <button class="btn-hud-ghost" disabled={!!busy || !settled || model.busy} onclick={() => handBack(id)}>Load {id}</button>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
  {#if error}<div role="alert" class="alert-hud mt-2">{error}</div>{/if}
</section>
<style>
  .image-edit { border: 1px solid var(--hud-border, #555); padding: 1rem; border-radius: .5rem; }
  .row { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .75rem; align-items: start; }
  .editor-list { list-style: none; margin: .75rem 0 0; padding: 0; display: grid; gap: .5rem; }
  .editor {
    display: flex; justify-content: space-between; align-items: start; gap: .75rem;
    border: 1px solid var(--hud-border, #555); border-radius: .375rem; padding: .5rem .75rem;
  }
  .editor.active { border-color: var(--hud-accent, #8b5cf6); }
</style>
