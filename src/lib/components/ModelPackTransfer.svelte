<script lang="ts">
	/**
	 * Transfer named models between installs: export this machine's remote/CLI
	 * rows and named profiles as a versioned pack, import one elsewhere.
	 * Secrets never travel — environment names and base URLs only.
	 */
	type PackConflict = {
		kind: 'model' | 'profile';
		id: string;
		name: string;
		reason: 'id' | 'name';
		existingId?: string;
		existingName?: string;
	};
	type PackPreview = {
		add: Array<{ kind: 'model' | 'profile'; id: string; name: string; detail: string }>;
		conflicts: PackConflict[];
		missing: Array<{ kind: 'model' | 'env'; ref: string; message: string }>;
	};
	type PackDecisionDraft = { action: 'skip' | 'rename' | ''; id: string; name: string };
	type PackExportPreview = {
		includePrivate: boolean;
		includedPrivate: Array<{ id: string; name: string; endpoint: string; scope: string }>;
		excludedModels: Array<{ id: string; name: string; reason: string; endpoint: string }>;
		profilesNeedingConfig: Array<{
			id: string;
			name: string;
			excludedModels: Array<{ id: string; name: string; reason: string }>;
		}>;
		counts: { models: number; profiles: number };
	};

	// The host page owns the model list; called after an import adds rows to it.
	let { onapplied }: { onapplied?: () => void } = $props();

	let includePrivate = $state(false);
	let exportPreview = $state<PackExportPreview | null>(null);
	let packPayload = $state<unknown>(null);
	let packPreview = $state<PackPreview | null>(null);
	let packFileName = $state('');
	let packMessage = $state('');
	let packDecisions = $state<Record<string, PackDecisionDraft>>({});
	let error = $state('');
	let busy = $state('');
	let packInput: HTMLInputElement | undefined;

	function conflictKey(conflict: PackConflict) {
		return `${conflict.kind}:${conflict.id}`;
	}
	function suggestedId(id: string) {
		return `${id}-copy`;
	}
	function packCanApply() {
		if (!packPreview) return false;
		return packPreview.conflicts.every((conflict) => {
			const decision = packDecisions[conflictKey(conflict)];
			if (!decision) return false;
			if (decision.action === 'skip') return true;
			if (decision.action === 'rename') return !!decision.id.trim();
			return false;
		});
	}
	function packDecisionsPayload() {
		const models: Record<string, { action: 'skip' } | { action: 'rename'; id: string; name?: string }> = {};
		const profiles: Record<string, { action: 'skip' } | { action: 'rename'; id: string; name?: string }> = {};
		for (const conflict of packPreview?.conflicts || []) {
			const decision = packDecisions[conflictKey(conflict)];
			if (!decision) continue;
			const dest = conflict.kind === 'model' ? models : profiles;
			if (decision.action !== 'skip' && decision.action !== 'rename') continue;
			dest[conflict.id] =
				decision.action === 'skip'
					? { action: 'skip' }
					: { action: 'rename', id: decision.id.trim(), name: decision.name.trim() || undefined };
		}
		return { models, profiles };
	}
	async function packApi(body: Record<string, unknown>) {
		error = '';
		packMessage = '';
		const res = await fetch('/api/admin/model-pack', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
		const json = await res.json();
		if (!res.ok) throw new Error(json.error || 'Request failed');
		return json;
	}
	async function loadExportPreview() {
		const res = await fetch('/api/admin/model-pack', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'export-preview', includePrivate }),
		});
		const json = await res.json();
		if (!res.ok) throw new Error(json.error || 'Could not preview export');
		exportPreview = {
			includePrivate: json.includePrivate === true,
			includedPrivate: json.includedPrivate || [],
			excludedModels: json.excludedModels || [],
			profilesNeedingConfig: json.profilesNeedingConfig || [],
			counts: json.counts || { models: 0, profiles: 0 },
		};
	}
	$effect(() => {
		includePrivate;
		void loadExportPreview().catch((e) => {
			error = e instanceof Error ? e.message : String(e);
		});
	});
	async function exportPack() {
		busy = 'export-pack';
		error = '';
		packMessage = '';
		try {
			const res = await fetch(`/api/admin/model-pack?includePrivate=${includePrivate ? '1' : '0'}`);
			const json = await res.json();
			if (!res.ok) throw new Error(json.error || 'Could not export');
			const blob = new Blob([JSON.stringify(json.pack, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = json.filename || 'komatose-model-pack.json';
			link.click();
			URL.revokeObjectURL(url);
			packMessage = `Exported ${json.counts?.models ?? 0} models and ${json.counts?.profiles ?? 0} profiles. Keys stayed on this machine.`;
			await loadExportPreview();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = '';
		}
	}
	async function previewPackFile(file: File | undefined) {
		if (!file) return;
		busy = 'preview-pack';
		error = '';
		packMessage = '';
		packPreview = null;
		packPayload = null;
		packFileName = file.name;
		try {
			const text = await file.text();
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch {
				throw new Error('Model pack is not valid JSON.');
			}
			const json = await packApi({ action: 'preview', pack: parsed });
			packPayload = json.pack;
			packPreview = json.preview;
			packDecisions = Object.fromEntries(
				(json.preview?.conflicts || []).map((conflict: PackConflict) => [
					conflictKey(conflict),
					{
						action: '',
						id: suggestedId(conflict.id),
						name: conflict.reason === 'name' ? `${conflict.name} import` : conflict.name,
					},
				]),
			);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			packPreview = null;
			packPayload = null;
		} finally {
			busy = '';
			if (packInput) packInput.value = '';
		}
	}
	async function applyPack() {
		if (!packPreview || packPayload == null || !packCanApply()) return;
		busy = 'apply-pack';
		try {
			const json = await packApi({
				action: 'apply',
				pack: packPayload,
				decisions: packDecisionsPayload(),
			});
			packMessage = `Imported ${json.addedModels?.length ?? 0} models and ${json.addedProfiles?.length ?? 0} profiles.`;
			packPreview = null;
			packPayload = null;
			packDecisions = {};
			packFileName = '';
			onapplied?.();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = '';
		}
	}
</script>

<section class="hud-card mb-4" aria-label="Transfer named models">
	<div class="hud-kicker mb-2">Transfer named models</div>
	<p class="hud-muted">
		Export remote and CLI rows plus named profiles as versioned JSON.
		API keys, saved executable paths, Test results, and private/loopback endpoints stay on this machine unless you include them.
		Credentials in URLs are always stripped. Import previews conflicts first; existing ids are skipped or renamed, never overwritten.
	</p>
	{#if error}
		<div class="alert-hud setup-alert mb-2">{error}</div>
	{/if}
	<label class="hud-muted d-block mb-2">
		<input
			type="checkbox"
			checked={includePrivate}
			onchange={(e) => {
				includePrivate = e.currentTarget.checked;
			}}
		/>
		Include private network endpoints
	</label>
	{#if exportPreview}
		<p class="hud-muted mb-2">
			This pack will include {exportPreview.counts.models}
			{exportPreview.counts.models === 1 ? 'model' : 'models'} and {exportPreview.counts.profiles}
			{exportPreview.counts.profiles === 1 ? 'profile' : 'profiles'}.
		</p>
		{#if exportPreview.includedPrivate.length}
			<div class="hud-kicker mb-1">Private endpoints in this pack</div>
			<ul class="pack-list">
				{#each exportPreview.includedPrivate as item}
					<li><code>{item.id}</code> · {item.name} · {item.endpoint} ({item.scope})</li>
				{/each}
			</ul>
		{/if}
		{#if !includePrivate && exportPreview.excludedModels.length}
			<div class="hud-kicker mb-1">Excluded private or local endpoints</div>
			<ul class="pack-list">
				{#each exportPreview.excludedModels as item}
					<li><code>{item.id}</code> · {item.name}{#if item.endpoint} · {item.endpoint}{/if} ({item.reason})</li>
				{/each}
			</ul>
		{/if}
		{#if exportPreview.profilesNeedingConfig.length}
			<div class="hud-kicker mb-1">Profiles that need models on the destination</div>
			<ul class="pack-list">
				{#each exportPreview.profilesNeedingConfig as item}
					<li>
						{item.name}:
						{item.excludedModels.map((model) => `${model.name} (${model.reason})`).join(', ')}
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
	<div class="d-flex flex-wrap gap-2 align-items-center mb-2">
		<button class="btn-hud" type="button" disabled={!!busy} onclick={() => void exportPack()}>
			{busy === 'export-pack' ? 'Exporting…' : 'Export pack'}
		</button>
		<label class="btn-hud-ghost mb-0">
			{busy === 'preview-pack' ? 'Reading…' : 'Choose pack'}
			<input
				bind:this={packInput}
				class="visually-hidden"
				type="file"
				accept="application/json,.json"
				disabled={!!busy}
				onchange={(e) => void previewPackFile(e.currentTarget.files?.[0])}
			/>
		</label>
	</div>
	{#if packMessage}
		<p class="mb-2">{packMessage}</p>
	{/if}
	{#if packPreview}
		<p class="hud-muted mb-2">{packFileName || 'Pack'} ready to import.</p>
		{#if packPreview.add.length}
			<div class="hud-kicker mb-1">Will add</div>
			<ul class="pack-list">
				{#each packPreview.add as item}
					<li>{item.kind} <code>{item.id}</code> · {item.name}{#if item.detail} · {item.detail}{/if}</li>
				{/each}
			</ul>
		{/if}
		{#if packPreview.missing.length}
			<div class="hud-kicker mb-1">Missing on this machine</div>
			<ul class="pack-list">
				{#each packPreview.missing as item}
					<li>{item.message}</li>
				{/each}
			</ul>
		{/if}
		{#if packPreview.conflicts.length}
			<div class="hud-kicker mb-1">Conflicts</div>
			<p class="hud-muted">Choose skip or rename. Import will not overwrite the existing row or profile.</p>
			{#each packPreview.conflicts as conflict}
				{@const key = conflictKey(conflict)}
				{@const decision = packDecisions[key]}
				<div class="pack-conflict">
					<strong>{conflict.kind}</strong>
					<code>{conflict.id}</code>
					· {conflict.name}
					<span class="hud-muted">
						{conflict.reason === 'name' ? 'same name as' : 'same id as'}
						{conflict.existingName || conflict.existingId}
					</span>
					<div class="d-flex flex-wrap gap-2 align-items-end mt-2">
						<label class="hud-muted mb-0"
							><input
								type="radio"
								name={key}
								checked={decision?.action === 'skip'}
								onchange={() => {
									packDecisions = { ...packDecisions, [key]: { ...decision, action: 'skip' } };
								}}
							/> Skip</label
						>
						<label class="hud-muted mb-0"
							><input
								type="radio"
								name={key}
								checked={decision?.action === 'rename'}
								onchange={() => {
									packDecisions = { ...packDecisions, [key]: { ...decision, action: 'rename' } };
								}}
							/> Rename</label
						>
						{#if decision?.action === 'rename'}
							<div>
								<div class="hud-label">New id</div>
								<input
									class="form-control"
									value={decision.id}
									oninput={(e) => {
										packDecisions = {
											...packDecisions,
											[key]: { ...decision, id: e.currentTarget.value },
										};
									}}
								/>
							</div>
							{#if conflict.kind === 'profile'}
								<div>
									<div class="hud-label">New name</div>
									<input
										class="form-control"
										value={decision.name}
										oninput={(e) => {
											packDecisions = {
												...packDecisions,
												[key]: { ...decision, name: e.currentTarget.value },
											};
										}}
									/>
								</div>
							{/if}
						{/if}
					</div>
				</div>
			{/each}
		{/if}
		<button class="btn-hud" type="button" disabled={!!busy || !packCanApply()} onclick={() => void applyPack()}>
			{busy === 'apply-pack' ? 'Applying…' : 'Apply import'}
		</button>
	{/if}
</section>

<style>
	.hud-muted {
		color: var(--hud-muted);
		font-size: 0.9rem;
	}
	code {
		font-size: 0.85rem;
	}
	.pack-list {
		margin: 0 0 0.75rem;
		padding-left: 1.1rem;
		color: var(--hud-muted);
		font-size: 0.9rem;
	}
	.pack-conflict + .pack-conflict {
		margin-top: 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--hud-line);
	}
	.pack-conflict {
		margin-bottom: 0.75rem;
	}
</style>
