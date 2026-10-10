<script lang="ts">
	import { APP_NAME } from '$lib/brand';
	import AppBrand from '$lib/components/AppBrand.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	let { form } = $props();
</script>

<svelte:head>
	<title>Setup · {APP_NAME}</title>
</svelte:head>

<div class="hud-cover">
	<div class="hud-cover-tools"><ThemeToggle /></div>
	<div class="hud-globe"></div>
	<div class="hud-auth">
		<AppBrand />
		<h1>Create Admin</h1>
		<p class="text-secondary mb-4">This account can add users, series, and access control.</p>
		{#if form?.error}
			<div class="alert-hud mb-3">{form.error}</div>
		{/if}
		<form method="POST" class="d-grid gap-3">
			<div>
				<div class="hud-label">Admin username</div>
				<input class="form-control" name="username" required />
			</div>
			<div>
				<div class="hud-label">Password</div>
				<input class="form-control" type="password" name="password" minlength="6" required />
			</div>
			<button class="btn-hud-primary" type="submit">Initialize</button>
		</form>
	</div>
</div>
