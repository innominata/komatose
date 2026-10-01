/* Chapter Studio mockup. Plain JS, full re-render on every state change. */
const M = window.MOCK;

const S = {
  stage: "translate",
  page: 2,
  region: "p3r2",
  tool: "select",
  scope: "page",
  tabs: { prepare: "page", translate: "regions", review: "queue", clean: "clean", typeset: "text" },
  prepView: "grid",
  showRegions: true,
  compare: false,
  showMask: true,
  zoom: 100,
  stripOpen: true,
  inspOpen: true,
  stripFilter: "all",
  jobs: "collapsed",
  settings: null,
  modelsTab: "translation",
  palette: false,
  paletteQuery: "",
  paletteIndex: 0,
  menu: null,
  modal: null,
  selectedPages: new Set(),
  notes: false,
  brush: 24,
  grow: 10,
  nudge: 10,
  cloneX: 40,
  cloneY: 0,
  cleanMethod: "auto",
  maskEngine: "auto",
  padding: 5,
  strokes: 0,
  subtab: "suggestions",
  kana: false,
  query: "",
  unresolvedOnly: false,
  queueScope: "chapter",
  exportFormat: "png",
  quality: 95,
  includeMeta: false,
  draft: false,
  viewer: true,
  numberingStale: true,
  pending: [],
  stitch: false,
  conflict: false,
  toasts: [],
};

/* ---------- helpers ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const page = () => M.pages[S.page];
const allRegions = () => M.pages.flatMap((p) => p.regions.map((r) => ({ ...r, _page: p })));
const findRegion = (id) => {
  for (const p of M.pages) {
    const r = p.regions.find((x) => x.id === id);
    if (r) return r;
  }
  return null;
};
const pageOf = (id) => M.pages.find((p) => p.regions.some((r) => r.id === id));
const region = () => (page().regions.some((r) => r.id === S.region) ? findRegion(S.region) : null);
const typeOf = (id) => M.TYPES.find((t) => t.id === id) || M.TYPES[M.TYPES.length - 1];
const stageDef = (id = S.stage) => M.STAGES.find((s) => s.id === id);
const icon = (name, extra = "") => `<i class="bi ${name} ${extra}" aria-hidden="true"></i>`;
const isCanvasStage = () => ["translate", "review", "clean", "typeset"].includes(S.stage) || (S.stage === "prepare" && S.prepView === "page");
const regionIndex = (r) => (pageOf(r.id)?.regions.indexOf(r) ?? 0) + 1;
const trim = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

function regionState(r) {
  if (r.state === "ignored") return { key: "ignored", label: "Ignored" };
  if (!r.source && r.suggestions.length) return { key: "attn", label: "Pick a reading" };
  if (!r.source) return { key: "attn", label: "No source" };
  if (!r.english) return { key: "attn", label: "No English" };
  if (r.status === "approved") return { key: "ok", label: "Approved" };
  if (r.status === "needs_work") return { key: "bad", label: "Needs work" };
  if (r.suggestions.length) return { key: "attn", label: `${r.suggestions.length} suggestion${r.suggestions.length > 1 ? "s" : ""}` };
  return { key: "todo", label: "Needs review" };
}
const chip = (r) => {
  const s = regionState(r);
  return `<span class="chip chip-${s.key}">${esc(s.label)}</span>`;
};

function pageStageStatus(p, stage) {
  const def = stageDef(stage);
  if (!def?.step) return null;
  if (p.running && stage === "translate") return "running";
  if (p.done[def.step]) return "done";
  const hasIssue = M.EXCEPTIONS.some((e) => e.stage === stage && e.page === p.n) ||
    (stage === "translate" && p.regions.some((r) => r.state !== "ignored" && (!r.source || !r.english)));
  if (hasIssue) return "issue";
  if (stage === "clean" && p.mask !== "none") return "progress";
  return "todo";
}
function stageProgress(stage) {
  const def = stageDef(stage);
  if (!def.step) return null;
  const done = M.pages.filter((p) => p.done[def.step]).length;
  return { done, total: M.pages.length };
}
const blockers = () => M.READINESS.filter((i) => i.severity !== "warning");

function notify(msg, kind = "") {
  const id = Math.random().toString(36).slice(2);
  S.toasts.push({ id, msg, kind });
  renderToasts();
  setTimeout(() => {
    S.toasts = S.toasts.filter((t) => t.id !== id);
    renderToasts();
  }, 3600);
}

/* ---------- top bar ---------- */
function renderTop() {
  const steps = M.STAGES.map((s, i) => {
    const prog = stageProgress(s.id);
    let meta = "";
    if (s.id === "prepare") meta = `<span class="count${S.numberingStale ? " warn" : ""}">${M.pages.length} pages${S.numberingStale ? " · renumber" : ""}</span>`;
    else if (s.id === "export") meta = `<span class="count warn">${blockers().length} blockers</span>`;
    else meta = `<span class="meter"><i style="width:${(prog.done / prog.total) * 100}%"></i></span><span class="count">${prog.done}/${prog.total}</span>`;
    return `<li><button class="step${S.stage === s.id ? " active" : ""}" data-act="stage" data-id="${s.id}" title="${esc(s.purpose)}">
      <span class="num">${i + 1}</span><span class="lbl">${s.label}</span>${meta}</button></li>`;
  }).join("");
  const exc = M.EXCEPTIONS.length;
  return `<header class="top">
    <div class="brand">${icon("bi-moon-stars-fill")}<span>Komatose</span></div>
    <nav class="crumbs" aria-label="Location">
      <a href="#" data-act="toast" data-msg="Back to the series library">${esc(M.series.title)}</a>${icon("bi-chevron-right")}
      <strong>${esc(M.chapter.title)}</strong>
    </nav>
    <ol class="stepper" data-find="stepper">${steps}</ol>
    <div class="top-right">
      <button class="btn ghost find" data-act="palette" data-find="palette">${icon("bi-search")}<span>Find an action</span><kbd>Ctrl K</kbd></button>
      <div class="issue-pair" data-find="issues">
        <button class="btn ghost" data-act="menu" data-menu="issues" title="Things to check">${icon("bi-flag")} <b>${exc}</b> to check</button>
        <button class="btn accent" data-act="next-issue" data-find="next-issue" title="Jump to the next thing to check">Next ${icon("bi-arrow-right")}</button>
      </div>
      <span class="saved" title="Unsaved drafts and conflicts show here">${S.conflict ? `${icon("bi-exclamation-triangle")} 1 conflict` : `${icon("bi-cloud-check")} All text saved`}</span>
      <button class="btn ghost" data-act="settings" data-find="settings">${icon("bi-sliders")}<span>Settings</span></button>
      <button class="btn ghost icon-only" data-act="menu" data-menu="view" title="View" data-find="view-menu">${icon("bi-three-dots")}</button>
    </div>
  </header>`;
}

/* ---------- page strip ---------- */
function renderStrip() {
  if (!S.stripOpen) return `<button class="edge-tab left" data-act="toggle-strip">Pages</button>`;
  const legend = stageDef().step
    ? `<div class="legend"><span class="dot lg-done"></span>done <span class="dot lg-issue"></span>check <span class="dot lg-todo"></span>to do</div>`
    : "";
  const list = M.pages.map((p, i) => {
    const st = pageStageStatus(p, S.stage);
    if (S.stripFilter === "todo" && st === "done") return "";
    if (S.stripFilter === "done" && st !== "done") return "";
    const exportMarks = S.stage === "export" ? Object.values(p.done).filter(Boolean).length : null;
    return `<button class="thumb${i === S.page ? " sel" : ""}" data-act="page" data-i="${i}" data-ctx="page" data-page="${i}" ${i === S.page ? 'data-find="thumb-current"' : ""} title="Page ${p.n} · right-click for page actions">
      <img src="${p.src}" alt="" loading="lazy"><span class="pn">${p.n}</span>
      ${st ? `<span class="st st-${st}" title="${st}">${st === "done" ? icon("bi-check") : st === "running" ? '<span class="spin"></span>' : ""}</span>` : ""}
      ${exportMarks !== null ? `<span class="marks" title="Steps marked done">${exportMarks}/4</span>` : ""}
    </button>`;
  }).join("");
  return `<aside class="strip" aria-label="Pages">
    <div class="strip-head"><strong>${M.pages.length} pages</strong><button class="icon-btn" data-act="toggle-strip" title="Hide pages">${icon("bi-chevron-bar-left")}</button></div>
    ${stageDef().step ? `<div class="seg mini" data-find="strip-filter">${["all", "todo", "done"].map((f) => `<button class="${S.stripFilter === f ? "on" : ""}" data-act="strip-filter" data-v="${f}">${{ all: "All", todo: "To do", done: "Done" }[f]}</button>`).join("")}</div>${legend}` : ""}
    <div class="thumbs" data-find="strip">${list}</div>
    <button class="btn ghost add-pages" data-act="add-pages" data-find="add-pages">${icon("bi-plus-lg")} Add pages</button>
    <div class="work-credit" title="Required attribution for the test pages">${M.CREDIT_LINES.map(esc).join("<br>")}</div>
  </aside>`;
}

/* ---------- stage bar ---------- */
function scopeSeg() {
  return `<div class="seg" data-find="scope" title="Choose what the run buttons apply to">
    <button class="${S.scope === "page" ? "on" : ""}" data-act="scope" data-v="page">Page ${page().n}</button>
    <button class="${S.scope === "chapter" ? "on" : ""}" data-act="scope" data-v="chapter">Whole chapter</button></div>`;
}
const scopeLabel = () => (S.scope === "page" ? `page ${page().n}` : "chapter");
const moreBtn = (id) => `<button class="btn ghost" data-act="menu" data-menu="more" data-find="more-${id}">More ${icon("bi-chevron-down")}</button>`;

function renderStageBar() {
  const def = stageDef();
  let actions = "";
  let right = "";
  let note = "";
  if (S.stage === "prepare") {
    actions = `<div class="seg" data-find="prep-view">
        <button class="${S.prepView === "grid" ? "on" : ""}" data-act="prep-view" data-v="grid">${icon("bi-grid-3x3-gap")} Organize</button>
        <button class="${S.prepView === "page" ? "on" : ""}" data-act="prep-view" data-v="page">${icon("bi-file-image")} Edit page</button></div>
      <span class="vsep"></span>
      <span class="group-label">Whole chapter</span>
      <button class="btn" data-act="run" data-msg="Split spreads queued" data-find="split-spreads">Split spreads</button>
      <button class="btn" data-act="run" data-msg="Auto-crop margins on every story page" data-find="auto-crop">Auto-crop</button>
      <button class="btn" data-act="run" data-msg="Auto-align: pages scaled to the story width; credits scaled proportionally" data-find="auto-align">Auto-align</button>
      <button class="btn" data-act="run" data-msg="Auto-reslice strips queued" data-find="auto-reslice">Auto-reslice</button>
      <button class="btn" data-act="run" data-msg="Generating scene notes for every page" data-find="scene-notes">${icon("bi-card-text")} Scene notes</button>
      ${moreBtn("prepare")}`;
  } else if (S.stage === "translate") {
    actions = `${scopeSeg()}
      <button class="btn primary" data-act="run" data-msg="Transcribe ${scopeLabel()}: detect lettering, read with Hayai + PaddleOCR-VL" data-find="transcribe">${icon("bi-chat-square-text")} Transcribe</button>
      <button class="btn" data-act="run" data-msg="Translate ${scopeLabel()}: drafts empty English, offers alternatives elsewhere" data-find="translate">${icon("bi-translate")} Translate</button>
      <button class="btn" data-act="run" data-msg="Fill missing source & English on ${scopeLabel()}. Existing text untouched." data-find="fill-missing" title="Transcribe empty sources and fill empty English. Never overwrites.">${icon("bi-plus-square")} Fill missing</button>
      ${moreBtn("translate")}`;
    right = `<button class="model-chip" data-act="settings" data-sec="detection" data-find="detector-chip" title="Text detector for this chapter">${icon("bi-bounding-box-circles")} CTD + Koharu · 0.20</button>
      <button class="model-chip" data-act="menu" data-menu="translate-model" data-find="translate-model" title="Translation model for this chapter">${icon("bi-cpu")} Sugoi v4 ${icon("bi-chevron-down")}</button>`;
    if (S.scope === "chapter") note = "Chapter transcribe skips pages that already have regions. To re-detect one page, delete its junk boxes and transcribe that page.";
  } else if (S.stage === "review") {
    actions = `${scopeSeg()}
      <button class="btn" data-act="run" data-msg="Proofreading edited English on ${scopeLabel()}. Suggestions only; nothing auto-approved." data-find="proofread-english">${icon("bi-spellcheck")} Proofread English</button>
      <button class="btn" data-act="confirm" data-kind="approve-all" data-find="accept-all">${icon("bi-check2-all")} Accept all translations</button>
      <span class="vsep"></span>
      <span class="group-label">Page ${page().n} images</span>
      <button class="btn icon-only" data-act="toast" data-msg="Raw page ${page().n} copied at full size" title="Copy raw image" data-find="copy-raw">${icon("bi-clipboard")}</button>
      <button class="btn icon-only" data-act="toast" data-msg="Typeset page ${page().n} copied at full size" title="Copy typeset image" data-find="copy-typeset">${icon("bi-clipboard-check")}</button>
      <button class="btn" data-act="modal" data-kind="proofread" data-find="page-proofreader">${icon("bi-chat-square-quote")} Page proofreader</button>
      ${moreBtn("review")}`;
  } else if (S.stage === "clean") {
    const p = page();
    const steps = [
      ["Mask", p.mask === "approved" ? "done" : p.mask === "none" ? "now" : "now"],
      ["Remove", p.cleaned ? "done" : p.mask === "approved" ? "now" : "later"],
      ["Touch up", p.cleaned ? "now" : "later"],
      ["Approve", p.cleanApproved ? "done" : "later"],
    ];
    const next = p.mask === "none" ? ["Detect lettering", "detect"] : p.mask !== "approved" ? ["Approve mask", "approve-mask"] : !p.cleaned ? ["Clean page", "clean-run"] : ["Approve & next page", "approve-clean"];
    actions = `<ol class="pipeline" data-find="clean-pipeline">${steps.map(([l, s], i) => `<li class="${s}"><span>${s === "done" ? icon("bi-check") : i + 1}</span>${l}</li>`).join("")}</ol>
      <span class="vsep"></span>
      <span class="group-label">Next</span>
      <button class="btn primary" data-act="clean-next" data-v="${next[1]}" data-find="clean-next">${esc(next[0])}</button>
      ${moreBtn("clean")}`;
  } else if (S.stage === "typeset") {
    actions = `${scopeSeg()}
      <button class="btn primary" data-act="run" data-msg="Auto-fitting all text on ${scopeLabel()}. Locked layouts are skipped." data-find="autofit-all">${icon("bi-textarea-resize")} Auto-fit all text</button>
      <button class="btn" data-act="run" data-msg="Finding bubble interiors with SAM and fitting text on ${scopeLabel()}" data-find="find-fit">${icon("bi-bounding-box-circles")} Find &amp; fit bubbles</button>
      <button class="btn" data-act="run" data-msg="Kept 1 stale layout as placed" data-find="keep-layouts" title="Accept stale placements instead of refitting">${icon("bi-pin-angle")} Keep current layouts <span class="badge">1</span></button>
      ${moreBtn("typeset")}`;
    right = `<button class="model-chip" data-act="settings" data-sec="typography" data-find="type-settings-chip">${icon("bi-fonts")} Series type settings</button>`;
  } else if (S.stage === "export") {
    actions = `<span class="group-label">${blockers().length} items block a finished export · drafts and scripts can export now</span>`;
  }
  return `<div class="stagebar">
      <div class="sb-title">${icon(def.icon)}<div><strong>${def.label}</strong><small>${esc(def.purpose)}</small></div></div>
      <div class="sb-actions">${actions}</div>
      <div class="sb-right">${right}</div>
    </div>${note ? `<div class="sb-note">${icon("bi-info-circle")} ${esc(note)}</div>` : ""}`;
}

