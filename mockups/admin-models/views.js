/* Overview, Models list and the model drawer. */
window.VIEWS = (() => {
	const A = window.APP;
	const { M, S, esc, fmtGb, TASK, OP, CAT, DEV } = A;
	const d = () => S.data;

	// --------------------------------------------------------------- helpers
	const dot = (st) => `<span class="dot ${st.dot || st.tone}"></span>`;
	const statusHtml = (m) => {
		const st = A.status(m);
		return `<span class="status tone-${st.tone}" data-qstatus="${m.id}">${dot(st)}<span>${esc(st.label)}</span></span>`;
	};
	const sw = (checked, attrs, label = '', disabled = false) =>
		`<label class="switch" onclick="event.stopPropagation()"><input type="checkbox" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} ${attrs}><span class="track"></span>${label}</label>`;
	const act = (fix, cls = 'btn sm') => {
		if (!fix) return '';
		if (fix.action === 'install' || fix.action === 'install-many') {
			const ids = fix.ids ? fix.ids.split(',') : [fix.id];
			if (!A.planFor(ids).length && ids.some((id) => A.queueItem(id)))
				return `<a class="status tone-busy small" href="#install"><span class="dot busy"></span>Installing — view queue</a>`;
			const gb = A.planFor(ids).reduce((a, p) => a + p.diskGb, 0);
			if (gb && !/\d (GB|MB)$/.test(fix.label)) fix = { ...fix, label: `${fix.label} · ${fmtGb(gb)}` };
		}
		const attrs = [
			`data-action="${fix.action}"`,
			fix.id ? `data-id="${esc(fix.id)}"` : '',
			fix.ids ? `data-ids="${esc(fix.ids)}"` : '',
			fix.adapter ? `data-adapter="${esc(fix.adapter)}"` : '',
		].join(' ');
		return `<button class="${cls}" ${attrs}>${esc(fix.label)}</button>`;
	};
	const taskChips = (m, max = 4) => {
		const ts = A.tasksOf(m);
		const shown = ts.slice(0, max).map((t) => `<span class="chip task">${esc(TASK[t].label)}</span>`).join('');
		return shown + (ts.length > max ? `<span class="chip muted" title="${esc(ts.slice(max).map((t) => TASK[t].label).join(', '))}">+${ts.length - max}</span>` : '');
	};
	const devBar = (use, lg = false) =>
		`<div class="bar ${lg ? 'lg' : ''}">${use.parts
			.map((p) => `<span class="seg-${p.kind}" style="width:${(p.gb / use.dev.vramGb) * 100}%" title="${esc(p.label)} · ${fmtGb(p.gb)}"></span>`)
			.join('')}</div>`;
	const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
	const subOf = (m) => {
		const c = A.cat(m);
		if (c) return [c.lang, fmtGb(c.diskGb)].filter(Boolean).join(' · ');
		if (m.source === 'service') return m.service.envVar;
		return m.slug || m.id;
	};

	// -------------------------------------------------------------- overview
	function overview() {
		const att = A.attention();
		const cov = Object.fromEntries(M.TASKS.map((t) => [t.id, A.coverage(t)]));
		const blocked = M.TASKS.filter((t) => t.required && cov[t.id].tone === 'bad');
		const limited = M.TASKS.filter((t) => cov[t.id].tone === 'warn');
		const installing = d().queue.filter((q) => q.state === 'running' || q.state === 'queued').length;
		let hero;
		if (blocked.length)
			hero = {
				tone: 'bad', icon: 'bi-slash-circle',
				title: `Komatose can’t ${blocked.map((t) => t.label.toLowerCase()).join(' or ')} yet`,
				text: 'Nothing on this machine can do those jobs. Guided setup picks models that fit this hardware and installs them in one go.',
				cta: `<a class="btn solid" href="#welcome"><i class="bi bi-magic"></i> Start guided setup</a>`,
			};
		else if (att.length)
			hero = {
				tone: 'warn', icon: 'bi-exclamation-triangle',
				title: `Ready to work — ${att.length} thing${att.length === 1 ? '' : 's'} need${att.length === 1 ? 's' : ''} attention`,
				text: `Every required job has a ready model.${limited.length ? ` ${limited.map((t) => t.label).join(', ')} ${limited.length === 1 ? 'is' : 'are'} running in a limited mode.` : ''}`,
				cta: '',
			};
		else if (limited.some((t) => t.required))
			hero = {
				tone: 'warn', icon: 'bi-hourglass-split',
				title: 'Ready to work, with limits',
				text: `${limited.map((t) => t.label).join(', ')} ${limited.length === 1 ? 'is' : 'are'} using a fallback or basic mode.${installing ? ` ${installing} install step${installing === 1 ? '' : 's'} in progress will fix most of this.` : ''}`,
				cta: installing ? `<a class="btn ghost" href="#install">View installs</a>` : '',
			};
		else
			hero = { tone: 'ok', icon: 'bi-check-circle', title: 'Everything is ready', text: limited.length ? `${limited.map((t) => t.label).join(', ')} could be better — see the suggestions below.` : 'Every job has a ready default model.', cta: '' };

		const card = (t) => {
			const c = cov[t.id];
			const defLine = c.def
				? `Default: <button class="btn link" data-action="open-model" data-id="${c.def.id}">${esc(c.def.name)}</button>`
				: c.defLabel
					? `Default: <b>${esc(c.defLabel)}</b>${c.defNote ? ` <span class="muted">(${c.defNote})</span>` : ''}`
					: '';
			const others = c.others?.length ? ` <span class="muted" title="${esc(c.others.join(', '))}">+${c.others.length} more</span>` : '';
			return `<div class="task-card ${c.tone}">
				<div class="t-head"><i class="bi ${t.icon} tone-${c.tone}"></i><strong>${esc(t.label)}</strong>${t.required ? '' : '<span class="t-optional">optional</span>'}</div>
				<div class="status tone-${c.tone}"><span class="dot ${c.tone}"></span>${esc(c.label)}</div>
				${defLine ? `<div class="t-default">${defLine}${others}</div>` : ''}
				${c.text ? `<div class="muted small">${esc(c.text)}</div>` : ''}
				${c.note ? `<div class="muted small">${esc(c.note)}</div>` : ''}
				${c.fix ? `<div class="t-fix row">${act(c.fix)}${c.fix.alt ? act(c.fix.alt, 'btn link') : ''}</div>` : ''}
				<a class="small" href="#models?task=${t.id}">Models for ${esc(t.label.toLowerCase())} →</a>
			</div>`;
		};

		const stages = M.STAGES.map((stage) => {
			const ts = M.TASKS.filter((t) => t.stage === stage);
			return `<div class="stage ${ts.length > 2 ? 'wide' : ''}"><div class="stage-name">${stage}</div><div class="stage-cards">${ts.map(card).join('')}</div></div>`;
		}).join('');

		const running = d().models.filter((m) => m.run && (m.run.state === 'running' || m.run.state === 'starting'));
		const onDemand = d().models.filter((m) => m.run && m.run.state === 'stopped' && m.install?.state !== 'missing' && A.usable(m));

		const attHtml = att.length
			? att.map((a) => `<div class="attn"><i class="bi ${a.icon} tone-${a.tone}"></i><div><strong>${esc(a.title)}</strong><div class="muted small">${esc(a.text)}</div></div><div class="a-actions">${a.actions.map((x, i) => act(x, i ? 'btn ghost sm' : 'btn sm')).join('')}</div></div>`).join('')
			: `<div class="card muted"><i class="bi bi-check2-circle tone-ok"></i> Nothing needs attention. Missing optional models aren’t problems — they’re in <a href="#install">Install</a>.</div>`;

		const disk = A.diskUsed();
		const freeDisk = M.HARDWARE.disk.freeGb;

		return `
		<div class="page-head">
			<div><div class="kicker">Administration · Models</div><h1>Overview</h1>
			<p>What Komatose can do on this machine, by job. Checks here are free — they look at files, ports and variable names and never call a model.</p></div>
			<div class="row"><button class="btn ghost" data-action="recheck"><i class="bi bi-arrow-repeat"></i> Recheck</button><button class="btn" data-action="add-model"><i class="bi bi-plus-lg"></i> Add model</button></div>
		</div>

		<div class="card hero-status">
			<i class="bi ${hero.icon} big-icon tone-${hero.tone}"></i>
			<div><h2>${esc(hero.title)}</h2><div class="muted">${esc(hero.text)}</div></div>
			<div>${hero.cta}</div>
		</div>

		<div class="section">
			<div class="section-head"><h2>Jobs</h2><span class="muted small">Each card shows the model that runs by default and the one fix that would help most. <a href="#access">Change defaults →</a></span></div>
			<div class="pipeline">${stages}</div>
		</div>

		<div class="section two-col">
			<div>
				<div class="section-head"><h2>Needs attention</h2><span class="muted small">Only things that are broken — not every optional model you don’t have.</span></div>
				<div class="attn-list">${attHtml}</div>
			</div>
			<div>
				<div class="section-head"><h2>Running now</h2><a class="small" href="#hardware">Hardware & services →</a></div>
				<div class="card">
					<div class="running-list">
						${running.length ? running.map((m) => `<div class="running-item">${dot(A.status(m))}<div><button class="btn link" data-action="open-model" data-id="${m.id}">${esc(m.name)}</button><div class="muted small">${DEV[A.deviceOf(m)].label}${A.cat(m)?.port || m.launch?.port ? ` · port ${m.launch?.port || A.cat(m).port}` : ''} · ${fmtGb(A.memOf(m))}</div></div><button class="btn ghost sm" data-action="stop" data-id="${m.id}">Stop</button></div>`).join('') : '<div class="muted small">No model is loaded right now.</div>'}
					</div>
					<div class="muted small" style="margin-top:.5rem">${onDemand.length} more ready — they load when a task needs them and unload after 5 idle minutes.</div>
					<div style="margin-top:1rem">
						${['gpu0', 'gpu1', 'cpu'].map((id) => { const u = A.deviceUse(id); return `<div class="res-row"><span class="muted">${u.dev.label}</span>${devBar(u)}<span class="small">${u.used.toFixed(1)} / ${u.dev.vramGb} GB</span></div>`; }).join('')}
						<div class="res-row"><span class="muted">Disk</span><div class="bar"><span class="seg-used" style="width:${(disk / (disk + freeDisk)) * 100}%"></span></div><span class="small">${fmtGb(disk)} models · ${freeDisk} GB free</span></div>
					</div>
				</div>
			</div>
		</div>`;
	}

	// ---------------------------------------------------------------- models
	function filtered(ignoreStatus = false) {
		const f = S.ui.f;
		return d().models.filter((m) => {
			const st = A.status(m);
			if (!ignoreStatus) {
				if (f.status === 'machine' && st.key === 'missing') return false;
				if (f.status === 'attention' && st.key !== 'attention') return false;
				if (f.status === 'missing' && !(st.key === 'missing' || st.key === 'installing')) return false;
				if (f.status === 'hidden' && (m.visible || st.key === 'missing')) return false;
			}
			if (f.source !== 'all' && m.source !== f.source) return false;
			if (f.task !== 'all' && !A.tasksOf(m).includes(f.task)) return false;
			if (f.q && !`${m.name} ${m.slug || ''} ${m.id}`.toLowerCase().includes(f.q.toLowerCase())) return false;
			return true;
		});
	}

	function modelsTable() {
		const list = filtered();
		const f = S.ui.f;
		const groupOf = f.group === 'family' ? A.familyOf : f.group === 'source' ? (m) => A.sourceOf(m).group : () => '';
		const order = f.group === 'family' ? A.FAMILY_ORDER : ['On this machine', 'Remote APIs', 'CLI agents', 'Services', ''];
		const groups = new Map();
		for (const m of list) {
			const g = groupOf(m);
			if (!groups.has(g)) groups.set(g, []);
			groups.get(g).push(m);
		}
		const allSel = list.length && list.every((m) => S.ui.sel.has(m.id));
		const row = (m) => {
			const st = A.status(m);
			const src = A.sourceOf(m);
			const missing = st.key === 'missing';
			return `<tr class="m-row ${S.ui.sel.has(m.id) ? 'sel' : ''} ${missing ? 'dim' : ''}" data-action="open-model" data-id="${m.id}">
				<td class="keep" style="width:30px" onclick="event.stopPropagation()"><input type="checkbox" data-change="select-row" data-id="${m.id}" ${S.ui.sel.has(m.id) ? 'checked' : ''}></td>
				<td><div class="m-name"><strong>${esc(m.name)}</strong><span class="sub"><span class="src"><i class="bi ${src.icon}"></i>${esc(src.label)}</span> · ${esc(subOf(m))}</span></div></td>
				<td><div class="chips">${taskChips(m, 3)}</div></td>
				<td class="keep"><div class="row">${statusHtml(m)}${missing ? `<button class="btn sm" data-action="install" data-id="${m.id}">Install · ${fmtGb(A.cat(m).diskGb)}</button>` : ''}${st.key === 'attention' && st.fix ? act(st.fix, 'btn sm') : ''}</div></td>
				<td class="keep">${sw(m.visible, `data-change="toggle-visible" data-id="${m.id}"`, '', missing)}</td>
				<td style="width:24px"><i class="bi bi-chevron-right muted"></i></td>
			</tr>`;
		};
		if (!list.length) return `<div class="card muted">No models match these filters.</div>`;
		return `<table class="mtable">
			<thead><tr>
				<th onclick="event.stopPropagation()"><input type="checkbox" data-change="select-all" ${allSel ? 'checked' : ''}></th>
				<th>Model</th><th>Jobs</th><th>Status</th><th title="Shown in chapter model lists">Users can pick</th><th></th>
			</tr></thead>
			<tbody>
			${order.filter((g) => groups.has(g)).map((g) => `${g ? `<tr class="group"><td colspan="6"><b>${esc(g)}</b> · ${groups.get(g).length}</td></tr>` : ''}${groups.get(g).map(row).join('')}`).join('')}
			</tbody></table>`;
	}

	function models() {
		const f = S.ui.f;
		const base = filtered(true);
		const count = (key) =>
			base.filter((m) => {
				const k = A.status(m).key;
				if (key === 'machine') return k !== 'missing';
				if (key === 'attention') return k === 'attention';
				if (key === 'missing') return k === 'missing' || k === 'installing';
				if (key === 'hidden') return !m.visible && k !== 'missing';
				return true;
			}).length;
		const seg = (key, options) =>
			`<div class="seg">${options.map(([val, label, n]) => `<button class="${f[key] === val ? 'on' : ''}" data-action="filter" data-key="${key}" data-val="${val}">${label}${n != null ? `<span class="n">${n}</span>` : ''}</button>`).join('')}</div>`;
		const sel = S.ui.sel.size;
		return `
		<div class="page-head">
			<div><div class="kicker">Administration · Models</div><h1>Models</h1>
			<p>Every model in one list — installed weights, local servers, remote APIs, CLI agents and services. Click a row for setup, jobs, tests and visibility in one place.</p></div>
			<div class="row"><button class="btn ghost" data-action="transfer"><i class="bi bi-box-arrow-up-right"></i> Import / export</button><button class="btn" data-action="add-model"><i class="bi bi-plus-lg"></i> Add model</button></div>
		</div>
		<div class="toolbar">
			<input type="search" placeholder="Search models…" value="${esc(f.q)}" data-input="search">
			${seg('status', [['machine', 'On this machine', count('machine')], ['attention', 'Needs attention', count('attention')], ['missing', 'Not installed', count('missing')], ['hidden', 'Hidden from users', count('hidden')], ['all', 'All', count('all')]])}
		</div>
		<div class="toolbar">
			${seg('source', [['all', 'Any source'], ['local', 'Local'], ['remote', 'Remote'], ['cli', 'CLI'], ['service', 'Service']])}
			<select data-change="filter-task" style="width:auto">
				<option value="all">Any job</option>
				${M.TASKS.map((t) => `<option value="${t.id}" ${f.task === t.id ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}
			</select>
			<span class="muted small" style="margin-left:auto">Group by</span>
			${seg('group', [['family', 'Job'], ['source', 'Source'], ['none', 'None']])}
		</div>
		<div id="mtable-wrap">${modelsTable()}</div>
		${sel ? `<div class="bulkbar"><strong>${sel} selected</strong>
			<button class="btn sm" data-action="bulk" data-op="show">Show to users</button>
			<button class="btn sm" data-action="bulk" data-op="hide">Hide from users</button>
			<button class="btn ghost sm" data-action="bulk" data-op="test">Test</button>
			<button class="btn ghost sm" data-action="bulk" data-op="install">Install missing</button>
			<button class="btn link" style="margin-left:auto" data-action="bulk" data-op="clear">Clear selection</button></div>` : ''}`;
	}

	// ---------------------------------------------------------------- drawer
	function testCell(m, op) {
		const t = m.tests[op];
		if (!t) return '<span class="muted">Not tested</span>';
		if (t.running) return '<span class="tone-busy"><span class="dot busy" style="display:inline-block"></span> Testing…</span>';
		if (t.ok) return `<span class="tone-ok" title="${esc(t.preview || '')}">✓ ${secs(t.ms)}</span> <span class="muted">· ${esc(t.at)}</span>`;
		return `<span class="tone-bad" title="${esc(t.reason)}">✗ ${esc(t.reason.length > 38 ? `${t.reason.slice(0, 38)}…` : t.reason)}</span>`;
	}

	function drawer(m) {
		const st = A.status(m);
		const src = A.sourceOf(m);
		const c = A.cat(m);
		const missing = st.key === 'missing';
		const sections = [];

		// Status and the fix for it.
		let statusBox = '';
		if (st.key === 'attention') statusBox = `<div class="fix-box ${st.tone === 'bad' ? 'bad' : ''}"><strong>${esc(st.label)}</strong><div class="small">${esc(st.detail || '')}</div><div class="row" style="margin-top:.5rem">${act(st.fix)}</div></div>`;
		else if (st.key === 'optional') statusBox = `<div class="fix-box"><strong>${esc(st.label)}</strong><div class="small">${esc(st.detail)}</div><div class="row" style="margin-top:.5rem">${act(st.fix)}</div></div>`;
		else if (missing) {
			const plan = A.planFor([m.id]);
			const total = plan.reduce((a, p) => a + p.diskGb, 0);
			const f = A.fit(c);
			statusBox = `<div class="fix-box"><strong>Not installed</strong><div class="small">${esc(c.sum)}</div>
				<div class="chips" style="margin:.45rem 0"><span class="chip"><i class="bi bi-hdd"></i> ${fmtGb(total)} download${plan.length > 1 ? ' incl. dependencies' : ''}</span><span class="chip ${f.tone}"><i class="bi bi-memory"></i> ${esc(f.text)}</span></div>
				<button class="btn solid sm" data-action="install" data-id="${m.id}">Install</button></div>`;
		} else if (st.key === 'installing') {
			const q = A.queueItem(m.id);
			statusBox = `<div class="fix-box"><strong data-qstatus="${m.id}">${esc(st.label)}</strong><div class="progress" style="margin:.45rem 0"><span data-qprog="${m.id}" style="width:${q.progress * 100}%"></span></div><button class="btn danger sm" data-action="cancel-install" data-id="${m.id}">Cancel</button></div>`;
		} else {
			const where = m.run?.state === 'running' ? `Running on ${DEV[A.deviceOf(m)].label}${c?.port || m.launch?.port ? ` · port ${m.launch?.port || c.port}` : ''} · ${fmtGb(A.memOf(m))} since ${m.run.since || 'just now'}.` : m.run ? `Installed. Loads on ${DEV[A.deviceOf(m)].label} when a task needs it and unloads after 5 idle minutes.` : m.source === 'cli' ? 'The CLI starts per call. Found is not proof of sign-in — sign in as the server account.' : m.source === 'remote' ? 'Endpoint and key variable are set. Each call is billed by the provider.' : 'Installed and ready.';
			statusBox = `<div class="fix-box ok"><strong class="tone-ok">${esc(st.label)}</strong><div class="small">${esc(where)}</div></div>`;
		}
		sections.push(`<div class="d-sec">${statusBox}</div>`);

		// Visibility.
		if (!missing) {
			const roles = ['Admin', 'Translator', 'Proofreader', 'Typesetter'];
			sections.push(`<div class="d-sec"><h4>Who can pick it</h4>
				<div class="spread">${sw(m.visible, `data-change="toggle-visible" data-id="${m.id}"`, m.visible ? 'Shown in chapter model lists' : 'Hidden from chapter model lists')}</div>
				<div class="chips" style="margin-top:.6rem">${roles.map((r) => `<label class="chip ${m.visible ? '' : 'muted'}"><input type="checkbox" ${m.visible ? 'checked' : 'disabled'} style="accent-color:var(--teal)"> ${r}</label>`).join('')}</div>
				<div class="muted small" style="margin-top:.4rem">Hiding keeps the setup; nothing is deleted.</div></div>`);
		}

		// Jobs + tests.
		const ops = A.possibleOps(m);
		if (ops.length) {
			const billed = m.billed ? '<span class="chip warn" title="Remote and CLI tests make a real, billed call">billed</span>' : '';
			sections.push(`<div class="d-sec"><div class="spread" style="margin-bottom:.5rem"><h4 style="margin:0">Jobs it may run</h4><div class="row">${billed}${!missing ? `<button class="btn ghost sm" data-action="test-all" data-id="${m.id}">Test all allowed</button>` : ''}</div></div>
				${m.opsLocked ? `<div class="muted small" style="margin-bottom:.4rem"><i class="bi bi-lock"></i> Fixed by the model type — ${esc(m.name)} only does these.</div>` : ''}
				<div class="op-list">${ops.map((op) => {
					const allowed = m.ops.includes(op);
					const isDef = d().defaults[op] === m.id;
					return `<div class="op-row">
						<input type="checkbox" data-change="toggle-op" data-id="${m.id}" data-op="${op}" ${allowed ? 'checked' : ''} ${m.opsLocked ? 'disabled' : ''}>
						<div><div>${esc(OP[op].label)}</div><div class="muted small">${esc(OP[op].hint)}</div></div>
						<div class="res">${allowed && !missing ? testCell(m, op) : ''}</div>
						<div class="row">${allowed && !missing && op !== 'vision' ? `<button class="icon-btn" title="${isDef ? 'Default for this job' : 'Make default for this job'}" data-action="make-default" data-op="${op}" data-id="${m.id}" style="color:${isDef ? 'var(--amber)' : ''}">${isDef ? '★' : '☆'}</button>` : ''}${allowed && !missing ? `<button class="btn ghost sm" data-action="test" data-id="${m.id}" data-op="${op}">Test</button>` : ''}</div>
					</div>`;
				}).join('')}</div>
				${m.tests.vision && m.tests.vision.ok === false ? '<div class="muted small" style="margin-top:.4rem"><i class="bi bi-info-circle"></i> A failed image test keeps this model out of transcription until it passes.</div>' : ''}</div>`);
		} else if (c) {
			const isDetDefault = d().defaults.detect === m.id;
			sections.push(`<div class="d-sec"><h4>Jobs</h4><div class="chips">${taskChips(m, 9)}</div>
				${c.group === 'detect' && !missing ? `<div class="row" style="margin-top:.6rem">${isDetDefault ? '<span class="chip ok">★ Default detector</span>' : `<button class="btn ghost sm" data-action="make-default" data-op="detect" data-id="${m.id}">Make default detector</button>`}</div>` : ''}
				${c.group === 'fill' ? `<div class="muted small" style="margin-top:.5rem">Appears as a clean method in the Clean step.</div>` : ''}</div>`);
		}

		// Connection / install details.
		let kv = [];
		let extra = '';
		if (m.source === 'remote') {
			const set = A.keySet(m.endpoint.keyVar);
			kv = [['Provider', esc(m.endpoint.provider)], ['Base URL', `<code>${esc(m.endpoint.baseUrl)}</code>`], ['Model id', `<code>${esc(m.slug)}</code>`], ['API key', `<code>${esc(m.endpoint.keyVar)}</code> ${set ? '<span class="chip ok">set in .env</span>' : '<span class="chip warn">not set</span>'}`]];
			extra = `<div class="row" style="margin-top:.6rem"><button class="btn ghost sm" data-action="toast" data-msg="Endpoint listed 41 models (cached)">Refresh model list</button><button class="btn ghost sm" data-action="add-model" data-step="remote">Add another model from this endpoint</button></div>`;
		} else if (m.source === 'cli') {
			const t = d().cli[m.adapter];
			kv = [['CLI', esc(M.CLI_DEFS[m.adapter].label)], ['Location', t.path ? `<code>${esc(t.path)}</code>` : '<span class="muted">not set</span>'], ['Found via', t.source === 'auto' ? 'automatic discovery' : t.source === 'saved' ? 'saved location' : 'environment variable'], ['Version', t.version || '—'], ['Model', `<code>${esc(m.slug)}</code>`]];
			extra = `<div class="row" style="margin-top:.6rem"><button class="btn ghost sm" data-action="fix-cli" data-adapter="${m.adapter}">Change location</button><button class="btn ghost sm" data-action="add-model" data-step="cli" data-adapter="${m.adapter}">Add more ${esc(M.CLI_DEFS[m.adapter].label)} models</button></div>`;
		} else if (m.source === 'service') {
			kv = [['Variable', `<code>${esc(m.service.envVar)}</code>`], ['URL', m.service.url ? `<code>${esc(m.service.url)}</code>` : '<span class="muted">not set</span>']];
		} else if (m.launch) {
			const L = m.launch;
			kv = [['Launch preset', esc(L.preset)], ['Weights', `<code>${esc(L.weights)}</code>`], ...(L.projector ? [['Vision projector', `<code>${esc(L.projector)}</code>`]] : []), ['Device · port', `${DEV[L.device].label} · ${L.port}`], ['Context', `${L.ctx.toLocaleString()} tokens · ${L.slots} slots`], ['Start with app', L.startOnBoot ? 'Yes' : 'No']];
			extra = S.ui.editLaunch
				? `<div class="fields" style="margin-top:.8rem">
					<label class="field"><span>Weights</span><input type="text" value="${esc(L.weights)}"></label>
					<label class="field"><span>Device</span><select>${['gpu0', 'gpu1', 'cpu'].map((x) => `<option ${x === L.device ? 'selected' : ''}>${DEV[x].label} · ${DEV[x].name}</option>`).join('')}</select></label>
					<label class="field"><span>Port</span><input type="number" value="${L.port}"></label>
					<label class="field"><span>Context size</span><input type="number" value="${L.ctx}"></label>
					<label class="field"><span>GPU layers</span><input type="number" value="${L.gpuLayers}"></label>
					<label class="field"><span>Slots</span><input type="number" value="${L.slots}"></label>
				</div>
				<details style="margin-top:.6rem"><summary class="muted small">Advanced tuning arguments</summary><textarea rows="3" style="margin-top:.4rem">--temp\n0.6\n--top-p\n0.95</textarea></details>
				<div class="row" style="margin-top:.6rem"><button class="btn solid sm" data-action="save-launch" data-id="${m.id}">Save</button><button class="btn ghost sm" data-action="edit-launch">Cancel</button><span class="muted small">A running model keeps its old settings until Restart.</span></div>`
				: `<div class="row" style="margin-top:.6rem"><button class="btn ghost sm" data-action="edit-launch">Edit launch settings</button></div>`;
		} else if (c && !missing) {
			kv = [['Files', `<code>data/models/${esc(c.id)}/</code>`], ['Size on disk', fmtGb(c.diskGb)], ['Memory running', `${fmtGb(c.memGb)} on ${DEV[c.device].label}`], ...(c.requires ? [['Runs in', `<code>${esc(A.ENV[c.requires[0]].path)}</code>`]] : []), ['Source', `<code>${esc(c.repo)}</code>`]];
			extra = `<div class="row" style="margin-top:.6rem"><button class="btn ghost sm" data-action="view-log" data-id="${m.id}">Install log</button><button class="btn ghost sm" data-action="toast" data-msg="Checksums verified — files are intact">Verify files</button></div>`;
		}
		if (kv.length) sections.push(`<div class="d-sec"><h4>Setup</h4><dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>${extra}</div>`);

		// Runtime controls.
		if (m.run && !missing && st.key !== 'installing') {
			const s = m.run.state;
			const settled = s === 'running' || s === 'stopped' || s === 'error';
			sections.push(`<div class="d-sec"><h4>Runtime</h4>
				<div class="spread"><span>${statusHtml(m)}</span><div class="row">
					<button class="btn ghost sm" data-action="start" data-id="${m.id}" ${s !== 'stopped' ? 'disabled' : ''}>Start</button>
					<button class="btn ghost sm" data-action="stop" data-id="${m.id}" ${s !== 'running' ? 'disabled' : ''}>Stop</button>
					<button class="btn ghost sm" data-action="restart" data-id="${m.id}" ${!settled || s === 'stopped' ? 'disabled' : ''}>Restart</button>
				</div></div>
				<div style="margin-top:.6rem">${sw(m.run.keepLoaded, `data-change="keep-loaded" data-id="${m.id}"`, 'Keep loaded (don’t unload when idle)')}</div>
				${m.run.evictedBy ? `<div class="muted small" style="margin-top:.4rem">Unloaded to make room for ${esc(m.run.evictedBy)}.</div>` : ''}
				${A.cat(m)?.runtime === 'editor' ? '<div class="muted small" style="margin-top:.4rem">Image editors share GPU 0 with the chat model; only one of them fits at a time.</div>' : ''}</div>`);
		}

		// Remove.
		if (!missing && st.key !== 'installing') {
			const running = m.run?.state === 'running';
			const label = c ? 'Uninstall' : 'Remove';
			const text = c ? `Deletes ${fmtGb(c.diskGb)} of weights. Settings for it are kept, so reinstalling restores them.` : m.source === 'service' ? 'Clear the variable in .env to switch it off.' : 'Removes this entry. Chapters that used it fall back to the job default.';
			if (m.source !== 'service')
				sections.push(`<div class="d-sec"><h4>${label}</h4><div class="spread"><span class="muted small grow">${text}</span><button class="btn danger sm" data-action="remove" data-id="${m.id}" ${running ? 'disabled title="Stop it first"' : ''}>${label}</button></div></div>`);
		}

		return `<div class="scrim" data-action="close-drawer"></div>
		<aside class="drawer" role="dialog" aria-label="${esc(m.name)}">
			<div class="drawer-head">
				<div class="spread"><span class="src"><i class="bi ${src.icon}"></i>${esc(src.label)}</span><button class="icon-btn" data-action="close-drawer" aria-label="Close"><i class="bi bi-x-lg"></i></button></div>
				<h2 style="margin-top:.3rem">${esc(m.name)}</h2>
				<div class="row" style="margin-top:.3rem">${statusHtml(m)}<span class="muted small">· ${esc(subOf(m))}</span></div>
			</div>
			<div class="drawer-body">${sections.join('')}</div>
		</aside>`;
	}

	return { overview, models, modelsTable, filtered, drawer, statusHtml, sw, act, dot, devBar, taskChips, secs, subOf };
})();
