<script lang="ts">
	import type { GlossaryTerm } from '$lib/types';

	let {
		terms,
		onchange,
		disabled = false
	}: {
		terms: GlossaryTerm[];
		onchange: (next: GlossaryTerm[]) => void;
		disabled?: boolean;
	} = $props();

	function update(i: number, patch: Partial<GlossaryTerm>) {
		const next = terms.map((t, idx) => (idx === i ? { ...t, ...patch, edited: true } : t));
		onchange(next);
	}

	function remove(i: number) {
		onchange(terms.filter((_, idx) => idx !== i));
	}

	function add() {
		onchange([...terms, { source: '', translation: '', edited: true }]);
	}
</script>

<div class="glossary-edit">
	{#each terms as term, i}
		<div class="glossary-row">
			<input
				class="form-control form-control-sm"
				placeholder="Source"
				value={term.source}
				{disabled}
				oninput={(e) => update(i, { source: e.currentTarget.value })}
			/>
			<input
				class="form-control form-control-sm"
				placeholder="English"
				value={term.translation}
				{disabled}
				oninput={(e) => update(i, { translation: e.currentTarget.value })}
			/>
			<button class="ed-btn" type="button" {disabled} onclick={() => remove(i)} title="Remove">×</button>
		</div>
	{/each}
	<button class="ed-btn" type="button" {disabled} onclick={add}>Add term</button>
</div>

<style>
	.glossary-edit {
		display: grid;
		gap: 0.35rem;
	}
	.glossary-row {
		display: grid;
		grid-template-columns: 1fr 1fr auto;
		gap: 0.35rem;
		align-items: center;
	}
</style>