/* ---------- banners ---------- */
function renderBanners() {
  const out = [];
  const tr = M.JOBS.find((j) => j.kind === "Transcribe" && j.state === "running");
  if (tr && ["translate", "review"].includes(S.stage))
    out.push(`<div class="banner run">${icon("bi-activity")}<strong>Transcribe chapter</strong><span>${esc(tr.message)}</span>
      <span class="bar"><i style="width:${(tr.done / tr.total) * 100}%"></i></span>
      <button class="btn small" data-act="toast" data-msg="Stopping AI… unfinished pages can be retried">Stop AI</button></div>`);
  if (S.stage === "prepare" && S.numberingStale)
    out.push(`<div class="banner warn">${icon("bi-sort-numeric-down")}<span>Page numbering is stale after reordering. Export names will be wrong until you renumber.</span>
      <button class="btn small accent" data-act="renumber" data-find="renumber">Renumber pages 1–${M.pages.length}</button></div>`);
  if (S.conflict)
    out.push(`<div class="banner bad">${icon("bi-exclamation-octagon")}<div><strong>Region #1 on page 3 changed while you were editing.</strong><br>
      <small>Saved: “Eight thousand…” · Your draft: “Eight thousand people…”</small></div>
      <button class="btn small" data-act="conflict" data-v="mine">Save my draft over it</button><button class="btn small" data-act="conflict" data-v="theirs">Keep the saved version</button></div>`);
  if (S.stage === "prepare" && S.selectedPages.size && S.prepView === "grid")
    out.push(`<div class="banner sel">${icon("bi-check2-square")}<strong>${S.selectedPages.size} selected</strong>
      <button class="btn small" data-act="confirm" data-kind="extract" data-find="extract">Extract to chapter…</button>
      <button class="btn small" data-act="run" data-msg="Scene notes generating for ${S.selectedPages.size} pages">Scene notes</button>
      <button class="btn small danger" data-act="confirm" data-kind="delete-pages" data-find="delete-selected">Delete…</button>
      <button class="btn small ghost" data-act="clear-selection">Clear</button></div>`);
  return out.join("");
}

/* ---------- tool options bar ---------- */
function renderToolOptions() {
  const t = M.TOOLS[S.tool];
  if (!t || S.tool === "select" || S.tool === "zoom") return "";
  let opts = "";
  const brushy = ["brush", "erase", "blur", "restore", "raw", "clone-stamp", "text-mask", "text-erase"];
  if (brushy.includes(S.tool))
    opts += `<label class="opt">Size <input type="range" min="2" max="120" value="${S.brush}" data-input="brush"><b>${S.brush}px</b></label>`;
  if (S.tool === "clone-stamp") opts += `<span class="opt muted">Source: ${icon("bi-mouse2")} right-click to set</span>`;
  if (S.tool === "mask-grow") opts += `<label class="opt">Grow by <input type="number" min="1" max="50" value="${S.grow}" data-input="grow"> px</label>`;
  if (S.tool === "polygon") opts += `<span class="opt muted">4 points</span><button class="btn small accent" data-act="toast" data-msg="Polygon saved">Save polygon</button><button class="btn small ghost" data-act="tool" data-id="select">Cancel</button>`;
  if (S.tool === "crop") opts += `<button class="btn small accent" data-act="toast" data-msg="Page cropped · undo with Undo page edit">Apply crop</button><button class="btn small ghost" data-act="tool" data-id="select">Cancel</button>`;
  if (S.tool === "split") opts += `<label class="opt">At <input type="number" value="50" min="1" max="99"> %</label><button class="btn small accent" data-act="toast" data-msg="Page split into two">Apply split</button>`;
  if (S.tool === "reslice") opts += `<span class="opt muted">3 cuts · pages ${Math.max(1, page().n - 1)}–${page().n + 1} stitched</span><button class="btn small accent" data-act="toast" data-msg="Reslice applied">Apply reslice cuts</button>`;
  if (S.tool === "reorder") opts += `<span class="opt muted">After #${region() ? regionIndex(region()) : "—"} comes…</span><button class="btn small ghost" data-act="tool" data-id="select">Done</button>`;
  if (S.tool === "style-brush") opts += `<span class="opt muted">Copied 11 pt Dialogue style</span><button class="btn small ghost" data-act="tool" data-id="select">Stop</button>`;
  return `<div class="toolopts" data-find="tool-options">${icon(t.icon)}<strong>${t.label}</strong><span class="hint">${esc(t.hint)}</span><span class="spacer"></span>${opts}</div>`;
}

/* ---------- canvas ---------- */
function renderRail() {
  const groups = M.STAGE_TOOLS[S.stage] || [];
  const names = M.TOOL_GROUP_NAMES[S.stage] || [];
  return `<div class="rail" role="toolbar" aria-label="Tools" data-find="rail">${groups.map((g, gi) => `
    <div class="rail-group">${names[gi] ? `<span class="rail-name">${names[gi]}</span>` : ""}
      ${g.map((id) => {
        const t = M.TOOLS[id];
        const needsRegion = ["polygon", "rectangle", "oval", "style-brush"].includes(id) && !region();
        return `<button class="rail-btn${S.tool === id ? " on" : ""}" data-act="tool" data-id="${id}" data-find="tool-${id}" ${needsRegion ? "disabled" : ""}
          title="${esc(t.label)}${t.key ? ` (${t.key})` : ""}${needsRegion ? " · select a region first" : ""}">${icon(t.icon)}${t.key ? `<kbd>${t.key}</kbd>` : ""}</button>`;
      }).join("")}</div>`).join("")}</div>`;
}

function flowArrows(p) {
  const rs = p.regions.filter((r) => r.state !== "ignored");
  if (rs.length < 2) return "";
  const pts = rs.map((r) => [(r.x + r.w / 2) * 100, (r.y + r.h / 2) * 100]);
  const lines = pts.slice(1).map((pt, i) => `<line x1="${pts[i][0]}" y1="${pts[i][1]}" x2="${pt[0]}" y2="${pt[1]}" marker-end="url(#arr)"/>`).join("");
  return `<svg class="flow" viewBox="0 0 100 100" preserveAspectRatio="none"><defs><marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0,0L10,5L0,10z"/></marker></defs>${lines}</svg>`;
}

function renderCanvas() {
  const p = page();
  const st = S.stage;
  const showType = (st === "typeset" && !S.compare) || (st === "review" && S.compare);
  const showCleaned = showType || (st === "clean" && p.cleaned && !S.compare);
  const layers = [];
  if (showCleaned || showType)
    layers.push(...p.regions.filter((r) => r.state !== "ignored").map((r) => `<div class="patch" style="${box(r)}"></div>`));
  if (showType)
    layers.push(...p.regions.filter((r) => r.state !== "ignored" && r.english).map((r) =>
      `<div class="typeset${r.layout?.overflow ? " over" : ""}" style="${box(r)}"><span style="font-size:${Math.max(1.1, Math.min(2.4, r.w * 9))}cqw">${esc(r.english).replace(/\n/g, "<br>")}</span></div>`));
  if (st === "clean" && S.showMask && p.mask !== "none" && !S.compare)
    layers.push(...p.regions.filter((r) => r.state !== "ignored").map((r) => `<div class="mask" style="${box(r, 0.01)}"></div>`));
  if (st === "typeset" && S.showMask) layers.push(p.regions.filter((r) => r.textMask).map((r) => `<div class="tmask" style="${box(r)}"></div>`).join(""));
  if (S.showRegions && st !== "prepare")
    layers.push(...p.regions.map((r, i) => {
      const t = typeOf(r.type);
      const sel = r.id === S.region;
      const s = regionState(r);
      return `<div class="rbox${sel ? " sel" : ""}${r.state === "ignored" ? " ignored" : ""}${r.layout?.overflow && st === "typeset" ? " over" : ""}" style="${box(r)};--c:${t.color}"
        data-act="region" data-id="${r.id}" data-ctx="region" data-region="${r.id}">
        <span class="rnum">${i + 1}</span>${sel ? `<span class="rlabel">${esc(t.label)}</span>` : ""}
        ${s.key === "attn" || s.key === "bad" ? `<span class="rflag" title="${esc(s.label)}">!</span>` : ""}
        ${sel && ["clean", "typeset"].includes(st) ? polygonFor(r) : ""}
        ${sel && st === "typeset" ? `<span class="rot" title="Drag to rotate · arrows 1°, Shift 15°"></span><span class="skew sx" title="Drag to skew horizontally"></span><span class="skew sy" title="Drag to skew vertically"></span>` : ""}
      </div>`;
    }));
  if (st === "review" && S.showRegions) layers.push(flowArrows(p));
  if (st === "prepare") {
    if (S.tool === "crop") layers.push(`<div class="crop"><i></i><i></i><i></i><i></i></div>`);
    if (S.tool === "split") layers.push(`<div class="splitline"></div>`);
    if (S.tool === "reslice") layers.push(`<div class="cut" style="top:22%"></div><div class="cut" style="top:47%"></div><div class="cut" style="top:73%"></div><span class="boundary" style="top:0">page ${page().n}</span>`);
  }
  if (!p.regions.length && ["translate", "review"].includes(st))
    layers.push(`<div class="empty-note">${p.running ? '<span class="spin"></span> Transcribing this page…' : "No regions yet. Transcribe this page, or draw a region (R)."}</div>`);
  const zoomStyle = S.zoom === 100 ? "" : `height:${S.zoom}%`;
  return `<div class="canvas-scroll" data-ctx="page" data-page="${S.page}" data-find="canvas">
      <div class="frame" style="${zoomStyle}"><img src="${p.src}" alt="Page ${p.n}" draggable="false">${layers.join("")}</div>
    </div>`;
}
const box = (r, pad = 0) => `left:${(r.x - pad) * 100}%;top:${(r.y - pad) * 100}%;width:${(r.w + pad * 2) * 100}%;height:${(r.h + pad * 2) * 100}%`;
const polygonFor = () => `<svg class="poly" viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points="8,2 92,6 98,50 90,96 12,98 2,52"/></svg>`;

function renderViewBar() {
  const st = S.stage;
  const p = page();
  const btns = [];
  if (st !== "prepare")
    btns.push(`<button class="vb${S.showRegions ? " on" : ""}" data-act="view" data-v="regions" data-find="view-regions" title="Show or hide region outlines">${icon(S.showRegions ? "bi-eye" : "bi-eye-slash")} Regions</button>`);
  if (st === "clean" || st === "typeset")
    btns.push(`<button class="vb${S.showMask ? " on" : ""}" data-act="view" data-v="mask" data-find="view-mask">${icon("bi-transparency")} ${st === "typeset" ? "Text mask" : "Mask"}</button>`);
  if (["clean", "typeset", "review"].includes(st)) {
    const lbl = st === "review" ? (S.compare ? "Showing typeset" : "Showing raw") : S.compare ? "Showing source" : "Showing result";
    btns.push(`<button class="vb${S.compare ? " on" : ""}" data-act="view" data-v="compare" data-find="view-compare" title="Hold-to-compare also works with the \\ key">${icon("bi-layers-half")} ${lbl}</button>`);
  }
  return `<div class="viewbar" data-find="viewbar">
    <button class="vb" data-act="nav-page" data-d="-1" title="Previous page">${icon("bi-chevron-left")}</button><span class="vb-txt">Page ${p.n} / ${M.pages.length}</span><button class="vb" data-act="nav-page" data-d="1" title="Next page">${icon("bi-chevron-right")}</button>
    ${btns.length ? `<span class="vsep"></span>${btns.join("")}` : ""}
    <span class="vsep"></span>
    <button class="vb" data-act="zoom" data-d="-1" title="Zoom out">${icon("bi-dash")}</button><button class="vb vb-txt" data-act="zoom" data-d="0" title="Fit page">${S.zoom === 100 ? "Fit" : `${S.zoom}%`}</button><button class="vb" data-act="zoom" data-d="1" title="Zoom in">${icon("bi-plus")}</button>
  </div>`;
}

function renderPageFoot() {
  const p = page();
  const def = stageDef();
  if (!def.step) {
    return `<div class="pagefoot"><div class="pf-info"><strong>Page ${p.n}</strong> · ${p.name} · 1414 × 2000</div>
      <div class="pf-actions"><button class="btn ghost" data-act="toast" data-msg="Page edit undone" title="Undo page edit">${icon("bi-arrow-counterclockwise")} Undo page edit (2)</button>
      <button class="btn" data-act="nav-page" data-d="1">Next page ${icon("bi-arrow-right")}</button></div></div>`;
  }
  const done = p.done[def.step];
  const attn = p.regions.filter((r) => ["attn", "bad", "todo"].includes(regionState(r).key)).length;
  const info = st2info(p, attn);
  return `<div class="pagefoot">
    <div class="pf-info"><strong>Page ${p.n}</strong> · ${info}</div>
    <div class="pf-actions">
      <button class="btn ghost icon-only" data-act="toast" data-msg="Undid the last saved edit" title="Undo saved edit (Ctrl+Z)" data-find="undo">${icon("bi-arrow-counterclockwise")}</button>
      <button class="btn ghost icon-only" data-act="toast" data-msg="Redid" title="Redo (Ctrl+Shift+Z)">${icon("bi-arrow-clockwise")}</button>
      ${done
        ? `<span class="done-chip" data-find="mark-done" title="Editing this page in ${def.label} reopens it">${icon("bi-check-circle-fill")} Done in ${def.label}</span>`
        : `<button class="btn mark" data-act="mark-done" data-find="mark-done" title="Records page ${p.n} as finished for ${def.label} and clears its saved undo history. Text, artwork and layouts stay. Editing again reopens it.">${icon("bi-check-circle")} Mark page done</button>`}
      <button class="btn" data-act="nav-page" data-d="1">Next page ${icon("bi-arrow-right")}</button>
    </div></div>`;
}
function st2info(p, attn) {
  if (S.stage === "clean") return `mask ${p.mask === "approved" ? "approved" : p.mask === "none" ? "not detected" : "needs approval"} · ${p.cleaned ? "cleaned" : "not cleaned"}${p.cleanApproved ? " · approved" : ""}`;
  if (S.stage === "typeset") {
    const over = p.regions.filter((r) => r.layout?.overflow).length;
    const fitted = p.regions.filter((r) => r.layout).length;
    return `${fitted}/${p.regions.filter((r) => r.state !== "ignored").length} regions fitted${over ? ` · <span class="warn">${over} overflow</span>` : ""}`;
  }
  return `${p.regions.length} regions${attn ? ` · <span class="warn">${attn} need attention</span>` : ""}`;
}

/* ---------- prepare: organize grid ---------- */
function renderGrid() {
  const cr = M.series.credits;
  const cards = M.pages.map((p, i) => `
    <div class="gcard${S.selectedPages.has(i) ? " picked" : ""}${i === S.page ? " cur" : ""}" data-ctx="page" data-page="${i}" draggable="true">
      <label class="gcheck" title="Select (Shift-click for a range)"><input type="checkbox" data-act="pick" data-i="${i}" ${S.selectedPages.has(i) ? "checked" : ""}></label>
      <button class="gimg" data-act="open-page" data-i="${i}" title="Open page ${p.n} for editing"><img src="${p.src}" alt=""></button>
      <div class="gmeta"><strong>${p.n}</strong><span>${p.name}</span><button class="icon-btn" data-act="ctx-btn" data-kind="page" data-page="${i}" title="Page actions">${icon("bi-three-dots")}</button></div>
    </div>`).join("");
  return `<div class="grid-wrap" data-find="organize">
    <div class="grid-hint">${icon("bi-arrows-move")} Drag to reorder · Click to edit · Shift-click checkboxes for a range · Paste images anywhere</div>
    <div class="grid">
      <div class="gcard ghost-slot"><div class="gslot">${icon("bi-award")}<strong>Pre-credits</strong><small>${esc(cr.pre.name)} · saved on series</small><button class="btn small" data-act="run" data-msg="Series credits added as first and last pages">Add to chapter</button></div></div>
      ${cards}
      <div class="gcard ghost-slot"><div class="gslot">${icon("bi-award")}<strong>Post-credits</strong><small>${esc(cr.post.name)} · missing here</small><button class="btn small accent" data-act="run" data-msg="Series credits added as first and last pages" data-find="add-credits">Add to chapter</button></div></div>
      <label class="gcard drop" data-find="upload"><div class="gslot">${icon("bi-cloud-arrow-up")}<strong>Add images</strong><small>Drop, choose, or paste · order is previewed before upload</small><input type="file" multiple accept="image/*" data-input="files"></div></label>
    </div></div>`;
}

/* ---------- inspector ---------- */
function tabs(defs) {
  const cur = S.tabs[S.stage];
  return `<div class="itabs" role="tablist">${defs.map(([id, label, badge]) => `<button role="tab" class="${cur === id ? "on" : ""}" data-act="tab" data-v="${id}" data-find="tab-${S.stage}-${id}">${label}${badge ? ` <span class="badge">${badge}</span>` : ""}</button>`).join("")}</div>`;
}

