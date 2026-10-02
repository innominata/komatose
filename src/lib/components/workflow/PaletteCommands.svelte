<script lang="ts">
  import type { LineRow } from "$lib/types";
  import type { MaskStroke, PageData, RegionData, WorkflowDoc } from "$lib/workflow";
  import {
    cleanModelChoices,
    canStartClean,
    inpaintUnavailable,
    type CleanBackend,
  } from "$lib/cleanMethods";
  import { TYPESET_FOLLOWUP_LABEL, PAGE_PROOFREAD_LABEL } from "$lib/pageProofread";
  import { bubbleFitPoints } from "$lib/regionGeometry";
  import { maskDraftKey } from "$lib/draftKeys";

  export type PaletteCommandOps = {
    describe: (ids: string[], overwrite: boolean) => void;
    applyReslice: (cuts?: number[]) => void;
    deletePage: (id: string) => void;
    transcribePage: (id: string) => void;
    translatePage: (id: string) => void;
    reviewTranslations: (imageId?: string) => void;
    runAI: (kind: string, imageId?: string) => void;
    rereadMissing: (imageId?: string) => void;
    fillMissing: (imageId?: string) => void;
    act: (body: Record<string, unknown>) => unknown;
    applyMask: (detect?: boolean) => void;
    approveMask: () => void;
    applyCleaningPass: () => void;
    rectanglePolygon: () => void;
    completePolygon: () => void;
    copyPageImage: (variant: 'raw' | 'typeset') => void;
    proofreadPageImages: () => void;
    approveCleanedAndNext: () => void;
    forgetPageHistory: () => void;
    cleanWith: (method: string) => void;
    nudge: (dx: number, dy: number) => void;
  };

  let {
    step,
    translateStep,
    pageTool,
    pageId,
    episodeId,
    userId,
    canUpload,
    canEdit,
    canClean,
    busy,
    aiRunning,
    reviewImageBusy,
    hasReslicePreview,
    resliceCuts,
    pageDoc,
    strokes = $bindable([]),
    hasMaskRegions,
    selected,
    regionDoc,
    samAvailable,
    polygonCount,
    polygonDraft,
    polygonActive = false,
    backend,
    nudgeAmount = $bindable(10),
    proofreadFollowUp = false,
    pageMarkedComplete = false,
    ops,
  }: {
    step: string;
    translateStep: boolean;
    pageTool: string;
    pageId: string;
    episodeId: string;
    userId: string;
    canUpload: boolean;
    canEdit: boolean;
    canClean: boolean;
    busy: boolean;
    aiRunning: boolean;
    reviewImageBusy: boolean;
    hasReslicePreview: boolean;
    resliceCuts?: number[];
    pageDoc: WorkflowDoc<PageData> | undefined;
    strokes?: MaskStroke[];
    hasMaskRegions: boolean;
    selected: LineRow | undefined;
    regionDoc: WorkflowDoc<RegionData> | undefined;
    samAvailable: boolean;
    polygonCount: number;
    polygonDraft: { x: number; y: number }[];
    polygonActive?: boolean;
    backend: CleanBackend | null;
    nudgeAmount?: number;
    proofreadFollowUp?: boolean;
    pageMarkedComplete?: boolean;
    ops: PaletteCommandOps;
  } = $props();
</script>

