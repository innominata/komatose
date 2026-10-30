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
</script>

<details class="ls" open={anyOn}>
  <summary>Layer style{#if anyOn} <small>{EFFECT_ORDER.filter(on).length} on</small>{/if}</summary>
  <p class="panel-hint">Photoshop's layer effects, kept editable in PSD exports. The outline above is the Stroke.</p>
  <ul class="ls-list">
    {#each EFFECT_ORDER as kind (kind)}
      <li class:on={on(kind)}>
        <div class="ls-row">
          <label class="ls-name"><input type="checkbox" checked={on(kind)} {disabled} onchange={(e) => toggle(kind, e.currentTarget.checked)} /> {EFFECT_LABELS[kind]}</label>
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
  .ls-stops { display: grid; gap: 4px; font-size: 11.5px; }
  .ls-bar { height: 14px; border-radius: 3px; border: 1px solid var(--hud-line); }
  .ls-stop { display: grid; grid-template-columns: 3em 4.2em 1.4em auto; gap: 4px; align-items: center; }
</style>