function renderInspector() {
  if (S.stage === "export") return "";
  if (!S.inspOpen) return `<button class="edge-tab right" data-act="toggle-insp">Inspector</button>`;
  let body = "";
  const st = S.stage;
  if (st === "prepare") body = tabs([["page", `Page ${page().n}`], ["upload", "Upload", S.pending.length || ""], ["credits", "Credits"]]) + inspPrepare();
  else if (st === "translate") body = tabs([["regions", "Regions", page().regions.length], ["page", "Page & script"]]) + (S.tabs.translate === "regions" ? inspRegions("translate") : inspPageText());
  else if (st === "review") body = tabs([["queue", "To review", reviewQueue().length], ["page", "Page & script"], ["glossary", "Glossary"]]) + (S.tabs.review === "queue" ? inspQueue() : S.tabs.review === "page" ? inspPageText() : inspGlossary());
  else if (st === "clean") body = tabs([["clean", `Clean page ${page().n}`], ["region", region() ? `Region #${regionIndex(region())}` : "Region"]]) + (S.tabs.clean === "clean" ? inspClean() : inspShape(true));
  else if (st === "typeset") body = tabs([["text", "Text"], ["style", "Style"], ["shape", "Shape & mask"]]) + inspTypeset();
  return `<aside class="insp" aria-label="Inspector"><div class="insp-head"><span>Inspector</span><button class="icon-btn" data-act="toggle-insp" title="Hide inspector">${icon("bi-chevron-bar-right")}</button></div><div class="insp-body">${body}</div></aside>`;
}

function inspPrepare() {
  const p = page();
  const t = S.tabs.prepare;
  if (t === "upload") {
    const list = S.pending.length ? S.pending : ["scan_011.png", "scan_012.png", "scan_013.png"];
    return `<section class="sec"><h3>Upload order</h3><p class="muted">Files are added in this order after page ${M.pages.length}.</p>
      <ol class="upl">${list.map((f, i) => `<li><span>${i + 1}. ${esc(f)}</span><button class="icon-btn" title="Move up">${icon("bi-arrow-up")}</button><button class="icon-btn" title="Remove">${icon("bi-x")}</button></li>`).join("")}</ol>
      <label class="check"><input type="checkbox" ${S.stitch ? "checked" : ""} data-input="stitch"> Stitch these images into strips</label>
      <p class="warn small">${icon("bi-exclamation-triangle")} scan_012.png looks identical to page 7.</p>
      <button class="btn primary block" data-act="toast" data-msg="Uploading 3 images in this order" data-find="upload-order">Upload in this order</button></section>`;
  }
  if (t === "credits") {
    const c = M.series.credits;
    return `<section class="sec"><h3>Series credits <span class="scope">Series</span></h3>
      <p class="muted">Saved once on the series. Auto-crop and auto-align ignore them, then scale them to the story width.</p>
      ${["pre", "post"].map((k) => `<div class="credit"><div class="credit-img">${icon("bi-award")}</div><div><strong>${k === "pre" ? "Pre-credits" : "Post-credits"}</strong><small>${esc(c[k].name)} · ${c[k].size}</small>
        <small class="${k === "post" ? "warn" : "ok"}">${k === "post" ? "Not in this chapter yet" : "Already in this chapter"}</small></div>
        <button class="icon-btn" title="Replace">${icon("bi-arrow-repeat")}</button><button class="icon-btn" title="Remove from series">${icon("bi-trash")}</button></div>`).join("")}
      <button class="btn primary block" data-act="run" data-msg="Credits added as first and last pages">Add credits to this chapter</button></section>`;
  }
  return `<section class="sec"><h3>Page ${p.n}</h3>
      <dl class="meta"><dt>File</dt><dd>${p.name}</dd><dt>Size</dt><dd>1414 × 2000 · 350 DPI</dd><dt>Role</dt><dd>Story page</dd></dl></section>
    <section class="sec"><h3>Scene note <span class="scope">for translators</span></h3>
      <textarea rows="4" placeholder="Who is visible, where, what happens, mood. Don't quote lettering.">${esc(p.caption)}</textarea>
      <div class="row"><button class="btn small" data-act="run" data-msg="Describing page ${p.n}" data-find="describe-page">${icon("bi-card-text")} ${p.caption ? "Refresh" : "Generate"} scene note</button>
      <button class="btn small ghost" data-act="settings" data-sec="models" data-models="description">Description model…</button></div></section>
    <section class="sec" data-find="nudge"><h3>Nudge page</h3>
      <div class="nudge"><button class="btn icon-only" data-act="toast" data-msg="Nudged up">${icon("bi-arrow-up")}</button>
        <button class="btn icon-only" data-act="toast" data-msg="Nudged left">${icon("bi-arrow-left")}</button><input type="number" value="${S.nudge}" min="1" title="Pixels"><button class="btn icon-only" data-act="toast" data-msg="Nudged right">${icon("bi-arrow-right")}</button>
        <button class="btn icon-only" data-act="toast" data-msg="Nudged down">${icon("bi-arrow-down")}</button></div></section>
    <section class="sec"><h3>Page actions</h3>
      <div class="list-actions">
        <button data-act="tool" data-id="crop">${icon("bi-crop")} Crop…</button>
        <button data-act="tool" data-id="split">${icon("bi-vr")} Split page…</button>
        <button data-act="tool" data-id="reslice">${icon("bi-hr")} Reslice strips…</button>
        <button data-act="run" data-msg="Auto-cropped page ${p.n}">${icon("bi-bounding-box")} Auto-crop margins</button>
        <button data-act="toast" data-msg="Choose an image or PSD" data-find="replace-file">${icon("bi-arrow-repeat")} Replace from image / PSD…</button>
        <button data-act="toast" data-msg="Choose images to insert before page ${p.n}">${icon("bi-box-arrow-in-left")} Insert images before…</button>
        <button data-act="toast" data-msg="Choose images to insert after page ${p.n}">${icon("bi-box-arrow-in-right")} Insert images after…</button>
        <button data-act="move-page" data-d="-1">${icon("bi-arrow-up-short")} Move earlier</button>
        <button data-act="move-page" data-d="1">${icon("bi-arrow-down-short")} Move later</button>
        <button data-act="confirm" data-kind="revert">${icon("bi-arrow-counterclockwise")} Revert to original raw</button>
        <button class="danger" data-act="confirm" data-kind="delete-page">${icon("bi-trash")} Delete page…</button>
      </div></section>`;
}

/* ----- translate/review: regions ----- */
function inspRegions(mode) {
  const p = page();
  const hits = S.query.trim() ? allRegions().filter((r) => `${r.source} ${r.english}`.toLowerCase().includes(S.query.toLowerCase())) : [];
  let rows = p.regions;
  if (S.unresolvedOnly) rows = rows.filter((r) => regionState(r).key !== "ok" && r.state !== "ignored");
  return `<div class="searchbar" data-find="search"><div class="search">${icon("bi-search")}<input type="search" placeholder="Search source & English in this chapter" value="${esc(S.query)}" data-input="query"></div>
      <label class="check small" data-find="unresolved"><input type="checkbox" ${S.unresolvedOnly ? "checked" : ""} data-input="unresolved"> Unresolved</label></div>
    ${hits.length ? `<div class="hits">${hits.map((r) => `<button data-act="goto-region" data-id="${r.id}"><b>p${r._page.n}</b> ${esc(trim(r.source || "[unreadable]", 22))} <small>${esc(trim(r.english, 32))}</small></button>`).join("")}</div>` : ""}
    <div class="rlist">${rows.map((r) => `
      <button class="rrow${r.id === S.region ? " sel" : ""}" data-act="region" data-id="${r.id}" data-ctx="region" data-region="${r.id}">
        <span class="rnum" style="--c:${typeOf(r.type).color}">${regionIndex(r)}</span>
        <span class="rtext"><b>${esc(trim(r.source || "[no source yet]", 26))}</b><small>${esc(trim(r.english || "— no English —", 38))}</small></span>${chip(r)}
      </button>${r.id === S.region ? regionCard(r, mode) : ""}`).join("") || `<p class="empty">No regions on this page. Transcribe it or draw a region.</p>`}</div>`;
}

function regionCard(r, mode) {
  const t = typeOf(r.type);
  const srcLabel = M.chapter.lang === "japanese" ? "Japanese source" : "Korean source";
  const glossary = M.GLOSSARY.filter((g) => r.source.includes(g.source));
  const sfx = r.type === "::";
  const subtabs = [["suggestions", "Suggestions", r.suggestions.length], ["comments", "Comments", r.comments.length], ["history", "History"], ["details", "Order & bounds"]];
  return `<article class="rcard" data-find="region-card">
    <header>
      <select class="type-pick" style="--c:${t.color}" title="Region type" data-find="region-type">${M.TYPES.map((x) => `<option ${x.id === r.type ? "selected" : ""}>${x.label}</option>`).join("")}</select>
      <span class="muted small">${r.ocr == null ? "Image / manual source" : `OCR ${Math.round(r.ocr * 100)}%`}</span>
      <span class="spacer"></span>
      <button class="icon-btn" data-act="ctx-btn" data-kind="region" data-region="${r.id}" title="Region actions" data-find="region-actions">${icon("bi-three-dots")}</button>
    </header>
    ${r.state === "ignored" ? `<div class="alert muted">${icon("bi-slash-circle")} Ignored: ${esc(r.ignoreReason)} <button class="link" data-act="toast" data-msg="Region reopened">Reopen</button></div>` : ""}
    ${!r.source && r.suggestions.length ? `<div class="alert attn">${icon("bi-signpost-split")} The readers disagree. Pick a reading below, or ask for an AI Review.</div>` : ""}
    ${r.layout?.overflow ? `<div class="alert bad">${icon("bi-exclamation-triangle")} Text overflows at the minimum size.</div>` : ""}
    <div class="field">
      <div class="field-head"><label>${srcLabel}</label><button class="btn small" data-act="modal" data-kind="ai-review" data-find="ai-review" title="Independent readings from your source reviewers">${icon("bi-people")} AI Review</button></div>
      <textarea rows="${mode === "review" ? 1 : 2}" lang="ja" placeholder="Type or pick a reading">${esc(r.source)}</textarea>
      ${r.source ? `<div class="roman">${esc(romanize(r.source))}</div>` : ""}
      <div class="helpers">
        <button class="link${S.kana ? " on" : ""}" data-act="kana" data-find="kana">${icon("bi-keyboard")} Kana & kanji pad</button>
        ${glossary.map((g) => `<span class="gchip" title="Series glossary">${esc(g.source)} → ${esc(g.english)}</span>`).join("")}
        ${sfx ? `<button class="gchip sfx">ドン → BOOM</button>` : ""}
      </div>
      ${S.kana ? kanaPad() : ""}
    </div>
    <div class="field">
      <div class="field-head"><label>English</label><button class="btn small" data-act="modal" data-kind="revise" data-find="revise" ${!r.source ? "disabled title='Needs source first'" : ""}>${icon("bi-magic")} Revise English</button></div>
      <textarea rows="3" placeholder="${r.source ? "Translate, or type English" : "Needs source first"}">${esc(r.english)}</textarea>
    </div>
    <div class="row wrap">
      <button class="btn primary" data-act="approve-next" data-find="approve-next" ${!r.english ? "disabled" : ""}>${icon("bi-check2")} Approve &amp; next</button>
      <button class="btn" data-act="toast" data-msg="Marked needs work" data-find="needs-work">Needs work</button>
      <button class="btn ghost" data-act="run" data-msg="Asking for an alternative translation" data-find="suggest-alt">Suggest alternative</button>
      <button class="btn ghost" data-act="modal" data-kind="enquire" data-find="enquire">${icon("bi-chat-dots")} Enquire</button>
    </div>
    <div class="subtabs">${subtabs.map(([id, l, n]) => `<button class="${S.subtab === id ? "on" : ""}" data-act="subtab" data-v="${id}" data-find="subtab-${id}">${l}${n ? ` <span class="badge">${n}</span>` : ""}</button>`).join("")}</div>
    <div class="subbody">${subBody(r)}</div>
  </article>`;
}

