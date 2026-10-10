<script lang="ts">
  import "./studio-controls.css";
  import ExportDocuments from './ExportDocuments.svelte';
  import type { ImageRow } from "$lib/types";
  import {
    exportBlockers,
    exportRequiresCompletion,
    groupReadinessIssues,
    PAGE_STEPS,
    pageStepLabel,
    type PageData,
    type PageStep,
    type ReadinessIssue,
    type WorkflowDoc,
  } from "$lib/workflow";

  let {
    seriesId,
    episodeId,
    issues,
    canClean,
    busy,
    pendingExportDownload,
    exportFormat = $bindable("png"),
    quality = $bindable(95),
    includeExportMetadata = $bindable(false),
    draftExport = $bindable(false),
    previewCopied = $bindable(false),
    previewUrl,
    latestExport,
    downloadHref,
    downloadName,
    canEdit,
    onapprovegeometry,
    onapprovetranslations,
    onkeeplayouts,
    onmarkall,
    onapproveeverything,
    onexport,
    onpreviewshare,
    onissue,
    images = [],
    pageDocs = {},
    stepDone = () => false,
  }: {
    seriesId: string;
    episodeId: string;
    issues: ReadinessIssue[];
    canEdit: boolean;
    canClean: boolean;
    busy: boolean;
    pendingExportDownload: string | null;
    exportFormat?: string;
    quality?: number;
    includeExportMetadata?: boolean;
    draftExport?: boolean;
    previewCopied?: boolean;
    previewUrl: string;
    latestExport?: {
      id: string;
      state: string;
      error?: string | null;
      progress?: { artifact?: string; filename?: string };
    };
    downloadHref: string;
    downloadName: string;
    onapprovegeometry: () => void;
    onapprovetranslations: () => void;
    onkeeplayouts: () => void;
    onmarkall: (step?: PageStep) => void;
    onapproveeverything: () => void;
    onexport: () => void;
    onpreviewshare: (body?: Record<string, unknown>) => void;
    onissue: (issue: ReadinessIssue) => void;
    images?: ImageRow[];
    pageDocs?: Record<string, WorkflowDoc<PageData>>;
    stepDone?: (imageId: string, step: PageStep) => boolean;
  } = $props();

  const stageOf = (code: string) =>
    code === "numbering" || code === "credits"
      ? "Prepare"
      : ["cleaning", "prepared"].includes(code)
        ? "Clean"
        : ["font", "layout", "stale", "glyphs", "overflow", "geometry"].includes(code)
          ? "Typeset"
          : "Review";

  const blockers = $derived(exportBlockers(issues));
  const unfinishedSteps = $derived(issues.filter((issue) => issue.code === "step-complete"));
  const needsCompletion = $derived(exportRequiresCompletion(exportFormat, draftExport));
  const warnings = $derived(issues.filter((issue) => issue.severity === "warning"));
  const groupedIssues = $derived(groupReadinessIssues(issues));
  const exportBlocked = $derived(
    needsCompletion && (unfinishedSteps.length > 0 || (!draftExport && blockers.length > 0)),
  );
  const exportBlockReason = $derived(
    !exportBlocked
      ? ""
      : unfinishedSteps.length
        ? `Mark every page complete in Translate, Review, Clean, and Typeset (${unfinishedSteps.length} left).`
        : "Resolve the remaining export issues or label this ZIP as a draft.",
  );
</script>

