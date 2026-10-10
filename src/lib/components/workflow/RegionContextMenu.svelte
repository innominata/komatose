<script lang="ts">
  import "./studio-controls.css";
  import { type LineRow } from "$lib/types";
  import { builtinRegionKinds, regionKindOptions, type RegionKind } from "$lib/regionCatalog";
  import type { MaskStroke, PageData, RegionData, TextStyle, WorkflowDoc } from "$lib/workflow";
  import {
    cleanModelChoices,
    canStartClean,
    inpaintUnavailable,
    type CleanBackend,
  } from "$lib/cleanMethods";
  import { bubbleFitPoints } from "$lib/regionGeometry";

  export type ContextMenuState = {
    x: number;
    y: number;
    imageId: string;
    lineId?: string;
  };

  export type ContextMenuOps = {
    openTypeSubmenu: (el: HTMLElement) => void | Promise<void>;
    saveRotation: (id: string, revision: number, style: TextStyle, angle: number) => void;
    savePlacedTransform: (
      id: string,
      revision: number,
      style: TextStyle,
      patch: { rotation?: number; skewX?: number; skewY?: number },
    ) => void;
    inheritedStyle: (lineType: string) => TextStyle;
    act: (body: Record<string, unknown>) => unknown;
    reread: (line: LineRow) => void;
    edit: (line: LineRow, patch: Record<string, unknown>) => void;
    suggestAlternative: (line: LineRow) => void;
    openRegionAi: (line: LineRow, mode: "review" | "enquire") => void;
    openReviseEnglish: (line: LineRow) => void;
    regionDetails: (line: LineRow, comments?: boolean) => void;
    deleteRegion: (line: LineRow) => void;
    setRegionFirst: (id: string) => void;
    setLineType: (line: LineRow, type: string) => void;
    selectLine: (id: string) => void;
    switchStep: (next: string) => void | Promise<void>;
    pageOperation: (body: Record<string, unknown>) => void;
    loadReslicePreview: () => void;
    insertAt: (id: string, before: boolean) => void;
    reorder: (delta: number) => void;
    deletePage: (id: string) => void;
    describe: (ids: string[], overwrite: boolean) => void;
    transcribePage: (id: string) => void;
    translatePage: (id: string) => void;
    rereadMissing: (id: string) => void;
    fillMissing: (id: string) => void;
    applyMask: (detect?: boolean) => void;
    approveMask: () => void;
    applyCleaningPass: () => void;
    cleanWith: (method: string) => void;
    compareRegion: (line: LineRow) => void;
    saveCleaningSample: () => void;
    fitPage: (imageId?: string) => void;
    resetStyles: (scope: "page" | "chapter") => void;
    replaceFile: (imageId: string) => void;
  };

  let {
    menu = $bindable(),
    typeSubmenu = $bindable(false),
    typeSubmenuPos,
    pageTool = $bindable("select"),
    strokes = $bindable([]),
    menuEl = $bindable(),
    submenuEl = $bindable(),
    target,
    regionDoc,
    pageDoc,
    pageId,
    step,
    canEdit,
    canUpload,
    canClean,
    canChangeType,
    busy,
    aiRunning,
    fitting,
    hasMaskRegions,
    backend,
    psdHref,
    pngHref,
    regionKinds = builtinRegionKinds(),
    ops,
  }: {
    menu: ContextMenuState | null;
    typeSubmenu?: boolean;
    typeSubmenuPos: { x: number; y: number };
    pageTool?: string;
    strokes?: MaskStroke[];
    menuEl?: HTMLDivElement;
    submenuEl?: HTMLDivElement;
    target: LineRow | undefined;
    regionDoc: WorkflowDoc<RegionData> | undefined;
    pageDoc: WorkflowDoc<PageData> | undefined;
    pageId: string;
    step: string;
    canEdit: boolean;
    canUpload: boolean;
    canClean: boolean;
    canChangeType: boolean;
    busy: boolean;
    aiRunning: boolean;
    fitting: boolean;
    hasMaskRegions: boolean;
    backend: CleanBackend | null;
    psdHref: string;
    pngHref: string;
    regionKinds?: RegionKind[];
    ops: ContextMenuOps;
  } = $props();
</script>