function subBody(r) {
  if (S.subtab === "suggestions") {
    if (!r.suggestions.length) return `<p class="muted small">No pending suggestions. Suggestions from Transcribe, AI Review, Revise English, Proofread and Enquire appear here with their origin.</p>`;
    return r.suggestions.map((s) => `<div class="sugg">
      <div class="sugg-head"><strong>${esc(s.kind)}</strong><small>${esc(s.reason || "")}</small></div>
      <p lang="ja">${esc(s.body)}</p>${s.translation ? `<p class="sugg-en">${esc(s.translation)}</p>` : ""}
      <div class="row"><button class="btn small accent" data-act="toast" data-msg="Applied as a draft; region marked for review">${s.translation ? "Use source & English" : "Use this version"}</button><button class="btn small ghost" data-act="toast" data-msg="Suggestion rejected">Reject</button></div>
    </div>`).join("");
  }
  if (S.subtab === "comments")
    return `${r.comments.map((c) => `<div class="comment"><small>${esc(c.user)}${c.correction ? " · proofreader correction" : ""}</small><p>${esc(c.body)}</p><button class="link small">Delete</button></div>`).join("")}
      <textarea rows="2" placeholder="Add a comment"></textarea>
      <div class="row"><label class="check small"><input type="checkbox"> Proofreader correction</label><span class="spacer"></span><button class="btn small">Add comment</button></div>`;
  if (S.subtab === "history")
    return `${r.history.length ? r.history.map((h) => `<div class="hist"><small>Revision ${h.rev}</small><p>${esc(h.body || "(empty)")}</p><button class="btn small ghost" data-act="toast" data-msg="Restored as a draft, marked needs work">Restore as draft</button></div>`).join("") : `<p class="muted small">No earlier revisions.</p>`}`;
  return `<div class="grid2">
      <label>Reading order<input type="number" value="${regionIndex(r)}"></label>
      <label>&nbsp;<button class="btn small" data-act="toast" data-msg="Region moved to #1">Set as region 1</button></label>
      <label>x<input type="number" step=".005" value="${r.x}"></label><label>y<input type="number" step=".005" value="${r.y}"></label>
      <label>w<input type="number" step=".005" value="${r.w}"></label><label>h<input type="number" step=".005" value="${r.h}"></label>
    </div>
    <div class="row"><label class="grow">Split English at character<input type="number" value="12" min="1"></label><button class="btn small" data-act="toast" data-msg="Split into two regions; history kept">Split</button></div>
    <div class="row"><select class="grow"><option>Merge with…</option>${page().regions.filter((x) => x.id !== r.id).map((x) => `<option>#${regionIndex(x)} ${esc(trim(x.english || x.source, 24))}</option>`).join("")}</select><button class="btn small" data-act="toast" data-msg="Merged; the other region is kept as ignored">Merge</button></div>
    <div class="row"><input class="grow" placeholder="Reason to ignore" value="${esc(r.ignoreReason || "")}"><button class="btn small" data-act="toast" data-msg="Region explicitly ignored">${r.state === "ignored" ? "Reopen" : "Ignore"}</button></div>
    <button class="btn small danger" data-act="confirm" data-kind="delete-region">${icon("bi-trash")} Delete region…</button>`;
}

function kanaPad() {
  const kana = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん".split("");
  return `<div class="kana"><div class="kana-grid">${kana.map((k) => `<button>${k}</button>`).join("")}</div>
    <div class="kanji-pad"><span>Draw an unreadable kanji here</span></div>
    <div class="row"><button class="btn small" data-act="toast" data-msg="Reading the drawing…">Read drawing</button><button class="btn small ghost">Clear</button><span class="spacer"></span><button class="btn small accent" data-act="toast" data-msg="Inserted into source">Apply to source</button></div></div>`;
}

function romanize(s) {
  const map = { "８千人……": "hassen-nin……", "君達はその８千人のトップの80人である！": "kimitachi wa sono hassen-nin no toppu no hachijū-nin de aru!", "永禄大学医学部 卒業式": "Eiroku daigaku igakubu sotsugyōshiki", "日本の医療を背負っていくのは君達です!!": "Nihon no iryō o seotte iku no wa kimitachi desu!!", "第1話 研修医の夜": "dai-ichi-wa kenshūi no yoru" };
  return map[s] || "romanization appears here";
}

function inspPageText() {
  const p = page();
  return `<section class="sec"><h3>Scene note <span class="scope">translators see this</span></h3>
      <textarea rows="4" placeholder="Who is visible, where, what happens, mood.">${esc(p.caption)}</textarea>
      <div class="row"><button class="btn small" data-act="run" data-msg="Refreshing scene context for page ${p.n}" data-find="refresh-scene">${icon("bi-card-text")} Refresh scene context</button></div></section>
    <section class="sec"><h3>Chapter summary</h3><p class="muted small">Standing setting compacted from page notes: “Graduation ceremony, Eiroku University medical school, spring.”</p></section>
    <section class="sec" data-find="import-script"><h3>Import a script</h3>
      <textarea rows="4" placeholder="Paste a chapter script. Lines without a box land in Unplaced."></textarea>
      <button class="btn small">Import script</button></section>
    <section class="sec" data-find="unplaced"><h3>Unplaced lines <span class="badge">2</span></h3>
      <div class="unplaced"><span>“Welcome, graduates of the class of…”</span><button class="btn small" data-act="toast" data-msg="Draw the box for this line on the page">Draw to place</button></div>
      <div class="unplaced"><span>“Dean Tanaka will now speak.”</span><button class="btn small" data-act="toast" data-msg="Draw the box for this line on the page">Draw to place</button></div></section>`;
}

function reviewQueue() {
  const items = [];
  for (const p of M.pages) for (const r of p.regions) {
    if (S.queueScope === "page" && p !== page()) continue;
    const s = regionState(r);
    if (["attn", "bad", "todo"].includes(s.key)) items.push({ r, p, s });
  }
  return items;
}
function inspQueue() {
  const q = reviewQueue();
  const groups = {};
  for (const it of q) (groups[it.s.label.replace(/^\d+ /, "")] ||= []).push(it);
  const sel = region();
  return `<div class="searchbar"><div class="seg mini"><button class="${S.queueScope === "chapter" ? "on" : ""}" data-act="queue-scope" data-v="chapter">Whole chapter</button><button class="${S.queueScope === "page" ? "on" : ""}" data-act="queue-scope" data-v="page">Page ${page().n}</button></div>
      <span class="muted small">${q.length} left</span></div>
    ${sel ? regionCard(sel, "review") : ""}
    <div class="queue" data-find="queue">${Object.entries(groups).map(([g, list]) => `<h4>${esc(g)} <span class="badge">${list.length}</span></h4>
      ${list.map(({ r, p }) => `<button class="rrow${r.id === S.region ? " sel" : ""}" data-act="goto-region" data-id="${r.id}"><span class="rnum" style="--c:${typeOf(r.type).color}">${regionIndex(r)}</span><span class="rtext"><b>Page ${p.n} · ${esc(trim(r.source || "[no source]", 18))}</b><small>${esc(trim(r.english || "— no English —", 36))}</small></span></button>`).join("")}`).join("") || `<p class="empty">${icon("bi-check-circle")} Everything is approved.</p>`}</div>`;
}

function inspGlossary() {
  return `<section class="sec"><h3>Extract series terms</h3>
      <p class="muted small">Once the chapter is reviewed, send the bilingual script to a model to find names, places and catchphrases for later chapters. Accepted terms join the series glossary.</p>
      <div class="grid2"><label>Engine<select>${M.ENGINES.map((e) => `<option>${e}</option>`).join("")}</select></label><label>Model override<input placeholder="Engine default"></label></div>
      <button class="btn primary block" disabled title="4 regions still need source, English, or approval" data-find="extract-terms">Extract series terms</button>
      <p class="warn small">${icon("bi-hourglass")} 4 regions still need review before extraction.</p></section>
    <section class="sec"><h3>From the last extraction</h3>
      ${[["斉藤英二郎", "Eijiro Saito", "name", "Protagonist, appears 14×"], ["一流", "first-rate", "term", "Recurring in chapter titles"]].map(([s, e, k, why]) => `<div class="mine"><strong>${s} → ${e}</strong><small>${k} · ${why}</small><div class="row"><button class="btn small accent" data-act="toast" data-msg="Added to the series glossary">Accept</button><button class="btn small ghost" data-act="toast" data-msg="Rejected">Reject</button></div></div>`).join("")}</section>
    <section class="sec"><h3>Series glossary <span class="scope">Series</span></h3><p class="muted small">${M.GLOSSARY.length} terms. <button class="link" data-act="settings" data-sec="guide">Edit in Settings → Translation guide</button></p></section>`;
}

/* ----- clean ----- */
function inspClean() {
  const p = page();
  const m = M.CLEAN_METHODS.find((x) => x.id === S.cleanMethod);
  const maskLabel = { none: "Not detected", "needs-approval": "Needs approval", approved: "Approved" }[p.mask];
  return `<section class="sec step-sec" data-find="clean-mask"><h3><span class="stepn">1</span> Mask the lettering <span class="chip ${p.mask === "approved" ? "chip-ok" : "chip-attn"}">${maskLabel}</span></h3>
      <div class="grid2"><label>Engine<select data-input="maskEngine"><option value="auto">Auto (Koharu when installed)</option><option>Koharu SAM-TS-L</option><option>CTD regions</option></select></label>
      <label>Padding (px)<input type="number" min="0" max="20" value="${S.padding}"></label></div>
      <div class="row"><button class="btn" data-act="clean-next" data-v="detect" data-find="detect-lettering">${icon("bi-magic")} Detect lettering</button>
        <button class="btn" data-act="clean-next" data-v="approve-mask" data-find="approve-mask" ${p.mask === "approved" && !S.strokes ? "disabled" : ""}>${icon("bi-check2")} Approve mask</button></div>
      <p class="muted small">Refine with ${toolLink("brush")}, ${toolLink("erase")} and ${toolLink("mask-grow")}. Committing brush edits approves the mask.</p>
      ${S.strokes ? `<div class="row small"><span>${S.strokes} draft strokes</span><button class="link" data-act="clear-strokes" data-find="clear-strokes">Clear draft strokes</button></div>` : ""}
      ${p.mask !== "none" ? `<div class="alert attn small">${icon("bi-flag")} Region 2: low contrast, touches the panel border. Check before cleaning.</div>` : ""}
    </section>
    <section class="sec step-sec" data-find="clean-method"><h3><span class="stepn">2</span> Remove it</h3>
      <div class="methods">${M.CLEAN_METHODS.map((x) => `<label class="method${x.unavailable ? " off" : ""}${x.id === S.cleanMethod ? " on" : ""}" title="${esc(x.unavailable || x.desc)}">
        <input type="radio" name="cm" data-act="clean-method" data-v="${x.id}" ${x.id === S.cleanMethod ? "checked" : ""} ${x.unavailable ? "disabled" : ""}>
        <span class="mdot" style="background:${x.color}"></span><span><b>${esc(x.label)}</b><small>${esc(x.unavailable ? `Unavailable · ${x.unavailable}` : x.desc)}</small></span></label>`).join("")}</div>
      ${S.cleanMethod === "clone" ? `<div class="grid2"><label>Offset X (px)<input type="number" value="${S.cloneX}"></label><label>Offset Y (px)<input type="number" value="${S.cloneY}"></label></div>` : ""}
      <button class="btn primary block" data-act="clean-next" data-v="clean-run" data-find="clean-run">${m.prompt ? "Write prompt & clean…" : `Clean with ${esc(m.label)}`}</button>
      <p class="muted small">Cleaning also approves the current mask. Last run: ${p.cleaned ? "Big-LaMa on GPU 0" : "none yet"}.</p></section>
    <section class="sec step-sec" data-find="clean-touchup"><h3><span class="stepn">3</span> Touch up</h3>
      <div class="touch">${["bubble-fill", "clone-stamp", "blur", "restore", "raw"].map((id) => `<button class="${S.tool === id ? "on" : ""}" data-act="tool" data-id="${id}">${icon(M.TOOLS[id].icon)}<span><b>${M.TOOLS[id].label}</b> <kbd>${M.TOOLS[id].key}</kbd><small>${esc(M.TOOLS[id].hint)}</small></span></button>`).join("")}</div></section>
    <section class="sec step-sec" data-find="clean-finish"><h3><span class="stepn">4</span> Finish</h3>
      <button class="btn primary block" data-act="clean-next" data-v="approve-clean" data-find="approve-clean">${icon("bi-check2-square")} ${p.cleaned ? "Approve cleaned page & next" : "Approve without cleaning & next"}</button>
      <button class="btn block" data-act="toast" data-msg="Result kept as the base for another pass; mask cleared" data-find="apply-pass" ${!p.cleaned ? "disabled" : ""}>${icon("bi-layers")} Keep result &amp; start another pass</button>
      <p class="muted small">Passes stack. The raw original never changes; Undo steps back one pass.</p>
      <div class="list-actions">
        <button data-act="modal" data-kind="compare" data-find="compare-region">${icon("bi-film")} Compare raw vs cleaned for a region…</button>
        <button data-act="toast" data-msg="Sample raw/clean pair saved" data-find="save-sample">${icon("bi-save")} Save sample raw / clean</button>
        <button data-act="confirm" data-kind="revert">${icon("bi-arrow-counterclockwise")} Revert to original raw</button>
      </div></section>
    <details class="sec hw"><summary>${icon("bi-gpu-card")} Hardware</summary><p class="muted small">Big-LaMa resident on GPU 0 (7900 XTX, ROCm). OCR/LLM on GPU 1. Codex: available. Qwen-Image-Edit 2511: weights not installed.</p></details>`;
}
const toolLink = (id) => `<button class="link" data-act="tool" data-id="${id}">${M.TOOLS[id].label} (${M.TOOLS[id].key})</button>`;

function inspShape(inClean) {
  const r = region();
  if (!r) return `<p class="empty">Select a region on the page to edit its bubble shape.</p>`;
  return `<section class="sec" data-find="bubble-shape"><h3>Bubble shape · region #${regionIndex(r)} <span class="chip ${r.geometryApproved ? "chip-ok" : "chip-attn"}">${r.geometryApproved ? "Approved" : "Needs approval"}</span></h3>
      <p class="muted small">The polygon the English is fitted into${inClean ? " (also used by balloon fill)" : ""}. Separate from the lettering box.</p>
      <div class="list-actions">
        <button data-act="run" data-msg="Fitting bubble with SAM" data-find="fit-bubble">${icon("bi-bounding-box-circles")} Fit bubble (SAM)</button>
        <button data-act="run" data-msg="Finding the enclosed interior">${icon("bi-crosshair")} Find enclosed interior</button>
        <button data-act="run" data-msg="Refining with SAM points">${icon("bi-record-circle")} Refine with SAM points</button>
        <button data-act="tool" data-id="polygon">${icon("bi-pentagon")} Trace polygon by hand</button>
        ${!inClean ? `<button data-act="tool" data-id="rectangle">${icon("bi-square")} Draw rectangle shape</button><button data-act="tool" data-id="oval">${icon("bi-circle")} Draw oval shape</button>` : ""}
        <button data-act="toast" data-msg="Polygon set to the region bounds">${icon("bi-bounding-box")} Set to region bounds</button>
      </div>
      <div class="row"><button class="btn accent" data-act="toast" data-msg="Geometry approved" data-find="approve-geometry">${icon("bi-check2")} Approve shape</button>
        <button class="btn ghost icon-only" title="Undo geometry">${icon("bi-arrow-counterclockwise")}</button><button class="btn ghost icon-only" title="Redo geometry">${icon("bi-arrow-clockwise")}</button></div></section>
    ${inClean ? `<section class="sec"><h3>This region</h3><div class="list-actions"><button data-act="modal" data-kind="compare">${icon("bi-film")} Compare raw vs cleaned…</button><button data-act="toast" data-msg="Rotation reset">${icon("bi-arrow-repeat")} Reset rotation</button></div></section>` : ""}`;
}

/* ----- typeset ----- */
function inspTypeset() {
  const r = region();
  const p = page();
  if (!r) {
    return `<p class="empty">Select a region to set its type.</p><div class="rlist">${p.regions.map((x) => `<button class="rrow" data-act="region" data-id="${x.id}"><span class="rnum" style="--c:${typeOf(x.type).color}">${regionIndex(x)}</span><span class="rtext"><b>${esc(trim(x.english || "—", 30))}</b><small>${x.layout ? `${x.layout.size} pt${x.layout.overflow ? " · overflow" : x.layout.stale ? " · stale" : ""}` : "not fitted"}</small></span></button>`).join("")}</div>`;
  }
  const t = S.tabs.typeset;
  const L = r.layout;
  if (t === "text")
    return `<section class="sec"><h3>Region #${regionIndex(r)} <span class="chip ${L?.overflow ? "chip-bad" : L?.stale ? "chip-attn" : L ? "chip-ok" : "chip-todo"}">${L?.overflow ? "Overflow" : L?.stale ? "Stale" : L ? "Fitted" : "Not fitted"}</span></h3>
        ${L?.overflow ? `<div class="alert bad">${icon("bi-exclamation-triangle")} Doesn't fit at the ${10} pt minimum. Shorten the English, lower the minimum, or enlarge the shape.</div>` : ""}
        <label>English · manual line breaks<textarea rows="4">${esc(r.english)}</textarea></label>
        <label>Region type<select>${M.TYPES.map((x) => `<option ${x.id === r.type ? "selected" : ""}>${x.label}</option>`).join("")}</select></label>
        <p class="muted small">Changing the type resets unlocked lettering to that type's style.</p>
        <div class="row"><button class="btn primary" data-act="run" data-msg="Region fitted" data-find="autofit-region" ${r.locked ? "disabled" : ""}>${icon("bi-textarea-resize")} Auto-fit</button>
          <button class="btn" data-act="toast" data-msg="${r.locked ? "Layout unlocked" : "Layout locked"}" data-find="lock-layout">${icon(r.locked ? "bi-unlock" : "bi-lock")} ${r.locked ? "Unlock" : "Lock"} layout</button>
          <button class="btn ghost" data-act="tool" data-id="style-brush">${icon("bi-brush-fill")} Copy style…</button></div></section>
      ${L ? `<section class="sec"><h3>Fitted result</h3><p class="small">${L.size} pt · ${L.dpi} DPI${L.hyphenated ? " · dictionary hyphenation" : ""}</p><pre class="rows">${L.rows.map(esc).join("\n")}</pre></section>` : ""}`;
  if (t === "style")
    return `<section class="sec" data-find="style"><div class="inherit">${icon("bi-diagram-2")} <span>Series · ${typeOf(r.type).label}</span>${icon("bi-chevron-right")}<span>Chapter · —</span>${icon("bi-chevron-right")}<b>This region · 2 overrides</b></div>
        <label>Font<select><option>CC Wild Words · Roman</option><option>Anime Ace 3 · Regular</option><option>Komika Text · Bold</option></select></label>
        <div class="grid2"><label>Size (pt)<input type="number" value="11" step=".25"></label><label>Minimum (pt)<input type="number" value="10" step=".25"></label>
        <label>Leading ×<input type="number" value="1.15" step=".05"></label><label>Padding (pt)<input type="number" value="4" step=".25"></label>
        <label>Alignment<select><option>center</option><option>left</option><option>right</option></select></label><label>Emphasis<select><option>normal</option><option>bold</option><option>italic</option></select></label></div>
        <label class="check"><input type="checkbox" checked> Automatic black / white contrast</label>
        <div class="grid2"><label>Fill<input type="color" value="#000000" disabled></label><label>Outline<input type="color" value="#ffffff"></label><label>Outline (pt)<input type="number" value="0" step=".25"></label></div>
      </section>
      <section class="sec"><h3>Transform</h3>
        <div class="grid2"><label>Rotation (°)<input type="number" value="0"></label><label>&nbsp;<button class="btn small ghost" data-act="toast" data-msg="Rotation reset">Reset rotation</button></label>
        <label>Skew H (°)<input type="number" value="0" min="-75" max="75"></label><label>Skew V (°)<input type="number" value="0" min="-75" max="75"></label>
        <label>Warp (Photoshop)<select>${["None", "Arc", "Arc Lower", "Arc Upper", "Arch", "Bulge"].map((w) => `<option>${w}</option>`).join("")}</select></label><label>Bend (%)<input type="number" value="0" min="-100" max="100" disabled></label></div>
        <button class="btn small ghost" data-act="toast" data-msg="Skew reset">Reset skew</button>
        <p class="muted small">Or drag the round handle to rotate and the diamond handles to skew on the canvas.</p></section>
      <section class="sec"><h3>Save this style</h3><p class="muted small">Changes above apply to this region immediately.</p>
        <div class="list-actions"><button data-act="toast" data-msg="Saved as this chapter's Dialogue style">${icon("bi-journal")} Use for all ${typeOf(r.type).label} in this chapter</button>
        <button data-act="toast" data-msg="Saved as the series Dialogue style">${icon("bi-collection")} Use for all ${typeOf(r.type).label} in the series</button>
        <button data-act="toast" data-msg="Reset to series style">${icon("bi-arrow-counterclockwise")} Reset region to series style</button>
        <button data-act="toast" data-msg="Loaded saved style">${icon("bi-download")} Reload saved style</button></div></section>`;
  return inspShape(false) + `<section class="sec" data-find="text-mask"><h3>Text mask</h3>
      <p class="muted small">Hide text that runs behind another balloon. White reveals, black conceals — the same as a Photoshop layer mask, and it's written into the PSD.</p>
      <div class="list-actions"><button data-act="run" data-msg="Overlapping regions knocked out" data-find="knockout">${icon("bi-front")} Knock out overlapping regions</button>
      <button data-act="tool" data-id="text-mask">${icon("bi-mask")} Paint the mask (B / E)</button>
      <button data-act="toast" data-msg="Text mask cleared" ${r.textMask ? "" : "disabled"}>${icon("bi-x-circle")} Clear text mask</button></div></section>`;
}

/* ---------- export ---------- */
function renderExport() {
  const groups = {};
  for (const i of M.READINESS) (groups[i.stage] ||= []).push(i);
  const fmts = [["png", "Finished PNG", "Lossless, native size"], ["jpg", "Finished JPG", "4:4:4, quality below"], ["psd", "Editable PSD", "One text layer per bubble"], ["clean", "Clean images", "No lettering"], ["bilingual", "Bilingual script", "Source + English"], ["english", "English script", "Text only"], ["json", "JSON with revisions", "Full chapter data"]];
  const scriptish = ["bilingual", "english", "json"].includes(S.exportFormat);
  const blocked = !S.draft && !scriptish;
  const matrix = M.pages.map((p) => `<tr><th>${p.n}</th>${["translate", "review", "clean", "typeset"].map((s) => `<td class="${p.done[s] ? "y" : "n"}">${p.done[s] ? icon("bi-check-lg") : "·"}</td>`).join("")}</tr>`).join("");
  return `<div class="export">
    <section class="ex-col">
      <h2>Ready to publish?</h2>
      <p class="muted">A finished image export needs every item below resolved and every page marked done in the four working steps. Draft ZIPs and scripts don't wait.</p>
      <div class="fixes" data-find="quick-fixes">
        <button class="btn" data-act="confirm" data-kind="approve-all">${icon("bi-check2-all")} Accept all translations <span class="badge">3</span></button>
        <button class="btn" data-act="run" data-msg="Approved geometry for 2 regions" data-find="approve-all-geometry">${icon("bi-bounding-box-circles")} Approve all geometry <span class="badge">2</span></button>
        <button class="btn" data-act="run" data-msg="Kept 1 stale layout">${icon("bi-pin-angle")} Keep current layouts <span class="badge">1</span></button>
        <button class="btn" data-act="confirm" data-kind="mark-all" disabled title="Only available when the remaining blockers are completion marks">${icon("bi-check-circle")} Mark every page done</button>
      </div>
      <div class="issues" data-find="readiness">${Object.entries(groups).map(([stage, list]) => `<h4>${icon(stageDef(stage).icon)} ${stageDef(stage).label}</h4>
        ${list.map((i) => `<button class="issue${i.severity === "warning" ? " warning" : ""}" data-act="goto-issue" data-stage="${i.stage}" data-page="${i.page ?? ""}"><span>${esc(i.msg)}</span><small>${i.page ? `Page ${i.page}` : "Chapter"}${i.regions ? ` · ${i.regions.join(", ")}` : ""}${i.count ? ` · ${i.count} pages` : ""}</small>${icon("bi-arrow-right-short")}</button>`).join("")}`).join("")}</div>
      <h4>Pages marked done</h4>
      <table class="matrix" data-find="matrix"><thead><tr><th></th><th>Translate</th><th>Review</th><th>Clean</th><th>Typeset</th></tr></thead><tbody>${matrix}</tbody></table>
    </section>
    <section class="ex-col">
      <div class="card" data-find="download"><h3>${icon("bi-file-zip")} Download</h3>
        <div class="fmts">${fmts.map(([id, l, d]) => `<label class="fmt${S.exportFormat === id ? " on" : ""}"><input type="radio" name="fmt" data-act="fmt" data-v="${id}" ${S.exportFormat === id ? "checked" : ""}><b>${l}</b><small>${d}</small></label>`).join("")}</div>
        ${S.exportFormat === "jpg" ? `<label>JPG quality<input type="number" min="1" max="100" value="${S.quality}"></label>` : ""}
        <label class="check"><input type="checkbox" ${S.includeMeta ? "checked" : ""} data-input="includeMeta"> Include metadata and scripts <small class="muted">(chapter JSON, font manifest, scripts, notes)</small></label>
        <label class="check"><input type="checkbox" ${S.draft ? "checked" : ""} data-input="draft" data-find="draft"> Label as draft <small class="muted">(skips readiness, file starts with DRAFT-)</small></label>
        <button class="btn primary block" ${blocked ? "disabled" : ""} data-act="run" data-msg="Building ZIP… it downloads automatically">${blocked ? `${icon("bi-lock")} Resolve ${blockers().length} blockers, or label as draft` : `${icon("bi-download")} Generate ZIP`}</button>
        <div class="latest">${icon("bi-check-circle")} Latest: <a href="#" data-act="toast" data-msg="Downloading">DRAFT-black-jack-ch1-png.zip</a> · 18.4 MB · starting a new export replaces it</div>
        <p class="muted small">PSDs keep editable text. Install the exact font versions from the manifest before editing. Single-page PSDs are in each page's menu.</p>
      </div>
      <div class="card" data-find="viewer"><h3>${icon("bi-globe2")} Public viewer</h3>
        <p class="muted small">Anyone with the link can read the chapter as it is now. They can't edit or see anything else. Pages show at export size.</p>
        ${S.viewer ? `<div class="row"><input class="grow" readonly value="https://komatose.local/p/7fQx2k9"><button class="btn small" data-act="toast" data-msg="Link copied">Copy</button><button class="btn small ghost" data-act="toast" data-msg="Opening viewer">Open</button></div>
          <div class="row"><button class="btn small ghost" data-act="toast" data-msg="Old link stopped working; new link created">New link</button><button class="btn small ghost danger" data-act="viewer" data-v="0">Disable</button></div>
          <p class="warn small">${icon("bi-info-circle")} Export issues remain; guests see the current typeset pages.</p>`
        : `<button class="btn primary" data-act="viewer" data-v="1">Enable public viewer</button>`}
      </div>
    </section></div>`;
}

/* ---------- jobs ---------- */
function renderJobs() {
  const running = M.JOBS.filter((j) => j.state === "running");
  const failed = M.JOBS.filter((j) => j.state === "failed").length;
  const head = `<div class="jobs-head">
    <button class="jobs-toggle" data-act="jobs" data-v="${S.jobs === "collapsed" ? "shown" : "collapsed"}" data-find="jobs">${icon(S.jobs === "collapsed" ? "bi-chevron-up" : "bi-chevron-down")} Jobs &amp; downloads</button>
    ${running.map((j) => `<span class="job-now"><span class="spin"></span><b>${j.kind} ${j.scope.toLowerCase()}</b> ${esc(j.message)}<span class="bar"><i style="width:${(j.done / j.total) * 100}%"></i></span></span>`).join("")}
    ${failed ? `<span class="job-fail">${icon("bi-x-circle")} ${failed} failed</span>` : ""}
    <span class="spacer"></span>
    <button class="link small" data-act="modal" data-kind="proofread">${icon("bi-chat-square-quote")} Open critique</button>
    <button class="link small" data-act="toast" data-msg="Downloading DRAFT-black-jack-ch1-png.zip">${icon("bi-download")} Latest ZIP</button>
    ${S.jobs !== "collapsed" ? `<button class="icon-btn" data-act="jobs" data-v="${S.jobs === "maximized" ? "shown" : "maximized"}" title="${S.jobs === "maximized" ? "Restore" : "Maximize"}">${icon(S.jobs === "maximized" ? "bi-fullscreen-exit" : "bi-arrows-fullscreen")}</button>` : ""}
  </div>`;
  if (S.jobs === "collapsed") return `<footer class="jobs">${head}</footer>`;
  const rows = M.JOBS.map((j) => `<div class="job ${j.state}"><span class="jstate">${j.state === "running" ? '<span class="spin"></span>' : icon(j.state === "failed" ? "bi-x-circle" : "bi-check-circle")}</span>
    <span class="jkind"><b>${j.kind}</b><small>${j.scope}</small></span><span class="jmsg">${esc(j.message)}</span>
    <span class="jact">${j.state === "running" ? `<button class="btn small">Cancel</button>` : ""}${j.state === "failed" ? `<button class="btn small accent">Retry unfinished</button>` : ""}${j.critique ? `<button class="btn small" data-act="modal" data-kind="proofread">Open critique</button>` : ""}${j.zip ? `<button class="btn small">Download</button>` : ""}<button class="btn small ghost">Log</button></span></div>`).join("");
  return `<footer class="jobs ${S.jobs}">${head}<div class="jobs-list">${rows}<div class="row"><span class="spacer"></span><button class="btn small ghost">Clear finished</button></div></div></footer>`;
}

/* ---------- menus ---------- */
function menuItem(label, act, extra = "", find = "") {
  return `<button role="menuitem" data-act="${act}" ${extra} ${find ? `data-find="${find}"` : ""}>${label}</button>`;
}
function renderMenu() {
  const m = S.menu;
  if (!m) return "";
  let inner = "";
  if (m.kind === "issues") {
    inner = `<div class="mh">Things to check <small>in working order</small></div>
      ${M.EXCEPTIONS.map((e, i) => `<button role="menuitem" data-act="goto-exc" data-i="${i}"><span class="chip chip-attn">${stageDef(e.stage).label}</span> ${e.kind} · p${e.page}${e.region ? ` #${regionIndex(findRegion(e.region))}` : ""}</button>`).join("")}
      <div class="mrule"></div><div class="mh">Blocking a finished export <b>${blockers().length}</b></div>
      ${menuItem(`${icon("bi-box-arrow-up")} Open the Export checklist`, "stage", 'data-id="export"')}`;
  } else if (m.kind === "view") {
    inner = `${menuItem(`${S.stripOpen ? icon("bi-check") : icon("bi-dot")} Pages panel`, "toggle-strip")}
      ${menuItem(`${S.inspOpen ? icon("bi-check") : icon("bi-dot")} Inspector panel`, "toggle-insp")}
      ${menuItem(`${S.jobs !== "collapsed" ? icon("bi-check") : icon("bi-dot")} Jobs panel`, "jobs", `data-v="${S.jobs === "collapsed" ? "shown" : "collapsed"}"`)}
      <div class="mrule"></div>
      ${menuItem(`${icon("bi-zoom-in")} Zoom in`, "zoom", 'data-d="1"')}${menuItem(`${icon("bi-zoom-out")} Zoom out`, "zoom", 'data-d="-1"')}${menuItem(`${icon("bi-aspect-ratio")} Fit page`, "zoom", 'data-d="0"')}
      <div class="mrule"></div>
      ${menuItem(`${icon("bi-palette")} Region types &amp; colours…`, "settings", 'data-sec="colors"', "region-colors")}
      ${menuItem(`${icon("bi-keyboard")} Keyboard shortcuts`, "modal", 'data-kind="keys"')}
      ${menuItem(`${icon("bi-arrow-clockwise")} Rebuild app (admin)`, "toast", 'data-msg="Saving drafts, then rebuilding"')}
      <div class="mrule"></div>
      ${menuItem(`${icon("bi-lightbulb")} Mockup design notes`, "notes")}
      ${menuItem(`${icon("bi-exclamation-octagon")} Mockup: show a save conflict`, "conflict", 'data-v="demo"')}`;
  } else if (m.kind === "translate-model") {
    inner = `<div class="mh">Translation model · this chapter</div>${M.ENGINES.map((e, i) => menuItem(`${i === 0 ? icon("bi-check") : icon("bi-dot")} ${e}`, "toast", `data-msg="Translation model set to ${e}"`)).join("")}
      <div class="mrule"></div>${menuItem(`${icon("bi-sliders")} All AI models for this chapter…`, "settings", 'data-sec="models"')}`;
  } else if (m.kind === "more") {
    inner = moreItems();
  } else if (m.kind === "page") {
    inner = pageMenu(m);
  } else if (m.kind === "region") {
    inner = regionMenu(m);
  }
  return `<div class="menu-backdrop" data-act="close-menu"></div><div class="menu" role="menu" style="left:${m.x}px;top:${m.y}px">${inner}</div>`;
}

function moreItems() {
  const p = page();
  if (S.stage === "prepare")
    return `${menuItem(`${icon("bi-arrow-counterclockwise")} Undo page edit (2)`, "toast", 'data-msg="Page edit undone"', "undo-page-edit")}
      ${menuItem(`${icon("bi-sort-numeric-down")} Renumber pages`, "renumber")}
      ${menuItem(`${icon("bi-award")} Add series credits to this chapter`, "run", 'data-msg="Credits added"')}
      ${menuItem(`${icon("bi-sliders")} Chapter language, direction, DPI…`, "settings", 'data-sec="chapter"')}
      ${menuItem(`${icon("bi-cpu")} Description model…`, "settings", 'data-sec="models" data-models="description"')}`;
  if (S.stage === "translate")
    return `<div class="mh">Fix a specific problem · ${scopeLabel()}</div>
      ${menuItem(`${icon("bi-spellcheck")} Proofread edited English`, "run", `data-msg="Proofreading ${scopeLabel()}"`, "proofread-translate")}
      ${menuItem(`${icon("bi-eye")} Retry uncertain image reading`, "run", `data-msg="Rereading missing and low-confidence regions on ${scopeLabel()}. This can replace text."`, "reread")}
      ${menuItem(`${icon("bi-card-text")} Refresh scene context`, "run", `data-msg="Regenerating scene notes for ${scopeLabel()}"`)}
      <div class="mrule"></div>
      ${menuItem(`${icon("bi-eraser")} Remove blank regions in chapter (2)`, "confirm", 'data-kind="remove-blanks"', "remove-blanks")}
      ${menuItem(`${icon("bi-trash")} Remove all regions on page ${p.n}…`, "confirm", 'data-kind="remove-regions"', "remove-regions")}
      <div class="mrule"></div>
      ${menuItem(`${icon("bi-sliders")} Detection &amp; AI model settings…`, "settings", 'data-sec="detection"')}`;
  if (S.stage === "review")
    return `${menuItem(`${icon("bi-journal-bookmark")} Extract series terms…`, "tab", 'data-v="glossary"')}
      ${menuItem(`${icon("bi-people")} Source reviewers…`, "settings", 'data-sec="models" data-models="reviewers"')}
      ${menuItem(`${icon("bi-eye")} Retry uncertain image reading`, "run", `data-msg="Rereading on ${scopeLabel()}"`)}`;
  if (S.stage === "clean")
    return `${menuItem(`${icon("bi-save")} Save sample raw / clean`, "toast", 'data-msg="Sample saved"')}
      ${menuItem(`${icon("bi-film")} Compare raw vs cleaned for a region…`, "modal", 'data-kind="compare"')}
      ${menuItem(`${icon("bi-arrow-counterclockwise")} Revert page to original raw`, "confirm", 'data-kind="revert"')}`;
  if (S.stage === "typeset")
    return `${menuItem(`${icon("bi-arrow-counterclockwise")} Reset ${scopeLabel()} text to series defaults`, "confirm", 'data-kind="reset-styles"', "reset-styles")}
      ${menuItem(`${icon("bi-clipboard")} Copy raw image`, "toast", `data-msg="Raw page ${p.n} copied"`)}
      ${menuItem(`${icon("bi-clipboard-check")} Copy typeset image`, "toast", `data-msg="Typeset page ${p.n} copied"`)}
      ${menuItem(`${icon("bi-chat-square-quote")} Page proofreader (raw + typeset)…`, "modal", 'data-kind="proofread"')}
      ${menuItem(`${icon("bi-fonts")} Series type settings…`, "settings", 'data-sec="typography"')}
      ${menuItem(`${icon("bi-file-earmark-richtext")} Export page ${p.n} PSD (draft)`, "toast", 'data-msg="Downloading page PSD"')}`;
  return "";
}

function pageMenu(m) {
  const p = M.pages[m.page];
  const groups = {
    prepare: ["Page", [
      ["bi-pencil-square", "Open in Prepare", "open-page", `data-i="${m.page}"`],
      ["bi-crop", "Crop…", "tool-at", 'data-id="crop"'], ["bi-vr", "Split…", "tool-at", 'data-id="split"'], ["bi-hr", "Reslice strips…", "tool-at", 'data-id="reslice"'],
      ["bi-bounding-box", "Auto-crop margins", "run", 'data-msg="Auto-cropped"'], ["bi-arrow-repeat", "Replace from image / PSD…", "toast", 'data-msg="Choose a file"'],
      ["bi-box-arrow-in-left", "Insert images before…", "toast", 'data-msg="Choose images"'], ["bi-box-arrow-in-right", "Insert images after…", "toast", 'data-msg="Choose images"'],
      ["bi-arrow-up-short", "Move earlier", "move-page", 'data-d="-1"'], ["bi-arrow-down-short", "Move later", "move-page", 'data-d="1"'],
      ["bi-arrow-counterclockwise", "Revert to original raw", "confirm", 'data-kind="revert"'], ["bi-trash", "Delete page…", "confirm", 'data-kind="delete-page"'],
    ]],
    text: ["Text", [
      ["bi-chat-square-text", "Transcribe page", "run", 'data-msg="Transcribing page"'], ["bi-translate", "Translate page", "run", 'data-msg="Translating page"'],
      ["bi-plus-square", "Fill missing source & English", "run", 'data-msg="Filling missing"'], ["bi-spellcheck", "Proofread edited English", "run", 'data-msg="Proofreading page"'],
      ["bi-eye", "Retry uncertain image reading", "run", 'data-msg="Rereading"'], ["bi-card-text", "Refresh scene context", "run", 'data-msg="Describing"'],
      ["bi-trash", "Remove all regions…", "confirm", 'data-kind="remove-regions"'],
    ]],
    clean: ["Clean", [
      ["bi-magic", "Detect lettering", "clean-next", 'data-v="detect"'], ["bi-check2", "Approve mask", "clean-next", 'data-v="approve-mask"'],
      ["bi-x-lg", "Clear draft strokes", "clear-strokes", ""], ["bi-stars", "Clean with selected method", "clean-next", 'data-v="clean-run"'],
      ["bi-layers", "Keep result & start another pass", "toast", 'data-msg="New pass started"'], ["bi-check2-square", "Approve cleaned page", "clean-next", 'data-v="approve-clean"'],
      ["bi-save", "Save sample raw / clean", "toast", 'data-msg="Saved"'],
    ]],
    typeset: ["Typeset", [
      ["bi-textarea-resize", "Auto-fit all text on page", "run", 'data-msg="Fitting page"'], ["bi-bounding-box-circles", "Find & fit bubbles on page", "run", 'data-msg="Finding bubbles"'],
      ["bi-arrow-counterclockwise", "Reset page to series defaults", "confirm", 'data-kind="reset-styles"'],
    ]],
    export: ["Export", [["bi-file-earmark-richtext", "Export page PSD (draft)", "toast", 'data-msg="Downloading PSD"']]],
  };
  const current = S.stage === "review" || S.stage === "translate" ? "text" : S.stage === "export" ? "export" : S.stage;
  const order = [current, ...Object.keys(groups).filter((k) => k !== current)];
  return `<div class="mh">Page ${p.n}</div>` + order.map((k, i) => {
    const [title, items] = groups[k];
    const body = items.map(([ic, l, act, extra]) => menuItem(`${icon(ic)} ${l}`, act, extra)).join("");
    return i === 0 ? `<div class="msub">${title}</div>${body}` : `<div class="flyout"><button role="menuitem" class="has-sub">${title}${icon("bi-chevron-right")}</button><div class="menu sub">${body}</div></div>`;
  }).join("");
}

function regionMenu(m) {
  const r = findRegion(m.region);
  const groups = {
    text: ["Text", [
      ["bi-people", "AI Review…", "modal", 'data-kind="ai-review"'], ["bi-magic", "Revise English…", "modal", 'data-kind="revise"'],
      ["bi-lightbulb", "Suggest alternative", "run", 'data-msg="Asking for an alternative"'], ["bi-chat-dots", "Enquire…", "modal", 'data-kind="enquire"'],
      ["bi-eye", "Read this area again with AI", "run", 'data-msg="Rereading the crop with the image model; result becomes a draft"'],
      ["bi-check2", "Approve English", "toast", 'data-msg="Approved"'], ["bi-flag", "Mark needs work", "toast", 'data-msg="Marked needs work"'],
      ["bi-1-circle", "Set as region 1", "toast", 'data-msg="Moved to #1"'], ["bi-slash-circle", "Ignore region…", "confirm", 'data-kind="ignore"'],
    ]],
    shape: ["Bubble shape", [
      ["bi-bounding-box-circles", "Fit bubble", "run", 'data-msg="Fitting bubble"'], ["bi-crosshair", "Find enclosed interior", "run", 'data-msg="Finding interior"'],
      ["bi-check2", "Approve geometry", "toast", 'data-msg="Geometry approved"'], ["bi-film", "Compare raw vs cleaned…", "modal", 'data-kind="compare"'],
      ["bi-arrow-repeat", "Reset rotation", "toast", 'data-msg="Rotation reset"'],
    ]],
    typeset: ["Typeset", [
      ["bi-textarea-resize", "Typeset this region", "run", 'data-msg="Fitting region"'], ["bi-lock", r?.locked ? "Unlock layout" : "Lock layout", "toast", 'data-msg="Layout lock toggled"'],
      ["bi-distribute-horizontal", "Reset skew", "toast", 'data-msg="Skew reset"'], ["bi-front", "Knock out overlapping regions", "run", 'data-msg="Knocked out"'],
      ["bi-x-circle", "Clear text mask", "toast", 'data-msg="Cleared"'],
    ]],
  };
  const current = S.stage === "clean" ? "shape" : S.stage === "typeset" ? "typeset" : "text";
  const order = [current, ...Object.keys(groups).filter((k) => k !== current)];
  const types = M.TYPES.map((t) => menuItem(`<span class="swatch" style="background:${t.color}"></span>${t.label}${t.id === r.type ? " ✓" : ""}`, "toast", `data-msg="Region type set to ${t.label}"`)).join("");
  return `<div class="mh">Region #${regionIndex(r)} · page ${pageOf(r.id).n}</div>` + order.map((k, i) => {
    const [title, items] = groups[k];
    const body = items.map(([ic, l, act, extra]) => menuItem(`${icon(ic)} ${l}`, act, extra)).join("");
    return i === 0 ? `<div class="msub">${title}</div>${body}` : `<div class="flyout"><button role="menuitem" class="has-sub">${title}${icon("bi-chevron-right")}</button><div class="menu sub">${body}</div></div>`;
  }).join("") + `<div class="mrule"></div>
    <div class="flyout"><button role="menuitem" class="has-sub">${icon("bi-tag")} Region type${icon("bi-chevron-right")}</button><div class="menu sub">${types}</div></div>
    ${menuItem(`${icon("bi-arrows-angle-contract")} Bounds, split &amp; merge`, "subtab-open", 'data-v="details"')}
    ${menuItem(`${icon("bi-chat-left-text")} Comments &amp; corrections`, "subtab-open", 'data-v="comments"')}
    ${menuItem(`${icon("bi-clipboard")} Copy source`, "toast", 'data-msg="Source copied"')}${menuItem(`${icon("bi-clipboard")} Copy English`, "toast", 'data-msg="English copied"')}
    <div class="mrule"></div>${menuItem(`${icon("bi-trash")} Delete region…`, "confirm", 'data-kind="delete-region"')}`;
}

