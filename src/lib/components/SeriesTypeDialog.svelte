<script lang="ts">
  import { onMount } from "svelte";
  import { activeRegionKinds, regionKindLabel } from "$lib/regionCatalog";
  import { groupFontsByCategory } from "$lib/fontCategories";
  import {
    allTypeStyles,
    DEFAULT_STYLE,
    MIN_STYLE_SIZE,
    styleKeys,
    TEXT_WARP_STYLE_LABELS,
    TEXT_WARP_STYLES,
    type FontAsset,
    type Preferences,
    type TextStyle,
  } from "$lib/workflow";

  let {
    triggerLabel = "",
    triggerClass = "btn-hud",
    fonts,
    seriesId,
    revision,
    prefs,
    canManage = false,
    embedded = false,
    onclose,
    onsave,
    onupload,
  }: {
    triggerLabel?: string;
    triggerClass?: string;
    fonts: FontAsset[];
    seriesId: string;
    revision: number;
    prefs: Partial<Preferences>;
    canManage?: boolean;
    embedded?: boolean;
    onclose?: () => void;
    onsave: (payload: {
      expectedRevision: number;
      style: TextStyle;
      styles: Record<string, TextStyle>;
    }) => Promise<{ revision: number } | null | undefined>;
    onupload?: (files: File[]) => Promise<void>;
  } = $props();

  let mounted = $state(false);
  let dialogEl = $state<HTMLDialogElement | HTMLDivElement | undefined>();
  let selected = $state<string>('""');
  let draft = $state<Record<string, TextStyle>>(allTypeStyles(undefined));
  let preview = $state("The quick brown fox.");
  let saving = $state(false);
  let dirty = $state(false);
  let error = $state("");
  let currentRevision = $state(0);

  const current = $derived(draft[selected] ?? { ...DEFAULT_STYLE });
  const previewFont = $derived(
    fonts.find((font) => font.id === current.fontId),
  );
  // Built-in types plus any region type this series added, and any type that
  // already has a saved style, so added types appear in this window.
  const kindIds = $derived(styleKeys(prefs));
  const regionKinds = $derived(activeRegionKinds(prefs.regionKinds));
  function kindLabel(id: string) {
    return regionKindLabel(id, regionKinds);
  }

  onMount(() => {
    mounted = true;
  });

  function loadDraft() {
    draft = structuredClone(allTypeStyles(prefs));
    currentRevision = revision;
    dirty = false;
    error = "";
  }

  $effect(() => {
    if (embedded) loadDraft();
  });

  function openModal() {
    loadDraft();
    if (!dialogEl || embedded || !("showModal" in dialogEl)) return;
    try {
      if (!dialogEl.open) dialogEl.showModal();
    } catch {
      dialogEl.setAttribute("open", "");
    }
  }

  function edit<K extends keyof TextStyle>(key: K, value: TextStyle[K]) {
    draft = {
      ...draft,
      [selected]: { ...draft[selected], [key]: value },
    };
    dirty = true;
  }

  function copyToAll() {
    const style = { ...current };
    draft = Object.fromEntries(
      kindIds.map((type) => [type, { ...style }]),
    );
    dirty = true;
  }

  async function apply() {
    if (!canManage || saving) return false;
    saving = true;
    error = "";
    try {
      const result = await onsave({
        expectedRevision: currentRevision,
        style: draft['""'],
        styles: draft,
      });
      if (result?.revision != null) currentRevision = result.revision;
      dirty = false;
      return true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      saving = false;
    }
  }

  function closeDialog() {
    const node = dialogEl as HTMLDialogElement | undefined;
    if (node && "close" in node && node.open) node.close();
    else onclose?.();
  }

  async function ok() {
    if (dirty && !(await apply())) return;
    closeDialog();
  }

  function cancel() {
    if (dirty && !window.confirm("Discard unsaved type settings?")) return;
    closeDialog();
  }

  async function addFont(files: FileList | null) {
    const selected = files ? Array.from(files) : [];
    if (!selected.length || !onupload) return;
    error = "";
    try {
      await onupload(selected);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

</script>

<svelte:head>
  {@html `<style>${fonts.map((f) => `@font-face{font-family:scan-${f.id};src:url('/series/${seriesId}/fonts/${f.id}');}`).join("")}</style>`}
</svelte:head>

{#if mounted && !embedded}
<button
  type="button"
  class={triggerLabel ? triggerClass : "type-settings-trigger"}
  data-type-settings-trigger
  aria-hidden={triggerLabel ? undefined : true}
  tabindex={triggerLabel ? undefined : -1}
  onclick={openModal}
>{triggerLabel || "Open series type settings"}</button>
{/if}
{#if mounted || embedded}
<svelte:element
  this={embedded ? "div" : "dialog"}
  class={embedded ? "type-settings type-settings-embedded" : "hud-modal type-settings"}
  bind:this={dialogEl}
  aria-labelledby="type-settings-title"
  role={embedded ? "dialog" : undefined}
  aria-label={embedded ? "Series Type Settings" : undefined}
  ontoggle={(e: Event) => {
    const node = e.currentTarget as HTMLDialogElement;
    if (node.open) loadDraft();
    else if (!embedded) onclose?.();
  }}
  onclick={(e: MouseEvent) => {
    if (!embedded && e.target === dialogEl) cancel();
  }}
  oncancel={(e: Event) => {
    e.preventDefault();
    cancel();
  }}
>
  <header class="hud-window-bar">
    <h3 id="type-settings-title">Series Type Settings</h3>
  </header>
  <div class="type-settings-inner">
    <p class="hud-option-hint" style="padding-left:0;margin-bottom:.75rem">
      Defaults for every chapter. A region can still override one box while typesetting.
    </p>
    {#if error}<p class="alert-hud mb-2">{error}</p>{/if}
    <div class="type-settings-toolbar">
      {#if canManage && onupload}
        <label class="small mb-0"
          >Upload TTF or OTF
          <input
            class="form-control form-control-sm"
            type="file"
            accept=".ttf,.otf"
            multiple
            onchange={(e) => {
              void addFont(e.currentTarget.files);
              e.currentTarget.value = "";
            }}
          /></label
        >
      {/if}
      <label class="small mb-0 type-settings-preview-input"
        >Preview text
        <input class="form-control form-control-sm" bind:value={preview} /></label
      >
    </div>
    <div class="type-settings-body">
      <nav class="type-settings-list" aria-label="Text types">
        {#each kindIds as type}
          <button
            type="button"
            class:active={selected === type}
            onclick={() => (selected = type)}
          >
            <strong>{kindLabel(type)}</strong>
            <small>{draft[type]?.size ?? DEFAULT_STYLE.size} pt</small>
          </button>
        {/each}
      </nav>
      <div class="type-settings-editor">
        <fieldset disabled={!canManage || saving}>
          <label class="hud-task-field"
            >Font
            <select
              class="form-select form-select-sm"
              value={current.fontId}
              onchange={(e) => edit("fontId", e.currentTarget.value)}
            >
              <option value="">Choose a font</option>
              {#each groupFontsByCategory(fonts) as group}
                <optgroup label={group.label}>
                  {#each group.fonts as font}
                    <option value={font.id}
                      >{font.familyName} · {font.subfamilyName}</option
                    >
                  {/each}
                </optgroup>
              {/each}
            </select>
          </label>
          <div class="type-settings-grid">
            <label class="hud-task-field"
              >Size (pt)
              <input
                class="form-control form-control-sm"
                type="number"
                min={MIN_STYLE_SIZE}
                max="200"
                step=".25"
                value={current.size}
                oninput={(e) => edit("size", Number(e.currentTarget.value))}
              /></label
            >
            <label class="hud-task-field"
              >Minimum (pt)
              <input
                class="form-control form-control-sm"
                type="number"
                min={MIN_STYLE_SIZE}
                max="200"
                step=".25"
                value={current.minSize}
                oninput={(e) => edit("minSize", Number(e.currentTarget.value))}
              /></label
            >
            <label class="hud-task-field"
              >Leading
              <input
                class="form-control form-control-sm"
                type="number"
                min="1"
                max="3"
                step=".05"
                value={current.leading}
                oninput={(e) => edit("leading", Number(e.currentTarget.value))}
              /></label
            >
            <label class="hud-task-field"
              >Padding (pt)
              <input
                class="form-control form-control-sm"
                type="number"
                min="0"
                max="100"
                step=".25"
                value={current.padding}
                oninput={(e) => edit("padding", Number(e.currentTarget.value))}
              /></label
            >
            <label class="hud-task-field"
              >Outline (pt)
              <input
                class="form-control form-control-sm"
                type="number"
                min="0"
                max="20"
                step=".25"
                value={current.outlineWidth}
                oninput={(e) =>
                  edit("outlineWidth", Number(e.currentTarget.value))}
              /></label
            >
            <label class="hud-task-field"
              >Rotation (°)
              <input
                class="form-control form-control-sm"
                type="number"
                min="-180"
                max="180"
                step="1"
                value={current.rotation}
                oninput={(e) => edit("rotation", Number(e.currentTarget.value))}
              /></label
            >
            <label class="hud-task-field"
              >Skew H (°)
              <input
                class="form-control form-control-sm"
                type="number"
                min="-75"
                max="75"
                step="1"
                value={current.skewX}
                oninput={(e) => edit("skewX", Number(e.currentTarget.value))}
              /></label
            >
            <label class="hud-task-field"
              >Skew V (°)
              <input
                class="form-control form-control-sm"
                type="number"
                min="-75"
                max="75"
                step="1"
                value={current.skewY}
                oninput={(e) => edit("skewY", Number(e.currentTarget.value))}
              /></label
            >
            <label class="hud-task-field"
              >Warp (Photoshop)
              <select
                class="form-select form-select-sm"
                value={current.warpStyle}
                onchange={(e) => {
                  const warpStyle = e.currentTarget
                    .value as TextStyle["warpStyle"];
                  const prev = draft[selected];
                  draft = {
                    ...draft,
                    [selected]: {
                      ...prev,
                      warpStyle,
                      warpBend:
                        warpStyle !== "none" && !prev.warpBend
                          ? 50
                          : prev.warpBend,
                    },
                  };
                  dirty = true;
                }}
              >
                {#each TEXT_WARP_STYLES as w}
                  <option value={w}>{TEXT_WARP_STYLE_LABELS[w]}</option>
                {/each}
              </select></label
            >
            <label class="hud-task-field"
              >Bend (%)
              <input
                class="form-control form-control-sm"
                type="number"
                min="-100"
                max="100"
                step="1"
                disabled={current.warpStyle === "none"}
                value={current.warpBend}
                oninput={(e) => edit("warpBend", Number(e.currentTarget.value))}
              /></label
            >
            <label class="hud-task-field"
              >Alignment
              <select
                class="form-select form-select-sm"
                value={current.align}
                onchange={(e) =>
                  edit("align", e.currentTarget.value as TextStyle["align"])}
              >
                <option value="center">center</option>
                <option value="left">left</option>
                <option value="right">right</option>
              </select></label
            >
            <label class="hud-task-field"
              >Emphasis
              <select
                class="form-select form-select-sm"
                value={current.emphasis}
                onchange={(e) =>
                  edit(
                    "emphasis",
                    e.currentTarget.value as TextStyle["emphasis"],
                  )}
              >
                <option value="normal">normal</option>
                <option value="bold">bold</option>
                <option value="italic">italic</option>
              </select></label
            >
          </div>
          <label class="hud-option-check">
            <input
              type="checkbox"
              checked={current.autoContrast !== false}
              onchange={(e) => edit("autoContrast", e.currentTarget.checked)}
            />
            Automatic black / white contrast
          </label>
          <div class="type-settings-grid">
            <label class="hud-task-field"
              >Fill
              <input
                class="form-control form-control-color"
                type="color"
                disabled={current.autoContrast !== false}
                value={current.fill}
                oninput={(e) => edit("fill", e.currentTarget.value)}
              /></label
            >
            <label class="hud-task-field"
              >Outline color
              <input
                class="form-control form-control-color"
                type="color"
                value={current.outline}
                oninput={(e) => edit("outline", e.currentTarget.value)}
              /></label
            >
          </div>
        </fieldset>
        <div
          class="type-settings-sample"
          style:font-family={previewFont ? `scan-${previewFont.id}` : "inherit"}
          style:font-size={`${current.size}pt`}
          style:line-height={String(current.leading)}
          style:font-style={current.emphasis === "italic" ? "italic" : "normal"}
          style:font-weight={current.emphasis === "bold" ? "700" : "400"}
          style:color={current.fill}
          style:text-align={current.align}
        >
          {preview || " "}
        </div>
        {#if previewFont}
          <p class="hud-kicker mb-0">
            {previewFont.familyName} · {previewFont.subfamilyName} · {previewFont.format}
          </p>
        {:else}
          <p class="hud-kicker mb-0">No font selected for {kindLabel(selected)}.</p>
        {/if}
        {#if canManage}
          <button class="btn-hud-ghost" type="button" onclick={copyToAll}
            >Apply this style to all types</button
          >
        {/if}
      </div>
    </div>
    <div class="hud-modal-actions">
      {#if canManage}
        <button class="btn-hud" type="button" disabled={saving} onclick={() => void ok()}
          >OK</button
        >
        <button class="btn-hud-ghost" type="button" onclick={cancel}>Cancel</button>
        <button class="btn-hud-ghost" type="button" disabled={saving || !dirty} onclick={() => void apply()}
          >Apply</button
        >
      {:else}
        <button class="btn-hud" type="button" onclick={closeDialog}>Done</button>
      {/if}
    </div>
  </div>
</svelte:element>
{/if}
