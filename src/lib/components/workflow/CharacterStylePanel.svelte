<script lang="ts">
  import "./studio-controls.css";
  import { applyCharStyle, commonCharStyle, remapCharRuns } from "$lib/charStyles";
  import { groupFontsByCategory } from "$lib/fontCategories";
  import { throttle } from "$lib/throttle";
  import type { CharRun, CharStyle, FontAsset, TextStyle } from "$lib/workflow";

  /**
   * Character styles, like Photoshop's Character panel: select characters in the text, then
   * any change applies to just those characters. Unset fields follow the region style; the
   * × beside a field clears it for the selection.
   */
  let {
    body,
    runs,
    runsBody,
    regionStyle,
    fonts,
    seriesId,
    disabled = false,
    onchange,
  }: {
    body: string;
    runs: CharRun[] | undefined;
    runsBody: string | undefined;
    regionStyle: TextStyle;
    fonts: FontAsset[];
    seriesId?: string;
    disabled?: boolean;
    onchange: (runs: CharRun[], body: string) => void;
  } = $props();

  const text = $derived(body.replace(/\r\n?/g, "\n"));
  const current = $derived(remapCharRuns(runs, runsBody?.replace(/\r\n?/g, "\n"), text));
  const fontGroups = $derived(groupFontsByCategory(fonts));

  let start = $state(0);
  let end = $state(0);
  let area = $state<HTMLTextAreaElement>();
  const hasSelection = $derived(end > start && end <= text.length);
  const common = $derived<CharStyle>(hasSelection ? commonCharStyle(current, text.length, start, end) : {});

  function track() {
    if (!area) return;
    start = Math.min(area.selectionStart, area.selectionEnd);
    end = Math.max(area.selectionStart, area.selectionEnd);
  }

  function set(patch: Record<string, unknown>) {
    if (!hasSelection || disabled) return;
    onchange(applyCharStyle(current, text.length, start, end, patch), text);
  }

  /** While a colour or opacity is dragged: saved at most once a second. */
  const live = throttle((patch: Record<string, unknown>) => set(patch), 1000);
  const final = (patch: Record<string, unknown>) => {
    live.cancel();
    set(patch);
  };

  function selectRun(run: CharRun) {
    start = run.start;
    end = run.end;
    area?.focus();
    area?.setSelectionRange(run.start, run.end);
  }

  function clearAll() {
    if (disabled) return;
    onchange([], text);
  }

  const num = (v: string) => (v === "" ? undefined : Number(v));
  const summary = (s: CharStyle) =>
    [
      s.fontId && (fonts.find((f) => f.id === s.fontId)?.familyName ?? "font"),
      s.size != null && `${s.size}%`,
      s.fill && "fill",
      s.outline && "outline",
      s.outlineWidth != null && `${s.outlineWidth} pt outline`,
      s.emphasis && s.emphasis,
      s.tracking != null && `tracking ${s.tracking}`,
      s.baselineShift != null && `shift ${s.baselineShift} pt`,
      s.horizontalScale != null && `H ${s.horizontalScale}%`,
      s.verticalScale != null && `V ${s.verticalScale}%`,
    ]
      .filter(Boolean)
      .join(" · ");

  /** The body as styled spans, a quick look at the overrides before the refit lands. */
  const spans = $derived.by(() => {
    const out: { text: string; css: string; marked: boolean }[] = [];
    let at = 0;
    for (const run of current) {
      if (run.start > at) out.push({ text: text.slice(at, run.start), css: "", marked: false });
      const s = run.style;
      const css = [
        s.fontId && `font-family:scan-${s.fontId}`,
        s.size != null && `font-size:${s.size}%`,
        s.fill && `color:${s.fill}`,
        s.fillOpacity != null && `opacity:${s.fillOpacity / 100}`,
        s.outline && s.outlineWidth !== 0 && `-webkit-text-stroke:${Math.max(0.5, (s.outlineWidth ?? regionStyle.outlineWidth) / 2)}px ${s.outline}`,
        s.emphasis === "bold" && "font-weight:700",
        s.emphasis === "italic" && "font-style:italic",
        s.tracking != null && `letter-spacing:${s.tracking / 1000}em`,
        s.baselineShift != null && `vertical-align:${s.baselineShift / 2}px`,
        (s.horizontalScale != null || s.verticalScale != null) &&
          `display:inline-block;transform:scale(${(s.horizontalScale ?? 100) / 100},${(s.verticalScale ?? 100) / 100})`,
      ]
        .filter(Boolean)
        .join(";");
      out.push({ text: text.slice(run.start, run.end), css, marked: true });
      at = run.end;
    }
    if (at < text.length) out.push({ text: text.slice(at), css: "", marked: false });
    return out;
  });
  const usedFonts = $derived([...new Set(current.map((r) => r.style.fontId).filter((f): f is string => !!f))]);
