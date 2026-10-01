<script lang="ts">
	import { untrack } from 'svelte';
	import { GOLD_PAGES, goldOcrGroup } from '$lib/benchmarkGold';
	import { nextSort, sortedBy, type SortDir, type SortState } from '$lib/benchmarkSort';
	import { GOLD_SOURCE, medianMs, type BenchmarkStatus, type DetectionResult, type OcrResult } from '$lib/modelBenchmark';
	import { formatDuration } from '$lib/modelEstimate';
	import PageOverlay from './PageOverlay.svelte';
	import SortHead from './SortHead.svelte';

	let { status, busy, post }: {
		status: BenchmarkStatus;
		busy: boolean;
		post: (body: Record<string, unknown>) => Promise<void>;
	} = $props();

	const run = $derived(status.runs.ocr);
	const running = $derived(status.running === 'ocr');
	const blocked = $derived(Boolean(status.running) || busy || !status.available);
	const usable = $derived(status.detectors.filter((setup) => setup.available));

	// First visit: every installed detector, the transcription models, gold crops plus what chapters use.
	let detectors = $state<string[]>(untrack(() => status.detectors.filter((setup) => setup.available).map((setup) => setup.id)));
	let models = $state<string[]>(untrack(() => status.ocrModels.filter((model) => model.specialist).map((model) => model.id)));
	let sources = $state<string[]>(untrack(() => [GOLD_SOURCE, ...(status.detectors.some((setup) => setup.id === status.chapterSetup && setup.available) ? [status.chapterSetup] : [])]));

	const cropModels = $derived(status.ocrModels.filter((model) => models.includes(model.id) && model.crops).length);
	const pageModels = $derived(status.ocrModels.filter((model) => models.includes(model.id) && !model.crops).length);

	function toggle(list: string[], id: string) {
		return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
	}
	function pct(value: number | undefined, digits = 0) {
		return value == null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(digits)}%`;
	}
	function tone(value: number) {
		return value >= 0.9 ? 'tone-ok' : value >= 0.6 ? 'tone-warn' : 'tone-bad';
	}

	type DetKey = 'label' | 'recall' | 'dialogue' | 'sfx' | 'precision' | 'falseAlarms' | 'f1' | 'time';
	type OcrKey = 'name' | 'source' | 'dialogue' | 'other' | 'noise' | 'exact' | 'time';
	let detSort = $state<SortState<DetKey>>({ key: 'f1', dir: 'desc' });
	let ocrSort = $state<SortState<OcrKey>>({ key: 'dialogue', dir: 'desc' });

	function ready(row: { pages: unknown[] }, value: number) {
		return row.pages.length ? value : Number.NaN;
	}
	function ratio(found: number, targets: number) {
		return targets ? found / targets : Number.NaN;
	}
	function detValue(row: DetectionResult, key: DetKey): string | number {
		if (key === 'label') return row.label;
		if (key === 'recall') return ready(row, row.totals.recall);
		if (key === 'dialogue') return ready(row, ratio(row.totals.dialogueFound, row.totals.dialogueTargets));
		if (key === 'sfx') return ready(row, ratio(row.totals.sfxFound, row.totals.sfxTargets));
		if (key === 'precision') return ready(row, row.totals.precision);
		if (key === 'falseAlarms') return ready(row, row.totals.falseAlarms);
		if (key === 'f1') return ready(row, row.totals.f1);
		return ready(row, medianMs(row.pages));
	}
	function ocrValue(row: OcrResult, key: OcrKey): string | number {
		if (key === 'name') return row.name;
		if (key === 'source') return row.sourceLabel;
		if (key === 'dialogue') return ready(row, row.totals.dialogue);
		if (key === 'other') return ready(row, row.totals.other);
		if (key === 'noise') return ready(row, row.totals.noise);
		if (key === 'exact') return ready(row, ratio(row.totals.exact, row.totals.lines));
		return ready(row, medianMs(row.pages));
	}

	const detectionRows = $derived(sortedBy(run?.detectors || [], detSort, detValue));
	const ocrRows = $derived(sortedBy(run?.models || [], ocrSort, ocrValue));
	function sortDet(key: string, prefer: SortDir) {
		detSort = nextSort(detSort, key as DetKey, prefer);
	}
	function sortOcr(key: string, prefer: SortDir) {
		ocrSort = nextSort(ocrSort, key as OcrKey, prefer);
	}

	let pageId = $state('007');
	let detectorView = $state('');
	let ocrView = $state('');
	let hover = $state('');
	const page = $derived(GOLD_PAGES.find((item) => item.id === pageId)!);
	const shownDetector = $derived(run?.detectors.find((item) => item.id === detectorView) || detectionRows[0]);
	const shownOcr = $derived(run?.models.find((item) => `${item.id}@${item.source}` === ocrView) || ocrRows[0]);
	const detectorPage = $derived(shownDetector?.pages.find((item) => item.page === pageId));
	const ocrPage = $derived(shownOcr?.pages.find((item) => item.page === pageId));
	const goldLines = $derived(page.lines.filter((line) => goldOcrGroup(line) && /[\p{L}\p{N}]/u.test(line.ja)));
</script>

<div class="card stack">
	<div class="pickers">
		<div>
			<div class="kicker">Text detectors</div>
			<div class="pick-list">
				{#each status.detectors as setup (setup.id)}
					<label class="pick" title={setup.reason || setup.parts.join(' + ')} class:dim={!setup.available}>
						<input type="checkbox" disabled={!setup.available} checked={detectors.includes(setup.id)}
							onchange={() => (detectors = toggle(detectors, setup.id))} />
						<span class="grow">{setup.label}</span>
						{#if setup.id === status.chapterSetup}<span class="chip ok">chapters</span>{/if}
						{#if !setup.available}<span class="chip muted">not installed</span>{/if}
					</label>
				{/each}
			</div>
		</div>
		<div>
			<div class="kicker">OCR models</div>
			{#if !status.ocrModels.length}
				<p class="muted small">No visible vision or OCR models. Install Hayai, PaddleOCR-VL, or Manga OCR, or show a vision row in pickers.</p>
			{:else}
				<div class="pick-list">
					{#each status.ocrModels as model (model.id)}
						<label class="pick">
							<input type="checkbox" checked={models.includes(model.id)} onchange={() => (models = toggle(models, model.id))} />
							<span class="grow">{model.name}</span>
							{#if !model.crops}<span class="chip muted">full page</span>{/if}
							{#if model.billed}<span class="chip warn">billed</span>{/if}
						</label>
					{/each}
				</div>
			{/if}
		</div>
		<div>
			<div class="kicker">OCR models read crops from</div>
			<div class="pick-list">
				<label class="pick">
					<input type="checkbox" checked={sources.includes(GOLD_SOURCE)} onchange={() => (sources = toggle(sources, GOLD_SOURCE))} />
					<span class="grow">Gold boxes <span class="muted small">· recognition alone</span></span>
				</label>
				{#each usable as setup (setup.id)}
					<label class="pick">
						<input type="checkbox" checked={sources.includes(setup.id)} onchange={() => (sources = toggle(sources, setup.id))} />
						<span class="grow">{setup.label}</span>
						{#if setup.id === status.chapterSetup}<span class="chip ok">chapters</span>{/if}
					</label>
				{/each}
			</div>
		</div>
	</div>
	<div class="spread">
		<div class="row">
			<button class="btn solid {running ? 'busy' : ''}" disabled={blocked || (!detectors.length && !models.length) || (cropModels > 0 && !sources.length)}
				onclick={() => void post({ kind: 'ocr', detectors, models, sources })}>
				{#if running}<span class="test-spin" aria-hidden="true"></span> Running…{:else}<i class="bi bi-play"></i> Run OCR benchmark{/if}
			</button>
			<button class="btn ghost" disabled={blocked} onclick={() => { detectors = usable.map((setup) => setup.id); models = status.ocrModels.map((model) => model.id); }}>
				Select all
			</button>
			<button class="btn ghost" disabled={blocked} onclick={() => { detectors = []; models = []; }}>
				Select none
			</button>
			{#if running}<button class="btn danger" onclick={() => void post({ action: 'cancel' })}>Cancel</button>{/if}
		</div>
		<span class="muted small">
			{GOLD_PAGES.length} pages · {detectors.length} detector setups · {cropModels * sources.length + pageModels} OCR runs{#if pageModels} · full-page models make one call per page{/if}
		</span>
	</div>
	{#if status.running === 'translation'}<p class="muted small">The translation benchmark is running; one benchmark runs at a time.</p>{/if}
	{#if run?.state === 'running'}
		<div>
			<div class="progress"><span style="width:{run.progress.total ? (run.progress.done / run.progress.total) * 100 : 0}%"></span></div>
			<div class="muted small" style="margin-top:.3rem">{run.progress.done} / {run.progress.total} · {run.progress.step}</div>
		</div>
	{/if}
	{#if run && run.state !== 'running'}
		<p class="muted small">
			Last run {new Date(run.at).toLocaleString()}{#if run.finishedAt} · took {formatDuration(run.finishedAt - run.at)}{/if}
			{#if run.state === 'cancelled'} · <span class="tone-warn">cancelled</span>{/if}
			{#if run.state === 'error'} · <span class="tone-bad">{run.error}</span>{/if}
			· earlier results stay listed until you benchmark them again
		</p>
	{/if}
</div>

{#if run && detectionRows.length}
	<div class="section">
		<div class="section-head">
			<h3>Text detection</h3>
			<span class="muted small">Recall: required lettering (speech, captions, SFX) found. Precision: boxes on lettering; boxes on signs and titles are neutral.</span>
		</div>
		<table class="mtable" aria-label="Detection results">
			<thead><tr>
				<SortHead label="Detector" col="label" sortKey={detSort.key} dir={detSort.dir} prefer="asc" onsort={sortDet} />
				<SortHead label="Recall" col="recall" sortKey={detSort.key} dir={detSort.dir} onsort={sortDet} />
				<SortHead label="Dialogue" col="dialogue" sortKey={detSort.key} dir={detSort.dir} onsort={sortDet} />
				<SortHead label="SFX" col="sfx" sortKey={detSort.key} dir={detSort.dir} onsort={sortDet} />
				<SortHead label="Precision" col="precision" sortKey={detSort.key} dir={detSort.dir} onsort={sortDet} />
				<SortHead label="False boxes" col="falseAlarms" sortKey={detSort.key} dir={detSort.dir} prefer="asc" onsort={sortDet} />
				<SortHead label="F1" col="f1" sortKey={detSort.key} dir={detSort.dir} onsort={sortDet} />
				<SortHead label="Page time" col="time" sortKey={detSort.key} dir={detSort.dir} prefer="asc" onsort={sortDet} />
			</tr></thead>
			<tbody>
				{#each detectionRows as row (row.id)}
					{@const earlier = row.at && run && row.at !== run.at ? new Date(row.at).toLocaleString() : ''}
					<tr class="m-row" class:sel={shownDetector?.id === row.id} onclick={() => (detectorView = row.id)}>
						<td><div class="m-name"><strong>{row.label}</strong>
							{#if row.error}<span class="sub tone-bad">{row.error}</span>{:else if row.totals.missed.length}<span class="sub">missed {row.totals.missed.join(', ')}</span>{/if}
							{#if earlier}<span class="sub">{earlier}</span>{/if}</div>
							{#if row.id === status.chapterSetup}<span class="chip ok">chapters</span>{/if}
						</td>
						<td class={tone(row.totals.recall)}>{row.state === 'pending' ? '…' : pct(row.totals.recall)}</td>
						<td>{row.totals.dialogueFound}/{row.totals.dialogueTargets}</td>
						<td>{row.totals.sfxFound}/{row.totals.sfxTargets}</td>
						<td class={tone(row.totals.precision)}>{row.state === 'pending' ? '…' : pct(row.totals.precision)}</td>
						<td>{row.totals.falseAlarms} <span class="muted small">of {row.totals.detections}</span></td>
						<td><strong>{pct(row.totals.f1)}</strong></td>
						<td>{row.pages.length ? formatDuration(medianMs(row.pages)) : '…'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

{#if run && ocrRows.length}
	<div class="section">
		<div class="section-head">
			<h3>OCR</h3>
			<span class="muted small">Character accuracy (1 − edits ÷ length), weighted by line length. Noise: output no gold line accounts for, such as furigana or art misread as text.</span>
		</div>
		<table class="mtable" aria-label="OCR results">
			<thead><tr>
				<SortHead label="Model" col="name" sortKey={ocrSort.key} dir={ocrSort.dir} prefer="asc" onsort={sortOcr} />
				<SortHead label="Crops from" col="source" sortKey={ocrSort.key} dir={ocrSort.dir} prefer="asc" onsort={sortOcr} />
				<SortHead label="Dialogue" col="dialogue" sortKey={ocrSort.key} dir={ocrSort.dir} onsort={sortOcr} />
				<SortHead label="SFX & signs" col="other" sortKey={ocrSort.key} dir={ocrSort.dir} onsort={sortOcr} />
				<SortHead label="Noise" col="noise" sortKey={ocrSort.key} dir={ocrSort.dir} prefer="asc" onsort={sortOcr} />
				<SortHead label="Exact lines" col="exact" sortKey={ocrSort.key} dir={ocrSort.dir} onsort={sortOcr} />
				<SortHead label="Page time" col="time" sortKey={ocrSort.key} dir={ocrSort.dir} prefer="asc" onsort={sortOcr} />
			</tr></thead>
			<tbody>
				{#each ocrRows as row (`${row.id}@${row.source}`)}
					{@const failedCrops = row.pages.reduce((sum, item) => sum + (item.failedCrops || 0), 0)}
					{@const earlier = row.at && run && row.at !== run.at ? new Date(row.at).toLocaleString() : ''}
					<tr class="m-row" class:sel={shownOcr?.id === row.id && shownOcr?.source === row.source} onclick={() => (ocrView = `${row.id}@${row.source}`)}>
						<td><div class="m-name"><strong>{row.name}</strong>{#if row.error}<span class="sub tone-bad">{row.error}</span>{/if}
							{#if failedCrops}<span class="sub tone-warn">{failedCrops} {failedCrops === 1 ? 'crop' : 'crops'} failed</span>{/if}
							{#if earlier}<span class="sub">{earlier}</span>{/if}</div>
							{#if row.billed}<span class="chip warn">billed</span>{/if}</td>
						<td>{row.sourceLabel}</td>
						<td class={row.pages.length ? tone(row.totals.dialogue) : ''}><strong>{row.pages.length ? pct(row.totals.dialogue, 1) : row.state === 'running' ? '…' : '—'}</strong></td>
						<td>{row.pages.length ? pct(row.totals.other, 1) : '—'}</td>
						<td class={row.totals.noise > 0.15 ? 'tone-warn' : ''}>{row.pages.length ? pct(row.totals.noise, 1) : '—'}</td>
						<td>{row.pages.length ? `${row.totals.exact}/${row.totals.lines}` : '—'}</td>
						<td>{row.pages.length ? formatDuration(medianMs(row.pages)) : row.state === 'running' ? '…' : '—'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

<div class="section">
	<div class="section-head">
		<h3>Pages</h3>
		<div class="seg" role="tablist" aria-label="Benchmark page">
			{#each GOLD_PAGES as item (item.id)}
				<button role="tab" aria-selected={pageId === item.id} class:on={pageId === item.id} title={item.note} onclick={() => (pageId = item.id)}>{item.id}</button>
			{/each}
		</div>
	</div>
	<div class="viewer">
		<div class="stack">
			<PageOverlay {page} detections={detectorPage?.boxes || []} falseIndexes={detectorPage?.score.falseIndexes || []} highlight={hover} />
			<div class="legend">
				<span><i class="sw" style="border:2px dashed #ff3366"></i> gold, required</span>
				<span><i class="sw" style="border:2px dashed #4aa8ff"></i> gold, sign/title</span>
				{#if detectorPage}
					<span><i class="sw" style="background:#2de2c5"></i> detection</span>
					<span><i class="sw" style="background:#f2b544"></i> false box</span>
				{/if}
			</div>
		</div>
		<div class="stack">
			<div class="muted small">{page.note}</div>
			{#if run?.detectors.length}
				<label class="field-inline">
					<span class="muted small">Boxes from</span>
					<select bind:value={detectorView}>
						<option value="">{detectionRows[0]?.label || '—'} (best F1)</option>
						{#each run.detectors as item (item.id)}<option value={item.id}>{item.label}</option>{/each}
					</select>
				</label>
				{#if detectorPage}
					<div class="small">
						{#if detectorPage.error}<span class="tone-bad">{detectorPage.error}</span>
						{:else}
							Found {detectorPage.score.found}/{detectorPage.score.targets} required · {detectorPage.score.falseAlarms} false of {detectorPage.score.detections} boxes · {formatDuration(detectorPage.ms)}
							{#if detectorPage.score.missed.length}<div class="tone-warn">Missed {detectorPage.score.missed.join(', ')}</div>{/if}
						{/if}
					</div>
				{/if}
			{/if}
			{#if run?.models.length}
				<label class="field-inline">
					<span class="muted small">Readings from</span>
					<select bind:value={ocrView}>
						<option value="">{ocrRows[0] ? `${ocrRows[0].name} · ${ocrRows[0].sourceLabel}` : '—'} (best)</option>
						{#each run.models as item (`${item.id}@${item.source}`)}<option value={`${item.id}@${item.source}`}>{item.name} · {item.sourceLabel}</option>{/each}
					</select>
				</label>
			{/if}
			{#if goldLines.length}
				<table class="mtable lines" aria-label="Page lines">
					<thead><tr><th>Line</th><th>Gold Japanese</th>{#if ocrPage}<th>Read</th><th></th>{/if}</tr></thead>
					<tbody>
						{#each goldLines as line (line.id)}
							{@const score = ocrPage?.lines.find((item) => item.id === line.id)}
							<tr onmouseenter={() => (hover = line.id)} onmouseleave={() => (hover = '')}>
								<td class="muted small">{line.id.slice(4)}<br />{line.kind}</td>
								<td lang="ja">{line.ja}</td>
								{#if ocrPage}
									<td lang="ja">{score?.read || '—'}</td>
									<td class={score ? tone(score.accuracy) : ''}>{score ? pct(score.accuracy) : '—'}</td>
								{/if}
							</tr>
						{/each}
					</tbody>
				</table>
			{:else}
				<p class="muted small">No lettering to read on this page.</p>
			{/if}
			{#if ocrPage}
				<details>
					<summary class="muted small">Raw output · {ocrPage.regions} {ocrPage.regions === 1 ? 'call' : 'crops'} · {formatDuration(ocrPage.ms)} · noise {pct(ocrPage.noise)}</summary>
					{#if ocrPage.error}<div class="tone-bad small">{ocrPage.error}</div>{/if}
					{#if ocrPage.failedCrops}<div class="tone-warn small">{ocrPage.failedCrops} of {ocrPage.regions} crops failed: {ocrPage.cropError}</div>{/if}
					{#if ocrPage.dropped}<div class="muted small">{ocrPage.dropped} duplicate or English {ocrPage.dropped === 1 ? 'reading' : 'readings'} dropped, as chapter transcription would.</div>{/if}
					<pre lang="ja">{ocrPage.output || '(empty)'}</pre>
				</details>
			{/if}
		</div>
	</div>
</div>

<style>
	.pickers { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; }
	.pick.dim { opacity: 0.55; }
	h3 { font-size: 1rem; margin: 0; }
	.viewer { display: grid; grid-template-columns: minmax(260px, 420px) minmax(0, 1fr); gap: 1.1rem; align-items: start; }
	.field-inline { display: grid; gap: 0.2rem; max-width: 26rem; }
	.lines td { padding: 0.35rem 0.5rem; font-size: 0.86rem; }
	pre { white-space: pre-wrap; font-size: 0.82rem; margin: 0.4rem 0 0; color: var(--text); }
	@media (max-width: 1000px) {
		.pickers, .viewer { grid-template-columns: 1fr; }
	}
</style>