{#if menu}
  <div
    class="menu-backdrop"
    role="presentation"
    onpointerdown={() => (menu = null)}
    oncontextmenu={(e) => e.preventDefault()}
  ></div>
  <div
    class="actions-menu wf-ui"
    bind:this={menuEl}
    role="menu"
    style={`left:${menu.x}px;top:${menu.y}px`}
    onpointerover={(e) => {
      const item = (e.target as HTMLElement).closest("[role=menuitem]");
      if (item && !item.closest(".menu-flyout")) typeSubmenu = false;
    }}
  >
    {#snippet exportPagePng()}
      {#if (step === "Clean" || step === "Typeset") && pngHref}
        <a
          role="menuitem"
          data-find="export-page-png"
          href={pngHref}
          download
          onclick={() => {
            setTimeout(() => (menu = null), 0);
          }}>Export page as PNG</a
        >
      {/if}
    {/snippet}
    {#if target}
      <strong>Region</strong>
      <div class="menu-flyout">
        <button
          type="button"
          role="menuitem"
          aria-label="Region type"
          aria-haspopup="menu"
          aria-expanded={typeSubmenu}
          onpointerenter={(e) => ops.openTypeSubmenu(e.currentTarget)}
          onclick={(e) => {
            e.stopPropagation();
            ops.openTypeSubmenu(e.currentTarget);
          }}>Region type</button
        >
      </div>
      {#if step === "Clean" || step === "Typeset"}
        <button
          role="menuitem"
          disabled={!canClean || busy || regionDoc?.data.locked}
          onclick={() => {
            const doc = regionDoc;
            menu = null;
            void ops.saveRotation(
              target.id,
              doc?.revision ?? 0,
              { ...ops.inheritedStyle(target.lineType), ...doc?.data.style },
              0,
            );
          }}>Reset rotation</button
        >
        {#if step === "Typeset"}
          <button
            role="menuitem"
            disabled={!canClean || busy || regionDoc?.data.locked}
            onclick={() => {
              const doc = regionDoc;
              menu = null;
              void ops.savePlacedTransform(
                target.id,
                doc?.revision ?? 0,
                { ...ops.inheritedStyle(target.lineType), ...doc?.data.style },
                { skewX: 0, skewY: 0 },
              );
            }}>Reset skew</button
          >
        {/if}
      {/if}
      {#if step === "Clean"}
        <button
          role="menuitem"
          disabled={!canClean || busy}
          data-find="compare-region"
          onclick={() => {
            const line = target;
            menu = null;
            ops.compareRegion(line);
          }}>Compare raw vs cleaned…</button
        >
      {/if}
      {#if step === "Translate" || step === "Review"}
        <button
          role="menuitem"
          disabled={!canEdit || busy}
          onclick={() => ops.setRegionFirst(target.id)}
          >Set as region 1</button
        >
        <button role="menuitem" disabled={!canEdit} onclick={() => ops.reread(target)}
          >Read this area again with AI</button
        >
        <button
          role="menuitem"
          disabled={!canEdit || busy || aiRunning || !target.placed}
          onclick={() => ops.openRegionAi(target, "review")}>Review Transcription</button
        >
        <button
          role="menuitem"
          disabled={!canEdit ||
            busy ||
            aiRunning ||
            target.sourceState === "ignored" ||
            !(target.source || "").trim()}
          onclick={() => ops.openReviseEnglish(target)}>Review Translation</button
        >
        <button
          role="menuitem"
          onclick={() => {
            void navigator.clipboard.writeText(target.source || "");
            menu = null;
          }}>Copy source</button
        >
        <button
          role="menuitem"
          onclick={() => {
            void navigator.clipboard.writeText(target.body);
            menu = null;
          }}>Copy English</button
        >
        <button
          role="menuitem"
          disabled={!canEdit}
          onclick={() => {
            ops.edit(target, { status: "approved" });
            menu = null;
          }}>Approve English</button
        >
        <button
          role="menuitem"
          disabled={!canEdit}
          onclick={() => {
            ops.edit(target, { status: "needs_work" });
            menu = null;
          }}>Mark needs work</button
        >
        <button
          role="menuitem"
          disabled={!canEdit || busy || aiRunning || target.sourceState === "ignored"}
          onclick={() => void ops.suggestAlternative(target)}>Suggest alternative</button
        >
        <button
          role="menuitem"
          disabled={!canEdit || busy}
          onclick={() => ops.openRegionAi(target, "enquire")}>Enquire</button
        >
        <button
          role="menuitem"
          disabled={!canEdit}
          onclick={() => {
            const reason = window.prompt(
              "Reason to ignore this region",
              target.ignoreReason || "",
            );
            if (reason?.trim())
              ops.edit(target, { sourceState: "ignored", ignoreReason: reason });
            menu = null;
          }}>Ignore region…</button
        >
        <button role="menuitem" onclick={() => void ops.regionDetails(target)}
          >Edit bounds / split / merge</button
        >
        <button role="menuitem" onclick={() => ops.regionDetails(target, true)}
          >Comments / correction</button
        >
        <button role="menuitem" disabled={!canEdit} onclick={() => ops.deleteRegion(target)}
          >Delete region…</button
        >
      {/if}
      {#if step === "Typeset"}
        <button
          role="menuitem"
          disabled={!canClean || busy}
          onclick={() => {
            menu = null;
            void ops.act({
              action: "geometry",
              imageId: pageId,
              lineId: target.id,
              expectedRevision: pageDoc!.revision,
              method: backend?.models?.some(m => m.tasks.includes('segmentBubble')) ? backend!.models!.find(m => m.tasks.includes('segmentBubble'))!.id : "opencv",
              ...(backend?.models?.some(m => m.tasks.includes('segmentBubble')) ? { points: bubbleFitPoints(target) } : {}),
            });
          }}>Fit bubble</button
        >
        <button
          role="menuitem"
          disabled={!canClean || busy}
          onclick={() => {
            menu = null;
            void ops.act({
              action: "geometry",
              imageId: pageId,
              lineId: target.id,
              expectedRevision: pageDoc!.revision,
              method: "opencv",
            });
          }}>Find enclosed interior</button
        >
        <button
          role="menuitem"
          disabled={!canClean || busy}
          onclick={() => {
            menu = null;
            void ops.act({
              action: "region",
              id: target.id,
              expectedRevision: regionDoc?.revision ?? 0,
              data: { geometryApproved: true },
            });
          }}>Approve geometry</button
        >
        <button
          role="menuitem"
          disabled={!canClean}
          onclick={() => {
            ops.selectLine(target.id);
            menu = null;
            void ops.act({
              action: "fit",
              id: target.id,
              expectedRevision: regionDoc?.revision ?? 0,
            });
          }}>Typeset this region</button
        >
        <button
          role="menuitem"
          disabled={!canClean || busy}
          onclick={() => {
            const doc = regionDoc;
            menu = null;
            void ops.act({
              action: "region",
              id: target.id,
              expectedRevision: doc?.revision ?? 0,
              data: { locked: !doc?.data.locked },
            });
          }}>{regionDoc?.data.locked ? "Unlock layout" : "Lock layout"}</button
        >
        <button
          role="menuitem"
          disabled={!canClean || busy}
          onclick={() => {
            const doc = regionDoc;
            menu = null;
            void ops.act({
              action: "text-mask",
              id: target.id,
              expectedRevision: doc?.revision ?? 0,
              knockout: true,
            });
          }}>Knock out overlapping regions</button
        >
        <button
          role="menuitem"
          disabled={!canClean || busy || !regionDoc?.data.textMask}
          onclick={() => {
            const doc = regionDoc;
            menu = null;
            void ops.act({
              action: "text-mask",
              id: target.id,
              expectedRevision: doc?.revision ?? 0,
              clear: true,
            });
          }}>Clear text mask</button
        >
      {/if}
      {@render exportPagePng()}
    {:else}
      <strong>Page</strong>
      <button
        role="menuitem"
        onclick={() => {
          void ops.switchStep("Prepare");
          menu = null;
        }}>Page info</button
      >
      {#if step === "Prepare"}
        <button
          role="menuitem"
          disabled={!canUpload || busy}
          onclick={() => {
            pageTool = "crop";
            menu = null;
          }}>Crop page…</button
        >
        <button
          role="menuitem"
          disabled={!canUpload || busy}
          onclick={() => {
            pageTool = "split";
            menu = null;
          }}>Split page…</button
        >
        <button
          role="menuitem"
          disabled={!canUpload || busy}
          onclick={() => {
            // The tool reacts to the selection and stitches the window around this page.
            pageTool = "reslice";
            menu = null;
          }}>Reslice strips…</button
        >
        <button
          role="menuitem"
          disabled={!canUpload || busy}
          onclick={() => ops.pageOperation({ op: "auto-crop", imageIds: [menu!.imageId] })}
          >Auto-crop margins</button
        >
        <button
          role="menuitem"
          disabled={!canUpload || busy}
          onclick={() => ops.replaceFile(menu!.imageId)}>Replace from image / PSD…</button
        >
        <button
          role="menuitem"
          disabled={!canUpload || busy}
          onclick={() => ops.insertAt(menu!.imageId, true)}>Insert images before…</button
        >
        <button
          role="menuitem"
          disabled={!canUpload || busy}
          onclick={() => ops.insertAt(menu!.imageId, false)}>Insert images after…</button
        >
        <button
          role="menuitem"
          disabled={!canUpload || busy}
          onclick={() => {
            menu = null;
            void ops.reorder(-1);
          }}>Move page earlier</button
        >
        <button
          role="menuitem"
          disabled={!canUpload || busy}
          onclick={() => {
            menu = null;
            void ops.reorder(1);
          }}>Move page later</button
        >
        <button
          role="menuitem"
          disabled={!canClean || busy}
          onclick={() => ops.pageOperation({ op: "revert", imageId: menu!.imageId })}
          >Revert to original raw</button
        >
        <button
          role="menuitem"
          disabled={!canUpload || busy}
          onclick={() => ops.deletePage(menu!.imageId)}>Delete page…</button
        >
      {/if}
      {#if step === "Translate" || step === "Review"}
        <button
          role="menuitem"
          disabled={!canUpload || busy}
          onclick={() => ops.describe([menu!.imageId], true)}>Refresh scene context</button
        >
        <button
          role="menuitem"
          disabled={!canUpload || busy}
          onclick={() => ops.transcribePage(menu!.imageId)}>Transcribe page</button
        >
        <button
          role="menuitem"
          disabled={!canUpload || busy}
          onclick={() => ops.translatePage(menu!.imageId)}>Translate page</button
        >
        <button
          role="menuitem"
          disabled={!canEdit || busy}
          onclick={() => {
            const id = menu!.imageId;
            menu = null;
            void ops.rereadMissing(id);
          }}>Re-read missing / low-certainty</button
        >
        <button
          role="menuitem"
          disabled={!canEdit || busy}
          onclick={() => {
            const id = menu!.imageId;
            menu = null;
            void ops.fillMissing(id);
          }}>Fill missing source &amp; English</button
        >
      {/if}
      {#if step === "Clean"}
        <button
          role="menuitem"
          disabled={!canClean || busy || strokes.length > 0 || !hasMaskRegions}
          onclick={() => {
            menu = null;
            void ops.applyMask(true);
          }}>Detect lettering</button
        >
        <button
          role="menuitem"
          disabled={
            !canClean ||
            busy ||
            (!strokes.length && !(pageDoc?.data.mask && !pageDoc.data.maskApproved))
          }
          onclick={() => {
            menu = null;
            ops.approveMask();
          }}>Approve mask</button
        >
        <button
          role="menuitem"
          disabled={!canClean}
          onclick={() => {
            strokes = [];
            menu = null;
          }}>Clear draft strokes</button
        >
        {#each cleanModelChoices(backend) as model}
          {@const unavailable = inpaintUnavailable(model.id, backend)}
          <button
            role="menuitem"
            disabled={!canStartClean(
              canClean,
              busy,
              !!pageDoc?.data.mask,
              strokes.length,
              unavailable,
            )}
            onclick={() => {
              menu = null;
              ops.cleanWith(model.id);
            }}>{unavailable ? `${model.label} · ${unavailable}` : model.label}</button
          >
        {/each}
        <button
          class="accent-save"
          role="menuitem"
          disabled={!canClean || busy}
          onclick={() => {
            menu = null;
            void ops.applyCleaningPass();
          }}><i class="bi bi-floppy" aria-hidden="true"></i> Apply cleaning &amp; start new mask</button
        >
        <button
          role="menuitem"
          disabled={!canClean || !pageDoc?.canUndo}
          onclick={() => {
            menu = null;
            void ops.act({
              action: "page",
              imageId: pageId,
              expectedRevision: pageDoc!.revision,
              data: {},
              history: "undo",
            });
          }}>Undo saved edit (Ctrl+Z)</button
        >
        <button
          role="menuitem"
          disabled={!canClean || !pageDoc?.canRedo}
          onclick={() => {
            menu = null;
            void ops.act({
              action: "page",
              imageId: pageId,
              expectedRevision: pageDoc!.revision,
              data: {},
              history: "redo",
            });
          }}>Redo clean</button
        >
        <button
          role="menuitem"
          disabled={!canClean || busy}
          onclick={() => ops.pageOperation({ op: "revert", imageId: menu!.imageId })}
          >Revert to original raw</button
        >
        <button
          role="menuitem"
          disabled={!canClean || busy}
          onclick={() => {
            menu = null;
            ops.saveCleaningSample();
          }}>Save sample raw / clean</button
        >
      {/if}
      {#if step === "Typeset"}
        <button
          role="menuitem"
          disabled={!canClean || busy || fitting}
          onclick={() => ops.fitPage(menu!.imageId)}>Auto-fit all text on page</button
        >
        <button
          role="menuitem"
          disabled={!canClean || busy || fitting}
          onclick={() => void ops.resetStyles("page")}
          >Reset page to series defaults</button
        >
      {/if}
      {@render exportPagePng()}
      {#if menu}
        <a role="menuitem" href={psdHref} download>Export page PSD (draft)</a>
      {/if}
    {/if}
  </div>
  {#if target && typeSubmenu}
    <div
      class="actions-submenu wf-ui"
      bind:this={submenuEl}
      role="menu"
      aria-label="Region type"
      style={`left:${typeSubmenuPos.x}px;top:${typeSubmenuPos.y}px`}
      onpointerenter={() => (typeSubmenu = true)}
    >
      {#each regionKindOptions(regionKinds, target.lineType) as t}
        <button
          type="button"
          role="menuitem"
          class:active={target.lineType === t.id}
          disabled={!canChangeType}
          onclick={() => {
            ops.setLineType(target, t.id);
            menu = null;
            typeSubmenu = false;
          }}>{t.label}</button
        >
      {/each}
    </div>
  {/if}
{/if}

<style>
  .menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1000;
  }
  .actions-menu {
    position: fixed;
    z-index: 1001;
    width: 240px;
    max-width: calc(100vw - 16px);
    max-height: calc(100vh - 16px);
    overflow: auto;
    background: var(--hud-bg-2);
    border: 1px solid var(--hud-line);
    border-radius: 2px;
    padding: 4px;
    box-shadow: 0 12px 40px #0009;
    display: flex;
    flex-direction: column;
    gap: 1px;
    font-size: 12px;
  }
  .actions-menu button,
  .actions-menu a,
  .actions-submenu button {
    text-align: left;
    padding: 3px 7px;
    font-size: 12px;
    line-height: 1.35;
    min-height: 24px;
    flex-shrink: 0;
  }
  .actions-menu strong {
    padding: 3px 7px;
    font-size: 11px;
    line-height: 1.3;
    color: var(--ed-muted);
  }
  .menu-flyout {
    position: relative;
  }
  .menu-flyout > button {
    width: 100%;
  }
  .menu-flyout > button::after {
    content: "›";
    float: right;
    opacity: 0.7;
  }
  .actions-submenu {
    position: fixed;
    z-index: 1002;
    width: 160px;
    max-width: calc(100vw - 16px);
    max-height: calc(100vh - 16px);
    overflow: auto;
    padding: 4px;
    background: var(--hud-bg-2);
    border: 1px solid var(--hud-line);
    border-radius: 2px;
    box-shadow: 0 12px 40px #0009;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .actions-submenu button.active {
    color: var(--accent, var(--ed-active, var(--hud-teal)));
    outline: 1px solid var(--accent, var(--ed-active, var(--hud-teal)));
  }
  .accent-save {
    color: var(--hud-teal-ink);
  }
  .accent-save i {
    margin-right: 0.35rem;
  }
</style>