/* ---------- settings drawer ---------- */
const SETTINGS = [
  ["chapter", "Chapter", "bi-journal", "This chapter"],
  ["detection", "Text detection", "bi-bounding-box-circles", "This chapter"],
  ["models", "AI models", "bi-cpu", "Series"],
  ["guide", "Translation guide", "bi-book", "Chapter + series"],
  ["typography", "Typography", "bi-fonts", "Series"],
  ["colors", "Region types & colours", "bi-palette", "Series + just you"],
  ["credits", "Series credits", "bi-award", "Series"],
];
function renderSettings() {
  if (!S.settings) return "";
  const [id, label, ic, scope] = SETTINGS.find((s) => s[0] === S.settings);
  return `<div class="drawer-backdrop" data-act="settings-close"></div>
  <aside class="drawer" aria-label="Settings">
    <header><h2>${icon("bi-sliders")} Settings</h2><span class="muted small">Everything that shapes how this chapter is processed, in one place</span><button class="icon-btn" data-act="settings-close">${icon("bi-x-lg")}</button></header>
    <div class="drawer-body">
      <nav>${SETTINGS.map(([sid, l, i, sc]) => `<button class="${sid === id ? "on" : ""}" data-act="settings" data-sec="${sid}" data-find="set-${sid}">${icon(i)}<span>${l}<small>${sc}</small></span></button>`).join("")}</nav>
      <div class="drawer-main"><h3>${icon(ic)} ${label} <span class="scope">${scope}</span></h3>${settingsBody(id)}</div>
    </div></aside>`;
}
function settingsBody(id) {
  if (id === "chapter")
    return `<div class="grid2"><label>Source language<select><option>Japanese</option><option>Korean</option></select></label>
      <label>Reading direction<select><option>Right to left</option><option>Left to right</option></select></label>
      <label>DPI override<input type="number" placeholder="Imported density, otherwise 72"></label></div>
      <p class="muted small">Choosing Korean switches the direction to left-to-right. DPI converts point sizes to pixels for typesetting.</p>
      <button class="btn primary">Save chapter settings</button>`;
  if (id === "detection")
    return `<label>Text detector<select>${M.DETECTORS.map((d) => `<option ${d.includes("RT-DETR") ? "disabled" : ""}>${d}${d.includes("RT-DETR") ? " (needs COO)" : ""}</option>`).join("")}</select></label>
      <label>Detection confidence<input type="number" min="0.05" max="0.9" step="0.05" placeholder="0.20 (default)"></label>
      <label class="check"><input type="checkbox"> Transcribe lettering that's already English</label>
      <div class="explain"><p>Detection finds the boxes; it doesn't use the translation model. <b>Default</b> follows Admin → Models → Jobs &amp; defaults.</p>
      <p>Raise confidence if flames, empty space or art get boxed as text — manhwa often wants 0.35–0.45. Overlapping boxes that repeat the same lettering collapse into one region.</p></div>`;
  if (id === "models") {
    const tabs = [["profiles", "Profiles"], ["translation", "Translation"], ["transcription", "Transcription"], ["vision", "Vision / Read area"], ["description", "Scene description"], ["proofreading", "Proofreading"], ["enquire", "Enquire"], ["reviewers", "Source reviewers"]];
    const row = (label, i = 0) => `<div class="grid2"><label>${label} engine<select>${M.ENGINES.map((e, n) => `<option ${n === i ? "selected" : ""}>${e}</option>`).join("")}</select></label><label>Model override<input placeholder="Engine default"></label></div>`;
    const bodies = {
      profiles: `<label>Saved profile<select><option>Local only (fast)</option><option>Local + Grok review</option></select></label><label>Profile name<input value="Local only (fast)"></label><div class="row"><button class="btn small">Load</button><button class="btn small">Save as profile</button><button class="btn small ghost">Delete</button></div>`,
      translation: `${row("Translation")}<p class="muted small">Used by Translate, Fill missing, and to translate a corrected source.</p>`,
      transcription: `<p class="muted small">Models that read each region. A strict plurality fills the source; disagreements become suggestions.</p>${["Hayai OCR v2", "PaddleOCR-VL-1.6", "Qwen3-VL-8B", "Grok CLI (billed)"].map((m, i) => `<label class="check"><input type="checkbox" ${i < 2 ? "checked" : ""}> ${m}</label>`).join("")}`,
      vision: `${row("Vision", 3)}<p class="muted small">Used by Read area and Read this area again. Pick an image-capable model.</p>`,
      description: `${row("Description", 3)}<p class="muted small">Writes scene notes only — never lettering.</p>`,
      proofreading: `${row("Proofreading", 5)}<p class="muted small">Proofread edited English, and the page proofreader (raw + typeset images).</p>`,
      enquire: `${row("Enquire default", 4)}`,
      reviewers: `<p class="muted small">1–5 reviewers read the crop independently in AI Review. Billed ones wait for you to press Run.</p>${["Hayai OCR v2", "PaddleOCR-VL-1.6", "Qwen3-VL-8B", "Grok CLI · billed"].map((m, i) => `<div class="row"><span class="grow">Reviewer ${i + 1}: <b>${m}</b></span><button class="icon-btn" title="Remove">${icon("bi-x")}</button></div>`).join("")}<button class="btn small">${icon("bi-plus")} Add reviewer</button>`,
    };
    return `<div class="subtabs">${tabs.map(([t, l]) => `<button class="${S.modelsTab === t ? "on" : ""}" data-act="models-tab" data-v="${t}">${l}</button>`).join("")}</div><div class="pad">${bodies[S.modelsTab]}</div><button class="btn primary">Save AI model settings</button>`;
  }
  if (id === "guide")
    return `<h4>Chapter guidance <span class="scope">This chapter</span></h4>
      <label>Character aliases<textarea rows="3" placeholder="Source name → preferred English name">斉藤 → Saito\n出久根 → Dekune</textarea></label>
      <label>Translation preferences<textarea rows="3" placeholder="Voice, register, honorifics, terminology…">Keep honorifics. Medical terms in plain English. Speaker at graduation: formal, rousing.</textarea></label>
      <div class="row"><button class="btn primary small">Save as chapter defaults</button><button class="btn small ghost">Load saved defaults</button></div>
      <h4>Series glossary <span class="scope">Series</span></h4>
      <p class="muted small">Terms appear as chips under the source when they occur, and go with every translation request.</p>
      <table class="gloss"><thead><tr><th>Source</th><th>English</th><th>Kind</th><th></th></tr></thead><tbody>${M.GLOSSARY.map((g) => `<tr><td><input value="${esc(g.source)}"></td><td><input value="${esc(g.english)}"></td><td><select><option>${g.kind}</option></select></td><td><button class="icon-btn">${icon("bi-x")}</button></td></tr>`).join("")}</tbody></table>
      <div class="row"><button class="btn small">${icon("bi-plus")} Add term</button><span class="spacer"></span><button class="link small" data-act="settings-close-to" data-stage="review" data-tab="glossary">Extract terms from this chapter →</button></div>`;
  if (id === "typography")
    return `<h4>Fonts <span class="scope">Series</span></h4>
      <div class="fonts">${["CC Wild Words · Roman", "CC Wild Words · Italic", "Anime Ace 3 · Regular", "Komika Text · Bold"].map((f) => `<div class="font"><span style="font-family:'Comic Sans MS',cursive">Aa</span><b>${f}</b><small>OTF · v2</small></div>`).join("")}</div>
      <div class="row"><button class="btn small">${icon("bi-upload")} Upload TTF / OTF</button><button class="link small">Shared font library ↗</button></div>
      <h4>Style per region type</h4>
      <table class="gloss"><thead><tr><th>Type</th><th>Font</th><th>Size / min</th><th></th></tr></thead><tbody>${M.TYPES.slice(0, 7).map((t) => `<tr><td><span class="swatch" style="background:${t.color}"></span>${t.label}</td><td><select><option>CC Wild Words · Roman</option></select></td><td>12 / 10 pt</td><td><button class="link small">Edit</button></td></tr>`).join("")}</tbody></table>
      <div class="row"><button class="btn small ghost">Apply one style to all types</button></div>
      <p class="muted small">Region and chapter overrides are set in Typeset → Style. Chapter-wide resets live in Typeset → More.</p>`;
  if (id === "colors")
    return `<p class="muted small">Series types are shared by everyone on the series. <b>Your colour</b> overrides only what you see.</p>
      <table class="gloss"><thead><tr><th>ID</th><th>Name</th><th>Series colour</th><th>Your colour</th><th></th></tr></thead><tbody>${M.TYPES.map((t) => `<tr><td><code>${esc(t.id)}</code></td><td><input value="${t.label}"></td><td><input type="color" value="${t.color}"></td><td><input type="color" value="${t.color}"></td><td><button class="icon-btn" title="Remove from series">${icon("bi-x")}</button></td></tr>`).join("")}</tbody></table>
      <div class="row"><button class="btn small">${icon("bi-plus")} Add type</button><button class="btn small ghost">Reset to built-in types</button></div>`;
  if (id === "credits") {
    const c = M.series.credits;
    return `<p class="muted small">Optional first and last pages saved on the series. Credits don't need regions, cleaning or typesetting to export.</p>
      ${["pre", "post"].map((k) => `<div class="credit"><div class="credit-img">${icon("bi-award")}</div><div><strong>${k === "pre" ? "Pre-credits" : "Post-credits"}</strong><small>${esc(c[k].name)} · ${c[k].size}</small></div><button class="btn small">Replace</button><button class="btn small ghost">Remove</button></div>`).join("")}
      <button class="btn primary" data-act="run" data-msg="Credits added">Add credits to this chapter</button>`;
  }
  return "";
}

