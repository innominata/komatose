<script lang="ts">
	import {
		hub,
		ADMIN_TASKS,
		coverageFor,
		attentionList,
		deviceRows,
		openDrawer,
		openAdd,
		apiPost,
		hubPost,
		toast,
		refreshHub,
	} from '$lib/components/admin/hub.svelte';
	import { INSTALL_TARGETS } from '$lib/installCatalog';
	import { formatMiB, shownDevice } from '$lib/computeDevices';

	const data = $derived($hub!);
	const cov = $derived(Object.fromEntries(ADMIN_TASKS.map((task) => [task.id, coverageFor(data, task)])) as Record<string, ReturnType<typeof coverageFor>>);
	const blocked = $derived(ADMIN_TASKS.filter((task) => task.required && cov[task.id]?.tone === 'bad'));
	const limited = $derived(ADMIN_TASKS.filter((task) => cov[task.id]?.tone === 'warn'));
	const attention = $derived(attentionList(data));
	const runningRows = $derived(
		data.rows.filter((row) => row.managedLaunch && (row.managed?.state === 'running' || row.managed?.state === 'starting')),
	);
	const runningServers = $derived(data.reviewServers.filter((server) => server.state === 'running' || server.state === 'starting'));
	const runningEditors = $derived(data.editors.filter((editor) => editor.state === 'running' || editor.state === 'starting'));
	const devices = $derived(deviceRows(data));

	const hero = $derived(
		blocked.length
			? {
					tone: 'bad',
					icon: 'bi-slash-circle',
					title: `Komatose can’t ${blocked.map((t) => t.label.toLowerCase()).join(' or ')} yet`,
					text: 'Nothing on this machine can do those jobs yet. Guided setup picks models that fit this hardware and installs them in one go.',
				}
			: attention.length
				? {
						tone: 'warn',
						icon: 'bi-exclamation-triangle',
						title: `Ready to work — ${attention.length} thing${attention.length === 1 ? '' : 's'} need${attention.length === 1 ? 's' : ''} attention`,
						text: `Every required job has a ready model.${limited.length ? ` ${limited.map((t) => t.label).join(', ')} ${limited.length === 1 ? 'is' : 'are'} running in a limited mode.` : ''}`,
					}
				: limited.some((task) => task.required)
					? {
							tone: 'warn',
							icon: 'bi-hourglass-split',
							title: 'Ready to work, with limits',
							text: `${limited.map((t) => t.label).join(', ')} ${limited.length === 1 ? 'is' : 'are'} using a fallback or basic mode.`,
						}
					: {
							tone: 'ok',
							icon: 'bi-check-circle',
							title: 'Everything is ready',
							text: limited.length ? `${limited.map((t) => t.label).join(', ')} could be better — see the suggestions below.` : 'Every job has a ready default model.',
						},
	);

	async function recheck() {
		try {
			await hubPost({ action: 'refresh-hardware' });
			toast('Rechecked devices');
		} catch (e) {
			toast(String((e as Error).message), 'bad');
		}
	}

	async function fixTarget(action: string, id?: string, adapter?: string) {
		if (action === 'fix-key' && id) {
			const row = data.rows.find((item) => item.id === id);
			const keyVar = row?.http?.apiKeyEnv || 'OPENAI_API_KEY';
			toast(`Add ${keyVar}=… to .env on this server, then Refresh. Komatose stores the variable name only.`, 'warn');
			openDrawer(id);
			return;
		}
		if (action === 'fix-cli' && adapter) {
			const row = data.rows.find((item) => item.cliAdapter === adapter);
			toast('Set the executable path for the CLI, then check discovery.', 'warn');
			if (row) openDrawer(row.id);
			return;
		}
		try {
			if (action === 'hide' && id) {
				await apiPost('/api/admin/models', { action: 'update', id, disabled: true });
				toast('Hidden from users');
				await refreshHub();
				return;
			}
			if (action === 'install' && id) {
				const target = INSTALL_TARGETS.find((item) => item.id === id);
				await apiPost('/api/admin/setup-install', { action: 'start', ids: [id] });
				toast(`Installing ${target?.label || id} in the background`);
				await refreshHub();
				return;
			}
		} catch (e) {
			toast(String((e as Error).message), 'bad');
			return;
		}
		if (action === 'view-log' && id) openDrawer(id);
	}
</script>

<div class="page-head">
	<div>
		<div class="kicker">Administration · Models</div>
		<h1>Overview</h1>
		<p>What Komatose can do on this machine, by job. Checks here are free — they look at files, ports and variable names and never call a model.</p>
	</div>
	<div class="row">
		<button class="btn ghost" onclick={() => void recheck()}>
			<i class="bi bi-arrow-repeat"></i> Recheck
		</button>
		<button class="btn" onclick={() => openAdd()}><i class="bi bi-plus-lg"></i> Add model</button>
	</div>
</div>

