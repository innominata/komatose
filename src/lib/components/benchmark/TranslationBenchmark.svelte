<script lang="ts">
	import { untrack } from 'svelte';
	import { GOLD_PAGES, goldTranslationLines } from '$lib/benchmarkGold';
	import { nextSort, sortedBy, type SortDir, type SortState } from '$lib/benchmarkSort';
	import { medianMs, type BenchmarkStatus, type TranslationResult } from '$lib/modelBenchmark';
	import { formatDuration } from '$lib/modelEstimate';
	import PageOverlay from './PageOverlay.svelte';
	import SortHead from './SortHead.svelte';

	let { status, busy, post }: {
		status: BenchmarkStatus;
		busy: boolean;
		post: (body: Record<string, unknown>) => Promise<void>;
	} = $props();

	const run = $derived(status.runs.translation);
	const running = $derived(status.running === 'translation');
	const blocked = $derived(Boolean(status.running) || busy || !status.available);
	let models = $state<string[]>(untrack(() => status.translationModels.filter((model) => model.local).map((model) => model.id)));
	const billed = $derived(status.translationModels.filter((model) => models.includes(model.id) && model.billed).length);

	const PAGES = GOLD_PAGES.filter((page) => goldTranslationLines(page).length);
	const lineCount = PAGES.reduce((sum, page) => sum + goldTranslationLines(page).length, 0);

	function toggle(id: string) {
		models = models.includes(id) ? models.filter((item) => item !== id) : [...models, id];
	}
	function score(value: number | undefined) {
		return value == null || !Number.isFinite(value) ? '—' : (value * 100).toFixed(1);
	}
	function tone(value: number, good: number, fair: number) {
		return value >= good ? 'tone-ok' : value >= fair ? 'tone-warn' : 'tone-bad';
	}

	type TrKey = 'name' | 'official' | 'literal' | 'meaning' | 'missing' | 'time';
	let sort = $state<SortState<TrKey>>({ key: 'official', dir: 'desc' });
	function ready(row: { pages: unknown[] }, value: number) {
		return row.pages.length ? value : Number.NaN;
	}
	function trValue(row: TranslationResult, key: TrKey): string | number {
		if (key === 'name') return row.name;
		if (key === 'official') return ready(row, row.totals.official);
		if (key === 'literal') return ready(row, row.totals.literal);
		if (key === 'meaning') return ready(row, row.totals.meaning);
		if (key === 'missing') return ready(row, row.totals.missing);
		return ready(row, medianMs(row.pages));
	}
	const rows = $derived(sortedBy(run?.models || [], sort, trValue));
	function sortBy(key: string, prefer: SortDir) {
		sort = nextSort(sort, key as TrKey, prefer);
	}
	let modelView = $state('');
	let pageId = $state('009');
	const page = $derived(GOLD_PAGES.find((item) => item.id === pageId)!);
	const shown = $derived(run?.models.find((item) => item.id === modelView) || rows[0]);
	const shownPage = $derived(shown?.pages.find((item) => item.page === pageId));
	const lines = $derived(goldTranslationLines(page));
	let hover = $state('');
</script>

<div class="card stack">
	<div>
		<div class="kicker">Translation models</div>
		{#if !status.translationModels.length}
			<p class="muted small">No visible translation models for Japanese. Show a row in pickers or install a translation model.</p>
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
			<button class="btn solid {running ? 'busy' : ''}" disabled={blocked || !models.length}
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

<div class="section">
	<div class="section-head">
		<h3>Scores</h3>
		<span class="muted small">chrF: character n-gram overlap, 0–100. Meaning: key terms each line must carry (names, numbers, the point of the line).</span>
	</div>
	<table class="mtable" aria-label="Translation results">
		<thead><tr>
			<SortHead label="Model" col="name" sortKey={sort.key} dir={sort.dir} prefer="asc" onsort={sortBy} />
			<SortHead label="chrF · official" col="official" sortKey={sort.key} dir={sort.dir} onsort={sortBy} />
			<SortHead label="chrF · literal" col="literal" sortKey={sort.key} dir={sort.dir} onsort={sortBy} />
			<SortHead label="Meaning" col="meaning" sortKey={sort.key} dir={sort.dir} onsort={sortBy} />
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
					<td class={row.totals.missing ? 'tone-bad' : ''}>{row.pages.length ? `${row.totals.missing}/${row.totals.lines}` : '—'}</td>
					<td>{row.pages.length ? formatDuration(medianMs(row.pages)) : row.state === 'running' ? '…' : '—'}</td>
				</tr>
			{/each}
			<tr class="reference">
				<td><div class="m-name"><strong>Official English</strong><span class="sub">reference: how a fluent human translation scores</span></div></td>
				<td>{score(status.baseline.official)}</td>
				<td>{score(status.baseline.literal)}</td>
				<td>{score(status.baseline.meaning)}%</td>
				<td>0/{status.baseline.lines}</td>
				<td>—</td>
			</tr>
		</tbody>
	</table>
	<p class="muted small" style="margin-top:.4rem">
		The official edition is a localisation, so good translations rarely pass 60 against it. The literal column rewards staying
		close to the Japanese; the official English itself only reaches {score(status.baseline.literal)} there.
	</p>
</div>

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
		<div class="pages">
			<PageOverlay {page} highlight={hover} />
			<PageOverlay {page} english />
		</div>
		<div>
			{#if shownPage?.error}<div class="fix-box bad small">{shownPage.error}</div>{/if}
			<table class="mtable lines" aria-label="Translated lines">
				<thead><tr><th>Japanese</th><th>Official</th><th>Literal reference</th>{#if shownPage}<th>{shown?.name}</th><th>chrF</th>{/if}</tr></thead>
				<tbody>
					{#each lines as line (line.id)}
						{@const out = shownPage?.lines.find((item) => item.id === line.id)}
						<tr onmouseenter={() => (hover = line.id)} onmouseleave={() => (hover = '')}>
							<td lang="ja">{line.ja}</td>
							<td>{line.en}</td>
							<td class="muted">{line.literal}</td>
							{#if shownPage}
								<td>
									{#if out?.translation}{out.translation}{:else}<span class="tone-bad">missing</span>{/if}
									{#if out?.literal}<div class="muted small">literal: {out.literal}</div>{/if}
									{#if out?.missedKeys.length}<div class="tone-warn small">lacks: {out.missedKeys.join(', ')}</div>{/if}
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
	.reference td { color: var(--muted); font-style: italic; }
	.viewer { display: grid; grid-template-columns: minmax(240px, 380px) minmax(0, 1fr); gap: 1.1rem; align-items: start; }
	.pages { display: grid; grid-template-columns: 1fr 1fr; gap: 0.4rem; }
	.lines td { padding: 0.4rem 0.5rem; font-size: 0.85rem; vertical-align: top; }
	@media (max-width: 1000px) {
		.viewer { grid-template-columns: 1fr; }
	}
</style>