{#if step === 'Review' || step === 'Typeset'}
  <div class="palette-command-group" role="group" aria-label="Page images">
    <span class="palette-group-name">Images</span>
    <button class="palette-command" type="button" title="Copy raw image" aria-label="Copy raw image"
      disabled={busy || reviewImageBusy} onclick={() => ops.copyPageImage('raw')}><i class="bi bi-clipboard" aria-hidden="true"></i></button>
    <button class="palette-command" type="button" title="Copy typeset image" aria-label="Copy typeset image"
      disabled={busy || reviewImageBusy} onclick={() => ops.copyPageImage('typeset')}><i class="bi bi-clipboard-check" aria-hidden="true"></i></button>
    <button class="palette-command" type="button"
      title={proofreadFollowUp ? TYPESET_FOLLOWUP_LABEL : PAGE_PROOFREAD_LABEL}
      aria-label={proofreadFollowUp ? TYPESET_FOLLOWUP_LABEL : PAGE_PROOFREAD_LABEL}
      disabled={!canEdit || busy || reviewImageBusy} onclick={ops.proofreadPageImages}><i class="bi bi-chat-square-quote" aria-hidden="true"></i></button>
  </div>
{/if}

{#if step === "Prepare"}
  <div class="palette-command-group" role="group" aria-label="Page">
    <span class="palette-group-name">Page</span>
    <button
      class="palette-command"
      type="button"
      title="Generate scene context (optional)"
      aria-label="Generate scene context (optional)"
      disabled={!canUpload || busy || aiRunning}
      onclick={() => ops.describe([pageId], true)}
      ><i class="bi bi-card-text" aria-hidden="true"></i></button
    >
    {#if pageTool === "reslice"}
      <button
        class="palette-command"
        type="button"
        title="Apply reslice cuts"
        aria-label="Apply reslice cuts"
        disabled={!canUpload || busy || !hasReslicePreview}
        onclick={() => ops.applyReslice(resliceCuts)}
        ><i class="bi bi-scissors" aria-hidden="true"></i></button
      >
    {/if}
    <button
      class="palette-command"
      type="button"
      title="Delete page"
      aria-label="Delete page"
      disabled={!canUpload || busy}
      onclick={() => ops.deletePage(pageId)}
      ><i class="bi bi-trash" aria-hidden="true"></i></button
    >
  </div>
  {#if canUpload}
    <div class="palette-command-group" role="group" aria-label="Nudge page">
      <span class="palette-group-name">Nudge</span>
      {#each [
        [-1, 0, "left", "bi-arrow-left"],
        [1, 0, "right", "bi-arrow-right"],
        [0, -1, "up", "bi-arrow-up"],
        [0, 1, "down", "bi-arrow-down"],
      ] as [dx, dy, dir, icon]}
        <button
          class="palette-command"
          type="button"
          title={`Nudge ${dir}`}
          aria-label={`Nudge ${dir}`}
          disabled={busy}
          onclick={() => ops.nudge(Number(dx), Number(dy))}
          ><i class="bi {icon}" aria-hidden="true"></i></button
        >
      {/each}
      <label class="nudge-amount">
        <input
          type="number"
          min="1"
          bind:value={nudgeAmount}
          aria-label="Nudge pixels"
          title="Nudge pixels"
        />
      </label>
    </div>
  {/if}
{/if}

{#if translateStep}
  <div class="palette-command-group" role="group" aria-label="Translate">
    <span class="palette-group-name">Translate</span><button
      class="palette-command"
      type="button"
      title="Transcribe page"
      aria-label="Transcribe page"
      disabled={busy || aiRunning || !canUpload}
      onclick={() => ops.transcribePage(pageId)}
      ><i class="bi bi-chat-square-text" aria-hidden="true"></i></button
    >
    <button
      class="palette-command"
      type="button"
      title="Translate page"
      aria-label="Translate page"
      disabled={busy || aiRunning || !canUpload}
      onclick={() => ops.translatePage(pageId)}
      ><i class="bi bi-translate" aria-hidden="true"></i></button
    >
    <button
      class="palette-command"
      type="button"
      title="Review translations"
      aria-label="Review translations"
      onclick={() => ops.reviewTranslations(pageId)}
      ><i class="bi bi-check2-square" aria-hidden="true"></i></button
    >
    <button
      class="palette-command"
      type="button"
      title="Proofread edited English"
      aria-label="Proofread edited English"
      disabled={busy || aiRunning || !canEdit}
      onclick={() => ops.runAI("proofread", pageId)}
      ><i class="bi bi-spellcheck" aria-hidden="true"></i></button
    >
    <button
      class="palette-command"
      type="button"
      title="Retry uncertain image reading"
      aria-label="Retry uncertain image reading"
      disabled={busy || aiRunning || !canEdit}
      onclick={() => ops.rereadMissing(pageId)}
      ><i class="bi bi-eye" aria-hidden="true"></i></button
    >
    <button
      class="palette-command"
      type="button"
      title="Fill missing source & English"
      aria-label="Fill missing source & English"
      disabled={busy || aiRunning || !canEdit}
      onclick={() => ops.fillMissing(pageId)}
      ><i class="bi bi-plus-square" aria-hidden="true"></i></button
    >
    <button
      class="palette-command"
      type="button"
      title="Refresh scene context"
      aria-label="Refresh scene context"
      disabled={!canUpload || busy}
      onclick={() => ops.describe([pageId], true)}
      ><i class="bi bi-card-text" aria-hidden="true"></i></button
    >
    <button
      class="palette-command"
      type="button"
      title="Clear saved history for this step"
      aria-label="Clear saved history for this step"
      aria-pressed={pageMarkedComplete}
      disabled={!pageId || busy || !canEdit}
      onclick={() => ops.forgetPageHistory()}
      ><i class="bi bi-journal-x" aria-hidden="true"></i></button
    >
  </div>
{/if}

{#if step === "Clean"}
  <div class="palette-command-group" role="group" aria-label="Clean">
    <span class="palette-group-name">Clean</span>
    <button
      class="palette-command"
      type="button"
      title="Generate lettering mask"
      aria-label="Generate lettering mask"
      disabled={busy || !canClean || strokes.length > 0 || !hasMaskRegions}
      onclick={() => ops.applyMask(true)}
      ><i class="bi bi-magic" aria-hidden="true"></i></button
    >
    <button
      class="palette-command"
      type="button"
      title="Approve mask"
      aria-label="Approve mask"
      disabled={
        busy ||
        !canClean ||
        (!strokes.length && !(pageDoc?.data.mask && !pageDoc.data.maskApproved))
      }
      onclick={() => ops.approveMask()}
      ><i class="bi bi-check2" aria-hidden="true"></i></button
    >
    <button
      class="palette-command"
      type="button"
      title="Clear draft strokes"
      aria-label="Clear draft strokes"
      onclick={() => {
        strokes = [];
        localStorage.removeItem(maskDraftKey(userId, episodeId, pageId));
      }}><i class="bi bi-x-lg" aria-hidden="true"></i></button
    >
    <button
      class="palette-command"
      type="button"
      title="Apply cleaning &amp; start new mask"
      aria-label="Apply cleaning &amp; start new mask"
      disabled={busy || !canClean || !pageDoc?.data.cleaned || strokes.length > 0}
      onclick={ops.applyCleaningPass}
      style="color: var(--hud-teal)"
      ><i class="bi bi-floppy" aria-hidden="true"></i></button
    >
    <button
      class="palette-command"
      type="button"
      title="Undo saved edit (Ctrl+Z)"
      aria-label="Undo saved edit (Ctrl+Z)"
      disabled={!canClean || !pageDoc?.canUndo}
      onclick={() =>
        ops.act({
          action: "page",
          imageId: pageId,
          expectedRevision: pageDoc!.revision,
          data: {},
          history: "undo",
        })}><i class="bi bi-arrow-counterclockwise" aria-hidden="true"></i></button
    >
    <button
      class="palette-command"
      type="button"
      title="Redo (Ctrl+Shift+Z)"
      aria-label="Redo (Ctrl+Shift+Z)"
      disabled={!canClean || !pageDoc?.canRedo}
      onclick={() =>
        ops.act({
          action: "page",
          imageId: pageId,
          expectedRevision: pageDoc!.revision,
          data: {},
          history: "redo",
        })}><i class="bi bi-arrow-clockwise" aria-hidden="true"></i></button
    >
    <button
      class="palette-command"
      type="button"
      title={pageDoc?.data.cleaned || pageDoc?.data.cleanBase
        ? "Approve cleaned page and go to next"
        : "Approve source without cleaning and go to next"}
      aria-label={pageDoc?.data.cleaned || pageDoc?.data.cleanBase
        ? "Approve cleaned page and go to next"
        : "Approve source without cleaning and go to next"}
      disabled={!canClean || busy}
      onclick={ops.approveCleanedAndNext}><i class="bi bi-check2-square" aria-hidden="true"></i></button
    >
    <button
      class="palette-command"
      type="button"
      title="Clear saved history for this step"
      aria-label="Clear saved history for this step"
      aria-pressed={pageMarkedComplete}
      disabled={!pageId || busy || !canClean}
      onclick={() => ops.forgetPageHistory()}
      ><i class="bi bi-journal-x" aria-hidden="true"></i></button
    >
  </div>
  <div class="palette-command-group" role="group" aria-label="Inpaint">
    <span class="palette-group-name">Inpaint</span>
    {#each cleanModelChoices(backend) as model}
      {@const unavailable = inpaintUnavailable(model.id, backend)}
      <button
        class="palette-command inpaint-model"
        type="button"
        style="color:{model.color}"
        title={unavailable
          ? `${model.label} · ${unavailable}`
            : `${model.label} · approves the mask and cleans${backend?.models?.some(item => item.id === model.id && item.tasks.includes('cleaning')) ? ". Edit the prompt first." : ""}`}
        aria-label={unavailable ? `${model.label} · ${unavailable}` : model.label}
        disabled={!canStartClean(
          canClean,
          busy,
          !!pageDoc?.data.mask,
          strokes.length,
          unavailable,
        )}
        onclick={() => ops.cleanWith(model.id)}
        ><i class="bi {model.icon}" aria-hidden="true"></i></button
      >
    {/each}
  </div>
{/if}

{#if step === "Typeset"}
  <div class="palette-command-group" role="group" aria-label="Page history">
    <span class="palette-group-name">Page</span>
    <button
      class="palette-command"
      type="button"
      title="Clear saved history for this step"
      aria-label="Clear saved history for this step"
      aria-pressed={pageMarkedComplete}
      disabled={!pageId || busy || !canClean}
      onclick={() => ops.forgetPageHistory()}
      ><i class="bi bi-journal-x" aria-hidden="true"></i></button
    >
  </div>
{/if}

{#if step === "Typeset" && selected && regionDoc}
  <div class="palette-command-group" role="group" aria-label="Text">
    <span class="palette-group-name">Text</span><button
      class="palette-command"
      type="button"
      title="Auto-fit"
      aria-label="Auto-fit"
      disabled={!canClean || busy || regionDoc.data.locked}
      onclick={() =>
        ops.act({
          action: "fit",
          id: selected.id,
          expectedRevision: regionDoc.revision,
        })}><i class="bi bi-textarea-resize" aria-hidden="true"></i></button
    >
    <button
      class="palette-command"
      type="button"
      aria-pressed={regionDoc.data.locked}
      title={regionDoc.data.locked ? "Unlock layout" : "Lock layout"}
      aria-label={regionDoc.data.locked ? "Unlock layout" : "Lock layout"}
      disabled={!canClean}
      onclick={() =>
        ops.act({
          action: "region",
          id: selected.id,
          expectedRevision: regionDoc.revision,
          data: { locked: !regionDoc.data.locked },
        })}><i class="bi bi-lock" aria-hidden="true"></i></button
    >
    <button
      class="palette-command"
      type="button"
      title="Knock out overlapping regions"
      aria-label="Knock out overlapping regions"
      disabled={!canClean || busy}
      onclick={() =>
        ops.act({
          action: "text-mask",
          id: selected.id,
          expectedRevision: regionDoc.revision,
          knockout: true,
        })}><i class="bi bi-front" aria-hidden="true"></i></button
    >
    <button
      class="palette-command"
      type="button"
      title="Clear text mask"
      aria-label="Clear text mask"
      disabled={!canClean || busy || !regionDoc.data.textMask}
      onclick={() =>
        ops.act({
          action: "text-mask",
          id: selected.id,
          expectedRevision: regionDoc.revision,
          clear: true,
        })}><i class="bi bi-circle" aria-hidden="true"></i></button
    >
  </div>
{/if}

{#if selected && regionDoc && step === "Typeset"}
  <div class="palette-command-group" role="group" aria-label="Geometry">
    <span class="palette-group-name">Geometry</span><button
      class="palette-command"
      type="button"
      title="Set polygon to region bounds"
      aria-label="Set polygon to region bounds"
      disabled={!canClean || busy || regionDoc.data.locked}
      onclick={() => void ops.rectanglePolygon()}
      ><i class="bi bi-square" aria-hidden="true"></i></button
    ><button
      class="palette-command"
      type="button"
      title="Fit bubble (enclosed interior)"
      aria-label="Fit bubble (enclosed interior)"
      disabled={!canClean}
      onclick={() =>
        ops.act({
          action: "geometry",
          imageId: pageId,
          lineId: selected.id,
          expectedRevision: pageDoc!.revision,
          method: "opencv",
        })}><i class="bi bi-crosshair" aria-hidden="true"></i></button
    >
    <button
      class="palette-command"
      type="button"
      title="Refine bubble with model points"
      aria-label="Refine bubble with model points"
      disabled={!canClean || !backend?.models?.some(m => m.tasks.includes('segmentBubble'))}
      onclick={() =>
        ops.act({
          action: "geometry",
          imageId: pageId,
          lineId: selected.id,
          expectedRevision: pageDoc!.revision,
          method: backend?.models?.find(m => m.tasks.includes('segmentBubble'))?.id,
          points: bubbleFitPoints(selected, polygonDraft),
        })}><i class="bi bi-bounding-box-circles" aria-hidden="true"></i></button
    >
    {#if !polygonActive}
      <button
        class="palette-command"
        type="button"
        title="Save polygon"
        aria-label="Save polygon"
        disabled={!canClean || polygonCount < 3}
        onclick={() => void ops.completePolygon()}
        ><i class="bi bi-check2" aria-hidden="true"></i></button
      >
    {/if}
    <button
      class="palette-command"
      type="button"
      title="Approve geometry"
      aria-label="Approve geometry"
      disabled={!canClean}
      onclick={() =>
        ops.act({
          action: "region",
          id: selected.id,
          expectedRevision: regionDoc.revision,
          data: { geometryApproved: true },
        })}><i class="bi bi-check2-square" aria-hidden="true"></i></button
    >
    <button
      class="palette-command"
      type="button"
      title="Undo geometry"
      aria-label="Undo geometry"
      disabled={!regionDoc.canUndo}
      onclick={() =>
        ops.act({
          action: "region",
          id: selected.id,
          expectedRevision: regionDoc.revision,
          data: {},
          history: "undo",
        })}><i class="bi bi-arrow-counterclockwise" aria-hidden="true"></i></button
    >
    <button
      class="palette-command"
      type="button"
      title="Redo"
      aria-label="Redo"
      disabled={!regionDoc.canRedo}
      onclick={() =>
        ops.act({
          action: "region",
          id: selected.id,
          expectedRevision: regionDoc.revision,
          data: {},
          history: "redo",
        })}><i class="bi bi-arrow-clockwise" aria-hidden="true"></i></button
    >
  </div>
{/if}

<style>
  .nudge-amount {
    grid-column: 1 / -1;
  }
  .nudge-amount input {
    box-sizing: border-box;
    width: 100%;
    height: 28px;
    margin: 0;
    padding: 0 4px;
    border: 1px solid var(--ed-line, var(--hud-line));
    border-radius: 2px;
    background: transparent;
    color: var(--ed-text, var(--hud-text));
    font: 11px/1 "Inter", sans-serif;
    text-align: center;
  }
</style>