</script>

<svelte:head>
  {#if seriesId && usedFonts.length}
    {@html `<style>${usedFonts.map((id) => `@font-face{font-family:scan-${id};src:url('/series/${seriesId}/fonts/${id}');}`).join("")}</style>`}
  {/if}
</svelte:head>

<details class="cs" open>
  <summary>Characters{#if current.length} <small>{current.length} styled</small>{/if}</summary>
  <p class="panel-hint">Select characters, then change any setting to apply it to them. Unset settings follow the region style.</p>
  <textarea
    class="cs-text"
    rows="3"
    readonly
    aria-label="Select characters to style"
    value={text}
    bind:this={area}
    onselect={track}
    onkeyup={track}
    onmouseup={track}
    onfocus={track}
  ></textarea>
  {#if current.length}
    <div class="cs-preview" aria-label="Styled text preview" style={`font-family:scan-${regionStyle.fontId};color:${regionStyle.fill}`}>
      {#each spans as span}{#if span.marked}<mark style={span.css}>{span.text}</mark>{:else}{span.text}{/if}{/each}
    </div>
  {/if}
  <p class="cs-sel" role="status">
    {#if hasSelection}
      “{text.slice(start, end).length > 32 ? `${text.slice(start, start + 30)}…` : text.slice(start, end)}” · {end - start} character{end - start === 1 ? "" : "s"}
    {:else}
      No characters selected.
    {/if}
  </p>

  <fieldset class="cs-grid" disabled={disabled || !hasSelection}>
    <label class="wide">Font
      <span class="cs-field">
        <select value={common.fontId ?? ""} onchange={(e) => set({ fontId: e.currentTarget.value || undefined })}>
          <option value="">Region font</option>
          {#each fontGroups as group}<optgroup label={group.label}>{#each group.fonts as f}<option value={f.id}>{f.familyName} · {f.subfamilyName}</option>{/each}</optgroup>{/each}
        </select>
      </span>
    </label>
    {#each [["size", "Size (%)", 5, 10, 400], ["tracking", "Tracking (‰ em)", 10, -500, 2000], ["baselineShift", "Baseline shift (pt)", 0.5, -200, 200], ["horizontalScale", "Horizontal scale (%)", 1, 10, 400], ["verticalScale", "Vertical scale (%)", 1, 10, 400], ["outlineWidth", "Outline (pt)", 0.25, 0, 20]] as [key, label, step, min, max]}
      {@const k = key as keyof CharStyle}
      <label>{label}
        <span class="cs-field">
          <input
            type="number"
            {step}
            {min}
            {max}
            placeholder={k === "size" || k === "horizontalScale" || k === "verticalScale" ? "100" : k === "outlineWidth" ? String(regionStyle.outlineWidth) : "0"}
            value={common[k] ?? ""}
            onchange={(e) => set({ [k]: num(e.currentTarget.value) })}
          />
          {#if common[k] != null}<button type="button" class="cs-clear" title="Follow region style" aria-label={`Clear ${label}`} onclick={() => set({ [k]: undefined })}>×</button>{/if}
        </span>
      </label>
    {/each}
    <label>Emphasis
      <span class="cs-field">
        <select value={common.emphasis ?? ""} onchange={(e) => set({ emphasis: e.currentTarget.value || undefined })}>
          <option value="">Region ({regionStyle.emphasis})</option>
          <option value="normal">normal</option><option value="bold">bold</option><option value="italic">italic</option>
        </select>
      </span>
    </label>
    {#each [["fill", "fillOpacity", "Fill"], ["outline", "outlineOpacity", "Outline"]] as [color, opacity, label]}
      {@const c = color as "fill" | "outline"}
      {@const o = opacity as "fillOpacity" | "outlineOpacity"}
      <div class="cs-color">
        <span>{label}</span>
        <span class="cs-field">
          <input type="color" aria-label={`${label} color for selection`} value={common[c] ?? regionStyle[c]} oninput={(e) => live({ [c]: e.currentTarget.value })} onchange={(e) => final({ [c]: e.currentTarget.value })} />
          <input type="range" min="0" max="100" step="1" aria-label={`${label} opacity for selection`} value={common[o] ?? regionStyle[o]} oninput={(e) => live({ [o]: Number(e.currentTarget.value) })} onchange={(e) => final({ [o]: Number(e.currentTarget.value) })} />
          <small>{common[o] ?? regionStyle[o]}%</small>
          {#if common[c] != null || common[o] != null}<button type="button" class="cs-clear" title="Follow region style" aria-label={`Clear ${label}`} onclick={() => set({ [c]: undefined, [o]: undefined })}>×</button>{/if}
        </span>
      </div>
    {/each}
  </fieldset>

  {#if current.length}
    <ul class="cs-runs" aria-label="Styled characters">
      {#each current as run}
        <li>
          <button type="button" class="cs-run" title="Select these characters" onclick={() => selectRun(run)}>
            <strong>“{text.slice(run.start, run.end).length > 18 ? `${text.slice(run.start, run.start + 16)}…` : text.slice(run.start, run.end)}”</strong>
            <small>{summary(run.style)}</small>
          </button>
          <button type="button" class="cs-clear" title="Remove this style" aria-label="Remove this character style" disabled={disabled}
            onclick={() => onchange(current.filter((r) => r !== run), text)}>×</button>
        </li>
      {/each}
    </ul>
    <div class="control-row"><button type="button" {disabled} onclick={clearAll}>Clear all character styles</button></div>
  {/if}
</details>

<style>
  .cs { border: 1px solid var(--hud-line); border-radius: 5px; padding: 8px 10px; display: grid; gap: 8px; }
  .cs summary { cursor: pointer; font-size: 12px; color: var(--hud-text); }
  .cs summary small { color: var(--hud-muted); margin-left: 4px; }
  .cs-text { width: 100%; resize: vertical; font-size: 13px; }
  .cs-text::selection { background: var(--hud-teal-dim); }
  .cs-preview {
    padding: 6px 8px; border-radius: 4px; background: #fff; font-size: 15px; line-height: 1.35;
    white-space: pre-wrap; overflow-wrap: anywhere;
  }
  .cs-preview mark { background: transparent; color: inherit; }
  .cs-sel { margin: 0; font-size: 11.5px; color: var(--hud-muted); overflow-wrap: anywhere; }
  .cs-grid { border: 0; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .cs-grid:disabled { opacity: .55; }
  .cs-grid label, .cs-color { display: grid; gap: 3px; font-size: 11.5px; min-width: 0; }
  .cs-grid .wide { grid-column: 1 / -1; }
  .cs-field { display: flex; gap: 4px; align-items: center; min-width: 0; }
  .cs-field > input[type="number"], .cs-field > select { flex: 1; min-width: 0; }
  .cs-field > input[type="range"] { flex: 1; min-width: 0; }
  .cs-color small { font-size: 11px; color: var(--hud-muted); min-width: 2.6em; text-align: right; }
  .cs-clear { flex: none; padding: 0 6px; line-height: 1.4; }
  .cs-runs { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  .cs-runs li { display: flex; gap: 4px; align-items: stretch; }
  .cs-run { flex: 1; min-width: 0; display: grid; text-align: left; gap: 1px; padding: 4px 8px; }
  .cs-run strong, .cs-run small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cs-run small { color: var(--hud-muted); font-size: 11px; }
</style>
