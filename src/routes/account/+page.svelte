<script lang="ts">
	import { APP_NAME } from '$lib/brand';
	let { data, form } = $props();
</script>

<svelte:head>
	<title>Password · {APP_NAME}</title>
</svelte:head>

<div class="mb-4">
	<div class="hud-kicker">Account</div>
	<h2>Change password</h2>
	<p class="text-secondary">{data.username}</p>
</div>

{#if form?.error}
	<div class="alert-hud mb-3">{form.error}</div>
{/if}
{#if form?.ok}
	<div class="hud-card mb-3" style="border-color: var(--hud-teal-ink)">Password updated.</div>
{/if}

<div class="hud-card" style="max-width: 420px">
	<form method="POST" class="d-grid gap-3">
		<div>
			<div class="hud-label">Current password</div>
			<input class="form-control" type="password" name="current" required autocomplete="current-password" />
		</div>
		<div>
			<div class="hud-label">New password</div>
			<input class="form-control" type="password" name="next" minlength="6" required autocomplete="new-password" />
		</div>
		<div>
			<div class="hud-label">Confirm new password</div>
			<input class="form-control" type="password" name="confirm" minlength="6" required autocomplete="new-password" />
		</div>
		<button class="btn-hud" type="submit">Update password</button>
	</form>
</div>