/* ---------- command palette ---------- */
function paletteResults() {
  const words = S.paletteQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const list = window.CATALOG.filter((a) => {
    const hay = `${a.label} ${a.where} ${a.old || ""} ${a.k || ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  return list.slice(0, 60);
}
function renderPalette() {
  if (!S.palette) return "";
  const res = paletteResults();
  S.paletteIndex = Math.min(S.paletteIndex, Math.max(0, res.length - 1));
  return `<div class="drawer-backdrop" data-act="palette-close"></div>
    <div class="palette" role="dialog" aria-label="Find an action">
      <div class="pal-input">${icon("bi-search")}<input id="pal-q" placeholder="Find any action or setting… e.g. “reslice”, “glossary”, “mark complete”" value="${esc(S.paletteQuery)}" data-input="palette" autocomplete="off"><kbd>Esc</kbd></div>
      <div class="pal-list">${res.map((a, i) => `<button class="${i === S.paletteIndex ? "on" : ""}" data-act="palette-go" data-i="${window.CATALOG.indexOf(a)}">
        <span class="pal-l">${esc(a.label)}</span><span class="pal-w">${esc(a.where)}</span>${a.old ? `<span class="pal-o">was: ${esc(a.old)}</span>` : ""}</button>`).join("") || `<p class="empty">No match.</p>`}</div>
      <div class="pal-foot">${window.CATALOG.length} actions indexed · ↑↓ to move · Enter to go there</div>
    </div>`;
}

/* ---------- modals ---------- */
function renderModal() {
  const m = S.modal;
  if (!m) return "";
  const r = region() || page().regions[0];
  const crop = r ? `background-image:url(${page().src});background-size:${100 / r.w}% ${100 / r.h}%;background-position:${(r.x / (1 - r.w)) * 100}% ${(r.y / (1 - r.h)) * 100}%;aspect-ratio:${(r.w * 1414) / (r.h * 2000)}` : "";
  let title = "";
  let body = "";
  let wide = false;
  if (m.kind === "ai-review") {
    wide = true;
    title = `AI Review · region #${r ? regionIndex(r) : ""}`;
    body = `<div class="review-grid"><div class="crop-col"><div class="crop-img" style="${crop}"><div class="crop-mask"></div></div>
        <label class="check"><input type="checkbox" checked> Mask crop with detected text</label><div class="row"><button class="btn small">${icon("bi-brush")} Brush</button><button class="btn small">${icon("bi-eraser")} Erase</button></div>
        <p class="muted small">Current: <span lang="ja">${esc(r?.source || "—")}</span></p>
        <button class="btn primary block">Send to local reviewers</button></div>
      <div class="rev-cols">${[["Hayai OCR v2", "毎年８千人が全国に81ある大学医学部を卒業してゆく", "Every year, eight thousand graduate from the 81 medical schools in the country.", "match"], ["PaddleOCR-VL-1.6", "毎年８千人が全国に81ある大学医学部を卒業してゆく", "Each year 8,000 people graduate from the nation's 81 medical schools.", "match"], ["Qwen3-VL-8B", "", "", "wait"], ["Grok CLI · billed", "", "", "idle"]].map(([n, s, e, st]) => `<div class="rev ${st}"><h4>${n}${st === "match" ? ' <span class="chip chip-ok">matches 1 other</span>' : ""}</h4>
        ${st === "wait" ? `<p class="muted"><span class="spin"></span> Waiting…</p>` : st === "idle" ? `<p class="muted small">Billed models wait for you.</p><button class="btn small">Run</button>` : `<p lang="ja">${s}</p><p class="sugg-en">${e}</p><button class="btn small accent">Use source &amp; English</button>`}</div>`).join("")}</div></div>`;
  } else if (m.kind === "revise") {
    wide = true;
    title = `Revise English · region #${r ? regionIndex(r) : ""}`;
    body = `<p class="muted small">Text-only council: sends the source, current English, nearby lines, scene notes and matching glossary terms — never the image.</p>
      <div class="rev-cols">${[["Sugoi v4", "You are the ones who will carry medicine in Japan!!"], ["Hy-MT 1.5 · sample 1", "It is you who will shoulder Japan's medicine!!"], ["Hy-MT 1.5 · sample 2", "The future of Japanese medicine rests on your shoulders!!"], ["Codex CLI · billed", ""]].map(([n, e]) => `<div class="rev${e ? "" : " idle"}"><h4>${n}</h4>${e ? `<p class="sugg-en">${e}</p><button class="btn small accent">Use this</button>` : `<button class="btn small">Run</button>`}</div>`).join("")}</div>
      <div class="row"><button class="btn small ghost">${icon("bi-plus")} Add a translator for this session</button></div>`;
  } else if (m.kind === "enquire") {
    wide = true;
    title = `Enquire · region #${r ? regionIndex(r) : ""}`;
    body = `<div class="enq"><div class="enq-ctx"><h4>Context to send</h4>${[["Page summary", 1], ["Region", 1], ["Series summary", 1], ["Region image", 0], ["Page image", 0], ["Chapter summaries", 0]].map(([l, c]) => `<label class="check"><input type="checkbox" ${c ? "checked" : ""}> ${l}</label>`).join("")}
        <label>Model<select>${M.ENGINES.map((e) => `<option>${e}</option>`).join("")}</select></label><button class="btn small ghost block">New conversation / change context</button></div>
      <div class="enq-chat"><div class="msg me">Is “carry … on your shoulders” too literal for 背負っていく here?</div>
        <div class="msg ai">It's a common idiom meaning to take on responsibility. “It's you who will carry Japanese medicine forward” keeps the weight without the image.
        <div class="card-mini"><b>English replacement</b><p>It's you who will carry Japanese medicine forward!!</p><div class="row"><button class="btn small accent">Use</button><button class="btn small ghost">Reject</button></div></div></div>
        <div class="row"><input class="grow" placeholder="Ask about this region…"><button class="btn primary small">Send</button></div></div></div>`;
  } else if (m.kind === "compare") {
    title = `Compare raw vs cleaned · region #${r ? regionIndex(r) : ""}`;
    body = `<div class="cmp"><div class="crop-img anim" style="${crop}"></div></div><p class="muted small">Alternates raw and cleaned every 0.5 s. Share the animated image without flattening it.</p>
      <div class="row"><select><option>APNG</option><option>GIF</option></select><button class="btn small">${icon("bi-download")} Save image</button><button class="btn small ghost">${icon("bi-link-45deg")} Copy link</button></div>`;
  } else if (m.kind === "proofread") {
    wide = true;
    title = `Page proofreader · page ${page().n}`;
    body = `<div class="enq"><div class="enq-ctx"><h4>Sent</h4><div class="thumbs2"><img src="${page().src}" alt=""><div class="t2">typeset</div></div><p class="muted small">Proofreading model · keeps one conversation per proofreader, so later pages reuse context.</p></div>
      <div class="enq-chat"><div class="msg ai"><b>Summary:</b> Lettering reads well. Bubble 1 is cramped — consider a shorter line. “Carry the future of medicine” repeats the page 3 narration rhythm nicely.<br><br><b>Issues</b><br>• #1 overflow at 10 pt.<br>• #2 title: “The Intern's Night” — check series glossary for 研修医.</div>
        <div class="row"><input class="grow" placeholder="Follow-up question, or paste an image"><button class="btn small ghost">Attach working draft</button><button class="btn primary small">Send follow-up</button></div></div></div>`;
  } else if (m.kind === "clean-prompt") {
    const cm = M.CLEAN_METHODS.find((x) => x.id === S.cleanMethod);
    title = `${cm.label} · prompt`;
    body = `<label>Notes for this page<textarea rows="3" placeholder="e.g. redraw the missing finger on the raised fist; keep the screentone"></textarea></label>
      <details><summary>Reconstruction instructions</summary><textarea rows="4">Remove the masked lettering and reconstruct the artwork behind it in the same style. Keep everything outside the mask unchanged.</textarea></details>
      <div class="grid2"><label>Steps<input type="number" value="20"></label><label>Seed<input type="number" placeholder="random"></label></div>
      <div class="row"><span class="spacer"></span><button class="btn ghost" data-act="modal-close">Cancel</button><button class="btn primary" data-act="clean-done">Clean</button></div>`;
  } else if (m.kind === "keys") {
    title = "Keyboard shortcuts";
    body = `<table class="keys">${[["Ctrl K", "Find an action"], ["V", "Select"], ["R", "Draw region (Translate, Review)"], ["O", "Reorder reading flow"], ["B / E", "Mask brush / erase (Clean, Typeset text mask)"], ["G", "Grow mask"], ["F", "Fill speech bubble"], ["C", "Clone stamp"], ["L", "Blur"], ["H", "Restore"], ["S", "Paint raw"], ["Z", "Zoom"], ["Ctrl Z / Ctrl Shift Z", "Undo / redo saved edit"], ["Delete", "Delete selected region"], ["Enter", "Save polygon"], ["Esc", "Cancel tool / close"]].map(([k, v]) => `<tr><td><kbd>${k}</kbd></td><td>${v}</td></tr>`).join("")}</table>`;
  } else if (m.kind === "confirm") {
    const c = CONFIRMS[m.what];
    title = c.title;
    body = `<p>${c.body}</p>${c.input ? `<label>${c.input}<input value="${c.value || ""}" autofocus></label>` : ""}
      <div class="row"><span class="spacer"></span><button class="btn ghost" data-act="modal-close">Cancel</button><button class="btn ${c.danger ? "danger-solid" : "primary"}" data-act="confirm-ok" data-msg="${esc(c.done)}">${c.ok}</button></div>`;
  }
  return `<div class="modal-backdrop" data-act="modal-close"></div><div class="modal${wide ? " wide" : ""}" role="dialog"><header><h2>${title}</h2><button class="icon-btn" data-act="modal-close">${icon("bi-x-lg")}</button></header><div class="modal-body">${body}</div></div>`;
}
const CONFIRMS = {
  "approve-all": { title: "Accept all translations?", body: "Every region that already has English is approved and leftover suggestions are dropped. Regions with empty English stay as blockers.", ok: "Accept 3 translations", done: "Accepted 3 translations" },
  extract: { title: "Extract to a new chapter", body: "Copies the selected pages, in reading order, into a new chapter in this series — text, cleaning, typesetting, approvals and history included. The pages also stay here.", input: "Chapter number", value: "1.5", ok: "Extract pages", done: "Copied pages to chapter 1.5 · Open chapter 1.5" },
  "delete-pages": { title: "Delete selected pages?", body: "Removes their regions, comments, cleaning and typesetting.", ok: "Delete pages", danger: true, done: "Pages deleted" },
  "delete-page": { title: "Delete this page?", body: "Removes its regions, comments, cleaning and typesetting.", ok: "Delete page", danger: true, done: "Page deleted" },
  "delete-region": { title: "Delete this region?", body: "It has source or English text. Empty regions delete without asking.", ok: "Delete region", danger: true, done: "Region deleted" },
  revert: { title: "Revert to the original raw?", body: "The page goes back to the uploaded file. Cleaning passes are dropped (undoable).", ok: "Revert", danger: true, done: "Reverted to original raw" },
  ignore: { title: "Ignore this region", body: "Ignored regions stay visible but don't need source, English, cleaning or fitting.", input: "Reason", value: "", ok: "Ignore region", done: "Region ignored" },
  "remove-blanks": { title: "Remove blank regions?", body: "Removes 2 regions with no source, no English and no pending source suggestions, across the chapter.", ok: "Remove 2 regions", danger: true, done: "Removed 2 blank regions" },
  "remove-regions": { title: "Remove all regions on this page?", body: "Deletes every region on the page, including their text.", ok: "Remove all", danger: true, done: "Regions removed" },
  "reset-styles": { title: "Reset text to series defaults?", body: "Clears region and chapter style overrides and refits unlocked layouts.", ok: "Reset", danger: true, done: "Styles reset" },
  "mark-all": { title: "Mark every page done?", body: "Marks all pages done in Translate, Review, Clean and Typeset. Text, artwork and revision history stay.", ok: "Mark all done", done: "Marked 10 pages done" },
};

/* ---------- notes ---------- */
function renderNotes() {
  if (!S.notes) return "";
  return `<div class="drawer-backdrop" data-act="notes"></div><aside class="drawer notes"><header><h2>${icon("bi-lightbulb")} Design notes</h2><button class="icon-btn" data-act="notes">${icon("bi-x-lg")}</button></header>
  <div class="notes-body">
    <h3>The layout is the same in every step</h3>
    <ul><li><b>Top:</b> the six steps as a stepper, each with its own progress. Settings, issues and search stay in one place.</li>
    <li><b>Left:</b> pages, with a done / check / to-do mark for the current step.</li>
    <li><b>Stage bar:</b> the step's chapter-level run buttons, with one <i>Page / Whole chapter</i> switch instead of separate Page and Chapter menus.</li>
    <li><b>Tool rail:</b> canvas tools only (things you click on the page), grouped and labelled. One-shot commands moved out of the icon grid into labelled buttons.</li>
    <li><b>Tool options bar:</b> brush size, grow amount, polygon save, crop/split/reslice apply and reorder hints all show here, next to the active tool.</li>
    <li><b>Inspector:</b> things about the selected page or region, in tabs. No more replacing the canvas with a “chapter” panel.</li>
    <li><b>Page footer:</b> undo/redo, <i>Mark page done</i> and <i>Next page</i>, always in the same spot.</li></ul>
    <h3>Things that moved</h3>
    <ul><li><b>The chapter-settings gear tile is gone.</b> Chapter run buttons are in the stage bar. Settings (language, detector, AI models, aliases, glossary, fonts, colours, credits) are in one Settings drawer, each marked <i>This chapter</i>, <i>Series</i> or <i>Just you</i>.</li>
    <li><b>“Clear saved history for this step” is now “Mark page done”.</b> Same action, named for what it's for (export needs it). The Export tab shows a pages × steps table.</li>
    <li><b>Clean is a numbered pipeline:</b> mask → remove → touch up → finish. The stage bar always shows the next button to press.</li>
    <li><b>Region cards collapse.</b> The inspector lists regions compactly and opens only the selected one. Suggestions, comments, history and bounds/split/merge are tabs inside the card.</li>
    <li><b>Review is a queue</b> of everything still needing a decision across the chapter, grouped by reason, with the selected card on top.</li>
    <li><b>Typeset inspector:</b> Text / Style / Shape &amp; mask. Style shows where each value is inherited from (series → chapter → region).</li>
    <li><b>Prepare has an Organize grid</b> (drag, multi-select, credits slots, upload tile) and an Edit page view for crop/split/reslice/nudge.</li>
    <li><b>Context menus keep the same layout in every step:</b> the current step's group opens first, and the other steps are one flyout away.</li>
    <li><b>“N to check” + Next</b> combines the old Next button with a list you can see ahead of time. Export blockers link from there too.</li>
    <li><b>Find an action (Ctrl K)</b> searches every action and setting, shows where it lives now and where it used to be, and takes you there.</li></ul>
    <h3>Try</h3><ul><li>Press <kbd>Ctrl K</kbd> and type “history”, “nudge” or “reviewers”.</li><li>Right-click a region or a page thumbnail.</li><li>Clean step: follow the <i>Next</i> button.</li></ul>
  </div></aside>`;
}

/* ---------- toasts ---------- */
function renderToasts() {
  let el = document.getElementById("toasts");
  if (!el) return;
  el.innerHTML = S.toasts.map((t) => `<div class="toast ${t.kind}">${icon("bi-info-circle")} ${esc(t.msg)}</div>`).join("");
}

/* ---------- root render ---------- */
function render() {
  const keep = {};
  for (const sel of [".insp-body", ".thumbs", ".drawer-main", ".pal-list", ".issues", ".jobs-list"]) {
    const el = document.querySelector(sel);
    if (el) keep[sel] = el.scrollTop;
  }
  const focusPalette = S.palette;
  let main;
  if (S.stage === "export") main = renderExport();
  else if (S.stage === "prepare" && S.prepView === "grid") main = renderGrid();
  else main = `<div class="canvas-area">${renderRail()}<div class="canvas-col">${renderToolOptions()}${renderCanvas()}${renderViewBar()}</div></div>${renderPageFoot()}`;
  document.getElementById("app").innerHTML = `${renderTop()}
    <div class="body stage-${S.stage}">${renderStrip()}
      <main class="work">${renderStageBar()}${renderBanners()}${main}</main>
      ${renderInspector()}
    </div>${renderJobs()}${renderMenu()}${renderSettings()}${renderPalette()}${renderModal()}${renderNotes()}`;
  for (const [sel, top] of Object.entries(keep)) {
    const el = document.querySelector(sel);
    if (el) el.scrollTop = top;
  }
  if (focusPalette) {
    const q = document.getElementById("pal-q");
    if (q && document.activeElement !== q) {
      q.focus();
      q.setSelectionRange(q.value.length, q.value.length);
    }
  }
  const sel = document.querySelector(".pal-list button.on");
  if (sel) sel.scrollIntoView({ block: "nearest" });
  positionMenu();
}
function positionMenu() {
  const menu = document.querySelector(".menu:not(.sub)");
  if (!menu) return;
  const r = menu.getBoundingClientRect();
  if (r.right > innerWidth - 8) menu.style.left = `${Math.max(8, innerWidth - r.width - 8)}px`;
  if (r.bottom > innerHeight - 8) menu.style.top = `${Math.max(8, innerHeight - r.height - 8)}px`;
}

/* ---------- navigation helpers ---------- */
function setStage(id) {
  S.stage = id;
  S.tool = "select";
  S.compare = false;
  S.menu = null;
  if (id === "translate" || id === "review") S.subtab = region()?.suggestions.length ? "suggestions" : S.subtab;
}
function goRegion(id) {
  const p = pageOf(id);
  if (!p) return;
  S.page = M.pages.indexOf(p);
  S.region = id;
  const r = findRegion(id);
  if (r.suggestions.length) S.subtab = "suggestions";
}
function flash(key) {
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-find="${key}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 2200);
  });
}
function goCatalog(a) {
  const g = a.go || {};
  S.palette = false;
  S.menu = null;
  S.settings = null;
  S.modal = null;
  if (g.stage) setStage(g.stage);
  if (g.prepView) S.prepView = g.prepView;
  if (g.region) goRegion(g.region);
  if (g.tab) S.tabs[S.stage] = g.tab;
  if (g.subtab) S.subtab = g.subtab;
  if (g.tool) S.tool = g.tool;
  if (g.scope) S.scope = g.scope;
  if (g.jobs) S.jobs = g.jobs;
  if (g.settings) S.settings = g.settings;
  if (g.models) S.modelsTab = g.models;
  if (g.kana) S.kana = true;
  if (g.modal) S.modal = { kind: g.modal, what: g.what };
  render();
  if (g.menu) {
    const anchor = document.querySelector(`[data-find="${g.menuAnchor || a.find}"]`);
    const rect = anchor?.getBoundingClientRect();
    S.menu = { kind: g.menu, x: rect ? rect.left : 300, y: rect ? rect.bottom + 4 : 120, page: S.page, region: S.region };
    render();
    if (g.menuFind) {
      requestAnimationFrame(() => {
        const items = [...document.querySelectorAll(".menu [role=menuitem]")];
        const hit = items.find((b) => b.textContent.toLowerCase().includes(g.menuFind.toLowerCase()));
        if (hit) {
          hit.classList.add("flash");
          hit.closest(".flyout")?.classList.add("open");
        }
      });
    }
    return;
  }
  if (a.find) flash(a.find);
}

