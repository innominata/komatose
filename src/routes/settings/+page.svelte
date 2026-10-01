<script lang="ts">
  import { enhance } from '$app/forms';
  import { APP_NAME } from '$lib/brand';
  import FontLibrary from '$lib/components/FontLibrary.svelte';
  import { FONT_CATEGORIES } from '$lib/fontCategories';
  let { data, form } = $props();
</script>
<svelte:head>
  <title>Settings · {APP_NAME}</title>
</svelte:head>
<a href="/">← Series</a>
<h1>Settings</h1>
<p>Shared fonts are available to every series. Default face, size, and style are set on each series page.</p>
{#if form?.error}<p class="alert-hud">{form.error}</p>{/if}
{#if form?.message}<p role="status">{form.message}</p>{/if}
<section class="hud-card mb-3">
  <h2>Shared font library</h2>
  <p class="small text-secondary">Categories group the font pickers: Lettering, Sfx, Overtext, System, Handwriting and Other. Inspect a font to see every glyph it contains.</p>
  {#if data.canManage}<form method="POST" action="?/upload" enctype="multipart/form-data" use:enhance class="d-flex flex-wrap gap-2 align-items-end mb-3">
    <label>Upload TTF or OTF <input name="font" type="file" accept=".ttf,.otf" multiple required /></label>
    <label>Category
      <select name="category" class="form-select form-select-sm">
        {#each FONT_CATEGORIES as c}<option value={c.id} selected={c.id === 'lettering'}>{c.label}</option>{/each}
      </select>
    </label>
    <button class="btn-hud">Upload fonts</button>
  </form>{/if}
  <FontLibrary fonts={data.fonts} base="/settings/fonts" canManage={data.canManage} sharedLibrary emptyText="No shared fonts yet." />
</section>
