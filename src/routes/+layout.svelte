<script lang="ts">
	import 'bootstrap/dist/css/bootstrap.min.css';
	import 'bootstrap-icons/font/bootstrap-icons.css';
	import '../styles/hud.scss';
	import favicon from '$lib/assets/favicon.svg';
	import { APP_NAME } from '$lib/brand';
	import AppBrand from '$lib/components/AppBrand.svelte';
	import RebuildButton from '$lib/components/RebuildButton.svelte';

	let { data, children } = $props();

	const isAuth = $derived(data.path === '/login' || data.path === '/setup');
	const isPreview = $derived(data.path.startsWith('/p/'));
	const isEditor = $derived(data.path.includes('/episodes/'));
	const isAccount = $derived(data.path.startsWith('/account'));
</script>

<svelte:head>
	<title>{APP_NAME}</title>
	<link rel="icon" href={favicon} />
</svelte:head>

{#if isAuth || isPreview || !data.user}
	{@render children()}
{:else if isEditor}
	<div class="app-shell editor-owned">
		<main class="app-content full">
			{@render children()}
		</main>
	</div>
{:else}
	<div class="app-shell">
		<header class="app-header">
			<AppBrand />
			{#if data.user.role === 'admin'}
				<RebuildButton />
			{/if}
			<div class="ms-auto d-flex align-items-center gap-3">
				<span class="hud-kicker mb-0">{data.user.username} · {data.user.role}</span>
				<a class="btn-hud-ghost text-decoration-none" href="/account">Password</a>
				<form method="POST" action="/logout">
					<button class="btn-hud-ghost" type="submit">Sign out</button>
				</form>
			</div>
		</header>
		<nav class="app-sidebar">
			<a href="/" class:active={data.path === '/'} title="Series">
				<i class="bi bi-collection"></i>
			</a>
			<a href="/account" class:active={isAccount} title="Password">
				<i class="bi bi-key"></i>
			</a>
			{#if data.user.role === 'admin' || data.user.role === 'scanlator'}
				<a href="/admin/users" class:active={data.path.startsWith('/admin/users')} title="Users">
					<i class="bi bi-people"></i>
				</a>
			{/if}
			{#if data.user.role === 'admin'}
				<a href="/admin/models" class:active={data.path.startsWith('/admin/models') || data.path.startsWith('/admin/setup') || data.path.startsWith('/admin/settings')} title="Models">
					<i class="bi bi-sliders"></i>
				</a>
			{/if}
		</nav>
		<main class="app-content">
			{@render children()}
		</main>
	</div>
{/if}
