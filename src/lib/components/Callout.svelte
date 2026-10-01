<script lang="ts">
	import { LINE_COLORS } from '$lib/lineColors';
	import { LINE_TYPE_LABELS, type LineRow, type LineType } from '$lib/types';

	let {
		line,
		editable = false,
		compact = false,
		draggableNote = false,
		editing = false,
		latestComment = null,
		mainText = null,
		redText = undefined,
		guest = false,
		onbody,
		oneditend,
		ondragstart,
		ondragend
	}: {
		line: LineRow;
		editable?: boolean;
		compact?: boolean;
		draggableNote?: boolean;
		editing?: boolean;
		latestComment?: string | null;
		mainText?: string | null;
		redText?: string | null;
		guest?: boolean;
		onbody?: (body: string) => void;
		oneditend?: () => void;
		ondragstart?: (e: DragEvent) => void;
		ondragend?: (e: DragEvent) => void;
	} = $props();

	const color = $derived(LINE_COLORS[line.lineType as LineType] || '#2de2c5');
	const shown = $derived(mainText ?? line.body);
	const footnote = $derived(redText !== undefined ? redText : latestComment);
</script>

<div
	class="callout"
	class:compact
	style="--accent:{color};{compact
		? ''
		: ` height:${line.sidebarH ? Math.max(72, line.sidebarH * 220) + 'px' : 'auto'}`}"
	draggable={editable && draggableNote && !editing}
	{ondragstart}
	{ondragend}
>
	<div class="d-flex justify-content-between gap-2 mb-1">
		<span class="hud-kicker mb-0" style="color:{color}">{LINE_TYPE_LABELS[line.lineType]}</span>
		{#if !guest && line.status === 'approved'}
			<span class="status-pill on">Approved</span>
		{:else if !guest && line.status === 'needs_work'}
			<span class="status-pill">Needs work</span>
		{/if}
	</div>
	{#if compact}
		{#if editing}
			<textarea
				class="callout-body cause-sticky"
				value={shown}
				autofocus
				oninput={(e) => onbody?.(e.currentTarget.value)}
				onblur={() => oneditend?.()}
				onkeydown={(e) => {
					if (e.key === 'Escape') {
						e.preventDefault();
						(e.currentTarget as HTMLTextAreaElement).blur();
					}
				}}
				onpointerdown={(e) => e.stopPropagation()}
				rows={2}
			></textarea>
		{:else}
			<div class="callout-body cause-sticky">{shown}</div>
		{/if}
	{:else if editable}
		<textarea
			class="callout-body cause-sticky"
			value={shown}
			oninput={(e) => onbody?.(e.currentTarget.value)}
			rows={3}
		></textarea>
	{:else}
		<div class="callout-body cause-sticky">{shown}</div>
	{/if}
	{#if footnote}
		<div class="callout-latest">{footnote}</div>
	{/if}
</div>
