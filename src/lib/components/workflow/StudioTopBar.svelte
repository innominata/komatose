<script lang="ts">
  import type { Snippet } from "svelte";
  import AppBrand from "../AppBrand.svelte";
  import ThemeToggle from "../ThemeToggle.svelte";
  import RebuildButton from "../RebuildButton.svelte";
  import type { Episode, ImageRow, Series } from "$lib/types";
  import { STUDIO_STAGE_ORDER } from "$lib/studioActions";

  let {
    series,
    episode,
    page,
    step,
    counts,
    canRebuild = false,
    chapterSelected = false,
    onrebuild,
    onswitch,
    exceptionCount = 0,
    exceptionLabel = "Nothing to check",
    onnextexception,
    onissues,
    unsaved = 0,
    onsettings,
    openMenu = $bindable(null),
    pagesOpen = false,
    inspectorOpen = false,
    jobsOpen = false,
    zoom = 100,
    ontogglepane,
    onzoom,
    onresetzoom,
    onshortcuts,
    children,
  }: {
    series: Series;
    episode: Episode;
    page: ImageRow | undefined;
    step: string;
    counts: Record<string, string>;
    canRebuild?: boolean;
    chapterSelected?: boolean;
    onrebuild?: () => Promise<unknown>;
    onswitch: (next: string) => void;
    exceptionCount?: number;
    exceptionLabel?: string;
    onnextexception?: () => void;
    onissues?: () => void;
    unsaved?: number;
    onsettings: () => void;
    openMenu?: string | null;
    pagesOpen?: boolean;
    inspectorOpen?: boolean;
    jobsOpen?: boolean;
    zoom?: number;
    ontogglepane: (pane: "pages" | "inspector" | "jobs") => void;
    onzoom: (dir: 1 | -1) => void;
    onresetzoom: () => void;
    onshortcuts: () => void;
    children?: Snippet;
  } = $props();

function meterWidth(count: string | undefined) {
    const match = /^(\d+)\/(\d+)$/.exec(count ?? "");
    if (!match) return null;
    const total = Number(match[2]);
    return total ? Math.round((Number(match[1]) / total) * 100) : 0;
  }
</script>

