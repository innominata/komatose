<script lang="ts">
	import StripPreview from '$lib/components/StripPreview.svelte';
	import WorkCredit from '$lib/components/WorkCredit.svelte';
	import { APP_NAME } from '$lib/brand';
	import { parseSeriesCreditImageId } from '$lib/credits';

	let { data } = $props();

	const RAW_KEY = 'preview-raw-side-by-side';
	let sideBySide = $state(true);
	$effect(() => {
		try {
			if (localStorage.getItem(RAW_KEY) === '0') sideBySide = false;
		} catch {
			/* storage unavailable: keep the default */
		}
	});
	function setSideBySide(on: boolean) {
		sideBySide = on;
		try {
			localStorage.setItem(RAW_KEY, on ? '1' : '0');
		} catch {
			/* not remembered */
		}
	}
	const version = (id: string) => {
		const img = data.images.find((i) => i.id === id);
		return img?.updatedAt || img?.createdAt || 0;
	};
</script>

<svelte:head>
	<title>{data.seriesTitle} · {data.episodeTitle} · {APP_NAME}</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="preview">
	<div class="preview-bar">
		<WorkCredit title={data.seriesTitle} />
		{#if data.images.length}
			<label class="raw-toggle">
				<input type="checkbox" checked={sideBySide} onchange={(e) => setSideBySide(e.currentTarget.checked)} />
				Raw side by side
			</label>
		{/if}
	</div>
	<StripPreview
		images={data.images}
		imageSrc={(id) => `/p/${data.token}/i/${id}?v=${version(id)}`}
		rawSrc={sideBySide
			? (id) => (parseSeriesCreditImageId(id) ? null : `/p/${data.token}/i/${id}?raw=1&v=${version(id)}`)
			: undefined}
	/>
</div>

<style>
	.preview {
		min-height: 100vh;
		background: var(--hud-canvas);
		padding: 0.75rem 1rem 3rem;
		overflow-x: auto;
	}
	.preview-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.5rem 1rem;
		margin-bottom: 0.75rem;
	}
	.raw-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		margin-left: auto;
		color: var(--hud-text);
		font-size: 0.85rem;
		cursor: pointer;
	}
</style>
