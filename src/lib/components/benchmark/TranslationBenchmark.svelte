<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { goldTranslationLines } from '$lib/benchmarkGold';
	import { nextSort, sortedBy, type SortDir, type SortState } from '$lib/benchmarkSort';
	import { attachedReview, medianMs, reviewLetter, type BenchmarkStatus, type TranslationResult } from '$lib/modelBenchmark';
	import { formatDuration } from '$lib/modelEstimate';
	import PageOverlay from './PageOverlay.svelte';
	import SortHead from './SortHead.svelte';

	let { status, busy, post }: {
		status: BenchmarkStatus;
		busy: boolean;
		post: (body: Record<string, unknown>) => Promise<void>;
	} = $props();

	const run = $derived(status.runs.translation);
	const running = $derived(status.running === 'translation' && status.runningDataset === status.dataset.id);
	const blocked = $derived(Boolean(status.running) || busy || !status.available);
	let models = $state<string[]>(untrack(() => status.translationModels.filter((model) => model.local).map((model) => model.id)));
	const billed = $derived(status.translationModels.filter((model) => models.includes(model.id) && model.billed).length);
	const reviewing = $derived(status.running === 'review' && status.runningDataset === status.dataset.id);
	let reviewer = $state('');
	const reviewerId = $derived(status.reviewModels.some((model) => model.id === reviewer) ? reviewer : status.reviewModels[0]?.id || '');
	const reviewerRow = $derived(status.reviewModels.find((model) => model.id === reviewerId));
	let reviewTargets = $state<string[]>(untrack(() => (status.runs.translation?.models || []).filter((model) => model.pages.some((page) => page.lines.length)).map((model) => model.id)));
	let reviewTouched = $state(false);
	const savedModels = $derived((run?.models || []).filter((model) => model.pages.some((page) => page.lines.length)));
	$effect(() => {
		const ids = savedModels.map((model) => model.id);
		if (reviewTouched || reviewTargets.length || !ids.length) return;
		reviewTargets = ids;
	});

	const PAGES = $derived(status.dataset.pages.filter((page) => goldTranslationLines(page).length));
	const lineCount = $derived(PAGES.reduce((sum, page) => sum + goldTranslationLines(page).length, 0));

	function toggleReview(id: string) {
		reviewTouched = true;
		reviewTargets = reviewTargets.includes(id) ? reviewTargets.filter((item) => item !== id) : [...reviewTargets, id];
	}
	function gradeText(row: TranslationResult) {
		const review = attachedReview(row);
		if (!review?.totals.graded) return '';
		const mark = `${reviewLetter(review.totals.comparable)} ${Math.round(review.totals.comparable * 100)}`;
		return review.totals.graded < review.totals.lines ? `${mark} · ${review.totals.graded}/${review.totals.lines}` : mark;
	}
	let gradeDialog = $state<HTMLDialogElement | null>(null);
	let gradeOpen = $state<TranslationResult | null>(null);
	const openReview = $derived(gradeOpen ? attachedReview(gradeOpen) : undefined);
	async function openGrade(event: MouseEvent, row: TranslationResult) {
		event.stopPropagation();
		gradeOpen = row;
		await tick();
		if (!gradeDialog?.open) gradeDialog?.showModal();
	}
	function toggle(id: string) {
		models = models.includes(id) ? models.filter((item) => item !== id) : [...models, id];
	}
	function score(value: number | undefined) {
		return value == null || !Number.isFinite(value) ? '—' : (value * 100).toFixed(1);
	}
	function tone(value: number, good: number, fair: number) {
		return value >= good ? 'tone-ok' : value >= fair ? 'tone-warn' : 'tone-bad';
	}

	type TrKey = 'name' | 'official' | 'literal' | 'meaning' | 'grade' | 'missing' | 'time';
	let sort = $state<SortState<TrKey>>({ key: 'official', dir: 'desc' });
	function ready(row: { pages: unknown[] }, value: number) {
		return row.pages.length ? value : Number.NaN;
	}
	function trValue(row: TranslationResult, key: TrKey): string | number {
		if (key === 'name') return row.name;
		if (key === 'official') return ready(row, row.totals.official);
		if (key === 'literal') return ready(row, row.totals.literal);
		if (key === 'meaning') return ready(row, row.totals.meaning);
		if (key === 'grade') {
			const review = attachedReview(row);
			return review?.totals.graded ? review.totals.comparable : Number.NaN;
		}
		if (key === 'missing') return ready(row, row.totals.missing);
		return ready(row, medianMs(row.pages));
	}
	const rows = $derived(sortedBy(run?.models || [], sort, trValue));
	function sortBy(key: string, prefer: SortDir) {
		sort = nextSort(sort, key as TrKey, prefer);
	}
	let modelView = $state('');
	let pageId = $state(untrack(() => status.dataset.lang === 'japanese' ? '009' : status.dataset.pages.find(page => goldTranslationLines(page).length)!.id));
	const page = $derived(status.dataset.pages.find((item) => item.id === pageId)!);
	const shown = $derived(run?.models.find((item) => item.id === modelView) || rows[0]);
	const shownPage = $derived(shown?.pages.find((item) => item.page === pageId));
	const lines = $derived(goldTranslationLines(page));
	let hover = $state('');
