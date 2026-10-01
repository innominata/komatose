<script lang="ts">
  /**
   * The editor inside one expanded Setup → Local models card: launch presets,
   * recipe fields, save and Start/Stop/Restart for a single model. The page
   * owns the status polling and the card shell (name, badges, Edit/Delete).
   */
  import type { ModelRow } from '$lib/modelRegistry';
  import type { ManagedLaunch, ManagedStatus, RequestPreset } from '$lib/managedModels';

  let {
    row,
    status,
    presets = {},
    reservedReviewPorts = [],
    chatPort = 18080,
    onSaved,
  }: {
    row: ModelRow;
    status?: Partial<ManagedStatus>;
    presets?: Record<string, ManagedLaunch>;
    reservedReviewPorts?: Array<{ id: string; label: string; port: number }>;
    chatPort?: number;
    onSaved: () => Promise<void>;
  } = $props();

  // Draft state starts from the saved recipe on mount: collapse → expand
  // re-mounts the editor, so it always re-reads the stored values. JSON round
  // trip, not structuredClone: props and presets arrive as Svelte $state
  // proxies, which structuredClone refuses to clone.
  let recipe = $state<ManagedLaunch | null>(
    row.managedLaunch ? cloneLaunch(row.managedLaunch) : null,
  );
  let requestPreset = $state<RequestPreset>(row.requestPreset || 'generic');
  let argsText = $state(recipe?.extraArgs.join('\n') || '');
  let error = $state('');
  let message = $state('');
  let busy = $state(false);

  const PRESETS = [
    { id: 'generic', label: 'Generic llama.cpp preset' },
    { id: 'qwen38', label: 'Current Qwen preset' },
    { id: 'gemma4', label: 'Gemma 4 preset' },
    { id: 'gemma4-e2b', label: 'Gemma 4 E2B preset' },
    { id: 'gemma4-12b', label: 'Gemma 4 12B preset' },
  ] as const;

  const reserved = $derived.by(() => {
    const launch = recipe;
    return launch ? reservedReviewPorts.find((item) => item.port === Number(launch.port)) : undefined;
  });

  /** Plain-data copy of a recipe; safe on $state proxies (structuredClone is not). */
  function cloneLaunch(launch: ManagedLaunch): ManagedLaunch {
    return JSON.parse(JSON.stringify(launch)) as ManagedLaunch;
  }

  async function api(url: string, body?: unknown) {
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || 'Model operation failed');
    return data;
  }

  function usePreset(id: string) {
    if (!presets[id]) return;
    recipe = cloneLaunch(presets[id]);
    requestPreset = id === 'qwen38' ? 'qwen-thinking' : 'generic';
    argsText = recipe.extraArgs.join('\n');
    message = '';
    error = '';
  }

  async function act(work: () => Promise<void>) {
    busy = true;
    error = '';
    message = '';
    try {
      await work();
    } catch (e) {
      error = String((e as Error).message);
    } finally {
      busy = false;
    }
  }

  async function save() {
    await act(async () => {
      await api('/api/admin/models', {
        action: 'update',
        id: row.id,
        requestPreset,
        managedLaunch: recipe
          ? { ...recipe, extraArgs: argsText.split('\n').map((token) => token.trim()).filter(Boolean) }
          : null,
      });
      await onSaved();
      message = 'Saved. A running model keeps its current recipe until Restart.';
    });
  }

  async function lifecycle(action: 'start' | 'stop' | 'restart') {
    await act(async () => {
      await api('/api/admin/managed-models', { id: row.id, action });
      await onSaved();
    });
  }
</script>

