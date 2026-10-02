<script lang="ts">
	import {
		hub,
		apiPost,
		hubPost,
		toast,
		refreshHub,
		installFor,
		queueFor,
		openUninstall,
	} from '$lib/components/admin/hub.svelte';
	import { INSTALL_GROUPS, INSTALL_TARGETS, formatDisk, formatMemory, installTargetsForGroup } from '$lib/installCatalog';

	const data = $derived($hub!);
	const queue = $derived(data.queue.filter((item) => item.state !== 'cancelled'));
	const active = $derived(queue.filter((item) => item.state === 'running' || item.state === 'queued'));
	let picked = $state<Set<string>>(new Set());
	let logs = $state<Set<string>>(new Set());
	let torchVariant = $derived(data.torchVariant);

	const BUNDLES = [
		{ id: 'essentials', name: 'Essentials', icon: 'bi-lightning-charge', blurb: 'Detect, transcribe and fill on the CPU. Pair with any chat model.', items: ['rtdetr', 'ctd', 'hayai-ocr-v2', 'paddleocr-vl-1.6', 'lama-manga'] },
		{ id: 'local-translate', name: 'Local translation', icon: 'bi-gpu-card', blurb: 'Run translation and notes on this machine.', items: ['qwen3.8-27b', 'hy-mt2-manga-v5'] },
		{ id: 'light-chat', name: 'Light chat & vision', icon: 'bi-feather', blurb: 'Qwen3-VL 8B — a working chat model that fits modest hardware, even CPU.', items: ['qwen3-vl-8b'] },
		{ id: 'local-clean', name: 'Local cleaning', icon: 'bi-magic', blurb: 'Redraw artwork under lettering without a remote service.', items: ['koharu', 'qwen-image-edit-2511', 'qwen-image-edit-2511-lightning', 'big-lama'] },
	];

	function togglePick(id: string, on: boolean) {
		const next = new Set(picked);
		on ? next.add(id) : next.delete(id);
		picked = next;
	}
	async function queueInstalls(ids: string[]) {
		try {
			await apiPost('/api/admin/setup-install', { action: 'start', ids });
			toast(`Queued ${ids.length} install${ids.length === 1 ? '' : 's'} — environments run first`);
			picked = new Set();
			await refreshHub();
		} catch (e) {
			toast(String((e as Error).message), 'bad');
		}
	}
	async function setTorch(variant: string) {
		try {
			await hubPost({ action: 'set-torch-variant', variant });
			toast(`PyTorch build for new environments: ${variant}`);
		} catch (e) {
			toast(String((e as Error).message), 'bad');
		}
	}
	async function clearFinished() {
		try {
			await apiPost('/api/admin/setup-install', { action: 'clear' });
			await refreshHub();
		} catch (e) {
			toast(String((e as Error).message), 'bad');
		}
	}
	async function cancelItem(id: string) {
		try {
			await apiPost('/api/admin/setup-install', { action: 'cancel', id });
			await refreshHub();
		} catch (e) {
			toast(String((e as Error).message), 'bad');
		}
	}
	function bundleState(items: string[]) {
		const missing = items.filter((id) => !installFor(data, id)?.installed);
		return { missing, done: !missing.length };
	}
</script>

<div class="page-head">
	<div>
		<div class="kicker">Administration · Models</div>
		<h1>Install</h1>
		<p>Everything Komatose can download, grouped by job. Required Python environments are queued automatically and installed first. Every install shows its exact command and runs in the background.</p>
	</div>
</div>

