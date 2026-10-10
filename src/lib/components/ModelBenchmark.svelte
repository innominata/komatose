<script lang="ts">
	import { onMount } from 'svelte';
	import { BENCHMARK_DATASETS } from '$lib/benchmarkDatasets';
	import type { BenchmarkStatus } from '$lib/modelBenchmark';
	import OcrBenchmark from './benchmark/OcrBenchmark.svelte';
	import TranslationBenchmark from './benchmark/TranslationBenchmark.svelte';

	let datasetId = $state('manga-ja');
	let generation = 0;
	let status = $state<BenchmarkStatus | null>(null);
	let tab = $state<'ocr' | 'translation'>('ocr');
	let error = $state('');
	let busy = $state(false);
	let wake: () => void = () => {};

	async function api(method: 'GET' | 'POST', body?: unknown) {
		const response = await fetch(`/api/admin/model-benchmark?dataset=${encodeURIComponent(datasetId)}`, {
			method,
			headers: body ? { 'content-type': 'application/json' } : undefined,
			body: body ? JSON.stringify(body) : undefined,
		});
		const data = await response.json();
		if (!response.ok || data.ok === false) throw new Error(data.error || 'Benchmark request failed');
		return data;
	}

	async function refresh() {
		const requestGeneration = ++generation;
		const requestedDataset = datasetId;
    try {
		  const next = await api('GET');
		  if (requestGeneration === generation && requestedDataset === datasetId) status = next;
    } catch (error) {
      if (requestGeneration === generation && requestedDataset === datasetId) throw error;
    }
	}

	async function post(body: Record<string, unknown>) {
		busy = true;
		error = '';
		try {
			await api('POST', { ...body, dataset: datasetId });
			await refresh();
			wake();
		} catch (e) {
			error = (e as Error).message;
		} finally {
			busy = false;
		}
	}

	onMount(() => {
		let disposed = false;
		let pollCycle = 0;
		let timer: ReturnType<typeof setTimeout>;
		// Poll fast while a run is going; otherwise only when a run is started.
		const poll = async () => {
      const cycle = ++pollCycle;
			clearTimeout(timer);
			try {
				await refresh();
			} catch (e) {
				if (!disposed) error = (e as Error).message;
			}
			if (!disposed && cycle === pollCycle && status?.running) timer = setTimeout(poll, 1500);
		};
		wake = () => void poll();
		void poll();
		return () => {
			disposed = true;
      generation++;
      pollCycle++;
			clearTimeout(timer);
		};
	});
</script>

<section class="benchmark" aria-label="Benchmark">
	<div class="section-head">
		<h2>Benchmark</h2>
		<div class="seg" role="tablist" aria-label="Benchmark type">
			<button role="tab" aria-selected={tab === 'ocr'} class:on={tab === 'ocr'} onclick={() => (tab = 'ocr')}>
				<i class="bi bi-bounding-box"></i> Detection &amp; OCR
			</button>
			<button role="tab" aria-selected={tab === 'translation'} class:on={tab === 'translation'} onclick={() => (tab = 'translation')}>
				<i class="bi bi-translate"></i> Translation
			</button>
		</div>
	</div>
	<label class="dataset-picker">
    Dataset
    <select aria-label="Benchmark dataset" value={datasetId} onchange={(event) => {
      datasetId = event.currentTarget.value;
      generation++;
      status = null;
      error = '';
      wake();
    }}>
      {#each BENCHMARK_DATASETS as dataset (dataset.id)}
        <option value={dataset.id}>{dataset.label}</option>
      {/each}
    </select>
  </label>
  {#if status}
    <p class="muted small intro">
      {status.dataset.pages.length} pages of <em>{status.dataset.series}</em>, against a visually checked gold standard:
      lettering boxes, the {status.dataset.lang === 'korean' ? 'Korean' : 'Japanese'} as printed,
      {status.dataset.referenceLabel === 'official' ? 'the official English edition' : 'checked English text references'}, and literal translations.
      {#if tab === 'ocr'}
        Detectors are scored against gold boxes. Every OCR integration reads the same crops, cut from gold boxes
        to test recognition alone, or from detectors as chapter transcription does.
      {:else}
        Translators receive gold source text one page at a time, so OCR mistakes play no part.
        chrF and the keyword checks compare wording. A chat model can grade the saved translations
        by meaning, so a localization that does not copy the reference can still score well.
      {/if}
      {#if status.dataset.lang === 'korean'}This small synthetic fixture tests these scenes; it does not represent all manhwa.{/if}
    </p>
    {#if !status.available}
      <div class="fix-box bad">Some pages in <code>{status.dataset.fixtureDir}</code> are missing, so the benchmark cannot run.</div>
    {/if}
    {#if status.running}
      <p class="muted small" role="status">Running {status.running === 'ocr' ? 'Detection & OCR' : status.running === 'review' ? 'meaning review' : 'Translation'} · {status.datasets.find(item => item.id === status?.runningDataset)?.label}</p>
    {/if}
  {/if}
	{#if !status}
		<p class="muted">Loading benchmark…</p>
	{:else}
    {#key status.dataset.id}
      {#if tab === 'ocr'}
        <OcrBenchmark {status} {busy} {post} />
      {:else}
        <TranslationBenchmark {status} {busy} {post} />
      {/if}
    {/key}
	{/if}
	{#if error}<div role="alert" class="fix-box bad" style="margin-top:.75rem">{error}</div>{/if}
</section>

<style>
	.dataset-picker { display: flex; align-items: center; gap: .6rem; margin-bottom: .8rem; }
	.intro { max-width: 70rem; margin-bottom: 0.8rem; }
</style>
