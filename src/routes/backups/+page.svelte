<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { APP_NAME } from '$lib/brand';
  let { data, form } = $props();
  let busy = $state(false);
  let uploadMessage = $state('');
  let uploadError = $state('');
  const visible = $derived(data.backups.filter(backup => !data.filter || backup.seriesId === data.filter));
  function working() {
    uploadMessage = ''; uploadError = '';
    busy = true;
    return async ({ update }: { update: () => Promise<void> }) => {
      try { await update(); } finally { busy = false; }
    };
  }
  async function upload(file: FormDataEntryValue | null) {
    busy = true; uploadMessage = ''; uploadError = '';
    try {
      if (!(file instanceof File) || !file.size) throw new Error('Choose a series backup ZIP.');
      const response = await fetch('/api/series-backups/import', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: file });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Import failed');
      uploadMessage = `Imported “${result.backup.label}”. Select Restore when you are ready to use it.`;
      await invalidateAll();
    } catch (error) { uploadError = error instanceof Error ? error.message : 'Import failed'; }
    finally { busy = false; }
  }
  function size(bytes: number) { return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
</script>

<svelte:head><title>Series backups · {APP_NAME}</title></svelte:head>
<a class="hud-kicker text-decoration-none" href="/">← Library</a>
<h2 class="mb-2">Series backups</h2>
<p class="text-secondary">Keep a saved state before testing, then restore the complete series when you need it. Use backups within the same app version.</p>
{#if uploadError || form?.error}<div class="alert-hud mb-3" role="alert">{uploadError || form?.error}</div>{/if}
{#if uploadMessage || form?.message}<p class="hud-card" role="status">{uploadMessage || form?.message} {#if !uploadMessage && form?.restoredSeriesId}<a href="/series/{form.restoredSeriesId}">Open restored series</a>{/if}</p>{/if}
<section class="hud-card mb-3" aria-label="Import a series backup">
  <h3 class="h6">Import backup ZIP</h3>
  <form method="POST" action="?/import" enctype="multipart/form-data" use:enhance={({ formData, cancel }) => { cancel(); void upload(formData.get('backup')); }} class="d-flex flex-wrap gap-2 align-items-end">
    <label class="small">Backup file<input class="form-control" type="file" name="backup" accept=".zip,application/zip" required disabled={busy} /></label>
    <button type="submit" class="btn-hud" disabled={busy}>{busy ? 'Working…' : 'Import backup'}</button>
  </form>
</section>
<div class="d-flex justify-content-between align-items-center mb-2">
  <h3 class="h6 mb-0">Saved backups ({visible.length})</h3>
  {#if data.filter}<a href="/backups">Show every series</a>{/if}
</div>
<div class="d-grid gap-3">
  {#each visible as backup (backup.id)}
    <article class="hud-card" aria-label={backup.label}>
      <div class="d-flex flex-wrap justify-content-between gap-3 align-items-start">
        <div>
          <h3 class="h6 mb-1">{backup.label} {#if backup.safety}<span class="status-pill">Safety backup</span>{/if}</h3>
          <div>{backup.seriesTitle}</div>
          <p class="small text-secondary mb-0">{new Date(backup.createdAt).toLocaleString()} · {backup.chapters} chapters · {backup.pages} pages · {backup.regions} regions · {size(backup.bytes)}</p>
        </div>
        <div class="d-flex gap-2">
          <a class="btn-hud-ghost" href="/api/series-backups/{backup.id}" download>Download ZIP</a>
          <form method="POST" action="?/restore" use:enhance={({ cancel }) => {
            if (!confirm(`Restore “${backup.seriesTitle}” from “${backup.label}” (${new Date(backup.createdAt).toLocaleString()})?\n\nThis replaces its current chapters and edits with this backup. A safety backup of the current series will be saved first.`)) { cancel(); return; }
            return working();
          }}>
            <input type="hidden" name="backupId" value={backup.id} />
            <input type="hidden" name="confirmation" value="restore" />
            <button type="submit" class="btn-hud-danger" disabled={busy}>Restore</button>
          </form>
        </div>
      </div>
    </article>
  {:else}
    <p class="hud-card text-secondary">No backups yet. Open a series and choose “Back up series”, or import a saved ZIP.</p>
  {/each}
</div>
