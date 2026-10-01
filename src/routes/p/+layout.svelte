<script lang="ts">
	let { children } = $props();
</script>

{@render children()}

<style>
	:global(html),
	:global(body) {
		overflow: auto;
		height: auto;
		min-height: 100%;
	}
</style>
