<script lang="ts">
  import "./studio-controls.css";
  import { cleanModelChoices, canStartClean, inpaintUnavailable } from "$lib/cleanMethods";
  import type { PageData, WorkflowDoc } from "$lib/workflow";

  let {
    showMask,
    expansion = $bindable(5),
    maskEngine = $bindable<string>("auto"),
    strokeCount,
    maskApproved,
    cloneX = $bindable(40),
    cloneY = $bindable(0),
    backend,
    pageDoc,
    ontogglemask,
    canClean = false,
    busy = false,
    hasMaskRegions = false,
    ondetect,
    onapprovemask,
    onclean,
    onapplypass,
    onapproveclean,
    onclearstrokes,
  }: {
    showMask: boolean;
    expansion?: number;
    maskEngine?: string;
    strokeCount: number;
    maskApproved: boolean;
    cloneX?: number;
    cloneY?: number;
    backend: {
      models?: Array<{ id: string; label: string; tasks: string[] }>;
      bigLama?: boolean;
      bigLamaDevice?: string | null;
      sam?: boolean;
      koharu?: boolean;
      codex?: { available?: boolean; reason?: string };
      imageEdit?: Record<string, { available?: boolean; reason?: string }>;
      devices?: { name: string; backend: string }[];
      errors?: string[];
      gpu?: { mode?: string; llm?: string; ocr?: string; cleaning?: string };
    } | null;
    pageDoc: WorkflowDoc<PageData> | undefined;
    ontogglemask: (visible: boolean) => void;
    canClean?: boolean;
    busy?: boolean;
    hasMaskRegions?: boolean;
    ondetect?: () => void;
    onapprovemask?: () => void;
    onclean?: (method: string) => void;
    onapplypass?: () => void;
    onapproveclean?: () => void;
    onclearstrokes?: () => void;
  } = $props();
</script>

