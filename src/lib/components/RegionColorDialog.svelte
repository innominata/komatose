<script lang="ts">
  import { normalizeHex, normalizeRegionKinds, type RegionKind } from "$lib/regionCatalog";

  let {
    kinds,
    seriesKinds = kinds,
    userColors,
    seriesCustom,
    canEditSeries,
    seriesTitle,
    embedded = false,
    onclose,
    onsaveuser,
    onsaveseries,
  }: {
    kinds: RegionKind[];
    seriesKinds?: RegionKind[];
    userColors: Record<string, string>;
    seriesCustom: boolean;
    canEditSeries: boolean;
    seriesTitle: string;
    embedded?: boolean;
    onclose?: () => void;
    onsaveuser: (colors: Record<string, string>) => Promise<void>;
    onsaveseries: (kinds: RegionKind[] | null) => Promise<void>;
  } = $props();

  let dialog = $state<HTMLDialogElement | HTMLDivElement>();
  let draft = $state<Record<string, string>>({});
  let seriesDraft = $state<RegionKind[]>([]);
  let added = $state({ id: "", label: "", color: "#c5ccd6" });
  let error = $state("");
  let saving = $state(false);

  function copyColors(colors: Record<string, string>) {
    draft = { ...colors };
  }

  function copySeries(list: RegionKind[]) {
    seriesDraft = list.map((kind) => ({ ...kind }));
  }

  $effect(() => {
    if (!embedded) return;
    copyColors(userColors);
    copySeries(seriesKinds);
  });

  export function open() {
    copyColors(userColors);
    copySeries(seriesKinds);
    added = { id: "", label: "", color: "#c5ccd6" };
    error = "";
    if (dialog && "showModal" in dialog) dialog.showModal();
  }

  function close() {
    if (embedded) onclose?.();
    else if (dialog && "close" in dialog) dialog.close();
  }

  function setUserColor(id: string, value: string) {
    const hex = normalizeHex(value);
    if (!hex) return;
    const base = kinds.find((kind) => kind.id === id)?.color;
    if (hex === base) {
      const next = { ...draft };
      delete next[id];
      draft = next;
      return;
    }
    draft = { ...draft, [id]: hex };
  }

  async function saveUser() {
    error = "";
    saving = true;
    try {
      await onsaveuser(draft);
      close();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  function addKind() {
    error = "";
    try {
      const next = normalizeRegionKinds([...seriesDraft, added]);
      seriesDraft = next;
      added = { id: "", label: "", color: "#c5ccd6" };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function removeKind(id: string) {
    if (seriesDraft.length < 2) {
      error = "A series needs at least one region type";
      return;
    }
    error = "";
    seriesDraft = seriesDraft.filter((kind) => kind.id !== id);
  }

  async function saveSeries(reset: boolean) {
    error = "";
    saving = true;
    try {
      await onsaveseries(reset ? null : normalizeRegionKinds(seriesDraft));
      close();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }
</script>

<svelte:element
  this={embedded ? "div" : "dialog"}
  class="hud-modal options region-colors"
  class:region-colors-embedded={embedded}
  bind:this={dialog}
  role={embedded ? "dialog" : undefined}
  aria-label={embedded ? "Region colors" : undefined}
  aria-labelledby="region-color-title"
  onclick={(e: MouseEvent) => {
    if (!embedded && e.target === dialog) close();
  }}
>
  <h3 id="region-color-title">Region colors</h3>
  <p>
    These colors are saved on your account and used on every series. A color you set here replaces that series's color for you.
  </p>
  <ul>
    {#each kinds as kind (kind.id)}
      <li>
        <input
          type="color"
          aria-label={`${kind.label} color`}
          value={draft[kind.id] ?? kind.color}
          oninput={(e) => setUserColor(kind.id, e.currentTarget.value)}
        />
        <span>{kind.label}</span>
        <code>{kind.id}</code>
        {#if draft[kind.id]}
          <button
            class="btn-hud-ghost"
            type="button"
            onclick={() => setUserColor(kind.id, kind.color)}>Use series color</button
          >
        {/if}
      </li>
    {/each}
  </ul>
  <div class="hud-modal-actions">
    <button
      class="btn-hud-ghost"
      type="button"
      disabled={saving || !Object.keys(draft).length}
      onclick={() => (draft = {})}>Reset all</button
    >
    <button class="btn-hud-ghost" type="button" onclick={close}>Close</button>
    <button class="btn-hud" type="button" disabled={saving} onclick={() => void saveUser()}>Save</button>
  </div>

  {#if canEditSeries}
    <h3>Series region types</h3>
    <p>
      {seriesTitle} {seriesCustom ? "uses its own region types." : "uses the built-in region types."}
      Adding or removing a type changes the menu for everyone on this series. Regions that already use a removed type stay, and people can still color them.
    </p>
    <ul>
      {#each seriesDraft as kind, index (kind.id)}
        <li>
          <input
            type="color"
            aria-label={`${kind.label} series color`}
            value={kind.color}
            oninput={(e) => {
              const hex = normalizeHex(e.currentTarget.value);
              if (!hex) return;
              seriesDraft[index] = { ...kind, color: hex };
            }}
          />
          <input
            aria-label={`${kind.id} name`}
            value={kind.label}
            maxlength="40"
            oninput={(e) => (seriesDraft[index] = { ...kind, label: e.currentTarget.value })}
          />
          <code>{kind.id}</code>
          <button
            class="btn-hud-ghost"
            type="button"
            disabled={seriesDraft.length < 2}
            onclick={() => removeKind(kind.id)}>Remove</button
          >
        </li>
      {/each}
    </ul>
    <div class="add-kind">
      <input aria-label="New region id" placeholder="id" bind:value={added.id} maxlength="24" />
      <input aria-label="New region name" placeholder="Name" bind:value={added.label} maxlength="40" />
      <input type="color" aria-label="New region color" bind:value={added.color} />
      <button class="btn-hud-ghost" type="button" onclick={addKind}>Add type</button>
    </div>
    <div class="hud-modal-actions">
      <button
        class="btn-hud-ghost"
        type="button"
        disabled={saving || !seriesCustom}
        onclick={() => void saveSeries(true)}>Use built-in types</button
      >
      <button class="btn-hud" type="button" disabled={saving} onclick={() => void saveSeries(false)}
        >Save series types</button
      >
    </div>
  {/if}
  {#if error}<p class="alert-hud">{error}</p>{/if}
</svelte:element>

<style>
  .region-colors {
    width: min(680px, calc(100vw - 2rem));
    max-height: min(88vh, 820px);
    overflow: auto;
    color: var(--hud-text, #e7eef6);
  }
  .region-colors p {
    margin: 0 0 0.8rem;
  }
  ul {
    list-style: none;
    margin: 0 0 0.8rem;
    padding: 0;
    display: grid;
    gap: 0.4rem;
  }
  li, .add-kind {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  li span, .add-kind {
    min-width: 0;
  }
  li span {
    flex: 1;
  }
  code {
    color: var(--hud-muted, #8ea0b5);
    font-size: 0.75rem;
  }
  input[type="color"] {
    width: 2.2rem;
    height: 1.7rem;
    padding: 0;
    border: 1px solid var(--hud-line, #2c3a4a);
    background: transparent;
  }
  .add-kind input:not([type="color"]), li input:not([type="color"]) {
    flex: 1;
    min-width: 0;
    color: inherit;
    background: var(--hud-bg, #121920);
    border: 1px solid var(--hud-line, #2c3a4a);
    border-radius: 4px;
    padding: 0.25rem 0.4rem;
  }
  .region-colors h3:not(:first-child) {
    margin-top: 1.2rem;
  }
  @media (max-width: 700px) {
    li, .add-kind {
      flex-wrap: wrap;
    }
    li > button, .add-kind > button {
      margin-left: auto;
    }
  }
</style>
