<script lang="ts">
  import "./studio-controls.css";
  import RegionAiSettings from "../RegionAiSettings.svelte";
  import type { RegionAiSettings as RegionAiSettingsData } from "$lib/regionAi";
  import type { TaskEngine } from "$lib/aiTasks";
  import type { TranslateEngineInfo, ImageRow } from "$lib/types";
  import type { CreditKind, SeriesCredits } from "$lib/credits";
  import type { Preferences } from "$lib/workflow";
  import ResliceSizeControl from "./ResliceSizeControl.svelte";
  import { validSliceHeight, type ResliceSizing } from "$lib/reslice";

  let {
    canUpload,
    canEdit,
    busy,
    aiRunning,
    hasPage,
    pageUndoCount,
    pageUndoLabel = 'Undo page edit',
    duplicateWarning,
    numberingStale,
    pendingFiles = $bindable([]),
    stitch = $bindable(false),
    chapterDpi = $bindable(""),
    resliceSizing = $bindable<ResliceSizing>("pages"),
    resliceMaxHeight = $bindable<number | undefined>(2048),
    preferences,
    engine,
    model,
    engines,
    seriesId,
    credits = {},
    images = [],
    onaddfiles,
    onupload,
    onreorder,
    onrenumber,
    onpageop,
    onreslice,
    ondescribe,
    onsaveregionai,
    onsaveseriesprefs,
    onsavedpi,
    onuploadcredit,
    onclearcredit,
    section = "full",
  }: {
    canUpload: boolean;
    canEdit: boolean;
    busy: boolean;
    aiRunning: boolean;
    hasPage: boolean;
    pageUndoCount: number;
    pageUndoLabel?: string;
    duplicateWarning: string;
    numberingStale: boolean;
    pendingFiles?: File[];
    stitch?: boolean;
    chapterDpi?: string;
    resliceSizing?: ResliceSizing;
    resliceMaxHeight?: number;
    preferences: Preferences;
    engine: string;
    model: string;
    engines: TranslateEngineInfo[];
    seriesId: string;
    credits?: SeriesCredits;
    images?: ImageRow[];
    onaddfiles: (files: File[]) => void;
    onupload: () => void;
    onreorder: (delta: number) => void;
    onrenumber: () => void;
    onpageop: (body: Record<string, unknown>) => void;
    onreslice: () => void;
    ondescribe: () => void;
    onsaveregionai: (regionAi: RegionAiSettingsData) => Promise<boolean>;
    onsaveseriesprefs: (data: Record<string, unknown>) => void;
    onsavedpi: () => void;
    onuploadcredit: (kind: CreditKind, file: File) => void;
    onclearcredit: (kind: CreditKind) => void;
    section?: "full" | "upload" | "credits" | "defaults" | "series";
  } = $props();

  const slots: { kind: CreditKind; label: string }[] = [
    { kind: "pre", label: "Pre-credits" },
    { kind: "post", label: "Post-credits" },
  ];
  const hasKind = $derived({
    pre: images.some((img) => img.role === "pre-credits"),
    post: images.some((img) => img.role === "post-credits"),
  });
  const canAddCredits = $derived(
    Boolean(credits.pre || credits.post) &&
      ((credits.pre && !hasKind.pre) || (credits.post && !hasKind.post)),
  );

</script>

