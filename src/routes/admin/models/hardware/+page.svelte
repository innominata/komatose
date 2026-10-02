<script lang="ts">
	import {
		hub,
		apiPost,
		hubPost,
		toast,
		refreshHub,
		deviceRows,
		modelStatus,
		openDrawer,
	} from '$lib/components/admin/hub.svelte';
	import { formatMiB, cardLabel, deviceOptions, shownDevice } from '$lib/computeDevices';
	import { formatResidentMemory } from '$lib/gpuResidents';
	import type { DeviceUser } from '$lib/components/admin/hub.svelte';
	import ModelPackTransfer from '$lib/components/ModelPackTransfer.svelte';

	const ENV_NOTE: Record<string, string> = {
		'env-ocr': 'Detectors and the cleaning worker',
		'env-review': 'Hayai, Manga OCR, and the other PyTorch reviewers',
		'env-workflow': 'Masking, inpainting, and bubble geometry',
	};

	function swatch(kind: DeviceUser['kind']) {
		if (kind === 'chat') return 'chat';
		if (kind === 'edit') return 'edit';
		if (kind === 'venv') return 'venv';
		if (kind === 'other') return 'other';
		return 'ocr';
	}
	/** Where a pid's bytes actually sit, from the nvtop snapshot. */
	function residentPlace(pid?: number): string {
		if (!pid) return '';
		const parts: string[] = [];
		for (const device of devices) {
			for (const user of device.users) {
				if (user.pid !== pid) continue;
				const memory = formatResidentMemory(user);
				if (memory) parts.push(`${device.name} ${memory}`);
			}
		}
		return parts.join(', ');
	}

	const data = $derived($hub!);
	const devices = $derived(deviceRows(data));
	const managedRows = $derived(data.rows.filter((row) => row.managedLaunch));
	let busy = $state('');

	async function lifecycle(url: string, body: Record<string, unknown>, label: string, action: string) {
		busy = `${label}:${action}`;
		try {
			await apiPost(url, body);
			toast(`${label}: ${action}`);
			await refreshHub();
		} catch (e) {
			toast(String((e as Error).message), 'bad');
		} finally {
			busy = '';
		}
	}
	async function setWorkerDevice(choice: string) {
		try {
			await hubPost({ action: 'set-device', id: 'cleaning-worker', choice });
			toast(`Cleaning worker → ${choice}`);
		} catch (e) {
			toast(String((e as Error).message), 'bad');
		}
	}
	async function setGpuMode(enabled: boolean, input: HTMLInputElement) {
		try {
			await hubPost({ action: 'set-gpu-mode', enabled });
			toast(enabled ? 'GPU mode on — Komatose owns the GPUs' : 'GPU mode off — host layout untouched', 'warn');
		} catch (e) {
			input.checked = Boolean(data.gpuMode?.komatose);
			toast(String((e as Error).message), 'bad');
		}
	}
	async function recheckDevices() {
		try {
			await hubPost({ action: 'refresh-hardware' });
			toast('Devices rechecked');
		} catch (e) {
			toast(String((e as Error).message), 'bad');
		}
	}
	async function installEnv(id: string, label: string) {
		try {
			await apiPost('/api/admin/setup-install', { action: 'start', ids: [id] });
			toast(`Installing ${label}`);
			await refreshHub();
		} catch (e) {
			toast(String((e as Error).message), 'bad');
		}
	}
</script>

<div class="page-head">
	<div>
		<div class="kicker">Administration · Models</div>
		<h1>Hardware & services</h1>
		<p>What is loaded where. Services load when a task needs them and unload after they go idle; starting one here keeps it resident. CUDA, ROCm, Vulkan and Metal builds are all supported — the device lists come from the installed llama.cpp and PyTorch builds.</p>
	</div>
	<div class="row">
		<button class="btn ghost" onclick={() => void recheckDevices()}><i class="bi bi-arrow-repeat"></i> Recheck devices</button>
	</div>
</div>

