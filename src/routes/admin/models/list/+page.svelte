<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { get } from 'svelte/store';
	import {
		hub,
		listEntries,
		entryStatus,
		openDrawer,
		openAdd,
		apiPost,
		toast,
		refreshHub,
		ADMIN_TASKS,
		type ListEntry,
	} from '$lib/components/admin/hub.svelte';
	import { INSTALL_TARGETS, formatDisk } from '$lib/installCatalog';
	import { qualificationChecks } from '$lib/modelCapabilities';

	const data = $derived($hub!);
	const entries = $derived(listEntries(data));

	let q = $state('');
	let status = $state<'machine' | 'attention' | 'missing' | 'hidden' | 'all'>('machine');
	let source = $state<'all' | 'local' | 'remote' | 'cli' | 'service'>('all');
	function taskFromUrl(url: URL) {
		const requested = url.searchParams.get('task') || '';
		return ADMIN_TASKS.some((item) => item.id === requested) ? requested : 'all';
	}
	let task = $state(taskFromUrl(get(page).url));
	// The list page stays mounted when only ?task= changes, so follow the address.
	$effect(() => {
		task = taskFromUrl($page.url);
	});
	function setTask(next: string) {
		const chosen = ADMIN_TASKS.some((item) => item.id === next) ? next : 'all';
		task = chosen;
		const url = new URL($page.url);
		if (chosen === 'all') url.searchParams.delete('task');
		else url.searchParams.set('task', chosen);
		const target = `${url.pathname}${url.search}`;
		if (target === `${$page.url.pathname}${$page.url.search}`) return;
		void goto(target, { replaceState: true, keepFocus: true, noScroll: true });
	}
	let group = $state<'family' | 'source' | 'none'>('family');
	let selected = $state<Set<string>>(new Set());
	let busy = $state('');

	function statusKey(entry: ListEntry) {
		return entryStatus(data, entry).key;
	}
	const base = $derived(
		entries.filter((entry) => {
			if (source !== 'all' && entry.source !== source) return false;
			if (task !== 'all' && !entry.tasks.includes(task as never)) return false;
			if (q && !`${entry.name} ${entry.sub}`.toLowerCase().includes(q.toLowerCase())) return false;
			return true;
		}),
	);
	const shown = $derived(
		base.filter((entry) => {
			const key = statusKey(entry);
			const hidden = entry.row?.disabled;
			if (status === 'machine') return key !== 'missing';
			if (status === 'attention') return key === 'attention';
			if (status === 'missing') return key === 'missing' || key === 'installing';
			if (status === 'hidden') return Boolean(hidden) && key !== 'missing';
			return true;
		}),
	);
	const counts = $derived({
		machine: base.filter((e) => statusKey(e) !== 'missing').length,
		attention: base.filter((e) => statusKey(e) === 'attention').length,
		missing: base.filter((e) => ['missing', 'installing'].includes(statusKey(e))).length,
		hidden: base.filter((e) => e.row?.disabled && statusKey(e) !== 'missing').length,
		all: base.length,
	});
	const groups = $derived.by(() => {
		const map = new Map<string, ListEntry[]>();
		for (const entry of shown) {
			const key = group === 'family' ? entry.tasks[0] || 'other' : group === 'source' ? entry.source : '';
			const list = map.get(key) || [];
			list.push(entry);
			map.set(key, list);
		}
		return [...map.entries()];
	});
	const allSelected = $derived(shown.length > 0 && shown.every((entry) => selected.has(entry.id)));

	function toggleSelect(id: string, on: boolean) {
		const next = new Set(selected);
		on ? next.add(id) : next.delete(id);
		selected = next;
	}
	function toggleAll(on: boolean) {
		selected = on ? new Set(shown.map((entry) => entry.id)) : new Set();
	}

	async function setVisible(entry: ListEntry, visible: boolean) {
		if (!entry.row) return;
		busy = entry.id;
		try {
			await apiPost('/api/admin/models', { action: 'update', id: entry.id, disabled: !visible });
			toast(`${entry.name} ${visible ? 'shown to' : 'hidden from'} users`);
			await refreshHub();
		} catch (e) {
			toast(String((e as Error).message), 'bad');
		} finally {
			busy = '';
		}
	}

	async function installOne(id: string) {
		const target = INSTALL_TARGETS.find((item) => item.id === id);
		try {
			await apiPost('/api/admin/setup-install', { action: 'start', ids: [id] });
			toast(`Installing ${target?.label || id} in the background`);
			await refreshHub();
		} catch (e) {
			toast(String((e as Error).message), 'bad');
		}
	}

	async function bulk(action: string) {
		const ids = [...selected];
		const picked = ids.map((id) => entries.find((entry) => entry.id === id)).filter(Boolean) as ListEntry[];
		busy = 'bulk';
		try {
			if (action === 'show' || action === 'hide') {
				const rows = picked.filter((e) => e.row);
				for (const entry of rows) await apiPost('/api/admin/models', { action: 'update', id: entry.id, disabled: action === 'hide' });
				toast(`${rows.length} model${rows.length === 1 ? '' : 's'} ${action === 'show' ? 'shown to' : 'hidden from'} users`);
			} else if (action === 'install') {
				const idsToInstall = picked.filter((e) => e.target && !e.installed).map((e) => e.id);
				if (idsToInstall.length) {
					await apiPost('/api/admin/setup-install', { action: 'start', ids: idsToInstall });
					toast(`Queued ${idsToInstall.length} install${idsToInstall.length === 1 ? '' : 's'}`);
				}
			} else if (action === 'test') {
				const targets = picked.filter((e) => e.row);
				const results = await Promise.allSettled(
					targets.map((entry) =>
						apiPost('/api/admin/models', { action: 'test', id: entry.id, check: qualificationChecks(entry.row!)[0] }),
					),
				);
				const failed = results.filter((item) => item.status === 'rejected').length;
				toast(
					failed
						? `${failed} of ${targets.length} tests failed`
						: 'Tests started — results appear in each model’s panel.',
					failed ? 'warn' : 'ok',
				);
			}
			await refreshHub();
		} catch (e) {
			toast(String((e as Error).message), 'bad');
		} finally {
			busy = '';
			selected = new Set();
		}
	}
