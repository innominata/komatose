<script lang="ts">
  import { latestPageProofreadJob } from '$lib/pageProofread';
  type JobPage = { image_id?: string; state?: string; error?: string | null };
  type JobLog = {
    t?: number;
    step?: string;
    imageId?: string;
    engine?: string;
    model?: string;
    request?: string;
    response?: string;
    error?: string;
    usageText?: string;
  };
  type Job = {
    id: string;
    kind: string;
    state: string;
    created_at?: number;
    updated_at?: number;
    error?: string | null;
    payload?: Record<string, unknown>;
    progress?: {
      message?: string;
      completed?: number;
      total?: number;
      imageIndex?: number;
      imageCount?: number;
      skipped?: number;
      artifact?: string;
      filename?: string;
      critique?: string;
      report?: {
        summary?: string;
        issues?: { page?: string; severity?: string; text?: string }[];
        questions?: { page?: string; text?: string }[];
        notes?: string;
      };
      errors?: string[];
      log?: JobLog[];
      logCount?: number;
      engine?: string;
      model?: string;
    };
    pages?: JobPage[];
  };

  let {
    jobs = [],
    mode = "collapsed",
    flash = 0,
    pageLabel,
    asset,
    onmode,
    onretry,
    oncancel,
    onclear,
    onclearall,
    onopencritique,
  }: {
    jobs?: Job[];
    mode?: "collapsed" | "shown" | "maximized";
    flash?: number;
    pageLabel: (job: Job) => string;
    asset: (hash?: string) => string;
    onmode: (mode: "collapsed" | "shown" | "maximized") => void;
    onretry: (jobId: string) => void;
    oncancel: (jobId: string) => void;
    onclear: () => void;
    onclearall: () => void;
    onopencritique: (jobId: string) => void;
  } = $props();

  const running = $derived(
    jobs.filter((j) => ["running", "queued", "cancelling"].includes(j.state)).length,
  );
  const failed = $derived(jobs.filter((j) => j.state === "failed").length);
  const finished = $derived(
    jobs.filter((j) =>
      ["completed", "failed", "cancelled", "interrupted"].includes(j.state),
    ).length,
  );
  const open = $derived(mode !== "collapsed");
  const latestCritique = $derived(latestPageProofreadJob(jobs));
  let flashing = $state(false);

  $effect(() => {
    if (!flash) return;
    flashing = false;
    const timer = setTimeout(() => {
      flashing = true;
    }, 0);
    return () => clearTimeout(timer);
  });

  function kindLabel(kind: string) {
    return (
      {
        transcribe: "Transcribe",
        translate: "Translate",
        proofread: "Proofread",
        "page-proofread": "Page proofreader",
        review: "Chapter review",
        reread: "Retry image reading",
        "fill-missing": "Fill missing text",
        suggest: "Suggest alternatives",
        "source-translation": "Translate corrected source",
        "glossary-mine": "Extract series terms",
        "region-ocr": "Region OCR",
        describe: "Scene description",
        reslice: "Reslice strips",
        "typeset-all": "Auto-fit text",
        export: "Export",
        selection: "Selection translate",
        mask: "Detect mask",
        clean: "Clean",
        geometry: "Geometry",
      }[kind] || kind
    );
  }

  function progressOf(job: Job) {
    const completed =
      job.progress?.completed ??
      (job.progress?.imageIndex != null ? job.progress.imageIndex : null);
    const total =
      job.progress?.total ??
      (job.progress?.imageCount != null ? job.progress.imageCount : null);
    return { completed, total };
  }

  const liveStates = new Set(["running", "queued", "cancelling"]);

  function elapsed(job: Job) {
    if (!job.created_at) return "";
    const end = liveStates.has(job.state)
      ? Date.now()
      : (job.updated_at ?? job.created_at);
    const ms = Math.max(0, end - job.created_at);
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  let openLogs = $state<Record<string, boolean>>({});
  const current = $derived(jobs.find((j) => liveStates.has(j.state)));
  const latestZip = $derived(
    jobs.find((j) => j.kind === "export" && j.state === "completed" && j.progress?.artifact),
  );
  function zipHref(job: Job) {
    return `${asset(job.progress?.artifact)}?download=${encodeURIComponent(job.progress?.filename || "export.zip")}`;
  }
  function hasLog(job: Job) {
    return !!(job.pages?.length || job.progress?.report || job.progress?.log?.length || job.progress?.errors?.length);
  }

  const retryKinds = [
    "export",
    "transcribe",
    "translate",
    "proofread",
    "page-proofread",
    "review",
    "selection",
    "reread",
    "fill-missing",
    "suggest",
    "source-translation",
    "region-ocr",
    "mask",
    "clean",
    "geometry",
    "describe",
    "reslice",
  ];
</script>

<section class="jobs" data-find="jobs" class:open class:maximized={mode === "maximized"} class:flash={flashing}>
  <div
    class="jobs-head"
    role="button"
    tabindex="0"
    aria-expanded={open}
    title={open ? "Hide jobs" : "Show jobs"}
    onclick={() => onmode(open ? "collapsed" : "shown")}
    onkeydown={(e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onmode(open ? "collapsed" : "shown");
      }
    }}
  >
    <span class="jobs-toggle">
      <i class={`bi ${open ? "bi-chevron-down" : "bi-chevron-up"}`} aria-hidden="true"></i>
      <h2>Jobs</h2>
    </span>
    {#if current}
      {@const prog = progressOf(current)}
      <span class="job-now">
        <span class="spin" aria-hidden="true"></span>
        <b>{kindLabel(current.kind)} {(pageLabel(current) || "chapter").toLowerCase()}</b>
        <span class="now-msg">{current.progress?.message ?? current.state}</span>
        {#if prog.total}<span class="bar"><i style={`width:${((prog.completed ?? 0) / (prog.total || 1)) * 100}%`}></i></span>{/if}
        {#if running > 1}<span>+{running - 1} more</span>{/if}
      </span>
    {:else if !jobs.length}
      <span class="muted">No jobs yet</span>
    {/if}
    {#if failed}<span class="job-fail"><i class="bi bi-x-circle" aria-hidden="true"></i> {failed} failed</span>{/if}
    <span class="spacer"></span>
    {#if latestCritique}
      <button
        class="link"
        type="button"
        title={latestCritique.progress?.critique ? "Open the most recent critique" : "Open the most recent proofreader job"}
        onclick={(e) => { e.stopPropagation(); onopencritique(latestCritique.id); }}
      ><i class="bi bi-chat-square-quote" aria-hidden="true"></i> {latestCritique.progress?.critique ? "Open critique" : "Open proofreader"}</button>
    {/if}
    {#if latestZip}
      <a class="link" href={zipHref(latestZip)} download={latestZip.progress?.filename || "export.zip"} title={latestZip.progress?.filename}
        onclick={(e) => e.stopPropagation()}
        ><i class="bi bi-download" aria-hidden="true"></i> Latest ZIP</a>
    {/if}
    {#if open}
      <button
        class="icon-btn"
        type="button"
        title={mode === "maximized" ? "Restore panel" : "Maximize panel"}
        aria-label={mode === "maximized" ? "Restore panel" : "Maximize panel"}
        onclick={(e) => { e.stopPropagation(); onmode(mode === "maximized" ? "shown" : "maximized"); }}
      ><i class={`bi ${mode === "maximized" ? "bi-fullscreen-exit" : "bi-arrows-fullscreen"}`} aria-hidden="true"></i></button>
    {/if}
  </div>
  {#if open}
    <div class="jobs-list">
      {#each jobs as job (job.id)}
        {@const page = pageLabel(job)}
        {@const prog = progressOf(job)}
        {@const live = liveStates.has(job.state)}
        {@const engineText = [job.progress?.engine || job.payload?.engine, job.progress?.model || job.payload?.model].filter(Boolean).join(" · ")}
        <div class={`job ${job.state}`} class:running={live}>
          <span class="jstate" title={job.state}>
            {#if live}<span class="spin" aria-hidden="true"></span>
            {:else if job.state === "completed"}<i class="bi bi-check-circle" aria-hidden="true"></i>
            {:else if job.state === "failed"}<i class="bi bi-x-circle" aria-hidden="true"></i>
            {:else}<i class="bi bi-slash-circle" aria-hidden="true"></i>{/if}
          </span>
          <span class="jkind">
            <b>{kindLabel(job.kind)}</b>
            <small>{[page || "Chapter", job.created_at && elapsed(job) !== "0s" ? elapsed(job) : ""].filter(Boolean).join(" · ")}</small>
          </span>
          <span class="jmsg" title={job.error || job.progress?.message || ""}>
            {#if job.state === "failed" && job.error}<span class="err">{job.error}</span>
            {:else}{job.progress?.message || job.state}{/if}
            {#if job.kind === "typeset-all"} · {job.progress?.completed ?? 0} fitted · {job.progress?.skipped ?? 0} locked · {job.progress?.total ?? 0} regions{/if}
            {#if engineText}<small> · {engineText}</small>{/if}
            {#if live && prog.total}
              <span class="bar" role="progressbar" aria-label="Job progress" aria-valuenow={prog.completed ?? 0} aria-valuemax={prog.total}><i style={`width:${((prog.completed ?? 0) / (prog.total || 1)) * 100}%`}></i></span>
              <small>{prog.completed ?? 0}/{prog.total}</small>
            {/if}
          </span>
          <span class="jact">
            {#if ["running", "queued"].includes(job.state)}
              <button type="button" class="small" onclick={() => oncancel(job.id)}>Cancel</button>
            {/if}
            {#if ["failed", "interrupted", "cancelled"].includes(job.state) && retryKinds.includes(job.kind)}
              <button type="button" class="small accent" onclick={() => onretry(job.id)}>Retry unfinished work</button>
            {/if}
            {#if job.kind === "page-proofread"}
              <button type="button" class="small" onclick={() => onopencritique(job.id)}>{job.progress?.critique ? "Open critique" : "Open proofreader"}</button>
            {/if}
            {#if job.progress?.artifact}
              <a class="small btn-link" href={zipHref(job)} download={job.progress.filename || "export.zip"} aria-label={`Download ${job.progress.filename}`}>Download</a>
            {/if}
            {#if hasLog(job) || (job.error && job.state !== "failed")}
              <button type="button" class="small ghost" aria-expanded={!!openLogs[job.id]} onclick={() => (openLogs[job.id] = !openLogs[job.id])}>Log</button>
            {/if}
          </span>
        </div>
        {#if openLogs[job.id]}
          <div class="job-log">
            {#if job.pages?.length}
              <div class="job-pages">
                {#each job.pages as p}
                  <span class="chip {p.state}">{p.state}{p.error ? ` · ${p.error}` : ""}</span>
                {/each}
              </div>
            {/if}
            {#if job.error && job.state !== "failed"}<pre class="job-error">{job.error}</pre>{/if}
            {#if job.kind === "typeset-all"}{#each job.progress?.errors ?? [] as issue}<pre class="job-error">{issue}</pre>{/each}{/if}
            {#if job.progress?.report}<details>
                <summary>AI chapter review</summary>
                <p>{job.progress.report.summary}</p>
                {#each job.progress.report.issues ?? [] as issue}<p>{issue.page} · {issue.severity}: {issue.text}</p>{/each}
                {#each job.progress.report.questions ?? [] as question}<p>{question.page}: {question.text}</p>{/each}
                <p>{job.progress.report.notes}</p>
              </details>{/if}
            {#if job.progress?.log?.length}
              <details>
                <summary>AI request / response ({job.progress.logCount ?? job.progress.log.length}{#if (job.progress.logCount ?? 0) > job.progress.log.length} · latest {job.progress.log.length}{/if})</summary>
                {#each job.progress.log as entry, i}
                  <div class="log">
                    <strong>{entry.step || "call"}{#if entry.engine} · {entry.engine}{/if}{#if entry.model} · {entry.model}{/if}</strong>
                    {#if entry.request}<p class="io-label">Sent</p><pre>{entry.request}</pre>{/if}
                    {#if entry.response}<p class="io-label">Response</p><pre class="resp">{entry.response}</pre>{/if}
                    {#if entry.usageText}<p class="usage">Usage: {entry.usageText}</p>{/if}
                    {#if entry.error}<pre class="job-error">{entry.error}</pre>{/if}
                  </div>
                  {#if i < job.progress.log.length - 1}<hr />{/if}
                {/each}
              </details>
            {/if}
            {#each job.pages?.filter((p) => p.error) ?? [] as p}
              <pre class="job-error">{p.image_id}: {p.error}</pre>
            {/each}
          </div>
        {/if}
      {/each}
      {#if !jobs.length}<p class="empty">No jobs yet.</p>{/if}
      <div class="list-foot">
        <span class="muted">{jobs.length} logged{#if running} · {running} running{/if}</span>
        <span>
          <button type="button" class="small ghost" disabled={!finished} title="Remove finished jobs" onclick={() => onclear()}>Clear finished</button>
          <button
            type="button"
            class="small ghost"
            disabled={!jobs.length}
            title="Remove every job from the list"
            onclick={() => {
              if (running && !confirm(`${running} job(s) are still running. Remove them from the list too? They will not be stopped.`)) return;
              onclearall();
            }}
          >Clear all</button>
        </span>
      </div>
    </div>
  {/if}
</section>

<style>
  .jobs {
    flex-shrink: 0;
    border-top: 1px solid var(--hud-line);
    background: #141922;
    font: 12px Inter, system-ui, sans-serif;
    color: var(--hud-text);
  }
  .jobs.flash { animation: jobs-attention 0.55s ease-in-out 3; }
  .jobs.flash h2 { color: var(--hud-teal); }
  @keyframes jobs-attention {
    0%, 100% { background-color: #141922; box-shadow: inset 0 0 0 0 transparent; }
    40% { background-color: var(--hud-teal-dim); box-shadow: inset 0 0 0 2px var(--hud-teal); }
  }
  .jobs-head {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 12px;
    height: 32px;
    cursor: pointer;
    user-select: none;
  }
  .jobs-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--hud-text);
  }
  .jobs h2 { margin: 0; font: 600 12px Inter, system-ui, sans-serif; letter-spacing: 0; text-transform: none; color: inherit; }
  .job-now { display: inline-flex; align-items: center; gap: 7px; color: var(--hud-muted); min-width: 0; overflow: hidden; white-space: nowrap; }
  .job-now b { color: var(--hud-text); font-weight: 500; }
  .now-msg { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .job-fail { color: #ff5d73; white-space: nowrap; }
  .spacer { flex: 1; }
  .muted { color: var(--hud-muted); }
  .link {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 0;
    background: none;
    padding: 0;
    color: var(--hud-teal);
    font: 12px Inter, system-ui, sans-serif;
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
  }
  .link:hover { text-decoration: underline; }
  .icon-btn {
    display: inline-grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--hud-muted);
  }
  .icon-btn:hover { background: rgba(255, 255, 255, 0.06); color: var(--hud-text); }
  .bar { display: inline-block; width: 90px; height: 4px; border-radius: 2px; background: rgba(255, 255, 255, 0.1); overflow: hidden; vertical-align: middle; flex: none; }
  .bar i { display: block; height: 100%; background: var(--hud-teal); }
  .spin {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid rgba(255, 255, 255, 0.15);
    border-top-color: var(--hud-teal);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    flex: none;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .jobs-list { max-height: 190px; overflow: auto; padding: 0 12px 8px; display: grid; gap: 3px; }
  .jobs.maximized .jobs-list { max-height: 52vh; height: 52vh; }
  .job {
    display: grid;
    grid-template-columns: 22px 170px minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    padding: 5px 8px;
    background: rgba(255, 255, 255, 0.03);
    border-radius: 4px;
  }
  .jstate { display: inline-grid; place-items: center; color: var(--hud-muted); }
  .job.failed .jstate { color: #ff5d73; }
  .job.completed .jstate { color: #5ee39a; }
  .jkind { display: grid; min-width: 0; }
  .jkind b { font-weight: 500; }
  .jkind small, .jmsg small { color: var(--hud-muted); font-size: 11px; }
  .jmsg { color: var(--hud-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .jmsg .err { color: #ff8a9a; }
  .jact { display: flex; gap: 4px; }
  .jact button, .btn-link, .list-foot button {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border: 1px solid rgba(244, 247, 251, 0.18);
    border-radius: 5px;
    background: rgba(255, 255, 255, 0.04);
    color: var(--hud-text);
    font: 500 11.5px Inter, system-ui, sans-serif;
    letter-spacing: 0;
    text-transform: none;
    text-decoration: none;
    white-space: nowrap;
  }
  .jact button:hover, .btn-link:hover, .list-foot button:hover:not(:disabled) { border-color: var(--hud-teal); color: var(--hud-teal); }
  .jact .accent { border-color: rgba(45, 226, 197, 0.5); color: var(--hud-teal); }
  .jact .ghost, .list-foot .ghost { border-color: transparent; background: transparent; color: var(--hud-muted); }
  .list-foot button:disabled { opacity: 0.4; }
  .list-foot { display: flex; align-items: center; justify-content: space-between; padding-top: 4px; }
  .job-log { margin: 0 0 4px 32px; padding: 6px 8px; border-left: 2px solid var(--hud-line); display: grid; gap: 6px; }
  .job-pages { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip { padding: 2px 6px; border-radius: 3px; font-size: 11px; background: rgba(255, 255, 255, 0.04); }
  .chip.completed { color: #5ee39a; }
  .chip.failed { color: #ff8a9a; }
  .chip.running { color: var(--hud-teal); }
  .job-error, .log pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    background: #0e1117;
    padding: 8px;
    border-radius: 4px;
    font-size: 11.5px;
  }
  .job-error { color: #ffc283; }
  .empty { margin: 0; padding: 8px 0; color: var(--hud-muted); }
  details { padding: 6px 8px; border: 1px solid var(--hud-line); border-radius: 4px; }
  details summary { cursor: pointer; font-weight: 500; }
  .log .io-label { margin: 8px 0 4px; font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--hud-muted); }
  .log .resp { border-left: 2px solid #5ee39a; }
  .log .usage { margin: 6px 0 0; font-size: 11.5px; }
  hr { border: 0; border-top: 1px solid var(--hud-line); }
</style>
