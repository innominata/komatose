<script lang="ts">
  import { tick, untrack } from 'svelte';
  import type { GlossaryTerm } from '$lib/types';
  import { HANGUL_INITIALS, HANGUL_VOWELS, HANGUL_FINALS, composeHangul, koreanGlossaryTerms, replaceEntrySelection, deleteEntrySelection } from '$lib/hangulEntry';
  import SourceRomanization from './SourceRomanization.svelte';

  let { source = '', glossary = [], canEdit = true, embedded = false, onapply, oncancel }: {
    source?: string; glossary?: GlossaryTerm[]; canEdit?: boolean; embedded?: boolean;
    onapply: (text: string) => void; oncancel?: () => void;
  } = $props();
  let open = $state(false);
  let draft = $state(untrack(() => source));
  let box = $state<HTMLTextAreaElement>();
  let initial = $state(-1);
  let vowel = $state(-1);
  let final = $state(0);
  const preview = $derived(composeHangul(initial, vowel, final));
  const terms = $derived(koreanGlossaryTerms(glossary));
  const groups = $derived([
    { label: 'Initial consonant', keys: HANGUL_INITIALS, selected: initial, choose: (i: number) => initial = i },
    { label: 'Vowel', keys: HANGUL_VOWELS, selected: vowel, choose: (i: number) => vowel = i },
    { label: 'Final consonant', keys: HANGUL_FINALS, selected: final, choose: (i: number) => final = i },
  ]);
  function show() {
    draft = source;
    initial = vowel = -1;
    final = 0;
    open = true;
  }
  function cancel() { open = false; draft = source; oncancel?.(); }
  function apply() { if (!canEdit) return; onapply(draft); open = false; oncancel?.(); }
  async function edit(inserted: string, remove = false) {
    if (!canEdit) return;
    const el = box;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? draft.length;
    const next = remove ? deleteEntrySelection(draft, start, end) : replaceEntrySelection(draft, start, end, inserted);
    draft = next.text;
    await tick();
    el?.focus();
    el?.setSelectionRange(next.caret, next.caret);
  }
</script>

<div class="korean-entry" class:embedded>
  {#if !(embedded || open)}
    <button type="button" disabled={!canEdit} onclick={show}>Enter characters</button>
  {:else}
    <div class="panel">
      <label class="compose">Characters<textarea bind:this={box} bind:value={draft} lang="ko" rows="2" disabled={!canEdit}></textarea></label>
      <SourceRomanization text={draft} />
      <p class="hint">Choose an initial consonant, vowel, and optional final consonant. Use ㅇ for a syllable starting with a vowel.</p>
      <div class="preview-row">
        <output aria-label="Syllable preview" aria-live="polite" lang="ko">{preview || '—'}</output>
        <button type="button" disabled={!canEdit || !preview} onclick={() => void edit(preview)}>Insert syllable</button>
        <button type="button" disabled={!canEdit} onclick={() => { initial = vowel = -1; final = 0; }}>Reset syllable</button>
      </div>
      {#each groups as group}
        <fieldset disabled={!canEdit}>
          <legend>{group.label}</legend>
          <div class="keys">
            {#each group.keys as key, i}
              <button type="button" aria-label={`${group.label}: ${key.glyph || 'None'} ${key.glyph ? key.reading : ''}`.trim()}
                aria-pressed={group.selected === i} onclick={() => group.choose(i)}>
                <span lang="ko" class="glyph">{key.glyph || 'None'}</span>
                {#if key.glyph}<small>{key.reading}</small>{/if}
              </button>
            {/each}
          </div>
        </fieldset>
      {/each}
      <div class="actions" role="group" aria-label="Standalone letters">
        <span class="hint">Standalone letter</span>
        <button type="button" disabled={!canEdit || initial < 0} onclick={() => void edit(HANGUL_INITIALS[initial].glyph)}>Insert consonant</button>
        <button type="button" disabled={!canEdit || vowel < 0} onclick={() => void edit(HANGUL_VOWELS[vowel].glyph)}>Insert vowel</button>
      </div>
      <div class="actions" role="group" aria-label="Spacing and punctuation">
        {#each [{ text: ' ', label: 'Space' }, { text: '\n', label: 'Newline' }, ...['.', ',', '!', '?', '…', '—', '·'].map(text => ({ text, label: text }))] as key}
          <button type="button" disabled={!canEdit} onclick={() => void edit(key.text)}>{key.label}</button>
        {/each}
        <button type="button" disabled={!canEdit || !draft} onclick={() => void edit('', true)}>Backspace</button>
        <button type="button" disabled={!canEdit || !draft} onclick={() => { draft = ''; box?.focus(); }}>Clear</button>
      </div>
      {#if terms.length}
        <div class="actions" role="group" aria-label="Korean glossary">
          <span class="hint">Glossary</span>
          {#each terms as term}
            <button type="button" disabled={!canEdit} title={term.translation} onclick={() => void edit(term.source)}><span lang="ko">{term.source}</span></button>
          {/each}
        </div>
      {/if}
      <div class="actions">
        <button type="button" class="primary" disabled={!canEdit} onclick={apply}>Apply to source</button>
        <button type="button" onclick={cancel}>Cancel</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .korean-entry { --ko-text: 'Noto Sans KR', 'Malgun Gothic', 'Apple SD Gothic Neo', 'Noto Sans CJK KR', sans-serif; }
  .embedded { height: 100%; min-height: 0; }
  .panel { display: grid; gap: 8px; padding: 8px; margin-top: 6px; border: 1px solid var(--hud-line, #4a4338); background: var(--hud-bg, #1c1914); align-content: start; }
  .embedded .panel { height: 100%; overflow: auto; box-sizing: border-box; margin-top: 0; }
  .compose { display: grid; gap: 4px; font-size: 12px; }
  textarea { width: 100%; box-sizing: border-box; resize: vertical; padding: 6px; font-family: var(--ko-text); color: var(--hud-text, #ecddbd); background: var(--hud-input-bg, #12100c); border: 1px solid var(--hud-line, #4a4338); }
  .hint { font-size: 12px; color: var(--hud-muted, #9a8f7a); margin: 0; }
  fieldset { min-width: 0; margin: 0; padding: 6px; border: 1px solid var(--hud-line, #4a4338); }
  legend { font-size: 12px; }
  .keys { display: grid; grid-template-columns: repeat(auto-fit, minmax(2.5rem, 1fr)); gap: 4px; }
  .keys button { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 2.7rem; padding: 3px; }
  button { text-transform: none; letter-spacing: 0; }
  button[aria-pressed='true'] { outline: 2px solid var(--hud-accent, #2de2c5); outline-offset: -2px; }
  .glyph { font-family: var(--ko-text); font-size: 1.2rem; }
  small { font-size: 10px; font-weight: normal; }
  .actions, .preview-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  output { font-family: var(--ko-text); font-size: 2.5rem; min-width: 1.5em; text-align: center; }
</style>