<header class="studio-top" data-find="stepper">
  <span class="brand-cluster">
    <AppBrand class="ed-brand" />
    {#if canRebuild}
      <RebuildButton {step} pageId={page?.id} {chapterSelected} onbefore={onrebuild} />
    {/if}
  </span>
  <nav class="studio-crumb" aria-label="Location">
    <a href={`/series/${series.id}`}>{series.title}</a>
    <span class="bi bi-chevron-right" aria-hidden="true"></span>
    <strong>{episode.title}</strong>
  </nav>
  <nav class="studio-stepper" aria-label="Chapter workflow" data-find="stepper-nav">
    {#each STUDIO_STAGE_ORDER as stage, index (stage.id)}
      {@const width = meterWidth(counts[stage.label])}
      <button
        type="button"
        class="step"
        class:active={step === stage.label}
        title={stage.purpose}
        onclick={() => onswitch(stage.label)}
      >
        <span class="num" aria-hidden="true">{index + 1}</span>
        <span class="lbl">{stage.label}</span>
        {#if width !== null}<span class="meter" aria-hidden="true"><i style={`width:${width}%`}></i></span>{/if}
        <small aria-hidden="true" class:warn={/renumber|blocker/.test(counts[stage.label] ?? "")}>{counts[stage.label] ?? ""}</small>
      </button>
    {/each}
  </nav>
  <div class="top-right">
  {@render children?.()}
  <div class="issue-pair">
    <button
      class="ed-btn"
      type="button"
      data-find="issues"
      title={exceptionLabel}
      onclick={() => onissues?.()}
    ><i class="bi bi-flag" aria-hidden="true"></i> <b>{exceptionCount}</b> to check</button>
    <button
      class="ed-btn exception-next forward"
      type="button"
      data-find="next-issue"
      disabled={!exceptionCount}
      title={exceptionLabel}
      onclick={() => onnextexception?.()}
    >Next <i class="bi bi-arrow-right" aria-hidden="true"></i></button>
  </div>
  <ThemeToggle />
  <span class="save-studioState" data-find="save-status">{#if unsaved}<i class="bi bi-exclamation-triangle" aria-hidden="true"></i> {unsaved} unsaved{:else}<i class="bi bi-cloud-check" aria-hidden="true"></i> All text saved{/if}</span>
  <button class="ed-btn" type="button" data-find="settings" aria-label="Settings" onclick={onsettings}><i class="bi bi-sliders" aria-hidden="true"></i><span class="txt">Settings</span></button>
  <div class="ed-menu bar-menu">
    <button
      class="ed-btn"
      type="button"
      data-find="view-menu"
      aria-label="View"
      class:active={openMenu === "view"}
      onclick={(e) => { e.stopPropagation(); openMenu = openMenu === "view" ? null : "view"; }}
    ><i class="bi bi-three-dots" aria-hidden="true"></i></button>
    {#if openMenu === "view"}
      <div class="ed-menu-panel" role="menu">
        <button type="button" role="menuitemcheckbox" aria-checked={pagesOpen} onclick={() => { ontogglepane("pages"); openMenu = null; }}>Pages panel</button>
        <button type="button" role="menuitemcheckbox" aria-checked={inspectorOpen} onclick={() => { ontogglepane("inspector"); openMenu = null; }}>Properties panel</button>
        <button type="button" role="menuitemcheckbox" aria-checked={jobsOpen} onclick={() => { ontogglepane("jobs"); openMenu = null; }}>Jobs panel</button>
        <button type="button" role="menuitem" onclick={() => { onzoom(1); openMenu = null; }}>Zoom in</button>
        <button type="button" role="menuitem" onclick={() => { onzoom(-1); openMenu = null; }}>Zoom out</button>
        <button type="button" role="menuitem" onclick={() => { onresetzoom(); openMenu = null; }}>Reset zoom ({zoom}%)</button>
        <button type="button" role="menuitem" onclick={() => { onshortcuts(); openMenu = null; }}>Keyboard shortcuts</button>
      </div>
    {/if}
  </div>
  </div>
</header>

<style>
  .studio-top {
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
    overflow: visible;
    padding: 0 12px;
    height: 54px;
    flex-wrap: nowrap;
    border-bottom: 1px solid var(--hud-line);
    background: var(--hud-bg);
    font-family: Inter, system-ui, sans-serif;
    letter-spacing: 0;
    text-transform: none;
  }
  .brand-cluster { display: inline-flex; align-items: center; gap: 2px; flex: 0 0 auto; }
  .studio-top :global(a.ed-brand img) { display: block; height: 22px; width: auto; }
  .studio-crumb {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    flex: 0 1 220px;
    color: var(--hud-muted);
    font-size: 12.5px;
  }
  .studio-crumb a { color: inherit; text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .studio-crumb .bi { font-size: 10px; }
  .studio-crumb strong {
    color: var(--hud-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }
  .studio-stepper {
    display: flex;
    gap: 2px;
    margin: 0 auto;
    min-width: 0;
  }
  .step {
    display: grid;
    grid-template-columns: auto 1fr;
    grid-template-rows: auto auto;
    column-gap: 7px;
    align-items: center;
    min-width: 96px;
    padding: 4px 10px 5px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    text-align: left;
    font: inherit;
    letter-spacing: 0;
    text-transform: none;
  }
  .step:hover { background: var(--hud-hover); }
  .step .num {
    grid-row: span 2;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 1px solid var(--hud-line);
    display: grid;
    place-items: center;
    font-size: 11px;
    color: var(--hud-muted);
  }
  .step .lbl { font-weight: 600; font-size: 12.5px; }
  .step small { grid-column: 2; font-size: 10.5px; color: var(--hud-muted); white-space: nowrap; }
  .step small.warn { color: #f5b85c; }
  .step .meter {
    grid-column: 2;
    display: block;
    width: 44px;
    height: 3px;
    background: var(--hud-line);
    border-radius: 2px;
    overflow: hidden;
  }
  .step .meter i { display: block; height: 100%; background: #5ee39a; }
  .step .meter + small { grid-row: 2; margin-left: 50px; }
  .step.active { background: var(--hud-teal-dim); border-color: var(--hud-teal-ink); }
  .step.active .num { background: var(--hud-teal); color: var(--hud-on-teal); border-color: var(--hud-teal-ink); font-weight: 700; }
  .step.active .lbl { color: var(--hud-teal-ink); }
  .top-right { display: flex; align-items: center; gap: 6px; flex: none; }
  .issue-pair { display: inline-flex; border: 1px solid var(--hud-line); border-radius: 999px; overflow: hidden; }
  .issue-pair :global(.ed-btn) { border: 0; border-radius: 0; }
  .issue-pair :global(.exception-next) {
    background: var(--hud-primary);
    color: var(--hud-on-primary);
    box-shadow: inset 1px 0 var(--hud-line);
  }
  .issue-pair b { color: #f5b85c; font-weight: 600; }
  .save-studioState { color: var(--hud-muted); font-size: 11.5px; white-space: nowrap; padding: 0 4px; }
  .ed-menu { position: relative; }
  .ed-menu-panel {
    position: absolute;
    right: 0;
    top: 100%;
    z-index: 30;
    min-width: 220px;
    padding: 6px;
    background: var(--hud-bg-2);
    border: 1px solid var(--hud-line);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .ed-menu-panel button {
    text-align: left;
    background: transparent;
    border: 0;
    color: inherit;
    padding: 6px 8px;
  }
  .studio-top :global(.ed-btn) {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border-radius: 5px;
    white-space: nowrap;
    background: transparent;
    border: 1px solid transparent;
    color: inherit;
    font-family: Inter, system-ui, sans-serif;
    font-weight: 500;
    letter-spacing: 0;
    text-transform: none;
    font-size: 12.5px;
  }
  .studio-top :global(kbd) {
    font: 500 10px "JetBrains Mono", monospace;
    padding: 1px 4px;
    margin-left: 4px;
    border: 1px solid var(--hud-line);
    border-radius: 3px;
    color: var(--hud-muted);
  }
  .studio-top :global(.ed-btn:hover:not(:disabled)) { background: var(--hud-hover); border-color: var(--hud-line); }
  .studio-top :global(.ed-btn:disabled) { opacity: 0.4; }
  .studio-top :global(.ed-btn[data-find="palette"]) { color: var(--hud-muted); }
  @media (max-width: 1500px) {
    .studio-top :global(.ed-btn .txt) { display: none; }
    .studio-crumb { flex-basis: 180px; }
  }
  @media (max-width: 1400px) {
    .save-studioState { display: none; }
    .step { min-width: 0; padding: 5px 8px; }
    .step .meter { display: none; }
    .step .meter + small { margin-left: 0; }
  }
  @media (max-width: 1100px) {
    .studio-crumb { display: none; }
  }
</style>