/* ---------- events ---------- */
const handlers = {
  stage: (d) => setStage(d.id),
  page: (d) => {
    S.page = +d.i;
    S.region = page().regions[0]?.id || "";
  },
  "open-page": (d) => {
    S.page = +d.i;
    S.stage = "prepare";
    S.prepView = "page";
    S.menu = null;
  },
  "nav-page": (d) => {
    S.page = (S.page + +d.d + M.pages.length) % M.pages.length;
    S.region = page().regions[0]?.id || "";
  },
  region: (d) => {
    if (S.tool === "reorder" && S.region && d.id !== S.region) {
      notify(`#${regionIndex(findRegion(d.id))} now follows #${regionIndex(region())}. Click the next one, or Esc.`);
    }
    S.region = d.id;
  },
  "goto-region": (d) => goRegion(d.id),
  tool: (d) => {
    S.tool = S.tool === d.id && d.id !== "select" ? "select" : d.id;
    S.menu = null;
    if (S.stage === "prepare" && ["crop", "split", "reslice"].includes(d.id)) S.prepView = "page";
    if (["brush", "erase"].includes(d.id)) S.strokes = Math.max(S.strokes, 0);
  },
  "tool-at": (d) => {
    S.stage = "prepare";
    S.prepView = "page";
    S.page = S.menu?.page ?? S.page;
    S.tool = d.id;
    S.menu = null;
  },
  scope: (d) => (S.scope = d.v),
  tab: (d) => {
    S.tabs[S.stage] = d.v;
    S.menu = null;
  },
  subtab: (d) => (S.subtab = d.v),
  "subtab-open": (d) => {
    S.region = S.menu?.region || S.region;
    S.subtab = d.v;
    S.menu = null;
    if (!["translate", "review"].includes(S.stage)) setStage("translate");
    S.tabs.translate = "regions";
    goRegion(S.region);
  },
  "prep-view": (d) => (S.prepView = d.v),
  view: (d) => {
    if (d.v === "regions") S.showRegions = !S.showRegions;
    if (d.v === "mask") S.showMask = !S.showMask;
    if (d.v === "compare") S.compare = !S.compare;
  },
  zoom: (d) => {
    S.menu = null;
    S.zoom = +d.d === 0 ? 100 : Math.max(50, Math.min(300, S.zoom + +d.d * 25));
  },
  "toggle-strip": () => {
    S.stripOpen = !S.stripOpen;
    S.menu = null;
  },
  "toggle-insp": () => {
    S.inspOpen = !S.inspOpen;
    S.menu = null;
  },
  "strip-filter": (d) => (S.stripFilter = d.v),
  jobs: (d) => {
    S.jobs = d.v;
    S.menu = null;
  },
  settings: (d) => {
    S.settings = d.sec || S.settings || "chapter";
    if (d.models) S.modelsTab = d.models;
    S.menu = null;
  },
  "settings-close": () => (S.settings = null),
  "settings-close-to": (d) => {
    S.settings = null;
    setStage(d.stage);
    S.tabs[d.stage] = d.tab;
  },
  "models-tab": (d) => (S.modelsTab = d.v),
  palette: () => {
    S.palette = true;
    S.paletteQuery = "";
    S.paletteIndex = 0;
  },
  "palette-close": () => (S.palette = false),
  "palette-go": (d) => {
    goCatalog(window.CATALOG[+d.i]);
    return "skip";
  },
  menu: (d, el) => {
    const r = el.getBoundingClientRect();
    S.menu = S.menu?.kind === d.menu ? null : { kind: d.menu, x: d.menu === "view" || d.menu === "issues" ? r.right - 280 : r.left, y: r.bottom + 4 };
  },
  "close-menu": () => (S.menu = null),
  "ctx-btn": (d, el) => {
    const r = el.getBoundingClientRect();
    S.menu = { kind: d.kind, x: r.left - 200, y: r.bottom + 4, page: d.page != null ? +d.page : S.page, region: d.region };
  },
  "next-issue": () => {
    const e = M.EXCEPTIONS.find((x) => !(x.region === S.region && x.stage === S.stage)) || M.EXCEPTIONS[0];
    openException(e);
  },
  "goto-exc": (d) => openException(M.EXCEPTIONS[+d.i]),
  "goto-issue": (d) => {
    setStage(d.stage);
    const n = parseInt(d.page, 10);
    if (n) {
      S.page = n - 1;
      S.region = page().regions[0]?.id || "";
    }
  },
  modal: (d) => {
    if (S.menu?.region) S.region = S.menu.region;
    S.menu = null;
    S.modal = { kind: d.kind };
  },
  "modal-close": () => (S.modal = null),
  confirm: (d) => {
    S.menu = null;
    S.modal = { kind: "confirm", what: d.kind };
  },
  "confirm-ok": (d) => {
    S.modal = null;
    notify(d.msg);
  },
  run: (d) => {
    S.menu = null;
    notify(d.msg);
  },
  toast: (d) => {
    S.menu = null;
    notify(d.msg);
  },
  "mark-done": () => {
    page().done[stageDef().step] = true;
    notify(`Page ${page().n} marked done in ${stageDef().label}. Its undo history for this step was cleared.`);
  },
  "approve-next": () => {
    const r = region();
    if (r) r.status = "approved";
    const rs = page().regions;
    const next = rs.slice(rs.indexOf(r) + 1).find((x) => regionState(x).key !== "ok" && x.state !== "ignored");
    if (next) S.region = next.id;
    notify("Approved. Moved to the next region that needs review.");
  },
  "clean-method": (d) => (S.cleanMethod = d.v),
  "clean-next": (d) => {
    const p = page();
    S.menu = null;
    if (d.v === "detect") {
      p.mask = "needs-approval";
      S.showMask = true;
      notify("Lettering mask detected. Check flagged regions, refine, then approve.");
    } else if (d.v === "approve-mask") {
      p.mask = "approved";
      S.strokes = 0;
      notify("Mask approved.");
    } else if (d.v === "clean-run") {
      const m = M.CLEAN_METHODS.find((x) => x.id === S.cleanMethod);
      if (m.prompt) {
        S.modal = { kind: "clean-prompt" };
        return;
      }
      p.mask = "approved";
      p.cleaned = true;
      notify(`Cleaned with ${m.label}. Toggle “Showing result” to compare.`);
    } else if (d.v === "approve-clean") {
      p.cleanApproved = true;
      p.done.clean = true;
      S.page = Math.min(M.pages.length - 1, S.page + 1);
      notify(`Page ${p.n} approved. Now on page ${page().n}.`);
    }
  },
  "clean-done": () => {
    page().cleaned = true;
    page().mask = "approved";
    S.modal = null;
    notify("Reconstruction queued. Inspect before applying.");
  },
  "clear-strokes": () => {
    S.strokes = 0;
    S.menu = null;
    notify("Draft strokes cleared");
  },
  kana: () => (S.kana = !S.kana),
  "queue-scope": (d) => (S.queueScope = d.v),
  fmt: (d) => (S.exportFormat = d.v),
  viewer: (d) => (S.viewer = d.v === "1"),
  renumber: () => {
    S.numberingStale = false;
    S.menu = null;
    notify("Pages renumbered 1–10. Internal IDs and filenames unchanged.");
  },
  "move-page": (d) => {
    S.menu = null;
    S.numberingStale = true;
    notify(`Page moved ${+d.d < 0 ? "earlier" : "later"}. Renumber when you're done organizing.`);
  },
  pick: (d, el, ev) => {
    const i = +d.i;
    if (ev.shiftKey && S.lastPick != null) {
      const [a, b] = [Math.min(i, S.lastPick), Math.max(i, S.lastPick)];
      for (let k = a; k <= b; k++) S.selectedPages.add(k);
    } else if (S.selectedPages.has(i)) S.selectedPages.delete(i);
    else S.selectedPages.add(i);
    S.lastPick = i;
  },
  "clear-selection": () => S.selectedPages.clear(),
  "add-pages": () => {
    setStage("prepare");
    S.prepView = "grid";
    S.tabs.prepare = "upload";
    S.pending = ["scan_011.png", "scan_012.png", "scan_013.png"];
  },
  conflict: (d) => {
    S.menu = null;
    if (d.v === "demo") S.conflict = true;
    else {
      S.conflict = false;
      notify(d.v === "mine" ? "Your draft saved over the reviewed version" : "Kept the saved version; your draft was discarded");
    }
  },
  notes: () => {
    S.notes = !S.notes;
    S.menu = null;
  },
};

