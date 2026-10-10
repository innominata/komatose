<script lang="ts">
	import { enhance } from '$app/forms';
	import { APP_NAME } from '$lib/brand';
	import WorkCredit from '$lib/components/WorkCredit.svelte';

	let { data, form } = $props();
	let newTitle = $state('');
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
	</div>
	{#if data.canCreate}
		<div class="d-flex flex-column align-items-end gap-2">
			<form method="POST" action="?/create" use:enhance class="d-flex flex-column align-items-end gap-2">
				<div class="d-flex gap-2">
					<input class="form-control" name="title" placeholder="New series title" bind:value={newTitle} required />
					<button class="btn-hud-primary" type="submit">Add</button>
				</div>
				<WorkCredit title={newTitle} />
			</form>
			<form method="POST" action="?/addTestPages" use:enhance={addTestPagesEnhance}>
				<button class="btn-hud" type="submit" disabled={addingTestPages}>
					{addingTestPages ? 'Adding test pages…' : 'Add Test Pages'}
				</button>
			</form>
		</div>
	{/if}
</div>

{#if form?.error}
	<div class="alert-hud mb-3">{form.error}</div>
{/if}
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
