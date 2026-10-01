/* State, derived status and simulated side effects for the mockup. */
window.APP = (() => {
	const M = window.MOCK;
	const esc = (v) =>
		String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
	const fmtGb = (gb) => (gb >= 1 ? `${gb.toFixed(gb >= 10 ? 0 : 1)} GB` : `${Math.round(gb * 1000)} MB`);
	const hash = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
	const TASK = Object.fromEntries(M.TASKS.map((t) => [t.id, t]));
	const OP = Object.fromEntries(M.OPS.map((o) => [o.id, o]));
	const CAT = Object.fromEntries(M.CATALOG.map((c) => [c.id, c]));
	const ENV = Object.fromEntries(M.ENVIRONMENTS.map((e) => [e.id, e]));
	const DEV = Object.fromEntries(M.HARDWARE.devices.map((d) => [d.id, d]));
	const GROUP = Object.fromEntries(M.CATALOG_GROUPS.map((g) => [g.id, g]));

	const S = { data: null, ui: null };
	let renderFn = () => {};
	let patchFn = () => {};

	function freshWiz() {
		return {
			step: 0,
			translate: new Set(['local']),
			provider: 'openai',
			cliPicks: new Set(['codex:gpt-5.4']),
			read: new Set(['rtdetr', 'ctd', 'hayai-ocr-v2', 'paddleocr-vl-1.6']),
			clean: 'fill',
		};
	}
	function freshUi() {
		return {
			drawer: null,
			modal: null,
			f: { status: 'machine', source: 'all', task: 'all', group: 'family', q: '' },
			sel: new Set(),
			picks: new Set(),
			toasts: [],
			wiz: freshWiz(),
			editLaunch: false,
		};
	}
	function load(name) {
		S.data = M.scenario(name);
		S.ui = freshUi();
		renderFn();
	}

	// ------------------------------------------------------------- lookups
	const d = () => S.data;
	const model = (id) => d().models.find((m) => m.id === id);
	const cat = (m) => (m && m.catalog ? CAT[m.catalog] : null);
	const queueItem = (id) => d().queue.find((q) => q.id === id && (q.state === 'queued' || q.state === 'running'));
	const envInstalled = (id) => d().envs[id] === 'installed';
	const deviceOf = (m) => m.launch?.device || cat(m)?.device || 'cpu';
	const memOf = (m) => cat(m)?.memGb ?? m.memGb ?? 0;
	const keySet = (name) => d().envKeys.includes(name);

	function familyOf(m) {
		if (m.source === 'service') return 'Services';
		const c = cat(m);
		if (!c) return 'Chat models';
		return {
			chat: 'Chat models',
			detect: 'Detection & masks',
			transcribe: 'OCR & vision',
			translate: 'Dedicated translators',
			fill: 'Clean · fill',
			reconstruct: 'Clean · reconstruct',
		}[c.group];
	}
	const FAMILY_ORDER = ['Chat models', 'OCR & vision', 'Dedicated translators', 'Detection & masks', 'Clean · fill', 'Clean · reconstruct', 'Services'];

	function sourceOf(m) {
		if (m.source === 'remote') return { icon: 'bi-cloud', label: `Remote · ${m.endpoint.provider}`, group: 'Remote APIs' };
		if (m.source === 'cli') return { icon: 'bi-terminal', label: M.CLI_DEFS[m.adapter].label, group: 'CLI agents' };
		if (m.source === 'service') return { icon: 'bi-plug', label: 'External service', group: 'Services' };
		if (m.launch || cat(m)?.runtime === 'chat') return { icon: 'bi-cpu', label: 'Local · llama.cpp', group: 'On this machine' };
		if (m.external) return { icon: 'bi-hdd-network', label: 'Local · your server', group: 'On this machine' };
		return { icon: 'bi-hdd', label: 'Local · installed', group: 'On this machine' };
	}

	/** Operations this kind of model could ever run (the rest render as n/a). */
	function possibleOps(m) {
		if (m.opsLocked) return m.ops;
		if (m.source === 'cli') return [...M.CHAT_OPS, ...(M.CLI_DEFS[m.adapter].cleaning ? ['cleaning'] : [])];
		return M.CHAT_OPS;
	}

	function tasksOf(m) {
		if (m.tasks && m.opsLocked) return m.tasks;
		if (m.tasks && !m.ops.length) return m.tasks;
		const set = new Set(m.ops.map((o) => OP[o]?.task).filter(Boolean));
		return M.TASKS.map((t) => t.id).filter((t) => set.has(t));
	}

	// -------------------------------------------------------------- status
	function status(m) {
		const q = queueItem(m.id);
		if (q) {
			return q.state === 'running'
				? { key: 'installing', tone: 'busy', label: `Installing · ${Math.round(q.progress * 100)}%` }
				: { key: 'installing', tone: 'busy', label: 'Queued to install' };
		}
		if (m.install?.state === 'failed')
			return { key: 'attention', tone: 'bad', label: 'Install failed', detail: m.install.error, fix: { label: 'Retry install', action: 'install', id: m.id } };
		if (m.install?.state === 'missing') return { key: 'missing', tone: 'idle', label: 'Not installed' };
		if (m.source === 'remote') {
			if (!keySet(m.endpoint.keyVar))
				return {
					key: 'attention', tone: 'warn', label: `${m.endpoint.keyVar} not set`,
					detail: `Komatose stores the variable name only. Add ${m.endpoint.keyVar} to .env on this server.`,
					fix: { label: 'Show me how', action: 'fix-key', id: m.id },
				};
			return { key: 'ready', tone: 'ok', dot: 'ok', label: 'Ready · billed per call' };
		}
		if (m.source === 'cli') {
			const t = d().cli[m.adapter];
			if (!t.found)
				return {
					key: 'attention', tone: t.source === 'saved' ? 'bad' : 'warn', label: `${M.CLI_DEFS[m.adapter].label} not found`,
					detail: t.message, fix: { label: 'Fix location', action: 'fix-cli', adapter: m.adapter },
				};
			return { key: 'ready', tone: 'ok', dot: 'ok', label: 'Ready · runs per call' };
		}
		if (m.source === 'service') {
			if (!m.service.set)
				return { key: 'optional', tone: 'idle', label: 'Not configured · optional', detail: `Set ${m.service.envVar} in .env to enable page-image proofread.`, fix: { label: 'How to enable', action: 'fix-service', id: m.id } };
			return { key: 'ready', tone: 'ok', dot: 'ok', label: 'Configured' };
		}
		if (m.run) {
			const st = m.run.state;
			if (st === 'running') return { key: 'ready', tone: 'ok', dot: 'ok', label: 'Running', running: true };
			if (st === 'starting') return { key: 'ready', tone: 'busy', label: 'Starting…', running: true };
			if (st === 'stopping') return { key: 'ready', tone: 'busy', label: 'Stopping…' };
			if (st === 'error') return { key: 'attention', tone: 'bad', label: 'Crashed', detail: m.run.error, fix: { label: 'Restart', action: 'restart', id: m.id } };
			return { key: 'ready', tone: 'ok', dot: 'idle', label: 'Ready · loads on demand' };
		}
		return { key: 'ready', tone: 'ok', dot: 'ok', label: 'Installed' };
	}
	const usable = (m) => status(m).key === 'ready';

	function readyFor(op) {
		return d().models.filter(
			(m) => usable(m) && m.visible && m.ops.includes(op) && !(op === 'vision' && m.tests.vision && m.tests.vision.ok === false),
		);
	}
	const readyWithTask = (task) => d().models.filter((m) => usable(m) && m.visible && (m.tasks || []).includes(task));

	function defaultFor(op) {
		const id = d().defaults[op];
		const ready = op === 'detect' ? readyWithTask('detect') : readyFor(op);
		const want = id ? model(id) : null;
		if (want && ready.includes(want)) return { model: want, ready };
		return { model: ready[0] || null, wanted: want, fallback: Boolean(want && ready[0]), ready };
	}

	/** What each user-facing task looks like right now, plus the one fix that matters most. */
	function coverage(task) {
		const names = (list) => list.map((m) => m.name);
		const opTask = (op, { required, empty, fix }) => {
			const def = defaultFor(op);
			if (!def.ready.length) return { tone: required ? 'bad' : 'idle', label: required ? 'Blocked' : 'Not set up', text: empty, fix };
			const installing = def.fallback && queueItem(def.wanted.id);
			return {
				tone: def.fallback ? 'warn' : 'ok',
				label: def.fallback ? 'Using fallback' : 'Ready',
				def: def.model,
				others: names(def.ready.filter((m) => m !== def.model)),
				text: !def.fallback ? '' : installing ? `${def.wanted.name} is installing; ${def.model.name} runs until it’s ready.` : `${def.wanted.name} is unavailable, so ${def.model.name} runs instead.`,
				fix: def.fallback && !installing ? { label: `Fix ${def.wanted.name}`, action: 'open-model', id: def.wanted.id } : null,
			};
		};
		const chatFix = { label: 'Add a chat model', action: 'add-model', alt: { label: 'or install Qwen 3.8 27B', action: 'install', id: 'qwen3.8-27b' } };
		switch (task.id) {
			case 'detect': {
				const def = defaultFor('detect');
				if (!def.ready.length)
					return { tone: 'warn', label: 'Basic only', text: 'Only the built-in heuristic detector, which cannot see borderless text or SFX.', fix: { label: 'Install RT-DETR', action: 'install', id: 'rtdetr' } };
				return { tone: 'ok', label: 'Ready', def: def.model, others: names(def.ready.filter((m) => m !== def.model)) };
			}
			case 'transcribe': {
				const council = (d().defaults.transcribe || []).map(model).filter(Boolean);
				const ready = council.filter(usable);
				const missing = council.filter((m) => !usable(m));
				const vision = readyFor('vision').filter((m) => !council.includes(m));
				if (ready.length && !missing.length)
					return { tone: 'ok', label: 'Ready', defLabel: ready.map((m) => m.name).join(' + '), defNote: 'council', others: names(vision) };
				if (ready.length)
					return { tone: 'warn', label: 'Half council', defLabel: ready.map((m) => m.name).join(' + '), text: `${names(missing).join(', ')} is missing, so disagreements can’t be caught.`, fix: { label: `Install ${missing[0].name}`, action: 'install', id: missing[0].id }, others: names(vision) };
				if (vision.length)
					return { tone: 'warn', label: 'Fallback', def: vision[0], text: 'The OCR council isn’t installed; transcription falls back to an image model (slower, may be billed).', fix: { label: 'Install Hayai + PaddleOCR-VL', action: 'install-many', ids: 'hayai-ocr-v2,paddleocr-vl-1.6' }, others: names(vision.slice(1)) };
				return { tone: 'bad', label: 'Blocked', text: 'Nothing can read source text yet.', fix: { label: 'Install Hayai + PaddleOCR-VL', action: 'install-many', ids: 'hayai-ocr-v2,paddleocr-vl-1.6' } };
			}
			case 'translate':
				return opTask('translate', { required: true, empty: 'No model can translate yet.', fix: chatFix });
			case 'describe':
				return opTask('describe', { empty: 'No image-capable chat model is ready.', fix: chatFix });
			case 'review':
				return opTask('advisory', { empty: 'Needs a chat, OCR or CLI model.', fix: chatFix });
			case 'proofread': {
				const r = opTask('proofreadEnglish', { empty: 'Needs a chat model.', fix: chatFix });
				const svc = model('proofread-service');
				if (svc && !svc.service.set && r.tone !== 'bad') r.note = 'Page-image proofread is off (optional service).';
				return r;
			}
			case 'mask': {
				const ready = readyWithTask('mask');
				if (!ready.length) return { tone: 'warn', label: 'Brush only', text: 'No mask model, so masks are painted by hand.', fix: { label: 'Install Comic Text Detector', action: 'install', id: 'ctd' } };
				return { tone: 'ok', label: 'Ready', def: ready[0], others: names(ready.slice(1)) };
			}
			case 'clean': {
				const fill = d().models.filter((m) => usable(m) && cat(m)?.group === 'fill');
				const rec = defaultFor('cleaning');
				if (rec.model)
					return { tone: 'ok', label: 'Ready', def: rec.model, others: names(rec.ready.filter((m) => m !== rec.model)), note: fill.length ? `Fill: ${names(fill).join(', ')} + built-ins.` : 'Fill: built-in flat fill and Telea.' };
				if (fill.length)
					return { tone: 'warn', label: 'Fill only', defLabel: names(fill).join(', '), text: 'Detailed art under lettering can’t be redrawn.', fix: { label: 'Install Qwen-Image 2.1', action: 'install', id: 'qwen-image-2.1' } };
				return { tone: 'warn', label: 'Built-ins only', text: 'Flat fill and Telea only.', fix: { label: 'Install lama-Manga', action: 'install', id: 'lama-manga' } };
			}
		}
		return { tone: 'idle', label: '—' };
	}

	/** Only real problems: one row per broken thing, not per model that shares it. */
	function attention() {
		const out = [];
		const seenKeys = new Set();
		const seenCli = new Set();
		for (const m of d().models) {
			const st = status(m);
			if (st.key !== 'attention') continue;
			if (m.source === 'remote') {
				if (seenKeys.has(m.endpoint.keyVar)) continue;
				seenKeys.add(m.endpoint.keyVar);
				const affected = d().models.filter((x) => x.source === 'remote' && x.endpoint.keyVar === m.endpoint.keyVar);
				out.push({ tone: 'warn', icon: 'bi-key', title: `${m.endpoint.keyVar} is not set`, text: `${affected.map((x) => x.name).join(', ')} can’t run until the key is in .env.`, actions: [st.fix, { label: 'Hide model', action: 'hide', id: m.id }] });
			} else if (m.source === 'cli') {
				if (seenCli.has(m.adapter)) continue;
				seenCli.add(m.adapter);
				const affected = d().models.filter((x) => x.adapter === m.adapter);
				out.push({ tone: st.tone, icon: 'bi-terminal-x', title: `${M.CLI_DEFS[m.adapter].label} not found`, text: `${st.detail} ${affected.length === 1 ? '1 model depends' : `${affected.length} models depend`} on it.`, actions: [st.fix] });
			} else if (m.install?.state === 'failed') {
				out.push({ tone: 'bad', icon: 'bi-x-octagon', title: `${m.name} failed to install`, text: m.install.error, actions: [st.fix, { label: 'View log', action: 'view-log', id: m.id }] });
			} else {
				out.push({ tone: st.tone, icon: 'bi-exclamation-triangle', title: `${m.name}: ${st.label}`, text: st.detail || '', actions: [st.fix] });
			}
		}
		for (const [id, t] of Object.entries(d().cli)) {
			if (!t.found && t.source === 'saved' && !seenCli.has(id))
				out.push({ tone: 'bad', icon: 'bi-terminal-x', title: `${M.CLI_DEFS[id].label} not found`, text: t.message, actions: [{ label: 'Fix location', action: 'fix-cli', adapter: id }] });
		}
		return out;
	}

	// ------------------------------------------------------------ resources
	function deviceUse(devId, { exclude, excludeIds, extra } = {}) {
		const dev = DEV[devId];
		const parts = dev.foreign.map((f) => ({ label: f.label, gb: f.gb, kind: 'foreign' }));
		for (const m of d().models) {
			if (m === exclude || excludeIds?.includes(m.id) || !m.run || deviceOf(m) !== devId) continue;
			if (m.run.state !== 'running' && m.run.state !== 'starting') continue;
			const c = cat(m);
			const kind = c?.runtime === 'editor' ? 'edit' : c?.runtime === 'review' ? 'ocr' : 'chat';
			parts.push({ label: m.name, gb: memOf(m), kind, id: m.id });
		}
		if (extra) parts.push(extra);
		const used = parts.reduce((a, p) => a + p.gb, 0);
		return { dev, parts, used, free: Math.max(0, dev.vramGb - used) };
	}

	function fit(c) {
		if (c.device === 'cpu') return { tone: 'muted', text: `CPU · ${fmtGb(c.memGb)} RAM` };
		const dev = DEV[c.device];
		if (c.memGb > dev.vramGb) return { tone: 'bad', text: `Needs ${fmtGb(c.memGb)} · ${dev.label} has ${dev.vramGb} GB` };
		const use = deviceUse(c.device, { exclude: model(c.id) });
		if (c.memGb > use.free) {
			const who = use.parts.filter((p) => p.kind !== 'foreign').map((p) => p.label).join(', ');
			return { tone: 'warn', text: `${fmtGb(c.memGb)} on ${dev.label} · swaps out ${who || 'other models'}` };
		}
		return { tone: 'ok', text: `${fmtGb(c.memGb)} · fits ${dev.label}` };
	}

	function diskUsed() {
		let gb = 0;
		for (const m of d().models) if (m.install?.state === 'installed') gb += cat(m)?.diskGb || 0;
		for (const e of M.ENVIRONMENTS) if (envInstalled(e.id)) gb += e.diskGb;
		return gb;
	}

	// ---------------------------------------------------------------- install
	function installCmd(item) {
		if (item.kind === 'env') return ENV[item.id].cmd;
		const c = CAT[item.id];
		const py = c.requires?.[0] ? `${ENV[c.requires[0]].path}/bin/python ` : '';
		return `${py}scripts/install-model.py ${c.id} --repo ${c.repo} --file ${c.file} --verify-sha256`;
	}

	/** Expands a pick into dependency-ordered steps, skipping what's already here or queued. */
	function planFor(ids) {
		const plan = [];
		const has = (id) => plan.some((p) => p.id === id);
		for (const id of ids) {
			const m = model(id);
			const c = CAT[id];
			if (!c || !m || m.install.state === 'installed' || queueItem(id)) continue;
			for (const envId of c.requires || []) {
				if (envInstalled(envId) || queueItem(envId) || has(envId)) continue;
				const e = ENV[envId];
				plan.push({ kind: 'env', id: envId, label: `${e.label} (${e.path})`, diskGb: e.diskGb, dep: true, forName: c.name });
			}
			if (!has(id)) plan.push({ kind: 'model', id, label: c.name, diskGb: c.diskGb, dep: false });
		}
		for (const p of plan) p.cmd = installCmd(p);
		return plan;
	}

	let ticker = null;
	function enqueue(plan) {
		for (const p of plan) {
			if (queueItem(p.id)) continue;
			d().queue = d().queue.filter((q) => q.id !== p.id);
			const duration = p.kind === 'env' ? 5200 : Math.min(9000, Math.max(2600, 2000 + p.diskGb * 380));
			d().queue.push({ ...p, progress: 0, state: 'queued', duration, showLog: false });
		}
		if (!ticker) ticker = setInterval(tick, 200);
	}

	function tick() {
		let cur = d().queue.find((q) => q.state === 'running');
		if (!cur) {
			cur = d().queue.find((q) => q.state === 'queued');
			if (!cur) {
				clearInterval(ticker);
				ticker = null;
				return;
			}
			cur.state = 'running';
			if (cur.kind === 'env') d().envs[cur.id] = 'installing';
			renderFn();
		}
		cur.progress = Math.min(1, cur.progress + 200 / cur.duration);
		if (cur.progress >= 1) {
			cur.state = 'done';
			if (cur.kind === 'env') d().envs[cur.id] = 'installed';
			else {
				const m = model(cur.id);
				m.install = { state: 'installed' };
				if (m.run) m.run.state = 'stopped';
				const c = CAT[cur.id];
				if (c.runtime === 'chat' && !m.launch)
					m.launch = { preset: c.name, weights: `data/models/${c.id}/${c.file}`, port: c.port, device: c.device, ctx: 32768, gpuLayers: 999, slots: 2, startOnBoot: true };
				toast(`${cur.label} installed`, 'ok');
			}
			renderFn();
			return;
		}
		patchFn(cur);
	}

	function cancelInstall(id) {
		const q = queueItem(id);
		if (!q) return;
		const drop = new Set([id]);
		if (q.kind === 'env') for (const other of d().queue) if (other.state === 'queued' && CAT[other.id]?.requires?.includes(id) && !CAT[other.id].requires.some((e) => e !== id && envInstalled(e))) drop.add(other.id);
		for (const x of d().queue) if (drop.has(x.id) && (x.state === 'queued' || x.state === 'running')) x.state = 'cancelled';
		if (q.kind === 'env') d().envs[id] = 'missing';
		toast(`Cancelled ${q.label}${drop.size > 1 ? ` and ${drop.size - 1} dependent install${drop.size > 2 ? 's' : ''}` : ''}`, 'warn');
	}

	function logLines(q) {
		const p = q.progress;
		const lines = [`$ ${q.cmd}`];
		if (q.kind === 'env') {
			const pk = 60 + (hash(q.id) % 120);
			if (p > 0.05) lines.push('Using CPython 3.12.7 interpreter at /usr/bin/python3.12');
			if (p > 0.18) lines.push(`Resolved ${pk} packages in 1.9s`);
			if (p > 0.3) lines.push('Downloading torch (184.2 MiB)');
			if (p > 0.55) lines.push(`Prepared ${pk} packages in 14.2s`);
			if (p > 0.85) lines.push(`Installed ${pk} packages in 3.1s`);
			if (q.state === 'done') lines.push(`✓ ${ENV[q.id].path} ready`);
		} else {
			const c = CAT[q.id];
			if (p > 0.03) lines.push(`Fetching ${c.repo} @ ${(hash(c.repo) % 0xfffffff).toString(16)}`);
			if (p > 0.08) lines.push(`Downloading ${c.file}  ${Math.round(Math.min(p / 0.9, 1) * 100)}%  ${fmtGb(Math.min(p / 0.9, 1) * c.diskGb)} / ${fmtGb(c.diskGb)}`);
			if (p > 0.92) lines.push('Verifying sha256… OK');
			if (q.state === 'done') lines.push(`Registered ${c.id} in models.json`, '✓ Installed');
		}
		if (q.state === 'queued') lines.push('Waiting for the previous install to finish…');
		return lines.join('\n');
	}

	// -------------------------------------------------------------- services
	function conflictsFor(m) {
		const dev = deviceOf(m);
		if (dev === 'cpu') return [];
		const use = deviceUse(dev, { exclude: m });
		const editorClash = cat(m)?.runtime === 'editor' ? d().models.filter((x) => x !== m && cat(x)?.runtime === 'editor' && x.run?.state === 'running') : [];
		if (memOf(m) <= use.free && !editorClash.length) return [];
		const running = use.parts.filter((p) => p.id).map((p) => model(p.id));
		return [...new Set([...editorClash, ...running])];
	}

	function startService(id, force = false) {
		const m = model(id);
		const clash = conflictsFor(m);
		if (clash.length && !force) {
			S.ui.modal = { type: 'conflict', id, clash: clash.map((x) => x.id) };
			renderFn();
			return;
		}
		for (const x of clash) {
			x.run.state = 'stopped';
			x.run.evictedBy = m.name;
		}
		m.run.state = 'starting';
		delete m.run.evictedBy;
		renderFn();
		setTimeout(() => {
			if (m.run.state !== 'starting') return;
			m.run.state = 'running';
			m.run.since = 'just now';
			toast(`${m.name} is running on ${DEV[deviceOf(m)].label}`, 'ok');
			renderFn();
		}, 1500);
	}
	function stopService(id, then) {
		const m = model(id);
		m.run.state = 'stopping';
		renderFn();
		setTimeout(() => {
			m.run.state = 'stopped';
			renderFn();
			then?.();
		}, 700);
	}

	// ----------------------------------------------------------------- tests
	const PREVIEW = {
		vision: 'お前、戻ってきたのか',
		translate: '“Wait — you came back for me?”',
		describe: 'Rain-soaked rooftop at dusk; two figures, one kneeling.',
		compactNotes: 'Setting unchanged; adds the kneeling figure.',
		advisory: 'Reading matches: お前、戻ってきたのか',
		chapterReview: '3 lines flagged for tone on p.4.',
		alternatives: '“You came back? For me?”',
		proofreadEnglish: '“You came back for me?” (tightened)',
		pageImageProofread: 'Balloon 3 overflows its outline.',
		cleaning: 'Reconstructed 4 regions (1.2 MP).',
	};
	function runTest(id, op) {
		const m = model(id);
		m.tests[op] = { running: true };
		renderFn();
		const base = m.source === 'cli' ? 7000 : m.source === 'remote' ? 2400 : 1200;
		const ms = base + (hash(id + op) % 4000);
		setTimeout(() => {
			let fail = null;
			if (!usable(m)) fail = status(m).label;
			else if (m.id === 'cursor-composer-2.5' && op === 'vision') fail = 'Returned no text for the image — kept out of transcription.';
			else if (m.source === 'remote' && m.endpoint.provider === 'OpenRouter' && op === 'vision') fail = 'Model does not accept images (HTTP 400).';
			m.tests[op] = fail ? { ok: false, ms, at: 'just now', reason: fail } : { ok: true, ms, at: 'just now', preview: PREVIEW[op] };
			renderFn();
		}, Math.min(2600, 700 + ms / 6));
	}

	// ---------------------------------------------------------------- toasts
	let toastSeq = 0;
	function toast(text, tone = 'ok') {
		const id = ++toastSeq;
		S.ui.toasts.push({ id, text, tone });
		renderFn('toasts');
		setTimeout(() => {
			S.ui.toasts = S.ui.toasts.filter((t) => t.id !== id);
			renderFn('toasts');
		}, 3800);
	}

	return {
		M, S, esc, fmtGb, hash, TASK, OP, CAT, ENV, DEV, GROUP, FAMILY_ORDER,
		load, freshWiz, model, cat, queueItem, envInstalled, deviceOf, memOf, keySet,
		familyOf, sourceOf, possibleOps, tasksOf, status, usable, readyFor, readyWithTask, defaultFor,
		coverage, attention, deviceUse, fit, diskUsed, planFor, enqueue, cancelInstall, logLines,
		conflictsFor, startService, stopService, runTest, toast,
		onRender: (fn, patch) => { renderFn = fn; patchFn = patch; },
	};
})();
