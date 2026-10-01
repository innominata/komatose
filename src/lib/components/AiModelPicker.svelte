<script lang="ts">
  import type { TaskEngine } from "$lib/aiTasks";
  import type { ProviderSelectionOption } from "$lib/providerCatalog";
  let {
    value = $bindable(),
    engines,
    label,
    disabled = false,
    models: _models = {},
    showModel: _showModel = true,
    labeledModels: _labeledModels = false,
  }: {
    value: TaskEngine;
    engines: ProviderSelectionOption[];
    label: string;
    disabled?: boolean;
    models?: unknown;
    showModel?: boolean;
    labeledModels?: boolean;
  } = $props();
  const selectedEngine = $derived(engines.find((engine) => engine.id === value.engine));
  const groups = $derived.by(() => {
    const order = ["Local models", "Remote models", "CLI agents", "Proofreaders", "Browser"] as const;
    const map = new Map<string, ProviderSelectionOption[]>();
    for (const engine of engines) {
      const group = (engine as ProviderSelectionOption & { group?: string }).group
        || (engine.pageImageOnly ? "Browser" : "Local models");
      const list = map.get(group) || [];
      list.push(engine);
      map.set(group, list);
    }
    return order.filter((name) => map.has(name)).map((name) => ({ name, engines: map.get(name)! }));
  });
</script>

<div class="model-picker">
  <label
    >{label}<select
      aria-label={label}
      {disabled}
      value={value.engine}
      onchange={(e) =>
        (value = {
          engine: e.currentTarget.value,
          model: "",
        })}
    >
      {#if value.engine && !selectedEngine}
        <option value={value.engine} disabled>Not offered until this task’s test passes</option>
      {/if}
      {#each groups as group}
        <optgroup label={group.name}>
          {#each group.engines as engine}
            <option
              value={engine.id}
              disabled={!engine.available && engine.id !== value.engine}
              >{engine.label}{engine.available ? "" : " (unavailable)"}</option
            >
          {/each}
        </optgroup>
      {/each}
    </select></label
  >
  {#if selectedEngine && !selectedEngine.available && selectedEngine.reason}
    <small>{selectedEngine.reason}</small>
  {/if}
</div>

<style>
  .model-picker {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
    align-items: end;
  }
  label {
    display: grid;
    gap: 0.25rem;
    flex: 1;
    font-size: 0.85rem;
  }
  select {
    width: 100%;
    min-width: 140px;
    padding: 0.4rem;
    background: var(--hud-input-bg);
    color: var(--hud-text);
    border: 1px solid var(--hud-line);
    border-radius: 2px;
  }
  small {
    display: block;
    color: var(--hud-muted);
    flex-basis: 100%;
  }
</style>
