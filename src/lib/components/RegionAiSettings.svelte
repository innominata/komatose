<script lang="ts">
  import { untrack } from "svelte";
  import AiModelPicker from "./AiModelPicker.svelte";
  import TranslationModelPicker from './TranslationModelPicker.svelte';
  import { assistantDisplayName } from "$lib/modelRegistry";
  import { regionAiSettings, defaultReviseModels, enginesForRegionAiField, MAX_REVISE_MODELS, MAX_TRANSCRIPTION_MODELS, type RegionAiSettings } from "$lib/regionAi";
  import type { TaskEngine, EngineModelOption } from "$lib/aiTasks";
  import { isPageImageOnlyEngine, type TranslateEngine, type TranslateEngineInfo } from "$lib/types";
  import { isProofreaderId, proofreaderLabel } from "$lib/proofreaders";
  import { MAX_SOURCE_REVIEWERS } from "$lib/localReviewModels";
  import { formatDuration, transcribeSetPageMs } from "$lib/modelEstimate";
  import {
    mergeProfileIntoSettings,
    snapshotProfileSelections,
    type ModelProfile,
    type ProfileIssue,
  } from "$lib/modelProfiles";
  let {
    settings,
    fallback,
    engines,
    disabled,
    tasks,
    showTrigger = true,
    embedded = false,
    initialTab = "",
    onsave,
    onclose,
  }: {
    settings?: RegionAiSettings;
    fallback: TaskEngine;
    engines: TranslateEngineInfo[];
    disabled: boolean;
    tasks?: Array<keyof RegionAiSettings>;
    showTrigger?: boolean;
    embedded?: boolean;
    initialTab?: string;
    onsave: (settings: RegionAiSettings) => Promise<boolean>;
    onclose?: () => void;
  } = $props();
  let dialog: HTMLDialogElement | HTMLDivElement;
  let draft = $state(regionAiSettings());
  let saving = $state(false);
  let error = $state("");
  let models = $state<Partial<Record<TranslateEngine, EngineModelOption[]>>>(
    {},
  );
  let describeModels = $state<Partial<Record<TranslateEngine, EngineModelOption[]>>>({});
  let reviewModels = $state<Partial<Record<TranslateEngine, EngineModelOption[]>>>({});
  let reviewEngines = $state<TranslateEngineInfo[]>([]);
  let liveEngines = $state<TranslateEngineInfo[]>([]);
  let enginesEpoch = 0;
  let localReviewModels = $state<EngineModelOption[]>([]);
  let transcriptionOptions = $state<Array<TranslateEngineInfo & { access?: string }>>([]);
  let proofreaderStatus = $state("");
  let proofreaderBusy = $state(false);
  let profiles = $state<ModelProfile[]>([]);
  let selectedProfileId = $state("");
  let profileName = $state("");
  let profileIssues = $state<ProfileIssue[]>([]);
  let profileBusy = $state(false);
  let chosenTab = $state("");
  let openHint = $state("");
  const enginesSnapshot = $derived(liveEngines.length ? liveEngines : engines);
  const showProfiles = $derived(
    !tasks?.length ||
      tasks.some((key) =>
        ["translate", "proofread", "reviewers", "transcriptionModels"].includes(key),
      ),
  );
  function fieldEngines(field: "describe" | "vision" | "proofread" | "enquire" | "reviewers", savedId?: string) {
    const live = field === "reviewers" && reviewEngines.length ? reviewEngines : enginesSnapshot;
    return enginesForRegionAiField(field, live, savedId, enginesSnapshot);
  }
  function applyEngineInfo(info: {
    engines?: TranslateEngineInfo[];
    models?: Partial<Record<TranslateEngine, EngineModelOption[]>>;
    describeModels?: Partial<Record<TranslateEngine, EngineModelOption[]>>;
    sourceReviewModels?: Partial<Record<TranslateEngine, EngineModelOption[]>>;
    sourceReviewEngines?: TranslateEngineInfo[];
    localReviewModels?: EngineModelOption[];
    transcriptionModels?: Array<TranslateEngineInfo & { access?: string }>;
  }, epoch: number) {
    if (epoch !== enginesEpoch) return;
    if (Array.isArray(info.engines)) {
      liveEngines = info.engines;
      const ops = new Map(info.engines.map((engine) => [engine.id, new Set(engine.operations || [])]));
      const keeps = (id: string, operation: string) => ops.get(id)?.has(operation) === true;
    }
    if (info.models) models = info.models;
    if (info.describeModels) describeModels = info.describeModels;
    else if (info.models) describeModels = info.models;
    if (info.sourceReviewModels) reviewModels = info.sourceReviewModels;
    else if (info.models) reviewModels = info.models;
    if (info.sourceReviewEngines) reviewEngines = info.sourceReviewEngines;
    if (info.localReviewModels) localReviewModels = info.localReviewModels;
    if (Array.isArray(info.transcriptionModels)) {
      transcriptionOptions = info.transcriptionModels;
      const allowed = new Set(info.transcriptionModels.map((row) => row.id));
    }
  }
  async function refreshLiveEngines() {
    const epoch = ++enginesEpoch;
    const r = await fetch("/api/ai/engines");
    if (!r.ok) return;
    applyEngineInfo(await r.json(), epoch);
  }
  $effect(() => {
    if (!embedded) return;
    const next = JSON.parse(JSON.stringify(regionAiSettings(settings, fallback)));
    const tab = initialTab;
    untrack(() => {
      draft = next;
      if (tab) chosenTab = tab;
      void refreshLiveEngines().catch(() => {});
      void refreshProofreader();
      void refreshProfiles();
    });
  });
  export async function open(tab = "") {
    draft = JSON.parse(JSON.stringify(regionAiSettings(settings, fallback)));
    error = "";
    proofreaderStatus = "";
    chosenTab = tab;
    openHint = "";
    liveEngines = engines;
    selectedProfileId = "";
    profileName = "";
    profileIssues = [];
    if (!embedded && "showModal" in dialog) dialog.showModal();
    try {
      await refreshLiveEngines();
    } catch {
      /* Custom IDs remain available. */
    }
    await refreshProofreader();
    await refreshProfiles();
  }
  async function profileApi(body?: Record<string, unknown>) {
    const r = await fetch("/api/model-profiles", {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(json.error || "Could not update model profiles.");
    return json as { profiles?: ModelProfile[]; profile?: ModelProfile; issues?: ProfileIssue[] };
  }
  async function refreshProfiles() {
    if (!showProfiles) return;
    try {
      const json = await profileApi();
      profiles = json.profiles || [];
    } catch {
      profiles = [];
    }
  }
  async function previewSelectedProfile() {
    profileIssues = [];
    if (!selectedProfileId) return;
    const selected = profiles.find((item) => item.id === selectedProfileId);
    if (selected) profileName = selected.name;
    try {
      const json = await profileApi({ action: "validate", id: selectedProfileId });
      if (json.profiles) profiles = json.profiles;
      profileIssues = json.issues || [];
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
  }
  async function saveProfile() {
    profileBusy = true;
    error = "";
    try {
      const json = await profileApi({
        action: "save",
        name: profileName,
        selections: snapshotProfileSelections($state.snapshot(draft)),
      });
      profiles = json.profiles || [];
      if (json.profile) {
        selectedProfileId = json.profile.id;
        profileName = json.profile.name;
      }
      await previewSelectedProfile();
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      profileBusy = false;
    }
  }
  async function applyProfile() {
    if (!selectedProfileId) return;
    profileBusy = true;
    error = "";
    try {
      const json = await profileApi({ action: "validate", id: selectedProfileId });
      if (json.profiles) profiles = json.profiles;
      profileIssues = json.issues || [];
      if (profileIssues.length || !json.profile) return;
      const next = mergeProfileIntoSettings($state.snapshot(draft), json.profile.selections);
      if (await onsave(next)) draft = JSON.parse(JSON.stringify(next));
      else error = "Could not save. Resolve the editor error and try again.";
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      profileBusy = false;
    }
  }
  async function deleteProfile() {
    if (!selectedProfileId) return;
    profileBusy = true;
    error = "";
    try {
      const json = await profileApi({ action: "delete", id: selectedProfileId });
      profiles = json.profiles || [];
      selectedProfileId = "";
      profileIssues = [];
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      profileBusy = false;
    }
  }
  async function refreshProofreader() {
    const engine = draft.proofread.engine;
    if (!isProofreaderId(engine)) {
      proofreaderStatus = "";
      return;
    }
    try {
      const r = await fetch(`/api/ai/proofreaders?engine=${encodeURIComponent(engine)}`);
      if (!r.ok) return;
      const info = await r.json();
      proofreaderStatus = info.reason || "";
    } catch {
      proofreaderStatus = "";
    }
  }
  async function startProofreader() {
    const engine = isProofreaderId(draft.proofread.engine) ? draft.proofread.engine : "proofreader-a";
    proofreaderBusy = true;
    error = "";
    try {
      const r = await fetch("/api/ai/proofreaders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "launch", engine }),
      });
      const info = await r.json();
      if (!r.ok) error = info.error || "Could not start the proofreading service";
      proofreaderStatus = info.reason || error;
      try {
        await refreshLiveEngines();
      } catch {
        /* Keep the previous live snapshot. */
      }
    } catch (e) {
      error = String(e);
    } finally {
      proofreaderBusy = false;
    }
  }
  async function save() {
    saving = true;
    error = "";
    try {
      if (await onsave($state.snapshot(draft))) {
        if (embedded) onclose?.();
        else if ("close" in dialog) dialog.close();
      } else error = "Could not save. Resolve the editor error and try again.";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }
  const show = (key: keyof RegionAiSettings) => !tasks?.length || tasks.includes(key);
  const tabs = $derived.by(() => {
    const items: { id: string; label: string }[] = [];
    if (showProfiles) items.push({ id: "profiles", label: "Profiles" });
    if (show("translate")) items.push({ id: "translate", label: "Translation" });
    if (show("describe")) items.push({ id: "describe", label: "Description" });
    if (show("vision")) items.push({ id: "vision", label: "Read Text / OCR" });
    if (show("proofread")) items.push({ id: "proofread", label: "Proofreading" });
    if (show("enquire")) items.push({ id: "enquire", label: "Enquire" });
    if (show("reviewers")) items.push({ id: "reviewers", label: "Review Transcription" });
    if (show("reviseModels")) items.push({ id: "revise", label: "Review Translation" });
    if (show("transcriptionModels")) items.push({ id: "transcription", label: "Transcription" });
    return items;
  });
  const activeTab = $derived(tabs.find((tab) => tab.id === chosenTab)?.id ?? tabs[0]?.id ?? "");
  function addLocalReviewers() {
    const added = localReviewModels.filter(model => !draft.reviewers.some(
      reviewer => reviewer.engine === model.id || reviewer.model === model.id));
    draft.reviewers = [...draft.reviewers, ...added.map(model => ({ engine: model.id, model: '' }))]
      .slice(0, MAX_SOURCE_REVIEWERS);
  }
  function hasLocalReviewer(model: EngineModelOption) {
    return draft.reviewers.some(reviewer => reviewer.engine === model.id || reviewer.model === model.id);
  }
  function translateChoices(savedId?: string) {
    return enginesForRegionAiField("translate", enginesSnapshot, savedId);
  }
  function customizeReviseCouncil() {
    draft.reviseModels = defaultReviseModels(draft.translate, draft.proofread).map((model) => ({ ...model }));
  }
  function addReviseModel() {
    let list = draft.reviseModels.map((model) => ({ ...model }));
    if (!list.length) list = defaultReviseModels(draft.translate, draft.proofread).map((model) => ({ ...model }));
    if (list.length >= MAX_REVISE_MODELS) {
      draft.reviseModels = list;
      return;
    }
    const options = translateChoices();
    const unused = (engine: { id: string }) => !list.some((item) => item.engine === engine.id && !item.model);
    const pick = options.find((engine) => engine.available && unused(engine))
      ?? options.find((engine) => unused(engine));
    if (!pick) {
      draft.reviseModels = list;
      return;
    }
    draft.reviseModels = [...list, { engine: pick.id, model: "" }];
  }
  function toggleTranscription(id: string, on: boolean) {
    const next = on
      ? [...draft.transcriptionModels, id]
      : draft.transcriptionModels.filter((item) => item !== id);
    const unique = [...new Set(next)].slice(0, MAX_TRANSCRIPTION_MODELS);
    draft.transcriptionModels = unique.length ? unique : draft.transcriptionModels;
  }
  const transcriptionPaid = $derived(
    transcriptionOptions.some((row) => draft.transcriptionModels.includes(row.id) && (row.access === 'cli' || row.access === 'remote_http')),
  );
  const transcribeEstimate = $derived.by(() => {
    const medians = draft.transcriptionModels.map((id) => {
      const row = transcriptionOptions.find((item) => item.id === id);
      return row?.estimates?.vision?.medianMs ?? row?.estimates?.vision?.ms;
    });
    if (!draft.transcriptionModels.length || medians.some((ms) => ms == null)) return '';
    return formatDuration(transcribeSetPageMs(medians as number[], 8));
  });
  const transcriptionHint = $derived(
    `Chapter transcribe runs this set automatically, in parallel per region (cap ${MAX_TRANSCRIPTION_MODELS}). A strict plurality of comparable source readings is applied; one model is enough.` +
      (transcriptionPaid ? " The set includes CLI or remote models — those calls are billed." : "") +
      (transcribeEstimate ? ` Est. 8-region page ${transcribeEstimate}.` : ""),
  );
</script>

{#if showTrigger && !embedded}
<button {disabled} onclick={() => open()}>{tasks?.length === 1 && tasks[0] === "describe" ? "Description model…" : "AI model settings…"}</button>
{/if}
<svelte:element
  this={embedded ? "div" : "dialog"}
  class="hud-dialog-controls settings-modal"
  class:studio-embedded-settings={embedded}
  bind:this={dialog}
  aria-label="AI model settings"
  role={embedded ? "dialog" : undefined}
>
  <header class="settings-bar">
    <div class="title-row">
      <h2>AI model settings</h2>
      <span class="scope-label">Series</span>
      {@render help(
        "series",
        "About these settings",
        "Saved on this series. Every chapter uses these models, including the Review Translation council.",
      )}
    </div>
    {@render actions()}
  </header>
  {#if error}<p class="banner" role="alert">{error}</p>{/if}
  <div class="tabs" role="tablist" aria-label="Model setting sections">
    {#each tabs as tab}
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === tab.id}
        aria-controls={`settings-panel-${tab.id}`}
        id={`settings-tab-${tab.id}`}
        onclick={() => {
          chosenTab = tab.id;
          openHint = "";
        }}
      >{tab.label}</button>
    {/each}
  </div>
  <div class="panel" role="tabpanel" id={`settings-panel-${activeTab}`} aria-labelledby={`settings-tab-${activeTab}`}>
    {#if activeTab === "profiles"}
      <div class="panel-body">
        <div class="section-head">
          <h3>Model profiles</h3>
          {@render help(
            "profiles",
            "About model profiles",
            "Save translation, proofreading, reviewers, and transcription as a named set, such as “Local only” or “CLI agents.” Series settings stay as they are until you apply a profile.",
          )}
        </div>
        <div class="profile-grid">
          <label class="stack">Saved profile
            <select
              aria-label="Saved model profile"
              bind:value={selectedProfileId}
              disabled={disabled || saving || profileBusy}
              onchange={() => void previewSelectedProfile()}
            >
              <option value="">Choose a profile…</option>
              {#each profiles as profile}
                <option value={profile.id}>{profile.name}</option>
              {/each}
            </select>
          </label>
          <label class="stack">Profile name
            <input
              aria-label="Profile name"
              bind:value={profileName}
              disabled={disabled || saving || profileBusy}
              placeholder="Local only"
            />
          </label>
        </div>
        <div class="profile-actions">
          <button type="button" disabled={disabled || saving || profileBusy} onclick={() => void saveProfile()}>Save as profile</button>
          <button type="button" disabled={disabled || saving || profileBusy || !selectedProfileId || profileIssues.length > 0} onclick={() => void applyProfile()}>Apply profile</button>
          <button type="button" disabled={disabled || saving || profileBusy || !selectedProfileId} onclick={() => void deleteProfile()}>Delete profile</button>
        </div>
        {#if profileIssues.length}
          <ul class="profile-issues" role="alert">
            {#each profileIssues as issue}
              <li>{issue.message}</li>
            {/each}
          </ul>
        {/if}
      </div>
    {:else if activeTab === "translate"}
      <div class="panel-body">
        <div class="section-head">
          <h3>Translation</h3>
          {@render help(
            "translate",
            "About translation",
            "Chapter translation uses this model. Review Translation uses the council on the Review Translation tab. Until that council is saved, it is this model plus the Proofreading model when that is a different text translator.",
          )}
        </div>
        <TranslationModelPicker
          value={draft.translate}
          onchange={(value) => { draft.translate = value; }}
          engines={enginesSnapshot}
          lockEngineList
          onenginesrefresh={refreshLiveEngines}
          modelLabel="Translation model"
          disabled={saving}
        />
      </div>
    {:else if activeTab === "describe"}
      <div class="panel-body">
        <div class="section-head"><h3>Page description</h3></div>
        <AiModelPicker
          label="Page description"
          bind:value={draft.describe}
          engines={fieldEngines("describe", draft.describe.engine)}
          models={describeModels}
          labeledModels
          disabled={saving}
        />
      </div>
    {:else if activeTab === "vision"}
      <div class="panel-body">
        <div class="section-head"><h3>Read Text / OCR</h3></div>
        <AiModelPicker
          label="Read Text / OCR"
          bind:value={draft.vision}
          engines={fieldEngines("vision", draft.vision.engine)}
          {models}
          disabled={saving}
        />
      </div>
    {:else if activeTab === "proofread"}
      <div class="panel-body">
        <div class="section-head">
          <h3>Proofreading</h3>
          {#if isProofreaderId(draft.proofread.engine)}
            {@render help(
              "proofread",
              "About page proofreading",
              `Uses the ${proofreaderLabel(draft.proofread.engine)} conversation held by the proofreading service, so later pages keep context.`,
            )}
          {/if}
        </div>
        <AiModelPicker
          label="Proofreading (English / page images)"
          bind:value={draft.proofread}
          engines={fieldEngines("proofread", draft.proofread.engine)}
          {models}
          disabled={saving}
          showModel={!isPageImageOnlyEngine(draft.proofread.engine)}
        />
        {#if isProofreaderId(draft.proofread.engine)}
          <div class="inline-actions">
            <button type="button" disabled={saving || proofreaderBusy} onclick={() => void startProofreader()}
              >{proofreaderBusy ? "Starting…" : "Start proofreader"}</button>
            {#if proofreaderStatus}<p class="status">{proofreaderStatus}</p>{/if}
          </div>
        {/if}
      </div>
    {:else if activeTab === "enquire"}
      <div class="panel-body">
        <div class="section-head"><h3>Enquire</h3></div>
        <AiModelPicker
          label="Enquire default"
          bind:value={draft.enquire}
          engines={fieldEngines("enquire", draft.enquire.engine)}
          {models}
          disabled={saving}
        />
      </div>
    {:else if activeTab === "reviewers"}
      <div class="panel-body">
        <div class="section-head">
          <h3>Review Transcription</h3>
          {@render help(
            "reviewers",
            "About transcription reviewers",
            "Review Transcription sends the region image to each reviewer. You can mask that crop with the Clean-step text detector and tidy it with brush/erase before sending. Add up to five distinct models. Each returns an independent transcription. The selected Translation model supplies English separately. Send runs local models only. Grok, Codex, and Cursor each need their own Run button so you can skip them when Hayai or another local reading is already right. Every reviewer’s transcription is kept intact. Local reviews run one at a time.",
          )}
        </div>
        <div class="reviewer-list">
          {#each draft.reviewers as reviewer, i}
            <div class="reviewer">
              <AiModelPicker
                label={`Reviewer ${i + 1}`}
                bind:value={draft.reviewers[i]}
                engines={fieldEngines("reviewers", reviewer.engine)}
                models={reviewModels}
                disabled={saving}
              />
              <button
                type="button"
                disabled={saving}
                aria-label={`Remove reviewer ${i + 1}`}
                onclick={() => (draft.reviewers = draft.reviewers.filter((_, n) => n !== i))}
              >Remove</button>
            </div>
          {/each}
        </div>
        <div class="inline-actions">
          <button
            type="button"
            disabled={saving || draft.reviewers.length >= MAX_SOURCE_REVIEWERS}
            onclick={() => (draft.reviewers = [...draft.reviewers, { ...fallback }])}
          >Add reviewer</button>
          {#if localReviewModels.length}
            <button
              type="button"
              disabled={saving || draft.reviewers.length >= MAX_SOURCE_REVIEWERS || localReviewModels.every(hasLocalReviewer)}
              onclick={addLocalReviewers}
            >Add local OCR reviewers</button>
          {/if}
        </div>
      </div>
    {:else if activeTab === "revise"}
      <div class="panel-body">
        <div class="section-head">
          <h3>Review Translation council</h3>
          {@render help(
            "revise",
            "About the Review Translation council",
            "Review Translation sends the source, the current English, nearby lines, scene notes, and matching glossary terms. It does not send the page image. Add up to five text translators. Send runs local models only. Grok, Codex, and Cursor each need their own Run button. Hy-MT samples several wordings; other models translate once. Leave this list empty to use the Translation model plus the Proofreading model when that is a different text translator. Proofreaders stay on page-image proofreading.",
          )}
        </div>
        {#if draft.reviseModels.length}
          <div class="reviewer-list">
            {#each draft.reviseModels as model, i}
              <div class="reviewer">
                <AiModelPicker
                  label={`Translator ${i + 1}`}
                  bind:value={draft.reviseModels[i]}
                  engines={translateChoices(model.engine)}
                  {models}
                  disabled={saving}
                />
                <button
                  type="button"
                  disabled={saving}
                  aria-label={`Remove translator ${i + 1}`}
                  onclick={() => (draft.reviseModels = draft.reviseModels.filter((_, n) => n !== i))}
                >Remove</button>
              </div>
            {/each}
          </div>
          <div class="inline-actions">
            <button
              type="button"
              disabled={saving || draft.reviseModels.length >= MAX_REVISE_MODELS}
              onclick={addReviseModel}
            >Add translator</button>
            <button type="button" disabled={saving} onclick={() => (draft.reviseModels = [])}
              >Use translation and proofreading</button>
          </div>
        {:else}
          <p class="status">Until you save a council for this series, Review Translation uses:</p>
          <ul class="council-preview">
            {#each defaultReviseModels(draft.translate, draft.proofread) as model (model.engine + model.model)}
              <li>{enginesSnapshot.find((engine) => engine.id === model.engine)?.label || assistantDisplayName(model.engine, model.model)}</li>
            {/each}
          </ul>
          <div class="inline-actions">
            <button type="button" disabled={saving} onclick={customizeReviseCouncil}>Customize council</button>
            <button
              type="button"
              disabled={saving || defaultReviseModels(draft.translate, draft.proofread).length >= MAX_REVISE_MODELS}
              onclick={addReviseModel}
            >Add translator</button>
          </div>
        {/if}
      </div>
    {:else if activeTab === "transcription"}
      <div class="panel-body wide">
        <div class="section-head">
          <h3>Transcription models</h3>
          {@render help("transcription", "About transcription models", transcriptionHint)}
        </div>
        <div class="checks">
          {#each transcriptionOptions as row}
            <label class="check">
              <input
                type="checkbox"
                checked={draft.transcriptionModels.includes(row.id)}
                disabled={saving || (!draft.transcriptionModels.includes(row.id) && draft.transcriptionModels.length >= MAX_TRANSCRIPTION_MODELS)}
                onchange={(e) => toggleTranscription(row.id, e.currentTarget.checked)}
              />
              <span>{row.label}{row.access === "cli" || row.access === "remote_http" ? " (billed)" : ""}{row.available === false ? " (unavailable)" : ""}</span>
            </label>
          {:else}
            <p class="status">No model has passed its vision test yet. Run it under Admin → Models → Jobs.</p>
          {/each}
        </div>
      </div>
    {/if}
  </div>
  <footer>{@render actions()}</footer>
</svelte:element>

{#snippet help(id: string, label: string, body: string)}
  <span class="help">
    <button
      type="button"
      class="hint-btn"
      aria-label={label}
      aria-expanded={openHint === id}
      onclick={() => (openHint = openHint === id ? "" : id)}
    >?</button>
    {#if openHint === id}
      <span class="hint-panel" role="note">{body}</span>
    {/if}
  </span>
{/snippet}

{#snippet actions()}
  <div class="bar-actions">
    <button class="save" type="button" disabled={saving} onclick={save}>{saving ? "Saving…" : "Save"}</button>
    <button type="button" disabled={saving} onclick={() => { if (embedded) onclose?.(); else if ("close" in dialog) dialog.close(); }}>Cancel</button>
  </div>
{/snippet}

<style>
  dialog.settings-modal,
  .studio-embedded-settings {
    color: var(--hud-text);
    background:
      radial-gradient(ellipse at 12% 0%, rgba(45, 226, 197, 0.07), transparent 36%),
      var(--hud-bg);
    border: 0;
    border-radius: 0;
    width: 100vw;
    height: 100vh;
    max-width: 100vw;
    max-height: 100vh;
    margin: 0;
    padding: 0;
  }
  dialog.settings-modal[open],
  .studio-embedded-settings {
    display: flex;
    flex-direction: column;
  }
  .studio-embedded-settings {
    width: auto;
    height: auto;
    max-height: none;
    background: transparent;
  }
  dialog::backdrop {
    background: #000;
  }
  .settings-bar,
  footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.85rem 1.25rem;
    flex-shrink: 0;
  }
  .settings-bar {
    border-bottom: 1px solid var(--hud-line);
  }
  footer {
    justify-content: flex-end;
    border-top: 1px solid var(--hud-line);
  }
  .title-row,
  .section-head,
  .bar-actions,
  .inline-actions,
  .profile-actions {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    flex-wrap: wrap;
  }
  h2,
  h3 {
    margin: 0;
  }
  h2 {
    font-size: 1.45rem;
  }
  .scope-label {
    color: var(--hud-muted);
    font-size: 0.8rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  h3 {
    font-size: 1.2rem;
  }
  .tabs {
    display: flex;
    gap: 0.15rem;
    padding: 0 0.85rem;
    border-bottom: 1px solid var(--hud-line);
    overflow-x: auto;
    flex-shrink: 0;
  }
  .tabs button {
    border: 0;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    background: transparent;
    color: var(--hud-muted);
    padding: 0.85rem 0.95rem;
  }
  .tabs button[aria-selected="true"] {
    color: var(--hud-teal);
    border-bottom-color: var(--hud-teal);
    background: transparent;
  }
  .panel {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 1.75rem 2rem 2rem;
  }
  .panel-body {
    width: min(880px, 100%);
    display: grid;
    gap: 1.1rem;
    align-content: start;
  }
  .panel-body.wide {
    width: min(1080px, 100%);
  }
  .help {
    position: relative;
    display: inline-flex;
  }
  .hint-btn {
    width: 1.55rem;
    height: 1.55rem;
    padding: 0;
    border-radius: 50%;
    font-family: Inter, system-ui, sans-serif;
    font-weight: 700;
    letter-spacing: 0;
    text-transform: none;
    line-height: 1;
  }
  .hint-panel {
    position: absolute;
    z-index: 3;
    top: calc(100% + 0.45rem);
    left: 0;
    width: min(440px, 72vw);
    padding: 0.75rem 0.9rem;
    background: #1b2330;
    border: 1px solid var(--hud-teal);
    color: var(--hud-text);
    font-size: 0.85rem;
    line-height: 1.45;
    box-shadow: 0 16px 40px #000a;
  }
  .banner {
    margin: 0;
    padding: 0.55rem 1.25rem;
    background: rgba(255, 93, 115, 0.12);
    color: #ffb3bd;
    border-bottom: 1px solid var(--hud-danger);
    font-size: 0.85rem;
  }
  .status {
    margin: 0;
    color: var(--hud-muted);
    font-size: 0.85rem;
  }
  .profile-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
  }
  .stack {
    display: grid;
    gap: 0.35rem;
    font-size: 0.85rem;
  }
  .stack input,
  .stack select {
    width: 100%;
    padding: 0.55rem 0.65rem;
    background: var(--hud-input-bg);
    color: var(--hud-text);
    border: 1px solid var(--hud-line);
    border-radius: 2px;
  }
  .profile-issues {
    margin: 0;
    padding-left: 1.1rem;
    color: var(--hud-danger, #c44);
    font-size: 0.85rem;
  }
  .council-preview {
    margin: 0;
    padding-left: 1.2rem;
  }
  .reviewer-list {
    display: grid;
    gap: 0.75rem;
  }
  .reviewer {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.75rem;
    align-items: end;
    padding: 0.9rem;
    border: 1px solid var(--hud-line);
    background: var(--hud-bg-2);
  }
  .checks {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 0.65rem;
  }
  .check {
    display: flex;
    gap: 0.55rem;
    align-items: center;
    min-height: 2.8rem;
    padding: 0.65rem 0.8rem;
    border: 1px solid var(--hud-line);
    background: var(--hud-bg-2);
    font-size: 0.9rem;
  }
  button.save {
    background: var(--hud-teal);
    color: #0b1214;
    border-color: var(--hud-teal);
  }
  button.save:hover:not(:disabled) {
    background: #6ff3dc;
    color: #0b1214;
  }
  button {
    padding: 0.45rem 0.8rem;
  }
  button:disabled {
    opacity: 0.5;
  }
  @media (max-width: 720px) {
    .profile-grid,
    .reviewer {
      grid-template-columns: 1fr;
    }
    .panel {
      padding: 1.1rem;
    }
  }
</style>
