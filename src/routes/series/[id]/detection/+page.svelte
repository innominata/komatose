<script lang="ts">
	import { onMount } from 'svelte';
	import { APP_NAME } from '$lib/brand';
	import { detectorSetupLabel, parseDetectorSetup } from '$lib/detectorSetup';

	let { data } = $props();

	type Counts = {
		kept: number; reshaped: number; removed: number; ignored: number; 'auto-removed': number;
		cleared: number; 'auto-ignored': number; dropped: number; total: number; shown: number; rejected: number;
	};
	type Group = Counts & { key: string; label: string };
	type Row = {
		id: string; episodeId: string; imageId: string; kind: string; score: number;
		sources: string[]; scores: Record<string, number>; outcome: string; reason: string;
	};
	type Report = {
		runs: number; pages: number; setups: { setup: string; pages: number }[]; totals: Counts; addedByHand: number;
		bySources: Group[]; byScore: Group[]; byKind: Group[]; hotspots: Group[];
		byEpisode: (Group & { addedByHand: number })[]; rejectedSamples: Row[];
	};

	let report = $state<Report | null>(null);
	let failed = $state('');
	let loading = $state(true);

	async function load() {
		loading = true;
		failed = '';
		try {
			const res = await fetch(`/api/series/${data.series.id}/detection`);
			const body = await res.json();
			if (!res.ok) throw new Error(body?.error || body?.message || res.statusText);
			report = body;
		} catch (e) {
			failed = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}
	onMount(load);

	const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—');
	const filtered = (c: Counts) => c['auto-ignored'] + c.dropped;
	const setupName = (id: string) => {
		const parsed = parseDetectorSetup(id);
		return parsed ? detectorSetupLabel(parsed) : id;
	};
	const SOURCE_NAMES: Record<string, string> = {
		rtdetr: 'RT-DETR', ctd: 'CTD', paddle: 'PaddleOCR', coo: 'COO', 'sam-ts-l': 'SAM-TS-L', heuristic: 'Geometric',
	};
	const OUTCOME_NAMES: Record<string, string> = { removed: 'Deleted', ignored: 'Ignored' };
	const chapterTitle = (id: string) => report?.byEpisode.find((e) => e.key === id)?.label ?? '';
</script>

<svelte:head>
	<title>Detection report · {data.series.title} · {APP_NAME}</title>
</svelte:head>

<div class="report">
	<div class="d-flex flex-wrap justify-content-between align-items-end gap-2 mb-3">
		<div>
			<a class="hud-kicker text-decoration-none" href="/series/{data.series.id}">← {data.series.title}</a>
			<h2 class="mb-0">Detection report</h2>
		</div>
		<div class="d-flex gap-2">
			<button class="btn-hud-ghost" type="button" onclick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
			<a class="btn-hud-ghost" href="/api/series/{data.series.id}/detection?format=csv" download>Download CSV</a>
		</div>
	</div>

	{#if failed}
		<div class="alert-hud mb-3" role="alert">{failed}</div>
	{:else if report && !report.totals.total}
		<div class="hud-card" data-find="detection-empty">
			<p class="mb-1">No detections recorded for this series yet.</p>
			<p class="small text-secondary mb-0">
				From now on, every page detected by Transcribe is recorded here: which detectors found each region, how sure
				they were, and whether you kept it, reshaped it, deleted it or marked it ignored. Work through a chapter as usual
				and come back.
			</p>
		</div>
	{:else if report}
		{@const t = report.totals}
		<div class="tiles mb-3" data-find="detection-totals">
			<div class="hud-card tile"><span class="n">{t.shown}</span><span class="l">regions shown to you</span></div>
			<div class="hud-card tile"><span class="n">{t.kept + t.reshaped}</span><span class="l">kept ({t.reshaped} reshaped)</span></div>
			<div class="hud-card tile bad"><span class="n">{t.rejected}</span><span class="l">false positives · {pct(t.rejected, t.shown)}</span></div>
			<div class="hud-card tile"><span class="n">{pct(t.kept + t.reshaped, t.shown)}</span><span class="l">precision</span></div>
			<div class="hud-card tile"><span class="n">{report.addedByHand}</span><span class="l">drawn by hand (missed)</span></div>
			<div class="hud-card tile"><span class="n">{filtered(t)}</span><span class="l">caught by the reader before you saw them</span></div>
		</div>
		<p class="small text-secondary">
			{report.pages} page{report.pages === 1 ? '' : 's'} detected
			{#if report.setups.length}with {report.setups.map((s) => `${setupName(s.setup)} (${s.pages})`).join(', ')}{/if}.
			False positives are regions deleted on their own (or with Remove blank regions), marked ignored, or removed by the
			Director. Regions cleared with the rest of their page, as before detecting again, are not counted.
		</p>

		<section class="hud-card mb-3" aria-labelledby="hotspots-h">
			<h3 id="hotspots-h" class="hud-kicker mb-2">Where the false positives come from</h3>
			{#if report.hotspots.length}
				<ul class="hotspots" data-find="detection-hotspots">
					{#each report.hotspots as g (g.key)}
						<li>
							<span class="hs-label">{g.label}</span>
							<span class="bar" aria-hidden="true"><span style:width={pct(g.rejected, g.shown)}></span></span>
							<span class="hs-n">{g.rejected} of {g.shown} rejected · {pct(g.rejected, g.shown)}</span>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="small text-secondary mb-0">Nothing rejected yet.</p>
			{/if}
		</section>

		{#snippet table(title: string, groups: Group[], hand?: boolean)}
			<section class="hud-card mb-3" aria-label={title}>
				<h3 class="hud-kicker mb-2">{title}</h3>
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th scope="col"></th><th scope="col">Shown</th><th scope="col">Kept</th><th scope="col">Reshaped</th>
								<th scope="col">Deleted</th><th scope="col">Ignored</th><th scope="col">By Director</th>
								<th scope="col">Rejected</th><th scope="col" title="Read as no text, or a repeat, before you saw it">Filtered</th>
								{#if hand}<th scope="col">Drawn by hand</th>{/if}
							</tr>
						</thead>
						<tbody>
							{#each groups as g (g.key)}
								<tr>
									<th scope="row">{g.label}</th><td>{g.shown}</td><td>{g.kept}</td><td>{g.reshaped}</td>
									<td>{g.removed}</td><td>{g.ignored}</td><td>{g['auto-removed']}</td>
									<td class:hot={g.shown >= 5 && g.rejected / g.shown >= 0.5}>{pct(g.rejected, g.shown)}</td>
									<td>{filtered(g)}</td>
									{#if hand}<td>{(g as Group & { addedByHand?: number }).addedByHand ?? 0}</td>{/if}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>
		{/snippet}
		{@render table('By detectors that agreed', report.bySources)}
		{@render table('By score', report.byScore)}
		{@render table('By kind', report.byKind)}
		{@render table('By chapter', report.byEpisode, true)}

		<section class="hud-card mb-3" aria-labelledby="rejected-h">
			<h3 id="rejected-h" class="hud-kicker mb-2">What was rejected</h3>
			{#if report.rejectedSamples.length}
				<p class="small text-secondary">The {report.rejectedSamples.length} most recent regions you deleted or ignored, as detected.</p>
				<div class="gallery" data-find="detection-rejected">
					{#each report.rejectedSamples as r (r.id)}
						<figure>
							<img src="/api/series/{data.series.id}/detection/crop/{r.id}" alt="Rejected region" loading="lazy" />
							<figcaption>
								<span>{r.sources.map((s) => `${SOURCE_NAMES[s] ?? s}${r.scores[s] != null ? ` ${r.scores[s].toFixed(2)}` : ''}`).join(' + ') || 'Unknown'}</span>
								<span class="text-secondary">{OUTCOME_NAMES[r.outcome] ?? r.outcome} · {r.kind} · {chapterTitle(r.episodeId)}</span>
							</figcaption>
						</figure>
					{/each}
				</div>
			{:else}
				<p class="small text-secondary mb-0">Nothing rejected yet.</p>
			{/if}
		</section>
	{:else}
		<p class="text-secondary">Loading…</p>
	{/if}
</div>

<style>
	.report {
		max-width: 1200px;
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
		gap: 10px;
	}
	.tile {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin: 0;
	}
	.tile .n {
		font-size: 1.6rem;
		font-weight: 700;
		line-height: 1.1;
	}
	.tile .l {
		font-size: 0.8rem;
		color: var(--hud-muted);
	}
	.tile.bad .n {
		color: var(--hud-danger, #e0604f);
	}
	.hotspots {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 6px;
	}
	.hotspots li {
		display: grid;
		grid-template-columns: minmax(0, 2fr) minmax(80px, 1fr) auto;
		align-items: center;
		gap: 10px;
		font-size: 0.85rem;
	}
	.bar {
		height: 8px;
		border-radius: 4px;
		background: var(--hud-line);
		overflow: hidden;
	}
	.bar span {
		display: block;
		height: 100%;
		background: var(--hud-danger, #e0604f);
	}
	.hs-n {
		color: var(--hud-muted);
		white-space: nowrap;
	}
	.table-wrap {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
	}
	th,
	td {
		padding: 4px 8px;
		border-bottom: 1px solid var(--hud-line);
		text-align: right;
		white-space: nowrap;
	}
	th[scope='row'],
	thead th:first-child {
		text-align: left;
		white-space: normal;
	}
	td.hot {
		color: var(--hud-danger, #e0604f);
		font-weight: 700;
	}
	.gallery {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
		gap: 10px;
	}
	figure {
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	figure img {
		width: 100%;
		height: 140px;
		object-fit: contain;
		background: var(--hud-canvas);
		border: 1px solid var(--hud-line);
		border-radius: 4px;
	}
	figcaption {
		display: flex;
		flex-direction: column;
		font-size: 0.75rem;
		line-height: 1.3;
	}
</style>
