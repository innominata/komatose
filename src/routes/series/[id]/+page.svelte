<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { regionKindLabel } from '$lib/regionCatalog';
	import { APP_NAME } from '$lib/brand';
	import SeriesTypeDialog from '$lib/components/SeriesTypeDialog.svelte';
	import WorkCredit from '$lib/components/WorkCredit.svelte';
	import FontLibrary from '$lib/components/FontLibrary.svelte';
	import { FONT_CATEGORIES } from '$lib/fontCategories';

	let { data, form } = $props();
	let typeRevision = $state(data.typeRevision);

	function openTypeSettings() {
		document.querySelector<HTMLButtonElement>('[data-type-settings-trigger]')?.click();
	}

	$effect(() => {
		typeRevision = data.typeRevision;
	});

	async function saveTypeSettings(payload: {
		expectedRevision: number;
		style: import('$lib/workflow').TextStyle;
		styles: import('$lib/workflow').Preferences['styles'];
	}) {
		const res = await fetch(`/api/series/${data.series.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload)
		});
		const json = await res.json();
		if (!res.ok) throw new Error(json.error || 'Could not save type settings');
		typeRevision = json.revision;
		await invalidateAll();
		return { revision: json.revision };
	}

	async function uploadTypeFont(files: File[]) {
		const body = new FormData();
		for (const file of files) body.append('font', file);
		const res = await fetch(`/api/series/${data.series.id}`, { method: 'POST', body });
		const json = await res.json();
		if (!res.ok) throw new Error(json.error || 'Could not add font');
		await invalidateAll();
	}
	let editingNotes = $state(false);
	let editingGlossary = $state(false);
	let editingTitle = $state(false);
	let titleDraft = $state('');
	let renamingEpisodeId = $state<string | null>(null);
	let renamingTitle = $state('');
	function startRenameTitle() {
		titleDraft = data.series.title;
		editingTitle = true;
	}

	function startRenumber(ep: { id: string; title: string }) {
		renamingTitle = ep.title;
		renamingEpisodeId = ep.id;
	}

	function afterRename() {
		return async ({ result, update }: { result: { type: string }; update: (opts?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			if (result.type === 'success') editingTitle = false;
		};
	}

	function afterRenumber() {
		return async ({ result, update }: { result: { type: string }; update: (opts?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			if (result.type === 'success') renamingEpisodeId = null;
		};
	}
	const seriesGlossary = $derived(data.series.glossary ?? []);
	let glossaryDraft = $state(
		(data.series.glossary ?? []).length
			? (data.series.glossary ?? []).map((t) => `${t.source}\t${t.translation}`).join('\n')
			: ''
	);

	function glossaryJson(text: string) {
		const terms = text
			.split('\n')
			.map((line) => {
				const [source, ...rest] = line.split('\t');
				return { source: (source || '').trim(), translation: rest.join('\t').trim(), edited: true };
			})
			.filter((t) => t.source || t.translation);
		return JSON.stringify(terms);
	}
</script>

<svelte:head>
	<title>{data.series.title} · {APP_NAME}</title>
</svelte:head>

<div class="d-flex align-items-end justify-content-between mb-4 gap-3">
	<div>
		<a class="hud-kicker text-decoration-none" href="/">← Library</a>
		{#if data.canRename && editingTitle}
			<form method="POST" action="?/rename" use:enhance={afterRename} class="d-flex gap-2 align-items-center mt-1">
				<input class="form-control" name="title" bind:value={titleDraft} required />
				<button class="btn-hud" type="submit">Save</button>
				<button class="btn-hud-ghost" type="button" onclick={() => (editingTitle = false)}>Cancel</button>
			</form>
		{:else}
			<div class="d-flex align-items-center gap-2">
				<h2 class="mb-0">{data.series.title}</h2>
				{#if data.canRename}
					<button class="btn-hud-ghost" type="button" onclick={startRenameTitle}>Rename</button>
				{/if}
			</div>
		{/if}
		<WorkCredit title={data.series.title} />
	</div>
	{#if data.canUpload}
		<form method="POST" action="?/createEpisode" use:enhance class="d-flex gap-2">
			<input class="form-control" name="title" placeholder="Chapter number" required />
			<button class="btn-hud" type="submit">Add chapter</button>
		</form>
	{/if}
</div>

{#if form?.error}
	<div class="alert-hud mb-3">{form.error}</div>
{/if}

<div class="row g-3">
	<div class="col-lg-8">
		<div class="hud-card mb-3">
			<div class="hud-kicker mb-2">Chapters</div>
			{#if data.episodes.length === 0}
				<div class="text-secondary">No chapters yet.</div>
			{:else}
				<div class="d-grid gap-2">
					{#each data.episodes as ep, i (ep.id)}
						<div class="d-flex justify-content-between align-items-center border-bottom border-secondary-subtle py-2 gap-2">
							{#if data.canEdit}
								<div class="d-flex flex-column gap-1">
									<form method="POST" action="?/moveEpisode" use:enhance>
										<input type="hidden" name="episodeId" value={ep.id} />
										<input type="hidden" name="dir" value="up" />
										<button class="btn-hud-ghost py-0 px-2" type="submit" disabled={i === 0} aria-label="Move up">↑</button>
									</form>
									<form method="POST" action="?/moveEpisode" use:enhance>
										<input type="hidden" name="episodeId" value={ep.id} />
										<input type="hidden" name="dir" value="down" />
										<button class="btn-hud-ghost py-0 px-2" type="submit" disabled={i === data.episodes.length - 1} aria-label="Move down">↓</button>
									</form>
								</div>
							{/if}
							{#if data.canEdit && renamingEpisodeId === ep.id}
								<form method="POST" action="?/renameEpisode" use:enhance={afterRenumber} class="d-flex gap-2 align-items-center flex-grow-1">
									<input type="hidden" name="episodeId" value={ep.id} />
									<input class="form-control" name="title" bind:value={renamingTitle} required />
									<button class="btn-hud" type="submit">Save</button>
									<button class="btn-hud-ghost" type="button" onclick={() => (renamingEpisodeId = null)}>Cancel</button>
								</form>
							{:else}
								<a href="/series/{data.series.id}/episodes/{ep.id}" class="text-decoration-none flex-grow-1">
									<strong>{ep.title}</strong>
									<div class="hud-kicker mb-0">{ep.slug}</div>
								</a>
								{#if data.canEdit}
									<button class="btn-hud-ghost" type="button" onclick={() => startRenumber(ep)}>Renumber</button>
								{/if}
								{#if data.canUpload}
									<form method="POST" action="?/duplicateEpisode" use:enhance>
										<input type="hidden" name="episodeId" value={ep.id} />
										<button class="btn-hud-ghost" type="submit">Duplicate</button>
									</form>
									<form method="POST" action="?/deleteEpisode" use:enhance onsubmit={(e) => {
										if (!confirm(`Delete chapter ${ep.title}? This cannot be undone.`)) e.preventDefault();
									}}>
										<input type="hidden" name="episodeId" value={ep.id} />
										<button class="btn-hud-danger" type="submit">Delete</button>
									</form>
								{/if}
							{/if}
							<span class="status-pill on">{ep.status}</span>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
	<div class="col-lg-4">
		<div class="hud-card mb-3">
			<div class="d-flex justify-content-between">
				<div class="hud-kicker">General notes</div>
				<button class="btn-hud-ghost" type="button" onclick={() => (editingNotes = !editingNotes)}>
					{editingNotes ? 'Close' : 'Edit'}
				</button>
			</div>
			{#if editingNotes}
				<form method="POST" action="?/notes" use:enhance class="mt-2">
					<textarea class="form-control mb-2" name="notes" rows="8">{data.series.notes}</textarea>
					<button class="btn-hud" type="submit">Save notes</button>
				</form>
			{:else}
				<div class="mt-2 small">{@html data.notesHtml || '<span class="text-secondary">No notes.</span>'}</div>
			{/if}
		</div>
		<div class="hud-card mb-3">
			<div class="d-flex justify-content-between">
				<div class="hud-kicker">Names & terms</div>
				{#if data.canEditStickies}
					<button class="btn-hud-ghost" type="button" onclick={() => (editingGlossary = !editingGlossary)}>
						{editingGlossary ? 'Close' : 'Edit'}
					</button>
				{/if}
			</div>
			<p class="hud-kicker mb-0 mt-1">One term per line: source, then a tab, then English.</p>
			{#if editingGlossary}
				<form method="POST" action="?/glossary" use:enhance class="mt-2">
					<input type="hidden" name="glossary" value={glossaryJson(glossaryDraft)} />
					<textarea class="form-control mb-2" rows="8" bind:value={glossaryDraft} placeholder="사쿠타	Sakuta"></textarea>
					<button class="btn-hud" type="submit">Save terms</button>
				</form>
			{:else if seriesGlossary.length}
				<div class="mt-2 small d-grid gap-1">
					{#each seriesGlossary as term}
						<div><span class="text-secondary">{term.source}</span> → {term.translation}</div>
					{/each}
				</div>
			{:else}
				<div class="mt-2 small text-secondary">No locked names yet.</div>
			{/if}
		</div>
		<div class="hud-card">
			<div class="hud-kicker mb-2">Members</div>
			{#if data.canAdmin}
				<div class="text-secondary small mb-2">Assign access in Users.</div>
			{/if}
			{#each data.members as m (m.id)}
				<div class="d-flex justify-content-between">
					<span>{m.username}</span>
					<span class="hud-kicker mb-0">{m.role}</span>
				</div>
			{:else}
				<div class="text-secondary small">No explicit members (admins still have access).</div>
			{/each}
		</div>
	</div>
</div>

<div class="hud-card mt-3" id="type">
	<div class="d-flex justify-content-between align-items-start gap-3">
		<div>
			<div class="hud-kicker mb-2">Fonts &amp; type</div>
			<p class="small text-secondary mb-0">
				Upload faces here or from the type settings window. Use the
				<a href="/settings">shared library</a> for fonts every series can see.
			</p>
		</div>
		<SeriesTypeDialog
			triggerLabel="Type Settings…"
			triggerClass="btn-hud"
			fonts={data.fonts}
			seriesId={data.series.id}
			revision={typeRevision}
			prefs={{ style: data.typeStyle, styles: data.typeStyles, regionKinds: data.regionKinds }}
			canManage={data.canManageType}
			onsave={saveTypeSettings}
			onupload={data.canManageType ? uploadTypeFont : undefined}
		/>
	</div>
	{#if form?.message}<p class="small" role="status">{form.message}</p>{/if}
	{#if data.canManageType}
		<form method="POST" action="?/uploadFont" enctype="multipart/form-data" use:enhance class="d-flex flex-wrap gap-2 align-items-end my-3">
			<label class="small mb-0">Upload TTF or OTF <input class="form-control" name="font" type="file" accept=".ttf,.otf" multiple required /></label>
			<label class="small mb-0">Category
				<select class="form-select" name="category">
					{#each FONT_CATEGORIES as c}<option value={c.id} selected={c.id === 'lettering'}>{c.label}</option>{/each}
				</select>
			</label>
			<button class="btn-hud" type="submit">Add fonts</button>
		</form>
	{/if}
	<FontLibrary
		fonts={data.fonts}
		base={`/series/${data.series.id}/fonts`}
		canManage={data.canManageType}
		emptyText="No fonts yet. Upload one or add shared fonts in Settings."
	/>
	<h3 class="h6 mt-4">Type defaults</h3>
	<p class="small text-secondary">Each text type has its own face, size, and style. Open Type Settings to edit them.</p>
	<div class="type-summary">
		{#each Object.keys(data.typeStyles) as type}
			<button class="type-summary-item" type="button" onclick={openTypeSettings}>
				<strong>{regionKindLabel(type, data.regionKinds)}</strong>
				<small>{data.typeStyles[type]?.size ?? 10} pt</small>
			</button>
		{/each}
	</div>
</div>


<style>
	#type {
		scroll-margin-top: 4rem;
	}
	.type-summary {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr));
		gap: 0.45rem;
	}
	.type-summary-item {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 0.5rem;
		padding: 0.45rem 0.6rem;
		border: 1px solid rgba(45, 226, 197, 0.2);
		background: rgba(0, 0, 0, 0.18);
		color: inherit;
		text-align: left;
	}
	.type-summary-item small {
		color: var(--hud-muted);
	}
</style>
