<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		hub,
		apiPost,
		toast,
		planSteps,
	} from '$lib/components/admin/hub.svelte';
	import { INSTALL_TARGETS, formatDisk } from '$lib/installCatalog';

	const data = $derived($hub!);
	const steps = ['Translation', 'Reading pages', 'Cleaning', 'Review & install'];
	let step = $state(0);

	// step 1
	let translate = $state<Set<string>>(new Set(['local']));
	// step 2
	let read = $state<Set<string>>(new Set(['rtdetr', 'ctd', 'hayai-ocr-v2', 'paddleocr-vl-1.6']));
	// step 3
	let clean = $state('fill');
	// step 4
	let installing = $state(false);

	function toggleSet(set: Set<string>, key: string) {
		const next = new Set(set);
		if (next.has(key)) next.delete(key);
		else {
			next.delete('later');
			next.add(key);
		}
		return next;
	}

	const installed = (id: string) => data.installs.find((item) => item.id === id)?.installed === true;
	const chatTargets = $derived(['qwen3.8-27b', 'qwen3-vl-8b'].map((id) => INSTALL_TARGETS.find((t) => t.id === id)!).filter(Boolean));

	const wanted = $derived.by(() => {
		const ids: string[] = [];
		if (translate.has('local')) {
			const chosen = [...translate].find((item) => item.startsWith('install:'));
			ids.push(chosen ? chosen.slice('install:'.length) : 'qwen3.8-27b');
		}
		ids.push(...read);
		if (clean === 'fill' || clean === 'local' || clean === 'codex') ids.push('lama-manga');
		if (clean === 'local') ids.push('qwen-image-2.1');
		return ids.filter((id) => !installed(id));
	});
	const plan = $derived(planSteps(data, wanted));
	const totalBytes = $derived(plan.reduce((sum, step) => sum + step.diskBytes, 0));
	const cliTools = $derived(data.cliTools.filter((tool) => tool.found));

	async function finish() {
		installing = true;
		try {
			if (plan.length) await apiPost('/api/admin/setup-install', { action: 'start', ids: plan.map((item) => item.id) });
			toast(plan.length ? `Installing ${plan.length} step${plan.length === 1 ? '' : 's'} in the background` : 'Nothing to install');
			await goto('/admin/models');
		} catch (e) {
			toast(String((e as Error).message), 'bad');
			installing = false;
		}
	}
</script>

