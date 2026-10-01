/* Shell, routing and event wiring for the mockup. */
(() => {
	const A = window.APP;
	const V = window.VIEWS;
	const V2 = window.VIEWS2;
	const MD = window.MODALS;
	const { M, S, esc, OP } = A;
	const d = () => S.data;
	const $ = (s) => document.querySelector(s);

	const PAGES = {
		overview: { title: 'Overview', icon: 'bi-grid-1x2', view: V.overview },
		models: { title: 'Models', icon: 'bi-collection', view: V.models },
		install: { title: 'Install', icon: 'bi-download', view: V2.install },
		access: { title: 'Jobs & defaults', icon: 'bi-table', view: V2.access },
		hardware: { title: 'Hardware & services', icon: 'bi-gpu-card', view: V2.hardware },
		welcome: { title: 'Guided setup', icon: 'bi-magic', view: V2.welcome },
		notes: { title: 'Design notes', icon: 'bi-journal-text', view: V2.notes },
	};

	function currentPage() {
		const [id] = location.hash.slice(1).split('?');
		return PAGES[id] ? id : 'overview';
	}

	// ----------------------------------------------------------------- shell
	function shell(page) {
		const att = A.attention().length;
		const onMachine = d().models.filter((m) => A.status(m).key !== 'missing').length;
		const active = d().queue.filter((q) => q.state === 'running' || q.state === 'queued');
		const running = d().queue.find((q) => q.state === 'running');
		const link = (id, count = '') => `<a href="#${id}" class="${page === id ? 'active' : ''}"><i class="bi ${PAGES[id].icon}"></i>${PAGES[id].title}${count}</a>`;
		return `<div class="shell">
			<nav class="side">
				<div class="brand">KOMA<span>TOSE</span></div>
				<div class="nav-group nav">
					<div class="nav-label">Admin</div>
					<a class="disabled"><i class="bi bi-people"></i>Users</a>
				</div>
				<div class="nav-group nav">
					<div class="nav-label">Models</div>
					${link('overview', att ? `<span class="count bad">${att}</span>` : '')}
					${link('models', `<span class="count">${onMachine}</span>`)}
					${link('install', active.length ? `<span class="count" style="color:var(--amber)">${active.length}</span>` : '')}
					${link('access')}
					${link('hardware')}
				</div>
				<div class="nav-group nav">
					<div class="nav-label">First run</div>
					${link('welcome')}
				</div>
				<div class="nav-group nav">
					<div class="nav-label">About this mockup</div>
					${link('notes')}
				</div>
				<div class="side-foot">Replaces <code>/admin/setup</code> and <code>/admin/settings</code>. Pretend data — nothing here talks to the app.</div>
			</nav>
			<div class="main">
				<div class="topbar">
					<span class="crumbs">Admin / Models / <strong>${PAGES[page].title}</strong></span>
					<span class="mock-flag">Mockup</span>
					${running ? `<span class="queue-pill" data-action="nav" data-to="install" id="queue-pill"><span class="dot busy"></span><span data-qpill>Installing ${esc(running.label)} · ${Math.round(running.progress * 100)}%${active.length > 1 ? ` · ${active.length - 1} queued` : ''}</span></span>` : ''}
					<label class="scenario">Scenario
						<select data-change="scenario">
							<option value="partial" ${d().name === 'partial' ? 'selected' : ''}>This machine — partly set up</option>
							<option value="fresh" ${d().name === 'fresh' ? 'selected' : ''}>Fresh install</option>
							<option value="full" ${d().name === 'full' ? 'selected' : ''}>Everything installed</option>
						</select>
					</label>
				</div>
				<main class="content">${PAGES[page].view()}</main>
			</div>
		</div>
		${S.ui.drawer && A.model(S.ui.drawer) ? V.drawer(A.model(S.ui.drawer)) : ''}
		${MD.render(S.ui.modal)}`;
	}

	function render(part) {
		if (part !== 'toasts') {
			const drawerTop = $('.drawer-body')?.scrollTop;
			const modalTop = $('.modal')?.scrollTop;
			const focus = document.activeElement?.dataset?.input === 'search';
			$('#app').innerHTML = shell(currentPage());
			if (drawerTop && $('.drawer-body')) $('.drawer-body').scrollTop = drawerTop;
			if (modalTop && $('.modal')) $('.modal').scrollTop = modalTop;
			if (focus) {
				const input = $('[data-input="search"]');
				input?.focus();
				input?.setSelectionRange(input.value.length, input.value.length);
			}
		}
		$('#toasts').innerHTML = S.ui.toasts.map((t) => `<div class="toast ${t.tone}">${esc(t.text)}</div>`).join('');
	}

	/** Cheap in-place update for install progress, so typing and scroll aren't disturbed. */
	function patch(q) {
		const pct = `${Math.round(q.progress * 100)}%`;
		document.querySelectorAll(`[data-qprog="${q.id}"]`).forEach((el) => (el.style.width = pct));
		document.querySelectorAll(`[data-qlabel="${q.id}"]`).forEach((el) => (el.textContent = pct));
		document.querySelectorAll(`[data-qlog="${q.id}"]`).forEach((el) => {
			el.textContent = A.logLines(q);
			el.scrollTop = el.scrollHeight;
		});
		document.querySelectorAll(`[data-qstatus="${q.id}"] span:last-child`).forEach((el) => (el.textContent = `Installing · ${pct}`));
		const pill = $('[data-qpill]');
		if (pill) {
			const rest = d().queue.filter((x) => x.state === 'queued').length;
			pill.textContent = `Installing ${q.label} · ${pct}${rest ? ` · ${rest} queued` : ''}`;
		}
	}

	A.onRender(render, patch);

	// --------------------------------------------------------------- actions
	function openInstall(ids) {
		const plan = A.planFor(ids);
		if (!plan.length) return A.toast('Already installed or queued', 'warn');
		S.ui.modal = { type: 'install', plan };
		render();
	}

	function newAddModal(step = 'choose', adapter = 'codex') {
		const firstFound = Object.entries(d().cli).find(([, t]) => t.found)?.[0];
		return { type: 'add', step, preset: 'qwen38', provider: 'openai', adapter: adapter || firstFound || 'codex', form: {}, fetched: false, picks: new Set(), visible: true };
	}

	function uniqueId(base) {
		let id = base.toLowerCase().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'model';
		let n = 2;
		const root = id;
		while (A.model(id)) id = `${root}-${n++}`;
		return id;
	}

	const ACTIONS = {
		nav: (el) => (location.hash = `#${el.dataset.to}`),
		'open-model': (el) => {
			S.ui.drawer = el.dataset.id;
			S.ui.editLaunch = false;
			S.ui.modal = null;
		},
		'close-drawer': () => (S.ui.drawer = null),
		'close-modal': () => (S.ui.modal = null),
		backdrop: (el, e) => {
			if (e.target !== el) return false;
			S.ui.modal = null;
		},
		filter: (el) => (S.ui.f[el.dataset.key] = el.dataset.val),
		install: (el) => openInstall([el.dataset.id]),
		'install-many': (el) => openInstall(el.dataset.ids.split(',')),
		'install-env': (el) => {
			const e = A.ENV[el.dataset.id];
			S.ui.modal = { type: 'install', plan: [{ kind: 'env', id: e.id, label: `${e.label} (${e.path})`, diskGb: e.diskGb, cmd: e.cmd }] };
		},
		'confirm-install': () => {
			const plan = S.ui.modal.plan;
			A.enqueue(plan);
			S.ui.picks.clear();
			S.ui.modal = null;
			A.toast(plan.length === 1 ? `Installing ${plan[0].label}` : `Queued ${plan.length} install steps`, 'ok');
		},
		'review-picks': () => openInstall([...S.ui.picks]),
		'clear-picks': () => S.ui.picks.clear(),
		'cancel-install': (el) => A.cancelInstall(el.dataset.id),
		'toggle-log': (el) => {
			const q = d().queue.find((x) => x.id === el.dataset.id);
			if (q) q.showLog = !q.showLog;
		},
		'clear-finished': () => (d().queue = d().queue.filter((q) => q.state === 'running' || q.state === 'queued')),
		'view-log': (el) => (S.ui.modal = { type: 'log', id: el.dataset.id }),
		start: (el) => A.startService(el.dataset.id),
		stop: (el) => A.stopService(el.dataset.id),
		restart: (el) => A.stopService(el.dataset.id, () => A.startService(el.dataset.id)),
		'conflict-go': (el) => {
			S.ui.modal = null;
			A.startService(el.dataset.id, true);
		},
		test: (el) => A.runTest(el.dataset.id, el.dataset.op),
		'test-all': (el) => {
			const m = A.model(el.dataset.id);
			m.ops.forEach((op, i) => setTimeout(() => A.runTest(m.id, op), i * 120));
		},
		'test-untested': () => {
			const items = d().models
				.filter((m) => A.usable(m) && m.visible && A.possibleOps(m).length)
				.flatMap((m) => m.ops.filter((op) => !m.tests[op]).map((op) => ({ m, op })));
			S.ui.modal = { type: 'test-untested', items };
		},
		'confirm-test-untested': () => {
			S.ui.modal.items.forEach((x, i) => setTimeout(() => A.runTest(x.m.id, x.op), i * 120));
			S.ui.modal = null;
		},
		'make-default': (el) => {
			const m = A.model(el.dataset.id);
			d().defaults[el.dataset.op] = m.id;
			A.toast(`${m.name} is now the default for ${el.dataset.op === 'detect' ? 'text detection' : OP[el.dataset.op].label}`);
		},
		cell: (el) => {
			const m = A.model(el.dataset.id);
			const op = el.dataset.op;
			if (m.ops.includes(op)) {
				m.ops = m.ops.filter((x) => x !== op);
				if (d().defaults[op] === m.id) d().defaults[op] = '';
			} else m.ops.push(op);
		},
		hide: (el) => {
			const m = A.model(el.dataset.id);
			m.visible = false;
			A.toast(`${m.name} hidden from users`);
		},
		'fix-key': (el) => (S.ui.modal = { type: 'fix-key', id: el.dataset.id }),
		'recheck-key': (el) => {
			const key = A.model(el.dataset.id).endpoint.keyVar;
			d().envKeys.push(key);
			S.ui.modal = null;
			A.toast(`${key} found in .env`, 'ok');
		},
		'hide-key-models': (el) => {
			const key = A.model(el.dataset.id).endpoint.keyVar;
			d().models.filter((x) => x.source === 'remote' && x.endpoint.keyVar === key).forEach((x) => (x.visible = false));
			S.ui.modal = null;
			A.toast('Hidden from users. They stay listed under Needs attention until the key is set.', 'warn');
		},
		'fix-cli': (el) => {
			const t = d().cli[el.dataset.adapter];
			const guess = { grok: '~/.grok/bin/grok', cursor: '~/.local/bin/cursor-agent', codex: '~/.local/bin/codex' }[el.dataset.adapter];
			S.ui.modal = { type: 'fix-cli', adapter: el.dataset.adapter, path: t.found ? t.path : guess, back: S.ui.modal?.type === 'add' ? S.ui.modal : null };
		},
		'check-cli': (el) => {
			const t = d().cli[el.dataset.adapter];
			const path = S.ui.modal.path.trim();
			if (path && path !== '/opt/grok/bin/grok') {
				Object.assign(t, { found: true, path, source: 'saved', version: t.version || '1.9.2', message: '' });
				A.toast(`${M.CLI_DEFS[el.dataset.adapter].label} found at ${path}`, 'ok');
				S.ui.modal = S.ui.modal.back || null;
			} else A.toast(`Still nothing at ${path || '(empty)'}`, 'bad');
		},
		'clear-cli': (el) => {
			const def = M.CLI_DEFS[el.dataset.adapter];
			Object.assign(d().cli[el.dataset.adapter], { found: false, path: '', source: 'auto', message: `${def.command} not on PATH.` });
			S.ui.modal = null;
			A.toast('Saved location cleared — using automatic discovery', 'warn');
		},
		'fix-service': (el) => (S.ui.modal = { type: 'fix-service', id: el.dataset.id }),
		'recheck-service': (el) => {
			Object.assign(A.model(el.dataset.id).service, { set: true, url: 'http://10.0.0.12:8710' });
			S.ui.modal = null;
			A.toast('Proofreading service configured', 'ok');
		},
		remove: (el) => (S.ui.modal = { type: 'remove', id: el.dataset.id }),
		'confirm-remove': (el) => {
			const m = A.model(el.dataset.id);
			for (const [k, v] of Object.entries(d().defaults)) {
				if (v === m.id) d().defaults[k] = '';
				if (Array.isArray(v)) d().defaults[k] = v.filter((x) => x !== m.id);
			}
			if (A.cat(m)) {
				m.install = { state: 'missing' };
				if (m.run) m.run.state = 'stopped';
				m.tests = {};
				A.toast(`${m.name} uninstalled`, 'warn');
			} else {
				d().models = d().models.filter((x) => x !== m);
				S.ui.drawer = null;
				A.toast(`${m.name} removed`, 'warn');
			}
			S.ui.modal = null;
		},
		'add-model': (el) => (S.ui.modal = newAddModal(el.dataset.step, el.dataset.adapter)),
		'add-step': (el) => {
			if (el.dataset.step === 'install') {
				S.ui.modal = null;
				location.hash = '#install';
				return;
			}
			S.ui.modal.step = el.dataset.step;
			S.ui.modal.form = {};
			S.ui.modal.picks = new Set();
		},
		'add-preset': (el) => {
			S.ui.modal.preset = el.dataset.id;
			S.ui.modal.form = { device: S.ui.modal.form.device };
		},
		'add-provider': (el) => {
			Object.assign(S.ui.modal, { provider: el.dataset.id, form: {}, fetched: false, picks: new Set() });
		},
		'add-fetch': () => (S.ui.modal.fetched = true),
		'add-adapter': (el) => Object.assign(S.ui.modal, { adapter: el.dataset.id, picks: new Set() }),
		'add-local-install': () => {
			const p = M.CHAT_PRESETS.find((x) => x.id === S.ui.modal.preset);
			A.enqueue(A.planFor([p.catalog]));
			S.ui.modal = null;
			A.toast(`Installing ${p.name} — it appears in Models when the download finishes`, 'ok');
		},
		'add-local-submit': () => {
			const md = S.ui.modal;
			const p = M.CHAT_PRESETS.find((x) => x.id === md.preset);
			const name = md.form.name || p.name;
			const external = md.preset === 'external';
			const m = {
				id: uniqueId(md.form.slug ?? p.slug ?? name), name, source: 'local', slug: md.form.slug ?? p.slug,
				ops: M.CHAT_OPS.filter((o) => o !== 'pageImageProofread'), visible: md.visible, tests: {}, memGb: p.memGb,
				...(external
					? { external: true }
					: { launch: { preset: p.name, weights: md.form.weights ?? p.weights, port: 18081, device: md.form.device || 'gpu0', ctx: 32768, gpuLayers: 999, slots: 1, startOnBoot: false }, run: { state: 'stopped', keepLoaded: false } }),
			};
			d().models.push(m);
			S.ui.modal = null;
			S.ui.drawer = m.id;
			A.toast(`${name} added${md.visible ? ' and visible to users' : ''}`, 'ok');
			if (m.run) A.startService(m.id);
		},
		'add-remote-submit': () => {
			const md = S.ui.modal;
			const p = M.REMOTE_PRESETS.find((x) => x.id === md.provider);
			const baseUrl = md.form.baseUrl ?? p.baseUrl;
			const keyVar = md.form.keyVar ?? p.keyVar;
			const slugs = md.fetched && A.keySet(keyVar) ? [...md.picks] : [md.form.slug].filter(Boolean);
			for (const slug of slugs) {
				const row = M.remoteRow(uniqueId(`${p.id}-${slug}`), `${slug.split('/').pop()} (${p.name})`, 'openai', slug, { visible: md.visible });
				row.endpoint = { baseUrl, keyVar, provider: p.name };
				d().models.push(row);
			}
			S.ui.modal = null;
			A.toast(`Added ${slugs.length} ${p.name} model${slugs.length === 1 ? '' : 's'}`, 'ok');
		},
		'add-cli-submit': () => {
			const md = S.ui.modal;
			for (const slug of md.picks) d().models.push(M.cliRow(md.adapter, slug, { visible: md.visible }));
			S.ui.modal = null;
			A.toast(`Added ${md.picks.size} ${M.CLI_DEFS[md.adapter].label} model${md.picks.size === 1 ? '' : 's'}${md.visible ? ' — visible to users' : ''}`, 'ok');
		},
		bulk: (el) => {
			const ids = [...S.ui.sel];
			const ms = ids.map(A.model).filter(Boolean);
			const op = el.dataset.op;
			if (op === 'show' || op === 'hide') {
				const on = op === 'show';
				ms.filter((m) => A.status(m).key !== 'missing').forEach((m) => (m.visible = on));
				A.toast(`${ms.length} model${ms.length === 1 ? '' : 's'} ${on ? 'shown to' : 'hidden from'} users`);
			} else if (op === 'test') {
				ms.filter(A.usable).forEach((m, i) => m.ops.forEach((o, j) => setTimeout(() => A.runTest(m.id, o), (i * 4 + j) * 100)));
			} else if (op === 'install') {
				openInstall(ms.filter((m) => m.install && m.install.state !== 'installed').map((m) => m.id));
				return;
			}
			S.ui.sel.clear();
		},
		recheck: () => {
			const n = d().models.length;
			A.toast(`Checked ${n} models, 3 CLIs and ${new Set(d().models.filter((m) => m.endpoint).map((m) => m.endpoint.keyVar)).size} key variables in 0.3 s — no model was called.`);
		},
		toast: (el) => A.toast(el.dataset.msg),
		'edit-launch': () => (S.ui.editLaunch = !S.ui.editLaunch),
		'save-launch': (el) => {
			S.ui.editLaunch = false;
			const m = A.model(el.dataset.id);
			A.toast(m.run?.state === 'running' ? 'Saved. Restart to apply — the running model keeps its old settings.' : 'Saved.', m.run?.state === 'running' ? 'warn' : 'ok');
		},
		council: () => (S.ui.modal = { type: 'council', picks: new Set(d().defaults.transcribe || []) }),
		'save-council': () => {
			d().defaults.transcribe = [...S.ui.modal.picks];
			S.ui.modal = null;
			A.toast('Transcription council saved');
		},
		benchmark: () => {
			const picks = d().models.filter((m) => A.usable(m) && m.visible && !m.billed && (m.ops.includes('vision') || m.ops.includes('translate'))).map((m) => m.id);
			S.ui.modal = { type: 'bench', picks: new Set(picks), state: 'idle' };
		},
		'run-bench': () => {
			S.ui.modal.state = 'running';
			const md = S.ui.modal;
			setTimeout(() => {
				md.state = 'done';
				render();
			}, 2200);
		},
		transfer: () => (S.ui.modal = { type: 'transfer' }),
		'wiz-next': () => {
			S.ui.wiz.step = Math.min(3, S.ui.wiz.step + 1);
			window.scrollTo(0, 0);
		},
		'wiz-back': () => (S.ui.wiz.step = Math.max(0, S.ui.wiz.step - 1)),
		'wiz-toggle': (el) => {
			const set = S.ui.wiz.translate;
			const k = el.dataset.key;
			if (k === 'later') {
				set.clear();
				set.add('later');
				return;
			}
			set.delete('later');
			set.has(k) ? set.delete(k) : set.add(k);
		},
		'wiz-clean': (el) => (S.ui.wiz.clean = el.dataset.key),
		'wiz-finish': () => {
			const w = S.ui.wiz;
			const { ids, rows } = V2.wizardPlan();
			const plan = A.planFor(ids);
			A.enqueue(plan);
			let firstRow = null;
			for (const r of rows) {
				let m;
				if (r.kind === 'remote') {
					m = M.remoteRow(uniqueId(`${r.preset.id}-${r.preset.models[0]}`), r.name, 'openai', r.preset.models[0]);
					m.endpoint = { baseUrl: r.preset.baseUrl, keyVar: r.preset.keyVar, provider: r.preset.name };
				} else m = M.cliRow(r.adapter, r.slug);
				d().models.push(m);
				firstRow = firstRow || m;
			}
			const defs = d().defaults;
			const chat = w.translate.has('local') ? 'qwen3.8-27b' : firstRow?.id;
			if (chat) for (const op of ['translate', 'describe', 'compactNotes', 'alternatives', 'proofreadEnglish', 'advisory', 'chapterReview']) defs[op] = defs[op] || chat;
			if (w.clean === 'local') defs.cleaning = 'qwen-image-2.1';
			if (w.clean === 'codex') defs.cleaning = 'codex-gpt-5.4';
			S.ui.wiz = A.freshWiz();
			location.hash = '#overview';
			A.toast(`Setup started: ${plan.length} install step${plan.length === 1 ? '' : 's'}${rows.length ? `, ${rows.length} model entr${rows.length === 1 ? 'y' : 'ies'} added` : ''}`, 'ok');
		},
	};

	const CHANGES = {
		'toggle-visible': (el) => {
			const m = A.model(el.dataset.id);
			m.visible = el.checked;
			A.toast(`${m.name} ${m.visible ? 'shown to' : 'hidden from'} users`);
		},
		'toggle-op': (el) => ACTIONS.cell(el),
		'set-default': (el) => {
			d().defaults[el.dataset.op] = el.value;
			const m = A.model(el.value);
			if (m) A.toast(`${m.name} is now the default for ${el.dataset.op === 'detect' ? 'text detection' : OP[el.dataset.op].label}`);
		},
		'select-row': (el) => (el.checked ? S.ui.sel.add(el.dataset.id) : S.ui.sel.delete(el.dataset.id)),
		'select-all': (el) => {
			if (el.checked) V.filtered().forEach((m) => S.ui.sel.add(m.id));
			else S.ui.sel.clear();
		},
		'keep-loaded': (el) => {
			const m = A.model(el.dataset.id);
			m.run.keepLoaded = el.checked;
			if (el.checked && m.run.state === 'stopped') A.startService(m.id);
			else A.toast(`${m.name} ${el.checked ? 'stays loaded' : 'unloads after 5 idle minutes'}`);
		},
		scenario: (el) => {
			A.load(el.value);
			location.hash = el.value === 'fresh' ? '#overview' : location.hash;
		},
		'filter-task': (el) => (S.ui.f.task = el.value),
		'toggle-pick': (el) => (el.checked ? S.ui.picks.add(el.dataset.id) : S.ui.picks.delete(el.dataset.id)),
		'wiz-provider': (el) => (S.ui.wiz.provider = el.value),
		'wiz-cli': (el) => (el.checked ? S.ui.wiz.cliPicks.add(el.dataset.key) : S.ui.wiz.cliPicks.delete(el.dataset.key)),
		'wiz-read': (el) => (el.checked ? S.ui.wiz.read.add(el.dataset.key) : S.ui.wiz.read.delete(el.dataset.key)),
		mpick: (el) => (el.checked ? S.ui.modal.picks.add(el.dataset.key) : S.ui.modal.picks.delete(el.dataset.key)),
		mvisible: (el) => {
			S.ui.modal.visible = el.checked;
			return false;
		},
		mdevice: (el) => (S.ui.modal.form.device = el.value),
	};

	const INPUTS = {
		search: (el) => {
			S.ui.f.q = el.value;
			$('#mtable-wrap').innerHTML = V.modelsTable();
		},
		mform: (el) => {
			S.ui.modal.form[el.dataset.field] = el.value;
		},
		'cli-path': (el) => (S.ui.modal.path = el.value),
	};

	document.addEventListener('click', (e) => {
		const el = e.target.closest('[data-action]');
		if (!el || el.tagName === 'INPUT' || el.tagName === 'SELECT') return;
		if (el.tagName === 'A' && el.getAttribute('href')) return;
		const fn = ACTIONS[el.dataset.action];
		if (!fn) return;
		if (fn(el, e) === false) return;
		e.preventDefault();
		render();
	});
	document.addEventListener('change', (e) => {
		const el = e.target.closest('[data-change]');
		if (!el) return;
		const fn = CHANGES[el.dataset.change];
		if (fn && fn(el) !== false) render();
	});
	document.addEventListener('input', (e) => {
		const el = e.target.closest('[data-input]');
		if (el) INPUTS[el.dataset.input]?.(el);
	});
	document.addEventListener('keydown', (e) => {
		if (e.key !== 'Escape') return;
		if (S.ui.modal) S.ui.modal = null;
		else if (S.ui.drawer) S.ui.drawer = null;
		else return;
		render();
	});
	window.addEventListener('hashchange', () => {
		const [, q] = location.hash.slice(1).split('?');
		if (q) {
			const p = new URLSearchParams(q);
			if (p.get('task')) {
				S.ui.f.task = p.get('task');
				S.ui.f.status = 'all';
			}
		}
		S.ui.drawer = null;
		S.ui.modal = null;
		render();
		window.scrollTo(0, 0);
	});

	A.load('partial');
})();
