<script lang="ts">
  import { cleanModelChoices, inpaintUnavailable } from "$lib/cleanMethods";
  import type { ImageRow, LineRow } from "$lib/types";
  import type { PageData, RegionData } from "$lib/workflow";

  /**
   * Compare cleaning methods on one region: the raw region and its mask, a checkbox per
   * method, then each method's result on the same crop. Pick one to apply to the page, or
   * reject them all. Results never touch the page until one is applied.
   */
  type Backend = Parameters<typeof cleanModelChoices>[0];
  type Result = { method: string; label: string; asset?: string; error?: string; ms?: number };
  type Progress = {
    state: string;
    error?: string | null;
    message?: string;
    results?: Result[];
    source?: string;
    mask?: string;
    box?: { left: number; top: number; width: number; height: number };
  };

  let {
    apiBase,
    asset,
    backend,
    page,
    pageData,
    line,
    region,
    regionNumber,
    onclose,
    onapplied,
  }: {
    apiBase: string;
    asset: (hash?: string) => string;
    backend: Backend;
    page: ImageRow;
    pageData: PageData;
    line: LineRow;
    region: RegionData | undefined;
    regionNumber: number;
    onclose: () => void;
    onapplied: () => void | Promise<void>;
  } = $props();

  // Clone stamping needs a hand-picked source, so it is not a method to compare.
  const methods = $derived(cleanModelChoices(backend).filter((m) => m.id !== "clone" && !inpaintUnavailable(m.id, backend)));
  let chosen = $state<string[]>([]);
  let jobId = $state("");
  let progress = $state<Progress | null>(null);
  let pick = $state("");
  let error = $state("");
  let applying = $state(false);
  let dialog = $state<HTMLDialogElement>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    dialog?.showModal();
    return () => clearTimeout(timer);
  });

  /** The same crop the server compares: the region plus a quarter of its size, at least 32 px. */
  const box = $derived.by(() => {
    if (progress?.box) return progress.box;
    const pts = region?.polygon?.length
      ? region.polygon
      : [{ x: line.x ?? 0, y: line.y ?? 0 }, { x: (line.x ?? 0) + (line.w ?? 0.1), y: (line.y ?? 0) + (line.h ?? 0.1) }];
    const xs = pts.map((p) => p.x * page.width), ys = pts.map((p) => p.y * page.height);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const m = Math.max(32, Math.round(Math.max(x1 - x0, y1 - y0) * 0.25));
    const left = Math.max(0, Math.floor(x0 - m)), top = Math.max(0, Math.floor(y0 - m));
    return { left, top, width: Math.min(page.width, Math.ceil(x1 + m)) - left, height: Math.min(page.height, Math.ceil(y1 + m)) - top };
  });
  const viewBox = $derived(`${box.left} ${box.top} ${box.width} ${box.height}`);
  const raw = $derived(pageData.prepared ? asset(pageData.prepared) : "");
  const mask = $derived(pageData.mask ? asset(pageData.mask) : "");
  const running = $derived(!!jobId && (!progress || progress.state === "running" || progress.state === "queued"));
  const results = $derived(progress?.results ?? []);

  async function post(body: Record<string, unknown>) {
    const res = await fetch(`${apiBase}/workflow`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  async function poll() {
    if (!jobId) return;
    try {
      const res = await fetch(`${apiBase}/workflow?compare=${encodeURIComponent(jobId)}`);
      const data = (await res.json()) as Progress;
      if (!res.ok) throw new Error((data as { error?: string }).error || "Comparison not found");
      progress = data;
      if (!pick) pick = data.results?.find((r) => r.asset)?.method ?? "";
      if (data.state === "running" || data.state === "queued") timer = setTimeout(poll, 1500);
      else if (data.state === "failed") error = data.error || "The comparison failed";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function start() {
    if (!chosen.length) return;
    error = "";
    progress = null;
    pick = "";
    try {
      const labels = Object.fromEntries(methods.filter((m) => chosen.includes(m.id)).map((m) => [m.id, m.label]));
      jobId = (await post({ action: "compare-clean", imageId: page.id, lineId: line.id, methods: chosen, labels })).jobId;
      void poll();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function apply() {
    if (!pick || applying) return;
    applying = true;
    error = "";
    try {
      await post({ action: "apply-compare-clean", jobId, method: pick });
      await onapplied();
      close();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      applying = false;
    }
  }

  function close() {
    clearTimeout(timer);
    if (dialog?.open) dialog.close();
    onclose();
  }
  const secs = (ms?: number) => (ms == null ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
</script>

<dialog class="hud-modal cc" bind:this={dialog} aria-labelledby="cc-title" onclose={() => { clearTimeout(timer); onclose(); }}>
  <header class="hud-window-bar"><h3 id="cc-title">Compare cleaning · region {regionNumber}</h3></header>
  <div class="cc-body">
    <section class="cc-inputs">
      <figure>
        <svg viewBox={viewBox} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Raw region">
          {#if raw}<image href={raw} x="0" y="0" width={page.width} height={page.height} />{/if}
        </svg>
        <figcaption>Raw region</figcaption>
      </figure>
      <figure>
        <svg viewBox={viewBox} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Mask">
          <!-- The canvas's own mask view: the raw page with the mask as translucent red. -->
          {#if raw}<image href={raw} x="0" y="0" width={page.width} height={page.height} />{/if}
          {#if mask}
            <defs>
              <mask id="cc-mask" maskUnits="userSpaceOnUse" x="0" y="0" width={page.width} height={page.height} style="mask-type: luminance">
                <rect width={page.width} height={page.height} fill="black" />
                <image href={mask} width={page.width} height={page.height} />
              </mask>
            </defs>
            <rect width={page.width} height={page.height} fill="#ff405c" opacity=".5" mask="url(#cc-mask)" />
          {/if}
        </svg>
        <figcaption>Mask{#if !mask} · none yet{/if}</figcaption>
      </figure>
    </section>

    <section class="cc-methods" aria-label="Cleaning methods">
      <div class="cc-methods-head">
        <strong>Methods</strong>
        <button type="button" class="link" disabled={running} onclick={() => (chosen = chosen.length === methods.length ? [] : methods.map((m) => m.id))}>
          {chosen.length === methods.length ? "None" : "All"}
        </button>
      </div>
      {#each methods as m (m.id)}
        <label class="cc-method">
          <input type="checkbox" value={m.id} bind:group={chosen} disabled={running} />
          <span class="mdot" style={`background:${m.color}`}></span>{m.label}
        </label>
      {:else}
        <p class="muted">No cleaning methods are available.</p>
      {/each}
      <p class="muted">Each method cleans the same crop of the current artwork. Image editors use their default instructions. Nothing changes on the page until you apply a result.</p>
    </section>

    {#if error}<p class="alert-hud" role="alert">{error}</p>{/if}

    {#if jobId}
      <section class="cc-results" aria-label="Results">
        <p class="muted" role="status">{progress?.message ?? "Starting…"}</p>
        <div class="cc-grid" role="radiogroup" aria-label="Pick a result">
          {#each results as r (r.method)}
            <label class="cc-result" class:picked={pick === r.method} class:failed={!!r.error}>
              <input type="radio" name="cc-pick" value={r.method} bind:group={pick} disabled={!r.asset} />
              <div class="cc-img">
                {#if r.asset}
                  <img src={asset(r.asset)} alt={`Result from ${r.label}`} />
                {:else if r.error}
                  <span>Failed</span>
                {:else}
                  <span class="cc-wait">{running ? "Waiting…" : "—"}</span>
                {/if}
              </div>
              <span class="cc-name"><b>{r.label}</b> <small>{r.error ?? secs(r.ms)}</small></span>
            </label>
          {/each}
        </div>
      </section>
    {/if}
  </div>
  <footer class="cc-foot">
    {#if jobId && !running}
      <button type="button" onclick={close}>Reject all</button>
      <button type="button" class="primary" disabled={!pick || applying} onclick={apply}>{applying ? "Applying…" : "Apply selected"}</button>
    {:else}
      <button type="button" onclick={close}>{running ? "Close (keeps running)" : "Cancel"}</button>
      <button type="button" class="primary" disabled={!chosen.length || running || !mask} onclick={start}>
        {running ? "Processing…" : `Process ${chosen.length || ""} method${chosen.length === 1 ? "" : "s"}`}
      </button>
    {/if}
  </footer>
</dialog>

<style>
  .cc { width: min(1100px, 95vw); max-height: 92vh; padding: 0; }
  .cc[open] { display: flex; flex-direction: column; }
  .cc-body { padding: 12px 16px; overflow: auto; display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr) 260px; }
  .cc-inputs { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  figure { margin: 0; display: grid; gap: 4px; }
  figure svg { width: 100%; max-height: 300px; background: #fff; border: 1px solid var(--hud-line); border-radius: 4px; }
  figcaption { font-size: 11px; color: var(--hud-muted); }
  .cc-methods { display: grid; gap: 4px; align-content: start; grid-row: span 2; }
  .cc-methods-head { display: flex; justify-content: space-between; align-items: center; }
  .cc-method { display: flex; gap: 8px; align-items: center; font-size: 12.5px; margin: 0; padding: 3px 0; }
  .mdot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .link { background: none; border: 0; color: var(--hud-teal-ink); cursor: pointer; padding: 0; font-size: 12px; }
  .muted { font-size: 11.5px; color: var(--hud-muted); margin: 6px 0 0; }
  .cc-results { grid-column: 1; display: grid; gap: 6px; }
  .cc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; }
  .cc-result { display: grid; gap: 4px; padding: 6px; border: 1px solid var(--hud-line); border-radius: 5px; cursor: pointer; margin: 0; position: relative; }
  .cc-result.picked { border-color: var(--hud-teal-ink); box-shadow: inset 0 0 0 1px var(--hud-teal-ink); }
  .cc-result.failed { opacity: 0.7; cursor: default; }
  .cc-result input { position: absolute; top: 8px; left: 8px; z-index: 1; }
  .cc-img { background: #fff; border-radius: 3px; display: grid; place-items: center; min-height: 120px; overflow: hidden; }
  .cc-img img { width: 100%; height: auto; display: block; }
  .cc-img span { color: #666; font-size: 12px; }
  .cc-name { font-size: 12px; overflow-wrap: anywhere; }
  .cc-name small { color: var(--hud-muted); }
  .cc-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--hud-line); }
  @media (max-width: 760px) { .cc-body { grid-template-columns: 1fr; } .cc-methods { grid-row: auto; } }
</style>
