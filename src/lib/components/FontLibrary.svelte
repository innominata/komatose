<script lang="ts">
  import { enhance } from "$app/forms";
  import { invalidateAll } from "$app/navigation";
  import {
    FONT_CATEGORIES,
    fontCategoryLabel,
    groupFontsByCategory,
    normalizeFontCategory,
  } from "$lib/fontCategories";
  import { blocksIn, codepointLabel, unicodeBlockOf } from "$lib/unicodeBlocks";
  import type { FontAsset } from "$lib/workflow";

  /**
   * The font list for one scope. `base` is the scope's font route: `/settings/fonts` for the
   * shared library, `/series/<id>/fonts` for a series. Shared fonts shown inside a series are
   * inspectable but read-only there; they are managed in Settings.
   */
  let {
    fonts,
    base,
    canManage = false,
    sharedLibrary = false,
    emptyText = "No fonts yet.",
    uploadAction,
  }: {
    fonts: FontAsset[];
    base: string;
    canManage?: boolean;
    /** True when this list is the shared library itself, so its fonts are editable here. */
    sharedLibrary?: boolean;
    emptyText?: string;
    /** Form action that accepts `font` files and a `category`; shows the Add fonts control when set. */
    uploadAction?: string;
  } = $props();

  type GlyphData = {
    font: FontAsset;
    codepoints: number[];
    info: {
      glyphCount: number;
      unitsPerEm: number | null;
      version: string;
      copyright: string;
      license: string;
      fileSize: number;
    };
  };

  const PAGE = 400;
  const editable = (font: FontAsset) => canManage && (sharedLibrary || !font.shared);

  let preview = $state("The quick brown fox. I can do this!");
  let sampleSize = $state(26);
  let uploadCategory = $state<string>("lettering");
  let uploadForm = $state<HTMLFormElement>();
  let uploadInput = $state<HTMLInputElement>();
  let uploading = $state(false);
  let dragging = $state(false);

  function submitUpload(files?: FileList | null) {
    if (!uploadForm || !uploadInput) return;
    if (files?.length) {
      const dt = new DataTransfer();
      for (const f of files) if (/\.(ttf|otf)$/i.test(f.name)) dt.items.add(f);
      if (!dt.files.length) { error = "Only TTF and OTF files can be added."; return; }
      uploadInput.files = dt.files;
    }
    if (uploadInput.files?.length) uploadForm.requestSubmit();
  }
  function onDrop(e: DragEvent) {
    if (!uploadAction) return;
    e.preventDefault();
    dragging = false;
    submitUpload(e.dataTransfer?.files);
  }
  let filter = $state<string>("all");
  let search = $state("");
  let selected = $state<string[]>([]);
  let bulkCategory = $state<string>("lettering");
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");

  const counts = $derived(
    Object.fromEntries(
      FONT_CATEGORIES.map((c) => [
        c.id,
        fonts.filter((f) => normalizeFontCategory(f.category) === c.id).length,
      ]),
    ) as Record<string, number>,
  );
  const visible = $derived.by(() => {
    const q = search.trim().toLowerCase();
    return fonts.filter(
      (f) =>
        (filter === "all" || normalizeFontCategory(f.category) === filter) &&
        (!q ||
          `${f.familyName} ${f.subfamilyName} ${f.filename} ${f.postscriptName}`
            .toLowerCase()
            .includes(q)),
    );
  });
  const groups = $derived(groupFontsByCategory(visible));
  const fileUrl = (font: FontAsset) => `${base}/${font.id}?download=1`;
  /** The whole library, or just `list` when it is a subset. */
  const zipUrl = (list: FontAsset[]) =>
    list.length === fonts.length ? `${base}/zip` : `${base}/zip?ids=${list.map((f) => f.id).join(",")}`;
  const selectable = $derived(visible.filter(editable));
  const chosen = $derived(selected.filter((id) => fonts.some((f) => f.id === id && editable(f))));
  const allChosen = $derived(selectable.length > 0 && selectable.every((f) => chosen.includes(f.id)));

  function toggle(id: string) {
    selected = selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
  }
  function toggleAll() {
    selected = allChosen
      ? selected.filter((id) => !selectable.some((f) => f.id === id))
      : [...new Set([...selected, ...selectable.map((f) => f.id)])];
  }

  async function request(url: string, init: RequestInit) {
    const res = await fetch(url, init);
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  }

  async function setCategory(ids: string[], category: string) {
    if (!ids.length || busy) return;
    busy = true;
    error = notice = "";
    try {
      const res = await request(base, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids, category }),
      });
      if (!res.ok) throw new Error(res.body.error || "Could not change category");
      notice =
        ids.length === 1
          ? `Filed under ${fontCategoryLabel(category)}.`
          : `Filed ${ids.length} fonts under ${fontCategoryLabel(category)}.`;
      await invalidateAll();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  /**
   * Removing a font a style still uses needs a second, explicit go-ahead, because it also
   * clears that font from those styles.
   */
  async function remove(ids: string[]) {
    if (!ids.length || busy) return;
    const names = ids
      .map((id) => fonts.find((f) => f.id === id))
      .filter((f): f is FontAsset => !!f)
      .map((f) => `${f.familyName} · ${f.subfamilyName}`);
    const what = ids.length === 1 ? `“${names[0]}”` : `${ids.length} fonts`;
    if (!window.confirm(`Remove ${what}? The font file is deleted and can't be restored.`)) return;
    busy = true;
    error = notice = "";
    let removed = 0;
    const inUse: string[] = [];
    try {
      for (const id of ids) {
        const res = await request(`${base}/${id}`, { method: "DELETE" });
        if (res.ok) removed++;
        else if (res.status === 409) inUse.push(id);
        else throw new Error(res.body.error || "Could not remove font");
      }
      if (inUse.length) {
        const label = inUse.length === 1 ? "A font you chose is" : `${inUse.length} of the fonts are`;
        if (
          window.confirm(
            `${label} still selected in type styles. Remove anyway and clear the font from those styles? Affected text will need a new font before it can be typeset.`,
          )
        ) {
          for (const id of inUse) {
            const res = await request(`${base}/${id}?force=1`, { method: "DELETE" });
            if (!res.ok) throw new Error(res.body.error || "Could not remove font");
            removed++;
          }
        }
      }
      selected = selected.filter((id) => !ids.includes(id));
      if (inspecting && ids.includes(inspecting.id)) closeInspector();
      const kept = ids.length - removed;
      notice = removed
        ? `Removed ${removed} font${removed === 1 ? "" : "s"}${kept ? `; kept ${kept} that are in use` : ""}.`
        : "";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      await invalidateAll();
      busy = false;
    }
  }

  // ── Inspector ───────────────────────────────────────────────────────────
  let dialogEl = $state<HTMLDialogElement>();
  let inspecting = $state<FontAsset | null>(null);
  let glyphs = $state<GlyphData | null>(null);
  let glyphError = $state("");
  let loadingGlyphs = $state(false);
  let block = $state("all");
  let glyphSearch = $state("");
  let shown = $state(PAGE);
  let picked = $state<number | null>(null);
  let inspectorText = $state("Sphinx of black quartz, judge my vow. 0123456789");
  let copied = $state("");
  let loadToken = 0;

  const isBlank = (cp: number) => /[\p{Z}\p{C}]/u.test(String.fromCodePoint(cp));
  const isMark = (cp: number) => /\p{M}/u.test(String.fromCodePoint(cp));
  const glyphChar = (cp: number) => (isMark(cp) ? `\u25CC${String.fromCodePoint(cp)}` : String.fromCodePoint(cp));

  const blocks = $derived(glyphs ? blocksIn(glyphs.codepoints) : []);
  const filteredGlyphs = $derived.by(() => {
    if (!glyphs) return [];
    let list = glyphs.codepoints;
    if (block !== "all") list = list.filter((cp) => unicodeBlockOf(cp) === block);
    const q = glyphSearch.trim();
    if (q) {
      // "U+2605" / "0x2605" look up one code point; anything else matches the characters typed.
      const code = /^(?:u\+|0x)([0-9a-f]{1,6})$/i.exec(q);
      if (code) {
        const wanted = parseInt(code[1], 16);
        list = list.filter((cp) => cp === wanted);
      } else {
        const typed = new Set([...q].map((c) => c.codePointAt(0)!));
        list = list.filter((cp) => typed.has(cp));
      }
    }
    return list;
  });

  const fmtBytes = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  async function inspect(font: FontAsset) {
    inspecting = font;
    glyphs = null;
    glyphError = "";
    block = "all";
    glyphSearch = "";
    shown = PAGE;
    picked = null;
    loadingGlyphs = true;
    const token = ++loadToken;
    if (dialogEl && !dialogEl.open) {
      try {
        dialogEl.showModal();
      } catch {
        dialogEl.setAttribute("open", "");
      }
    }
    try {
      const res = await request(`${base}/${font.id}/glyphs`, {});
      if (token !== loadToken) return;
      if (!res.ok) throw new Error(res.body.error || "Could not read the font");
      glyphs = res.body as GlyphData;
    } catch (e) {
      if (token === loadToken) glyphError = e instanceof Error ? e.message : String(e);
    } finally {
      if (token === loadToken) loadingGlyphs = false;
    }
  }

  function closeInspector() {
    loadToken++;
    inspecting = null;
    glyphs = null;
    if (dialogEl?.open) dialogEl.close();
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = label;
      setTimeout(() => (copied = ""), 1200);
    } catch {
      copied = "";
    }
  }

  const current = $derived(inspecting ? (fonts.find((f) => f.id === inspecting!.id) ?? inspecting) : null);
