<script lang="ts">
	import logo from '$lib/assets/komatose-logo.png';
	import { APP_NAME } from '$lib/brand';

	let { class: className = 'app-brand' }: { class?: string } = $props();
</script>

<a href="/" class={className} aria-label={APP_NAME}>
	<img src={logo} alt="" width="613" height="193" />
</a>
