<script lang="ts">
  import { onMount } from "svelte";
  import type { ImageRow, LineRow } from "$lib/types";
  let {
    apiBase,
    page,
    images,
    lines = [],
    source,
    onclose,
    onapply,
  }: {
    apiBase: string;
    page: ImageRow;
    images: ImageRow[];
    lines?: LineRow[];
    source: string;
    onclose: () => void;
    onapply: (body: Record<string, unknown>) => Promise<unknown>;
  } = $props();
  type Preview = {
    cutY: number;
    direction: string;
    pixels: number;
    neighborId: string;
    revisionToken: string;
    pages: { id: string; width: number; height: number; preview: string }[];
  };
  let cut = $state(
    Math.max(
      1,
      Math.min(
        page.height - 1,
        Math.round(page.height * (images.at(-1)?.id === page.id ? 0.25 : 0.75)),
      ),
    ),
  );
  let preview = $state<Preview | null>(null),
    loading = $state(false),
    applying = $state(false),
    error = $state("");
  let conflictId = $state("");
  const conflict = $derived(
    lines.find((l) => l.id === conflictId && l.imageId === page.id),
  );
  let picture: HTMLDivElement,
    dialog: HTMLDialogElement,
    dragging = false,
    sequence = 0;
  async function load() {
    const request = ++sequence;
    preview = null;
    error = "";
    conflictId = "";
    loading = true;
    try {
      const response = await fetch(`${apiBase}/pages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          op: "boundary-preview",
          imageId: page.id,
          cutY: cut,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        if (request === sequence) conflictId = result.current?.lineId ?? "";
        throw new Error(result.error || "Could not preview the boundary");
      }
      if (request === sequence) preview = result;
    } catch (e) {
      if (request === sequence)
        error = e instanceof Error ? e.message : String(e);
    } finally {
      if (request === sequence) loading = false;
    }
  }
  function place(e: PointerEvent) {
    const box = picture.getBoundingClientRect();
    cut = Math.max(
      1,
      Math.min(
        page.height - 1,
        Math.round(((e.clientY - box.top) / box.height) * page.height),
      ),
    );
    preview = null;
    ++sequence;
  }
  async function apply() {
    if (!preview || applying) return;
    applying = true;
    error = "";
    try {
      const result = await onapply({
        op: "move-boundary",
        imageId: page.id,
        cutY: preview.cutY,
        revisionToken: preview.revisionToken,
      });
      if (!result)
        throw new Error(
          "The boundary was not changed. Check the page error and preview again.",
        );
      onclose();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      preview = null;
    } finally {
      applying = false;
    }
  }
  onMount(() => {
    dialog.showModal();
    void load();
  });
</script>

<dialog
  bind:this={dialog}
  class="boundary-dialog"
  oncancel={(e) => {
    if (applying) e.preventDefault();
    else onclose();
  }}
  aria-label="Move page boundary"
>
  <header>
    <strong>Move page boundary</strong><button
      type="button"
      disabled={applying}
      onclick={onclose}
      aria-label="Close boundary tool">×</button
    >
  </header>
  <p>
    Place a horizontal line. The smaller part moves to the adjacent page.
    Regions, text, cleaning and edit history move with it.
  </p>
  <div class="controls">
    <label
      >Cut at <input
        aria-label="Boundary position in pixels"
        type="number"
        min="1"
        max={page.height - 1}
        bind:value={cut}
        disabled={applying}
        oninput={() => {
          preview = null;
          ++sequence;
        }}
        onchange={() => void load()}
      /> px</label
    >
    <button
      type="button"
      disabled={loading || applying}
      onclick={() => void load()}>Preview</button
    >
    <button
      type="button"
      class="apply"
      disabled={!preview || loading || applying}
      onclick={() => void apply()}
      >{applying
        ? "Moving…"
        : preview
          ? `Move ${preview.pixels}px to ${preview.direction} page`
          : "Move segment"}</button
    >
  </div>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if loading}<p aria-live="polite">Preparing lossless preview…</p>{/if}
  <div class="body">
    <section>
      <h3>Current raw page</h3>
      <div
        bind:this={picture}
        class="source"
        role="slider"
        tabindex="0"
        aria-label="Page boundary line"
        aria-valuemin="1"
        aria-valuemax={page.height - 1}
        aria-valuenow={cut}
        onkeydown={(e) => {
          if (["ArrowUp", "ArrowDown"].includes(e.key)) {
            e.preventDefault();
            cut = Math.max(
              1,
              Math.min(
                page.height - 1,
                cut + (e.key === "ArrowUp" ? -1 : 1) * (e.shiftKey ? 10 : 1),
              ),
            );
            void load();
          }
        }}
        onpointerdown={(e) => {
          if (applying || e.button !== 0) return;
          dragging = true;
          picture.setPointerCapture(e.pointerId);
          place(e);
        }}
        onpointermove={(e) => {
          if (dragging) place(e);
        }}
        onpointerup={() => {
          if (dragging) {
            dragging = false;
            void load();
          }
        }}
        onpointercancel={() => {
          dragging = false;
          void load();
        }}
      >
        <img
          src={source}
          alt="Current raw artwork; drag the line to choose a boundary"
          draggable="false"
        />
        {#if conflict && conflict.x != null && conflict.y != null}<div
            class="conflict"
            role="img"
            aria-label="Region blocking the boundary"
            style:left={`${conflict.x * 100}%`}
            style:top={`${conflict.y * 100}%`}
            style:width={`${(conflict.w ?? 0) * 100}%`}
            style:height={`${(conflict.h ?? 0) * 100}%`}
          ></div>{/if}
        <div class="line" style:top={`${(cut / page.height) * 100}%`}>
          <span>{cut}px</span>
        </div>
      </div>
    </section>
    <section>
      <h3>Resulting pages</h3>
      {#if preview}<p>
          Reviews become stale and page completion flags clear. Saved work is
          retained.
        </p>
        <div class="previews">
          {#each preview.pages as p}<figure>
              <figcaption>
                {p.width} × {p.height}px {p.id === page.id
                  ? "· current page"
                  : "· adjacent page"}
              </figcaption>
              <img
                src={p.preview}
                alt={`Resulting ${p.id === page.id ? "current" : "adjacent"} page`}
              />
            </figure>{/each}
        </div>{:else}<p>
          Move the line outside existing regions and lettering to preview.
        </p>{/if}
    </section>
  </div>
</dialog>

<style>
  .conflict {
    position: absolute;
    border: 3px solid #f24;
    background: #ff224433;
    pointer-events: none;
  }
  p[role="alert"] {
    overflow-wrap: anywhere;
  }
  .boundary-dialog {
    width: min(1100px, 96vw);
    max-height: 94vh;
    padding: 18px;
    background: var(--hud-bg, #20232a);
    color: var(--hud-text, #eee);
    border: 1px solid var(--hud-line, #555);
    border-radius: 12px;
    overflow: auto;
  }
  .boundary-dialog::backdrop {
    background: #0009;
  }
  header,
  .controls {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  header {
    justify-content: space-between;
  }
  button,
  input {
    font: inherit;
    color: inherit;
    background: var(--hud-bg-2, #30343d);
    border: 1px solid var(--hud-line, #777);
    border-radius: 5px;
    padding: 5px 9px;
  }
  button {
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  input {
    width: 100px;
  }
  .apply {
    border-color: #59c9a5;
  }
  p {
    font-size: 0.88rem;
  }
  p[role="alert"] {
    color: #ffb47e;
  }
  .body {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 22px;
  }
  h3 {
    font-size: 0.9rem;
  }
  .source {
    position: relative;
    touch-action: none;
    cursor: row-resize;
  }
  .source img {
    display: block;
    width: 100%;
    user-select: none;
  }
  .line {
    position: absolute;
    left: 0;
    right: 0;
    border-top: 2px solid #ff5a5a;
    pointer-events: none;
  }
  .line span {
    position: absolute;
    top: 1px;
    left: 0;
    background: #a11;
    color: white;
    font-size: 12px;
    padding: 1px 4px;
  }
  .previews {
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }
  .previews figure {
    flex: 1;
    min-width: 0;
    margin: 0;
  }
  .previews img {
    display: block;
    width: 100%;
  }
  figcaption {
    font-size: 0.75rem;
    margin-bottom: 6px;
  }
  @media (max-width: 650px) {
    .body {
      grid-template-columns: 1fr;
    }
    .source {
      max-width: 380px;
      margin: auto;
    }
  }
</style>
