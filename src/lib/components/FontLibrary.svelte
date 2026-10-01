<script lang="ts">
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
  }: {
    fonts: FontAsset[];
    base: string;
    canManage?: boolean;
    /** True when this list is the shared library itself, so its fonts are editable here. */
    sharedLibrary?: boolean;
    emptyText?: string;
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

<div class="font-library">
  {#if error}<p class="alert-hud" role="alert">{error}</p>{/if}
  {#if notice}<p class="small" role="status">{notice}</p>{/if}

  <div class="fl-toolbar">
    <div class="fl-tabs" role="tablist" aria-label="Font categories">
      <button type="button" role="tab" aria-selected={filter === "all"} class:active={filter === "all"} onclick={() => (filter = "all")}
        >All <small>{fonts.length}</small></button
      >
      {#each FONT_CATEGORIES as c}
        <button type="button" role="tab" aria-selected={filter === c.id} class:active={filter === c.id} onclick={() => (filter = c.id)}
          >{c.label} <small>{counts[c.id]}</small></button
        >
      {/each}
    </div>
    <label class="small mb-0">Search <input class="form-control form-control-sm" placeholder="Name or file" bind:value={search} /></label>
    <label class="small mb-0 fl-preview-input">Preview text <input class="form-control form-control-sm" bind:value={preview} /></label>
  </div>

  {#if canManage && selectable.length}
    <div class="fl-bulk" aria-label="Bulk actions">
      <label class="small mb-0"><input type="checkbox" checked={allChosen} onchange={toggleAll} /> Select all shown</label>
      {#if chosen.length}
        <span class="small">{chosen.length} selected</span>
        <select class="form-select form-select-sm" aria-label="Category for selected fonts" bind:value={bulkCategory}>
          {#each FONT_CATEGORIES as c}<option value={c.id}>{c.label}</option>{/each}
        </select>
        <button class="btn-hud" type="button" disabled={busy} onclick={() => setCategory(chosen, bulkCategory)}>Set category</button>
        <button class="btn-hud fl-danger" type="button" disabled={busy} onclick={() => remove(chosen)}>Remove selected</button>
      {/if}
    </div>
  {/if}

  {#each groups as group (group.id)}
    <section class="fl-group" aria-label={group.label}>
      <h3 class="fl-group-title">{group.label} <small>{group.fonts.length}</small></h3>
      {#each group.fonts as font (font.id)}
        <article class="fl-row">
          <div class="fl-meta">
            {#if editable(font)}
              <input type="checkbox" aria-label={`Select ${font.familyName} ${font.subfamilyName}`} checked={selected.includes(font.id)} onchange={() => toggle(font.id)} />
            {/if}
            <div>
              <strong>{font.familyName} · {font.subfamilyName}</strong>
              {#if font.shared && !sharedLibrary}<span class="fl-badge">Shared</span>{/if}
              <br /><small>{font.filename} · {font.postscriptName} · {font.format}</small>
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
              <button class="btn-hud" type="button" onclick={() => inspect(font)}>Inspect</button>
              {#if editable(font)}
                <button class="btn-hud fl-danger" type="button" disabled={busy} onclick={() => remove([font.id])}>Remove</button>
              {/if}
            </div>
          </div>
          <p class="fl-sample" style={`font-family:scan-${font.id}`}>{preview}</p>
        </article>
      {/each}
    </section>
  {:else}
    <p class="small text-secondary">{fonts.length ? "No fonts match this filter." : emptyText}</p>
  {/each}
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
      {#if editable(current)}
        <button class="btn-hud fl-danger" type="button" disabled={busy} onclick={() => remove([current.id])}>Remove font</button>
      {/if}
      <button class="btn-hud" type="button" onclick={closeInspector}>Close</button>
    </footer>
  {/if}
</dialog>

<style>
  .font-library { display: grid; gap: 10px; }
  .fl-toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; }
  .fl-tabs { display: flex; flex-wrap: wrap; gap: 4px; }
  .fl-tabs button {
    background: transparent; color: var(--hud-muted); border: 1px solid var(--hud-line);
    border-radius: 4px; padding: 3px 9px; font-size: 12px; cursor: pointer;
  }
  .fl-tabs button.active { color: var(--hud-text); border-color: var(--hud-teal); background: var(--hud-teal-dim); }
  .fl-tabs small, .fl-group-title small { color: var(--hud-muted); margin-left: 2px; }
  .fl-preview-input { flex: 1 1 220px; }
  .fl-bulk { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 6px 8px; border: 1px solid var(--hud-line); border-radius: 5px; background: var(--hud-bg-2); }
  .fl-bulk select { width: auto; }
  .fl-group-title { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--hud-muted); margin: 8px 0 2px; }
  .fl-row { border-bottom: 1px solid var(--hud-line); padding: 6px 0; }
  .fl-meta { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .fl-meta > div:nth-child(2), .fl-meta > div:first-child:not(.fl-actions) { min-width: 0; }
  .fl-actions { margin-left: auto; display: flex; gap: 6px; align-items: center; }
  .fl-actions select { width: auto; }
  .fl-badge { font-size: 10px; text-transform: uppercase; border: 1px solid var(--hud-line); border-radius: 3px; padding: 0 4px; margin-left: 6px; color: var(--hud-muted); }
  .fl-sample { margin: 4px 0 0; font-size: 24px; line-height: 1.25; overflow-wrap: anywhere; }
  .fl-danger { color: var(--hud-danger); border-color: var(--hud-danger); }

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
  .fl-glyph:hover { border-color: var(--hud-teal); }
  .fl-glyph.active { border-color: var(--hud-teal); background: var(--hud-teal-dim); }
  .fl-glyph.blank small { font-size: 9px; color: var(--hud-muted); font-family: monospace; }
  .fl-more { grid-column: 1 / -1; }
  .fl-glyph-detail { position: sticky; top: 0; display: grid; gap: 6px; justify-items: center; text-align: center; border: 1px solid var(--hud-line); border-radius: 5px; padding: 10px; }
  .fl-big { font-size: 84px; line-height: 1.1; }
  .fl-detail-actions { display: grid; gap: 4px; width: 100%; }
  .fl-inspector-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--hud-line); }
  @media (max-width: 700px) { .fl-glyph-layout { grid-template-columns: 1fr; } }
</style>