<div class="wf-ui">
  {#if section === "full"}
  <h1>Prepare the chapter</h1>
  <p>
    Import pages in reading order, organize spreads or strips, then renumber for
    export. Use the thumbnail checkboxes to delete pages together or extract a
    copy to a new chapter. Shift-click selects a range.
  </p>
  {/if}
  {#if canUpload && (section === "full" || section === "upload")}<label class="upload" data-find="upload-order"
      >Add images or paste from clipboard<input
        type="file"
        accept="image/*"
        multiple
        onchange={(e) => onaddfiles([...(e.currentTarget.files ?? [])])}
      /></label
    >
    {#if pendingFiles.length}<div class="upload-list">
        <strong>Upload order preview</strong
        >{#each pendingFiles as f, i}<div>
            {i + 1}. {f.name}<button
              onclick={() => {
                if (i > 0) {
                  const fs = [...pendingFiles];
                  [fs[i - 1], fs[i]] = [fs[i], fs[i - 1]];
                  pendingFiles = fs;
                }
              }}>↑</button
            ><button
              onclick={() => (pendingFiles = pendingFiles.filter((_, n) => n !== i))}
              >Remove</button
            >
          </div>{/each}<label
          ><input type="checkbox" bind:checked={stitch} /> Stitch these images into
          strips</label
        ><button class="primary" disabled={busy} onclick={onupload}
          >Upload in this order</button
        >
      </div>{/if}
    {#if duplicateWarning}<p class="warning">{duplicateWarning}</p>{/if}
  {/if}
    {#if section === "full"}
    <div class="control-row">
      <button onclick={() => onreorder(-1)} disabled={!hasPage}
        >Move page earlier</button
      ><button onclick={() => onreorder(1)} disabled={!hasPage}
        >Move page later</button
      ><button class="primary" onclick={onrenumber}>Renumber pages</button>
    </div>
    <p class:warning={numberingStale}>
      {numberingStale
        ? "Numbering is stale. Renumber after organizing."
        : "Numbering is current. Export names: 1, 2, 3…"}
    </p>
    {/if}
    {#if section === "full" || section === "credits"}
    <h2 data-find="tab-prepare-credits">Series credits</h2>
    <p>
      Optional pre-credits and post-credits pages are saved on the series. Add
      them to this chapter with one click. Auto-align and auto-crop ignore them
      when measuring story pages, then scale credits to that width without
      padding or cropping.
    </p>
    <div class="credits-slots">
      {#each slots as slot}
        {@const credit = credits[slot.kind]}
        <div class="credit-slot">
          <h3>{slot.label}</h3>
          {#if credit}
            <img
              src={`/api/series/${seriesId}/credits/${slot.kind}?v=${credit.hash}`}
              alt=""
            />
            <p>{credit.originalName} · {credit.width}×{credit.height}</p>
            <p>
              {hasKind[slot.kind] ? "Already in this chapter." : "Not in this chapter yet."}
            </p>
            {#if canUpload}<button
                disabled={busy}
                onclick={() => onclearcredit(slot.kind)}>Remove from series</button
              >{/if}
          {:else if canUpload}
            <label
              >Upload {slot.label.toLowerCase()}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                aria-label={`Upload ${slot.label.toLowerCase()} page`}
                disabled={busy}
                onchange={(e) => {
                  const file = e.currentTarget.files?.[0];
                  e.currentTarget.value = "";
                  if (file) onuploadcredit(slot.kind, file);
                }}
              /></label
            >
          {:else}
            <p>None saved.</p>
          {/if}
        </div>
      {/each}
    </div>
    <div class="control-row">
      <button
        class="primary"
        disabled={busy || !canUpload || !canAddCredits}
        onclick={() => onpageop({ op: "add-credits" })}
        >Add credits to this chapter</button
      >
    </div>
    {#if canUpload && section === "full"}
    <div class="control-row">
      <button disabled={busy} onclick={() => onpageop({ op: "split" })}
        >Split spreads</button
      >
      <button disabled={busy} onclick={() => onpageop({ op: "auto-crop" })}
        >Auto-crop margins</button
      >
      <button disabled={busy} onclick={() => onpageop({ op: "auto-align" })}
        >Auto-align pages</button
      >
      <ResliceSizeControl bind:sizing={resliceSizing} bind:maxHeight={resliceMaxHeight} disabled={busy || aiRunning || !canUpload} />
      <button disabled={busy || aiRunning || !canUpload || (resliceSizing === "custom" && !validSliceHeight(resliceMaxHeight))} onclick={onreslice}
        >Split strips</button
      >
      <button
        disabled={busy || !pageUndoCount}
        onclick={() => onpageop({ op: "undo" })}
        >{pageUndoLabel} ({pageUndoCount})</button
      >
    </div>
    <div class="control-row">
      <button
        class="primary"
        disabled={busy || aiRunning || !canUpload}
        onclick={ondescribe}>Generate scene notes</button
      >
      <RegionAiSettings
        settings={preferences.regionAi}
        fallback={{ engine, model } as TaskEngine}
        {engines}
        tasks={["describe"]}
        disabled={!canEdit || busy}
        onsave={onsaveregionai}
      />
    </div>
    {/if}
  {/if}
  {#if section === "full" || section === "series"}
  <div class="settings" data-find="set-series">
    <h2>Series language & reading direction</h2>
    <p>Applies to every chapter in this series, including new chapters.</p>
    <label
      >Source language<select
        value={preferences.lang}
        disabled={!canEdit || busy}
        onchange={(e) =>
          onsaveseriesprefs({
            lang: e.currentTarget.value,
            direction: e.currentTarget.value === "japanese" ? "rtl" : "ltr",
          })}
        ><option value="japanese">Japanese</option><option value="korean"
          >Korean</option
        ></select
      ></label
    ><label
      >Reading direction<select
        value={preferences.direction}
        disabled={!canEdit || busy}
        onchange={(e) => onsaveseriesprefs({ direction: e.currentTarget.value })}
        ><option value="rtl">Right to left</option><option value="ltr"
          >Left to right</option
        ></select
      ></label
    >
  </div>
  {/if}
  {#if section === "full" || section === "defaults"}
  <div class="settings" data-find="set-chapter">
    <h2>Chapter settings</h2>
    <label
      >Chapter DPI override<input
        type="number"
        placeholder="Imported density, otherwise 72"
        bind:value={chapterDpi}
      /></label
    ><button disabled={!canEdit || busy} onclick={onsavedpi}
      >Save chapter DPI</button
    >
  </div>
  {/if}
</div>

<style>
  .upload {
    padding: 24px;
    border: 1px dashed var(--hud-teal);
    background: var(--hud-teal-dim);
    max-width: 700px;
  }
  .upload input {
    margin-top: 14px;
  }
  .upload-list {
    padding: 18px;
    background: var(--panel, var(--ed-panel, var(--hud-bg-2)));
  }
  .upload-list > div {
    display: flex;
    gap: 12px;
    align-items: center;
    margin: 5px;
  }
  .credits-slots {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px;
    margin: 12px 0;
  }
  .credit-slot {
    border: 1px solid var(--hud-line);
    padding: 10px;
    background: var(--ed-panel, var(--hud-bg-2));
  }
  .credit-slot h3 {
    margin: 0 0 8px;
    font-size: 12px;
  }
  .credit-slot img {
    display: block;
    width: 100%;
    max-height: 180px;
    object-fit: contain;
    background: var(--hud-bg);
    margin-bottom: 8px;
  }
  .credit-slot p {
    margin: 0 0 8px;
    font-size: 12px;
    color: var(--ed-muted, var(--hud-muted));
  }
</style>
