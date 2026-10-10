<script lang="ts">
	import StripPreview from '$lib/components/StripPreview.svelte';
	import WorkCredit from '$lib/components/WorkCredit.svelte';
	import { APP_NAME } from '$lib/brand';

	let { data } = $props();
</script>

<svelte:head>
	<title>{data.seriesTitle} · {data.episodeTitle} · {APP_NAME}</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="preview">
	<WorkCredit title={data.seriesTitle} />
	<StripPreview
		images={data.images}
		imageSrc={(id) => {
			const img = data.images.find((i) => i.id === id);
			return `/p/${data.token}/i/${id}?v=${img?.updatedAt || img?.createdAt || 0}`;
		}}
	/>
</div>

<style>
	.preview {
		min-height: 100vh;
		background: var(--hud-canvas);
		padding: 0.75rem 1rem 3rem;
		overflow-x: auto;
	}
</style>