<div class="wf-ui clean-insp">
  <section class="sec" data-find="clean-mask">
    <h3>
      <span class="stepn">1</span> Mask the lettering
      <span class={`chip ${maskApproved ? "chip-ok" : "chip-attn"}`}>{maskApproved ? "Approved" : pageDoc?.data.mask ? "Needs approval" : "Not detected"}</span>
    </h3>
    <div class="grid2">
      <label>Engine<select bind:value={maskEngine}>
          <option value="auto">Default tested model</option>
          {#each (backend?.models || []).filter(model => model.tasks.includes('textMask')) as model}<option value={model.id}>{model.label}</option>{/each}
          <option value="ctd">CTD regions</option>
        </select></label>
      <label>Padding (px)<input type="number" min="0" max="20" bind:value={expansion} aria-label="Detection padding (px)" /></label>
    </div>
    <label class="check"><input type="checkbox" checked={showMask} onchange={(e) => ontogglemask(e.currentTarget.checked)} /> Show mask overlay</label>
    <div class="btn-row" data-find="detect-lettering">
      <button type="button" disabled={busy || !canClean || strokeCount > 0 || !hasMaskRegions} onclick={() => ondetect?.()}><i class="bi bi-magic" aria-hidden="true"></i> Detect lettering</button>
      <button type="button" data-find="approve-mask" disabled={busy || !canClean || (!strokeCount && !(pageDoc?.data.mask && !pageDoc.data.maskApproved))} onclick={() => onapprovemask?.()}><i class="bi bi-check2" aria-hidden="true"></i> Approve mask</button>
    </div>
    <p class="muted">Refine with the Brush, Erase and Grow mask tools. <strong>Grow mask</strong> expands only the clicked section. Committing brush edits approves the mask.</p>
    {#if strokeCount}
      <div class="btn-row small"><span>{strokeCount} draft strokes</span><button type="button" class="link" onclick={() => onclearstrokes?.()}>Clear draft strokes</button></div>
    {/if}
    {#if pageDoc?.data.maskDiagnostics?.engine}
      <p class="muted">Last detection: {pageDoc.data.maskDiagnostics.engine} ({pageDoc.data.maskDiagnostics.version}) · {pageDoc.data.maskDiagnostics.backend}</p>
    {/if}
    {#if maskEngine === "koharu" && backend && !backend.koharu}
      <p class="muted">Koharu is not installed. Run scripts/install-koharu.py or choose CTD.</p>
    {/if}
    {#if pageDoc?.data.maskDiagnostics}
      {#each pageDoc.data.maskDiagnostics.entries.filter((entry) => entry.reasons.length) as entry}
        <div class="alert attn"><i class="bi bi-flag" aria-hidden="true"></i> Region {entry.regionNumber ?? entry.region + 1}: {entry.reasons.join(", ")}. Check before cleaning.</div>
      {/each}
    {/if}
  </section>
  <section class="sec" data-find="clean-method">
    <h3><span class="stepn">2</span> Remove it</h3>
    <div class="methods">
      {#each cleanModelChoices(backend) as model (model.id)}
        {@const unavailable = inpaintUnavailable(model.id, backend)}
        <button
          type="button"
          class="method"
          class:off={!!unavailable}
          class:on={pageDoc?.data.cleanMethod === model.id}
          aria-label={model.label}
          disabled={!canStartClean(canClean, busy, !!(pageDoc?.data.mask || strokeCount), strokeCount, unavailable)}
          title={unavailable || `Clean with ${model.label}`}
          onclick={() => onclean?.(model.id)}
        >
          <span class="mdot" style={`background:${model.color}`}></span>
          <span><b>{model.label}</b>{#if unavailable}<small>Unavailable · {unavailable}</small>{/if}</span>
        </button>
      {/each}
    </div>
    <div class="grid2">
      <label>Clone offset X (px)<input type="number" bind:value={cloneX} /></label>
      <label>Clone offset Y (px)<input type="number" bind:value={cloneY} /></label>
    </div>
    <p class="muted">Cleaning also approves the current mask. Image editors ask for instructions before they run. Last run: {pageDoc?.data.backend ?? "none yet"}.</p>

  </section>
  <section class="sec" data-find="clean-touchup">
    <h3><span class="stepn">3</span> Touch up</h3>
    <p class="muted">Use <strong>Fill speech bubble</strong> (F), <strong>Clone stamp</strong> (C), <strong>Blur</strong> (L), <strong>Restore</strong> (H) and <strong>Paint raw</strong> (S) on the tool rail. Clone stamp: right-click the source, then paint. Restore paints the previous saved artwork back in.</p>
  </section>
  <section class="sec" data-find="clean-finish">
    <h3><span class="stepn">4</span> Finish</h3>
    <button type="button" class="primary block" data-find="approve-clean" disabled={!canClean || busy || !pageDoc?.data.cleaned} onclick={() => onapproveclean?.()}><i class="bi bi-check2-square" aria-hidden="true"></i> Approve cleaned page &amp; next</button>
    <button type="button" class="block" data-find="apply-pass" disabled={!canClean || busy || strokeCount > 0 || !pageDoc?.data.cleaned} onclick={() => onapplypass?.()}><i class="bi bi-layers" aria-hidden="true"></i> Keep result &amp; start another pass</button>
    <p class="muted" data-find="save-sample">Passes stack. The raw original never changes; Undo steps back one pass.</p>
  </section>
  <details class="sec hw">
    <summary><i class="bi bi-gpu-card" aria-hidden="true"></i> Hardware</summary>
    {#if backend?.bigLamaDevice}
      <p class="muted">AnimeManga Big-LaMa resident on {backend.bigLamaDevice}.</p>
    {:else if backend?.bigLama}
      <p class="muted">AnimeManga Big-LaMa is available and loads on first use.</p>
    {/if}
    {#if backend?.gpu?.mode === "komatose"}
      <p class="muted">OCR/LLM: {backend.gpu.ocr}. {backend.gpu.llm}. Cleaner: {backend.gpu.cleaning}.</p>
    {/if}
    {#if backend}<p class="muted">{backend.devices?.length ? backend.devices.map((d) => `${d.name} (${d.backend})`).join(" · ") : (backend.errors ?? []).join(" · ")}</p>{/if}
  </details>
</div>

<style>
  .sec { padding: 12px 14px; border-bottom: 1px solid var(--hud-line); display: grid; gap: 8px; }
  .sec h3 {
    margin: 0;
    font: 700 12.5px Rajdhani, sans-serif;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    color: var(--hud-text);
  }
  .stepn { width: 18px; height: 18px; border-radius: 50%; background: var(--hud-teal-dim); color: var(--hud-teal); display: inline-grid; place-items: center; font: 700 11px Inter, sans-serif; }
  .chip { display: inline-block; padding: 1px 7px; border-radius: 9px; font: 500 10.5px Inter, sans-serif; letter-spacing: 0; text-transform: none; white-space: nowrap; }
  .chip-ok { background: rgba(94, 227, 154, 0.14); color: #5ee39a; }
  .chip-attn { background: rgba(245, 184, 92, 0.15); color: #f5b85c; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .clean-insp :global(label) { margin: 0; }
  .check { color: var(--hud-text); font-size: 12px; }
  .btn-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .muted { color: var(--hud-muted); font-size: 11.5px; margin: 0; }
  .small { font-size: 11.5px; }
  .link { border: 0; background: none; color: var(--hud-teal); padding: 0; font-size: 12px; }
  .alert { display: flex; gap: 7px; align-items: flex-start; padding: 6px 8px; border-radius: 4px; font-size: 12px; }
  .alert.attn { background: rgba(245, 184, 92, 0.12); color: #f8d49c; }
  .list-actions { display: flex; flex-direction: column; }
  .list-actions button { justify-content: flex-start; border: 0; background: transparent; padding: 6px; border-radius: 4px; }
  .list-actions button .bi { color: var(--hud-muted); width: 16px; }
  .list-actions button:hover:not(:disabled) { background: rgba(255, 255, 255, 0.05); color: var(--hud-text); }
  .methods { display: grid; gap: 2px; }
  .method {
    justify-content: flex-start;
    gap: 8px;
    padding: 5px 7px;
    border: 1px solid transparent;
    border-radius: 5px;
    background: transparent;
    color: var(--hud-text);
    text-align: left;
    white-space: normal;
  }
  .method:hover:not(:disabled) { background: rgba(255, 255, 255, 0.04); border-color: transparent; color: var(--hud-text); }
  .method.on { border-color: rgba(45, 226, 197, 0.5); background: var(--hud-teal-dim); }
  .method.off, .method:disabled { opacity: 0.45; }
  .method span:last-child { display: grid; }
  .method b { font-weight: 500; font-size: 12.5px; }
  .method small { color: var(--hud-muted); font-size: 11px; }
  .mdot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .block { width: 100%; justify-content: center; }
  .hw summary { cursor: pointer; color: var(--hud-muted); font-size: 12px; font-weight: 400; }
  details.sec { border-left: 0; border-right: 0; border-top: 0; margin: 0; border-radius: 0; }
</style>
