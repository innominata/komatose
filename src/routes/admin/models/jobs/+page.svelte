<script lang="ts">
  import { CAPABILITIES, qualificationChecks, qualificationQueue, qualificationSample, qualificationCurrent, qualificationLabel, qualificationReason, type QualificationId } from '$lib/modelCapabilities';
	import {
		hub,
		apiPost,
		toast,
		refreshHub,
		modelStatus,
		openDrawer,
		readyRowsForOp,
		type PublicRow,
	} from '$lib/components/admin/hub.svelte';
	import { CHAT_AND_CLI_OPERATIONS, rowHasOperation } from '$lib/modelRegistry';
	import { MODEL_TASKS, taskLabel } from '$lib/modelTasks';
	import type { ProviderOperation } from '$lib/providerCatalog';
	import {
		DETECTOR_ADDON_LABELS,
		DETECTOR_BASE_LABELS,
		acceptsAddOns,
		detectorSetupId,
		detectorSetupLabel,
		parseDetectorSetup,
		type DetectorAddOn,
		type DetectorSetupConfig,
	} from '$lib/detectorSetup';
	import type { Detector } from '$lib/types';

	const data = $derived($hub!);
	const rows = $derived(data.rows.filter(row => !['missing', 'installing'].includes(modelStatus(data, row).key)));
	const OP_GROUP = Object.fromEntries(MODEL_TASKS.map(task => [task.id, task.group]));
	const groups = $derived.by(() => {
		const map = new Map<string, ProviderOperation[]>();
		for (const op of CHAT_AND_CLI_OPERATIONS) {
			const list = map.get(OP_GROUP[op]) || [];
			list.push(op);
			map.set(OP_GROUP[op], list);
		}
		return [...map.entries()];
	});
  const testRows = $derived(rows.filter(row => !row.disabled));
  const failed = $derived(qualificationQueue(testRows, 'failed'));
  const untested = $derived(qualificationQueue(testRows, 'untested'));
  const all = $derived(qualificationQueue(testRows, 'all'));
  const checks = $derived([...CAPABILITIES.map(item => item.id), ...CHAT_AND_CLI_OPERATIONS].filter(id => testRows.some(row => qualificationChecks(row).includes(id))) as QualificationId[]);

	async function setDefault(op: ProviderOperation | 'detect' | 'transcribe', rowId: string) {
		try {
			await apiPost('/api/admin/model-hub', { action: 'set-default', job: op, rowId });
			toast('Default updated');
			await refreshHub();
		} catch (e) {
			toast(String((e as Error).message), 'bad');
			await refreshHub();
		}
	}
	async function setRowVisible(row: PublicRow, visible: boolean, input: HTMLInputElement) {
		try {
			await apiPost('/api/admin/models', { action: 'update', id: row.id, disabled: !visible });
			toast(`${row.name} ${visible ? 'shown to' : 'hidden from'} users`);
			await refreshHub();
		} catch (e) {
			input.checked = !row.disabled;
			toast(String((e as Error).message), 'bad');
		}
	}
	/** Probes in flight, keyed `${rowId}:${op}` — every one gets its own spinner in the grid. */
	let running = $state<Record<string, boolean>>({});
	/** The batch run in progress, so the buttons can show how far it has got. */
	let batchAbort: AbortController | undefined;
	let batch = $state<{ done: number; total: number; failed: number; source: 'untested' | 'failed' | 'all' } | null>(null);

	const keyOf = (row: PublicRow, op: QualificationId) => `${row.id}:${op}`;
	const testing = (row: PublicRow, op: QualificationId) => Boolean(running[keyOf(row, op)]);
	const rowTesting = (row: PublicRow) => qualificationChecks(row).some((op) => testing(row, op));

	async function test(row: PublicRow, op: QualificationId, quiet = false): Promise<boolean> {
		const key = keyOf(row, op);
		if (running[key]) return false;
		running = { ...running, [key]: true };
		try {
			const res = await fetch('/api/admin/models', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action: 'test', id: row.id, check: op }),
        signal: quiet ? batchAbort?.signal : undefined,
			});
			// A probe that did not pass still answers 200 with its reason in the body, so the
			// failure is read from there rather than from a generic "Request failed".
			const json = (await res.json()) as { ok?: boolean; error?: string; sample?: { reason?: string } };
			if (!res.ok || json.ok === false)
				throw new Error(json.error || json.sample?.reason || 'The test did not pass');
			if (!quiet) toast(`Tested ${row.name} · ${op}`);
			return true;
		} catch (e) {
			if (!quiet) toast(`${row.name} · ${op}: ${(e as Error).message}`, 'bad');
			return false;
		} finally {
			// Refresh first, so the cell swaps straight from its spinner to the new result.
			await refreshHub();
			const next = { ...running };
			delete next[key];
			running = next;
		}
	}
	/** Runs a queue of tests a few at a time, with the count on the button as it goes. */
	async function runBatch(queue: { row: PublicRow; op: QualificationId }[], source: 'untested' | 'failed' | 'all') {
		if (!queue.length || batch) return;
		batchAbort = new AbortController();
		const progress = { done: 0, total: queue.length, failed: 0 };
    let cancelled = false;
		batch = { ...progress, source };
		const failures: string[] = [];
		let next = 0;
		// Three at a time: the grid fills in as results land rather than every spinner
		// appearing and clearing together, and a local model is not asked to load twelve times over.
		const worker = async () => {
			while (next < queue.length && !batchAbort?.signal.aborted) {
				const { row, op } = queue[next++];
				const ok = await test(row, op, true);
        if (batchAbort?.signal.aborted) break;
				progress.done += 1;
				if (!ok) {
					progress.failed += 1;
					failures.push(`${row.name} · ${op}`);
				}
				batch = { ...progress, source };
			}
		};
		try {
			await Promise.all([worker(), worker(), worker()]);
		} finally {
			cancelled = batchAbort?.signal.aborted === true;
      batch = null;
      batchAbort = undefined;
		}
		toast(
      cancelled ? `Cancelled after ${progress.done} of ${progress.total} tests completed. Results are in the grid.` :
			progress.failed
				? `${progress.failed} of ${progress.total} tests failed: ${failures.slice(0, 3).join(', ')}${failures.length > 3 ? '…' : ''}`
				: `Completed ${progress.total} checks — results are in the grid.`,
			progress.failed ? 'warn' : 'ok',
		);
	}

	const SHORT_LABELS: Record<string, string> = {
		conversation: 'Chat',
		translation: 'TL',
		transcription: 'OCR',
		imageUnderstanding: 'Vision',
		translate: 'TL',
		alternatives: 'Alts',
		vision: 'OCR',
		sourceReview: 'OCR review',
		describe: 'Describe',
		compactNotes: 'Summary',
		proofreadEnglish: 'Proof',
		chapterReview: 'Chapter',
		pageImageProofread: 'Page proof',
		advisory: 'Enquire',
		detect: 'Detect',
		textMask: 'Mask',
		segmentBubble: 'Bubble',
		inpaint: 'Inpaint',
		cleaning: 'Edit',
	};
	const shortLabel = (id: string, full: string) => SHORT_LABELS[id] || full;

	const readyFor = (op: ProviderOperation) => readyRowsForOp(data, op);

	const DETECTORS = $derived(['heuristic', ...readyFor('detect').map(row => row.id)]);
	const ADDONS: DetectorAddOn[] = ['coo', 'koharu'];
	const detector = $derived.by(() => {
		const saved = data.detector;
		const setup = parseDetectorSetup(saved?.setup);
		return saved && setup ? { ...saved, setup } : undefined;
	});
	async function saveDetector(change: Partial<DetectorSetupConfig>, conf?: number | null) {
		if (!detector) return;
		const next = { ...detector.setup, ...change };
		if (!acceptsAddOns(next.base)) Object.assign(next, { coo: false, koharu: false });
		try {
			await apiPost('/api/admin/model-hub', {
				action: 'set-detector',
				setup: detectorSetupId(next),
				conf: conf === undefined ? detector.conf : conf,
			});
			toast('Text detector updated');
		} catch (e) {
			toast(String((e as Error).message), 'bad');
		}
		await refreshHub();
	}