<div class="card hero-status">
	<i class="bi {hero.icon} big-icon tone-{hero.tone}"></i>
	<div><h2>{hero.title}</h2><div class="muted">{hero.text}</div></div>
	<div>
		{#if blocked.length}
			<a class="btn solid" href="/admin/models/setup"><i class="bi bi-magic"></i> Start guided setup</a>
		{/if}
	</div>
</div>

<div class="section">
	<div class="section-head">
		<h2>Jobs</h2>
		<span class="muted small">Each card shows the model that runs by default. <a href="/admin/models/jobs">Change defaults →</a></span>
	</div>
	<div class="pipeline">
		{#each ['Translate', 'Review', 'Clean'] as stage (stage)}
			{@const tasks = ADMIN_TASKS.filter((task) => task.stage === stage)}
			<div class="stage {tasks.length > 2 ? 'wide' : ''}">
				<div class="stage-name">{stage}</div>
				<div class="stage-cards">
					{#each tasks as task (task.id)}
						{@const c = cov[task.id]}
						<div class="task-card {c.tone}">
							<div class="t-head">
								<i class="bi {task.icon} tone-{c.tone}"></i>
								<strong>{task.label}</strong>
								{#if !task.required}<span class="t-optional">optional</span>{/if}
							</div>
							<div class="status tone-{c.tone}"><span class="dot {c.tone}"></span>{c.label}</div>
							{#if c.def}
								<div class="t-default">Default: <button class="btn link" onclick={() => openDrawer(c.def!.id)}>{c.def.name}</button>{#if c.others.length} <span class="muted">+{c.others.length} more</span>{/if}</div>
							{:else if c.defLabel}
								<div class="t-default">Default: <b>{c.defLabel}</b></div>
							{/if}
							{#if c.text}<div class="muted small">{c.text}</div>{/if}
							{#if c.note}<div class="muted small">{c.note}</div>{/if}
							<a class="small" href="/admin/models/list?task={task.id}">Models for {task.label.toLowerCase()} →</a>
						</div>
					{/each}
				</div>
			</div>
		{/each}
	</div>
</div>

<div class="section two-col">
	<div>
		<div class="section-head"><h2>Needs attention</h2><span class="muted small">Broken things only — optional models you don’t have are in <a href="/admin/models/install">Install</a>.</span></div>
		<div class="attn-list">
			{#each attention as item (item.title)}
				<div class="attn">
					<i class="bi {item.icon} tone-{item.tone}"></i>
					<div><strong>{item.title}</strong><div class="muted small">{item.text}</div></div>
					<div class="a-actions">
						{#each item.actions as action, i (action.label)}
							<button class={i ? 'btn ghost sm' : 'btn sm'} onclick={() => fixTarget(action.action, action.id, action.adapter)}>{action.label}</button>
						{/each}
					</div>
				</div>
			{:else}
				<div class="card muted"><i class="bi bi-check2-circle tone-ok"></i> Nothing needs attention.</div>
			{/each}
		</div>
	</div>
	<div>
		<div class="section-head"><h2>Running now</h2><a class="small" href="/admin/models/hardware">Hardware & services →</a></div>
		<div class="card">
			<div class="running-list">
				{#each runningRows as row (row.id)}
					<div class="running-item">
						<span class="dot ok"></span>
						<div>
							<button class="btn link" onclick={() => openDrawer(row.id)}>{row.name}</button>
							<div class="muted small">{shownDevice(data.hardware, row.managed?.device) || 'auto'}{row.managed?.port ? ` · port ${row.managed.port}` : ''}</div>
						</div>
					</div>
				{/each}
				{#each runningServers as server (server.id)}
					<div class="running-item">
						<span class="dot ok"></span>
						<div>
							<strong>{server.label}</strong>
							<div class="muted small">{shownDevice(data.hardware, server.device) || ''}{server.port ? ` · port ${server.port}` : ''}</div>
						</div>
					</div>
				{/each}
				{#each runningEditors as editor (editor.id)}
					<div class="running-item">
						<span class="dot ok"></span>
						<div>
							<button class="btn link" onclick={() => openDrawer(editor.id)}>{editor.label}</button>
							<div class="muted small">{shownDevice(data.hardware, editor.device)}{editor.port ? ` · port ${editor.port}` : ''}</div>
						</div>
					</div>
				{/each}
				{#if !runningRows.length && !runningServers.length && !runningEditors.length}
					<div class="muted small">Nothing is loaded right now. Models load when a task needs them.</div>
				{/if}
			</div>
			<div style="margin-top:1rem">
				{#each devices as device (device.name)}
					<div class="res-row">
						<span class="muted">{device.name}</span>
						<div class="bar">
							<span class="seg-used" style="width:{Math.min(100, (device.usedMiB / Math.max(1, device.totalMiB)) * 100)}%"></span>
						</div>
						<span class="small">{formatMiB(device.usedMiB)} / {formatMiB(device.totalMiB)}</span>
					</div>
				{/each}
				{#if !devices.length}<div class="muted small">No GPU reported; models run on CPU.</div>{/if}
			</div>
		</div>
	</div>
</div>