</script>

<div class="card stack">
	<div>
		<div class="kicker">Translation models</div>
		{#if !status.translationModels.length}
			<p class="muted small">No visible translation models for {status.dataset.lang === 'korean' ? 'Korean' : 'Japanese'}. Show a row in pickers or install a translation model.</p>
		{:else}
			<div class="pick-list models">
				{#each status.translationModels as model (model.id)}
					<label class="pick">
						<input type="checkbox" checked={models.includes(model.id)} onchange={() => toggle(model.id)} />
						<span class="grow">{model.name}</span>
						{#if model.billed}<span class="chip warn">billed</span>{/if}
					</label>
				{/each}
			</div>
		{/if}
	</div>
	<div class="spread">
		<div class="row">
			<button class="btn {running ? 'busy' : ''}" disabled={blocked || !models.length}
				onclick={() => void post({ kind: 'translation', models })}>
				{#if running}<span class="test-spin" aria-hidden="true"></span> Running…{:else}<i class="bi bi-play"></i> Run translation benchmark{/if}
			</button>
			<button class="btn ghost" disabled={blocked} onclick={() => (models = status.translationModels.map((model) => model.id))}>Select all</button>
			<button class="btn ghost" disabled={blocked} onclick={() => (models = [])}>Select none</button>
			{#if running}<button class="btn danger" onclick={() => void post({ action: 'cancel' })}>Cancel</button>{/if}
		</div>
		<span class="muted small">{PAGES.length} pages · {lineCount} lines · one request per page per model{#if billed} · {billed} billed {billed === 1 ? 'model' : 'models'}{/if}</span>
	</div>
	{#if status.running === 'ocr'}<p class="muted small">The OCR benchmark is running; one benchmark runs at a time.</p>{/if}
	{#if run?.state === 'running'}
		<div>
			<div class="progress"><span style="width:{run.progress.total ? (run.progress.done / run.progress.total) * 100 : 0}%"></span></div>
			<div class="muted small" style="margin-top:.3rem">{run.progress.done} / {run.progress.total} · {run.progress.step}</div>
		</div>
	{/if}
	{#if run && run.state !== 'running'}
		<p class="muted small">
			Last run {new Date(run.at).toLocaleString()}{#if run.finishedAt} · took {formatDuration(run.finishedAt - run.at)}{/if}
			· earlier results stay listed until you benchmark that model again
			{#if run.state === 'cancelled'} · <span class="tone-warn">cancelled</span>{/if}
			{#if run.state === 'error'} · <span class="tone-bad">{run.error}</span>{/if}
		</p>
	{/if}
</div>

<div class="card stack">
	<div>
		<div class="kicker">Meaning review</div>
		<p class="muted small">A chat model reads each saved translation next to the source and the reference, and grades how close the meaning is. Different wording that keeps the same facts, names, and intent scores well. Every page of a saved translation goes in one request.</p>
	</div>
	{#if !status.reviewModels.length}
		<p class="muted small">No model has a passing Conversation check. Run that check under Admin → Models → Jobs.</p>
	{:else}
		<label>
			Reviewer
			<select aria-label="Review model" value={reviewerId} onchange={(event) => (reviewer = event.currentTarget.value)}>
				{#each status.reviewModels as model (model.id)}
					<option value={model.id}>{model.name}{model.billed ? ' (billed)' : ''}</option>
				{/each}
			</select>
		</label>
		{#if !savedModels.length}
			<p class="muted small">{run?.models.length ? 'These saved results have no line text to grade.' : 'No saved translations for this dataset yet.'}</p>
		{:else}
			<div class="pick-list models">
				{#each savedModels as model (model.id)}
					<label class="pick">
						<input type="checkbox" aria-label="Grade {model.name}" checked={reviewTargets.includes(model.id)} onchange={() => toggleReview(model.id)} />
						<span class="grow">{model.name}</span>
					</label>
				{/each}
			</div>
			<div class="row">
				<button class="btn {reviewing ? 'busy' : ''}" disabled={blocked || !reviewerId || !reviewTargets.length}
					onclick={() => void post({ kind: 'review', reviewer: reviewerId, models: reviewTargets })}>
					{#if reviewing}<span class="test-spin" aria-hidden="true"></span> Grading…{:else}<i class="bi bi-check2-square"></i> Grade saved translations{/if}
				</button>
				{#if reviewing}<button class="btn danger" onclick={() => void post({ action: 'cancel' })}>Cancel</button>{/if}
				{#if reviewerRow?.billed}<span class="muted small">One billed request per saved translation.</span>{/if}
			</div>
		{/if}
	{/if}
	{#if status.review?.state === 'running'}
		<div>
			<div class="progress"><span style="width:{status.review.progress.total ? (status.review.progress.done / status.review.progress.total) * 100 : 0}%"></span></div>
			<div class="muted small" style="margin-top:.3rem">{status.review.progress.done} / {status.review.progress.total} · {status.review.progress.step}</div>
		</div>
	{:else if status.review}
		<p class="muted small">
			{status.review.state === 'done' ? 'Graded' : status.review.state === 'cancelled' ? 'Grading cancelled' : 'Grading failed'}
			with {status.review.reviewerName}{#if status.review.finishedAt} · {new Date(status.review.finishedAt).toLocaleString()}{/if}
			{#if status.review.error} · <span class="tone-bad">{status.review.error}</span>{/if}
		</p>
	{/if}
</div>

<div class="section">
	<div class="section-head">
		<h3>Scores</h3>
		<span class="muted small">chrF: character n-gram overlap, 0–100. Meaning: key terms each line must carry. Grade: a chat model's judgement that the English means the same thing, even when the words differ. Click a grade to read the written assessment.</span>
	</div>
	<table class="mtable" aria-label="Translation results">
		<thead><tr>
			<SortHead label="Model" col="name" sortKey={sort.key} dir={sort.dir} prefer="asc" onsort={sortBy} />
			<SortHead label={`chrF · ${status.dataset.referenceLabel}`} col="official" sortKey={sort.key} dir={sort.dir} onsort={sortBy} />
			<SortHead label="chrF · literal" col="literal" sortKey={sort.key} dir={sort.dir} onsort={sortBy} />
			<SortHead label="Meaning" col="meaning" sortKey={sort.key} dir={sort.dir} onsort={sortBy} />
			<SortHead label="Grade" col="grade" sortKey={sort.key} dir={sort.dir} onsort={sortBy} />
			<SortHead label="Missing" col="missing" sortKey={sort.key} dir={sort.dir} prefer="asc" onsort={sortBy} />
			<SortHead label="Page time" col="time" sortKey={sort.key} dir={sort.dir} prefer="asc" onsort={sortBy} />
		</tr></thead>
		<tbody>
			{#each rows as row (row.id)}
				{@const earlier = row.at && run && row.at !== run.at ? new Date(row.at).toLocaleString() : ''}
				<tr class="m-row" class:sel={shown?.id === row.id} onclick={() => (modelView = row.id)}>
					<td><div class="m-name"><strong>{row.name}</strong>{#if row.error}<span class="sub tone-bad">{row.error}</span>{/if}
						{#if earlier}<span class="sub">{earlier}</span>{/if}</div>
						{#if row.billed}<span class="chip warn">billed</span>{/if}</td>
					<td class={row.pages.length ? tone(row.totals.official, 0.5, 0.35) : ''}><strong>{row.pages.length ? score(row.totals.official) : row.state === 'running' ? '…' : '—'}</strong></td>
					<td>{row.pages.length ? score(row.totals.literal) : '—'}</td>
					<td class={row.pages.length ? tone(row.totals.meaning, 0.9, 0.75) : ''}>{row.pages.length ? `${score(row.totals.meaning)}%` : '—'}</td>
					<td class={gradeText(row) ? tone(attachedReview(row)!.totals.comparable, 0.9, 0.6) : ''}>
						{#if gradeText(row)}
							<button type="button" class="grade" aria-label="Show the assessment for {row.name}" onclick={(event) => openGrade(event, row)}>
								<strong>{gradeText(row)}</strong>
								<span class="sub">{attachedReview(row)?.reviewerName}</span>
							</button>
						{:else if attachedReview(row)?.error}<span class="sub tone-bad">{attachedReview(row)?.error}</span>
						{:else}—{/if}
					</td>
					<td class={row.totals.missing ? 'tone-bad' : ''}>{row.pages.length ? `${row.totals.missing}/${row.totals.lines}` : '—'}</td>
					<td>{row.pages.length ? formatDuration(medianMs(row.pages)) : row.state === 'running' ? '…' : '—'}</td>
				</tr>
			{/each}
			<tr class="reference">
				<td><div class="m-name"><strong>{status.dataset.referenceLabel === 'official' ? 'Official English' : 'Reference English'}</strong><span class="sub">reference: how the {status.dataset.referenceLabel} English scores</span></div></td>
				<td>{score(status.baseline.official)}</td>
				<td>{score(status.baseline.literal)}</td>
				<td>{score(status.baseline.meaning)}%</td>
				<td>—</td>
				<td>0/{status.baseline.lines}</td>
				<td>—</td>
			</tr>
		</tbody>
	</table>
	<p class="muted small" style="margin-top:.4rem">
    {#if status.dataset.referenceLabel === 'official'}
      The official edition is a localisation, so good translations rarely pass 60 against it.
    {:else}
      The English reference is agent-prepared and visually checked against the Korean. chrF measures wording overlap, not translation quality by itself.
    {/if}
    The literal column rewards staying close to the source; the {status.dataset.referenceLabel} English
    itself reaches {score(status.baseline.literal)} there.
	</p>
</div>

<dialog class="grade-note" bind:this={gradeDialog} aria-labelledby="grade-note-title" onclose={() => (gradeOpen = null)}>
	{#if gradeOpen && openReview}
		<div class="spread">
			<h3 id="grade-note-title">{gradeOpen.name}</h3>
			<button type="button" class="btn ghost" onclick={() => gradeDialog?.close()}>Close</button>
		</div>
		<p class="kicker {tone(openReview.totals.comparable, 0.9, 0.6)}">{reviewLetter(openReview.totals.comparable)} {Math.round(openReview.totals.comparable * 100)} · {openReview.reviewerName}</p>
		{#if openReview.assessment}
			<p class="assessment">{openReview.assessment}</p>
		{:else}
			<p class="muted">This grade has no written assessment. Grade the saved translation again to add one.</p>
		{/if}
	{/if}
</dialog>

<div class="section">
	<div class="section-head">
		<h3>Lines</h3>
		<div class="row">
			{#if run?.models.length}
				<select bind:value={modelView} aria-label="Model">
					<option value="">{rows[0]?.name || '—'} (best)</option>
					{#each run.models as item (item.id)}<option value={item.id}>{item.name}</option>{/each}
				</select>
			{/if}
			<div class="seg" role="tablist" aria-label="Benchmark page">
				{#each PAGES as item (item.id)}
					<button role="tab" aria-selected={pageId === item.id} class:on={pageId === item.id} title={item.note} onclick={() => (pageId = item.id)}>{item.id}</button>
				{/each}
			</div>
		</div>
	</div>
	<div class="viewer">
		<div class="pages" class:single={!page.english}>
			<PageOverlay {page} dataset={status.dataset.id} highlight={hover} />
			{#if page.english}<PageOverlay {page} dataset={status.dataset.id} english />{/if}
		</div>
		<div>
			{#if shownPage?.error}<div class="fix-box bad small">{shownPage.error}</div>{/if}
			<table class="mtable lines" aria-label="Translated lines">
				<thead><tr><th>{status.dataset.lang === 'korean' ? 'Korean' : 'Japanese'}</th><th>{status.dataset.referenceLabel === 'official' ? 'Official' : 'Reference'}</th><th>Literal reference</th>{#if shownPage}<th>{shown?.name}</th><th>chrF</th>{/if}</tr></thead>
				<tbody>
					{#each lines as line (line.id)}
						{@const out = shownPage?.lines.find((item) => item.id === line.id)}
						<tr onmouseenter={() => (hover = line.id)} onmouseleave={() => (hover = '')}>
							<td lang={status.dataset.lang === 'korean' ? 'ko' : 'ja'}>{line.source}</td>
							<td>{line.en}</td>
							<td class="muted">{line.literal}</td>
							{#if shownPage}
							<td>
								{#if out?.translation}{out.translation}{:else}<span class="tone-bad">missing</span>{/if}
								{#if out?.literal}<div class="muted small">literal: {out.literal}</div>{/if}
								{#if out?.missedKeys.length}<div class="tone-warn small">lacks: {out.missedKeys.join(', ')}</div>{/if}
								{#if shown}
									{@const graded = attachedReview(shown)?.lines.find((item) => item.id === line.id)}
									{#if graded}<div class="small {tone(graded.comparable, 0.9, 0.6)}"><strong>{reviewLetter(graded.comparable)} {Math.round(graded.comparable * 100)}</strong>{#if graded.note} — {graded.note}{/if}</div>{/if}
								{/if}
							</td>
								<td class="small">
									{#if out}<span class={tone(out.chrfOfficial, 0.5, 0.35)}>{score(out.chrfOfficial)}</span><br /><span class="muted">{score(out.chrfLiteral)} lit</span>{/if}
								</td>
							{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
</div>

<style>
	h3 { font-size: 1rem; margin: 0; }
	.models { grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
	.pages.single { grid-template-columns: 1fr; }
	.reference td { color: var(--muted); font-style: italic; }
	.viewer { display: grid; grid-template-columns: minmax(240px, 380px) minmax(0, 1fr); gap: 1.1rem; align-items: start; }
	.pages { display: grid; grid-template-columns: 1fr 1fr; gap: 0.4rem; }
	.lines td { padding: 0.4rem 0.5rem; font-size: 0.85rem; vertical-align: top; }
	button.grade {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.1rem;
		padding: 0;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 0.18em;
	}
	button.grade:hover { color: var(--teal); }
	button.grade .sub { font-size: 0.75rem; color: var(--muted); text-decoration: none; }
	dialog.grade-note {
		width: min(36rem, calc(100vw - 2rem));
		border: 1px solid var(--line);
		border-radius: 0.6rem;
		background: var(--panel);
		color: var(--text);
		padding: 1.1rem 1.2rem;
	}
	dialog.grade-note::backdrop { background: rgba(0, 0, 0, 0.45); }
	dialog.grade-note h3 { margin: 0; font-size: 1.05rem; }
	.assessment { margin: 0.7rem 0 0; white-space: pre-wrap; line-height: 1.45; }
	@media (max-width: 1000px) {
		.viewer { grid-template-columns: 1fr; }
	}
</style>
