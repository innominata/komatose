<script lang="ts">
  import "./studio-controls.css";
  import {
    EFFECT_BLENDS,
    EFFECT_DEFAULTS,
    EFFECT_LABELS,
    EFFECT_ORDER,
    type EffectKind,
    type GradientStop,
    type TextEffects,
  } from "$lib/textEffects";
  import { throttle } from "$lib/throttle";
  import type { PatternAsset } from "$lib/workflow";
  import { onMount } from "svelte";

  /**
   * Photoshop's Layer Style dialog for a text region: tick an effect to turn it on with
   * Photoshop's defaults, open it to adjust. Every change saves and refits like the rest of
   * the Style tab; the region's outline is its Stroke.
   */
  let {
    effects,
    disabled = false,
    onchange,
  }: {
    effects: TextEffects | undefined;
    disabled?: boolean;
    onchange: (effects: TextEffects | undefined) => void;
  } = $props();

  type Field =
    | { key: string; label: string; kind: "color" }
    | { key: string; label: string; kind: "range"; min: number; max: number; step?: number; unit: string }
    | { key: string; label: string; kind: "select"; options: readonly string[] }
    | { key: string; label: string; kind: "check" };
  const blend: Field = { key: "blend", label: "Blend mode", kind: "select", options: EFFECT_BLENDS };
  const colour: Field = { key: "color", label: "Color", kind: "color" };
  const opacity: Field = { key: "opacity", label: "Opacity", kind: "range", min: 0, max: 100, unit: "%" };
  const angle: Field = { key: "angle", label: "Angle", kind: "range", min: -180, max: 180, unit: "°" };
  const size = (max = 100): Field => ({ key: "size", label: "Size", kind: "range", min: 0, max, step: 0.5, unit: "pt" });
  const FIELDS: Record<EffectKind, Field[]> = {
    dropShadow: [blend, colour, opacity, angle, { key: "distance", label: "Distance", kind: "range", min: 0, max: 100, step: 0.5, unit: "pt" }, { key: "spread", label: "Spread", kind: "range", min: 0, max: 100, unit: "%" }, size()],
    innerShadow: [blend, colour, opacity, angle, { key: "distance", label: "Distance", kind: "range", min: 0, max: 100, step: 0.5, unit: "pt" }, { key: "spread", label: "Choke", kind: "range", min: 0, max: 100, unit: "%" }, size()],
    outerGlow: [blend, colour, opacity, { key: "spread", label: "Spread", kind: "range", min: 0, max: 100, unit: "%" }, size(), { key: "range", label: "Range", kind: "range", min: 1, max: 100, unit: "%" }],
    innerGlow: [blend, colour, opacity, { key: "source", label: "Source", kind: "select", options: ["edge", "center"] }, { key: "spread", label: "Choke", kind: "range", min: 0, max: 100, unit: "%" }, size(), { key: "range", label: "Range", kind: "range", min: 1, max: 100, unit: "%" }],
    satin: [blend, colour, opacity, angle, { key: "distance", label: "Distance", kind: "range", min: 1, max: 100, step: 0.5, unit: "pt" }, size(), { key: "invert", label: "Invert", kind: "check" }],
    colorOverlay: [blend, colour, opacity],
    patternOverlay: [blend, opacity, { key: "scale", label: "Scale", kind: "range", min: 1, max: 400, unit: "%" }],
    gradientOverlay: [blend, opacity, { key: "style", label: "Style", kind: "select", options: ["linear", "radial", "reflected"] }, angle, { key: "scale", label: "Scale", kind: "range", min: 10, max: 150, unit: "%" }, { key: "reverse", label: "Reverse", kind: "check" }],
    bevel: [
      { key: "style", label: "Style", kind: "select", options: ["inner bevel", "outer bevel", "emboss", "pillow emboss"] },
      { key: "depth", label: "Depth", kind: "range", min: 1, max: 1000, unit: "%" },
      { key: "direction", label: "Direction", kind: "select", options: ["up", "down"] },
      size(50),
      { key: "soften", label: "Soften", kind: "range", min: 0, max: 16, step: 0.5, unit: "pt" },
      angle,
      { key: "altitude", label: "Altitude", kind: "range", min: 0, max: 90, unit: "°" },
      { key: "highlightBlend", label: "Highlight mode", kind: "select", options: EFFECT_BLENDS },
      { key: "highlightColor", label: "Highlight color", kind: "color" },
      { key: "highlightOpacity", label: "Highlight opacity", kind: "range", min: 0, max: 100, unit: "%" },
      { key: "shadowBlend", label: "Shadow mode", kind: "select", options: EFFECT_BLENDS },
      { key: "shadowColor", label: "Shadow color", kind: "color" },
      { key: "shadowOpacity", label: "Shadow opacity", kind: "range", min: 0, max: 100, unit: "%" },
    ],
  };

  let open = $state<EffectKind | null>(null);
  const on = (kind: EffectKind) => !!effects?.[kind]?.enabled;
  const value = (kind: EffectKind, key: string) => ((effects?.[kind] ?? EFFECT_DEFAULTS[kind]) as Record<string, unknown>)[key];

  function update(kind: EffectKind, patch: Record<string, unknown>) {
    const current = effects?.[kind] ?? EFFECT_DEFAULTS[kind];
    onchange({ ...effects, [kind]: { ...current, ...patch } });
  }
  /** While a colour or slider is dragged: saved at most once a second. */
  const live = throttle((kind: EffectKind, patch: Record<string, unknown>) => update(kind, patch), 1000);
  const final = (kind: EffectKind, patch: Record<string, unknown>) => {
    live.cancel();
    update(kind, patch);
  };

  function toggle(kind: EffectKind, enabled: boolean) {
    if (enabled && !effects?.[kind]) open = kind;
    update(kind, { enabled });
  }
  /** Removing keeps nothing of the effect, so re-enabling starts from Photoshop's defaults. */
  function remove(kind: EffectKind) {
    const next = { ...effects };
    delete next[kind];
    onchange(Object.keys(next).length ? next : undefined);
    if (open === kind) open = null;
  }
  const stops = $derived((value("gradientOverlay", "stops") as GradientStop[]) ?? []);
  function setStop(i: number, patch: Partial<GradientStop>) {
    update("gradientOverlay", { stops: stops.map((s, k) => (k === i ? { ...s, ...patch } : s)) });
  }
  const liveStop = throttle((i: number, patch: Partial<GradientStop>) => setStop(i, patch), 1000);
  const anyOn = $derived(EFFECT_ORDER.some(on));

  // ── Pattern overlay: the shared pattern library ─────────────────────
  let patterns = $state<PatternAsset[] | null>(null);
  let patternError = $state("");
  let patternBusy = $state(false);
  let patternInput = $state<HTMLInputElement>();
  async function loadPatterns() {
    try {
      const res = await fetch("/settings/patterns");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not load patterns");
      patterns = body.patterns;
      patternError = "";
    } catch (e) {
      patternError = e instanceof Error ? e.message : String(e);
    }
  }
  onMount(() => {
    if (effects?.patternOverlay) loadPatterns();
  });
  $effect(() => {
    if (open === "patternOverlay" && patterns === null) loadPatterns();
  });
  const chosenPattern = $derived(String(value("patternOverlay", "patternId") ?? ""));
  const chosenPatternInfo = $derived(patterns?.find((p) => p.id === chosenPattern));
  /** Turning the overlay on with no pattern chosen picks the first one, so something shows. */
  async function toggleWith(kind: EffectKind, enabled: boolean) {
    if (kind !== "patternOverlay" || !enabled || chosenPattern) return toggle(kind, enabled);
    if (patterns === null) await loadPatterns();
    if (!effects?.patternOverlay) open = kind;
    update(kind, { enabled, ...(patterns?.length ? { patternId: patterns[0].id } : {}) });
  }
  async function addPatterns(files: File[]) {
    if (!files.length) return;
    patternBusy = true;
    patternError = "";
    let last = "";
    try {
      for (const file of files) {
        const form = new FormData();
        form.append("pattern", file);
        const res = await fetch("/settings/patterns", { method: "POST", body: form });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`${file.name}: ${body.error || res.statusText}`);
        patterns = body.patterns;
        last = body.added?.[0] ?? last;
      }
      if (last) update("patternOverlay", { patternId: last });
    } catch (e) {
      patternError = e instanceof Error ? e.message : String(e);
    } finally {
      patternBusy = false;
      if (patternInput) patternInput.value = "";
    }
  }
