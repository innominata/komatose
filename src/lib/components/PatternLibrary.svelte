<script lang="ts">
  import type { PatternAsset } from "$lib/workflow";

  /**
   * The shared pattern library: screentones and other tiles for the Pattern Overlay layer
   * style. Uploads, renames and removals go straight to `/settings/patterns` and the list
   * updates in place.
   */
  let {
    patterns: initial,
    canManage,
  }: { patterns: PatternAsset[]; canManage: boolean } = $props();

  const base = "/settings/patterns";
  // svelte-ignore state_referenced_locally
  let patterns = $state<PatternAsset[]>(initial);
  let search = $state("");
  let busy = $state(false);
  let uploading = $state(false);
  let dragging = $state(false);
  let error = $state("");
  let notice = $state("");
  let uploadInput = $state<HTMLInputElement>();

  const visible = $derived.by(() => {
    const q = search.trim().toLowerCase();
    return q ? patterns.filter((p) => `${p.name} ${p.filename}`.toLowerCase().includes(q)) : patterns;
  });

  async function upload(files: File[]) {
    const images = files.filter((f) => f.size > 0);
    if (!images.length || uploading) return;
    uploading = true;
    error = notice = "";
    try {
      // One file a request keeps each under the body limit and reports progress honestly.
      let added = 0, duplicates = 0;
      const failed: string[] = [];
      for (const file of images) {
        notice = `Adding ${added + duplicates + failed.length + 1} of ${images.length}…`;
        const form = new FormData();
        form.append("pattern", file);
        const res = await fetch(base, { method: "POST", body: form });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          failed.push(`${file.name}: ${body.error || res.statusText}`);
          continue;
        }
        patterns = body.patterns;
        if (body.duplicates) duplicates++;
        else added++;
      }
      notice = [
        added ? `Added ${added} pattern${added === 1 ? "" : "s"}.` : "",
        duplicates ? `${duplicates} already in the library.` : "",
      ].filter(Boolean).join(" ");
      if (failed.length) error = failed.join("\n");
    } finally {
      uploading = false;
      if (uploadInput) uploadInput.value = "";
    }
  }

  async function rename(p: PatternAsset, name: string) {
    if (!name.trim() || name.trim() === p.name) return;
    const res = await fetch(`${base}/${p.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    const body = await res.json().catch(() => ({}));
    if (res.ok) patterns = body.patterns;
    else error = body.error || "Could not rename pattern";
  }

  /** A pattern a style still uses needs a second go-ahead, since removing it clears those overlays. */
  async function remove(p: PatternAsset) {
    if (busy || !window.confirm(`Remove “${p.name}”? The pattern file is deleted and can't be restored.`)) return;
    busy = true;
    error = notice = "";
    try {
      let res = await fetch(`${base}/${p.id}`, { method: "DELETE" });
      if (res.status === 409) {
        if (!window.confirm("This pattern is still chosen in pattern overlays. Remove anyway? Those overlays will draw nothing until another pattern is picked.")) return;
        res = await fetch(`${base}/${p.id}?force=1`, { method: "DELETE" });
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Could not remove pattern");
      patterns = body.patterns;
      notice = `Removed “${p.name}”.`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function onDrop(e: DragEvent) {
    dragging = false;
    if (!canManage || !e.dataTransfer?.files.length) return;
    e.preventDefault();
    upload([...e.dataTransfer.files].filter((f) => f.type.startsWith("image/")));
  }
</script>

<div
  class="pattern-library"
  role="region"
  aria-label="Pattern library"
  ondragover={(e) => { if (canManage && e.dataTransfer?.types.includes("Files")) { e.preventDefault(); dragging = true; } }}
  ondragleave={(e) => { if (e.currentTarget === e.target) dragging = false; }}
  ondrop={onDrop}
>
  {#if canManage}
    <div class="pl-upload">
      <i class="bi bi-cloud-arrow-up pl-upload-icon" aria-hidden="true"></i>
      <div class="pl-upload-copy">
        <strong>{uploading ? "Adding patterns…" : "Add patterns"}</strong>
        <small>Drop PNG, JPEG, GIF or WebP tiles here, or choose files. Seamless tiles repeat cleanly.</small>
      </div>
      <input class="visually-hidden" bind:this={uploadInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple
        onchange={(e) => upload([...(e.currentTarget.files ?? [])])} />
      <button class="btn-hud" type="button" disabled={uploading} onclick={() => uploadInput?.click()}>Choose files…</button>
    </div>
  {/if}

  {#if error}<p class="alert-hud mb-0 pl-error" role="alert">{error}</p>{/if}
  {#if notice}<p class="small mb-0" role="status">{notice}</p>{/if}

  {#if patterns.length > 8}
    <label class="pl-search"><i class="bi bi-search" aria-hidden="true"></i><input class="form-control form-control-sm" placeholder="Search patterns" bind:value={search} /></label>
  {/if}

  {#if visible.length}
    <div class="pl-grid">
      {#each visible as p (p.id)}
        <article class="pl-card">
          <div class="pl-swatch" style={`background-image:url('${base}/${p.id}');background-size:${Math.max(24, Math.min(p.width, 600) / 4)}px auto`} title={`${p.width} × ${p.height} px`}></div>
          <div class="pl-foot">
            {#if canManage}
              <input class="pl-name" value={p.name} aria-label="Pattern name" onchange={(e) => rename(p, e.currentTarget.value)} />
              <button class="pl-icon" type="button" title="Remove" aria-label={`Remove ${p.name}`} disabled={busy} onclick={() => remove(p)}><i class="bi bi-trash" aria-hidden="true"></i></button>
            {:else}
              <span class="pl-name">{p.name}</span>
            {/if}
          </div>
          <small class="pl-meta">{p.width} × {p.height}</small>
        </article>
      {/each}
    </div>
  {:else}
    <div class="pl-empty">
      <i class="bi bi-grid-3x3" aria-hidden="true"></i>
      <p>{patterns.length ? "No patterns match." : "No patterns yet."}</p>
    </div>
  {/if}
  {#if dragging}<div class="pl-drop" aria-hidden="true"><i class="bi bi-cloud-arrow-up"></i> Drop to add patterns</div>{/if}
</div>

<style>
  .pattern-library { position: relative; display: grid; gap: 12px; }
  .pl-upload {
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px;
    padding: 12px 14px; border: 1px dashed var(--hud-line); border-radius: 6px; background: var(--hud-bg-2);
  }
  .pl-upload-icon { font-size: 22px; color: var(--hud-teal-ink); }
  .pl-upload-copy { display: grid; flex: 1 1 200px; line-height: 1.3; }
  .pl-upload-copy small { color: var(--hud-muted); }
  .pl-error { white-space: pre-line; }
  .pl-search { display: flex; align-items: center; gap: 6px; max-width: 320px; margin: 0; color: var(--hud-muted); }
  .pl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
  .pl-card { display: grid; min-width: 0; overflow: hidden; border: 1px solid var(--hud-line); border-radius: 6px; background: var(--hud-bg-2); }
  .pl-swatch { height: 96px; background-color: #fff; background-repeat: repeat; image-rendering: auto; }
  .pl-foot { display: flex; align-items: center; gap: 4px; padding: 5px 6px 0; border-top: 1px solid var(--hud-line); }
  .pl-name {
    flex: 1; min-width: 0; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    background: transparent; border: 1px solid transparent; border-radius: 3px; color: var(--hud-text); padding: 1px 4px;
  }
  input.pl-name:hover, input.pl-name:focus { border-color: var(--hud-line); background: var(--hud-bg); }
  .pl-meta { padding: 0 10px 6px; font-size: 10.5px; color: var(--hud-muted); }
  .pl-icon {
    display: grid; place-items: center; width: 26px; height: 26px; padding: 0; flex: none;
    border: 1px solid transparent; border-radius: 4px; background: transparent; color: var(--hud-muted); cursor: pointer;
  }
  .pl-icon:hover:not(:disabled) { color: var(--hud-danger); border-color: var(--hud-danger); }
  .pl-empty { display: grid; justify-items: center; gap: 8px; padding: 24px 16px; color: var(--hud-muted); border: 1px dashed var(--hud-line); border-radius: 6px; }
  .pl-empty i { font-size: 26px; }
  .pl-empty p { margin: 0; }
  .pl-drop {
    position: absolute; inset: 0; display: grid; place-items: center; font-size: 15px;
    border: 2px dashed var(--hud-teal-ink); border-radius: 6px; color: var(--hud-teal-ink);
    background: color-mix(in srgb, var(--hud-bg) 85%, transparent); pointer-events: none;
  }
</style>
