<script lang="ts">
  import { tick } from "svelte";
  import { extraKana, kanaGrid, type KanaScript } from "$lib/kanaChart";
  import { glossaryKanjiTerms } from "$lib/glossary";
  import type { GlossaryTerm } from "$lib/types";
  import SourceRomanization from "./SourceRomanization.svelte";
  import KanjiScratchpad from "./KanjiScratchpad.svelte";

  let {
    source = "",
    glossary = [],
    canEdit = true,
    embedded = false,
    onapply,
    oncancel,
    onreadDrawing,
  }: {
    source?: string;
    glossary?: GlossaryTerm[];
    canEdit?: boolean;
    embedded?: boolean;
    onapply: (text: string) => void;
    oncancel?: () => void;
    onreadDrawing?: (image: string, signal: AbortSignal) => Promise<{ source: string }>;
  } = $props();

  let open = $state(false);
  let draft = $state(source ?? "");
  let box = $state<HTMLTextAreaElement>();
  let script = $state<KanaScript>("hiragana");
  let diacritic = $state(false);
  let digraph = $state(false);
  const shown = $derived(embedded || open);
  const grid = $derived(kanaGrid({ script, diacritic, digraph }));
  const extras = $derived(extraKana({ script }));
  const kanjiTerms = $derived(glossaryKanjiTerms(glossary));

  function resetDraft() {
    draft = source ?? "";
    script = "hiragana";
    diacritic = false;
    digraph = false;
  }

  function show() {
    resetDraft();
    open = true;
  }

  function cancel() {
    open = false;
    draft = source ?? "";
    oncancel?.();
  }

  function apply() {
    onapply(draft);
    open = false;
    oncancel?.();
  }

  async function insert(text: string) {
    const el = box;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? draft.length;
    draft = draft.slice(0, start) + text + draft.slice(end);
    await tick();
    el?.focus();
    const pos = start + text.length;
    el?.setSelectionRange(pos, pos);
  }

  function backspace() {
    const el = box;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? draft.length;
    if (start !== end) {
      draft = draft.slice(0, start) + draft.slice(end);
      void tick().then(() => {
        el?.focus();
        el?.setSelectionRange(start, start);
      });
      return;
    }
    if (!start) return;
    draft = draft.slice(0, start - 1) + draft.slice(start);
    void tick().then(() => {
      el?.focus();
      el?.setSelectionRange(start - 1, start - 1);
    });
  }
</script>