function openException(e) {
  S.menu = null;
  setStage(e.stage);
  S.page = e.page - 1;
  if (e.region) goRegion(e.region);
  if (e.stage === "review") S.tabs.review = "queue";
  if (e.kind === "Unapproved mask") S.tool = "brush";
  if (e.stage === "typeset") S.tabs.typeset = "text";
  notify(`${e.kind} · page ${e.page}`);
}

document.addEventListener("click", (ev) => {
  const flyBtn = ev.target.closest(".flyout > .has-sub");
  if (flyBtn) {
    flyBtn.parentElement.classList.toggle("open");
    return;
  }
  const el = ev.target.closest("[data-act]");
  if (!el || el.disabled) return;
  if (el.tagName === "A") ev.preventDefault();
  if (el.tagName === "INPUT" && el.type === "checkbox" && el.dataset.act !== "pick") return;
  const fn = handlers[el.dataset.act];
  if (!fn) return;
  const res = fn({ ...el.dataset }, el, ev);
  if (res !== "skip") render();
});

document.addEventListener("contextmenu", (ev) => {
  const el = ev.target.closest("[data-ctx]");
  if (!el) return;
  ev.preventDefault();
  const kind = el.dataset.ctx;
  const target = ev.target.closest("[data-region]");
  if (kind === "region" || target) {
    const id = (target || el).dataset.region;
    S.region = id;
    S.menu = { kind: "region", x: ev.clientX, y: ev.clientY, region: id };
  } else {
    S.menu = { kind: "page", x: ev.clientX, y: ev.clientY, page: +el.dataset.page };
  }
  render();
});

document.addEventListener("input", (ev) => {
  const k = ev.target.dataset.input;
  if (!k) return;
  const v = ev.target.type === "checkbox" ? ev.target.checked : ev.target.value;
  if (k === "palette") {
    S.paletteQuery = v;
    S.paletteIndex = 0;
    render();
  } else if (k === "query") {
    S.query = v;
    clearTimeout(S._qt);
    S._qt = setTimeout(() => {
      render();
      const q = document.querySelector('[data-input="query"]');
      q?.focus();
      q?.setSelectionRange(q.value.length, q.value.length);
    }, 250);
  } else if (k === "brush" || k === "grow") {
    S[k] = +v;
    ev.target.nextElementSibling && (ev.target.nextElementSibling.textContent = `${v}px`);
  } else if (k === "unresolved") {
    S.unresolvedOnly = v;
    render();
  } else if (k === "files") {
    S.pending = [...ev.target.files].map((f) => f.name);
    S.tabs.prepare = "upload";
    render();
  } else if (k in S) {
    S[k] = v;
    render();
  }
});

document.addEventListener("keydown", (ev) => {
  const typing = ev.target.closest("input, textarea, select");
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "k") {
    ev.preventDefault();
    handlers.palette();
    render();
    return;
  }
  if (S.palette) {
    const res = paletteResults();
    if (ev.key === "ArrowDown") S.paletteIndex = Math.min(res.length - 1, S.paletteIndex + 1);
    else if (ev.key === "ArrowUp") S.paletteIndex = Math.max(0, S.paletteIndex - 1);
    else if (ev.key === "Enter" && res[S.paletteIndex]) return goCatalog(res[S.paletteIndex]);
    else if (ev.key === "Escape") S.palette = false;
    else return;
    ev.preventDefault();
    render();
    return;
  }
  if (ev.key === "Escape") {
    if (S.modal) S.modal = null;
    else if (S.menu) S.menu = null;
    else if (S.settings) S.settings = null;
    else if (S.notes) S.notes = false;
    else S.tool = "select";
    render();
    return;
  }
  if (typing || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const tools = (M.STAGE_TOOLS[S.stage] || []).flat();
  const hit = tools.find((id) => M.TOOLS[id].key?.toLowerCase() === ev.key.toLowerCase());
  if (hit) {
    S.tool = hit;
    if (["brush", "erase"].includes(hit) && S.stage === "clean") S.strokes += 1;
    render();
  }
});

render();