</script>

<div class="page-head">
	<div>
		<div class="kicker">Administration · Models</div>
		<h1>Models</h1>
		<p>Every model in one list — installed weights, local servers, remote APIs, CLI agents and services. Click a row for setup, jobs, tests and visibility in one place.</p>
	</div>
	<div class="row">
		<a class="btn ghost" href="/admin/models/hardware"><i class="bi bi-box-arrow-up-right"></i> Import / export</a>
		<button class="btn" onclick={() => openAdd()}><i class="bi bi-plus-lg"></i> Add model</button>
	</div>
</div>

<div class="toolbar">
	<input type="search" placeholder="Search models…" bind:value={q} />
	<div class="seg">
		<button class:on={status === 'machine'} onclick={() => (status = 'machine')}>On this machine <span class="n">{counts.machine}</span></button>
		<button class:on={status === 'attention'} onclick={() => (status = 'attention')}>Needs attention <span class="n">{counts.attention}</span></button>
		<button class:on={status === 'missing'} onclick={() => (status = 'missing')}>Not installed <span class="n">{counts.missing}</span></button>
		<button class:on={status === 'hidden'} onclick={() => (status = 'hidden')}>Hidden from users <span class="n">{counts.hidden}</span></button>
		<button class:on={status === 'all'} onclick={() => (status = 'all')}>All <span class="n">{counts.all}</span></button>
	</div>
