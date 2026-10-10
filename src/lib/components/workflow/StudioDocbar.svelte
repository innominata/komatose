<script lang="ts">
  import AppBrand from "../AppBrand.svelte";
  import RebuildButton from "../RebuildButton.svelte";
  import WorkCredit from "../WorkCredit.svelte";
  import type { Episode, ImageRow, Series } from "$lib/types";

  let {
    series,
    episode,
    page,
    step,
    translateStep,
    openMenu = $bindable(null),
    chapterSelected = $bindable(true),
    pagesOpen = $bindable(true),
    inspectorOpen = $bindable(true),
    zoom = $bindable(100),
    jobsRunning,
    unsaved,
    busy,
    canEdit,
    canUpload,
    canClean,
    canRebuild = false,
    fitting,
    pagePsdHref,
    ontogglemenu,
    ontypesettings,
    onregioncolors,
    onaimodels,
    onrunai,
    translateBlockedReason = "",
    proofreadEnglishBlockedReason = "",
    onrereadmissing,
    onfillmissing,
    onfitchapter,
    onresetstyles,
    onswitchstep,
    ontranscribepage,
    ontranslatepage,
    onfitpage,
    onremoveregions,
    regionCount = 0,
    onsavesample,
    onpersistlayout,
    onnudgezoom,
    onrebuild,
    hasCleaningSample,
    exceptionCount = 0,
    exceptionLabel = "Nothing to review",
    onnextexception,
  }: {
    series: Series;
    episode: Episode;
    page: ImageRow | undefined;
    step: string;
    translateStep: boolean;
    openMenu?: null | "series" | "chapter" | "page" | "view";
    chapterSelected?: boolean;
    pagesOpen?: boolean;
    inspectorOpen?: boolean;
    zoom?: number;
    jobsRunning: number;
    unsaved: number;
    busy: boolean;
    canEdit: boolean;
    canUpload: boolean;
    canClean: boolean;
    canRebuild?: boolean;
    fitting: boolean;
    pagePsdHref: string;
    ontogglemenu: (next: "series" | "chapter" | "page" | "view") => void;
    ontypesettings: () => void;
    onregioncolors: () => void;
    onaimodels: () => void;
    onrunai: (kind: string, imageId?: string) => void;
    translateBlockedReason?: string;
    proofreadEnglishBlockedReason?: string;
    onrereadmissing: (imageId?: string) => void;
    onfillmissing: (imageId?: string) => void;
    onfitchapter: () => void;
    onresetstyles: (scope: "page" | "chapter") => void;
    onswitchstep: (next: string) => void;
    ontranscribepage: (id: string) => void;
    ontranslatepage: (id: string) => void;
    onfitpage: () => void;
    onremoveregions: () => void;
    regionCount?: number;
    onsavesample: () => void;
    hasCleaningSample: boolean;
    onpersistlayout: () => void;
    onnudgezoom: (dir: 1 | -1) => void;
    onrebuild?: () => Promise<unknown>;
    exceptionCount?: number;
    exceptionLabel?: string;
    onnextexception?: () => void;
  } = $props();
</script>

