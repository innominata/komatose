<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { TaskEngine } from '$lib/aiTasks';
  import { enginesForRegionAiField } from '$lib/regionAi';
  import type { TranslateEngineInfo } from '$lib/types';
  import { loadTranslationCatalog, type TranslationCatalog } from '$lib/translationCatalog';
  import { formatDuration } from '$lib/modelEstimate';

  let { value, engines, disabled = false, modelLabel: _modelLabel = 'Model override', lockEngineList = false, onenginesrefresh, onchange }: {
    value: TaskEngine | null;
    engines: TranslateEngineInfo[];
    disabled?: boolean;
    modelLabel?: string;
    lockEngineList?: boolean;
    onenginesrefresh?: () => unknown;
    onchange: (value: TaskEngine) => unknown;
  } = $props();
  let catalog = $state<TranslationCatalog | null>(null);
  let loading = $state(false);
  let error = $state('');
  const engineOptions = $derived(enginesForRegionAiField(
    'translate',
    lockEngineList ? engines : (catalog?.engines ?? engines),
    value?.engine,
  ));
  const selectedEngine = $derived(engineOptions.find(engine => engine.id === value?.engine));
  const groups = $derived.by(() => {
    const order = ['Local models', 'Remote models', 'CLI agents', 'Browser'] as const;
    const map = new Map<string, typeof engineOptions>();
    for (const engine of engineOptions) {
      const group = (engine as typeof engine & { group?: string }).group
        || (engine.pageImageOnly ? 'Browser' : 'Local models');
      const list = map.get(group) || [];
      list.push(engine);
      map.set(group, list);
    }
    return order.filter(name => map.has(name)).map(name => ({ name, engines: map.get(name)! }));
  });
  const estimate = $derived.by(() => {
    const raw = selectedEngine && (selectedEngine as { estimates?: Record<string, { ms: number }> }).estimates?.translate;
    return raw?.ms ? formatDuration(raw.ms) : '';
  });

  async function refresh(force = false) {
    loading = true;
    error = '';
    try {
      catalog = await loadTranslationCatalog(force);
      if (force) await onenginesrefresh?.();
    }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { loading = false; }
  }
  function shownValue() {
    return value?.engine ?? '';
  }
  function isNewUnavailable(next: TaskEngine) {
    const option = engineOptions.find(engine => engine.id === next.engine);
    return Boolean(option && !option.available && option.id !== value?.engine);
  }
  async function change(next: TaskEngine, field: HTMLSelectElement) {
    if (isNewUnavailable(next)) {
      field.value = shownValue();
      return;
    }
    try { await onchange(next); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally {
      await tick();
      field.value = shownValue();
    }
  }
  onMount(() => { void refresh(); });
</script>

<div class="translation-picker">
  <label>Translation model<select aria-label="Translation model" disabled={disabled || !value}
    value={value?.engine ?? ''} onchange={(e) => change({ engine: e.currentTarget.value, model: '' }, e.currentTarget)}>
    {#each groups as group}
      <optgroup label={group.name}>
        {#each group.engines as engine}
          <option value={engine.id} disabled={!engine.available && engine.id !== value?.engine}>{engine.label}{engine.available ? '' : ' (unavailable)'}</option>
        {/each}
      </optgroup>
    {/each}
  </select></label>
  <button type="button" disabled={loading} onclick={() => void refresh(true)} aria-label="Refresh translation models">Refresh models</button>
</div>
{#if selectedEngine && !selectedEngine.available && selectedEngine.reason}<small>{selectedEngine.reason}</small>{/if}
{#if estimate}<small>Est. 8-line page {estimate} (from last tests · detection/masking not included)</small>{/if}
{#if error}<p role="status">{error}</p>{/if}

<style>
  .translation-picker { display: flex; gap: .6rem; flex-wrap: wrap; align-items: end; }
  label { display: grid; gap: .25rem; flex: 1; font-size: .85rem; }
  select { width: 100%; min-width: 140px; padding: .4rem; background: var(--hud-input-bg); color: var(--hud-text); border: 1px solid var(--hud-line); border-radius: 2px; }
  small { display: block; color: var(--hud-muted); margin-top: .3rem; }
</style>
