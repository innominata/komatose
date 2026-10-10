<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import KanaEntryPanel from './KanaEntryPanel.svelte';
  import KoreanEntryPanel from './KoreanEntryPanel.svelte';
  let { lang, ...props }: ComponentProps<typeof KanaEntryPanel> & { lang: string } = $props();
</script>

{#if lang === 'japanese'}
  <KanaEntryPanel {...props} />
{:else if lang === 'korean'}
  <KoreanEntryPanel {...props} />
{/if}