</script>

<div class="page-head">
	<div>
		<div class="kicker">Administration · Models</div>
		<h1>Jobs & defaults</h1>
		<p>Shared capability checks determine which jobs each model can do. Transcription also enables Review Transcription; Translation also enables Review Translation. Chapters and series can still override every default.</p>
	</div>
	<div class="row">
    <button class="btn ghost" onclick={async () => { try { const result = await apiPost('/api/admin/model-packages', { action: 'refresh' }) as { errors?: { error: string }[] }; await refreshHub(); toast(result.errors?.length ? result.errors.map((item) => item.error).join('; ') : 'Packages refreshed; changed checks need retesting', result.errors?.length ? 'warn' : 'ok'); } catch (error) { toast((error as Error).message, 'bad'); } }}>Refresh packages</button>
		{#if batch}
			<span class="testing-note">
				<span class="test-spin" aria-hidden="true"></span>
				{batch.done} of {batch.total} tested{batch.failed ? ` · ${batch.failed} failed` : ''}…
			</span>
      <button class="btn ghost" onclick={() => batchAbort?.abort()}>Cancel tests</button>
		{/if}
		<button class="btn {batch ? 'busy' : ''}" onclick={() => void runBatch(untested, 'untested')} disabled={!untested.length || !!batch}>
			{#if batch?.source === 'untested'}
				<span class="test-spin" aria-hidden="true"></span> Testing…
			{:else}
				<i class="bi bi-play"></i> Test {untested.length} untested
			{/if}
		</button>
		<button class="btn ghost {batch ? 'busy' : ''}" onclick={() => void runBatch(failed, 'failed')} disabled={!failed.length || !!batch}>
			{#if batch?.source === 'failed'}
				<span class="test-spin" aria-hidden="true"></span> Testing…
			{:else}
				<i class="bi bi-arrow-repeat"></i> Test failed ({failed.length})
			{/if}
		</button>
		<button class="btn ghost {batch ? 'busy' : ''}" onclick={() => void runBatch(all, 'all')} disabled={!all.length || !!batch}>
			{#if batch?.source === 'all'}
				<span class="test-spin" aria-hidden="true"></span> Testing…
			{:else}
				<i class="bi bi-play-circle"></i> Test all ({all.length})
			{/if}
		</button>
	</div>
</div>

<div class="matrix-legend">
	<span><span class="mx on"><i class="bi bi-check-lg"></i></span> Test passed</span>
	<span><span class="mx on untested"></span> Untested or stale · retest to enable</span>
	<span><span class="mx on testing"><span class="test-spin" aria-hidden="true"></span></span> Testing now</span>
	<span><span class="mx on fail"><i class="bi bi-x-lg"></i></span> Failed or unsupported · see reason</span>
	<span><span class="mx on star"><i class="bi bi-check-lg"></i></span> Default</span>
	<span class="muted">Click a capability to run its check. Job availability is derived below.</span>
</div>

<h2>Capability checks</h2>
<p class="muted">For general vision models, Transcription and Image Understanding share one request and receive separate results. Other adapters show their supported integration checks.</p>
<div class="matrix-wrap">
  <table class="matrix qualification-matrix">
    <thead><tr><th class="rowhead">Model</th>{#each checks as check}<th class="op" title={qualificationLabel(check)}>{shortLabel(check, qualificationLabel(check))}</th>{/each}</tr></thead>
    <tbody>{#each testRows as row (row.id)}
      <tr><th class="rowhead">{#if rowTesting(row)}<span class="test-spin row-spin"></span>{/if}<button class="btn link" onclick={() => openDrawer(row.id)}>{row.name}</button></th>
        {#each checks as check}
          {@const supported = qualificationChecks(row).includes(check)}
          {@const sample = qualificationSample(row, check)}
          {@const current = qualificationCurrent(row, check)}
          {@const busy = testing(row, check) || (row.qualificationAdapter === 'general' && (check === 'transcription' || check === 'imageUnderstanding') && (testing(row, 'transcription') || testing(row, 'imageUnderstanding')))}
          {@const status = !current ? (sample ? 'Stale' : 'Untested') : sample?.ok ? 'Passed' : sample?.outcome?.replaceAll('_', ' ') || 'Failed'}
          <td class="cell">
            {#if supported}<button class="mx {sample && current ? (sample.ok ? 'on' : 'on fail') : 'on untested'} {busy ? 'testing' : ''}"
              disabled={busy || !!batch} onclick={() => void test(row, check)}
              aria-label="{qualificationLabel(check)}: {status}"
              title={busy ? `Testing ${row.name} · ${check}…` : `${qualificationLabel(check)} · ${status}${sample?.reason ? ` — ${sample.reason}` : ''} · click to test`}>
              {#if busy}<span class="test-spin"></span>{:else if sample && current}<i class="bi {sample.ok ? 'bi-check-lg' : 'bi-x-lg'}"></i>{/if}
            </button>{:else}<span class="muted">—</span>{/if}
          </td>
        {/each}
      </tr>
    {/each}</tbody>
  </table>
</div>
<h2>Jobs & defaults</h2>
<div class="matrix-wrap">
	<table class="matrix">
		<thead>
			<tr>
				<th class="rowhead" rowspan="2" style="vertical-align:bottom">Model <span class="muted small" style="font-weight:400">· users can pick</span></th>
				{#each groups as [label, ops] (label)}<th class="task-group" colspan={ops.length}>{label}</th>{/each}
			</tr>
			<tr>
				{#each CHAT_AND_CLI_OPERATIONS as op (op)}<th class="op" title="{taskLabel(op)} — {MODEL_TASKS.find(task => task.id === op)?.description}">{shortLabel(op, taskLabel(op))}</th>{/each}
			</tr>
		</thead>
		<tbody>
			<tr class="defaults">
				<th class="rowhead"><span class="tone-warn">★</span> Default for new chapters</th>
				{#each CHAT_AND_CLI_OPERATIONS as op (op)}
					<td>
						{#if ["translate", "vision", "proofreadEnglish", "chapterReview", "alternatives", "textMask", "inpaint"].includes(op)}
						<select value={data.defaults[op] || ''} onchange={(e) => void setDefault(op, e.currentTarget.value)}>
							{#if data.defaults[op] && !readyFor(op).some(row => row.id === data.defaults[op])}<option value={data.defaults[op]} disabled>{data.rows.find(row => row.id === data.defaults[op])?.name || data.defaults[op]} · unavailable or needs retest</option>{/if}
              <option value="">{readyFor(op).length ? 'Auto' : 'None ready'}</option>
							{#each readyFor(op) as row (row.id)}<option value={row.id}>{row.name}</option>{/each}
						</select>
						{:else}<span class="muted small">Series settings</span>{/if}
					</td>
				{/each}
			</tr>
			{#each rows as row (row.id)}
				{@const status = modelStatus(data, row)}
				<tr style={status.tone === 'ok' ? '' : 'opacity:.6'}>
					<th class="rowhead">
						<div class="row" style="flex-wrap:nowrap">
							<label class="switch"><input type="checkbox" checked={!row.disabled} onchange={(e) => void setRowVisible(row, e.currentTarget.checked, e.currentTarget)} /><span class="track"></span></label>
							<span class="dot {status.dot || status.tone}"></span>
							{#if rowTesting(row)}<span class="test-spin row-spin" title="Testing…"></span>{/if}
							<button class="btn link" onclick={() => openDrawer(row.id)}>{row.name}</button>
							{#if row.access === 'cli' || row.access === 'remote_http'}<span class="chip warn" style="font-size:.62rem">billed</span>{/if}
						</div>
					</th>
					{#each CHAT_AND_CLI_OPERATIONS as op (op)}
            {@const passed = rowHasOperation(row, op)}
            <td class="cell" title="{taskLabel(op)} · {passed ? 'Available' : 'Unavailable'}{qualificationReason(row, op) ? ` — ${qualificationReason(row, op)}` : ''}">
              <span class="mx {passed ? 'on' : 'off'} {data.defaults[op] === row.id ? 'star' : ''}" aria-label={passed ? 'Available' : 'Unavailable'}>{#if passed}<i class="bi bi-check-lg"></i>{/if}</span>
            </td>
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<div class="section">
	<div class="section-head"><h2>Other defaults</h2></div>
	<div class="card fields">
		{#if detector}
			<label class="field">
				<span>Text detector</span>
				<select value={detector.setup.base} onchange={(e) => void saveDetector({ base: e.currentTarget.value as Detector })}>
					{#each DETECTORS as base (base)}
						<option value={base} disabled={!detector.available[base]?.installed && base !== detector.setup.base}>
							{DETECTOR_BASE_LABELS[base] || data.rows.find(row => row.id === base)?.name || base}{detector.available[base]?.installed ? '' : ' (not installed)'}
						</option>
					{/each}
				</select>
			</label>
			{#each ADDONS as addOn (addOn)}
				{@const installed = detector.available[addOn].installed}
				<label class="field">
					<span>{DETECTOR_ADDON_LABELS[addOn]}</span>
					<span class="switch" title={!acceptsAddOns(detector.setup.base) ? 'The heuristic detector runs alone' : installed ? '' : 'Install it from Admin → Models → Install'}>
						<input
							type="checkbox"
							checked={detector.setup[addOn]}
							disabled={!acceptsAddOns(detector.setup.base) || (!installed && !detector.setup[addOn])}
							onchange={(e) => void saveDetector({ [addOn]: e.currentTarget.checked })}
						/><span class="track"></span>
					</span>
				</label>
			{/each}
			<label class="field">
				<span>Detection confidence</span>
				<input
					type="number"
					min="0.05"
					max="0.9"
					step="0.05"
					value={detector.conf}
					onchange={(e) => void saveDetector({}, e.currentTarget.value === '' ? null : Number(e.currentTarget.value))}
				/>
			</label>
			<p class="muted small" style="grid-column:1/-1">
				New chapters run <b>{detectorSetupLabel(detector.setup)}</b>{detector.saved ? '' : ' (not saved yet — this is the legacy fallback)'}.
				COO adds sound effects and free text; Koharu adds lettering the box detector missed.
				Chapters can pick their own setup in Chapter settings.
			</p>
		{/if}
    <p class="muted small">Choose the transcription readers, Review Transcription reviewers, and Review Translation council as lists in each series’ AI model settings.</p>
	</div>
</div>
