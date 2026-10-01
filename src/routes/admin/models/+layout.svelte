<script lang="ts">
	import { page } from '$app/stores';
	import { onDestroy, onMount } from 'svelte';
	import '$lib/components/admin/adminModels.css';
	import ModelDrawer from '$lib/components/admin/ModelDrawer.svelte';
	import AddModelDialog from '$lib/components/admin/AddModelDialog.svelte';
	import UninstallDialog from '$lib/components/admin/UninstallDialog.svelte';
	import {
		hub,
		hubError,
		ui,
		toasts,
		refreshHub,
		openDrawer,
		openUninstall,
	} from '$lib/components/admin/hub.svelte';
	import { get } from 'svelte/store';

	let { children } = $props();

	// Dialogs are centred in the viewport; keep the page under them still.
	$effect(() => {
		const open = $ui.addOpen || $ui.uninstallId != null;
		if (typeof document === 'undefined') return;
		document.body.classList.toggle('admin-dlg-open', open);
	});

	const TABS = [
		{ href: '/admin/models', label: 'Overview', icon: 'bi-grid-1x2', match: (path: string) => path === '/admin/models' },
		{ href: '/admin/models/list', label: 'Models', icon: 'bi-collection', match: (path: string) => path.startsWith('/admin/models/list') },
		{ href: '/admin/models/install', label: 'Install', icon: 'bi-download', match: (path: string) => path.startsWith('/admin/models/install') },
		{ href: '/admin/models/jobs', label: 'Jobs & defaults', icon: 'bi-table', match: (path: string) => path.startsWith('/admin/models/jobs') },
		{ href: '/admin/models/hardware', label: 'Hardware & services', icon: 'bi-gpu-card', match: (path: string) => path.startsWith('/admin/models/hardware') },
		{ href: '/admin/models/setup', label: 'Guided setup', icon: 'bi-magic', match: (path: string) => path.startsWith('/admin/models/setup') },
	];

	onMount(() => {
		void refreshHub();
		// Escape closes the top-most overlay: dialog, then the model drawer.
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			const state = get(ui);
			if (state.uninstallId) openUninstall(null);
			else if (state.addOpen) ui.update((current) => ({ ...current, addOpen: false }));
			else if (state.drawerId) openDrawer(null);
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	});
	onDestroy(() => {
		if (typeof document !== 'undefined') document.body.classList.remove('admin-dlg-open');
	});

	const running = $derived(($hub?.queue || []).find((item) => item.state === 'running'));
	const queuedCount = $derived(($hub?.queue || []).filter((item) => item.state === 'queued').length);
</script>

<div class="amodels">
	<div class="topbar">
		<span class="crumbs">Admin / <strong>Models</strong></span>
		{#if running}
			<span class="queue-pill">
				<span class="dot busy"></span>
				<span>Installing {running.label}{queuedCount ? ` · ${queuedCount} queued` : ''}</span>
			</span>
		{/if}
		<button class="btn ghost sm" style="margin-left:auto" onclick={() => void refreshHub()}>
			<i class="bi bi-arrow-repeat"></i> Refresh
		</button>
	</div>

	<div class="content" style="padding-top:1rem">
		<nav class="seg" style="margin-bottom:1.1rem">
			{#each TABS as tab (tab.href)}
				<a href={tab.href} class:on={tab.match($page.url.pathname)}>
					<i class="bi {tab.icon}"></i> {tab.label}
				</a>
			{/each}
		</nav>

		{#if $hubError}
			<div class="fix-box bad" style="margin-bottom:1rem"><strong>Could not load model data</strong> <span class="small">{$hubError}</span></div>
		{/if}

		{#if $hub}
			{@render children()}
		{:else}
			<p class="muted">Loading model data…</p>
		{/if}
	</div>

	<ModelDrawer />
	<AddModelDialog />
	<UninstallDialog />

	<div class="toasts">
		{#each $toasts as item (item.id)}
			<div class="toast {item.tone}">{item.text}</div>
		{/each}
	</div>
</div>

<style>
	.seg a {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font: 500 0.8rem var(--body);
		color: var(--muted);
		padding: 0.35rem 0.7rem;
		border-right: 1px solid var(--line);
		text-decoration: none;
	}
	.seg a:last-child { border-right: 0; }
	.seg a:hover { color: var(--text); }
	.seg a.on { color: var(--teal); background: var(--teal-dim); }
</style>
