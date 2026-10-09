<script lang="ts">
  import { onMount } from 'svelte';
  import { EXPORT_DOCUMENTS, type ExportDocument, type ExportDocumentId } from '$lib/exportDocuments';

  let { seriesId, episodeId }: { seriesId: string; episodeId: string } = $props();
  let chapters = $state<{ id: string; title: string }[]>([]);
  let files = $state<{ id: ExportDocumentId; label: string }[]>([...EXPORT_DOCUMENTS]);
  let selected = $state<string[]>([]);
  let file = $state<ExportDocumentId>('bilingual.txt');
  let includeSceneNotes = $state(true);
  let document = $state<ExportDocument | null>(null);
  let loading = $state(false);
  let error = $state('');
  let copied = $state(false);
  let selectText = $state(false);
  let viewer: HTMLTextAreaElement;
  let controller: AbortController | undefined;
  let generation = 0;
  const isScript = $derived(file === 'bilingual.txt' || file === 'english.txt');
  const endpoint = $derived(`/api/series/${encodeURIComponent(seriesId)}/export-documents`);

  async function responseJson(response: Response) {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }
  async function load() {
    const current = ++generation;
    controller?.abort();
    copied = false;
    selectText = false;
    error = '';
    document = null;
    if (!selected.length) { loading = false; return; }
    controller = new AbortController();
    loading = true;
    try {
      const data = await responseJson(await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ episodeIds: selected, file, includeSceneNotes }), signal: controller.signal,
      }));
      if (current === generation) document = data.document;
    } catch (e) {
      if (current === generation && !(e instanceof Error && e.name === 'AbortError')) error = e instanceof Error ? e.message : String(e);
    } finally {
      if (current === generation) loading = false;
    }
  }
  function toggle(id: string, checked: boolean) {
    selected = checked ? [...selected, id] : selected.filter(value => value !== id);
    void load();
  }
  async function copy() {
    if (!document) return;
    const source = document;
    try {
      await navigator.clipboard.writeText(source.text);
      if (document === source) copied = true;
    } catch {
      if (document !== source) return;
      viewer?.focus();
      viewer?.select();
      selectText = true;
    }
  }
  function download() {
    if (!document) return;
    const url = URL.createObjectURL(new Blob([document.text], { type: `${document.mime};charset=utf-8` }));
    const link = window.document.createElement('a');
    link.href = url;
    link.download = document.filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  onMount(() => {
    let mounted = true;
    const initial = new AbortController();
    loading = true;
    void fetch(endpoint, { signal: initial.signal }).then(responseJson).then(data => {
      if (!mounted) return;
      chapters = data.chapters;
      files = data.files;
      selected = [episodeId];
      void load();
    }).catch(e => {
      if (mounted) { loading = false; error = e instanceof Error ? e.message : String(e); }
    });
    return () => { mounted = false; generation++; initial.abort(); controller?.abort(); };
  });
</script>

<section class="documents" data-find="export-documents" aria-label="Scripts and metadata">
  <header>
    <div><h3><i class="bi bi-file-earmark-text" aria-hidden="true"></i> Scripts &amp; metadata</h3>
      <p>Read, copy, or download saved text. Select several chapters for one proofreading script.</p></div>
    <button type="button" disabled={loading || !selected.length} onclick={() => load()} title="Reload the latest saved content"><i class="bi bi-arrow-clockwise" aria-hidden="true"></i> Refresh</button>
  </header>
  <div class="document-controls">
    <label>File<select value={file} onchange={e => { file = e.currentTarget.value as ExportDocumentId; void load(); }} disabled={!chapters.length}>
      {#each files as option (option.id)}<option value={option.id}>{option.label}</option>{/each}
    </select></label>
    <label class="check"><input type="checkbox" checked={includeSceneNotes} onchange={e => { includeSceneNotes = e.currentTarget.checked; void load(); }} disabled={!isScript || !chapters.length} /> Include scene notes</label>
    <button type="button" disabled={!document || loading} onclick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    <button type="button" disabled={!document || loading} onclick={download}>Download file</button>
  </div>
  <details>
    <summary>Chapters ({selected.length} selected)</summary>
    <div class="chapter-actions">
      <button type="button" disabled={!chapters.length} onclick={() => { selected = [episodeId]; void load(); }}>Current chapter</button>
      <button type="button" disabled={!chapters.length} onclick={() => { selected = chapters.map(chapter => chapter.id); void load(); }}>All chapters</button>
    </div>
    <div class="chapter-list">
      {#each chapters as chapter (chapter.id)}
        <label class="check"><input type="checkbox" checked={selected.includes(chapter.id)} onchange={e => toggle(chapter.id, e.currentTarget.checked)} />{chapter.title}</label>
      {/each}
    </div>
  </details>
  {#if error}<p role="alert" class="error">{error}</p>{/if}
  {#if selectText}<p role="status">Text selected. Press Ctrl+C (or ⌘C) to copy.</p>{/if}
  <div class="file-status" role="status">
    {#if loading}Loading saved content…{:else if document}{document.filename} · {selected.length} chapter{selected.length === 1 ? '' : 's'} · {document.text.length.toLocaleString()} characters{:else if !selected.length}Select a chapter to view its files.{/if}
  </div>
  <textarea bind:this={viewer} readonly value={document?.text ?? ''} aria-label="Metadata file contents" aria-busy={loading} spellcheck="false" wrap="soft"></textarea>
</section>

<style>
  .documents { grid-column: 1 / -1; display: grid; gap: 12px; border: 1px solid var(--hud-line); border-radius: 8px; padding: 16px; background: #141922; }
  header { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
  h3 { margin: 0 0 6px; font: 700 16px Rajdhani, sans-serif; }
  p { margin: 0; color: var(--hud-muted); }
  .document-controls, .chapter-actions { display: flex; flex-wrap: wrap; align-items: end; gap: 10px; }
  label { display: grid; gap: 4px; margin: 0; }
  label.check { display: flex; align-items: center; gap: 6px; padding: 6px 0; }
  select { min-width: 180px; }
  details { border-top: 1px solid var(--hud-line); padding-top: 10px; }
  summary { cursor: pointer; }
  .chapter-actions { margin-top: 8px; }
  .chapter-list { max-height: 200px; overflow: auto; display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0 16px; margin-top: 8px; }
  .file-status { color: var(--hud-muted); font-size: 12px; }
  textarea { width: 100%; min-height: 420px; height: 55vh; resize: vertical; box-sizing: border-box; padding: 14px; background: var(--hud-bg); color: var(--hud-text); border: 1px solid var(--hud-line); border-radius: 4px; font: 13px/1.6 ui-monospace, monospace; }
  .error { color: #ff5d73; }
</style>
