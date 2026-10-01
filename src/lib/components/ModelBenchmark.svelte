<script lang="ts">
	import { onMount } from 'svelte';
	import { GOLD_SERIES } from '$lib/benchmarkGold';
	import type { BenchmarkStatus } from '$lib/modelBenchmark';
	import OcrBenchmark from './benchmark/OcrBenchmark.svelte';
	import TranslationBenchmark from './benchmark/TranslationBenchmark.svelte';

	let status = $state<BenchmarkStatus | null>(null);
	let tab = $state<'ocr' | 'translation'>('ocr');
	let error = $state('');
	let busy = $state(false);
	let wake: () => void = () => {};

	async function api(method: 'GET' | 'POST', body?: unknown) {
		const response = await fetch('/api/admin/model-benchmark', {
			method,
			headers: body ? { 'content-type': 'application/json' } : undefined,
			body: body ? JSON.stringify(body) : undefined,
		});
		const data = await response.json();
		if (!response.ok || data.ok === false) throw new Error(data.error || 'Benchmark request failed');
		return data;
	}

	async function refresh() {
		status = await api('GET');
	}

	async function post(body: Record<string, unknown>) {
		busy = true;
		error = '';
		try {
			await api('POST', body);
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
		let timer: ReturnType<typeof setTimeout>;
		// Poll fast while a run is going; otherwise only when a run is started.
		const poll = async () => {
			clearTimeout(timer);
			try {
				await refresh();
			} catch (e) {
				if (!disposed) error = (e as Error).message;
			}
			if (!disposed && status?.running) timer = setTimeout(poll, 1500);
		};
		wake = () => void poll();
		void poll();
		return () => {
			disposed = true;
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
	<p class="muted small intro">
		Ten pages of <em>{GOLD_SERIES}</em>, vol. 1 (<code>fixtures/test-pages</code>), against a hand-checked gold standard:
		a box around every piece of lettering, the Japanese as printed, the official English edition, and a literal translation.
		{#if tab === 'ocr'}
			Every text detector is scored on the gold boxes, then OCR models read crops — cut from the gold boxes, to test
			recognition alone, or from a detector, as chapter transcription does. CLI and remote vision models read each full page.
		{:else}
			Translators get the gold Japanese one page at a time, the same request chapter translation sends, so OCR mistakes
			play no part. Scores are chrF against the official English and against the literal reference, plus meaning checks.
		{/if}
	</p>
	{#if status && !status.available}
		<div class="fix-box bad">Some pages in <code>fixtures/test-pages</code> are missing, so the benchmark cannot run.</div>
	{/if}
	{#if !status}
		<p class="muted">Loading benchmark…</p>
	{:else if tab === 'ocr'}
		<OcrBenchmark {status} {busy} {post} />
	{:else}
		<TranslationBenchmark {status} {busy} {post} />
	{/if}
	{#if error}<div role="alert" class="fix-box bad" style="margin-top:.75rem">{error}</div>{/if}
</section>

<style>
	.intro { max-width: 70rem; margin-bottom: 0.8rem; }
</style>
