<script lang="ts">
	import type { ImageRow } from '$lib/types';

	let {
		image,
		index = 0,
		total = 0,
		canEdit = false,
		canDescribe = false,
		canDelete = false,
		canRetranslate = false,
		describing = false,
		missing = false,
		oncaption,
		ondescribe,
		ondelete,
		onretranslate,
		onreplace
	}: {
		image: ImageRow | null;
		index?: number;
		total?: number;
		canEdit?: boolean;
		canDescribe?: boolean;
		canDelete?: boolean;
		canRetranslate?: boolean;
		describing?: boolean;
		missing?: boolean;
		oncaption: (text: string) => void;
		ondescribe: () => void;
		ondelete?: () => void;
		onretranslate?: () => void;
		onreplace?: () => void;
	} = $props();
</script>

{#if image}
	<div class="page-meta">
		<div class="hud-kicker mb-0">Page {index + 1} of {total}</div>
		<div class="page-meta-name" title={image.originalName}>{image.originalName}</div>
		{#if missing}
			<p class="missing-note">The image file is gone. Delete this page slot to drop it from the chapter.</p>
		{/if}
		<dl class="page-meta-dl">
			<div>
				<dt>Size</dt>
				<dd>{image.width} × {image.height}</dd>
			</div>
			<div>
				<dt>File</dt>
				<dd>{image.filename}</dd>
			</div>
		</dl>
		<label class="hud-kicker mb-1" for="page-caption-field">Scene note</label>
		<textarea
			id="page-caption-field"
			class="form-control"
			rows="5"
			disabled={!canEdit || describing}
			value={image.caption}
			placeholder="Who is visible, where they are, what is happening, and the mood. Do not quote lettering."
			oninput={(e) => oncaption(e.currentTarget.value)}
		></textarea>
		{#if canDescribe && !missing}
			<button class="ed-btn mt-2" type="button" data-find="describe-page" disabled={describing} onclick={() => ondescribe()}>
				{describing ? 'Describing…' : image.caption.trim() ? 'Refresh scene context' : 'Generate scene context (optional)'}
			</button>
		{/if}
		{#if canRetranslate && !missing}
			<button class="ed-btn mt-2" type="button" disabled={describing} onclick={() => onretranslate?.()}>
				Translate page
			</button>
		{/if}
		{#if canDelete}
			<button class="ed-btn danger mt-2" type="button" disabled={describing} onclick={() => ondelete?.()}>
				Delete page
			</button>
		{/if}
		{#if onreplace}
			<button class="ed-btn mt-2" type="button" data-find="replace-file" onclick={() => onreplace?.()}>Replace from image / PSD</button>
		{/if}
		<p class="hud-kicker mb-0 mt-2">Translators see this. It is not drawn on the page.</p>
	</div>
{:else}
	<div class="page-meta">
		<div class="hud-kicker">No page selected</div>
		<p class="small text-secondary mb-0">Click a page on the strip to see its size and scene note.</p>
	</div>
{/if}

<style>
	.page-meta {
		display: grid;
		gap: 0.45rem;
		padding: 0.85rem 1rem;
	}
	.page-meta-name {
		font-size: 0.92rem;
		word-break: break-all;
	}
	.page-meta-dl {
		display: grid;
		gap: 0.35rem;
		margin: 0 0 0.4rem;
	}
	.page-meta-dl div {
		display: grid;
		grid-template-columns: 3.4rem 1fr;
		gap: 0.4rem;
		font-size: 0.78rem;
	}
	.page-meta-dl dt {
		margin: 0;
		color: var(--ed-muted, #9a9a9a);
		font-weight: 500;
	}
	.page-meta-dl dd {
		margin: 0;
		word-break: break-all;
	}
	.missing-note {
		margin: 0;
		font-size: 0.78rem;
		color: #e8b4b8;
	}
</style>
