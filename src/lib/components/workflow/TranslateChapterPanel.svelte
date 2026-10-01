<script lang="ts">
  import "./studio-controls.css";
  import RegionAiSettings from "../RegionAiSettings.svelte";
  import TranslationModelPicker from '../TranslationModelPicker.svelte';
  import GlossaryEditor from "../GlossaryEditor.svelte";
  import type { RegionAiSettings as RegionAiSettingsData } from "$lib/regionAi";
  import type { TaskEngine } from "$lib/aiTasks";
  import type { GlossaryTerm, TranslateEngineInfo } from "$lib/types";
  import { providerRunGate } from "$lib/providerCatalog";
  import { textEngines } from "$lib/types";
  import type { Preferences } from "$lib/workflow";
  import {
    allDetectorSetups,
    detectorSetupId,
    detectorSetupLabel,
    parseDetectorSetup,
    type DetectorDefaults,
    type DetectorSetupConfig,
  } from "$lib/detectorSetup";

  type GlossaryMineCard = {
    source: string;
    translation: string;
    kind: string;
    reason: string;
    state: "pending" | "accepted" | "rejected";
  };

  let {
    step,
    canEdit,
    canUpload,
    busy,
    aiRunning,
    blankRegionCount,
    hasLines,
    reviewPendingCount = 0,
    aliases = $bindable(""),
    translationPrefs = $bindable(""),
    preferences,
    detectorDefaults,
    detection,
    engine,
    model,
    engines,
    translationModel,
    visionLabel,
    translateLabel,
    transcriptionLabel = "",
    transcribeEstimate = "",
    seriesTerms,
    glossaryMine = null,
    glossaryModel,
    onsavetranslationmodel,
    onsaveregionai,
    onprefs,
    onrunai,
    onreview,
    onremoveblanks,
    onstop,
    onrereadmissing,
    onfillmissing,
    onseriesglossary,
    onextractglossary,
    onglossarymodel,
    onglossarydecide,
    onsavedefaults,
    onloaddefaults,
    section = "full",
    embeddedModels = false,
    modelsTab = "",
    onclosemodels,
  }: {
    step: string;
    canEdit: boolean;
    canUpload: boolean;
    busy: boolean;
    aiRunning: boolean;
    blankRegionCount: number;
    hasLines: boolean;
    reviewPendingCount?: number;
    aliases?: string;
    translationPrefs?: string;
    preferences: Preferences;
    detectorDefaults?: DetectorDefaults;
    detection?: { setup: DetectorSetupConfig; conf: number; source: string; skipped: string[] };
    engine: string;
    model: string;
    engines: TranslateEngineInfo[];
    translationModel: TaskEngine | null;
    visionLabel: string;
    translateLabel: string;
    transcriptionLabel?: string;
    transcribeEstimate?: string;
    seriesTerms: GlossaryTerm[];
    glossaryMine?: {
      jobId: string;
      state: string;
      message?: string;
      terms: GlossaryMineCard[];
    } | null;
    glossaryModel: TaskEngine | null;
    onsavetranslationmodel: (next: TaskEngine) => void;
    onsaveregionai: (regionAi: RegionAiSettingsData) => Promise<boolean>;
    onprefs: (data: Record<string, unknown>) => void;
    onrunai: (kind: string) => void;
    onreview: () => void;
    onremoveblanks: () => void;
    onstop: () => void;
    onrereadmissing: () => void;
    onfillmissing: () => void;
    onseriesglossary: (terms: GlossaryTerm[]) => void;
    onextractglossary: () => void;
    onglossarymodel: (next: TaskEngine) => void;
    onglossarydecide: (source: string, decision: "accept" | "reject") => void;
    onsavedefaults: () => void;
    onloaddefaults: () => void;
    section?: "full" | "models" | "detection" | "guide" | "glossary";
    embeddedModels?: boolean;
    modelsTab?: string;
    onclosemodels?: () => void;
  } = $props();
  const pendingMine = $derived((glossaryMine?.terms ?? []).filter((t) => t.state === "pending"));
  const translateGate = $derived(providerRunGate(translationModel?.engine, "translate", engines));
  const proofreadGate = $derived(providerRunGate(preferences.regionAi?.proofread?.engine, "proofreadEnglish", engines));
  const glossaryGate = $derived(providerRunGate(glossaryModel?.engine, "advisory", engines));
  const defaultSetup = $derived(parseDetectorSetup(detectorDefaults?.setup));
  /** A chapter saved before setups shows the setup its old detector still runs. */
  const chosenSetup = $derived(
    preferences.detectorSetup ?? (detection?.source === "chapter" ? detectorSetupId(detection.setup) : ""),
  );
  function setupMissing(setup: DetectorSetupConfig): string {
    const available = detectorDefaults?.available;
    if (!available) return "";
    const missing = [
      !available[setup.base].installed && setup.base,
      setup.coo && !available.coo.installed && "COO",
      setup.koharu && !available.koharu.installed && "Koharu",
    ].filter(Boolean);
    return missing.length ? ` (needs ${missing.join(", ")})` : "";
  }
