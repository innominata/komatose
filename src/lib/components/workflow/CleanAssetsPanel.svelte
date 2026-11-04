<script lang="ts">
  import "./studio-controls.css";
  import { onMount } from "svelte";
  import {
    ASSET_DRAG_TYPE,
    type CleanAsset,
    type PlacedAsset,
  } from "$lib/cleanAssets";
  let {
    seriesId,
    placements,
    selectedId,
    canClean,
    busy,
    oninsert,
    onselect,
    onchange,
    onlibrarychange = () => {},
  }: {
    seriesId: string;
    placements: PlacedAsset[];
    selectedId: string;
    canClean: boolean;
    busy: boolean;
    oninsert: (a: CleanAsset) => void;
    onselect: (id: string) => void;
    onchange: (list: PlacedAsset[]) => void;
    onlibrarychange?: () => void;
  } = $props();
  let assets = $state<CleanAsset[]>([]),
    revision = $state(0),
    working = $state(false),
    error = $state("");
  let input: HTMLInputElement;
  let replaceId = $state("");
  const api = $derived(`/api/series/${seriesId}/clean-assets`);
  const selected = $derived(placements.find((p) => p.id === selectedId));
  async function response(res: Response) {
    const data = await res.json();
    if (!res.ok) throw Error(data.error || "Could not save assets");
    assets = data.assets;
    revision = data.revision;
    onlibrarychange();
  }
  onMount(() => {
    void fetch(api)
      .then(response)
      .catch((e) => (error = e.message));
  });
  async function upload(files: File[]) {
    working = true;
    error = "";
    try {
      for (const file of files) {
        const form = new FormData();
        form.append("file", file);
        form.append("revision", String(revision));
        if (replaceId) form.append("replaceId", replaceId);
        await response(await fetch(api, { method: "POST", body: form }));
      }
    } catch (e) {
      error = String(e);
    } finally {
      working = false;
      replaceId = "";
      if (input) input.value = "";
    }
  }
  async function remove(id: string) {
    working = true;
    error = "";
    try {
      await response(
        await fetch(api, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, revision }),
        }),
      );
    } catch (e) {
      error = String(e);
    } finally {
      working = false;
    }
  }
  function patch(values: Partial<PlacedAsset>) {
    if (selected)
      onchange(
        placements.map((p) => (p.id === selected.id ? { ...p, ...values } : p)),
      );
  }
  function number(
    key: "x" | "y" | "width" | "height" | "rotation" | "opacity",
    value: string,
  ) {
    const n = Number(value);
    if (Number.isFinite(n)) patch({ [key]: n });
  }
  function reorder(delta: number) {
    if (!selected) return;
    const list = [...placements],
      i = list.findIndex((p) => p.id === selected.id),
      next = i + delta;
    if (next < 0 || next >= list.length) return;
    [list[i], list[next]] = [list[next], list[i]];
    onchange(list);
  }
</script>

