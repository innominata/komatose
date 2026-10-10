<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		hub,
		ui,
		apiPost,
		toast,
		refreshHub,
		openAdd,
	} from '$lib/components/admin/hub.svelte';
	import { deviceOptions } from '$lib/computeDevices';
	import type { ManagedLaunch } from '$lib/managedModels';
	import { QWEN_38_27B_ID, QWEN_38_27B_LABEL } from '$lib/qwenModels';
	import { GEMMA4_26B_LABEL, GEMMA4_12B_LABEL, GEMMA4_E2B_LABEL, GEMMA4_26B_ID, GEMMA4_12B_ID, GEMMA4_E2B_ID } from '$lib/gemmaModels';

	const data = $derived($hub!);
	const open = $derived($ui.addOpen);
	const step = $derived($ui.addStep);

	// ---- local
	const LOCAL_PRESETS = [
		{ id: 'qwen38', label: QWEN_38_27B_LABEL, slug: 'qwen3.8-27b-q4', target: 'qwen3.8-27b', note: 'Default chat model. Installer downloads the weights.' },
		{ id: 'gemma4-26b', label: GEMMA4_26B_LABEL, slug: GEMMA4_26B_ID, note: 'Bring your own GGUF.' },
		{ id: 'gemma4-12b', label: GEMMA4_12B_LABEL, slug: GEMMA4_12B_ID, note: 'Bring your own GGUF.' },
		{ id: 'gemma4-e2b', label: GEMMA4_E2B_LABEL, slug: GEMMA4_E2B_ID, note: 'Tiny; CPU-friendly.' },
		{ id: 'generic', label: 'Other llama.cpp model', slug: '', note: 'Any GGUF with the generic launch preset.' },
		{ id: 'external', label: 'Already-running server', slug: '', note: 'Point at an OpenAI-compatible /v1 you start yourself.' },
	];
	let localPreset = $state('qwen38');
	let localName = $state('');
	let localSlug = $state('');
	let localWeights = $state('');
	let localUrl = $state('http://127.0.0.1:8081/v1');
	let localDevice = $state('auto');
	let localPort = $state(18090);
	let localCatalog = $state<Record<string, ManagedLaunch>>({});
	/** Set the first time the local step is shown, so a blank model id never refills Name. */
	let localSeeded = false;

	// ---- remote
	type Provider = { id: string; name: string; group: string; baseUrl: string; apiKeyEnv: string; keyUrl?: string; models?: string[]; notes?: string };
	let providers = $state<Provider[]>([]);
	let providerQuery = $state('');
	let provider = $state<Provider | null>(null);
	let remoteBase = $state('');
	let remoteKeyVar = $state('OPENAI_API_KEY');
	let remoteSlug = $state('');
	let probe = $state<{ keySet: boolean; models: { id: string; label: string }[]; error?: string } | null>(null);
	let picked = $state<Set<string>>(new Set());
	let modelQuery = $state('');

	// ---- cli
	let cliAdapter = $state('codex');
	let cliPicked = $state<Set<string>>(new Set());
	let cliListed = $state<{ id: string; label: string }[] | null>(null);
	let cliLoading = $state(false);
	let cliError = $state('');
	let cliRefreshTick = $state(0);

	const providerGroups = $derived.by(() => {
		const q = providerQuery.toLowerCase();
		const match = (item: Provider) => !q || `${item.name} ${item.id} ${item.baseUrl} ${item.group}`.toLowerCase().includes(q);
		const out: { label: string; items: Provider[] }[] = [];
		for (const [key, label] of [['global', 'Global'], ['china', 'China'], ['local', 'Local servers']] as const) {
			const items = providers.filter((item) => item.group === key && match(item));
			if (items.length) out.push({ label, items });
		}
		return out;
	});

	$effect(() => {
		if (!open) return;
		if (!providers.length) {
			void fetch('/api/admin/remote-providers')
				.then((res) => (res.ok ? res.json() : { providers: [] }))
				.then((json) => (providers = json.providers || []))
				.catch(() => {});
		}
		if (step === 'local' && !localSeeded) {
			localSeeded = true;
			if (!localName.trim() && !localSlug.trim()) choosePreset(localPreset);
		}
		if (step === 'local' && !Object.keys(localCatalog).length) {
			void fetch('/api/admin/managed-models')
				.then((res) => (res.ok ? res.json() : { presets: {} }))
				.then((json) => { localCatalog = json.presets || {}; })
				.catch(() => {});
		}
	});

	/** Catalog key the managed-models presets use for a local preset id. */
	function launchPresetKey(id: string) {
		return id === 'qwen38' ? 'qwen38' : id.startsWith('gemma4') ? (id === 'gemma4-26b' ? 'gemma4' : id) : 'generic';
	}

	// A launch recipe must name a .gguf: an empty weights path is rejected by
	// the server, so the local step waits for one instead of failing on submit.
	const localNeedsWeights = $derived(
		step === 'local' &&
			localPreset !== 'external' &&
			!localWeights.trim() &&
			!localCatalog[launchPresetKey(localPreset)]?.modelPath,
	);

	function choosePreset(id: string) {
		localPreset = id;
		const preset = LOCAL_PRESETS.find((item) => item.id === id);
		localSlug = preset?.slug || '';
		localName = preset?.label || '';
		probe = null;
	}
	function chooseProvider(item: Provider) {
		provider = item;
		remoteBase = item.baseUrl;
		remoteKeyVar = item.apiKeyEnv;
		probe = null;
		picked = new Set();
		modelQuery = '';
	}

	const shownModels = $derived.by(() => {
		const models = probe?.models || [];
		const query = modelQuery.trim().toLowerCase();
		if (!query) return models;
		return models.filter((model) => `${model.id} ${model.label}`.toLowerCase().includes(query));
	});

	const llamaOptions = $derived(deviceOptions('llama', data.hardware));
	const cliTools = $derived(data.cliTools);
	const cliCatalog = $derived(cliListed ?? ((data.catalogs[cliAdapter]?.models || []) as { id: string; label: string }[]));
	let cliRemove = $state<Set<string>>(new Set());
	const cliExisting = $derived(data.rows.filter((row) => row.access === 'cli' && row.cliAdapter === cliAdapter));
	const cliChoices = $derived([
		...cliCatalog,
		...cliExisting.filter((row) => !cliCatalog.some((item) => item.id === row.slug)).map((row) => ({ id: row.slug, label: row.name })),
	]);

	$effect(() => {
		if (!open || step !== 'cli') return;
		const adapter = cliAdapter;
		const force = cliRefreshTick;
		const found = untrack(() => data.cliTools.find((tool) => tool.id === adapter)?.found);
		if (!found) {
			cliListed = [];
			cliError = '';
			cliLoading = false;
			return;
		}
		const cached = untrack(() => data.catalogs[adapter]?.models || []);
		if (!force && cached.length) {
			cliListed = cached;
			cliError = '';
			cliLoading = false;
			return;
		}
		let cancelled = false;
		cliLoading = true;
		cliError = '';
		void fetch('/api/admin/models', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'refresh', adapter }),
		})
			.then(async (res) => {
				const json = await res.json().catch(() => ({}));
				if (cancelled) return;
				cliListed = Array.isArray(json.models) ? json.models : [];
				if (!res.ok || json.ok === false) cliError = String(json.error || 'Could not list models from this CLI');
				else await refreshHub();
			})
			.catch((error) => {
				if (!cancelled) cliError = String((error as Error).message || error);
			})
			.finally(() => {
				if (!cancelled) cliLoading = false;
			});
		return () => {
			cancelled = true;
		};
	});

	async function run(work: () => Promise<void>) {
		try {
			await work();
		} catch (e) {
			toast(String((e as Error).message), 'bad');
		}
	}

	/** Preset plus the device, weights and port from the form, fetched before any row is created. */
	async function localLaunch(): Promise<ManagedLaunch> {
		const key = launchPresetKey(localPreset);
		let preset = localCatalog[key];
		if (!preset) {
			const res = await fetch('/api/admin/managed-models');
			const json = await res.json();
			localCatalog = (json.presets || {}) as Record<string, ManagedLaunch>;
			preset = localCatalog[key];
		}
		if (!preset) throw new Error('Launch preset is not available');
		return {
			...preset,
			device: localDevice,
			...(localWeights.trim() ? { modelPath: localWeights.trim() } : {}),
			...(localPreset === 'generic' ? { port: Number(localPort) } : {}),
		};
	}

	async function addLocal() {
		await run(async () => {
			if (localPreset === 'external') {
				await apiPost('/api/admin/models', { action: 'add-local', name: localName, slug: localSlug, baseUrl: localUrl, apiKeyEnv: 'LLAMASWAP_API_KEY' });
			} else {
				await apiPost('/api/admin/models', {
					action: 'add-local',
					name: localName,
					slug: localSlug,
					baseUrl: '',
					apiKeyEnv: 'LLAMASWAP_API_KEY',
					managedLaunch: await localLaunch(),
					requestPreset: localPreset === 'qwen38' ? 'qwen-thinking' : 'generic',
				});
			}
			toast(`${localName} added`);
			$ui.addOpen = false;
			await refreshHub();
		});
	}

	async function installChat() {
		await run(async () => {
			const preset = LOCAL_PRESETS.find((item) => item.id === localPreset);
			await apiPost('/api/admin/setup-install', { action: 'start', ids: [preset?.target || 'qwen3.8-27b'] });
			toast('Installing — the chat model is set up automatically when the download finishes.');
			$ui.addOpen = false;
			await refreshHub();
		});
	}

	async function probeRemote() {
		await run(async () => {
			probe = null;
			modelQuery = '';
			const json = await apiPost('/api/admin/remote-providers', { action: 'probe', baseUrl: remoteBase, apiKeyEnv: remoteKeyVar });
			probe = {
				keySet: json.keySet === true,
				models: (json.models as { id: string; label: string }[]) || [],
				error: json.error ? String(json.error) : json.reachable === false ? 'Endpoint did not answer' : undefined,
			};
		});
	}

	const remoteAddCount = $derived(probe?.models.length ? picked.size : remoteSlug.trim() ? 1 : 0);

	async function addRemote() {
		const slugs = probe?.models.length ? [...picked] : [remoteSlug.trim()].filter(Boolean);
		if (!slugs.length) return;
		await run(async () => {
			for (const slug of slugs) {
				await apiPost('/api/admin/models', {
					action: 'add-remote',
					name: slug.split('/').pop() || slug,
					slug,
					baseUrl: remoteBase,
					apiKeyEnv: remoteKeyVar,
				});
			}
			toast(`Added ${slugs.length} remote model${slugs.length === 1 ? '' : 's'}`);
			$ui.addOpen = false;
			await refreshHub();
		});
	}

	async function addCli() {
		const slugs = [...cliPicked];
		const removeIds = [...cliRemove];
		if (!slugs.length && !removeIds.length) return;
		if (removeIds.length && !window.confirm(`Remove ${removeIds.length} ${cliAdapter} model${removeIds.length === 1 ? '' : 's'}? Chapters that used them fall back to the job default.`)) return;
		await run(async () => {
			if (slugs.length) {
				const models = slugs.map((id) => ({ id, label: cliCatalog.find((item) => item.id === id)?.label || id }));
				await apiPost('/api/admin/models', { action: 'bulk-add-cli', adapter: cliAdapter, models });
			}
			const failures: string[] = [];
			for (const id of removeIds) {
				try {
					await apiPost('/api/admin/models', { action: 'delete', id });
				} catch (e) {
					failures.push(`${data.rows.find((row) => row.id === id)?.name || id}: ${(e as Error).message}`);
				}
			}
			cliPicked = new Set();
			cliRemove = new Set();
			const parts = [slugs.length && `added ${slugs.length}`, removeIds.length - failures.length && `removed ${removeIds.length - failures.length}`].filter(Boolean);
			if (failures.length) toast(`Could not remove ${failures.join('; ')}`, 'bad');
			else toast(`${cliAdapter}: ${parts.join(', ')}`);
			$ui.addOpen = false;
			await refreshHub();
		});
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="dlg-wrap" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) $ui.addOpen = false; }}>
		<div class="dlg wide" role="dialog" tabindex="-1" aria-label="Add model" onclick={(e) => e.stopPropagation()}>
			<div class="kicker">Add model</div>
			<div class="seg" style="margin:.4rem 0 1rem">
				<button class:on={step === 'choose'} onclick={() => openAdd('choose')}>Start</button>
				<button class:on={step === 'local'} onclick={() => openAdd('local')}>Local model</button>
				<button class:on={step === 'remote'} onclick={() => openAdd('remote')}>Remote API</button>
				<button class:on={step === 'cli'} onclick={() => openAdd('cli')}>CLI agent</button>
			</div>

			{#if step === 'choose'}
				<h3>What are you adding?</h3>
				<div class="choice-grid">
					<button class="choice" onclick={() => { $ui.addOpen = false; void goto('/admin/models/install'); }}><i class="bi bi-download"></i><strong>Install a model</strong><span class="muted">Detectors, OCR, translators, editors — downloaded and set up for you.</span></button>
					<button class="choice" onclick={() => openAdd('local')}><i class="bi bi-cpu"></i><strong>Local model server</strong><span class="muted">Run a GGUF with llama.cpp, or point at a server you already run.</span></button>
					<button class="choice" onclick={() => openAdd('remote')}><i class="bi bi-cloud"></i><strong>Remote API</strong><span class="muted">OpenAI, DeepSeek, Moonshot, Qwen and other OpenAI-compatible endpoints.</span></button>
					<button class="choice" onclick={() => openAdd('cli')}><i class="bi bi-terminal"></i><strong>CLI agent</strong><span class="muted">Codex, Cursor or Grok installed on this server.</span></button>
				</div>
			{:else if step === 'local'}
				<h3>Local model server</h3>
				<div class="pick-list" style="max-height:none">
					{#each LOCAL_PRESETS as preset (preset.id)}
						<label class="pick">
							<input type="radio" name="local-preset" onchange={() => choosePreset(preset.id)} checked={localPreset === preset.id} />
							<span class="grow"><strong>{preset.label}</strong> <span class="muted small">— {preset.note}</span></span>
						</label>
					{/each}
				</div>
				{#if LOCAL_PRESETS.find((p) => p.id === localPreset)?.target && !data.installs.find((item) => item.id === LOCAL_PRESETS.find((p) => p.id === localPreset)?.target)?.installed}
					<div class="fix-box" style="margin-top:.8rem">
						The weights aren’t on this machine yet.
						<button class="btn sm" onclick={() => void installChat()}>Install weights & set up automatically</button>
					</div>
				{/if}
				<div class="fields" style="margin-top:.8rem">
					<label class="field"><span>Name</span><input type="text" bind:value={localName} /></label>
					<label class="field"><span>Model id</span><input type="text" bind:value={localSlug} /></label>
					{#if localPreset === 'external'}
						<label class="field"><span>Base URL</span><input type="text" bind:value={localUrl} /></label>
					{:else}
						<label class="field"><span>Weights (.gguf)</span><input type="text" bind:value={localWeights} placeholder="~/models/model.gguf" /></label>
						<label class="field"><span>Device</span>
							<select bind:value={localDevice}>
								{#each llamaOptions as option (option.value)}<option value={option.value}>{option.label}{option.detail ? ` — ${option.detail}` : ''}</option>{/each}
							</select>
						</label>
						{#if localPreset === 'generic'}<label class="field"><span>Port</span><input type="number" bind:value={localPort} /></label>{/if}
					{/if}
				</div>
				{#if localNeedsWeights}
					<p class="muted small" style="margin-top:.6rem">Add the .gguf weights — a launch recipe needs a model file.</p>
				{/if}
			{:else if step === 'remote'}
				<h3>Remote API</h3>
				{#if providers.length}
					<input type="search" placeholder="Search providers — OpenAI, DeepSeek, Moonshot, Qwen, Ollama…" bind:value={providerQuery} />
					<div class="pick-list" style="max-height:220px">
						{#each providerGroups as group (group.label)}
							<div class="kicker" style="margin-top:.4rem">{group.label}</div>
							{#each group.items as item (item.id)}
								<label class="pick">
									<input type="radio" name="provider" onchange={() => chooseProvider(item)} checked={provider?.id === item.id} />
									<span class="grow"><strong>{item.name}</strong> <code>{item.baseUrl}</code></span>
									<span class="muted small">{item.apiKeyEnv || 'no key'}</span>
								</label>
							{/each}
						{/each}
					</div>
				{/if}
				<div class="fields" style="margin-top:.8rem">
					<label class="field"><span>Base URL</span><input type="text" bind:value={remoteBase} placeholder="https://api.example.com/v1" /></label>
					<label class="field"><span>API key variable</span><input type="text" bind:value={remoteKeyVar} placeholder="OPENAI_API_KEY" /></label>
				</div>
				<div class="row" style="margin-top:.6rem">
					<button class="btn ghost sm" onclick={() => void probeRemote()} disabled={!remoteBase}><i class="bi bi-plug"></i> Check endpoint & list models</button>
					{#if provider?.keyUrl}<a class="small" href={provider.keyUrl} target="_blank" rel="noreferrer">Get a key →</a>{/if}
				</div>
				{#if probe}
					{#if probe.error}
						<div class="fix-box bad" style="margin-top:.6rem">{probe.error}</div>
					{:else if !probe.keySet && remoteKeyVar}
						<div class="fix-box" style="margin-top:.6rem">
							<strong>{remoteKeyVar} isn’t in .env</strong> — add it on this server. You can add models now; they’ll show “key not set” until it is.
						</div>
					{/if}
					{#if probe.models.length}
						<div class="kicker" style="margin-top:.7rem">Models this endpoint offers</div>
						<input type="search" placeholder="Search returned models" aria-label="Search returned models" bind:value={modelQuery} />
						<p class="muted small" style="margin:.35rem 0 0">{shownModels.length} of {probe.models.length} shown{picked.size ? ` · ${picked.size} selected` : ''}</p>
						<div class="pick-list">
							{#each shownModels as model (model.id)}
								<label class="pick">
									<input type="checkbox" checked={picked.has(model.id)} onchange={(e) => { const next = new Set(picked); e.currentTarget.checked ? next.add(model.id) : next.delete(model.id); picked = next; }} />
									<span class="grow"><code>{model.id}</code>{#if model.label && model.label !== model.id} <span class="muted">{model.label}</span>{/if}</span>
								</label>
							{:else}
								<p class="muted small">No models match that search.</p>
							{/each}
						</div>
					{:else}
						<label class="field" style="margin-top:.6rem"><span>Or type one model id</span><input type="text" bind:value={remoteSlug} placeholder="gpt-5.4" /></label>
					{/if}
				{:else}
					<label class="field" style="margin-top:.6rem"><span>Or type one model id</span><input type="text" bind:value={remoteSlug} placeholder="gpt-5.4" /></label>
				{/if}
			{:else if step === 'cli'}
				<h3>CLI agent</h3>
				<div class="choice-grid" style="grid-template-columns:repeat(3,1fr)">
					{#each cliTools as tool (tool.id)}
						<button class="choice {cliAdapter === tool.id ? 'on' : ''}" onclick={() => { cliAdapter = tool.id; cliPicked = new Set(); cliRemove = new Set(); cliListed = null; cliError = ''; }}>
							<strong>{tool.label}</strong>
							<span class="{tool.found ? 'tone-ok' : 'tone-warn'} small">{tool.found ? '✓ found' : '✗ not found'}</span>
						</button>
					{/each}
				</div>
				{#if cliTools.find((tool) => tool.id === cliAdapter)?.found}
					<div class="spread" style="margin-top:.8rem;align-items:center">
						<div class="kicker" style="margin:0">Models it offers</div>
						<button class="btn ghost sm" disabled={cliLoading} onclick={() => (cliRefreshTick += 1)}>
							{cliLoading ? 'Listing…' : 'Refresh list'}
						</button>
					</div>
					{#if cliError}
						<div class="fix-box bad" style="margin-top:.6rem">{cliError}</div>
					{/if}
					{#if cliLoading && !cliChoices.length}
						<p class="muted small" style="margin-top:.5rem">Asking this CLI for its model list…</p>
					{:else if cliChoices.length}
						<div class="pick-list">
							{#each cliChoices as model (model.id)}
								{@const existing = cliExisting.find((row) => row.slug === model.id)}
								{@const removing = !!existing && cliRemove.has(existing.id)}
								<label class="pick">
									<input type="checkbox" checked={existing ? !removing : cliPicked.has(model.id)} onchange={(e) => {
										const on = e.currentTarget.checked;
										if (existing) { const next = new Set(cliRemove); on ? next.delete(existing.id) : next.add(existing.id); cliRemove = next; }
										else { const next = new Set(cliPicked); on ? next.add(model.id) : next.delete(model.id); cliPicked = next; }
									}} />
									<span class="grow">{model.label} <code>{model.id}</code></span>
									{#if removing}<span class="chip bad">will be removed</span>{:else if existing}<span class="chip ok">added</span>{/if}
								</label>
							{/each}
						</div>
						<p class="muted small" style="margin-top:.5rem">Listed from this server’s {cliTools.find((tool) => tool.id === cliAdapter)?.label} CLI.</p>
					{:else if !cliLoading}
						<p class="muted small" style="margin-top:.5rem">This CLI did not return any models. Sign in as the account Komatose runs under, then refresh.</p>
					{/if}
				{:else}
					<div class="fix-box" style="margin-top:.8rem">Not found on this server. Install the CLI and sign in, then use <strong>Check discovery</strong> from its model panel.</div>
				{/if}
			{/if}

			<div class="dlg-actions">
				<button class="btn ghost" onclick={() => { $ui.addOpen = false; }}>Close</button>
				{#if step === 'local'}
					<button class="btn solid" disabled={localNeedsWeights} onclick={() => void addLocal()}>Add model</button>
				{:else if step === 'remote'}
					<button class="btn solid" onclick={() => void addRemote()} disabled={!remoteAddCount}>Add{remoteAddCount ? ` ${remoteAddCount}` : ''}</button>
				{:else if step === 'cli'}
					<button class="btn solid" onclick={() => void addCli()} disabled={!cliPicked.size && !cliRemove.size}>{[cliPicked.size && `Add ${cliPicked.size}`, cliRemove.size && `Remove ${cliRemove.size}`].filter(Boolean).join(' · ') || 'Add'}</button>
				{/if}
			</div>
		</div>
	</div>
{/if}
