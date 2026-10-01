<script lang="ts">
	import { workCredit } from "$lib/workCredit";

	let { title, compact = false }: { title: string; compact?: boolean } = $props();
	const credit = $derived(workCredit(title));
</script>

{#if credit}
	<p class="work-credit" class:compact data-work-credit>
		{#each credit.lines as line (line)}
			<span>{line}</span>
		{/each}
	</p>
{/if}

<style>
	.work-credit {
		display: flex;
		flex-direction: column;
		gap: 0.05rem;
		margin: 0.35rem 0 0;
		color: var(--hud-muted, #8b95a5);
		font-size: 0.82rem;
		line-height: 1.35;
		letter-spacing: 0;
		text-transform: none;
	}

	.work-credit.compact {
		flex-flow: row wrap;
		gap: 0.15rem 0.75rem;
		margin: 0;
		max-width: 36rem;
		font-size: 0.72rem;
	}
</style>
