<script lang="ts">
  import { glossaryHits, textHasTerm } from "$lib/glossary";
  import type { GlossaryTerm } from "$lib/types";

  let {
    source = "",
    english = "",
    terms = [],
  }: {
    source?: string;
    english?: string;
    terms?: GlossaryTerm[];
  } = $props();

  const hits = $derived(glossaryHits(terms, source));

  function chipState(term: GlossaryTerm): "pending" | "present" | "missing" {
    const en = english.trim();
    if (!en) return "pending";
    return textHasTerm(en, term.translation) ? "present" : "missing";
  }
</script>

{#if hits.length}
  <div class="glossary-chips">
    <small>Glossary in source</small>
    <ul aria-label="Glossary terms in source">
      {#each hits as term}
        {@const state = chipState(term)}
        <li class={state} title={state === "missing"
          ? `${term.translation} is not in the English draft`
          : state === "present"
            ? "English already uses this term"
            : "Source contains this series term"}>
          <span class="src">{term.source}</span>
          <span aria-hidden="true">→</span>
          <span class="en">{term.translation}</span>
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  .glossary-chips {
    margin: 0 0 8px;
  }
  .glossary-chips small {
    display: block;
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--hud-muted, #9a8f7a);
    margin-bottom: 4px;
  }
  ul {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    padding: 2px 8px;
    font-size: 12px;
    font-weight: 500;
    line-height: 1.4;
    color: var(--hud-text, #ecddbd);
    border: 1px solid var(--hud-line, #4a4338);
    border-radius: 999px;
    background: var(--hud-bg-2);
  }
  li.present {
    color: var(--accent, var(--ed-active, var(--hud-teal)));
    border-color: var(--accent, var(--ed-active, var(--hud-teal)));
  }
  li.missing {
    color: #ffc283;
    border-color: #d8ae70;
  }
  .src {
    font-weight: 600;
  }
  .en {
    color: inherit;
  }
</style>