<section class="local-editor" aria-label="Local model editor">
  <div class="d-flex flex-wrap gap-2 my-3">
    {#each PRESETS as preset (preset.id)}
      <button
        class="btn-hud-ghost"
        type="button"
        disabled={busy || !presets[preset.id]}
        onclick={() => usePreset(preset.id)}>{preset.label}</button
      >
    {/each}
    <button
      class="btn-hud-ghost"
      type="button"
      disabled={busy || !!status?.activeUses || !!status?.pid}
      onclick={() => {
        recipe = null;
        message = '';
        error = '';
      }}>Use external service</button
    >
  </div>

  <label
    >Request settings<select aria-label="Request preset" bind:value={requestPreset}>
      <option value="generic">Generic</option><option value="qwen-thinking">Qwen thinking template</option
      >
    </select></label
  >

  {#if recipe}
    <div class="fields my-3">
      <label>Executable<input aria-label="Model executable" bind:value={recipe.executable} /></label>
      <label>Weights<input aria-label="Model weights" bind:value={recipe.modelPath} /></label>
      <label>Vision projector (optional)<input aria-label="Vision projector" bind:value={recipe.projectorPath} /></label>
      <label>Chat template (optional)<input aria-label="Chat template" bind:value={recipe.templatePath} /></label>
      <label>Port<input aria-label="Model port" type="number" min="1" max="65535" bind:value={recipe.port} /></label>
      <label>Device<input aria-label="Model device" bind:value={recipe.device} /></label>
      <label>Context size<input aria-label="Model context size" type="number" min="512" bind:value={recipe.contextSize} /></label>
      <label>GPU layers<input aria-label="Model GPU layers" type="number" min="0" max="999" bind:value={recipe.gpuLayers} /></label>
      <label>Slots<input aria-label="Model slots" type="number" min="1" max="128" bind:value={recipe.slots} /></label>
    </div>
    {#if reserved}
      <div class="alert-hud my-2" role="status">
        Port {reserved.port} is reserved for {reserved.label}. Chat models use port {chatPort}.
      </div>
    {/if}
    <label class="d-block my-2"><input type="checkbox" bind:checked={recipe.startOnBoot} /> Start with the app</label>
    <details class="my-2">
      <summary>Advanced tuning arguments</summary>
      <p class="hud-muted">
        One argument token per line, including values on separate lines. Model, port, and
        authentication settings come from the fields above.
      </p>
      <textarea aria-label="Advanced launch arguments" rows="5" bind:value={argsText}></textarea>
    </details>
  {/if}

  <button class="btn-hud my-2" type="button" disabled={busy} onclick={save}>Save launch settings</button>

  {#if row.managedLaunch}
    <div class="my-2" role="status">
      {status?.state || 'stopped'}{status?.device ? ` · ${status.device}` : ''}{status?.port
        ? ` · port ${status.port}`
        : ''}
      · {status?.activeUses || 0} active uses
      {#if status?.pendingChanges}<strong> · Saved changes pending Restart</strong>{/if}
    </div>
    <div class="d-flex gap-2">
      <button
        class="btn-hud-ghost"
        type="button"
        disabled={busy || status?.state === 'starting' || status?.state === 'stopping'}
        onclick={() => lifecycle('start')}>Start model</button
      >
      <button
        class="btn-hud-ghost"
        type="button"
        disabled={busy || !!status?.activeUses || status?.state === 'starting' || status?.state === 'stopping'}
        onclick={() => lifecycle('stop')}>Stop model</button
      >
      <button
        class="btn-hud-ghost"
        type="button"
        disabled={busy || !!status?.activeUses || status?.state === 'starting' || status?.state === 'stopping'}
        onclick={() => lifecycle('restart')}>Restart model</button
      >
    </div>
    {#if status?.error}<div class="alert-hud my-2">{status.error}</div>{/if}
  {/if}

  {#if message}<p role="status" class="mt-2">{message}</p>{/if}
  {#if error}<div role="alert" class="alert-hud mt-2">{error}</div>{/if}
</section>

<style>
  .local-editor {
    border-top: 1px solid var(--hud-border, #555);
    margin-top: 0.6rem;
    padding-top: 0.4rem;
  }
  .fields {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
    gap: 0.75rem;
  }
  label {
    display: grid;
    gap: 0.25rem;
  }
  input:not([type='checkbox']),
  select,
  textarea {
    width: 100%;
    padding: 0.4rem;
    color: inherit;
    background: var(--hud-bg, #181818);
    border: 1px solid var(--hud-border, #555);
    border-radius: 0.25rem;
  }
</style>
