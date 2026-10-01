/* Dialogs: install plan, GPU conflict, fixes, add model, council, benchmark. */
window.MODALS = (() => {
	const A = window.APP;
	const V = window.VIEWS;
	const { M, S, esc, fmtGb, CAT, DEV, OP } = A;
	const d = () => S.data;

	const wrap = (inner, wide = false) =>
		`<div class="modal-wrap" data-action="backdrop"><div class="modal ${wide ? 'wide' : ''}" role="dialog">${inner}</div></div>`;
	const actions = (...btns) => `<div class="modal-actions">${btns.join('')}</div>`;
	const cancel = (label = 'Cancel') => `<button class="btn ghost" data-action="close-modal">${label}</button>`;

	function install(m) {
		const plan = m.plan;
		const total = plan.reduce((a, p) => a + p.diskGb, 0);
		const models = plan.filter((p) => p.kind === 'model').map((p) => CAT[p.id]);
		const title = plan.length === 1 ? plan[0].label : `${models.length} model${models.length === 1 ? '' : 's'}${plan.length > models.length ? ` + ${plan.length - models.length} environment${plan.length - models.length === 1 ? '' : 's'}` : ''}`;
		return wrap(`
			<div class="kicker">Install on this machine</div>
			<h3>${esc(title)}</h3>
			<div class="plan">${plan.map((p, i) => {
				const f = p.kind === 'model' ? A.fit(CAT[p.id]) : null;
				return `<div class="plan-item ${p.dep ? 'dep' : ''}"><span class="muted small">${i + 1}</span><div><strong>${esc(p.label)}</strong>${p.dep ? `<div class="muted small">Needed by ${esc(p.forName)} — added automatically</div>` : `<div class="muted small">${esc(CAT[p.id].sum)}</div>`}</div>${f ? `<span class="chip ${f.tone}">${esc(f.text)}</span>` : '<span></span>'}<span class="small">${fmtGb(p.diskGb)}</span></div>`;
			}).join('')}</div>
			<div class="spread" style="margin-top:.7rem"><span><strong>${fmtGb(total)}</strong> download · ${M.HARDWARE.disk.freeGb} GB free</span><span class="muted small">Runs in the background, one step at a time.</span></div>
			<details style="margin-top:.7rem" ${plan.length === 1 ? 'open' : ''}><summary class="muted small">Commands Komatose will run</summary><code class="cmd" style="margin-top:.4rem">${esc(plan.map((p) => p.cmd).join('\n'))}</code></details>
			<p class="muted small" style="margin-top:.7rem">Only these whitelisted commands run, from the repository root. Downloads are pinned to a revision and checksum-verified.</p>
			${actions(cancel(), `<button class="btn solid" data-action="confirm-install"><i class="bi bi-download"></i> Install</button>`)}`);
	}

	function conflict(m) {
		const target = A.model(m.id);
		const dev = DEV[A.deviceOf(target)];
		const use = A.deviceUse(dev.id, { exclude: target });
		const clash = m.clash.map(A.model);
		return wrap(`
			<div class="kicker">${esc(dev.label)} is full</div>
			<h3>Start ${esc(target.name)}?</h3>
			<p>${esc(target.name)} needs <strong>${fmtGb(A.memOf(target))}</strong>, and ${esc(dev.label)} has <strong>${use.free.toFixed(1)} GB</strong> free. Starting it unloads:</p>
			<div class="plan">${clash.map((x) => `<div class="plan-item"><span class="dot ok"></span><div><strong>${esc(x.name)}</strong>${x.run.keepLoaded ? '<div class="small tone-warn">Marked “keep loaded”</div>' : ''}</div><span class="small">${fmtGb(A.memOf(x))}</span><span></span></div>`).join('')}</div>
			<div class="small muted" style="margin-top:.8rem">${esc(dev.label)} after the swap</div>
			<div style="margin-top:.3rem">${V.devBar(A.deviceUse(dev.id, { exclude: target, excludeIds: m.clash, extra: { label: target.name, gb: A.memOf(target), kind: 'edit' } }), true)}</div>
			<p class="muted small" style="margin-top:.6rem">They reload by themselves the next time a task needs them. Running jobs on them finish first.</p>
			${actions(cancel(), `<button class="btn solid" data-action="conflict-go" data-id="${target.id}">Unload & start</button>`)}`);
	}

	function fixKey(m) {
		const model = A.model(m.id);
		const key = model.endpoint.keyVar;
		const affected = d().models.filter((x) => x.source === 'remote' && x.endpoint.keyVar === key);
		return wrap(`
			<div class="kicker">API key</div><h3>Set ${esc(key)}</h3>
			<p>${affected.map((x) => esc(x.name)).join(', ')} ${affected.length === 1 ? 'uses' : 'use'} this variable.</p>
			<ol style="padding-left:1.1rem">
				<li>On the server, open <code>./.env</code>.</li>
				<li>Add a line: <code class="cmd" style="margin:.35rem 0">${esc(key)}=sk-…</code></li>
				<li>Click <strong>Recheck</strong>. No restart is needed.</li>
			</ol>
			<p class="muted small">Komatose stores the variable <em>name</em> only. The key never enters the database, logs or model packs.</p>
			${actions(`<button class="btn ghost" data-action="hide-key-models" data-id="${model.id}">Hide these models instead</button>`, cancel('Close'), `<button class="btn solid" data-action="recheck-key" data-id="${model.id}"><i class="bi bi-arrow-repeat"></i> Recheck</button>`)}`);
	}

	function fixCli(m) {
		const def = M.CLI_DEFS[m.adapter];
		const t = d().cli[m.adapter];
		return wrap(`
			<div class="kicker">Command-line agent</div><h3>Where is ${esc(def.label)}?</h3>
			<p class="muted">${esc(t.message || `${def.label} was found at ${t.path}.`)}</p>
			<label class="field"><span>Executable</span><input type="text" data-input="cli-path" value="${esc(m.path)}" placeholder="path or command name"></label>
			<p class="muted small" style="margin-top:.5rem">Automatic discovery checks <code>PATH</code>, <code>~/.local/bin</code> and the usual install folders. <code>${esc(def.envVar)}</code> in .env overrides this. Finding the binary isn’t proof of sign-in — sign in as the server account.</p>
			${actions(t.source === 'saved' ? `<button class="btn ghost" data-action="clear-cli" data-adapter="${m.adapter}">Use automatic discovery</button>` : '', cancel(), `<button class="btn solid" data-action="check-cli" data-adapter="${m.adapter}">Save & check</button>`)}`);
	}

	function fixService(m) {
		const svc = A.model(m.id);
		return wrap(`
			<div class="kicker">Optional service</div><h3>Page-image proofreading</h3>
			<p>Runs a separate proofreading service you host yourself. It keeps a conversation per proofreader, so later pages reuse context.</p>
			<ol style="padding-left:1.1rem"><li>Start the service (see <code>docs/PROOFREADING_SERVICE.md</code>).</li><li>Add <code>${esc(svc.service.envVar)}=http://host:port</code> to <code>.env</code>.</li><li>Click <strong>Recheck</strong>.</li></ol>
			${actions(cancel('Not now'), `<button class="btn solid" data-action="recheck-service" data-id="${svc.id}">Recheck</button>`)}`);
	}

	function remove(m) {
		const model = A.model(m.id);
		const c = A.cat(model);
		const defaults = Object.entries(d().defaults).filter(([, v]) => v === model.id || (Array.isArray(v) && v.includes(model.id))).map(([k]) => OP[k]?.label || k);
		return wrap(`
			<div class="kicker">${c ? 'Uninstall' : 'Remove'}</div><h3>${c ? 'Uninstall' : 'Remove'} ${esc(model.name)}?</h3>
			<p>${c ? `Deletes ${fmtGb(c.diskGb)} from <code>data/models/${esc(c.id)}/</code>. Its settings are kept, so reinstalling restores them.` : 'Removes this entry. Keys and CLI programs on the server are untouched.'}</p>
			${defaults.length ? `<div class="fix-box">It is the default for <strong>${esc(defaults.join(', '))}</strong>. Those jobs fall back to the next ready model.</div>` : ''}
			${actions(cancel(), `<button class="btn danger" data-action="confirm-remove" data-id="${model.id}">${c ? 'Uninstall' : 'Remove'}</button>`)}`);
	}

	function log(m) {
		const model = A.model(m.id);
		const c = A.cat(model);
		const failed = model.install?.state === 'failed';
		const text = failed
			? `$ .venv-review/bin/python scripts/install-model.py ${c.id} --repo ${c.repo} --file ${c.file} --verify-sha256\nFetching ${c.repo}\nDownloading ${c.file}  12%\nRetrying in 4s (attempt 2/3)…\nDownloading ${c.file}  12%\nRetrying in 8s (attempt 3/3)…\n${model.install.error}\nexit 1`
			: `$ scripts/install-model.py ${c.id} --repo ${c.repo} --file ${c.file} --verify-sha256\nFetching ${c.repo}\nDownloading ${c.file}  100%  ${fmtGb(c.diskGb)}\nVerifying sha256… OK\nRegistered ${c.id} in models.json\n✓ Installed · 2026-09-12 14:02`;
		return wrap(`<div class="kicker">Install log</div><h3>${esc(model.name)}</h3><pre class="log" style="max-height:340px">${esc(text)}</pre>
			${actions(cancel('Close'), failed ? `<button class="btn solid" data-action="install" data-id="${model.id}">Retry install</button>` : '')}`);
	}

	function council(m) {
		const vision = d().models.filter((x) => A.usable(x) && x.ops.includes('vision'));
		return wrap(`
			<div class="kicker">Transcribe</div><h3>Transcription council</h3>
			<p class="muted">Every region is read by each member. Matching readings fill the source; disagreements are kept as suggestions for AI review. Two fast OCR models is the sweet spot.</p>
			<div class="pick-list">${vision.map((x) => `<label class="pick"><input type="checkbox" data-change="mpick" data-key="${x.id}" ${m.picks.has(x.id) ? 'checked' : ''}><span class="grow"><strong>${esc(x.name)}</strong> <span class="muted small">${esc(A.sourceOf(x).label)}</span></span>${x.billed ? '<span class="chip warn">billed</span>' : ''}${x.tests.vision?.ok === false ? '<span class="chip bad">image test failed</span>' : ''}</label>`).join('')}</div>
			${m.picks.size === 1 ? '<div class="fix-box" style="margin-top:.6rem">With one member, disagreements can’t be caught.</div>' : ''}
			${actions(cancel(), `<button class="btn solid" data-action="save-council" ${m.picks.size ? '' : 'disabled'}>Save</button>`)}`);
	}

	function bench(m) {
		const candidates = d().models.filter((x) => A.usable(x) && x.visible && (x.ops.includes('vision') || x.ops.includes('translate')));
		const score = (id, salt) => 55 + (A.hash(id + salt) % 44);
		const results = m.state === 'done'
			? [...m.picks].map(A.model).map((x) => ({ x, ms: (x.source === 'cli' ? 9000 : x.source === 'remote' ? 4000 : 2500) + (A.hash(x.id) % 6000), src: x.ops.includes('vision') ? score(x.id, 's') : null, en: x.ops.includes('translate') ? score(x.id, 'e') : null }))
			: [];
		return wrap(`
			<div class="kicker">Compare on a page</div><h3>Page benchmark</h3>
			<p class="muted small">Runs detection and reading on fixture <code>001-raw.png</code> (Takumi p.1), then scores expected Japanese lines and English concepts. OCR models only see crops; CLI and remote models get one full-page call.</p>
			<div class="pick-list">${candidates.map((x) => `<label class="pick"><input type="checkbox" data-change="mpick" data-key="${x.id}" ${m.picks.has(x.id) ? 'checked' : ''} ${m.state === 'running' ? 'disabled' : ''}><span class="grow">${esc(x.name)}</span>${x.billed ? '<span class="chip warn">billed</span>' : '<span class="chip muted">local</span>'}</label>`).join('')}</div>
			${m.state === 'running' ? '<div style="margin-top:.8rem"><div class="progress"><span style="width:60%;transition:width 2s"></span></div><div class="muted small" style="margin-top:.3rem">Running…</div></div>' : ''}
			${results.length ? `<table class="mtable" style="margin-top:.8rem"><thead><tr><th>Model</th><th>Time</th><th>Source lines</th><th>English</th></tr></thead><tbody>${results.map((r) => `<tr><td>${esc(r.x.name)}</td><td>${V.secs(r.ms)}</td><td>${r.src == null ? '<span class="muted">—</span>' : `${r.src}%`}</td><td>${r.en == null ? '<span class="muted">OCR only</span>' : `${r.en}%`}</td></tr>`).join('')}</tbody></table>` : ''}
			${actions(cancel('Close'), `<button class="btn solid" data-action="run-bench" ${m.picks.size && m.state !== 'running' ? '' : 'disabled'}>Run ${m.picks.size || ''}</button>`)}`, true);
	}

	function testUntested(m) {
		const billed = m.items.filter((x) => x.m.billed).length;
		return wrap(`
			<div class="kicker">Test</div><h3>Run ${m.items.length} tests?</h3>
			<p>Each test runs the real production path once with a short sample.</p>
			${billed ? `<div class="fix-box"><strong>${billed} of them are billed</strong> — remote and CLI models make a real call.</div>` : ''}
			<div class="pick-list">${m.items.map((x) => `<div class="pick"><span class="grow">${esc(x.m.name)}</span><span class="muted small">${esc(OP[x.op].label)}</span>${x.m.billed ? '<span class="chip warn">billed</span>' : ''}</div>`).join('')}</div>
			${actions(cancel(), `<button class="btn solid" data-action="confirm-test-untested">Run tests</button>`)}`);
	}

	// ------------------------------------------------------------- add model
	function addModel(m) {
		const tabs = [['choose', 'Start'], ['local', 'Local server'], ['remote', 'Remote API'], ['cli', 'CLI agent']];
		const head = `<div class="kicker">Add model</div><div class="seg" style="margin:.4rem 0 1rem">${tabs.map(([id, label]) => `<button class="${m.step === id ? 'on' : ''}" data-action="add-step" data-step="${id}">${label}</button>`).join('')}</div>`;
		let body = '';
		if (m.step === 'choose') {
			const c = (step, icon, title, text) => `<button class="choice" data-action="add-step" data-step="${step}"><i class="bi ${icon}"></i><strong>${title}</strong><span class="muted">${text}</span></button>`;
			body = `<h3>What are you adding?</h3><div class="choice-grid">
				${c('install', 'bi-download', 'Install a model', 'Detectors, OCR, translators, editors and the default chat model — downloaded and set up for you.')}
				${c('local', 'bi-cpu', 'Local model server', 'Run a GGUF with llama.cpp using a launch preset, or point at a server you already run.')}
				${c('remote', 'bi-cloud', 'Remote API', 'OpenAI, OpenRouter, DeepSeek or any OpenAI-compatible endpoint. Pick several models at once.')}
				${c('cli', 'bi-terminal', 'CLI agent', 'Codex, Cursor or Grok installed on this server. Pick the models it offers.')}
			</div>`;
		} else if (m.step === 'local') {
			const p = M.CHAT_PRESETS.find((x) => x.id === m.preset);
			const catModel = p.catalog ? A.model(p.catalog) : null;
			const needsInstall = catModel && catModel.install.state !== 'installed' && !A.queueItem(catModel.id);
			const alreadyHere = catModel && catModel.install.state === 'installed';
			const dev = m.form.device || 'gpu0';
			const f = p.memGb ? A.fit({ id: '_new', device: dev, memGb: p.memGb }) : null;
			body = `<h3>Local model server</h3>
				<div class="pick-list" style="max-height:none">${M.CHAT_PRESETS.map((x) => `<label class="pick" data-action="add-preset" data-id="${x.id}"><input type="radio" name="preset" ${x.id === m.preset ? 'checked' : ''}><span class="grow"><strong>${esc(x.name)}</strong> <span class="muted small">— ${esc(x.note)}</span></span>${x.memGb ? `<span class="muted small">${x.memGb} GB</span>` : ''}</label>`).join('')}</div>
				${alreadyHere ? `<div class="fix-box ok" style="margin-top:.8rem">${esc(catModel.name)} is already set up on this machine. <button class="btn link" data-action="open-model" data-id="${catModel.id}">Open it →</button></div>` : ''}
				${needsInstall ? `<div class="fix-box" style="margin-top:.8rem"><strong>The weights aren’t on this machine yet.</strong> Install them (${fmtGb(CAT[p.catalog].diskGb)}) and Komatose adds this model with the ${esc(p.name)} launch preset when the download finishes.</div>` : ''}
				${!alreadyHere && !needsInstall ? `<div class="fields" style="margin-top:.8rem">
					<label class="field"><span>Name</span><input type="text" data-input="mform" data-field="name" value="${esc(m.form.name || p.name)}"></label>
					<label class="field"><span>Model id</span><input type="text" data-input="mform" data-field="slug" value="${esc(m.form.slug ?? p.slug)}"></label>
					${m.preset === 'external'
						? `<label class="field"><span>Base URL</span><input type="text" data-input="mform" data-field="baseUrl" value="${esc(m.form.baseUrl || 'http://127.0.0.1:8081/v1')}"></label><label class="field"><span>API key variable (optional)</span><input type="text" data-input="mform" data-field="keyVar" value="${esc(m.form.keyVar || 'LLAMASWAP_API_KEY')}"></label>`
						: `<label class="field"><span>Weights (.gguf)</span><input type="text" data-input="mform" data-field="weights" value="${esc(m.form.weights ?? p.weights)}" placeholder="~/models/model.gguf"></label>
						<label class="field"><span>Device</span><select data-change="mdevice">${['gpu0', 'gpu1', 'cpu'].map((x) => `<option value="${x}" ${x === dev ? 'selected' : ''}>${DEV[x].label} · ${DEV[x].name}</option>`).join('')}</select></label>
						<label class="field"><span>Port</span><input type="number" value="18081"><span class="muted" style="text-transform:none;letter-spacing:0">Next free port — picked for you.</span></label>
						<label class="field"><span>Context size</span><input type="number" value="32768"></label>`}
				</div>
				${f ? `<div class="chips" style="margin-top:.6rem"><span class="chip ${f.tone}"><i class="bi bi-memory"></i> ${esc(f.text)}</span></div>` : ''}` : ''}`;
			const primary = alreadyHere
				? ''
				: needsInstall
					? `<button class="btn solid" data-action="add-local-install">Install weights · ${fmtGb(CAT[p.catalog].diskGb)}</button>`
					: `<button class="btn solid" data-action="add-local-submit">${m.preset === 'external' ? 'Add' : 'Add & start'}</button>`;
			return wrap(head + body + visibleRow(m) + actions(cancel(), primary));
		} else if (m.step === 'remote') {
			const p = M.REMOTE_PRESETS.find((x) => x.id === m.provider);
			const keyVar = m.form.keyVar ?? p.keyVar;
			const set = A.keySet(keyVar);
			body = `<h3>Remote API</h3>
				<div class="seg" style="margin-bottom:.8rem">${M.REMOTE_PRESETS.map((x) => `<button class="${x.id === m.provider ? 'on' : ''}" data-action="add-provider" data-id="${x.id}">${x.name}</button>`).join('')}</div>
				<div class="fields">
					<label class="field"><span>Base URL</span><input type="text" data-input="mform" data-field="baseUrl" value="${esc(m.form.baseUrl ?? p.baseUrl)}" placeholder="https://host/v1"></label>
					<label class="field"><span>API key variable</span><input type="text" data-input="mform" data-field="keyVar" value="${esc(keyVar)}"></label>
				</div>
				<div class="small" style="margin-top:.5rem">${set ? `<span class="tone-ok">✓ ${esc(keyVar)} is set in .env</span>` : `<span class="tone-warn">${esc(keyVar)} isn’t in .env.</span> <span class="muted">You can add models now; they’ll show “key not set” until it is.</span>`}</div>
				<div class="spread" style="margin-top:1rem"><strong>Models</strong><button class="btn ghost sm" data-action="add-fetch" ${set ? '' : 'disabled title="Needs the key to list models"'}><i class="bi bi-arrow-repeat"></i> Fetch model list</button></div>
				${m.fetched && set
					? `<div class="pick-list">${p.models.map((slug) => { const exists = d().models.some((x) => x.source === 'remote' && x.slug === slug && x.endpoint.baseUrl === p.baseUrl); return `<label class="pick"><input type="checkbox" data-change="mpick" data-key="${slug}" ${exists ? 'checked disabled' : m.picks.has(slug) ? 'checked' : ''}><span class="grow"><code>${esc(slug)}</code></span>${exists ? '<span class="chip ok">added</span>' : ''}</label>`; }).join('')}</div>`
					: `<label class="field" style="margin-top:.4rem"><span>Model id</span><input type="text" data-input="mform" data-field="slug" value="${esc(m.form.slug || '')}" placeholder="${esc(p.models[0])}"></label>`}`;
			const n = m.fetched && set ? m.picks.size : m.form.slug ? 1 : 0;
			return wrap(head + body + visibleRow(m) + actions(cancel(), `<button class="btn solid" data-action="add-remote-submit" ${n ? '' : 'disabled'}>Add ${n || ''} model${n === 1 ? '' : 's'}</button>`));
		} else if (m.step === 'cli') {
			const t = d().cli[m.adapter];
			const def = M.CLI_DEFS[m.adapter];
			body = `<h3>CLI agent</h3>
				<div class="choice-grid" style="grid-template-columns:repeat(3,1fr)">${Object.entries(d().cli).map(([id, x]) => `<button class="choice ${id === m.adapter ? 'on' : ''}" data-action="add-adapter" data-id="${id}"><strong>${esc(M.CLI_DEFS[id].label)}</strong><span class="${x.found ? 'tone-ok' : 'tone-warn'} small">${x.found ? `✓ found · ${esc(x.version || '')}` : '✗ not found'}</span></button>`).join('')}</div>
				${t.found
					? `<div class="spread" style="margin-top:1rem"><strong>Models ${esc(def.label)} offers</strong><span class="muted small">Listed by the CLI · cached 2 h ago</span></div>
					<div class="pick-list">${def.catalog.map(([slug, label]) => { const exists = A.model(`${m.adapter}-${slug}`); return `<label class="pick"><input type="checkbox" data-change="mpick" data-key="${slug}" ${exists ? 'checked disabled' : m.picks.has(slug) ? 'checked' : ''}><span class="grow">${esc(label)} <code>${esc(slug)}</code></span>${exists ? '<span class="chip ok">added</span>' : ''}</label>`; }).join('')}</div>
					<p class="muted small" style="margin-top:.5rem">Found isn’t proof of sign-in. Sign in as the account Komatose runs under; a Test confirms it.</p>`
					: `<div class="fix-box" style="margin-top:1rem"><strong>${esc(def.label)} isn’t on this server.</strong> <span class="small">${esc(t.message || '')}</span><div class="row" style="margin-top:.5rem"><button class="btn sm" data-action="fix-cli" data-adapter="${m.adapter}">Set its location</button></div></div>`}`;
			const n = m.picks.size;
			return wrap(head + body + (t.found ? visibleRow(m) : '') + actions(cancel(), t.found ? `<button class="btn solid" data-action="add-cli-submit" ${n ? '' : 'disabled'}>Add ${n || ''} model${n === 1 ? '' : 's'}</button>` : ''));
		}
		return wrap(head + body + actions(cancel()));
	}

	const visibleRow = (m) =>
		`<div style="margin-top:1rem;padding-top:.8rem;border-top:1px solid var(--line)"><label class="switch"><input type="checkbox" data-change="mvisible" ${m.visible ? 'checked' : ''}><span class="track"></span>Users can pick it right away</label></div>`;

	function transfer() {
		return wrap(`<div class="kicker">Import / export</div><h3>Move model setup between machines</h3>
			<p class="muted">Exports remote and CLI model entries plus saved model profiles. Keys, CLI paths and private-network URLs stay behind unless you include them.</p>
			<label class="switch"><input type="checkbox"><span class="track"></span>Include private network endpoints</label>
			<div class="card tight" style="margin-top:.8rem"><div class="small">Will export <strong>7 models</strong> and <strong>2 profiles</strong>. “Local chat” profile references Qwen 3.8 27B, which is machine-local and will need adding on the other side.</div></div>
			${actions(cancel('Close'), '<button class="btn ghost" data-action="toast" data-msg="Pick a .json pack to preview what it adds">Import…</button>', '<button class="btn solid" data-action="toast" data-msg="Exported komatose-models-2026-09-24.json">Export</button>')}`);
	}

	function render(m) {
		if (!m) return '';
		switch (m.type) {
			case 'install': return install(m);
			case 'conflict': return conflict(m);
			case 'fix-key': return fixKey(m);
			case 'fix-cli': return fixCli(m);
			case 'fix-service': return fixService(m);
			case 'remove': return remove(m);
			case 'log': return log(m);
			case 'council': return council(m);
			case 'bench': return bench(m);
			case 'test-untested': return testUntested(m);
			case 'add': return addModel(m);
			case 'transfer': return transfer();
		}
		return '';
	}

	return { render };
})();
