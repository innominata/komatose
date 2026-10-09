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
		if (patch.kind === 'character' && !terms[i].id) patch.id = crypto.randomUUID();
		const next = terms.map((t, idx) => (idx === i ? { ...t, ...patch, edited: true } : t));
		onchange(next);
	}

	function remove(i: number) {
		onchange(terms.filter((_, idx) => idx !== i));
	}

	function add() {
		onchange([...terms, { source: '', translation: '', edited: true }]);
	}
	function addCharacter() {
		onchange([...terms, { id: crypto.randomUUID(), kind: 'character', source: '', translation: '', edited: true }]);
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
				aria-label="Original spelling"
				onchange={(e) => update(i, { source: e.currentTarget.value })}
			/>
			<input
				class="form-control form-control-sm"
				placeholder="English"
				value={term.translation}
				{disabled}
				aria-label="Preferred English spelling"
				onchange={(e) => update(i, { translation: e.currentTarget.value })}
			/>
			<select class="form-control form-control-sm" aria-label="Glossary entry type" value={term.kind || 'term'} {disabled}
				onchange={e => update(i, { kind: e.currentTarget.value === 'character' ? 'character' : undefined })}>
				<option value="term">Term</option><option value="character">Character</option>
			</select>
			<button class="ed-btn" type="button" {disabled} onclick={() => remove(i)} title="Remove">×</button>
			{#if term.kind === 'character'}
				<label class="character-detail">Other English spellings to recognize<input class="form-control form-control-sm" value={(term.aliases ?? []).join(', ')} placeholder="Park Mooyeol, Park Mu-yeol" {disabled}
					onchange={e => update(i, { aliases: e.currentTarget.value.split(/[,;\n]/).map(value => value.trim()).filter(Boolean) })} /></label>
				<label class="character-detail">Character / voice notes<input class="form-control form-control-sm" value={term.notes || ''} placeholder="Optional: relationships, pronouns, way of speaking" {disabled}
					onchange={e => update(i, { notes: e.currentTarget.value })} /></label>
			{/if}
		</div>
	{/each}
	<button class="ed-btn" type="button" {disabled} onclick={add}>Add term</button>
	<button class="ed-btn" type="button" {disabled} onclick={addCharacter}>Add character</button>
	<p class="hint">Character names use the preferred English spelling across chapters. Record the original name when known; do not guess it. Assign speakers in Review. Changes save when you leave a field.</p>
	<p class="hint">For Korean names, choose one given-name spelling and hyphenation consistently. <a href="https://www.korean.go.kr/front_eng/roman/roman_01.do" target="_blank" rel="noreferrer">Official romanization guidance</a></p>
</div>

<style>
	.glossary-edit {
		container-type: inline-size;
		display: grid;
		gap: 0.35rem;
	}
	.glossary-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 100px auto;
		gap: 0.35rem;
		align-items: center;
	}
	.character-detail { grid-column: 1 / -1; font-size: 11px; color: var(--hud-muted); }
	.hint { margin: 4px 0; font-size: 11px; color: var(--hud-muted); }
	@container (max-width: 380px) {
		.glossary-row { grid-template-columns: minmax(0, 1fr) auto; }
		.glossary-row > input { grid-column: 1 / -1; }
	}
</style>
