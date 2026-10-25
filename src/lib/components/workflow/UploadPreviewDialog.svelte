<script lang="ts">
  // Opens whenever files are staged for upload so adding images never looks
  // like nothing happened: the letterer previews, reorders, then confirms or
  // cancels before carrying on.
  let {
    files = $bindable([]),
    busy = false,
    pageMode = "pages",
    insertLabel = "",
    duplicateWarning = "",
    error = "",
    onupload,
    oncancel,
    onaddfiles,
  }: {
    files?: File[];
    busy?: boolean;
    pageMode?: "pages" | "strip";
    insertLabel?: string;
    duplicateWarning?: string;
    error?: string;
    onupload: () => void;
    oncancel: () => void;
    onaddfiles: (files: File[]) => void;
  } = $props();

  let dialog = $state<HTMLDialogElement | undefined>();
  let urls = new Map<File, string>();

  function url(file: File) {
    let found = urls.get(file);
    if (!found) urls.set(file, (found = URL.createObjectURL(file)));
    return found;
  }

  $effect(() => {
    const open = files.length > 0;
    if (!dialog) return;
    if (open && !dialog.open) {
      try { dialog.showModal(); } catch { dialog.setAttribute("open", ""); }
    } else if (!open && dialog.open) dialog.close();
    for (const [file, href] of urls)
      if (!files.includes(file)) { URL.revokeObjectURL(href); urls.delete(file); }
  });

  $effect(() => () => { for (const href of urls.values()) URL.revokeObjectURL(href); urls.clear(); });

  function move(i: number, delta: number) {
    const j = i + delta;
    if (j < 0 || j >= files.length) return;
    const next = [...files];
    [next[i], next[j]] = [next[j], next[i]];
    files = next;
  }

  function size(bytes: number) {
    return bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  }
</script>

<dialog
  class="hud-modal hud-dialog-controls upload-preview"
  bind:this={dialog}
  aria-labelledby="upload-preview-title"
  data-find="upload-preview"
  oncancel={(e) => { e.preventDefault(); if (!busy) oncancel(); }}
>
  <header class="hud-window-bar">
    <h3 id="upload-preview-title">Add {files.length} image{files.length === 1 ? "" : "s"}</h3>
  </header>
  <div class="body">
    <p class="hint">
      Check the order below — this is the reading order the pages will get{insertLabel ? `, ${insertLabel}` : ""}.
      {pageMode === "strip" ? "Short uploads are automatically joined into strips." : "Each image becomes its own page."}
    </p>
    {#if duplicateWarning}<p class="warning" role="status">{duplicateWarning}</p>{/if}
    {#if error}<p class="failure" role="alert">{error}</p>{/if}
    <ol class="grid">
      {#each files as file, i (file)}
        <li>
          <div class="thumb"><img src={url(file)} alt="" loading="lazy" /></div>
          <div class="meta">
            <span class="n">{i + 1}</span>
            <span class="name" title={file.name}>{file.name}</span>
            <small>{size(file.size)}</small>
          </div>
          <div class="acts">
            <button type="button" class="btn-hud-ghost" aria-label={`Move ${file.name} earlier`} disabled={busy || i === 0} onclick={() => move(i, -1)}>←</button>
            <button type="button" class="btn-hud-ghost" aria-label={`Move ${file.name} later`} disabled={busy || i === files.length - 1} onclick={() => move(i, 1)}>→</button>
            <button type="button" class="btn-hud-ghost" aria-label={`Remove ${file.name}`} disabled={busy} onclick={() => (files = files.filter((f) => f !== file))}>✕</button>
          </div>
        </li>
      {/each}
    </ol>
    <div class="hud-modal-actions">
      <label class="btn-hud-ghost more">
        Add more…
        <input type="file" accept="image/*" multiple disabled={busy}
          onchange={(e) => { onaddfiles([...(e.currentTarget.files ?? [])]); e.currentTarget.value = ""; }} />
      </label>
      <span class="spacer"></span>
      <button class="btn-hud-ghost" type="button" disabled={busy} onclick={oncancel}>Cancel</button>
      <button class="btn-hud" type="button" disabled={busy || !files.length} onclick={onupload}>
        {busy ? "Uploading…" : `Upload ${files.length} image${files.length === 1 ? "" : "s"}`}
      </button>
    </div>
  </div>
</dialog>

<style>
  dialog.upload-preview { width: min(860px, calc(100vw - 2rem)); max-height: calc(100vh - 3rem); padding: 0; border-color: var(--hud-teal-ink); }
  .body { display: grid; gap: 0.75rem; padding: 1rem 1.15rem 1.1rem; }
  .hint { margin: 0; color: var(--hud-muted); font-size: 0.82rem; }
  .warning { margin: 0; color: #f5b85c; font-size: 0.82rem; }
  .failure { margin: 0; color: var(--hud-danger); font-size: 0.82rem; }
  .grid {
    list-style: none; margin: 0; padding: 0;
    display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 10px;
    max-height: min(60vh, 520px); overflow: auto;
  }
  li { display: grid; gap: 4px; border: 1px solid var(--hud-line); padding: 6px; background: var(--hud-canvas, var(--hud-bg)); }
  .thumb { aspect-ratio: 3 / 4; display: grid; place-items: center; overflow: hidden; background: #0002; }
  .thumb img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .meta { display: flex; gap: 6px; align-items: baseline; min-width: 0; font-size: 0.75rem; color: var(--hud-text); }
  .n { font-weight: 700; color: var(--hud-teal, inherit); }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta small { color: var(--hud-muted); }
  .acts { display: flex; gap: 4px; }
  .acts button { flex: 1; padding: 2px 0; }
  .hud-modal-actions { display: flex; gap: 8px; align-items: center; }
  .spacer { flex: 1; }
  .more { position: relative; cursor: pointer; }
  .more input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
</style>
