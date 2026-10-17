<script lang="ts">
	import { enhance } from '$app/forms';
	import { APP_NAME } from '$lib/brand';
	import WorkCredit from '$lib/components/WorkCredit.svelte';

	let { data, form } = $props();
	let newTitle = $state('');
	let newSeriesDialog: HTMLDialogElement;
	let newLang = $state('japanese');
	let newDirection = $state('rtl');
	let addingTestPages = $state(false);

	function addTestPagesEnhance() {
		addingTestPages = true;
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			addingTestPages = false;
		};
	}
</script>

<svelte:head>
	<title>Series · {APP_NAME}</title>
</svelte:head>

<div class="d-flex align-items-end justify-content-between mb-4">
	<div>
		<div class="hud-kicker">Library</div>
		<h2 class="mb-0">Series</h2>
		<a href="/settings">Shared font library</a>
		{#if data.canBackup}<span class="text-secondary"> · </span><a href="/backups">Series backups</a>{/if}
	</div>
	{#if data.canCreate}
		<div class="d-flex flex-column align-items-end gap-2">
			<button class="btn-hud-primary" type="button" onclick={() => newSeriesDialog.showModal()}>New series</button>
			<form method="POST" action="?/addTestPages" use:enhance={addTestPagesEnhance}>
				<button class="btn-hud" type="submit" disabled={addingTestPages}>
					{addingTestPages ? 'Adding test pages…' : 'Add Test Pages'}
				</button>
			</form>
		</div>
	{/if}
</div>

{#if data.canCreate}
	<dialog bind:this={newSeriesDialog} class="hud-card new-series-dialog">
		<form method="POST" action="?/create" enctype="multipart/form-data" use:enhance={() => async ({ result, update }) => {
			await update({ reset: false });
			if (result.type === 'success') newSeriesDialog.close();
		}}>
			<h2 class="h4">New series</h2>
			{#if form?.error}<div class="alert-hud" role="alert">{form.error}</div>{/if}
			<label>Name<input class="form-control" name="title" bind:value={newTitle} required /></label>
			<div class="new-series-pair">
				<label>Format<select class="form-control" name="pageMode" required><option value="pages">Pages · manga</option><option value="strip">Strip · webtoon</option></select></label>
				<label>Source language<select class="form-control" name="lang" bind:value={newLang} onchange={() => (newDirection = newLang === 'korean' ? 'ltr' : 'rtl')}><option value="japanese">Japanese</option><option value="korean">Korean</option></select></label>
			</div>
			<label>Reading direction<select class="form-control" name="direction" bind:value={newDirection}><option value="rtl">Right to left</option><option value="ltr">Left to right</option></select></label>
			<div class="new-series-pair">
				<label>Pre-credits image <small>(optional)</small><input class="form-control" name="pre" type="file" accept="image/png,image/jpeg,image/webp,image/gif" /></label>
				<label>Post-credits image <small>(optional)</small><input class="form-control" name="post" type="file" accept="image/png,image/jpeg,image/webp,image/gif" /></label>
			</div>
			<p class="small mb-0">Series credits appear in every chapter export. A chapter can use its own credits image.</p>
			<WorkCredit title={newTitle} />
			<div class="d-flex justify-content-end gap-2"><button class="btn-hud" type="button" onclick={() => newSeriesDialog.close()}>Cancel</button><button class="btn-hud-primary" type="submit">Create series</button></div>
		</form>
	</dialog>
{/if}

{#if form?.error}
	<div class="alert-hud mb-3">{form.error}</div>
{/if}

<style>
	.new-series-dialog { width: min(620px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; color: var(--text); }
	.new-series-dialog::backdrop { background: rgba(0, 0, 0, .7); }
	.new-series-dialog form { display: grid; gap: 14px; }
	.new-series-dialog label { display: grid; gap: 5px; }
	.new-series-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
	@media (max-width: 550px) { .new-series-pair { grid-template-columns: 1fr; } }
</style>
{#if form?.testPages}
	<div class="hud-card mb-3">
		{form.testPages.added
			? `Added ${form.testPages.added} test page${form.testPages.added === 1 ? '' : 's'} to ${form.testPages.title}.`
			: `Test pages are already in ${form.testPages.title}.`}
		<a href="/series/{form.testPages.seriesId}">Open series</a>
	</div>
{/if}

{#if data.series.length === 0}
	<div class="hud-card">No series yet. {data.canCreate ? 'Create one to start.' : 'Ask an admin or scanlator for access.'}</div>
{:else}
	<div class="row g-3">
		{#each data.series as s (s.id)}
			<div class="col-md-6 col-xl-4">
				<a href="/series/{s.id}" class="text-decoration-none">
					<div class="hud-card h-100">
						<div class="hud-kicker">{s.slug}</div>
						<h3 class="h5 mb-2">{s.title}</h3>
						<WorkCredit title={s.title} />
						<div class="status-pill">{data.counts[s.id] ?? 0} episodes</div>
					</div>
				</a>
			</div>
		{/each}
	</div>
{/if}
