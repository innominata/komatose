<script lang="ts">
	import { goldRequired, type GoldPage, type GoldBox } from '$lib/benchmarkGold';

	let {
		page,
		dataset = 'manga-ja',
		english = false,
		gold = true,
		detections = [],
		falseIndexes = [],
		highlight = '',
	}: {
		page: GoldPage;
		dataset?: string;
		english?: boolean;
		gold?: boolean;
		detections?: GoldBox[];
		falseIndexes?: number[];
		highlight?: string;
	} = $props();

	const falses = $derived(new Set(falseIndexes));
	const src = $derived(`/api/admin/model-benchmark?dataset=${dataset}&page=${page.id}${english ? '&lang=en' : ''}`);
</script>

<figure class="overlay">
	<img {src} alt={`Page ${page.id}${english ? ', official English' : ''}`} loading="lazy" />
	{#if !english}
		<svg viewBox={`0 0 ${page.width} ${page.height}`} preserveAspectRatio="none" aria-hidden="true">
			{#each detections as box, i (i)}
				<rect class="det" class:false={falses.has(i)} x={box[0]} y={box[1]} width={box[2] - box[0]} height={box[3] - box[1]} />
			{/each}
			{#if gold}
				{#each page.lines as line (line.id)}
					{#each line.boxes as box, i (i)}
						<rect class="gold" class:optional={!goldRequired(line)} class:hl={highlight === line.id}
							x={box[0]} y={box[1]} width={box[2] - box[0]} height={box[3] - box[1]}>
							<title>{line.id} · {line.kind}{line.ocr === false ? ` · detection only: ${line.note}` : ''}</title>
						</rect>
					{/each}
				{/each}
			{/if}
		</svg>
	{/if}
</figure>

<style>
	.overlay { position: relative; margin: 0; line-height: 0; border: 1px solid var(--line); background: #000; }
	.overlay img { width: 100%; height: auto; display: block; }
	.overlay svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
	.gold { fill: none; stroke: #ff3366; stroke-width: 5; stroke-dasharray: 16 9; }
	.gold.optional { stroke: #4aa8ff; }
	.gold.hl { stroke: #fff; stroke-width: 9; stroke-dasharray: none; }
	.det { fill: rgba(45, 226, 197, 0.16); stroke: #2de2c5; stroke-width: 4; }
	.det.false { fill: rgba(242, 181, 68, 0.22); stroke: #f2b544; }
</style>
