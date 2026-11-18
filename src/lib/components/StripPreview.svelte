<script lang="ts">
	import type { ImageRow } from '$lib/types';

	let {
		images,
		imageSrc,
		rawSrc
	}: {
		images: ImageRow[];
		imageSrc: (id: string) => string;
		/** When given, each page shows its raw beside it (null for a page without one). */
		rawSrc?: (id: string) => string | null;
	} = $props();
</script>

{#if rawSrc}
	<div class="pairs">
		{#if images.length}
			<div class="pair-head" aria-hidden="true" style="--w: {images[0].width}px"><span>Raw</span><span>Finished</span></div>
		{/if}
		{#each images as img (img.id)}
			{@const raw = rawSrc(img.id)}
			<div class="pair" id="img-{img.id}" style="--w: {img.width}px">
				{#if raw}
					<img
						src={raw}
						alt="Raw {img.originalName}"
						width={img.width}
						height={img.height}
						draggable="false"
						loading="lazy"
					/>
				{/if}
				<img
					class:solo={!raw}
					src={imageSrc(img.id)}
					alt={img.originalName}
					width={img.width}
					height={img.height}
					draggable="false"
					loading="lazy"
				/>
			</div>
		{:else}
			<div class="empty">No pages in this chapter yet.</div>
		{/each}
	</div>
{:else}
	<div class="strip">
		{#each images as img (img.id)}
			<div class="strip-image" id="img-{img.id}">
				<img
					src={imageSrc(img.id)}
					alt={img.originalName}
					width={img.width}
					height={img.height}
					style="width: {img.width}px; height: {img.height}px"
					draggable="false"
					loading="lazy"
				/>
			</div>
		{:else}
			<div class="empty">No pages in this chapter yet.</div>
		{/each}
	</div>
{/if}

<style>
	.strip {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		width: max-content;
		min-width: 100%;
		margin: 0 auto;
	}
	.strip-image {
		position: relative;
		display: block;
		width: max-content;
	}
	.strip-image img {
		display: block;
		max-width: none;
		pointer-events: none;
	}
	/* Side by side: each page and its raw share the width, never larger than actual size. */
	.pairs {
		display: flex;
		flex-direction: column;
		align-items: center;
		width: 100%;
	}
	.pair-head,
	.pair {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
		width: min(100%, calc(var(--w, 900px) * 2 + 12px));
	}
	.pair-head {
		padding: 6px 0;
		color: var(--hud-muted);
		font: 600 0.75rem/1 Inter, system-ui, sans-serif;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		text-align: center;
	}
	.pair img {
		display: block;
		width: 100%;
		height: auto;
		pointer-events: none;
	}
	.pair img.solo {
		grid-column: 1 / -1;
		justify-self: center;
		width: calc(50% - 6px);
	}
	.empty {
		color: var(--hud-muted);
		text-align: center;
		padding: 4rem 1rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		font-size: 0.8rem;
	}
</style>