</script>

<div class="wf-ui">
  {#if section === "full"}
  <h1>{step === "Review" ? "Review translations" : "Translate the chapter"}</h1>
  {/if}
  {#if section === "full"}
  <div data-find="translate-model">
  <TranslationModelPicker
    value={translationModel}
    {engines}
    disabled={!canEdit || busy || !translationModel}
    onchange={onsavetranslationmodel}
  />
  <p>
    Transcription: {transcriptionLabel || "Hayai OCR v2 + PaddleOCR-VL-1.6"}.
    Translation: {translateLabel}. Manual Read area: {visionLabel}.
    Change other task models in Series → AI model settings.
    {#if transcribeEstimate}Est. 8-region page {transcribeEstimate} (selected set in parallel · detection/masking not included).{/if}
    {#if engines.some((en) => en.label?.includes("GPU"))}
      Managed local models use their configured devices.
    {/if}
  </p>
  </div>
  {/if}
  {#if section === "full" || section === "models"}
  <div data-find="translate-model">
  {#if section === "models"}
  <TranslationModelPicker
    value={translationModel}
    {engines}
    disabled={!canEdit || busy || !translationModel}
    onchange={onsavetranslationmodel}
  />
  {#if !translateGate.ok}<p role="status">{translateGate.reason}</p>{/if}
  {/if}
  <RegionAiSettings
    settings={preferences.regionAi}
    fallback={{ engine, model } as TaskEngine}
    {engines}
    disabled={!canEdit || busy}
    embedded={embeddedModels}
    initialTab={modelsTab}
    onclose={onclosemodels}
    onsave={onsaveregionai}
  />
  </div>
  {/if}
  {#if section === "full" || section === "detection"}
  <div data-find="set-detection">
  <div class="control-row">
    <label
      >Text detector<select
        value={chosenSetup}
        disabled={!canEdit}
        onchange={(e) => onprefs({ detectorSetup: e.currentTarget.value })}
        ><option value="">Default · {defaultSetup ? detectorSetupLabel(defaultSetup) : "set in Admin"}</option>
        {#each allDetectorSetups() as setup (detectorSetupId(setup))}
          {@const missing = setupMissing(setup)}
          <option value={detectorSetupId(setup)} disabled={Boolean(missing) && detectorSetupId(setup) !== chosenSetup}
            >{detectorSetupLabel(setup)}{missing}</option>
        {/each}</select
      ></label
    ><label
      >Detection confidence<input
        type="number"
        min="0.05"
        max="0.9"
        step="0.05"
        placeholder={String(detectorDefaults?.conf ?? 0.2)}
        value={preferences.detectConf ?? ""}
        disabled={!canEdit}
        onchange={(e) => onprefs({ detectConf: e.currentTarget.value === "" ? null : Number(e.currentTarget.value) })}
      /></label
    >
  </div>
  {#if detection?.skipped.length}
    <p class="muted small">Transcribe will run {detectorSetupLabel(detection.setup)}: {detection.skipped.join("; ")}.</p>
  {/if}
  <p>Transcribe runs the selected vision models on every region. A strict plurality of comparable readings fills the source.</p>
  <label
    title="Leave off to skip logos and other lettering that is already English."
    ><input
      type="checkbox"
      checked={preferences.transcribeEnglish === true}
      disabled={!canEdit}
      onchange={(e) => onprefs({ transcribeEnglish: e.currentTarget.checked })}
    /> Transcribe English text</label
  >
  </div>
  {/if}
  {#if section === "full"}
  <div class="control-row">
    <button
      class="primary"
      disabled={busy || aiRunning || !canUpload}
      onclick={() => onrunai("transcribe")}>Transcribe chapter</button
    >
    <button
      disabled={busy || aiRunning || !canUpload || !translateGate.ok}
      title={translateGate.reason || undefined}
      onclick={() => onrunai("translate")}>Translate chapter</button
    >
    <button
      disabled={busy || aiRunning || !canEdit}
      title="Transcribe empty sources and fill empty English on regions and suggestions. Existing text is left alone."
      onclick={onfillmissing}>Fill missing source &amp; English</button
    >
    <button disabled={!hasLines} onclick={onreview}>Review translations</button>
    <button
      disabled={!canEdit || busy || aiRunning || !blankRegionCount}
      title="Remove empty regions without pending source suggestions from every page in this chapter"
      onclick={onremoveblanks}
      >Remove all blank regions ({blankRegionCount})</button
    >
    {#if aiRunning}<button onclick={onstop}>Stop AI</button>{/if}
  </div>
  {#if !translateGate.ok}<p role="status">{translateGate.reason}</p>{/if}
  {#if !proofreadGate.ok}<p role="status">{proofreadGate.reason}</p>{/if}
  <p>
    Transcribe runs the selected vision models on every region. A strict
    plurality of comparable readings fills the source. One selected model is
    enough. Ties or failed readings leave source and English empty, with each
    reading saved as a suggestion that already includes English from the
    selected Translation model. Check the source, then Translate. Proofreading is a
    separate optional step.
    {#if transcribeEstimate} Estimated 8-region page {transcribeEstimate} when every selected model has Test samples.{/if}
  </p>
  <p>
    Region detection uses the text detector above, not the translation LLM:
    a box detector, optionally with COO for sound effects and Koharu for
    lettering the boxes missed. Leave it on Default to follow Admin → Models →
    Jobs &amp; defaults. Raise confidence if flames, empty space, or other art
    are boxed as text — manhwa often wants 0.35–0.45. An empty confidence uses
    the default. Overlapping boxes that repeat the same
    lettering collapse to one region. English lettering is skipped unless
    Transcribe English text is on. Chapter transcribe skips pages that already
    have regions; delete junk boxes and use Transcribe page to re-detect.
  </p>
  <p>
    Translate fills empty English and offers alternatives where English already
    exists. <strong>Fill missing source &amp; English</strong> only transcribes
    regions with no source and only writes English where it is still empty,
    including pending source suggestions that have no translation.
  </p>
  <details>
    <summary>Optional translation tools</summary>
    <p>Use these to fix a specific problem after transcribing or translating.</p>
    <div class="control-row">
      <button
        disabled={busy || aiRunning || !canUpload || !proofreadGate.ok}
        title={proofreadGate.reason || undefined}
        onclick={() => onrunai("proofread")}>Proofread edited English</button
      >
      <button
        disabled={busy || aiRunning || !canEdit}
        onclick={onrereadmissing}>Retry uncertain image reading</button
      >
    </div>
  </details>
  {/if}
  {#if (section === "full" && step === "Review") || section === "glossary"}
    <div data-find="extract-terms">
    <div class="settings">
      <h2>Series glossary</h2>
      <p>
        After this chapter is reviewed, extract names, places, and catchphrases
        for later chapters. Accepted terms join the series list.
      </p>
      <div class="control-row">
        <label
          >Extract engine<select
            value={glossaryModel?.engine ?? ""}
            disabled={!canEdit || busy}
            onchange={(e) =>
              onglossarymodel({
                engine: e.currentTarget.value as TaskEngine["engine"],
                model: "",
              })}
            >{#if !glossaryModel}<option value="" disabled>AI model settings</option>{/if}
            {#each textEngines(engines) as en}<option value={en.id} disabled={!en.available}
                >{en.label}</option
              >{/each}</select
          ></label
        ><label
          >Model override<input
            value={glossaryModel?.model ?? ""}
            disabled={!canEdit || busy || !glossaryModel}
            onchange={(e) => {
              if (glossaryModel)
                onglossarymodel({
                  ...glossaryModel,
                  model: e.currentTarget.value.trim(),
                });
            }}
            placeholder={glossaryModel ? "Engine default" : "Set in AI model settings"}
          /></label
        >
      </div>
      <div class="control-row">
        <button
          class="primary"
          disabled={!canEdit || busy || aiRunning || !hasLines || reviewPendingCount > 0 || !glossaryGate.ok}
          title={glossaryGate.reason || (reviewPendingCount
            ? `${reviewPendingCount} region${reviewPendingCount === 1 ? "" : "s"} still need source, English, or approval`
            : "Send the reviewed bilingual script to the selected model")}
          onclick={onextractglossary}>Extract series terms</button
        >
      </div>
      {#if reviewPendingCount}
        <p>{reviewPendingCount} region{reviewPendingCount === 1 ? "" : "s"} still need review before extraction.</p>
      {/if}
      {#if glossaryMine}
        <p>{glossaryMine.message || (glossaryMine.state === "running" ? "Extracting series terms…" : "")}</p>
        {#each pendingMine as term}
          <div class="mine-card">
            <strong>{term.source} → {term.translation}</strong>
            <span>{term.kind}{term.reason ? ` · ${term.reason}` : ""}</span>
            <div class="control-row">
              <button disabled={!canEdit || busy} onclick={() => onglossarydecide(term.source, "accept")}>Accept</button>
              <button disabled={!canEdit || busy} onclick={() => onglossarydecide(term.source, "reject")}>Reject</button>
            </div>
          </div>
        {/each}
      {/if}
    </div>
    </div>
  {/if}
  {#if section === "full" || section === "guide"}
  <div data-find="set-guide">
  <details>
    <summary>Series terminology</summary>
    <GlossaryEditor
      terms={seriesTerms}
      disabled={!canEdit}
      onchange={onseriesglossary}
    />
  </details>
  <div class="settings">
    <h2>Translation defaults</h2>
    <label
      >Character aliases<textarea
        bind:value={aliases}
        rows="3"
        placeholder="Source name → preferred English name"
      ></textarea></label
    ><label
      >Translation preferences<textarea
        bind:value={translationPrefs}
        rows="3"
        placeholder="Voice, register, honorifics, terminology…"
      ></textarea></label
    ><button disabled={!canEdit || busy} onclick={onsavedefaults}
      >Save translation defaults</button
    ><button onclick={onloaddefaults}>Load saved defaults</button>
  </div>
  </div>
  {/if}
</div>

<style>
  .mine-card {
    display: grid;
    gap: 0.35rem;
    margin: 0.75rem 0;
    padding: 0.65rem 0.75rem;
    border: 1px solid var(--wf-line);
  }
  .mine-card span {
    opacity: 0.8;
    font-size: 0.9em;
  }
</style>
