<script lang="ts">
	import type { ImageRow } from '$lib/types';

	let {
		images,
		imageSrc
	}: {
		images: ImageRow[];
		imageSrc: (id: string) => string;
	} = $props();
</script>

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
	.empty {
		color: var(--hud-muted);
		text-align: center;
		padding: 4rem 1rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		font-size: 0.8rem;
	}
</style>
