<script lang="ts">
	import { APP_NAME } from '$lib/brand';
	import AppBrand from '$lib/components/AppBrand.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	let { form } = $props();
</script>

<svelte:head>
	<title>Sign In · {APP_NAME}</title>
</svelte:head>

<div class="hud-cover">
	<div class="hud-cover-tools"><ThemeToggle /></div>
	<div class="hud-globe"></div>
	<div class="hud-auth">
		<AppBrand />
		<h1>Sign In</h1>
		{#if form?.error}
			<div class="alert-hud mb-3">{form.error}</div>
		{/if}
		<form method="POST" class="d-grid gap-3 mt-4">
			<input class="form-control" name="username" placeholder="Username" autocomplete="username" required />
			<input class="form-control" type="password" name="password" placeholder="Password" autocomplete="current-password" required />
			<button class="btn-hud-primary" type="submit">Sign In</button>
		</form>
	</div>
</div>
