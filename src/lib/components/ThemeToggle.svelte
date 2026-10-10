<script lang="ts">
	import { onMount } from 'svelte';
	import { cycleTheme, themeChoice, themeLabel } from '$lib/theme.svelte';

	let ready = $state(false);
	const label = $derived(ready ? `Theme: ${themeLabel(themeChoice.value)}` : 'Theme');

	onMount(() => {
		ready = true;
	});

	function cycle() {
		cycleTheme();
	}
</script>

<button class="theme-toggle" type="button" aria-label={label} title="{label} (click to change)" onclick={cycle}>
	<svg class="theme-ico theme-ico-sun" viewBox="0 0 24 24" aria-hidden="true">
		<circle cx="12" cy="12" r="4" />
		<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
	</svg>
	<svg class="theme-ico theme-ico-moon" viewBox="0 0 24 24" aria-hidden="true">
		<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
	</svg>
</button>
