<script lang="ts">
	import { proofreaderLabel } from '$lib/proofreaders';
	import { APP_NAME } from '$lib/brand';
	import { onMount } from 'svelte';
	let { data, form } = $props();

	type Item = { id: string; action: string; label: string; createdAt: number };
	type Summary = { id: string; username: string; role: string; lastSeenAt: number | null; total: number; actions: Item[] };

	const POLL_MS = 10_000;
	// svelte-ignore state_referenced_locally
	let activity = $state<Summary[] | null>(data.activity);
	// Full histories, fetched only when someone asks for one.
	let expanded = $state<Record<string, Item[]>>({});
	let loading = $state<Record<string, boolean>>({});
	let refreshError = $state('');
	let clock = $state(Date.now());

	async function fetchAll(id: string): Promise<Item[]> {
		const res = await fetch(`/api/admin/activity?user=${encodeURIComponent(id)}`);
		if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
		return (await res.json()).actions;
	}

	async function refresh() {
		if (!activity) return;
		try {
			const res = await fetch('/api/admin/activity');
			if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
			activity = (await res.json()).users;
			for (const id of Object.keys(expanded)) expanded[id] = await fetchAll(id);
			refreshError = '';
		} catch (e) {
			refreshError = e instanceof Error ? e.message : String(e);
		}
		clock = Date.now();
	}

	async function toggleAll(id: string) {
		if (expanded[id]) {
			delete expanded[id];
			return;
		}
		loading[id] = true;
		try {
			expanded[id] = await fetchAll(id);
		} catch (e) {
			refreshError = e instanceof Error ? e.message : String(e);
		} finally {
			loading[id] = false;
		}
	}

	onMount(() => {
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') void refresh();
		}, POLL_MS);
		return () => clearInterval(timer);
	});
</script>

<svelte:head>
	<title>Users · {APP_NAME}</title>
</svelte:head>

