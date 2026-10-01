/* Install catalog, task matrix, hardware, guided setup and design notes. */
window.VIEWS2 = (() => {
	const A = window.APP;
	const V = window.VIEWS;
	const { M, S, esc, fmtGb, TASK, OP, CAT, ENV, DEV } = A;
	const d = () => S.data;

	// --------------------------------------------------------------- install
	function queueItemHtml(q) {
		const running = q.state === 'running';
		const done = q.state === 'done';
		const text = done ? 'Installed' : running ? `${Math.round(q.progress * 100)}%` : q.state === 'cancelled' ? 'Cancelled' : 'Queued';
		return `<div class="q-item">
			<div class="spread">
				<div class="row"><span class="dot ${running ? 'busy' : done ? 'ok' : 'idle'}"></span><strong>${esc(q.label)}</strong>${q.dep ? `<span class="chip muted">needed by ${esc(q.forName)}</span>` : ''}<span class="muted small">${fmtGb(q.diskGb)}</span></div>
				<div class="row"><span class="small muted" data-qlabel="${q.id}">${text}</span>
					<button class="btn ghost sm" data-action="toggle-log" data-id="${q.id}">${q.showLog ? 'Hide log' : 'Log'}</button>
					${running || q.state === 'queued' ? `<button class="btn danger sm" data-action="cancel-install" data-id="${q.id}">Cancel</button>` : ''}</div>
			</div>
			${done || q.state === 'cancelled' ? '' : `<div class="progress"><span data-qprog="${q.id}" style="width:${q.progress * 100}%"></span></div>`}
			${q.showLog ? `<pre class="log" data-qlog="${q.id}">${esc(A.logLines(q))}</pre>` : ''}
		</div>`;
	}

	function catItem(c) {
		const m = A.model(c.id);
		const st = A.status(m);
		const installed = m.install.state === 'installed';
		const busy = st.key === 'installing';
		const picked = S.ui.picks.has(c.id);
		const f = A.fit(c);
		const needEnv = (c.requires || []).filter((e) => !A.envInstalled(e) && !A.queueItem(e));
		let action;
		if (installed) action = `<span class="status tone-ok"><i class="bi bi-check2-circle"></i> Installed</span><button class="btn ghost sm" data-action="open-model" data-id="${c.id}">Details</button>`;
		else if (busy) action = `${V.statusHtml(m)}`;
		else if (m.install.state === 'failed') action = `<span class="status tone-bad"><i class="bi bi-x-octagon"></i> Failed</span><button class="btn sm" data-action="install" data-id="${c.id}">Retry</button>`;
		else action = `<button class="btn sm" data-action="install" data-id="${c.id}">Install</button>`;
		return `<div class="cat-item ${installed ? 'installed' : ''} ${picked ? 'picked' : ''}">
			<div class="ci-head">${!installed && !busy ? `<input type="checkbox" title="Add to selection" data-change="toggle-pick" data-id="${c.id}" ${picked ? 'checked' : ''}>` : ''}<strong>${esc(c.name)}</strong>${c.recommended ? '<span class="chip violet">recommended</span>' : ''}</div>
			<div class="ci-sum">${esc(c.sum)}</div>
			<div class="ci-foot">
				<span class="chip"><i class="bi bi-hdd"></i> ${fmtGb(c.diskGb)}</span>
				<span class="chip ${f.tone}" title="Memory while running"><i class="bi bi-memory"></i> ${esc(f.text)}</span>
				${c.lang ? `<span class="chip">${esc(c.lang)}</span>` : ''}
				${needEnv.map((e) => `<span class="chip warn" title="Installed automatically first">+ ${esc(ENV[e].path)} · ${fmtGb(ENV[e].diskGb)}</span>`).join('')}
				${action}
			</div>
		</div>`;
	}

	function install() {
		const used = A.diskUsed();
		const free = M.HARDWARE.disk.freeGb;
		const pickPlan = A.planFor([...S.ui.picks]);
		const pickGb = pickPlan.reduce((a, p) => a + p.diskGb, 0);
		const total = used + free;
		const queue = d().queue.filter((q) => q.state !== 'cancelled');
		const active = queue.filter((q) => q.state === 'running' || q.state === 'queued');

		const bundles = M.BUNDLES.map((b) => {
			const missing = b.items.filter((id) => A.model(id).install.state !== 'installed');
			const plan = A.planFor(missing);
			const size = plan.reduce((a, p) => a + p.diskGb, 0);
			const done = !missing.length;
			const pending = missing.length && !plan.length;
			return `<div class="bundle ${done ? 'done' : ''}">
				<div class="row"><i class="bi ${b.icon} tone-ok" style="font-size:1.2rem"></i><h3>${esc(b.name)}</h3></div>
				<div class="muted small">${esc(b.blurb)}</div>
				<ul>${b.items.map((id) => `<li class="${A.model(id).install.state === 'installed' ? 'have' : ''}">${esc(CAT[id].name)} <span class="muted">· ${fmtGb(CAT[id].diskGb)}</span></li>`).join('')}</ul>
				<div class="spread">${done ? '<span class="status tone-ok"><i class="bi bi-check2-circle"></i> All installed</span>' : pending ? '<span class="status tone-busy">Installing…</span>' : `<span class="small">${missing.length} to install · ${fmtGb(size)}${plan.some((p) => p.kind === 'env') ? ' incl. environments' : ''}</span><button class="btn sm" data-action="install-many" data-ids="${missing.join(',')}">Install</button>`}</div>
			</div>`;
		}).join('');

		const groups = M.CATALOG_GROUPS.map((g) => {
			const items = M.CATALOG.filter((c) => c.group === g.id);
			const have = items.filter((c) => A.model(c.id).install.state === 'installed').length;
			return `<div class="cat-group"><div class="cat-group-head"><h3>${esc(g.label)}</h3><span class="muted small">${have}/${items.length} installed</span><span class="muted small grow">${esc(g.blurb)}</span></div><div class="cat-grid">${items.map(catItem).join('')}</div></div>`;
		}).join('');

		return `
		<div class="page-head">
			<div><div class="kicker">Administration · Models</div><h1>Install</h1>
			<p>Everything Komatose can download, grouped by job. Dependencies (Python environments) are added automatically and installed first. Every install shows its exact commands before it runs, and downloads are pinned and checksum-verified.</p></div>
		</div>

		<div class="card disk-card">
			<div>
				<div class="spread" style="margin-bottom:.4rem"><strong>Disk · ${esc(M.HARDWARE.disk.path)}</strong><span class="small muted">${fmtGb(used)} used by models · ${free} GB free${pickGb ? ` · <span class="tone-warn">${fmtGb(pickGb)} selected</span>` : ''}</span></div>
				<div class="bar lg"><span class="seg-used" style="width:${(used / total) * 100}%"></span><span class="seg-pending" style="width:${(pickGb / total) * 100}%"></span></div>
				<div class="legend" style="margin-top:.4rem"><span><i class="sw seg-used"></i> Models & environments</span><span><i class="sw seg-pending"></i> Selected to install</span><span><i class="sw" style="background:rgba(244,247,251,.07)"></i> Free</span></div>
			</div>
		</div>

		${queue.length ? `<div class="section"><div class="section-head"><h2>Install queue</h2><div class="row"><span class="muted small">${active.length ? `${active.length} remaining · runs one at a time` : 'All done'}</span>${queue.some((q) => q.state === 'done') ? '<button class="btn ghost sm" data-action="clear-finished">Clear finished</button>' : ''}</div></div><div class="queue">${queue.map(queueItemHtml).join('')}</div></div>` : ''}

		<div class="section"><div class="section-head"><h2>Bundles</h2><span class="muted small">Sets of models that work together. Only what’s missing is installed.</span></div><div class="bundles">${bundles}</div></div>

		<div class="section"><div class="section-head"><h2>All models</h2><span class="muted small">Tick several to install them together, or install one at a time.</span></div>${groups}
			<div class="card tight muted small" style="margin-top:1.2rem"><i class="bi bi-box"></i> Built in, nothing to install: heuristic bubble detector, PaddleOCR line detector (comes with the OCR environment), flat fill and Telea clean methods.</div>
		</div>

		${S.ui.picks.size ? `<div class="sticky-cart"><strong>${S.ui.picks.size} selected</strong><span class="muted small">${pickPlan.length} step${pickPlan.length === 1 ? '' : 's'} · ${fmtGb(pickGb)}${pickPlan.some((p) => p.dep) ? ' incl. dependencies' : ''}</span><button class="btn solid sm" style="margin-left:auto" data-action="review-picks">Review & install</button><button class="btn ghost sm" data-action="clear-picks">Clear</button></div>` : ''}`;
	}

	// ---------------------------------------------------------------- access
	function access() {
		const ops = M.OPS;
		const groups = [];
		for (const op of ops) {
			const last = groups[groups.length - 1];
			if (last && last.task === op.task) last.ops.push(op);
			else groups.push({ task: op.task, ops: [op] });
		}
		const rows = d().models.filter((m) => A.status(m).key !== 'missing' && A.status(m).key !== 'installing' && A.possibleOps(m).length);
		const fams = A.FAMILY_ORDER.filter((f) => rows.some((m) => A.familyOf(m) === f));
		const council = (d().defaults.transcribe || []).map(A.model).filter(Boolean);

		const defaultCell = (op) => {
			if (op.id === 'vision') return `<td><button class="btn link" style="font-size:.75rem" data-action="council" title="Transcription council">${council.length ? esc(council.map((m) => m.name.split(' ')[0]).join(' + ')) : 'Choose…'} <i class="bi bi-pencil"></i></button></td>`;
			const ready = A.readyFor(op.id);
			const cur = d().defaults[op.id] || '';
			const def = A.defaultFor(op.id);
			const warn = cur && def.fallback;
			return `<td><select data-change="set-default" data-op="${op.id}" style="${warn ? 'border-color:var(--amber)' : ''}" title="${warn ? `${esc(def.wanted.name)} is unavailable` : ''}">
				<option value="">${ready.length ? 'Auto' : 'None ready'}</option>
				${ready.map((m) => `<option value="${m.id}" ${m.id === cur ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
				${warn ? `<option value="${cur}" selected>⚠ ${esc(def.wanted.name)}</option>` : ''}
			</select></td>`;
		};

		const cell = (m, op) => {
			if (!A.possibleOps(m).includes(op.id)) return '<td class="cell na" title="This model can’t do this job"></td>';
			const allowed = m.ops.includes(op.id);
			const locked = m.opsLocked;
			const attrs = locked ? 'title="Fixed by the model type"' : `data-action="cell" data-id="${m.id}" data-op="${op.id}" title="${allowed ? 'Click to disallow' : 'Click to allow'}"`;
			if (!allowed) return `<td class="cell" ${attrs}><span class="mx off">·</span></td>`;
			const t = m.tests[op.id];
			const isDef = op.id === 'vision' ? council.includes(m) : A.defaultFor(op.id).model === m;
			const cls = ['mx', 'on', t && t.ok === false ? 'fail' : '', !t ? 'untested' : '', isDef ? 'star' : ''].join(' ');
			const icon = t?.running ? '<span class="dot busy"></span>' : t && t.ok === false ? '<i class="bi bi-x-lg"></i>' : '<i class="bi bi-check-lg"></i>';
			return `<td class="cell ${locked ? 'locked' : ''}" ${attrs}><span class="${cls}" title="${t ? (t.ok ? `Tested ✓ ${V.secs(t.ms)}` : t.reason || '') : 'Allowed · not tested yet'}">${icon}</span></td>`;
		};

		const untested = rows.filter((m) => A.usable(m) && m.visible).flatMap((m) => m.ops.filter((op) => !m.tests[op]).map((op) => ({ m, op })));

		return `
		<div class="page-head">
			<div><div class="kicker">Administration · Models</div><h1>Jobs & defaults</h1>
			<p>Which model does each job by default, and which models users may pick for it. This replaces the checkbox wall on every Settings card: one grid, real job names, test results in place.</p></div>
			<div class="row"><button class="btn ghost" data-action="benchmark"><i class="bi bi-speedometer2"></i> Compare on a page</button><button class="btn" data-action="test-untested" ${untested.length ? '' : 'disabled'}><i class="bi bi-play"></i> Test ${untested.length} untested</button></div>
		</div>
		<div class="matrix-legend">
			<span><span class="mx on"><i class="bi bi-check-lg"></i></span>Allowed · test passed</span>
			<span><span class="mx on untested"><i class="bi bi-check-lg"></i></span>Allowed · not tested</span>
			<span><span class="mx on fail"><i class="bi bi-x-lg"></i></span>Allowed · test failed</span>
			<span><span class="mx off">·</span>Not allowed</span>
			<span><span class="mx" style="background:repeating-linear-gradient(135deg,transparent 0 4px,rgba(244,247,251,.08) 4px 8px)"></span>Can’t do it</span>
			<span><span class="mx on star"><i class="bi bi-check-lg"></i></span>Default</span>
			<span class="muted">Click a cell to allow or disallow.</span>
		</div>
		<div class="matrix-wrap">
			<table class="matrix">
				<thead>
					<tr><th class="rowhead" rowspan="2" style="vertical-align:bottom">Model <span class="muted small" style="font-weight:400">· users can pick</span></th>${groups.map((g) => `<th class="task-group" colspan="${g.ops.length}">${esc(TASK[g.task].label)}</th>`).join('')}</tr>
					<tr>${ops.map((op) => `<th class="op">${esc(op.label)}<span class="op-hint">${esc(op.hint)}</span></th>`).join('')}</tr>
				</thead>
				<tbody>
					<tr class="defaults"><th class="rowhead"><span class="tone-warn">★</span> Default for new chapters</th>${ops.map(defaultCell).join('')}</tr>
					${fams.map((f) => `<tr class="fam"><th class="rowhead" style="background:var(--canvas)">${esc(f)}</th><td colspan="${ops.length}"></td></tr>${rows.filter((m) => A.familyOf(m) === f).map((m) => `<tr style="${A.usable(m) ? '' : 'opacity:.55'}"><th class="rowhead"><div class="row" style="flex-wrap:nowrap">${V.sw(m.visible, `data-change="toggle-visible" data-id="${m.id}"`)}${V.dot(A.status(m))}<button class="btn link" data-action="open-model" data-id="${m.id}">${esc(m.name)}</button>${m.billed ? '<span class="chip warn" style="font-size:.62rem">billed</span>' : ''}</div></th>${ops.map((op) => cell(m, op)).join('')}</tr>`).join('')}`).join('')}
				</tbody>
			</table>
		</div>

		<div class="section">
			<div class="section-head"><h2>Other defaults</h2></div>
			<div class="card fields">
				<label class="field"><span>Text detector</span><select data-change="set-default" data-op="detect">${A.readyWithTask('detect').map((m) => `<option value="${m.id}" ${d().defaults.detect === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}<option>PaddleOCR lines (built in)</option><option>Heuristic bubbles (built in)</option></select></label>
				<label class="field"><span>Detection confidence</span><input type="number" step="0.05" value="0.20"></label>
				<label class="field"><span>Auto-clean fill method</span><select><option>lama-Manga</option><option>Big-LaMa</option><option>Flat fill</option><option>Telea</option></select></label>
				<label class="field"><span>Source language for new series</span><select><option>Japanese</option><option>Korean</option></select></label>
			</div>
			<div class="muted small" style="margin-top:.4rem">Chapters and series can still override every default in <em>AI model settings</em>.</div>
		</div>`;
	}

	// -------------------------------------------------------------- hardware
	function hardware() {
		const devices = ['gpu0', 'gpu1', 'cpu'].map((id) => {
			const u = A.deviceUse(id);
			return `<div class="card device">
				<div class="spread"><h3>${esc(u.dev.label)}</h3><span class="muted small">${esc(u.dev.name)}</span></div>
				${V.devBar(u, true)}
				<div class="small"><strong>${u.used.toFixed(1)}</strong> / ${u.dev.vramGb} GB used · ${u.free.toFixed(1)} GB free</div>
				<div class="stack" style="gap:.25rem">${u.parts.map((p) => `<div class="spread small"><span class="row"><i class="sw seg-${p.kind}" style="width:10px;height:10px;display:inline-block"></i>${p.id ? `<button class="btn link" style="font-size:.82rem" data-action="open-model" data-id="${p.id}">${esc(p.label)}</button>` : `<span class="muted">${esc(p.label)} · not managed</span>`}</span><span class="muted">${fmtGb(p.gb)}</span></div>`).join('') || '<span class="muted small">Nothing loaded.</span>'}</div>
			</div>`;
		}).join('');

		const svc = d().models.filter((m) => m.run && A.status(m).key !== 'missing' && A.status(m).key !== 'installing');
		const kinds = [
			['chat', 'Chat models', 'llama.cpp servers you configure. Start with the app, or load on demand.'],
			['review', 'OCR, vision & translator servers', 'Loopback services behind transcription, review and dedicated translation.'],
			['editor', 'Image editor', 'One editor at a time. It shares GPU 0 with the chat model, so loading one unloads the other.'],
		];
		const kindOf = (m) => A.cat(m)?.runtime || 'chat';
		const svcRow = (m) => {
			const s = m.run.state;
			return `<tr>
				<td><button class="btn link" data-action="open-model" data-id="${m.id}">${esc(m.name)}</button></td>
				<td class="muted">${DEV[A.deviceOf(m)].label}</td>
				<td class="muted">${m.launch?.port || A.cat(m)?.port || '—'}</td>
				<td class="muted">${fmtGb(A.memOf(m))}</td>
				<td>${V.statusHtml(m)}</td>
				<td>${V.sw(m.run.keepLoaded, `data-change="keep-loaded" data-id="${m.id}"`)}</td>
				<td><div class="row"><button class="btn ghost sm" data-action="start" data-id="${m.id}" ${s !== 'stopped' ? 'disabled' : ''}>Start</button><button class="btn ghost sm" data-action="stop" data-id="${m.id}" ${s !== 'running' ? 'disabled' : ''}>Stop</button><button class="btn ghost sm" data-action="restart" data-id="${m.id}" ${s !== 'running' ? 'disabled' : ''}>Restart</button></div></td>
			</tr>`;
		};

		return `
		<div class="page-head">
			<div><div class="kicker">Administration · Models</div><h1>Hardware & services</h1>
			<p>What is loaded where. Services not marked <em>keep loaded</em> start when a task needs them and unload after 5 idle minutes; when a GPU is full, Komatose asks before swapping something out.</p></div>
		</div>
		<div class="devices">${devices}</div>
		<div class="legend" style="margin-top:.5rem"><span><i class="sw seg-chat"></i> Chat</span><span><i class="sw seg-ocr"></i> OCR / vision / translators</span><span><i class="sw seg-edit"></i> Image editor</span><span><i class="sw seg-foreign"></i> Other programs</span></div>

		<div class="section">
			<div class="section-head"><h2>Services</h2></div>
			<div class="card" style="padding:0">
				<table class="mtable svc-table"><thead><tr><th>Service</th><th>Device</th><th>Port</th><th>Memory</th><th>Status</th><th>Keep loaded</th><th></th></tr></thead>
				<tbody>${kinds.map(([k, label, blurb]) => {
					const list = svc.filter((m) => kindOf(m) === k);
					return `<tr class="group"><td colspan="7"><b>${label}</b> <span style="text-transform:none;letter-spacing:0;font-family:var(--body)">· ${esc(blurb)}</span></td></tr>${list.length ? list.map(svcRow).join('') : `<tr><td colspan="7" class="muted small">None installed. <a href="#install">Install one →</a></td></tr>`}`;
				}).join('')}</tbody></table>
			</div>
		</div>

		<div class="section two-col">
			<div>
				<div class="section-head"><h2>Python environments</h2><span class="muted small">Installed automatically when a model needs one.</span></div>
				<div class="card" style="padding:0"><table class="mtable"><tbody>${M.ENVIRONMENTS.map((e) => {
					const st = d().envs[e.id];
					const users = M.CATALOG.filter((c) => c.requires?.includes(e.id) && A.model(c.id).install.state === 'installed').length;
					return `<tr><td><strong>${esc(e.label)}</strong><div class="muted small"><code>${esc(e.path)}</code> · ${fmtGb(e.diskGb)} · used by ${users} model${users === 1 ? '' : 's'}</div></td>
						<td>${st === 'installed' ? '<span class="status tone-ok"><span class="dot ok"></span>Installed</span>' : st === 'installing' ? '<span class="status tone-busy"><span class="dot busy"></span>Installing…</span>' : '<span class="status tone-idle"><span class="dot idle"></span>Not installed</span>'}</td>
						<td style="text-align:right">${st === 'installed' ? '<button class="btn ghost sm" data-action="toast" data-msg="Environment verified — 142 packages OK">Verify</button>' : st === 'missing' ? `<button class="btn ghost sm" data-action="install-env" data-id="${e.id}">Install</button>` : ''}</td></tr>`;
				}).join('')}</tbody></table></div>
			</div>
			<div>
				<div class="section-head"><h2>Move to another machine</h2></div>
				<div class="card">
					<p class="muted small">Export remote and CLI model entries plus saved profiles as a JSON pack. Keys, CLI paths and private-network URLs stay behind unless you include them.</p>
					<label class="switch" style="margin-bottom:.7rem"><input type="checkbox"><span class="track"></span>Include private network endpoints</label>
					<div class="row"><button class="btn sm" data-action="toast" data-msg="Exported komatose-models-2026-09-24.json · 7 models, 2 profiles">Export pack</button><button class="btn ghost sm" data-action="toast" data-msg="Pick a .json pack to preview what it adds">Import pack…</button></div>
				</div>
			</div>
		</div>`;
	}

	// --------------------------------------------------------------- welcome
	function welcome() {
		const w = S.ui.wiz;
		const steps = ['Translation', 'Reading pages', 'Cleaning', 'Review & install'];
		const hw = M.HARDWARE;
		const qwenFit = A.fit(CAT['qwen3.8-27b']);
		const clis = Object.entries(d().cli);
		const choice = (key, on, icon, title, text, extra = '') =>
			`<button class="choice ${on ? 'on' : ''}" data-action="wiz-toggle" data-key="${key}"><i class="bi ${icon}"></i><strong>${title}</strong><span class="muted">${text}</span>${extra}</button>`;
		let body = '';
		if (w.step === 0) {
			const p = M.REMOTE_PRESETS.find((r) => r.id === w.provider);
			body = `<h2>How should Komatose translate?</h2><p class="muted">Pick any combination — for example, local drafts with a CLI agent for review. Everything can be changed later.</p>
				<div class="choice-grid">
					${choice('local', w.translate.has('local'), 'bi-gpu-card', 'On this machine', `Qwen 3.8 27B · 13 GB download`, `<span class="chip ${qwenFit.tone}" style="justify-self:start">${esc(qwenFit.text)}</span>`)}
					${choice('remote', w.translate.has('remote'), 'bi-cloud', 'Remote API', 'OpenAI, OpenRouter, DeepSeek or any OpenAI-compatible endpoint. Billed per call.')}
					${choice('cli', w.translate.has('cli'), 'bi-terminal', 'CLI agent', clis.map(([id, t]) => `${M.CLI_DEFS[id].label} ${t.found ? '✓' : '✗'}`).join(' · '))}
					${choice('later', w.translate.has('later'), 'bi-clock', 'Decide later', 'Set up reading and cleaning now; add a translator from Models.')}
				</div>
				${w.translate.has('remote') ? `<div class="card" style="margin-top:.8rem"><div class="fields"><label class="field"><span>Provider</span><select data-change="wiz-provider">${M.REMOTE_PRESETS.map((r) => `<option value="${r.id}" ${r.id === w.provider ? 'selected' : ''}>${r.name}</option>`).join('')}</select></label><label class="field"><span>API key variable</span><input type="text" value="${esc(p.keyVar)}"></label></div>
					<div class="small" style="margin-top:.5rem">${A.keySet(p.keyVar) ? `<span class="tone-ok">✓ ${esc(p.keyVar)} is set in .env</span>` : `<span class="tone-warn">${esc(p.keyVar)} isn’t in .env yet.</span> <span class="muted">Add it on the server — Komatose never stores the key itself. You can finish setup first.</span>`}</div></div>` : ''}
				${w.translate.has('cli') ? `<div class="card" style="margin-top:.8rem"><div class="muted small">Models from CLIs found on this server:</div><div class="pick-list">${clis.filter(([, t]) => t.found).flatMap(([id]) => M.CLI_DEFS[id].catalog.map(([slug, label]) => `<label class="pick"><input type="checkbox" data-change="wiz-cli" data-key="${id}:${slug}" ${w.cliPicks.has(`${id}:${slug}`) ? 'checked' : ''}><span class="grow">${esc(label)} <code>${esc(slug)}</code></span><span class="muted small">${M.CLI_DEFS[id].label}</span></label>`)).join('') || '<span class="muted small">No CLI found. Install one and sign in as the server account.</span>'}</div></div>` : ''}`;
		} else if (w.step === 1) {
			const opt = (id) => {
				const c = CAT[id];
				const have = A.model(id).install.state === 'installed';
				return `<label class="pick"><input type="checkbox" data-change="wiz-read" data-key="${id}" ${have || w.read.has(id) ? 'checked' : ''} ${have ? 'disabled' : ''}><span class="grow"><strong>${esc(c.name)}</strong> <span class="muted small">— ${esc(c.sum)}</span></span>${have ? '<span class="chip ok">installed</span>' : `<span class="muted small">${fmtGb(c.diskGb)}</span>`}</label>`;
			};
			body = `<h2>Reading pages</h2><p class="muted">Detection finds lettering; the OCR council reads it twice and flags disagreements. The recommended set runs on the CPU.</p>
				<div class="kicker" style="margin-top:1rem">Recommended</div><div class="pick-list" style="max-height:none">${['rtdetr', 'ctd', 'hayai-ocr-v2', 'paddleocr-vl-1.6'].map(opt).join('')}</div>
				<div class="kicker" style="margin-top:1rem">Optional</div><div class="pick-list" style="max-height:none">${['manga-ocr', 'koharu', 'coo', 'qwen3-vl-8b', 'hy-mt2-manga-v5', 'imsbee-ko-en'].map(opt).join('')}</div>`;
		} else if (w.step === 2) {
			const codex = d().cli.codex.found;
			const cChoice = (key, icon, title, text, extra = '') => `<button class="choice ${w.clean === key ? 'on' : ''}" data-action="wiz-clean" data-key="${key}"><i class="bi ${icon}"></i><strong>${title}</strong><span class="muted">${text}</span>${extra}</button>`;
			const qi = A.fit(CAT['qwen-image-2.1']);
			body = `<h2>Cleaning</h2><p class="muted">Masks come from the Comic Text Detector. Choose how Komatose fills the art underneath.</p>
				<div class="choice-grid">
					${cChoice('fill', 'bi-paint-bucket', 'Fill only', 'lama-Manga inpainting · 206 MB. Great on balloons and flat art.')}
					${cChoice('local', 'bi-magic', 'Redraw locally', 'Qwen-Image 2.1 · 8.4 GB, plus lama-Manga for balloons.', `<span class="chip ${qi.tone}" style="justify-self:start">${esc(qi.text)}</span>`)}
					${cChoice('codex', 'bi-terminal', 'Redraw with Codex', codex ? 'Codex CLI is on this server. Billed per page, nothing large to download.' : 'Codex CLI isn’t installed on this server.')}
					${cChoice('later', 'bi-clock', 'Decide later', 'Built-in flat fill and Telea still work.')}
				</div>`;
		} else {
			const { ids, rows } = wizardPlan();
			const plan = A.planFor(ids);
			const total = plan.reduce((a, p) => a + p.diskGb, 0);
			body = `<h2>Review & install</h2><p class="muted">Installs run one at a time in the background; you can leave this page. Every step’s command is listed.</p>
				${plan.length ? `<div class="plan">${plan.map((p) => `<div class="plan-item ${p.dep ? 'dep' : ''}"><i class="bi ${p.kind === 'env' ? 'bi-box-seam' : 'bi-download'} tone-ok"></i><div><strong>${esc(p.label)}</strong>${p.dep ? `<span class="muted small"> · needed by ${esc(p.forName)}</span>` : ''}</div><span class="muted small">${fmtGb(p.diskGb)}</span><span></span></div>`).join('')}</div>` : '<div class="card muted">Nothing to download.</div>'}
				${rows.length ? `<div class="kicker" style="margin-top:1rem">Model entries added</div><div class="plan">${rows.map((r) => `<div class="plan-item"><i class="bi ${r.icon} tone-ok"></i><div><strong>${esc(r.name)}</strong> <span class="muted small">· ${esc(r.detail)}</span></div><span class="chip ok">visible to users</span><span></span></div>`).join('')}</div>` : ''}
				<div class="card" style="margin-top:1rem"><div class="spread"><span><strong>${fmtGb(total)}</strong> to download · ${hw.disk.freeGb} GB free on ${esc(hw.disk.path)}</span><span class="muted small">Default translator: ${esc(w.translate.has('local') ? 'Qwen 3.8 27B' : rows[0]?.name || 'none yet')}</span></div>
				<details style="margin-top:.6rem"><summary class="muted small">Show commands</summary><code class="cmd" style="margin-top:.4rem">${esc(plan.map((p) => p.cmd).join('\n'))}</code></details></div>`;
		}
		return `<div class="wizard">
			<div class="kicker">Guided setup</div><h1>Set up Komatose on this machine</h1>
			<div class="hw-strip" style="margin-top:.8rem"><span><i class="bi bi-gpu-card"></i> ${hw.devices.filter((x) => x.id !== 'cpu').map((x) => `<b>${x.label}</b> ${x.name} · ${x.vramGb} GB`).join(' &nbsp; ')}</span><span><i class="bi bi-memory"></i> <b>${hw.ramGb} GB</b> RAM</span><span><i class="bi bi-hdd"></i> <b>${hw.disk.freeGb} GB</b> free</span></div>
			<div class="steps">${steps.map((s, i) => `<div class="st ${i === w.step ? 'on' : i < w.step ? 'done' : ''}">${i + 1}. ${s}</div>`).join('')}</div>
			${body}
			<div class="wiz-nav">
				${w.step ? '<button class="btn ghost" data-action="wiz-back"><i class="bi bi-arrow-left"></i> Back</button>' : '<a class="btn ghost" href="#overview">Skip setup</a>'}
				${w.step < 3 ? '<button class="btn solid" data-action="wiz-next">Next <i class="bi bi-arrow-right"></i></button>' : '<button class="btn solid" data-action="wiz-finish"><i class="bi bi-download"></i> Install & finish</button>'}
			</div>
		</div>`;
	}

	function wizardPlan() {
		const w = S.ui.wiz;
		const ids = [];
		const rows = [];
		if (w.translate.has('local')) ids.push('qwen3.8-27b');
		ids.push(...w.read);
		if (w.clean === 'fill' || w.clean === 'local' || w.clean === 'codex') ids.push('lama-manga');
		if (w.clean === 'local') ids.push('qwen-image-2.1');
		if (w.translate.has('remote')) {
			const p = M.REMOTE_PRESETS.find((r) => r.id === w.provider);
			rows.push({ kind: 'remote', icon: 'bi-cloud', name: `${p.name} · ${p.models[0]}`, detail: `${p.baseUrl} · ${p.keyVar}`, preset: p });
		}
		if (w.translate.has('cli') || w.clean === 'codex') {
			const picks = new Set(w.translate.has('cli') ? w.cliPicks : []);
			if (w.clean === 'codex' && ![...picks].some((k) => k.startsWith('codex:'))) picks.add('codex:gpt-5.4');
			for (const key of picks) {
				const [adapter, slug] = key.split(':');
				if (A.model(`${adapter}-${slug}`)) continue;
				rows.push({ kind: 'cli', icon: 'bi-terminal', name: M.CLI_DEFS[adapter].catalog.find(([s]) => s === slug)?.[1] || slug, detail: M.CLI_DEFS[adapter].label, adapter, slug });
			}
		}
		return { ids: ids.filter((id) => A.model(id)?.install?.state !== 'installed'), rows };
	}

	// ----------------------------------------------------------------- notes
	function notes() {
		return `<div class="notes">
		<div class="kicker">Mockup</div><h1>Design notes</h1>
		<p class="muted">Why the admin model pages are being reorganised, and how the pages in this mockup replace <code>/admin/setup</code> and <code>/admin/settings</code>.</p>

		<h2>What’s wrong today</h2>
		<div class="problem"><strong>One model is spread across both pages.</strong> Hayai OCR, for example, has an install row at the bottom of Setup → Local, an entry in the Status service list, Start/Stop in the “Local OCR / review servers” box, a Status “optional local model” entry, and a card on Settings for visibility, tasks and Test. Setup and Settings link to each other constantly.</div>
		<div class="problem"><strong>Split by transport, not by job.</strong> Setup’s tabs are Local / Remote / CLI. An admin wants to know “can I transcribe?”, but Task coverage only checks Translation and Transcription. Detection, masks, cleaning, review and proofread have no readiness at all.</div>
		<div class="problem"><strong>The Status counts mean nothing.</strong> “12 configured · 9 missing · 2 unavailable” mixes required gaps with optional models the admin never wanted. Optional models look like failures.</div>
		<div class="problem"><strong>Settings is a wall of internal names.</strong> Every card has 9 checkboxes (<code>chapterReview</code>, <code>compactNotes</code>, <code>pageImageProofread</code>…) and a Test button per operation. You can’t answer “which models can proofread?” without reading every card. It also lists seeded models that aren’t installed, with no sign of that.</div>
		<div class="problem"><strong>Adding a CLI model takes two pages.</strong> Added rows start hidden in Setup; you then find them in Settings and click Show in pickers. The same goes for any model you’ve just set up.</div>
		<div class="problem"><strong>Dependencies block instead of resolving.</strong> Installing Koharu when <code>.venv-workflow</code> is missing shows a lock chip. The admin has to work out that another row installs the environment first.</div>
		<div class="problem"><strong>Defaults are hard-coded.</strong> Qwen 27B for translation and Composer for review are baked in. When they aren’t ready, Status explains the fallback in prose instead of letting you choose.</div>
		<div class="problem"><strong>GPU sharing is invisible.</strong> The chat model and image editor share GPU 0, and loading one unloads the other. That’s explained in a paragraph inside the image-editor box, and there’s no view of what’s loaded where.</div>
		<div class="problem"><strong>Mixed visual languages and repeated blocks.</strong> The review-server, image-editor and benchmark components use rounded cards and an undefined <code>--hud-border</code>; the rest is square HUD. The error alert renders twice, and the Transfer panel and Benchmark are tacked onto the bottoms of the pages.</div>

		<h2>The proposal</h2>
		<div class="problem fix"><strong>One “Models” area with five pages and a shared model drawer.</strong> Every model opens the same drawer from any page: status and the fix, who can pick it, jobs it may run with test results, setup (install, launch recipe, endpoint and key variable, or CLI path), runtime controls, and remove. Nothing about a model lives anywhere else.</div>
		<div class="problem fix"><strong>Organise around jobs.</strong> The Overview shows eight jobs across the Translate / Review / Clean stages. Each has a status, the default model, and the single most useful fix (“Install Qwen-Image 2.1 · 8.4 GB”). Optional jobs say “Not set up”, not “missing”.</div>
		<div class="problem fix"><strong>“Needs attention” lists only broken things,</strong> one row per cause: a missing key covering three remote models is one row, and so is a CLI with a bad saved path.</div>
		<div class="problem fix"><strong>Install behaves like a package manager:</strong> bundles, multi-select, dependencies added automatically, a disk budget, a background queue with logs and cancel, and “fits GPU 0” hints from real memory figures.</div>
		<div class="problem fix"><strong>Jobs & defaults is one grid</strong> of models × jobs, with test results in the cells and a Default row. App-wide defaults become a setting, not code.</div>
		<div class="problem fix"><strong>Hardware & services shows VRAM per device,</strong> every service in one table, “keep loaded” pins, and a confirmation when a start would swap something out.</div>
		<div class="problem fix"><strong>Guided setup for fresh installs:</strong> four steps with hardware-aware suggestions. It replaces reading FRESH_INSTALL.md.</div>

		<h2>Where things moved</h2>
		<table>
			<tr><th>Today</th><th>In the mockup</th></tr>
			<tr><td>Setup → Status panel (counts, services, task coverage, next steps)</td><td>Overview: job cards, Needs attention, Running now</td></tr>
			<tr><td>Setup → Local → configs, llama-swap list, add form, presets</td><td>Models (Local filter) + Add model → Local server; launch settings in the drawer</td></tr>
			<tr><td>Setup → Local → OCR / review servers, image editor</td><td>Hardware & services; per-model Runtime section in the drawer</td></tr>
			<tr><td>Setup → Local → Install models on this machine</td><td>Install (bundles, multi-select, queue); Not installed filter on Models</td></tr>
			<tr><td>Setup → Remote tab</td><td>Models (Remote filter) + Add model → Remote API (fetches the model list, adds several at once)</td></tr>
			<tr><td>Setup → CLI tab (tree, saved location, add / add all)</td><td>Models (CLI filter) + Add model → CLI agent; path fix from Needs attention or the drawer</td></tr>
			<tr><td>Setup → Transfer named models</td><td>Hardware & services → Move to another machine (also Models → Import / export)</td></tr>
			<tr><td>Settings → per-card operation checkboxes</td><td>Jobs & defaults grid; per-model Jobs section in the drawer</td></tr>
			<tr><td>Settings → Test buttons, last probe</td><td>Test results in grid cells and the drawer; “Test N untested”</td></tr>
			<tr><td>Settings → Show/Hide in pickers (page, group, card)</td><td>“Users can pick” switch on every row; bulk select on Models</td></tr>
			<tr><td>Settings → Page benchmark</td><td>Jobs & defaults → Compare on a page</td></tr>
			<tr><td>Hard-coded defaults (Qwen 27B, Composer)</td><td>Default row in Jobs & defaults</td></tr>
		</table>

		<h2>What it would take</h2>
		<ul>
			<li><strong>Mostly a UI reshuffle.</strong> <code>setupReport</code>, <code>installCatalog</code>, <code>modelRegistryStore</code>, probes, and managed / review / image-model status already provide almost every field shown here.</li>
			<li><strong>New backend pieces:</strong>
				<ul>
					<li>coverage for all eight jobs (extend <code>buildSetupReport</code>)</li>
					<li>an install queue that expands <code>requires</code> into ordered steps (today <code>startInstall</code> runs one target and blocks on missing environments)</li>
					<li>stored app-wide per-operation defaults read by <code>hydrateTaskEngine</code></li>
					<li>a small device endpoint that joins managed-model, review-server and image-editor status with VRAM figures</li>
				</ul>
			</li>
			<li><strong>“Added rows start hidden” flips to “visible by default, with a switch in the add dialog”.</strong> This removes the two-page trip.</li>
			<li><strong>Suggested order:</strong>
				<ol>
					<li>shared drawer + Models list (replaces both pages’ card grids)</li>
					<li>Overview</li>
					<li>Jobs & defaults grid</li>
					<li>Install queue with dependencies</li>
					<li>Hardware</li>
					<li>Guided setup</li>
				</ol>
			</li>
		</ul>
		</div>`;
	}

	return { install, access, hardware, welcome, notes, wizardPlan, queueItemHtml };
})();