<div class="kana-entry" class:embedded>
  {#if !shown}
    <button type="button" disabled={!canEdit} onclick={show}>Enter characters</button>
  {:else}
    <div class="panel">
      <label class="compose"
        >Characters<textarea
          bind:this={box}
          bind:value={draft}
          rows="2"
          disabled={!canEdit}
        ></textarea></label
      >
      <SourceRomanization text={draft} />
      <div class="modes">
        <button
          type="button"
          aria-pressed={script === "katakana"}
          onclick={() => (script = script === "hiragana" ? "katakana" : "hiragana")}
          >{script === "hiragana" ? "Katakana" : "Hiragana"}</button
        >
        <button
          type="button"
          aria-pressed={diacritic}
          onclick={() => (diacritic = !diacritic)}>Diacritic</button
        >
        <button type="button" aria-pressed={digraph} onclick={() => (digraph = !digraph)}
          >Digraph</button
        >
      </div>
      <div class="grid" role="group" aria-label="Kana keys">
        {#each grid as row}
          <div class="row">
            {#each row as key}
              {#if key.empty}
                <span class="spacer" aria-hidden="true"></span>
              {:else}
                <button
                  type="button"
                  class="kana-key"
                  disabled={!canEdit}
                  aria-label={`${key.glyph} ${key.romaji}`}
                  onclick={() => void insert(key.glyph)}
                  ><span class="glyph">{key.glyph}</span><span class="romaji">{key.romaji}</span
                  ></button
                >
              {/if}
            {/each}
          </div>
        {/each}
      </div>
      <div class="extras" role="group" aria-label="Extra kana">
        {#each extras as key}
          <button
            type="button"
            class="kana-key"
            disabled={!canEdit}
            aria-label={`${key.glyph} ${key.romaji}`}
            onclick={() => void insert(key.glyph)}
            ><span class="glyph">{key.glyph}</span><span class="romaji">{key.romaji}</span></button
          >
        {/each}
        <button type="button" disabled={!canEdit || !draft} onclick={backspace}>Backspace</button>
        <button type="button" disabled={!canEdit || !draft} onclick={() => (draft = "")}>Clear</button>
      </div>
      {#if kanjiTerms.length}
        <div class="glossary-keys" role="group" aria-label="Glossary kanji">
          <small>Glossary</small>
          <div class="glossary-row">
            {#each kanjiTerms as term}
              <button
                type="button"
                class="kana-key glossary"
                disabled={!canEdit}
                title={term.translation}
                aria-label={`${term.source} ${term.translation}`}
                onclick={() => void insert(term.source)}
                ><span class="glyph">{term.source}</span><SourceRomanization text={term.source} /></button
              >
            {/each}
          </div>
        </div>
      {/if}
      {#if onreadDrawing}
        <KanjiScratchpad
          disabled={!canEdit}
          onread={onreadDrawing}
          onaccept={(text) => {
            if (text) void insert(text);
          }}
        />
      {/if}
      <div class="actions">
        <button type="button" class="primary" disabled={!canEdit} onclick={apply}
          >Apply to source</button
        >
        <button type="button" onclick={cancel}>Cancel</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .kana-entry {
    --jp-text: "Noto Sans JP", "Hiragino Sans", "Yu Gothic", "Noto Sans CJK JP",
      sans-serif;
  }
  .kana-entry.embedded {
    min-height: 0;
    height: 100%;
  }
  .kana-entry.embedded .panel {
    height: 100%;
    overflow: auto;
    box-sizing: border-box;
    margin-top: 0;
  }
  .panel {
    display: grid;
    gap: 8px;
    margin-top: 6px;
    padding: 8px;
    border: 1px solid var(--hud-line, #4a4338);
    border-radius: 2px;
    background: var(--hud-bg, #1c1914);
    align-content: start;
  }
  .compose {
    display: grid;
    gap: 4px;
    color: var(--hud-muted, #9a8f7a);
    font-size: 12px;
  }
  textarea {
    width: 100%;
    background: var(--hud-input-bg, #12100c);
    border: 1px solid var(--hud-line, #4a4338);
    border-radius: 2px;
    color: var(--hud-text, #ecddbd);
    padding: 4px 6px;
    resize: vertical;
    font-family: var(--jp-text);
    font-weight: 400;
  }
  .modes,
  .extras,
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .grid {
    display: grid;
    gap: 4px;
  }
  .row,
  .glossary-row {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 4px;
  }
  .glossary-row {
    grid-template-columns: repeat(auto-fill, minmax(3.4rem, 1fr));
  }
  .kana-key {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 2.6rem;
    padding: 3px 2px;
    text-transform: none;
    letter-spacing: 0;
    font-family: inherit;
    font-weight: 400;
    line-height: 1.15;
  }
  .glyph {
    font-family: var(--jp-text);
    font-size: 1.2rem;
    font-weight: 400;
    color: var(--hud-text, #ecddbd);
  }
  .romaji {
    font-family: Inter, system-ui, sans-serif;
    font-size: 10px;
    font-style: italic;
    font-weight: 400;
    color: var(--hud-muted, #9a8f7a);
    text-transform: none;
  }
  .spacer {
    min-height: 2.6rem;
  }
  .glossary-keys small {
    display: block;
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--hud-muted, #9a8f7a);
    margin-bottom: 4px;
  }
  .glossary :global(.source-romaji) {
    margin: 0;
    font-size: 10px;
  }
</style>