<div class="wf-ui export-layout">
  <ExportDocuments {seriesId} {episodeId} />
  <div class="export-main">
  <h2>Export the chapter</h2>
  <h4>Ready to publish?</h4>
  <p class="muted">
    {#if needsCompletion && unfinishedSteps.length}
      Mark every page complete in Translate, Review, Clean, and Typeset before a finished publication export.
      {unfinishedSteps.length} still open. Draft images and script/JSON handoffs can export without that.
    {:else if blockers.length}
      {blockers.length} item{blockers.length === 1 ? "" : "s"} need attention before a finished export.
    {:else if warnings.length}
      Ready for finished export. {warnings.length} warning{warnings.length === 1 ? "" : "s"} will not block it.
    {:else}
      Ready for finished export.
    {/if}
  </p>
  <div class="control-row" data-find="quick-fixes">
    <button
      type="button"
      class="primary"
      data-find="approve-everything"
      title="Approve current translations, geometry and artwork, and accept saved layouts for the whole chapter."
      disabled={!canEdit || !canClean || busy || !images.length}
      onclick={onapproveeverything}><i class="bi bi-check2-all" aria-hidden="true"></i> Approve everything</button
    >
    <button
      type="button"
      disabled={!canEdit ||
        busy ||
        !issues.some((issue) => issue.code === "review")}
      onclick={onapprovetranslations}><i class="bi bi-check2-all" aria-hidden="true"></i> Accept all translations</button
    ><button
      type="button"
      disabled={!canClean ||
        busy ||
        !issues.some((issue) => issue.code === "geometry")}
      onclick={onapprovegeometry} data-find="approve-all-geometry"><i class="bi bi-bounding-box-circles" aria-hidden="true"></i> Approve all geometry</button
    ><button
      type="button"
      disabled={!canClean ||
        busy ||
        !issues.some((issue) => issue.code === "stale")}
      onclick={onkeeplayouts}><i class="bi bi-pin-angle" aria-hidden="true"></i> Keep current layouts</button
    >
  </div>
  {#if exportBlocked && exportBlockReason}
    <p class="export-need">{exportBlockReason}</p>
  {/if}
  <div class="issues" data-find="readiness">
    {#each groupedIssues as group}
        <button class="issue" class:warning={group.severity === "warning"} onclick={() => onissue(group.first)}>
        {stageOf(group.code)} ·
        {group.severity === "warning" ? "warning" : group.code}
        {#if group.pageLabel} · {group.pageLabel}{/if}
        {#if group.regionLabels.length === 1} · {group.regionLabels[0]}{/if}
        · {group.message}
        {#if group.count > 1} ({group.count}){/if}
        {#if group.regionLabels.length > 1}
          <span class="issue-regions">{group.regionLabels.join(", ")}</span>
        {/if}
      </button>
    {/each}
  </div>
  {#if images.length}
    <h4>Pages marked done</h4>
    <div class="control-row" data-find="bulk-completion">
      <button
        type="button"
        class="primary"
        data-find="mark-all-steps-done"
        title="Mark Translate, Review, Clean and Typeset done on every page. Revision history stays."
        disabled={!canEdit || !canClean || busy}
        onclick={() => onmarkall()}><i class="bi bi-check-circle" aria-hidden="true"></i> Mark all steps done</button>
      {#each PAGE_STEPS as step}
        <button
          type="button"
          data-find={`mark-all-${step}-done`}
          title={`Mark ${pageStepLabel(step)} done on every page in this chapter.`}
          disabled={busy || (step === "translate" || step === "review" ? !canEdit : !canClean)}
          onclick={() => onmarkall(step)}>Mark all {pageStepLabel(step)} done</button>
      {/each}
    </div>
    <table class="matrix" data-find="matrix">
      
      <thead><tr><th>Page</th>{#each PAGE_STEPS as step}<th>{pageStepLabel(step)}</th>{/each}</tr></thead>
      <tbody>
        {#each images as img, index (img.id)}
          <tr>
            <td>{img.pageNumber ?? index + 1}</td>
            {#each PAGE_STEPS as step}
              <td class:y={stepDone(img.id, step)}>{stepDone(img.id, step) ? "✓" : pageDocs[img.id]?.data.completed?.[step] ? "·" : ""}</td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
  </div>
  <div class="export-side">
  <section class="export-card" data-find="download">
  <h3><i class="bi bi-file-zip" aria-hidden="true"></i> Download</h3>
  <div class="control-row">
    <label
      >Format<select aria-label="Export format" bind:value={exportFormat}
        ><option value="png">Finished PNG · lossless</option><option value="jpg"
          >Finished JPG · 4:4:4</option
        ><option value="psd">Editable PSD</option><option value="clean"
          >Clean images</option
        ><option value="bilingual">Bilingual script</option><option
          value="english">English script</option
        ><option value="json">JSON with revisions</option></select
      ></label
    >{#if exportFormat === "jpg"}<label
        >JPG quality<input
          type="number"
          min="1"
          max="100"
          bind:value={quality}
        /></label
      >{/if}<label
      ><input type="checkbox" bind:checked={includeExportMetadata} /> Include
      metadata and scripts</label
    ><label data-find="draft"
      ><input type="checkbox" bind:checked={draftExport} /> Label as draft</label
    ><button
      class="primary"
      disabled={busy || !!pendingExportDownload || exportBlocked}
      title={exportBlockReason || undefined}
      onclick={onexport}
      >{pendingExportDownload ? "Building ZIP…" : "Generate ZIP"}</button
    >
  </div>
  <p role="status">
    {#if latestExport?.state === "completed" && latestExport.progress?.artifact}
      ZIP ready.
      <a href={downloadHref} download={downloadName}
        >Download {downloadName}</a
      >
    {:else if latestExport && ["queued", "running", "cancelling"].includes(latestExport.state)}
      Building your ZIP.
      {pendingExportDownload === latestExport.id
        ? "The download will start when it is ready."
        : "The download link will appear here when it is ready."}
    {:else if latestExport && ["failed", "cancelled", "interrupted"].includes(latestExport.state)}
      Export {latestExport.state}. {latestExport.error ||
        "Generate the ZIP again to retry."}
    {:else}
      Generate a ZIP of the chapter in the selected format.
    {/if}
  </p>
  <p class="muted small">
    Image ZIPs contain only numbered image files by default, at native page
    dimensions. Include metadata and scripts to add chapter JSON, a font
    manifest, English and bilingual scripts, and draft notes. PSDs contain one
    editable text layer per bubble. Install the exact font versions to edit, and
    check reflow in your target editor.
  </p>
  </section>
  <div class="export-card" data-find="viewer">
    <h3><i class="bi bi-globe2" aria-hidden="true"></i> Public viewer</h3>
    <p>
      Anyone with this link can read the strip. They cannot edit, comment, or see
      the rest of the app. Pages are shown at export pixel size, not stretched to
      a shared column, so width mismatches stay visible.
    </p>
    {#if blockers.length}
      <p>
        This chapter still has export issues; guests will see the current
        typeset pages.
      </p>
    {/if}
    {#if previewUrl}
      <label>Viewer URL<input readonly value={previewUrl} /></label>
      <div class="control-row">
        <button
          type="button"
          onclick={async () => {
            try {
              await navigator.clipboard.writeText(previewUrl);
              previewCopied = true;
            } catch {
              previewCopied = false;
            }
          }}>{previewCopied ? "Copied" : "Copy"}</button
        >
        <a href={previewUrl} target="_blank" rel="noreferrer">Open</a>
        <button type="button" onclick={() => onpreviewshare({ rotate: true })}
          >New link</button
        >
        <button type="button" onclick={() => onpreviewshare({ revoke: true })}
          >Disable</button
        >
      </div>
    {:else}
      <button class="primary" type="button" onclick={() => onpreviewshare()}
        >Enable public viewer</button
      >
    {/if}
  </div>
  </div>
</div>

<style>
  .export-layout {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
    gap: 22px;
    align-items: start;
    padding: 18px 22px 28px;
    font: 12.5px Inter, system-ui, sans-serif;
  }
  .export-main, .export-side { min-width: 0; display: grid; gap: 12px; align-content: start; }
  .export-main h2 { margin: 0; font: 700 20px Manrope, sans-serif; letter-spacing: 0.04em; text-transform: none; }
  .export-main h4 { margin: 4px 0 0; font: 700 12px Manrope, sans-serif; letter-spacing: 0.07em; text-transform: uppercase; color: var(--hud-muted); }
  p { margin: 0; }
  .muted { color: var(--hud-muted); }
  .small { font-size: 11.5px; }
  .control-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .export-card {
    border: 1px solid var(--hud-line);
    border-radius: 8px;
    padding: 14px 16px;
    background: var(--hud-bg-2);
    display: grid;
    gap: 10px;
  }
  .export-card h3 { margin: 0; font: 700 14px Manrope, sans-serif; letter-spacing: 0.06em; text-transform: uppercase; display: flex; gap: 8px; align-items: center; }
  .export-card label { margin: 0; }
  .matrix { width: 100%; max-width: 520px; border-collapse: collapse; font-size: 12px; }
  .matrix th, .matrix td { border-bottom: 1px solid var(--hud-line); padding: 3px 8px; text-align: center; color: var(--hud-muted); font-weight: 500; }
  .matrix td.y { color: #5ee39a; }
  .matrix td:first-child, .matrix th:first-child { text-align: left; }
  .issues { display: grid; gap: 4px; }
  .issue {
    justify-content: flex-start;
    text-align: left;
    white-space: normal;
    padding: 7px 10px;
    background: var(--hud-bg-2);
    border: 1px solid var(--hud-line);
    border-left: 3px solid #ff5d73;
    border-radius: 4px;
    display: block;
  }
  .issue.warning { border-left-color: #f5b85c; }
  .issue:hover { border-color: var(--hud-teal-ink); }
  .issue-regions { display: block; font-size: 11px; color: var(--hud-muted); }
  .export-need { color: #ff5d73; }
</style>
