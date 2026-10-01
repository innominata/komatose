<script lang="ts">
	import { get } from 'svelte/store';
	import {
		hub,
		ui,
		openUninstall,
		apiPost,
		toast,
		refreshHub,
		installFor,
	} from '$lib/components/admin/hub.svelte';
	import { INSTALL_TARGETS, formatDisk } from '$lib/installCatalog';

	const data = $derived($hub!);
	const id = $derived($ui.uninstallId);
	const target = $derived(id ? INSTALL_TARGETS.find((item) => item.id === id) : undefined);
	const status = $derived(id ? installFor(data, id) : undefined);

	type Plan = {
		id: string;
		label: string;
		paths: { path: string; note: string; kind: string }[];
		warnings: string[];
		blocked?: string;
		alsoRemoves: string[];
	};
	let plan = $state<Plan | null>(null);
	let busy = $state('');

	$effect(() => {
		if (!id) {
			plan = null;
			return;
		}
		const requested = id;
		plan = null;
		void apiPost('/api/admin/setup-install', { action: 'uninstall-plan', id: requested })
			.then((json) => {
				if (get(ui).uninstallId === requested) plan = json.plan as Plan;
			})
			.catch((e) => {
				if (get(ui).uninstallId === requested) toast(String((e as Error).message), 'bad');
			});
	});

	async function confirm() {
		if (!id) return;
		busy = 'x';
		try {
			const json = await apiPost('/api/admin/setup-install', { action: 'uninstall', id });
			const removed = (json.plan as Plan)?.paths?.length ?? 0;
			toast(`Uninstalled ${plan?.label || id} — deleted ${removed} item${removed === 1 ? '' : 's'}`, 'warn');
			openUninstall(null);
			await refreshHub();
		} catch (e) {
			toast(String((e as Error).message), 'bad');
		} finally {
			busy = '';
		}
	}
</script>

{#if id && target}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="dlg-wrap" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) openUninstall(null); }}>
		<div class="dlg" role="dialog" tabindex="-1" aria-label="Uninstall {target.label}" onclick={(e) => e.stopPropagation()}>
			<div class="kicker">Uninstall</div>
			<h3>{target.label}</h3>
			{#if !plan}
				<p class="muted">Working out what to delete…</p>
			{:else}
				<p class="muted">This deletes the files Komatose installed for it. Settings and chapter history are kept, so reinstalling restores the model.</p>
				<div class="plan">
					{#each plan.paths as item (item.path)}
						<div class="plan-item">
							<i class="bi {item.kind === 'symlink' ? 'bi-link-45deg' : item.kind === 'marker' ? 'bi-card-checklist' : item.kind === 'dir' || item.kind === 'cache' || item.kind === 'venv' ? 'bi-folder' : 'bi-file-earmark'} tone-warn"></i>
							<div><code style="font-size:.78rem">{item.path}</code><div class="muted small">{item.note}</div></div>
							<span></span>
							<span></span>
						</div>
					{/each}
				</div>
				{#if plan.alsoRemoves.length}
					<div class="fix-box" style="margin-top:.7rem">
						Also removes model entry: <strong>{plan.alsoRemoves.join(', ')}</strong> — it points at these weights.
					</div>
				{/if}
				{#each plan.warnings as warning (warning)}
					<div class="fix-box" style="margin-top:.5rem"><i class="bi bi-exclamation-triangle"></i> {warning}</div>
				{/each}
				{#if plan.blocked}
					<div class="fix-box bad" style="margin-top:.7rem"><strong>Can’t uninstall yet</strong> <div class="small">{plan.blocked}</div></div>
				{/if}
			{/if}
			<div class="dlg-actions">
				<button class="btn ghost" onclick={() => openUninstall(null)}>Keep it</button>
				{#if plan && !plan.blocked}
					<button class="btn danger" disabled={!!busy} onclick={() => void confirm()}>
						<i class="bi bi-trash"></i> {busy ? 'Deleting…' : `Delete ${plan.paths.length} item${plan.paths.length === 1 ? '' : 's'}`}
					</button>
				{/if}
			</div>
			<p class="muted small" style="margin-top:.7rem">
				Only these paths are deleted — never anything outside the model’s own directory. A symlinked environment is unlinked, not followed.
				{#if status?.job?.state === 'running'} <strong>Its installer is still running; wait for it to finish.</strong>{/if}
			</p>
		</div>
	</div>
{/if}
