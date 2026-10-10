<script lang="ts">
	import logoDark from '$lib/assets/komatose-logo.png';
	import logoLight from '$lib/assets/komatose-logo-light.png';
	import { APP_NAME } from '$lib/brand';

	let { class: className = 'app-brand' }: { class?: string } = $props();
</script>

<a href="/" class={className} aria-label={APP_NAME}>
	<img class="logo-dark" src={logoDark} alt="" width="613" height="193" />
	<img class="logo-light" src={logoLight} alt="" width="613" height="193" />
</a>