</script>

<details class="ls" open={anyOn}>
  <summary>Layer style{#if anyOn} <small>{EFFECT_ORDER.filter(on).length} on</small>{/if}</summary>
  <p class="panel-hint">Photoshop's layer effects, kept editable in PSD exports. The outline above is the Stroke.</p>
  <ul class="ls-list">
    {#each EFFECT_ORDER as kind (kind)}
      <li class:on={on(kind)}>
        <div class="ls-row">
          <label class="ls-name"><input type="checkbox" checked={on(kind)} {disabled} onchange={(e) => toggleWith(kind, e.currentTarget.checked)} /> {EFFECT_LABELS[kind]}</label>
          {#if effects?.[kind]}
            <button type="button" class="ls-icon" title="Remove and reset" aria-label={`Remove ${EFFECT_LABELS[kind]}`} {disabled} onclick={() => remove(kind)}><i class="bi bi-x-lg" aria-hidden="true"></i></button>
          {/if}
          <button type="button" class="ls-icon" aria-expanded={open === kind} aria-label={`${open === kind ? "Hide" : "Show"} ${EFFECT_LABELS[kind]} settings`}
            onclick={() => (open = open === kind ? null : kind)}><i class={`bi ${open === kind ? "bi-chevron-up" : "bi-chevron-down"}`} aria-hidden="true"></i></button>
        </div>
        {#if open === kind}
          <fieldset class="ls-fields" {disabled}>
            {#each FIELDS[kind] as field (field.key)}
              {#if field.kind === "color"}
                <label class="ls-field">{field.label}<input type="color" value={String(value(kind, field.key))} oninput={(e) => live(kind, { [field.key]: e.currentTarget.value })} onchange={(e) => final(kind, { [field.key]: e.currentTarget.value })} /></label>
              {:else if field.kind === "select"}
                <label class="ls-field">{field.label}
                  <select value={String(value(kind, field.key))} onchange={(e) => update(kind, { [field.key]: e.currentTarget.value })}>
                    {#each field.options as o}<option value={o}>{o}</option>{/each}
                  </select>
                </label>
              {:else if field.kind === "check"}
                <label class="ls-field ls-check"><input type="checkbox" checked={!!value(kind, field.key)} onchange={(e) => update(kind, { [field.key]: e.currentTarget.checked })} /> {field.label}</label>
              {:else}
                <label class="ls-field ls-range">{field.label}
                  <input type="range" min={field.min} max={field.max} step={field.step ?? 1} value={Number(value(kind, field.key))}
                    oninput={(e) => live(kind, { [field.key]: Number(e.currentTarget.value) })}
                    onchange={(e) => final(kind, { [field.key]: Number(e.currentTarget.value) })} />
                  <input type="number" min={field.min} max={field.max} step={field.step ?? 1} value={Number(value(kind, field.key))}
                    aria-label={`${field.label} (${field.unit})`}
                    onchange={(e) => update(kind, { [field.key]: Number(e.currentTarget.value) })} /><span>{field.unit}</span>
                </label>
              {/if}
            {/each}
            {#if kind === "patternOverlay"}
              <div class="ls-patterns">
                <span class="ls-phead">Pattern{#if chosenPatternInfo}<small>{chosenPatternInfo.name} · {chosenPatternInfo.width} × {chosenPatternInfo.height} px</small>{/if}</span>
                {#if patterns === null && !patternError}
                  <small class="ls-muted">Loading patterns…</small>
                {:else if patterns?.length}
                  <div class="ls-pgrid" role="listbox" aria-label="Pattern">
                    {#each patterns as p (p.id)}
                      <button type="button" role="option" aria-selected={p.id === chosenPattern} class="ls-pswatch" class:chosen={p.id === chosenPattern}
                        title={`${p.name} (${p.width} × ${p.height} px)`} aria-label={p.name}
                        style={`background-image:url('/settings/patterns/${p.id}');background-size:${Math.max(16, Math.min(p.width, 600) / 8)}px auto`}
                        onclick={() => update("patternOverlay", { patternId: p.id })}></button>
                    {/each}
                  </div>
                {:else if patterns}
                  <small class="ls-muted">The pattern library is empty. Add a screentone or other tile.</small>
                {/if}
                {#if chosenPattern && patterns && !chosenPatternInfo}<small class="ls-muted">The chosen pattern is no longer in the library; pick another.</small>{/if}
                {#if patternError}<small class="ls-error" role="alert">{patternError}</small>{/if}
                <div class="ls-prow">
                  <input class="visually-hidden" bind:this={patternInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple
                    onchange={(e) => addPatterns([...(e.currentTarget.files ?? [])])} />
                  <button type="button" disabled={patternBusy} onclick={() => patternInput?.click()}><i class="bi bi-plus-lg" aria-hidden="true"></i> {patternBusy ? "Adding…" : "Add pattern…"}</button>
                  <a href="/settings#patterns" target="_blank" rel="noopener">Manage library</a>
                </div>
                <small class="ls-muted">Scale is a percentage of the tile's pixels; tiling is anchored to the page, so neighbouring bubbles share one tone. Multiply keeps the text colour under dark dots.</small>
              </div>
            {/if}
            {#if kind === "gradientOverlay"}
              <div class="ls-stops">
                <span>Gradient</span>
                <div class="ls-bar" style={`background:linear-gradient(90deg, ${stops.map((s) => `${s.color} ${s.location}%`).join(", ")})`}></div>
                {#each stops as stop, i}
                  <div class="ls-stop">
                    <input type="color" aria-label={`Stop ${i + 1} color`} value={stop.color} oninput={(e) => liveStop(i, { color: e.currentTarget.value })} onchange={(e) => { liveStop.cancel(); setStop(i, { color: e.currentTarget.value }); }} />
                    <input type="number" min="0" max="100" aria-label={`Stop ${i + 1} location (%)`} value={stop.location} onchange={(e) => setStop(i, { location: Number(e.currentTarget.value) })} /><span>%</span>
                    {#if stops.length > 2}<button type="button" class="ls-icon" aria-label={`Remove stop ${i + 1}`} onclick={() => update("gradientOverlay", { stops: stops.filter((_, k) => k !== i) })}><i class="bi bi-x" aria-hidden="true"></i></button>{/if}
                  </div>
                {/each}
                {#if stops.length < 16}
                  <button type="button" onclick={() => update("gradientOverlay", { stops: [...stops, { color: stops.at(-1)?.color ?? "#ffffff", location: 100 }] })}>Add stop</button>
                {/if}
              </div>
            {/if}
          </fieldset>
        {/if}
      </li>
    {/each}
  </ul>
</details>

<style>
  .ls { border: 1px solid var(--hud-line); border-radius: 5px; padding: 8px 10px; display: grid; gap: 8px; }
  .ls summary { cursor: pointer; font-size: 12px; color: var(--hud-text); }
  .ls summary small { color: var(--hud-muted); margin-left: 4px; }
  .ls-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
  .ls-list li { border: 1px solid transparent; border-radius: 4px; }
  .ls-list li.on { border-color: var(--hud-line); background: rgba(0, 0, 0, 0.12); }
  .ls-row { display: flex; align-items: center; gap: 4px; padding: 3px 6px; }
  .ls-name { flex: 1; display: flex; gap: 6px; align-items: center; font-size: 12px; margin: 0; }
  .ls-icon { padding: 1px 6px; line-height: 1.2; }
  .ls-fields { border: 0; margin: 0; padding: 4px 8px 8px; display: grid; gap: 6px; }
  .ls-field { display: grid; grid-template-columns: 7.5em minmax(0, 1fr); gap: 6px; align-items: center; font-size: 11.5px; margin: 0; }
  .ls-field select, .ls-field input[type="color"] { min-width: 0; }
  .ls-range { grid-template-columns: 7.5em minmax(0, 1fr) 4.2em 1.6em; }
  .ls-range input[type="number"] { min-width: 0; padding: 1px 4px; }
  .ls-range span { color: var(--hud-muted); }
  .ls-check { grid-template-columns: auto 1fr; }
  .ls-patterns { display: grid; gap: 5px; font-size: 11.5px; }
  .ls-patterns small { font-size: 10.5px; }
  .ls-phead { display: flex; gap: 8px; align-items: baseline; }
  .ls-phead small { color: var(--hud-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ls-muted { color: var(--hud-muted); }
  .ls-error { color: var(--hud-danger); }
  .ls-pgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(38px, 1fr)); gap: 4px; max-height: 172px; overflow-y: auto; padding: 1px; }
  .ls-pswatch { aspect-ratio: 1; padding: 0; border: 1px solid var(--hud-line); border-radius: 3px; background-color: #fff; background-repeat: repeat; cursor: pointer; }
  .ls-pswatch.chosen { outline: 2px solid var(--hud-teal-ink); outline-offset: 1px; }
  .ls-prow { display: flex; gap: 10px; align-items: center; }
  .ls-prow a { font-size: 11px; }
  .ls-stops { display: grid; gap: 4px; font-size: 11.5px; }
  .ls-bar { height: 14px; border-radius: 3px; border: 1px solid var(--hud-line); }
  .ls-stop { display: grid; grid-template-columns: 3em 4.2em 1.4em auto; gap: 4px; align-items: center; }
</style>
