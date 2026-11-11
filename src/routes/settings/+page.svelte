<script lang="ts">
  import { APP_NAME } from '$lib/brand';
  import FontLibrary from '$lib/components/FontLibrary.svelte';
  import PatternLibrary from '$lib/components/PatternLibrary.svelte';
  let { data, form } = $props();
</script>
<svelte:head>
  <title>Settings · {APP_NAME}</title>
</svelte:head>
<div class="settings-head">
  <a class="small" href="/">← Series</a>
  <h1>Settings</h1>
</div>
{#if form?.error}<p class="alert-hud">{form.error}</p>{/if}
{#if form?.message}<p role="status">{form.message}</p>{/if}
<section class="hud-card mb-3">
  <header class="mb-3">
    <div class="hud-kicker mb-1">Shared font library</div>
    <p class="small text-secondary mb-0">Fonts here are available to every series. Categories group the font pickers; click a sample to see every glyph in a font. Default face, size and style are set on each series page.</p>
  </header>
  <FontLibrary fonts={data.fonts} base="/settings/fonts" canManage={data.canManage} sharedLibrary uploadAction="?/upload" emptyText="No shared fonts yet." />
</section>
<section class="hud-card mb-3" id="patterns">
  <header class="mb-3">
    <div class="hud-kicker mb-1">Shared pattern library</div>
    <p class="small text-secondary mb-0">Screentones and other tiles for a text region's Pattern Overlay (Style → Layer style). Patterns are shared by every series and travel with PSD exports.</p>
  </header>
  <PatternLibrary patterns={data.patterns} canManage={data.canManage} />
</section>
<style>
  .settings-head { margin-bottom: 12px; }
  .settings-head h1 { margin: 2px 0 0; }
</style>