</script>

<svelte:head>
  {@html `<style>${fonts.map((f) => `@font-face{font-family:scan-${f.id};src:url('${base}/${f.id}');}`).join("")}</style>`}
</svelte:head>

<div
  class="font-library"
  class:dragging
  role="region"
  aria-label="Font library"
  ondragover={(e) => { if (uploadAction && e.dataTransfer?.types.includes("Files")) { e.preventDefault(); dragging = true; } }}
  ondragleave={(e) => { if (e.currentTarget === e.target) dragging = false; }}
  ondrop={onDrop}
>
  {#if canManage && uploadAction}
    <form
      class="fl-upload"
      method="POST"
      action={uploadAction}
      enctype="multipart/form-data"
      bind:this={uploadForm}
      use:enhance={() => {
        uploading = true;
        error = notice = "";
        return async ({ update }) => {
          await update();
          uploading = false;
          if (uploadInput) uploadInput.value = "";
        };
      }}
    >
      <i class="bi bi-cloud-arrow-up fl-upload-icon" aria-hidden="true"></i>
      <div class="fl-upload-copy">
        <strong>{uploading ? "Adding fonts…" : "Add fonts"}</strong>
        <small>Drop TTF or OTF files anywhere here, or choose files.</small>
      </div>
      <label class="fl-field">File under
        <select class="form-select form-select-sm" name="category" bind:value={uploadCategory}>
          {#each FONT_CATEGORIES as c}<option value={c.id}>{c.label}</option>{/each}
        </select>
      </label>
      <input class="visually-hidden" bind:this={uploadInput} name="font" type="file" accept=".ttf,.otf" multiple onchange={() => submitUpload()} />
      <button class="btn-hud" type="button" disabled={uploading} onclick={() => uploadInput?.click()}>Choose files…</button>
    </form>
  {/if}

  {#if error}<p class="alert-hud mb-0" role="alert">{error}</p>{/if}
  {#if notice}<p class="small mb-0" role="status">{notice}</p>{/if}

  <div class="fl-tabs" role="tablist" aria-label="Font categories">
    <button type="button" role="tab" aria-selected={filter === "all"} class:active={filter === "all"} onclick={() => (filter = "all")}
      >All <small>{fonts.length}</small></button
    >
    {#each FONT_CATEGORIES as c}
      <button type="button" role="tab" aria-selected={filter === c.id} class:active={filter === c.id} class:empty={!counts[c.id]} onclick={() => (filter = c.id)}
        >{c.label} <small>{counts[c.id]}</small></button
      >
    {/each}
  </div>

  <div class="fl-toolbar">
    <label class="fl-field fl-search"><span>Search</span>
      <span class="fl-input-icon"><i class="bi bi-search" aria-hidden="true"></i><input class="form-control form-control-sm" placeholder="Name or file" bind:value={search} /></span>
    </label>
    <label class="fl-field fl-grow"><span>Preview text</span><input class="form-control form-control-sm" bind:value={preview} /></label>
    <label class="fl-field fl-size"><span>Size {sampleSize}px</span><input type="range" min="14" max="60" step="1" bind:value={sampleSize} /></label>
    {#if visible.length}
      <a class="btn-hud fl-download" href={zipUrl(visible)} download
        title={visible.length === fonts.length ? "Every font, a folder per category" : "The fonts shown, a folder per category"}
        ><i class="bi bi-file-earmark-zip" aria-hidden="true"></i> {visible.length === fonts.length ? "Download all" : `Download ${visible.length} shown`}</a>
    {/if}
  </div>

  {#if canManage && selectable.length}
    <div class="fl-bulk" class:active={chosen.length > 0} aria-label="Bulk actions">
      <label class="mb-0"><input type="checkbox" checked={allChosen} onchange={toggleAll} /> Select all shown</label>
      {#if chosen.length}
        <span class="fl-bulk-count">{chosen.length} selected</span>
        <span class="fl-bulk-actions">
          <select class="form-select form-select-sm" aria-label="Category for selected fonts" bind:value={bulkCategory}>
            {#each FONT_CATEGORIES as c}<option value={c.id}>{c.label}</option>{/each}
          </select>
          <button class="btn-hud" type="button" disabled={busy} onclick={() => setCategory(chosen, bulkCategory)}>Move</button>
          <a class="btn-hud" href={zipUrl(fonts.filter((f) => chosen.includes(f.id)))} download><i class="bi bi-download" aria-hidden="true"></i> Download</a>
          <button class="btn-hud fl-danger" type="button" disabled={busy} onclick={() => remove(chosen)}><i class="bi bi-trash" aria-hidden="true"></i> Remove</button>
          <button class="btn-hud fl-ghost" type="button" onclick={() => (selected = [])}>Clear</button>
        </span>
      {/if}
    </div>
  {/if}

  {#each groups as group (group.id)}
    <section class="fl-group" aria-label={group.label}>
      {#if filter === "all"}<h3 class="fl-group-title">{group.label} <small>{group.fonts.length}</small></h3>{/if}
      <div class="fl-grid">
        {#each group.fonts as font (font.id)}
          <article class="fl-card" class:selected={selected.includes(font.id) && editable(font)}>
            <button type="button" class="fl-sample" title="Inspect glyphs" onclick={() => inspect(font)}>
              <span style={`font-family:scan-${font.id};font-size:${sampleSize}px`}>{preview || font.familyName}</span>
            </button>
            <div class="fl-card-foot">
              {#if editable(font)}
                <input class="fl-check" type="checkbox" aria-label={`Select ${font.familyName} ${font.subfamilyName}`} checked={selected.includes(font.id)} onchange={() => toggle(font.id)} />
              {/if}
              <div class="fl-name">
                <strong title={`${font.familyName} · ${font.subfamilyName}`}>{font.familyName}</strong>
                <small title={`${font.filename} · ${font.postscriptName}`}>
                  {font.subfamilyName} · {font.format}{#if font.shared && !sharedLibrary} · <span class="fl-badge">Shared</span>{/if}
                </small>
              </div>
              <div class="fl-actions">
                {#if editable(font)}
                  <select
                    class="form-select form-select-sm"
                    aria-label={`Category of ${font.familyName} ${font.subfamilyName}`}
                    value={normalizeFontCategory(font.category)}
                    disabled={busy}
                    onchange={(e) => setCategory([font.id], e.currentTarget.value)}
                  >
                    {#each FONT_CATEGORIES as c}<option value={c.id}>{c.label}</option>{/each}
                  </select>
                {/if}
                <button class="fl-icon" type="button" title="Inspect glyphs" aria-label={`Inspect ${font.familyName} ${font.subfamilyName}`} onclick={() => inspect(font)}><i class="bi bi-grid-3x3-gap" aria-hidden="true"></i></button>
                <a class="fl-icon" href={fileUrl(font)} download={font.filename} title={`Download ${font.filename}`} aria-label={`Download ${font.familyName} ${font.subfamilyName}`}><i class="bi bi-download" aria-hidden="true"></i></a>
                {#if editable(font)}
                  <button class="fl-icon fl-danger" type="button" title="Remove" aria-label={`Remove ${font.familyName} ${font.subfamilyName}`} disabled={busy} onclick={() => remove([font.id])}><i class="bi bi-trash" aria-hidden="true"></i></button>
                {/if}
              </div>
            </div>
          </article>
        {/each}
      </div>
    </section>
  {:else}
    <div class="fl-empty">
      <i class="bi bi-fonts" aria-hidden="true"></i>
      <p>{fonts.length ? "No fonts match this filter." : emptyText}</p>
      {#if fonts.length && (search || filter !== "all")}
        <button class="btn-hud" type="button" onclick={() => { search = ""; filter = "all"; }}>Show all fonts</button>
      {/if}
    </div>
  {/each}

  {#if dragging}<div class="fl-drop" aria-hidden="true"><i class="bi bi-cloud-arrow-up"></i> Drop to add as {fontCategoryLabel(uploadCategory)}</div>{/if}
</div>

<dialog class="hud-modal fl-inspector" bind:this={dialogEl} aria-labelledby="fl-inspector-title" onclose={() => { loadToken++; inspecting = null; glyphs = null; }}>
  {#if current}
    <header class="hud-window-bar">
      <h3 id="fl-inspector-title">{current.familyName} · {current.subfamilyName}</h3>
    </header>
    <div class="fl-inspector-body">
      <dl class="fl-facts">
        <div><dt>Category</dt><dd>{fontCategoryLabel(current.category)}{#if current.shared} · shared{/if}</dd></div>
        <div><dt>File</dt><dd>{current.filename}</dd></div>
        <div><dt>PostScript name</dt><dd>{current.postscriptName}</dd></div>
        <div><dt>Format</dt><dd>{current.format}{#if glyphs} · {fmtBytes(glyphs.info.fileSize)}{/if}</dd></div>
        {#if glyphs}
          <div><dt>Glyphs</dt><dd>{glyphs.info.glyphCount.toLocaleString()} total · {glyphs.codepoints.length.toLocaleString()} characters</dd></div>
          {#if glyphs.info.version}<div><dt>Version</dt><dd>{glyphs.info.version}</dd></div>{/if}
          {#if glyphs.info.license || glyphs.info.copyright}
            <div class="wide"><dt>Licence</dt><dd>{glyphs.info.license || glyphs.info.copyright}</dd></div>
          {/if}
        {/if}
      </dl>

      <label class="small">Sample text <input class="form-control form-control-sm" bind:value={inspectorText} /></label>
      <p class="fl-inspector-sample" style={`font-family:scan-${current.id}`}>{inspectorText}</p>

      {#if loadingGlyphs}
        <p class="small text-secondary">Reading font…</p>
      {:else if glyphError}
        <p class="alert-hud" role="alert">{glyphError}</p>
      {:else if glyphs}
        <div class="fl-glyph-tools">
          <label class="small mb-0">Block
            <select class="form-select form-select-sm" bind:value={block} onchange={() => { shown = PAGE; picked = null; }}>
              <option value="all">All blocks ({glyphs.codepoints.length.toLocaleString()})</option>
              {#each blocks as b}<option value={b.name}>{b.name} ({b.count.toLocaleString()})</option>{/each}
            </select>
          </label>
          <label class="small mb-0">Find character or code
            <input class="form-control form-control-sm" placeholder="é, ★ or U+2605" bind:value={glyphSearch} oninput={() => { shown = PAGE; picked = null; }} />
          </label>
          <span class="small text-secondary">{filteredGlyphs.length.toLocaleString()} shown</span>
        </div>

        <div class="fl-glyph-layout">
          <div class="fl-glyph-grid" role="listbox" aria-label="Glyphs">
            {#each filteredGlyphs.slice(0, shown) as cp (cp)}
              <button
                type="button"
                role="option"
                aria-selected={picked === cp}
                class="fl-glyph"
                class:active={picked === cp}
                class:blank={isBlank(cp)}
                title={codepointLabel(cp)}
                style={`font-family:scan-${current.id}`}
                onclick={() => (picked = cp)}
              >{#if isBlank(cp)}<small>{codepointLabel(cp).slice(2)}</small>{:else}{glyphChar(cp)}{/if}</button>
            {:else}
              <p class="small text-secondary">No glyphs match.</p>
            {/each}
            {#if filteredGlyphs.length > shown}
              <button type="button" class="btn-hud fl-more" onclick={() => (shown += PAGE)}>Show {Math.min(PAGE, filteredGlyphs.length - shown).toLocaleString()} more</button>
            {/if}
          </div>

          <aside class="fl-glyph-detail" aria-live="polite">
            {#if picked !== null}
              <div class="fl-big" style={`font-family:scan-${current.id}`}>{isBlank(picked) ? "␣" : glyphChar(picked)}</div>
              <p><strong>{codepointLabel(picked)}</strong><br /><small>{unicodeBlockOf(picked)}</small></p>
              <p class="small">Decimal {picked}<br />HTML &amp;#{picked};</p>
              <div class="fl-detail-actions">
                <button type="button" class="btn-hud" onclick={() => copy(String.fromCodePoint(picked!), "char")}>{copied === "char" ? "Copied" : "Copy character"}</button>
                <button type="button" class="btn-hud" onclick={() => copy(codepointLabel(picked!), "code")}>{copied === "code" ? "Copied" : "Copy code"}</button>
              </div>
            {:else}
              <p class="small text-secondary">Select a glyph to see its code point.</p>
            {/if}
          </aside>
        </div>
      {/if}
    </div>
    <footer class="fl-inspector-foot">
      <a class="btn-hud fl-foot-download" href={fileUrl(current)} download={current.filename}><i class="bi bi-download" aria-hidden="true"></i> Download {current.filename}</a>
      {#if editable(current)}
        <button class="btn-hud fl-danger" type="button" disabled={busy} onclick={() => remove([current.id])}>Remove font</button>
      {/if}
      <button class="btn-hud" type="button" onclick={closeInspector}>Close</button>
    </footer>
  {/if}
</dialog>

<style>
  .font-library { position: relative; display: grid; gap: 12px; }
  .fl-upload {
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; margin: 0;
    padding: 12px 14px; border: 1px dashed var(--hud-line); border-radius: 6px; background: var(--hud-bg-2);
  }
  .fl-upload-icon { font-size: 22px; color: var(--hud-teal-ink); }
  .fl-upload-copy { display: grid; flex: 1 1 200px; line-height: 1.3; }
  .fl-upload-copy small { color: var(--hud-muted); }
  .fl-upload .fl-field { flex-direction: row; align-items: center; gap: 6px; }
  .fl-upload select { width: auto; }

  .fl-tabs { display: flex; flex-wrap: wrap; gap: 2px; border-bottom: 1px solid var(--hud-line); }
  .fl-tabs button {
    background: transparent; color: var(--hud-muted); border: 0; border-bottom: 2px solid transparent;
    margin-bottom: -1px; padding: 6px 12px; font-size: 13px; cursor: pointer;
  }
  .fl-tabs button:hover { color: var(--hud-text); }
  .fl-tabs button.active { color: var(--hud-text); border-bottom-color: var(--hud-teal-ink); }
  .fl-tabs button.empty:not(.active) { opacity: .55; }
  .fl-tabs small, .fl-group-title small { color: var(--hud-muted); margin-left: 3px; font-variant-numeric: tabular-nums; }

  .fl-toolbar { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: end; }
  .fl-field { display: flex; flex-direction: column; gap: 3px; margin: 0; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--hud-muted); }
  .fl-field input, .fl-field select { text-transform: none; letter-spacing: normal; }
  .fl-search { flex: 0 1 220px; }
  .fl-grow { flex: 1 1 240px; }
  .fl-size { flex: 0 0 150px; }
  .fl-size input { width: 100%; }
  .fl-download { margin-left: auto; white-space: nowrap; text-decoration: none; }
  .fl-bulk-actions a, .fl-foot-download { text-decoration: none; }
  .fl-foot-download { margin-right: auto; }
  .fl-input-icon { position: relative; display: block; }
  .fl-input-icon i { position: absolute; left: 8px; top: 50%; transform: translateY(-50%); color: var(--hud-muted); pointer-events: none; font-size: 12px; }
  .fl-input-icon input { padding-left: 26px; }

  .fl-bulk {
    position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center;
    min-height: 40px; padding: 6px 10px; font-size: 13px;
    border: 1px solid var(--hud-line); border-radius: 6px; background: var(--hud-bg-2);
  }
  .fl-bulk.active { border-color: var(--hud-teal-ink); }
  .fl-bulk-count { color: var(--hud-teal-ink); font-weight: 600; }
  .fl-bulk-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-left: auto; }
  .fl-bulk-actions select { width: auto; }

  .fl-group { display: grid; gap: 8px; }
  .fl-group-title { font-size: 11px; text-transform: uppercase; letter-spacing: .1em; color: var(--hud-muted); margin: 6px 0 0; }
  .fl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; }
  .fl-card {
    display: grid; grid-template-rows: 1fr auto; min-width: 0; overflow: hidden;
    border: 1px solid var(--hud-line); border-radius: 6px; background: var(--hud-bg-2);
    transition: border-color .12s;
  }
  .fl-card:hover { border-color: color-mix(in srgb, var(--hud-teal-ink) 55%, var(--hud-line)); }
  .fl-card.selected { border-color: var(--hud-teal-ink); box-shadow: inset 0 0 0 1px var(--hud-teal-ink); }
  .fl-sample {
    display: flex; align-items: center; min-height: 96px; max-height: 180px; overflow: hidden;
    padding: 14px 14px 10px; border: 0; background: transparent; color: var(--hud-text);
    text-align: left; cursor: zoom-in;
  }
  .fl-sample span { line-height: 1.2; overflow-wrap: anywhere; }
  .fl-card-foot {
    display: flex; align-items: center; gap: 8px; padding: 7px 10px;
    border-top: 1px solid var(--hud-line); background: rgba(0, 0, 0, .15);
  }
  .fl-check { flex: none; }
  .fl-name { display: grid; min-width: 0; flex: 1; line-height: 1.25; }
  .fl-name strong, .fl-name small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fl-name strong { font-size: 13px; }
  .fl-name small { font-size: 11px; color: var(--hud-muted); }
  .fl-actions { display: flex; gap: 4px; align-items: center; flex: none; }
  .fl-actions select { width: auto; max-width: 110px; font-size: 12px; padding-block: 2px; }
  .fl-icon {
    display: grid; place-items: center; width: 28px; height: 28px; padding: 0;
    border: 1px solid transparent; border-radius: 4px; background: transparent; color: var(--hud-muted); cursor: pointer;
  }
  a.fl-icon { text-decoration: none; }
  .fl-icon:hover:not(:disabled) { color: var(--hud-text); border-color: var(--hud-line); background: var(--hud-bg); }
  .fl-icon.fl-danger:hover:not(:disabled) { color: var(--hud-danger); border-color: var(--hud-danger); }
  .fl-badge { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--hud-teal-ink); }
  .btn-hud.fl-danger { color: var(--hud-danger); border-color: var(--hud-danger); }
  .fl-ghost { border-color: transparent; }
  .fl-empty { display: grid; justify-items: center; gap: 8px; padding: 32px 16px; color: var(--hud-muted); border: 1px dashed var(--hud-line); border-radius: 6px; text-align: center; }
  .fl-empty i { font-size: 28px; }
  .fl-empty p { margin: 0; }
  .fl-drop {
    position: absolute; inset: 0; z-index: 5; display: grid; place-items: center; gap: 6px;
    border: 2px dashed var(--hud-teal-ink); border-radius: 8px; background: color-mix(in srgb, var(--hud-bg) 82%, transparent);
    color: var(--hud-text); font-size: 15px; pointer-events: none;
  }
  .fl-drop i { font-size: 32px; color: var(--hud-teal-ink); }
  @media (max-width: 560px) {
    .fl-search, .fl-size { flex: 1 1 100%; }
    .fl-grid { grid-template-columns: 1fr; }
  }

  .fl-inspector { width: min(960px, 94vw); max-height: 92vh; padding: 0; }
  .fl-inspector[open] { display: flex; flex-direction: column; }
  .fl-inspector-body { padding: 12px 16px; overflow: auto; display: grid; gap: 10px; }
  .fl-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 6px 16px; margin: 0; }
  .fl-facts div { min-width: 0; }
  .fl-facts .wide { grid-column: 1 / -1; }
  .fl-facts dt { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: var(--hud-muted); }
  .fl-facts dd { margin: 0; font-size: 13px; overflow-wrap: anywhere; }
  .fl-inspector-sample { font-size: 34px; line-height: 1.2; margin: 0; overflow-wrap: anywhere; }
  .fl-glyph-tools { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; }
  .fl-glyph-layout { display: grid; grid-template-columns: minmax(0, 1fr) 190px; gap: 12px; align-items: start; }
  .fl-glyph-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(46px, 1fr)); gap: 4px;
    max-height: 46vh; overflow: auto; padding: 2px;
  }
  .fl-glyph {
    aspect-ratio: 1; display: grid; place-items: center; font-size: 24px; line-height: 1; padding: 0;
    color: var(--hud-text); background: var(--hud-bg-2); border: 1px solid var(--hud-line); border-radius: 4px; cursor: pointer;
  }
  .fl-glyph:hover { border-color: var(--hud-teal-ink); }
  .fl-glyph.active { border-color: var(--hud-teal-ink); background: var(--hud-teal-dim); }
  .fl-glyph.blank small { font-size: 9px; color: var(--hud-muted); font-family: monospace; }
  .fl-more { grid-column: 1 / -1; }
  .fl-glyph-detail { position: sticky; top: 0; display: grid; gap: 6px; justify-items: center; text-align: center; border: 1px solid var(--hud-line); border-radius: 5px; padding: 10px; }
  .fl-big { font-size: 84px; line-height: 1.1; }
  .fl-detail-actions { display: grid; gap: 4px; width: 100%; }
  .fl-inspector-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--hud-line); }
  @media (max-width: 700px) { .fl-glyph-layout { grid-template-columns: 1fr; } }
</style>
