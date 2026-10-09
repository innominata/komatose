<script lang="ts">
  import type { TranscriptionDecision } from '$lib/decider';
  let { decision, stale = false }: { decision: TranscriptionDecision; stale?: boolean } = $props();
  const percentage = (value: number) => `${(value * 100).toFixed(1)}%`;
</script>
<details class="decider-result">
  <summary>{decision.modelName} · {stale ? 'past decision' : decision.status === 'accepted' ? (decision.applied ? 'reading selected' : 'preferred reading · saved for review') : 'needs review'}{decision.confidence ? ` · ${percentage(decision.confidence)}` : ''}</summary>
  {#if stale}<p>The region or source has changed since this decision.</p>{/if}
  {#if decision.error}<p>{decision.error}</p>{/if}
  {#each decision.candidates as candidate}
    <p class:chosen={candidate.id === decision.choice}><span>{candidate.id}: {candidate.source}</span> <small>{decision.probabilities[candidate.id] === undefined ? '—' : percentage(decision.probabilities[candidate.id])}</small></p>
  {/each}
  {#if Object.keys(decision.probabilities).length}
    <p><span>None match</span> <small>{percentage(decision.probabilities.none)}</small></p>
    <p><span>Too unclear</span> <small>{percentage(decision.probabilities.unclear)}</small></p>
    <p>Lead {percentage(decision.margin)} · requires {percentage(decision.minProbability)} probability and {percentage(decision.minMargin)} lead.</p>
  {/if}
</details>
<style>
  .decider-result { margin: .5rem 0; padding: .6rem; border: 1px solid var(--border, #555); border-radius: .4rem; font-size: .85rem; }
  summary { cursor: pointer; }
  p { display: flex; justify-content: space-between; gap: .7rem; margin: .4rem 0; }
  .chosen { font-weight: 700; }
  small { white-space: nowrap; }
</style>
