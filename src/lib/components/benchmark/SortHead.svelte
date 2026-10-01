<script lang="ts">
	import { ariaSort, type SortDir } from '$lib/benchmarkSort';

	let { label, col, sortKey, dir, prefer = 'desc', onsort }: {
		label: string;
		col: string;
		sortKey: string;
		dir: SortDir;
		prefer?: SortDir;
		onsort: (key: string, prefer: SortDir) => void;
	} = $props();

	const active = $derived(sortKey === col);
</script>

<th aria-sort={ariaSort(active, dir)}>
	<button type="button" class="sort" class:on={active} onclick={() => onsort(col, prefer)}>
		{label}{#if active}<span class="caret" aria-hidden="true">{dir === 'asc' ? '↑' : '↓'}</span>{/if}
	</button>
</th>