<section class="assets wf-ui" aria-label="Cleaning assets">
  <header>
    <strong>Assets</strong><button
      type="button"
      disabled={!canClean || busy || working}
      onclick={() => {
        replaceId = "";
        input.click();
      }}>Upload PNGs</button
    >
  </header>
  <input
    bind:this={input}
    type="file"
    accept="image/png,.png"
    multiple={!replaceId}
    hidden
    onchange={(e) => void upload([...(e.currentTarget.files ?? [])])}
  />
  <p>
    Shared across this series. Drag a graphic onto the page, or click Insert.
    Move it, drag a corner to resize, or drag the rotation handle.
  </p>
  {#if error}<p role="alert">{error}</p>{/if}
  <div
    class="library"
    ondragover={(e) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    }}
    ondrop={(e) => {
      if (e.dataTransfer?.files.length) {
        e.preventDefault();
        if (canClean && !working && !busy)
          void upload([...e.dataTransfer.files]);
      }
    }}
    role="group"
    aria-label="Reusable PNG assets"
  >
    {#each assets as a (a.id)}<article
        draggable={canClean && !busy && !working}
        ondragstart={(e) => {
          e.dataTransfer?.setData(ASSET_DRAG_TYPE, JSON.stringify(a));
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
        }}
      >
        <img src={`${api}?hash=${a.hash}`} alt={a.name} draggable="false" />
        <span title={a.name}>{a.name}</span><small>{a.width} × {a.height}</small
        >
        <div class="buttons">
          <button
            type="button"
            disabled={!canClean || busy || working}
            onclick={() => oninsert(a)}>Insert</button
          ><button
            type="button"
            disabled={!canClean || busy || working}
            aria-label={`Replace ${a.name}`}
            onclick={() => {
              replaceId = a.id;
              input.click();
            }}>Replace</button
          ><button
            type="button"
            disabled={!canClean || busy || working}
            aria-label={`Delete ${a.name}`}
            onclick={() => void remove(a.id)}>Delete</button
          >
        </div>
      </article>{/each}
    {#if !assets.length}<p>
        Upload a title card, logo, or other PNG. Transparency is preserved.
      </p>{/if}
  </div>
  {#if placements.length}<h3>On this page</h3>
    <div class="placed">
      {#each placements as p (p.id)}<button
          type="button"
          class:active={selectedId === p.id}
          onclick={() => onselect(p.id)}>{p.name}</button
        >{/each}
    </div>{/if}
  {#if selected}<fieldset disabled={!canClean || busy}>
      <legend>Transform {selected.name}</legend>
      <div class="grid">
        <label
          >X (px)<input
            aria-label="Graphic X"
            type="number"
            value={Math.round(selected.x)}
            onchange={(e) => number("x", e.currentTarget.value)}
          /></label
        ><label
          >Y (px)<input
            aria-label="Graphic Y"
            type="number"
            value={Math.round(selected.y)}
            onchange={(e) => number("y", e.currentTarget.value)}
          /></label
        >
        <label
          >Width (px)<input
            aria-label="Graphic width"
            type="number"
            min="1"
            max="30000"
            value={Math.round(selected.width)}
            onchange={(e) => {
              const w = Number(e.currentTarget.value);
              if (w > 0)
                patch({
                  width: w,
                  height: (selected.height * w) / selected.width,
                });
            }}
          /></label
        ><label
          >Height (px)<input
            aria-label="Graphic height"
            type="number"
            min="1"
            max="30000"
            value={Math.round(selected.height)}
            onchange={(e) => {
              const h = Number(e.currentTarget.value);
              if (h > 0)
                patch({
                  height: h,
                  width: (selected.width * h) / selected.height,
                });
            }}
          /></label
        >
        <label
          >Rotation (°)<input
            aria-label="Graphic rotation"
            type="number"
            value={Math.round(selected.rotation)}
            onchange={(e) => number("rotation", e.currentTarget.value)}
          /></label
        ><label
          >Opacity<input
            aria-label="Graphic opacity"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={selected.opacity}
            oninput={(e) => number("opacity", e.currentTarget.value)}
          /></label
        >
      </div>
      <div class="buttons">
        <button type="button" onclick={() => reorder(1)}>Forward</button><button
          type="button"
          onclick={() => reorder(-1)}>Backward</button
        ><button
          type="button"
          onclick={() =>
            onchange(placements.filter((p) => p.id !== selected.id))}
          >Remove from page</button
        >
      </div>
    </fieldset>{/if}
</section>

<style>
  h3 {
    font:
      600 12px Inter,
      system-ui,
      sans-serif;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin: 16px 0 8px;
  }
  legend {
    font:
      600 13px Inter,
      system-ui,
      sans-serif;
    float: none;
    width: auto;
    margin: 0;
    padding: 0 4px;
  }
  .assets {
    padding: 14px;
    border-bottom: 1px solid var(--hud-line, #ccc);
    font-size: 12px;
  }
  header,
  .buttons {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  header {
    justify-content: space-between;
  }
  p {
    color: var(--hud-muted);
    line-height: 1.5;
  }
  .library {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  article {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
    padding: 8px;
    border: 1px solid var(--hud-line, #ccc);
    border-radius: 7px;
    cursor: grab;
  }
  article img {
    width: 100%;
    height: 80px;
    object-fit: contain;
    background: repeating-conic-gradient(#ddd 0% 25%, #fff 0% 50%) 0/16px 16px;
  }
  article span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  button {
    font: inherit;
    padding: 5px 8px;
    border: 1px solid var(--hud-line, #ccc);
    border-radius: 5px;
    background: var(--hud-panel, #fff);
    color: inherit;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .placed {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .active {
    outline: 2px solid #18ad91;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  input {
    min-width: 0;
    width: 100%;
    box-sizing: border-box;
  }
  fieldset {
    margin: 12px 0 0;
    border: 1px solid var(--hud-line, #ccc);
    padding: 10px;
    border-radius: 6px;
  }
  .buttons {
    margin-top: 5px;
  }
  [role="alert"] {
    color: #b33;
  }
</style>