</div>
<div class="toolbar">
	<div class="seg">
		<button class:on={source === 'all'} onclick={() => (source = 'all')}>Any source</button>
		<button class:on={source === 'local'} onclick={() => (source = 'local')}>Local</button>
		<button class:on={source === 'remote'} onclick={() => (source = 'remote')}>Remote</button>
		<button class:on={source === 'cli'} onclick={() => (source = 'cli')}>CLI</button>
		<button class:on={source === 'service'} onclick={() => (source = 'service')}>Service</button>
	</div>
	<select value={task} onchange={(e) => setTask(e.currentTarget.value)} style="width:auto">
		<option value="all">Any job</option>
		{#each ADMIN_TASKS as item (item.id)}<option value={item.id}>{item.label}</option>{/each}
	</select>
	<span class="muted small" style="margin-left:auto">Group by</span>
	<div class="seg">
		<button class:on={group === 'family'} onclick={() => (group = 'family')}>Job</button>
		<button class:on={group === 'source'} onclick={() => (group = 'source')}>Source</button>
		<button class:on={group === 'none'} onclick={() => (group = 'none')}>None</button>
	</div>
</div>

<table class="mtable">
	<thead>
		<tr>
			<th><input type="checkbox" checked={allSelected} onchange={(e) => toggleAll(e.currentTarget.checked)} /></th>
			<th>Model</th><th>Jobs</th><th>Status</th><th title="Shown in chapter model lists">Users can pick</th><th></th>
		</tr>
	</thead>
	<tbody>
		{#each groups as [key, list] (key)}
			{#if group !== 'none'}
				<tr class="group"><td colspan="6"><b>{key === 'other' ? 'Other' : (ADMIN_TASKS.find((t) => t.id === key)?.label ?? key)}</b> · {list.length}</td></tr>
			{/if}
			{#each list as entry (entry.id)}
				{@const st = entryStatus(data, entry)}
				<tr class="m-row {st.key === 'missing' ? 'dim' : ''}" onclick={() => openDrawer(entry.id)}>
					<td class="keep" onclick={(e) => e.stopPropagation()}>
						<input type="checkbox" checked={selected.has(entry.id)} onchange={(e) => toggleSelect(entry.id, e.currentTarget.checked)} />
					</td>
					<td>
						<div class="m-name">
							<strong>{entry.name}</strong>
							<span class="sub"><span class="src"><i class="bi {entry.source === 'remote' ? 'bi-cloud' : entry.source === 'cli' ? 'bi-terminal' : entry.source === 'service' ? 'bi-plug' : 'bi-hdd'}"></i>{entry.sourceLabel}</span> · {entry.sub}</span>
						</div>
					</td>
					<td><div class="chips">{#each entry.tasks.slice(0, 3) as t (t)}<span class="chip task">{ADMIN_TASKS.find((x) => x.id === t)?.label}</span>{/each}{#if entry.tasks.length > 3}<span class="chip muted">+{entry.tasks.length - 3}</span>{/if}</div></td>
					<td class="keep">
						<div class="row">
							<span class="status tone-{st.tone}"><span class="dot {st.dot || st.tone}"></span>{st.label}</span>
							{#if st.key === 'missing' && entry.target}
								<button class="btn sm" disabled={!!busy} onclick={(e) => { e.stopPropagation(); void installOne(entry.id); }}>Install · {formatDisk(entry.target.diskBytes)}</button>
							{/if}
						</div>
					</td>
					<td class="keep" onclick={(e) => e.stopPropagation()}>
						{#if entry.pickable && entry.row}
							<label class="switch"><input type="checkbox" checked={!entry.row.disabled} disabled={busy === entry.id || st.key === 'missing'} onchange={(e) => void setVisible(entry, e.currentTarget.checked)} /><span class="track"></span></label>
						{:else}
							<span class="muted small">—</span>
						{/if}
					</td>
					<td><i class="bi bi-chevron-right muted"></i></td>
				</tr>
			{/each}
		{/each}
		{#if !shown.length}
			<tr><td colspan="6" class="muted">No models match these filters.</td></tr>
		{/if}
	</tbody>
</table>

{#if selected.size}
	<div class="bulkbar">
		<strong>{selected.size} selected</strong>
		<button class="btn sm" disabled={!!busy} onclick={() => void bulk('show')}>Show to users</button>
		<button class="btn sm" disabled={!!busy} onclick={() => void bulk('hide')}>Hide from users</button>
		<button class="btn ghost sm" disabled={!!busy} onclick={() => void bulk('test')}>Test</button>
		<button class="btn ghost sm" disabled={!!busy} onclick={() => void bulk('install')}>Install missing</button>
		<button class="btn link" style="margin-left:auto" onclick={() => (selected = new Set())}>Clear selection</button>
	</div>
{/if}