<div class="wizard">
	<div class="kicker">Guided setup</div>
	<h1>Set up Komatose on this machine</h1>
	<div class="hw-strip" style="margin-top:.8rem">
		<span><i class="bi bi-gpu-card"></i> {#each data.hardware.llama.devices as device (device.name)}<b>{device.name}</b> {device.label} · {formatDisk(device.totalMiB * 1024 * 1024)} &nbsp; {/each}{#if !data.hardware.llama.devices.length}no GPU reported · CPU only{/if}</span>
		<span><i class="bi bi-memory"></i> <b>{Math.round(data.hardware.ram.totalMiB / 1024)} GB</b> RAM</span>
	</div>

	<div class="steps">
		{#each steps as label, i (label)}
			<div class="st {i === step ? 'on' : i < step ? 'done' : ''}">{i + 1}. {label}</div>
		{/each}
	</div>

	{#if step === 0}
		<h2>How should Komatose translate?</h2>
		<p class="muted">Pick any combination. Everything can be changed later in Models.</p>
		<div class="choice-grid">
			<button class="choice {translate.has('local') ? 'on' : ''}" onclick={() => (translate = toggleSet(translate, 'local'))}>
				<i class="bi bi-gpu-card"></i><strong>On this machine</strong>
				<span class="muted">Install a local chat model — Qwen 3.8 27B, or Qwen3-VL 8B for modest hardware and CPU.</span>
			</button>
			<button class="choice {translate.has('remote') ? 'on' : ''}" onclick={() => (translate = toggleSet(translate, 'remote'))}>
				<i class="bi bi-cloud"></i><strong>Remote API</strong>
				<span class="muted">OpenAI, DeepSeek, Moonshot, Qwen and other providers. Billed per call.</span>
			</button>
			<button class="choice {translate.has('cli') ? 'on' : ''}" onclick={() => (translate = toggleSet(translate, 'cli'))}>
				<i class="bi bi-terminal"></i><strong>CLI agent</strong>
				<span class="muted">{cliTools.length ? cliTools.map((tool) => `${tool.label} ✓`).join(' · ') : 'Install Codex, Cursor or Grok on this server.'}</span>
			</button>
			<button class="choice {translate.has('later') ? 'on' : ''}" onclick={() => (translate = new Set(['later']))}>
				<i class="bi bi-clock"></i><strong>Decide later</strong>
				<span class="muted">Set up reading and cleaning now.</span>
			</button>
		</div>
		{#if translate.has('local')}
			<div class="card" style="margin-top:.8rem">
				<div class="kicker">Local chat model</div>
				<div class="pick-list" style="max-height:none">
					{#each chatTargets as target (target.id)}
						<label class="pick">
							<input type="radio" name="chat-choice" checked={translate.has(`install:${target.id}`) || (target.id === 'qwen3.8-27b' && ![...translate].some((item) => item.startsWith('install:')))} onchange={() => { const next = new Set([...translate].filter((item) => !item.startsWith('install:'))); next.add(`install:${target.id}`); translate = next; }} />
							<span class="grow"><strong>{target.label}</strong> <span class="muted small">{target.summary}</span></span>
							<span class="muted small">{formatDisk(target.diskBytes)}{installed(target.id) ? ' · installed' : ''}</span>
						</label>
					{/each}
				</div>
			</div>
		{/if}
		{#if translate.has('remote') || translate.has('cli')}
			<div class="fix-box" style="margin-top:.8rem">
				{translate.has('remote') ? 'Remote models are added from Models → Add model → Remote API — the provider list fills in the endpoint for you.' : ''}
				{translate.has('cli') ? ' CLI models are added from Models → Add model → CLI agent.' : ''}
			</div>
		{/if}
	{:else if step === 1}
		<h2>Reading pages</h2>
		<p class="muted">Detection finds lettering; the OCR council reads every region twice and flags disagreements.</p>
		<div class="kicker" style="margin-top:1rem">Recommended</div>
		<div class="pick-list" style="max-height:none">
			{#each ['rtdetr', 'ctd', 'hayai-ocr-v2', 'paddleocr-vl-1.6'] as id (id)}
				{@const target = INSTALL_TARGETS.find((item) => item.id === id)!}
				<label class="pick">
					<input type="checkbox" checked={installed(id) || read.has(id)} disabled={installed(id)} onchange={(e) => (read = toggleSet(read, id))} />
					<span class="grow"><strong>{target.label}</strong> <span class="muted small">{target.summary}</span></span>
					{#if installed(id)}<span class="chip ok">installed</span>{:else}<span class="muted small">{formatDisk(target.diskBytes)}</span>{/if}
				</label>
			{/each}
		</div>
		<div class="kicker" style="margin-top:1rem">Optional</div>
		<div class="pick-list" style="max-height:none">
			{#each ['manga-ocr', 'koharu', 'coo', 'qwen3-vl-8b', 'hy-mt2-manga-v5', 'imsbee-ko-en-translator', 'shisa-v2.1-qwen3-8b-q4', 'sugoi-v4-ja-en'] as id (id)}
				{@const target = INSTALL_TARGETS.find((item) => item.id === id)!}
				<label class="pick">
					<input type="checkbox" checked={installed(id) || read.has(id)} disabled={installed(id)} onchange={() => (read = toggleSet(read, id))} />
					<span class="grow"><strong>{target.label}</strong> <span class="muted small">{target.summary}</span></span>
					{#if installed(id)}<span class="chip ok">installed</span>{:else}<span class="muted small">{formatDisk(target.diskBytes)}</span>{/if}
				</label>
			{/each}
		</div>
	{:else if step === 2}
		<h2>Cleaning</h2>
		<p class="muted">Masks come from the detector you picked. Choose how Komatose fills the art underneath.</p>
		<div class="choice-grid">
			<button class="choice {clean === 'fill' ? 'on' : ''}" onclick={() => (clean = 'fill')}><i class="bi bi-paint-bucket"></i><strong>Fill only</strong><span class="muted">lama-Manga inpainting · 206 MB. Great on balloons and flat art.</span></button>
			<button class="choice {clean === 'local' ? 'on' : ''}" onclick={() => (clean = 'local')}><i class="bi bi-magic"></i><strong>Redraw locally</strong><span class="muted">Qwen-Image 2.1 · 8.4 GB. Redraws detailed art under lettering.</span></button>
			<button class="choice {clean === 'codex' ? 'on' : ''}" onclick={() => (clean = 'codex')}><i class="bi bi-terminal"></i><strong>Redraw with Codex</strong><span class="muted">{cliTools.some((tool) => tool.id === 'codex') ? 'Codex CLI is on this server. Billed per page.' : 'Codex CLI isn’t installed on this server.'}</span></button>
			<button class="choice {clean === 'later' ? 'on' : ''}" onclick={() => (clean = 'later')}><i class="bi bi-clock"></i><strong>Decide later</strong><span class="muted">Built-in flat fill and Telea still work.</span></button>
		</div>
	{:else}
		<h2>Review & install</h2>
		<p class="muted">Installs run one at a time in the background; you can leave this page. Environments are queued before the models that need them.</p>
		{#if plan.length}
			<div class="plan">
				{#each plan as item, i (item.id)}
					<div class="plan-item {item.kind === 'env' ? 'dep' : ''}">
						<span class="muted small">{i + 1}</span>
						<div><strong>{item.label}</strong>{#if item.neededBy}<span class="muted small"> · needed by {item.neededBy}</span>{/if}</div>
						<span class="muted small">{formatDisk(item.diskBytes)}</span>
						<span></span>
					</div>
				{/each}
			</div>
			<div class="card" style="margin-top:1rem">
				<div class="spread"><span><strong>{formatDisk(totalBytes)}</strong> to download</span><span class="muted small">Commands are shown before anything runs.</span></div>
				<details style="margin-top:.6rem"><summary class="muted small">Show commands</summary><code class="cmd" style="margin-top:.4rem">{plan.map((item) => item.command).filter(Boolean).join('\n') || 'Commands are recorded with each install.'}</code></details>
			</div>
		{:else}
			<div class="card muted">Everything you picked is already installed.</div>
		{/if}
		<div class="fix-box ok" style="margin-top:.8rem">
			Installing a chat model sets it up automatically — Translate works as soon as the download finishes.
		</div>
	{/if}

	<div class="wiz-nav">
		{#if step > 0}
			<button class="btn ghost" onclick={() => (step = step - 1)}><i class="bi bi-arrow-left"></i> Back</button>
		{:else}
			<a class="btn ghost" href="/admin/models">Skip setup</a>
		{/if}
		{#if step < 3}
			<button class="btn solid" onclick={() => (step = step + 1)}>Next <i class="bi bi-arrow-right"></i></button>
		{:else}
			<button class="btn solid" disabled={installing} onclick={() => void finish()}><i class="bi bi-download"></i> {installing ? 'Starting…' : 'Install & finish'}</button>
		{/if}
	</div>
</div>