<header class="ed-docbar">
  <span class="brand-cluster">
    <AppBrand class="ed-brand" />
    {#if canRebuild}
      <RebuildButton {step} pageId={page?.id} {chapterSelected} onbefore={onrebuild} />
    {/if}
  </span>
  <a href={`/series/${series.id}`} class="ed-back">← {series.title}</a>
  <WorkCredit title={series.title} compact />
  <strong class="ed-title">{episode.title}</strong>
  {#if jobsRunning}
    <span class="job-spinner" role="status">
      <span class="spin" aria-hidden="true"></span>
      {jobsRunning} job{jobsRunning === 1 ? "" : "s"} running
    </span>
  {/if}
  <span class="ed-sep"></span>
  <div class="ed-menu bar-menu">
    <button
      class="ed-btn"
      class:active={openMenu === "series"}
      type="button"
      onclick={() => ontogglemenu("series")}
      onpointerenter={() => {
        if (openMenu) openMenu = "series";
      }}>Series</button
    >
    {#if openMenu === "series"}
      <div class="ed-menu-panel" role="menu">
        <button type="button" role="menuitem" onclick={ontypesettings}
          >Type settings…</button
        >
        <button
          type="button"
          role="menuitem"
          disabled={!canEdit || busy}
          onclick={onaimodels}>AI model settings…</button
        >
      </div>
    {/if}
  </div>
  <div class="ed-menu bar-menu">
    <button
      class="ed-btn"
      class:active={openMenu === "chapter"}
      type="button"
      onclick={() => ontogglemenu("chapter")}
      onpointerenter={() => {
        if (openMenu) openMenu = "chapter";
      }}>Chapter</button
    >
    {#if openMenu === "chapter"}
      <div class="ed-menu-panel" role="menu">
        <button
          type="button"
          role="menuitem"
          onclick={() => {
            chapterSelected = true;
            openMenu = null;
          }}>Chapter settings</button
        >
        {#if translateStep}
          <button
            type="button"
            role="menuitem"
            disabled={busy || !canUpload}
            onclick={() => {
              openMenu = null;
              void onrunai("transcribe");
            }}>Transcribe chapter</button
          >
          <button
            type="button"
            role="menuitem"
            disabled={busy || !canUpload || Boolean(translateBlockedReason)}
            title={translateBlockedReason || undefined}
            onclick={() => {
              openMenu = null;
              void onrunai("translate");
            }}>Translate chapter</button
          >
          <button
            type="button"
            role="menuitem"
            disabled={busy || !canEdit || Boolean(proofreadEnglishBlockedReason)}
            title={proofreadEnglishBlockedReason || undefined}
            onclick={() => {
              openMenu = null;
              void onrunai("proofread");
            }}>Proofread edited English</button
          >
          <button
            type="button"
            role="menuitem"
            disabled={busy || !canEdit}
            onclick={() => {
              openMenu = null;
              void onrereadmissing();
            }}>Re-read missing / low-certainty</button
          >
          <button
            type="button"
            role="menuitem"
            disabled={busy || !canEdit}
            onclick={() => {
              openMenu = null;
              void onfillmissing();
            }}>Fill missing source &amp; English</button
          >
        {/if}
        {#if step === "Typeset"}
          <button
            type="button"
            role="menuitem"
            disabled={!canClean || busy || fitting}
            onclick={() => onfitchapter()}>Find &amp; fit whole chapter</button
          >
          <button
            type="button"
            role="menuitem"
            disabled={!canClean || busy || fitting}
            onclick={() => void onresetstyles("chapter")}
            >Reset all text to series defaults</button
          >
        {/if}
        <span class="menu-rule"></span>
        <button
          type="button"
          role="menuitem"
          onclick={() => {
            openMenu = null;
            void onswitchstep("Export");
          }}>Export…</button
        >
      </div>
    {/if}
  </div>
  <div class="ed-menu bar-menu">
    <button
      class="ed-btn"
      class:active={openMenu === "page"}
      type="button"
      disabled={!page}
      onclick={() => ontogglemenu("page")}
      onpointerenter={() => {
        if (openMenu && page) openMenu = "page";
      }}>Page</button
    >
    {#if openMenu === "page"}
      <div class="ed-menu-panel" role="menu">
        <button
          type="button"
          role="menuitem"
          disabled={!page}
          onclick={() => {
            openMenu = null;
            void onswitchstep("Prepare");
          }}>Page info</button
        >
        {#if translateStep}
          <button
            type="button"
            role="menuitem"
            disabled={busy || !canUpload || !page}
            onclick={() => {
              openMenu = null;
              if (page) void ontranscribepage(page.id);
            }}>Transcribe page</button
          >
          <button
            type="button"
            role="menuitem"
            disabled={busy || !canUpload || !page || Boolean(translateBlockedReason)}
            title={translateBlockedReason || undefined}
            onclick={() => {
              openMenu = null;
              if (page) void ontranslatepage(page.id);
            }}>Translate page</button
          >
          <button
            type="button"
            role="menuitem"
            disabled={busy || !canEdit || !page || Boolean(proofreadEnglishBlockedReason)}
            title={proofreadEnglishBlockedReason || undefined}
            onclick={() => {
              openMenu = null;
              if (page) void onrunai("proofread", page.id);
            }}>Proofread edited English</button
          >
          <button
            type="button"
            role="menuitem"
            disabled={busy || !canEdit || !page}
            onclick={() => {
              openMenu = null;
              if (page) void onrereadmissing(page.id);
            }}>Re-read missing / low-certainty</button
          >
          <button
            type="button"
            role="menuitem"
            disabled={busy || !canEdit || !page}
            onclick={() => {
              openMenu = null;
              if (page) void onfillmissing(page.id);
            }}>Fill missing source &amp; English</button
          >
          <span class="menu-rule"></span>
          <button
            type="button"
            role="menuitem"
            disabled={busy || !canEdit || !page || !regionCount}
            onclick={() => {
              openMenu = null;
              onremoveregions();
            }}>Remove all regions</button
          >
        {/if}
        {#if step === "Clean"}
          <button
            type="button"
            role="menuitem"
            disabled={!canClean || busy || !page || !hasCleaningSample}
            onclick={() => {
              openMenu = null;
              onsavesample();
            }}>Save Sample Raw/Clean</button
          >
        {/if}
        {#if step === "Typeset"}
          <button
            type="button"
            role="menuitem"
            disabled={!canClean || busy || fitting || !page}
            onclick={() => onfitpage()}>Auto-fit all text on page</button
          >
          <button
            type="button"
            role="menuitem"
            disabled={!canClean || busy || fitting || !page}
            onclick={() => void onresetstyles("page")}
            >Reset page to series defaults</button
          >
        {/if}
        <span class="menu-rule"></span>
        {#if page}<a
            role="menuitem"
            href={pagePsdHref}
            download
            onclick={() => (openMenu = null)}>Export page PSD</a
          >{/if}
      </div>
    {/if}
  </div>
  <span class="ed-sep"></span>
  <div class="ed-menu bar-menu">
    <button
      class="ed-btn"
      type="button"
      aria-haspopup="menu"
      aria-expanded={openMenu === "view"}
      class:active={openMenu === "view"}
      onclick={() => ontogglemenu("view")}
      onpointerenter={() => {
        if (openMenu) openMenu = "view";
      }}>View</button
    >
    {#if openMenu === "view"}<div class="ed-menu-panel" role="menu">
        <button
          role="menuitemcheckbox"
          aria-checked={pagesOpen}
          onclick={() => {
            pagesOpen = !pagesOpen;
            onpersistlayout();
            openMenu = null;
          }}>Pages panel</button
        >
        <button
          role="menuitemcheckbox"
          aria-checked={inspectorOpen}
          onclick={() => {
            inspectorOpen = !inspectorOpen;
            onpersistlayout();
            openMenu = null;
          }}>Properties panel</button
        >
        <span class="menu-rule"></span>
        <button
          type="button"
          role="menuitem"
          onclick={() => {
            onregioncolors();
            openMenu = null;
          }}>Region colors…</button
        >
        <button
          role="menuitem"
          onclick={() => {
            onnudgezoom(1);
            openMenu = null;
          }}>Zoom in</button
        >
        <button
          role="menuitem"
          onclick={() => {
            onnudgezoom(-1);
            openMenu = null;
          }}>Zoom out</button
        >
        <button
          role="menuitem"
          onclick={() => {
            zoom = 100;
            openMenu = null;
          }}>Reset zoom</button
        >
      </div>{/if}
  </div>
  <button
    type="button"
    class="ed-btn exception-next"
    disabled={!exceptionCount}
    title={exceptionLabel}
    onclick={() => onnextexception?.()}
    >Next{#if exceptionCount}<span> · {exceptionCount}</span>{/if}</button
  >
  <span class="save-studioState"
    >{unsaved ? `${unsaved} unsaved` : "All text saved"}</span
  >
</header>

<style>
  .brand-cluster {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }
  .ed-docbar .ed-btn {
    background: transparent;
    border: 0;
    padding: 4px 8px;
  }
  .ed-docbar .ed-btn:hover {
    background: var(--ed-hover);
  }
  .exception-next {
    margin-left: auto;
    flex-shrink: 0;
  }
  .exception-next:not(:disabled) {
    color: var(--hud-teal-ink);
  }
  .save-studioState {
    color: var(--ed-muted, var(--hud-muted));
    font-size: 12px;
    flex-shrink: 0;
  }
  @media (max-width: 760px) {
    .brand-cluster {
      display: none;
    }
    .ed-title {
      max-width: 28vw;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ed-docbar :global(.work-credit) {
      display: none;
    }
    .save-studioState {
      display: none;
    }
    .ed-docbar .ed-btn {
      padding: 4px 6px;
    }
    .exception-next {
      margin-left: auto;
    }
  }
  .bar-menu .ed-menu-panel {
    left: 0;
    right: auto;
    min-width: 248px;
    z-index: 1100;
  }
  .menu-rule {
    display: block;
    height: 1px;
    margin: 4px 6px;
    background: var(--ed-line, var(--hud-line));
  }
  .job-spinner {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--hud-teal-ink);
    font-size: 12px;
  }
  .spin {
    width: 12px;
    height: 12px;
    border: 2px solid var(--hud-line);
    border-top-color: var(--hud-teal-ink);
    border-radius: 50%;
    animation: jobspin 0.8s linear infinite;
  }
  @keyframes jobspin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