<div class="mb-4">
	<div class="hud-kicker">{data.scanlator ? 'Scanlator' : 'Administration'}</div>
	<h2>Users & access</h2>
	{#if data.scanlator}
		<p class="text-secondary mb-0">
			Create translators, proofreaders, and typesetters. You can give them access to series you
			upload, series an admin assigned to you, and the shared <strong>Test</strong> series.
		</p>
	{/if}
</div>

{#if form?.error}
	<div class="alert-hud mb-3">{form.error}</div>
{/if}
{#if form?.ok && form?.message}
	<div class="hud-card mb-3" style="border-color: var(--hud-teal-ink)">{form.message}</div>
{/if}

{#if activity}
	<div class="hud-card mb-4">
		<div class="d-flex flex-wrap gap-2 align-items-center mb-3">
			<div class="hud-kicker mb-0">User activity</div>
			<span class="text-secondary">Latest 50 actions per user · updates every {POLL_MS / 1000}s</span>
			<button class="btn-hud-ghost ms-auto" type="button" onclick={() => void refresh()}>Refresh</button>
		</div>
		{#if refreshError}<p class="text-secondary small mb-2">Could not refresh: {refreshError}</p>{/if}
		<div class="d-grid gap-3">
			{#each activity as u (u.id)}
				{@const online = !!u.lastSeenAt && clock - u.lastSeenAt < data.signedInMs}
				{@const shown = expanded[u.id] ?? u.actions}
				<div class="activity-user">
					<div class="d-flex flex-wrap gap-2 align-items-baseline">
						<strong>{u.username}</strong>
						<span class="hud-kicker mb-0">{u.role}</span>
						{#if online}<span class="online">Signed in</span>{/if}
						<span class="text-secondary ms-auto">
							{u.lastSeenAt ? `Last seen ${new Date(u.lastSeenAt).toLocaleString()}` : 'Never signed in'}
						</span>
					</div>
					{#if shown.length === 0}
						<p class="text-secondary mb-0 mt-2">No recorded actions yet.</p>
					{:else}
						<ol class="activity-actions" class:all={!!expanded[u.id]}>
							{#each shown as a (a.id)}
								<li>
									<time datetime={new Date(a.createdAt).toISOString()}>{new Date(a.createdAt).toLocaleString()}</time>
									{a.label}
								</li>
							{/each}
						</ol>
						{#if u.total > u.actions.length}
							<button class="btn-hud-ghost mt-2" type="button" disabled={loading[u.id]} onclick={() => void toggleAll(u.id)}>
								{expanded[u.id] ? `Show latest ${u.actions.length}` : loading[u.id] ? 'Loading…' : `Show all ${u.total}`}
							</button>
						{/if}
					{/if}
				</div>
			{/each}
		</div>
	</div>
{/if}

<div class="hud-card mb-4">
	<div class="hud-kicker mb-2">Create user</div>
	<form method="POST" action="?/create" class="row g-2 align-items-end">
		<div class="col-md-4">
			<div class="hud-label">Username</div>
			<input class="form-control" name="username" required />
		</div>
		<div class="col-md-3">
			<div class="hud-label">Password</div>
			<input class="form-control" type="password" name="password" minlength="6" required />
		</div>
		<div class="col-md-3">
			<div class="hud-label">Role</div>
			<select class="form-select" name="role">
				{#each data.roles as role}
					<option value={role} selected={role === 'typesetter'}>{role}</option>
				{/each}
			</select>
		</div>
		<div class="col-md-2">
			<button class="btn-hud w-100" type="submit">Create</button>
		</div>
	</form>
</div>

{#each data.users as u (u.id)}
	<div class="hud-card mb-3">
		<div class="d-flex flex-wrap gap-3 align-items-center">
			<strong>{u.username}</strong>
			{#if u.manageable}
				<form method="POST" action="?/role" class="d-flex gap-2 align-items-center">
					<input type="hidden" name="id" value={u.id} />
					<select class="form-select form-select-sm" name="role" onchange={(e) => e.currentTarget.form?.requestSubmit()}>
						{#each data.roles as role}
							<option value={role} selected={role === u.role}>{role}</option>
						{/each}
					</select>
				</form>
				{#if u.id !== data.user?.id}
					<form method="POST" action="?/remove">
						<input type="hidden" name="id" value={u.id} />
						<button class="btn-hud-danger" type="submit">Delete</button>
					</form>
				{/if}
			{:else}
				<span class="hud-kicker mb-0">{u.role}</span>
			{/if}
		</div>
		{#if u.manageable}
			<form method="POST" action="?/password" class="row g-2 align-items-end mt-3">
				<input type="hidden" name="id" value={u.id} />
				<div class="col-md-4">
					<div class="hud-label">Set new password</div>
					<input class="form-control form-control-sm" type="password" name="next" minlength="6" required autocomplete="new-password" />
				</div>
				<div class="col-md-4">
					<div class="hud-label">Confirm</div>
					<input class="form-control form-control-sm" type="password" name="confirm" minlength="6" required autocomplete="new-password" />
				</div>
				<div class="col-md-4">
					<button class="btn-hud" type="submit">Reset password</button>
				</div>
			</form>
			<div class="hud-kicker mt-3 mb-2">
				{data.scanlator
					? 'Series access (your series, assigned series, and Test)'
					: 'Series access (admins always see all; scanlators get full control of assigned series)'}
			</div>
			<div class="d-flex flex-wrap gap-2">
				{#each data.series as s (s.id)}
					<form method="POST" action="?/acl">
						<input type="hidden" name="userId" value={u.id} />
						<input type="hidden" name="seriesId" value={s.id} />
						<input type="hidden" name="on" value={u.seriesIds.includes(s.id) ? '0' : '1'} />
						<button class="status-pill" class:on={u.seriesIds.includes(s.id)} type="submit">
							{s.title}{#if s.test && s.title !== 'Test'} · Test{/if}
						</button>
					</form>
				{/each}
				{#if data.series.length === 0}
					<span class="text-secondary">No series yet</span>
				{/if}
			</div>
			{#if u.id !== data.me}
				<div class="hud-kicker mt-3 mb-2">
					Page-image proofread (grant a proofreader; off means the tools stay hidden)
				</div>
				<div class="d-flex flex-wrap gap-2">
					{#each data.proofreaderIds as engine (engine)}
						<form method="POST" action="?/proofreaders">
							<input type="hidden" name="id" value={u.id} />
							<input type="hidden" name="engine" value={engine} />
							<input type="hidden" name="on" value={u.proofreaders?.includes(engine) ? '0' : '1'} />
							<button class="status-pill" class:on={u.proofreaders?.includes(engine)} type="submit">
								{proofreaderLabel(engine)}
							</button>
						</form>
					{/each}
				</div>
			{/if}
		{/if}
	</div>
{/each}

<style>
	.activity-user + .activity-user {
		border-top: 1px solid var(--hud-line);
		padding-top: 0.85rem;
	}
	.activity-actions {
		margin: 0.55rem 0 0;
		padding: 0;
		max-height: 16rem;
		overflow: auto;
		list-style: none;
	}
	.activity-actions.all {
		max-height: 32rem;
	}
	.online {
		color: var(--hud-teal-ink);
		font-size: 0.8rem;
	}
	.activity-actions li {
		display: grid;
		grid-template-columns: minmax(9.5rem, auto) 1fr;
		gap: 0.65rem;
		padding: 0.28rem 0;
		font-size: 0.86rem;
		border-bottom: 1px solid var(--hud-line);
	}
	.activity-actions time {
		color: var(--hud-muted);
		white-space: nowrap;
	}
</style>
