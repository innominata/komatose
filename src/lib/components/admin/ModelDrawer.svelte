<script lang="ts">
  import { qualificationChecks, qualificationSample, qualificationCurrent, qualificationLabel, qualificationReason, type QualificationId } from '$lib/modelCapabilities';
	import {
		hub,
		ui,
		entryStatus,
		listEntries,
		openDrawer,
		openUninstall,
		apiPost,
		toast,
		refreshHub,
		planSteps,
		queueFor,
		type ListEntry,
		type PublicRow,
	} from '$lib/components/admin/hub.svelte';
	import { deviceOptions, formatMiB, type DeviceRuntime } from '$lib/computeDevices';
	import { INSTALL_TARGETS, formatDisk, formatMemory } from '$lib/installCatalog';
	import { CHAT_AND_CLI_OPERATIONS } from '$lib/modelRegistry';
	import type { ProviderOperation } from '$lib/providerCatalog';
	import { ROLES, type Role } from '$lib/roles';
	import LocalModelEditor from '$lib/components/LocalModelEditor.svelte';
	import type { ManagedLaunch } from '$lib/managedModels';
	import { untrack } from 'svelte';

	const ROLE_LIST: Role[] = ROLES;

	const data = $derived($hub!);
	const entry = $derived($ui.drawerId ? listEntries(data).find((item) => item.id === $ui.drawerId) : undefined);
	const row = $derived(entry?.row);
	const target = $derived(entry?.target ?? (entry ? INSTALL_TARGETS.find((t) => t.id === entry.id) : undefined));
	const st = $derived(entry ? entryStatus(data, entry) : undefined);

	// Which runtime a device picker controls, and the pref key it writes.
	const deviceKind = $derived.by((): { runtime: DeviceRuntime; env: string; key: string; label: string } | null => {
		if (!entry) return null;
		if (row?.managedLaunch) return { runtime: 'llama', env: 'env-review', key: row.id, label: 'Device' };
		const review = data.reviewServers.find((item) => item.id === entry.id);
		if (review) {
			const torch = entry.id === 'hayai-ocr-v2' || entry.id === 'manga-ocr';
			return { runtime: torch ? 'torch' : 'llama', env: 'env-review', key: entry.id, label: torch ? 'GPU' : 'Device' };
		}
		if (entry.id === 'hy-mt2-manga-v5' || entry.id === 'shisa-v2.1-qwen3-8b-q4')
			return { runtime: 'llama', env: 'env-review', key: entry.id, label: 'Device' };
		if (entry.id === 'imsbee-ko-en-translator' || entry.id === 'opus-mt-ja-en' || entry.id === 'sugoi-v4-ja-en')
			return { runtime: 'torch', env: 'env-review', key: entry.id, label: 'GPU' };
		if (entry.id.startsWith('qwen-image'))
			return { runtime: 'llama', env: 'env-review', key: 'qwen-image-edit-2511', label: 'Device' };
		if (['rtdetr', 'ctd', 'koharu', 'coo', 'big-lama', 'aot', 'lama-manga', 'migan', 'manga-inpainting'].includes(entry.id))
			return { runtime: 'torch', env: 'env-workflow', key: 'cleaning-worker', label: 'Cleaning worker GPU' };
		return null;
	});
	const deviceChoice = $derived.by(() => {
		if (!entry || !deviceKind) return 'auto';
		if (row?.managedLaunch) return row.managedLaunch.device || 'auto';
		const review = data.reviewServers.find((item) => item.id === entry.id);
		// Review servers carry their own choice; everything else (cleaning worker,
		// image editors, translators) lives in the shared device-preference map.
		return review?.deviceChoice || data.devicePrefs?.[deviceKind.key] || 'auto';
	});
	const options = $derived(deviceKind ? deviceOptions(deviceKind.runtime, data.hardware, deviceKind.env) : []);
	/** Stable across the 4s poll, so opening a managed row fetches presets once. */
	const managedPresetId = $derived(row?.managedLaunch ? row.id : '');
	const cliSeedKey = $derived(row?.cliAdapter ? `${row.id}\0${row.cliAdapter}` : '');

	let busy = $state('');
	let cliPath = $state('');
	let testing = $state<string>('');
	let launchPresets = $state<Record<string, ManagedLaunch>>({});
	let cliSeeded = '';

	$effect(() => {
		const id = managedPresetId;
		if (!id) return;
		let live = true;
		void fetch('/api/admin/managed-models')
			.then((res) => (res.ok ? res.json() : { presets: {} }))
			.then((json) => {
				if (live) launchPresets = (json.presets || {}) as Record<string, ManagedLaunch>;
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	});

	$effect(() => {
		const key = cliSeedKey;
		if (!key) {
			cliSeeded = '';
			return;
		}
		if (key === cliSeeded) return;
		cliSeeded = key;
		const adapter = key.slice(key.indexOf('\0') + 1);
		const tools = untrack(() => data.cliTools);
		cliPath = tools.find((tool) => tool.id === adapter)?.path || '';
	});

	async function run(work: () => Promise<void>) {
		busy = 'x';
		try {
			await work();
		} catch (e) {
			toast(String((e as Error).message), 'bad');
		} finally {
			busy = '';
		}
	}

	async function setDevice(choice: string) {
		if (!entry || !deviceKind) return;
		await run(async () => {
			await apiPost('/api/admin/model-hub', { action: 'set-device', id: deviceKind!.key, choice });
			toast(`${entry!.name} → ${choice === 'auto' ? 'Auto' : choice}`);
			await refreshHub();
		});
	}
	async function setVisible(visible: boolean) {
		if (!row) return;
		await run(async () => {
			await apiPost('/api/admin/models', { action: 'update', id: row!.id, disabled: !visible });
			await refreshHub();
		});
	}
	async function setRole(role: Role, on: boolean) {
		if (!row) return;
		const roles = on ? [...new Set([...row.roles, role])] : row.roles.filter((item) => item !== role);
		await run(async () => {
			await apiPost('/api/admin/models', { action: 'update', id: row!.id, roles });
			await refreshHub();
		});
	}
	async function test(op: QualificationId) {
		if (!row) return;
		testing = op;
		try {
			await apiPost('/api/admin/models', { action: 'test', id: row.id, check: op });
			toast(`Tested ${row.name} · ${op}`);
		} catch (e) {
			toast(String((e as Error).message), 'bad');
		} finally {
			await refreshHub();
			testing = '';
		}
	}
	async function install() {
		if (!entry) return;
		await run(async () => {
			await apiPost('/api/admin/setup-install', { action: 'start', ids: [entry!.id] });
			toast(`Installing ${entry!.name} in the background`);
			await refreshHub();
		});
	}
	async function lifecycle(action: 'start' | 'stop' | 'restart') {
		if (!entry) return;
		await run(async () => {
			const url = row?.managedLaunch
				? '/api/admin/managed-models'
				: data.reviewServers.some((server) => server.id === entry!.id)
					? '/api/admin/review-models'
					: '/api/admin/image-model';
			await apiPost(url, { id: entry.id, action, ...(url.endsWith('image-model') ? { model: entry.id } : {}) });
			toast(`${entry!.name}: ${action}`);
			await refreshHub();
		});
	}
	async function setJobDefault(op: ProviderOperation) {
		if (!row) return;
		const rowId = data.defaults[op] === row.id ? '' : row.id;
		await run(async () => {
			await apiPost('/api/admin/model-hub', { action: 'set-default', job: op, rowId });
			toast('Default updated');
			await refreshHub();
		});
	}
	async function refreshRemoteList() {
		if (!row) return;
		const id = row.id;
		await run(async () => {
			await apiPost('/api/admin/models', { action: 'refresh', adapter: `remote:${id}` });
			toast('Model list refreshed');
			await refreshHub();
		});
	}
	async function saveCli() {
		if (!row?.cliAdapter) return;
		await run(async () => {
			await apiPost('/api/admin/cli-tools', { action: 'save', id: row!.cliAdapter, executable: cliPath });
			toast('Saved. Checking discovery…');
			await apiPost('/api/admin/cli-tools', { action: 'check', id: row!.cliAdapter });
			await refreshHub();
		});
	}
	async function remove() {
		if (!row || !window.confirm(`Delete ${row.name}? Its configuration is removed from this machine.`)) return;
		await run(async () => {
			await apiPost('/api/admin/models', { action: 'delete', id: row!.id });
			toast(`${row!.name} removed`, 'warn');
			openDrawer(null);
			await refreshHub();
		});
	}

	function probeText(op: QualificationId) {
		const probe = row && qualificationSample(row, op);
		if (!probe) return null;
		if (row && !qualificationCurrent(row, op)) return { tone: 'warn', text: 'Stale · retest' };
		if (probe.ok) return { tone: 'ok', text: `✓ ${probe.ms ? Math.round(probe.ms) + ' ms' : ''} · ${new Date(probe.at).toLocaleString()}` };
		return { tone: 'bad', text: `✗ ${probe.reason || 'failed'}` };
	}
	const plan = $derived(entry ? planSteps(data, [entry.id]) : []);
	const queued = $derived(entry ? queueFor(data, entry.id) : undefined);
</script>

{#if entry && st}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="scrim" role="presentation" onclick={() => openDrawer(null)}></div>
	<div class="drawer" role="dialog" aria-label={entry.name}>
		<div class="drawer-head">
			<div class="spread">
				<span class="src"><i class="bi {entry.source === 'remote' ? 'bi-cloud' : entry.source === 'cli' ? 'bi-terminal' : entry.source === 'service' ? 'bi-plug' : 'bi-hdd'}"></i>{entry.sourceLabel}</span>
				<button class="icon-btn" onclick={() => openDrawer(null)} aria-label="Close"><i class="bi bi-x-lg"></i></button>
			</div>
			<h2 style="margin-top:.3rem">{entry.name}</h2>
			<div class="row" style="margin-top:.3rem">
				<span class="status tone-{st.tone}"><span class="dot {st.dot || st.tone}"></span>{st.label}</span>
				<span class="muted small">· {entry.sub}</span>
			</div>
		</div>
		<div class="drawer-body">
			<!-- status & fix -->
			<div class="d-sec">
				{#if st.key === 'missing' && target}
					<div class="fix-box">
						<strong>Not installed</strong>
						<div class="small">{target.summary}</div>
						<div class="chips" style="margin:.45rem 0">
							<span class="chip"><i class="bi bi-hdd"></i> {formatDisk(target.diskBytes)} download</span>
							{#if target.memoryBytes}<span class="chip"><i class="bi bi-memory"></i> {formatMemory(target.memoryBytes)} while running</span>{/if}
							{#if target.requires?.length}<span class="chip warn">needs {target.requires.join(' or ')}</span>{/if}
						</div>
						{#if plan.some((step) => step.kind === 'env')}<div class="small muted">Runtime environments are installed first automatically.</div>{/if}
						<button class="btn solid sm" onclick={() => void install()}>Install</button>
					</div>
				{:else if queued}
					<div class="fix-box">
						<strong>{queued.state === 'running' ? 'Installing…' : 'Queued to install'}</strong>
						<div class="small">Runs in the background — you can leave this page.</div>
					</div>
				{:else if st.key === 'attention'}
					<div class="fix-box {st.tone === 'bad' ? 'bad' : ''}">
						<strong>{st.label}</strong>
						{#if st.detail}<div class="small">{st.detail}</div>{/if}
					</div>
				{:else if st.key === 'optional'}
					<div class="fix-box"><strong>{st.label}</strong><div class="small">{st.detail}</div></div>
				{:else}
					<div class="fix-box ok">
						<strong class="tone-ok">{st.label}</strong>
						<div class="small">{st.running ? 'Resident on its device now.' : 'Loads when a task needs it and unloads after it goes idle.'}</div>
					</div>
				{/if}
			</div>

      {#if row}
        <div class="d-sec">
          <h4>Model package</h4>
          {#if row.packageOperation}
            <p class="small">{row.packageOperation.action}: {row.packageOperation.state}{row.packageOperation.error ? ` · ${row.packageOperation.error}` : ''}</p>
            {#if row.packageOperation.messages.length}<pre style="max-height:12rem;overflow:auto">{row.packageOperation.messages.join('')}</pre>{/if}
            {#if row.packageOperation.state === 'running'}<button class="btn ghost" onclick={() => run(async () => { await apiPost('/api/admin/model-packages', { id: row!.id, action: 'cancel' }); await refreshHub(); })}>Cancel operation</button>{/if}
          {/if}
          <div class="row">
            {#each (row.packageId ? ['installation-status', 'install', 'start', 'health', 'stop', 'model-updated'] : ['model-updated']) as action}
              <button class="btn ghost" disabled={!!busy} onclick={() => run(async () => {
                const result = await apiPost('/api/admin/model-packages', { id: row!.id, action });
                toast(action === 'model-updated' ? 'Old checks are stale; retest this model' : JSON.stringify(result.output || result));
                await refreshHub();
              })}>{action === 'model-updated' ? 'Model updated · require retest' : action}</button>
            {/each}
          </div>
        </div>
      {/if}
			<!-- device -->
			{#if deviceKind && st.key !== 'missing'}
				<div class="d-sec">
					<h4>Compute device</h4>
					<label class="field">
						<span>{deviceKind.label}</span>
						<select value={deviceChoice} onchange={(e) => void setDevice(e.currentTarget.value)}>
							{#each options as option (option.value)}
								<option value={option.value}>{option.label}{option.detail ? ` — ${option.detail}` : ''}</option>
							{/each}
						</select>
					</label>
					<div class="muted small" style="margin-top:.4rem">
						Auto picks the GPU with room and falls back to CPU. GPU 1 is the lowest PCI address, and that number is the same card for every runtime.
					</div>
					{#if entry?.id === 'qwen-image-edit-2511-lightning'}
						<div class="muted small" style="margin-top:.4rem">Lightning uses the Qwen-Image-Edit 2511 device. Both editors load the same weights.</div>
					{/if}
					{#if deviceKind.key === 'cleaning-worker' && data.cleaningWorker}
						<div class="muted small" style="margin-top:.4rem">Now: {data.cleaningWorker.resolved.label} — {data.cleaningWorker.resolved.reason}.</div>
					{/if}
				</div>
			{/if}

			<!-- visibility -->
			{#if row && row.access !== 'proofreader'}
				<div class="d-sec">
					<h4>Who can pick it</h4>
					<label class="switch"><input type="checkbox" checked={!row.disabled} onchange={(e) => void setVisible(e.currentTarget.checked)} /><span class="track"></span>{row.disabled ? 'Hidden from chapter model lists' : 'Shown in chapter model lists'}</label>
					<div class="chips" style="margin-top:.6rem">
						{#each ROLE_LIST as role (role)}
							<label class="chip {row.disabled ? 'muted' : ''}"><input type="checkbox" checked={row.roles.includes(role)} disabled={row.disabled} onchange={(e) => void setRole(role, e.currentTarget.checked)} /> {role}</label>
						{/each}
					</div>
				</div>
			{/if}

      <!-- Shared checks and derived jobs -->
      {#if row}
        <div class="d-sec"><h4>Capability checks</h4>
          {#each qualificationChecks(row) as check}
            {@const probe = probeText(check)}
            <div class="op-row"><span>{qualificationLabel(check)}</span><span>{testing === check ? 'Testing…' : probe?.text || 'Untested'}</span>
              <button class="btn ghost sm" disabled={!!testing} onclick={() => void test(check)}>Test</button>
            </div>
            {@const latest = row.capabilityHistory?.filter(item => item.capability === check).at(-1) || row.probeHistory?.filter(item => item.operation === check).at(-1) || qualificationSample(row, check)}
            {#if latest}<details class="small"><summary>Last attempt · {latest.outcome || (latest.ok ? 'passed' : 'failed')}</summary>
              <p>{new Date(latest.at).toLocaleString()} · {latest.reason || 'Check passed'}</p>
              {#if latest.outputPreview}<pre style="white-space:pre-wrap;overflow-wrap:anywhere">{latest.outputPreview}</pre>{/if}
            </details>{/if}
          {/each}
        </div>
        {#if row.probeHistory?.length || Object.keys(row.probes || {}).length}<details class="d-sec"><summary>Previous job test results</summary>
          {#each row.probeHistory?.length ? row.probeHistory : Object.values(row.probes || {}) as previous}
            <p class="small">{previous.operation} · {new Date(previous.at).toLocaleString()} · {previous.outcome || (previous.ok ? 'passed' : 'failed')} {previous.reason || ''}</p>
          {/each}
        </details>{/if}
        <div class="d-sec"><h4>Jobs</h4>
          {#each CHAT_AND_CLI_OPERATIONS as op}
            <div class="op-row"><span>{op}</span><span class="small">{qualificationReason(row, op)}</span>
              <button class="icon-btn" title="Make default for this job" onclick={() => void setJobDefault(op)}>{data.defaults[op] === row.id ? '★' : '☆'}</button>
            </div>
          {/each}
        </div>
			{:else if target}
				<div class="d-sec">
					<h4>Jobs</h4>
					<div class="chips">{#each entry.tasks as t (t)}<span class="chip task">{t}</span>{/each}</div>
					{#if entry.tasks.includes('clean')}<div class="muted small" style="margin-top:.5rem">Appears as a clean method in the Clean step.</div>{/if}
				</div>
			{/if}

			<!-- setup -->
			{#if row?.http || row?.managedLaunch}
				<div class="d-sec">
					<h4>Setup</h4>
					<dl class="kv">
						<dt>{row.managedLaunch ? 'Endpoint' : 'Base URL'}</dt><dd><code>{row.managedLaunch ? `http://127.0.0.1:${row.managedLaunch.port}/v1` : row.http?.baseUrl || '—'}</code></dd>
						<dt>API key</dt><dd><code>{row.http?.apiKeyEnv || '—'}</code> {#if !row.managedLaunch}<span class="chip {data.report.items.find((i) => i.id === `remote:${row.id}`)?.state === 'configured' ? 'ok' : 'warn'}">{data.report.items.find((i) => i.id === `remote:${row.id}`)?.state === 'configured' ? 'set in .env' : 'not set'}</span>{/if}</dd>
						<dt>Model id</dt><dd><code>{row.slug}</code></dd>
					</dl>
					{#if !row.managedLaunch}
					<div class="row" style="margin-top:.6rem">
						<button class="btn ghost sm" onclick={() => void refreshRemoteList()}>Refresh model list</button>
					</div>
					{/if}
				</div>
			{/if}
			{#if row?.managedLaunch}
				<div class="d-sec">
					<h4>Launch</h4>
					<LocalModelEditor {row} status={row.managed} presets={launchPresets} onSaved={async () => { await refreshHub(); }} />
				</div>
			{/if}
			{#if row?.cliAdapter}
				<div class="d-sec">
					<h4>Command-line agent</h4>
					<dl class="kv">
						<dt>Found via</dt><dd>{data.cliTools.find((t) => t.id === row.cliAdapter)?.source === 'saved_setting' ? 'saved location' : data.cliTools.find((t) => t.id === row.cliAdapter)?.source === 'environment' ? 'environment variable' : 'automatic discovery'}</dd>
						<dt>Model</dt><dd><code>{row.slug}</code></dd>
					</dl>
					<label class="field" style="margin-top:.5rem"><span>Executable</span><input type="text" bind:value={cliPath} placeholder="path or command name" /></label>
					<div class="row" style="margin-top:.5rem"><button class="btn sm" onclick={() => void saveCli()}>Save & check</button></div>
				</div>
			{/if}
			{#if target && target.summary}
				<div class="d-sec">
					<h4>Install</h4>
					<dl class="kv">
						<dt>Size on disk</dt><dd>{formatDisk(target.diskBytes)}</dd>
						{#if target.memoryBytes}<dt>Memory running</dt><dd>{formatMemory(target.memoryBytes)}</dd>{/if}
						{#if target.requires?.length}<dt>Runs in</dt><dd><code>{target.requires.join(', ')}</code></dd>{/if}
					</dl>
					{#if entry.installed && queued == null}
						<details style="margin-top:.5rem"><summary class="muted small">Install command</summary><code class="cmd" style="margin-top:.4rem">{plan[0]?.command || ''}</code></details>
						<div class="row" style="margin-top:.6rem"><button class="btn danger sm" onclick={() => openUninstall(entry.id)}><i class="bi bi-trash"></i> Uninstall…</button><span class="muted small">Shows exactly what gets deleted first.</span></div>
					{/if}
				</div>
			{/if}

			<!-- runtime (rows with a launch recipe drive Start/Stop/Restart from the Launch editor) -->
			{#if (!row?.managedLaunch && (data.reviewServers.some((s) => s.id === entry.id) || entry.id.startsWith('qwen-image'))) && st.key !== 'missing'}
				{@const live = Boolean(st.running && st.tone === 'ok')}
				<div class="d-sec">
					<h4>Runtime</h4>
					<div class="row">
						<button class="btn ghost sm" disabled={Boolean(st.running)} onclick={() => void lifecycle('start')}>Start</button>
						<button class="btn ghost sm" disabled={!live} onclick={() => void lifecycle('stop')}>Stop</button>
						<button class="btn ghost sm" disabled={!live} onclick={() => void lifecycle('restart')}>Restart</button>
					</div>
					{#if row?.managed?.pendingChanges}<div class="fix-box" style="margin-top:.5rem">Saved changes pending — Restart to apply.</div>{/if}
				</div>
			{/if}

			<!-- remove -->
			{#if row && !row.seeded && st.key !== 'missing'}
				<div class="d-sec">
					<h4>Remove</h4>
					<div class="spread"><span class="muted small grow">Chapters that used it fall back to the job default.</span><button class="btn danger sm" onclick={() => void remove()}>Delete</button></div>
				</div>
			{/if}
		</div>
	</div>
{/if}