<div class="devices">
	{#each devices as device (device.name)}
		<div class="card device">
			<div class="spread"><h3>{device.name}</h3><span class="muted small">{cardLabel(device.label)}{device.integrated ? ' · integrated' : ''}</span></div>
			<div class="bar lg">
				<span class="seg-used" style="width:{Math.min(100, (device.usedMiB / Math.max(1, device.totalMiB)) * 100)}%"></span>
			</div>
			<div class="small"><strong>{formatMiB(device.usedMiB)}</strong> / {formatMiB(device.totalMiB)} {device.integrated ? 'shared with RAM' : 'VRAM'}</div>
			<div class="stack" style="gap:.25rem">
				{#each device.users as user (`${user.pid ?? user.label}:${user.vramMiB ?? 0}:${user.gttMiB ?? 0}`)}
					<div class="resident small">
						<span class="row"><i class="sw seg-{swatch(user.kind)}" style="width:10px;height:10px;display:inline-block"></i>{user.label}{#if user.detail} <span class="muted">· {user.detail}</span>{/if}</span>
						{#if formatResidentMemory(user)}<span class="muted mem">{formatResidentMemory(user)}</span>{/if}
					</div>
				{:else}
					<span class="muted small">Nothing resident right now.</span>
				{/each}
			</div>
		</div>
	{/each}
	<div class="card device">
		<div class="spread"><h3>System memory</h3><span class="muted small">{data.hardware.cpu.model}</span></div>
		<div class="bar lg"><span class="seg-used" style="width:{Math.min(100, ((data.hardware.ram.totalMiB - data.hardware.ram.freeMiB) / Math.max(1, data.hardware.ram.totalMiB)) * 100)}%"></span></div>
		<div class="small"><strong>{formatMiB(data.hardware.ram.totalMiB - data.hardware.ram.freeMiB)}</strong> / {formatMiB(data.hardware.ram.totalMiB)} used · {data.hardware.cpu.cores} cores</div>
	</div>
</div>

<div class="section">
	<div class="section-head"><h2>Services</h2><span class="muted small">Chat servers, OCR and translator services, and the image editor.</span></div>
	<div class="card" style="padding:0">
		<table class="mtable svc-table">
			<thead><tr><th>Service</th><th>Device</th><th>Port</th><th>Status</th><th></th></tr></thead>
			<tbody>
				<tr class="group"><td colspan="5"><b>Chat models</b></td></tr>
				{#each managedRows as row (row.id)}
					{@const status = modelStatus(data, row)}
					{@const state = row.managed?.state || 'stopped'}
					{@const up = state === 'running'}
					{@const transition = state === 'starting' || state === 'stopping'}
					<tr>
						<td><button class="btn link" onclick={() => openDrawer(row.id)}>{row.name}</button></td>
						<td class="muted">{residentPlace(row.managed?.pid) || shownDevice(data.hardware, row.managed?.device || row.managedLaunch?.device) || 'auto'}</td>
						<td class="muted">{row.managed?.port || row.managedLaunch?.port || '—'}</td>
						<td><span class="status tone-{status.tone}"><span class="dot {status.dot || status.tone}"></span>{status.label}</span></td>
						<td>
							<div class="row">
								<button class="btn ghost sm" disabled={!!busy || up || transition} onclick={() => void lifecycle('/api/admin/managed-models', { id: row.id, action: 'start' }, row.name, 'start')}>Start</button>
								<button class="btn ghost sm" disabled={!!busy || !up} onclick={() => void lifecycle('/api/admin/managed-models', { id: row.id, action: 'stop' }, row.name, 'stop')}>Stop</button>
								<button class="btn ghost sm" disabled={!!busy || !up} onclick={() => void lifecycle('/api/admin/managed-models', { id: row.id, action: 'restart' }, row.name, 'restart')}>Restart</button>
							</div>
						</td>
					</tr>
				{/each}

				<tr class="group"><td colspan="5"><b>OCR, vision & translator services</b></td></tr>
				{#each data.reviewServers as server (server.id)}
					<tr>
						<td><button class="btn link" onclick={() => openDrawer(server.id)}>{server.label}</button>{#if !server.installed} <span class="chip muted">not installed</span>{/if}</td>
						<td class="muted">{residentPlace(server.pid) || shownDevice(data.hardware, server.device) || '—'}</td>
						<td class="muted">{server.port || '—'}</td>
						<td><span class="status tone-{server.state === 'running' ? 'ok' : server.state === 'error' ? 'bad' : 'idle'}"><span class="dot {server.state === 'running' ? 'ok' : server.state === 'error' ? 'bad' : 'idle'}"></span>{server.state}{server.served && server.served !== server.id ? ` · serving ${server.served}` : ''}</span></td>
						<td>
							<div class="row">
								<button class="btn ghost sm" disabled={!!busy || !server.installed} onclick={() => void lifecycle('/api/admin/review-models', { id: server.id, action: 'start' }, server.label, 'start')}>Start</button>
								<button class="btn ghost sm" disabled={!!busy || server.state !== 'running'} onclick={() => void lifecycle('/api/admin/review-models', { id: server.id, action: 'stop' }, server.label, 'stop')}>Stop</button>
								<button class="btn ghost sm" disabled={!!busy || server.state !== 'running'} onclick={() => void lifecycle('/api/admin/review-models', { id: server.id, action: 'restart' }, server.label, 'restart')}>Restart</button>
							</div>
						</td>
					</tr>
				{/each}

				<tr class="group"><td colspan="5"><b>Image editors</b></td></tr>
				{#each data.editors as editor (editor.id)}
					{@const running = editor.state === 'running'}
					{@const transition = editor.state === 'starting' || editor.state === 'stopping'}
					{@const tone = running ? 'ok' : editor.state === 'error' ? 'bad' : transition || editor.busy ? 'busy' : 'idle'}
					<tr>
						<td>
							<button class="btn link" onclick={() => openDrawer(editor.id)}>{editor.label}</button>
							{#if !editor.installed}<span class="chip muted">not installed</span>{/if}
						</td>
						<td class="muted">{residentPlace(editor.pid) || shownDevice(data.hardware, editor.device)}</td>
						<td class="muted">{editor.port}</td>
						<td>
							<span class="status tone-{tone}">
								<span class="dot {tone}"></span>
								{editor.state}{editor.busy ? ' · cleaning' : ''}{editor.pid ? ` · pid ${editor.pid}` : ''}
							</span>
							{#if editor.error}<div class="muted small">{editor.error}</div>{/if}
						</td>
						<td>
							<div class="row">
								<button class="btn ghost sm" disabled={!!busy || transition || !editor.installed} onclick={() => void lifecycle('/api/admin/image-model', { action: 'start', model: editor.id }, editor.label, 'start')}>Start</button>
								<button class="btn ghost sm" disabled={!!busy || !running} onclick={() => void lifecycle('/api/admin/image-model', { action: 'stop', model: editor.id }, editor.label, 'stop')}>Stop</button>
								<button class="btn ghost sm" disabled={!!busy || !running} onclick={() => void lifecycle('/api/admin/image-model', { action: 'restart', model: editor.id }, editor.label, 'restart')}>Restart</button>
							</div>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	<div class="muted small" style="margin-top:.5rem">
		Qwen-Image-Edit 2511 and Lightning share one process and one port. Starting either unloads chat models on that device.
	</div>
</div>

<div class="section two-col">
	<div>
		<div class="section-head"><h2>Python environments</h2><span class="muted small">Installed automatically when a model needs one.</span></div>
		<div class="card" style="padding:0">
			<table class="mtable">
				<tbody>
					{#each data.environments as env (env.id)}
						{@const torch = data.hardware.torch.find((item) => item.env === env.id)}
						<tr>
							<td><strong>{env.label}</strong><div class="muted small">{ENV_NOTE[env.id] || 'Python environment'}</div></td>
							<td>
								{#if env.installed}<span class="status tone-ok"><span class="dot ok"></span>Installed</span>{:else}<span class="status tone-idle"><span class="dot idle"></span>Not installed</span>{/if}
								{#if torch}<span class="chip {torch.backend === 'missing' ? 'muted' : torch.backend === 'cpu' ? 'warn' : 'ok'}">{torch.backend}{torch.version ? ` · ${torch.version}` : ''}</span>{/if}
							</td>
							<td style="text-align:right">{#if !env.installed}<button class="btn ghost sm" disabled={!!busy} onclick={() => void installEnv(env.id, env.label)}>Install</button>{/if}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<div class="card">
			<div class="spread"><h3 style="font-size:1rem;margin:0">GPU mode</h3><span class="chip {data.gpuMode?.komatose ? 'ok' : 'muted'}">{data.gpuMode?.komatose ? 'On' : 'Off'}</span></div>
			<p class="muted small">Komatose owns the GPUs: OCR, vision and cleaning services stay resident on their pinned cards, the review ports are reserved for them, and the app reports GPU instead of CPU.</p>
			<label class="switch">
				<input type="checkbox" checked={data.gpuMode?.komatose} disabled={data.gpuMode?.source === 'env'} onchange={(e) => void setGpuMode(e.currentTarget.checked, e.currentTarget)} /><span class="track"></span>
				{data.gpuMode?.komatose ? 'Komatose owns the GPUs' : 'Leave the host layout alone'}
			</label>
			{#if data.gpuMode?.source === 'env'}<div class="muted small">Pinned by <code>SCAN_GPU_MODE</code> in the environment.</div>{/if}
		</div>
		<div class="card" style="margin-top:.75rem">
			<h3 style="font-size:1rem">Cleaning worker</h3>
			<p class="muted small">Masking, inpainting and bubble geometry run through one PyTorch worker.</p>
			<label class="field">
				<span>Device</span>
				<select onchange={(e) => void setWorkerDevice(e.currentTarget.value)} value={data.devicePrefs?.['cleaning-worker'] ?? 'auto'}>
					{#each deviceOptions('torch', data.hardware, 'env-workflow') as option (option.value)}<option value={option.value}>{option.label}{option.detail ? ` — ${option.detail}` : ''}</option>{/each}
				</select>
			</label>
			{#if data.cleaningWorker}
				<div class="spread small" style="margin-top:.5rem">
					<span class="muted">Runs on</span>
					<strong>{data.cleaningWorker.resolved.label}</strong>
				</div>
				<div class="muted small">{data.cleaningWorker.resolved.reason}{data.cleaningWorker.choice === 'auto' ? '' : ` · saved as ${data.cleaningWorker.choice}`}</div>
			{/if}
		</div>
	</div>
	<div>
		<div class="section-head"><h2>Move to another machine</h2></div>
		<ModelPackTransfer onapplied={() => void refreshHub()} />
	</div>
</div>
