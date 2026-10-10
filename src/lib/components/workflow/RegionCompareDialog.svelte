<script lang="ts">
  import "./studio-controls.css";
  import { tick } from "svelte";

  type RegionCompareRequest = {
    title: string;
    savedCount: number;
    onSaveExample: () => Promise<{ savedCount: number; apngSrc: string; gifSrc: string }>;
    onClearExamples: () => Promise<{ savedCount: number; apngSrc: string; gifSrc: string }>;
    /** Animated PNG for this region. */
    apngSrc: string;
    /** Same frames as a GIF, for apps that still prefer one. */
    gifSrc: string;
    /** Suggested file name, without the extension. */
    downloadName: string;
  };

  let dialog = $state<HTMLDialogElement | undefined>();
  let request = $state<RegionCompareRequest | null>(null);
  let format = $state<"apng" | "gif">("apng");
  let loading = $state(true);
  let failed = $state(false);
  let copied = $state(false);
  let savingExample = $state(false);
  let exampleError = $state("");
  let copyError = $state("");

  const src = $derived(request ? (format === "gif" ? request.gifSrc : request.apngSrc) : "");
  const absolute = $derived(
    src && typeof window !== "undefined" ? new URL(src, window.location.origin).href : "",
  );
  const download = $derived(
    request ? `${request.downloadName}.${format === "gif" ? "gif" : "png"}` : "",
  );

  export async function open(next: RegionCompareRequest) {
    request = next;
    exampleError = "";
    format = "apng";
    loading = true;
    failed = false;
    copied = false;
    copyError = "";
    if (!dialog) return;
    try {
      if (!dialog.open) dialog.showModal();
    } catch {
      dialog.setAttribute("open", "");
    }
    await tick();
  }

  function close() {
    copyError = "";
    if (dialog?.open) dialog.close();
    else request = null;
  }

  function pick(next: "apng" | "gif") {
    if (next === format) return;
    format = next;
    loading = true;
    failed = false;
  }

  async function updateExamples(clear = false) {
    if (!request) return;
    const current = request;
    savingExample = true;
    exampleError = "";
    try {
      const updated = await (clear ? current.onClearExamples() : current.onSaveExample());
      if (request !== current) return;
      Object.assign(current, updated);
      loading = true;
      failed = false;
      copied = false;
      copyError = "";
    } catch (e) {
      exampleError = e instanceof Error ? e.message : String(e);
    } finally {
      savingExample = false;
    }
  }

  async function copyLink() {
    copyError = "";
    try {
      await navigator.clipboard.writeText(absolute);
      copied = true;
    } catch (e) {
      copyError = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<!-- The dialog element stays mounted: bind:this must exist before the first open. -->
<dialog
  class="hud-modal hud-dialog-controls region-compare"
  bind:this={dialog}
  aria-labelledby="region-compare-title"
  onclick={(e) => {
    if (e.target === dialog) close();
  }}
  oncancel={(e) => {
    e.preventDefault();
    close();
  }}
  onclose={() => {
    request = null;
  }}
>
  {#if request}
    <header class="hud-window-bar">
      <h3 id="region-compare-title">{request.title}</h3>
      <button class="btn-hud-ghost" type="button" onclick={close}>Close</button>
    </header>
    <div class="compare-body">
      <div class="compare-stage" class:loading>
        <img
          {src}
          alt={`Raw and cleaned crop of ${request.title}, alternating every half second`}
          onload={() => (loading = false)}
          onerror={() => {
            loading = false;
            failed = true;
          }}
        />
      </div>
      {#if failed}
        <p class="compare-error" role="alert">
          Could not render the comparison. Save a cleaning pass on this page first, then try again.
        </p>
      {:else}
        <p class="compare-hint">
          Raw artwork alternates with each cleaning example every 0.5&nbsp;s. Method and available cleaning time appear at the top left.
          Right-click the image and <strong>Save image as…</strong> (or drag it out) to keep all
          frames. Pasting a copied image flattens it to one frame in most editors.
        </p>
      {/if}
      <div class="hud-modal-actions">
        <button class="btn-hud-ghost" type="button" disabled={loading || failed || savingExample} onclick={() => updateExamples()}>{savingExample ? "Saving…" : "Save clean example"}</button>
        <button class="btn-hud-ghost" type="button" disabled={savingExample || !request.savedCount} onclick={() => updateExamples(true)}>Clear examples</button>
      </div>
      <p class="compare-hint">{request.savedCount} temporary example(s) saved. Undo, try another cleaner, then compare again. Examples expire after two hours or a server restart; reloading clears this list.</p>
      {#if exampleError}<p class="compare-error" role="alert">{exampleError}</p>{/if}
      <div class="compare-formats">
        <span>Format</span>
        <button class="btn-hud-ghost" type="button" class:active={format === "apng"} onclick={() => pick("apng")}
          >APNG</button
        >
        <button class="btn-hud-ghost" type="button" class:active={format === "gif"} onclick={() => pick("gif")}
          >GIF</button
        >
        <small>{format === "gif" ? "256 colors, widest app support" : "Full color, smallest file"}</small>
      </div>
      <label class="compare-link">
        Image URL
        <input readonly value={absolute} onfocus={(e) => e.currentTarget.select()} />
      </label>
      {#if copyError}<p class="compare-error" role="alert">{copyError}</p>{/if}
      <div class="hud-modal-actions">
        <button class="btn-hud-ghost" type="button" onclick={copyLink}
          >{copied ? "Link copied" : "Copy link"}</button
        >
        <a class="compare-action" href={src} download={download}>Save image</a>
        <a class="compare-action" href={src} target="_blank" rel="noreferrer">Open in new tab</a>
        <button class="btn-hud" type="button" onclick={close}>Done</button>
      </div>
    </div>
  {/if}
</dialog>

<style>
  dialog.region-compare {
    width: min(760px, calc(100vw - 2rem));
    max-height: min(92vh, 940px);
    overflow: auto;
    padding: 0;
    border-color: var(--hud-teal-ink);
  }
  .hud-window-bar {
    gap: 0.5rem;
  }
  .hud-window-bar h3 {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .compare-body {
    display: grid;
    gap: 0.7rem;
    padding: 0.9rem 1.1rem 1rem;
  }
  .compare-stage {
    display: grid;
    place-items: center;
    min-height: 8rem;
    padding: 0.5rem;
    background:
      repeating-conic-gradient(#14171c 0% 25%, #191d23 0% 50%) 50% / 16px 16px;
    border: 1px solid var(--hud-line);
  }
  .compare-stage img {
    max-width: 100%;
    max-height: min(56vh, 560px);
    /* Keep the crop crisp while comparing lettering pixels. */
    image-rendering: -webkit-optimize-contrast;
  }
  .compare-stage.loading img {
    opacity: 0.35;
  }
  .compare-hint {
    margin: 0;
    color: var(--hud-muted);
    font-size: 0.82rem;
    line-height: 1.5;
  }
  .compare-hint strong {
    color: var(--hud-text);
  }
  .compare-error {
    margin: 0;
    color: #ffc283;
    font-size: 0.82rem;
  }
  .compare-formats {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.78rem;
    color: var(--hud-muted);
  }
  .compare-formats small {
    font-size: 0.72rem;
    opacity: 0.8;
  }
  .compare-formats .active {
    border-color: var(--hud-teal-ink);
    color: var(--hud-teal-ink);
    background: var(--hud-teal-dim);
  }
  .compare-link {
    display: grid;
    gap: 0.3rem;
    font-size: 0.78rem;
    color: var(--hud-muted);
  }
  .compare-link input {
    width: 100%;
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--hud-line);
    border-radius: 2px;
    background: var(--hud-bg);
    color: var(--hud-text);
    font: 0.78rem/1.4 ui-monospace, SFMono-Regular, monospace;
  }
  .hud-modal-actions {
    flex-wrap: wrap;
  }
  a.compare-action {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--hud-line);
    border-radius: 2px;
    padding: 0.35rem 0.75rem;
    color: var(--hud-muted);
    font-family: "Manrope", sans-serif;
    font-size: 0.78rem;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    text-decoration: none;
  }
  a.compare-action:hover {
    border-color: var(--hud-teal-ink);
    color: var(--hud-teal-ink);
  }
</style>