{#if queue.length}
	<div class="section" style="margin-top:0">
		<div class="section-head">
			<h2>Install queue</h2>
			<div class="row">
				<span class="muted small">{active.length ? `${active.length} remaining · runs one at a time` : 'All done'}</span>
				{#if queue.some((item) => item.state === 'done' || item.state === 'failed')}
					<button class="btn ghost sm" onclick={() => void clearFinished()}>Clear finished</button>
				{/if}
			</div>
		</div>
		<div class="queue">
			{#each queue as item (item.key)}
				{@const job = installFor(data, item.key)?.job}
				<div class="q-item">
					<div class="spread">
						<div class="row">
							<span class="dot {item.state === 'running' ? 'busy' : item.state === 'done' ? 'ok' : item.state === 'failed' ? 'bad' : 'idle'}"></span>
							<strong>{item.label}</strong>
							{#if item.neededBy}<span class="chip muted">needed by {item.neededBy}</span>{/if}
							<span class="muted small">{item.kind === 'env' ? 'runtime environment' : 'model'}</span>
						</div>
						<div class="row">
							<span class="small muted">{item.state === 'running' ? 'Installing…' : item.state}</span>
							{#if job?.lines?.length}
								<button class="btn ghost sm" onclick={() => { const next = new Set(logs); next.has(item.key) ? next.delete(item.key) : next.add(item.key); logs = next; }}>{logs.has(item.key) ? 'Hide log' : 'Log'}</button>
							{/if}
							{#if item.state === 'running' || item.state === 'queued'}
								<button class="btn danger sm" onclick={() => void cancelItem(item.key)}>Cancel</button>
							{/if}
						</div>
					</div>
					{#if item.error}<div class="small tone-bad">{item.error}</div>{/if}
					{#if logs.has(item.key) && job?.lines?.length}<pre class="log">{job.lines.join('\n')}</pre>{/if}
				</div>
			{/each}
		</div>
	</div>
{/if}

<div class="section" style="margin-top:0">
	<div class="section-head"><h2>Bundles</h2><span class="muted small">Sets that work together — only what’s missing is installed.</span></div>
	<div class="bundles">
		{#each BUNDLES as bundle (bundle.id)}
			{@const state = bundleState(bundle.items)}
			<div class="bundle {state.done ? 'done' : ''}">
				<div class="row"><i class="bi {bundle.icon} tone-ok" style="font-size:1.2rem"></i><h3>{bundle.name}</h3></div>
				<div class="muted small">{bundle.blurb}</div>
				<ul>
					{#each bundle.items as id (id)}
						{@const target = INSTALL_TARGETS.find((item) => item.id === id)}
						{#if target}
							<li class={installFor(data, id)?.installed ? 'have' : ''}>{target.label} <span class="muted">· {formatDisk(target.diskBytes)}</span></li>
						{/if}
					{/each}
				</ul>
				<div class="spread">
					{#if state.done}
						<span class="status tone-ok"><i class="bi bi-check2-circle"></i> All installed</span>
					{:else}
						<span class="small">{state.missing.length} to install</span>
						<button class="btn sm" onclick={() => void queueInstalls(state.missing)}>Install</button>
					{/if}
				</div>
			</div>
		{/each}
	</div>
</div>

<div class="section">
	<div class="section-head">
		<h2>All models</h2>
		<div class="row">
			<span class="muted small">PyTorch build for new environments</span>
			<div class="seg">
				{#each ['auto', 'cpu', 'cuda', 'rocm'] as variant (variant)}
					<button class:on={torchVariant === variant} onclick={() => void setTorch(variant)}>{variant}</button>
				{/each}
			</div>
		</div>
	</div>

	{#each INSTALL_GROUPS as group (group.id)}
		{@const targets = installTargetsForGroup(group.id)}
		<div class="cat-group">
			<div class="cat-group-head">
				<h3>{group.label}</h3>
				<span class="muted small">{targets.filter((target) => installFor(data, target.id)?.installed).length}/{targets.length} installed</span>
				<span class="muted small grow">{group.blurb}</span>
			</div>
			<div class="cat-grid">
				{#each targets as target (target.id)}
					{@const ins = installFor(data, target.id)}
					{@const queued = queueFor(data, target.id)}
					{@const running = queued || ins?.job?.state === 'running'}
					<div class="cat-item {ins?.installed ? 'installed' : ''} {picked.has(target.id) ? 'picked' : ''}">
						<div class="ci-head">
							{#if !ins?.installed && !running}
								<input type="checkbox" checked={picked.has(target.id)} onchange={(e) => togglePick(target.id, e.currentTarget.checked)} />
							{/if}
							<strong>{target.label}</strong>
						</div>
						<div class="ci-sum">{target.summary}</div>
						<div class="ci-foot">
							<span class="chip"><i class="bi bi-hdd"></i> {formatDisk(target.diskBytes)}</span>
							{#if target.memoryBytes}<span class="chip"><i class="bi bi-memory"></i> {formatMemory(target.memoryBytes)}</span>{/if}
							{#if target.unlocks}<span class="chip muted">{target.unlocks}</span>{/if}
							{#if target.requires?.length && !ins?.installed}<span class="chip warn">+ {target.requires.join(' or ')}</span>{/if}
							{#if ins?.installed}
								<span class="status tone-ok"><i class="bi bi-check2-circle"></i> Installed</span>
								<button class="btn ghost sm" onclick={() => openUninstall(target.id)}>Uninstall</button>
							{:else if running}
								<span class="status tone-busy"><span class="dot busy"></span>{queued?.state === 'queued' ? 'Queued' : 'Installing…'}</span>
							{:else if ins?.job?.state === 'failed'}
								<button class="btn sm" onclick={() => void queueInstalls([target.id])}>Retry</button>
							{:else}
								<button class="btn sm" onclick={() => void queueInstalls([target.id])}>Install</button>
							{/if}
						</div>
						{#if ins?.job?.state === 'failed' && ins.job.error}<div class="small tone-bad">{ins.job.error}</div>{/if}
					</div>
				{/each}
			</div>
		</div>
	{/each}

	<div class="card tight muted small" style="margin-top:1.2rem">
		<i class="bi bi-box"></i> Built in, nothing to install: the heuristic bubble detector, PaddleOCR line detection (part of the OCR environment), flat fill and Telea clean methods.
	</div>
</div>

{#if picked.size}
	<div class="sticky-cart">
		<strong>{picked.size} selected</strong>
		<span class="muted small">Environments run first automatically</span>
		<button class="btn solid sm" style="margin-left:auto" onclick={() => void queueInstalls([...picked])}>Install</button>
		<button class="btn ghost sm" onclick={() => (picked = new Set())}>Clear</button>
	</div>
{/if}
