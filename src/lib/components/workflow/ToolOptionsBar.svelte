<script lang="ts">
  import type { GlossaryTerm } from '$lib/types';
  let {
    tool,
    characters = [],
    characterId = '',
    busy = false,
    oncharacter,
    onmanagecharacters,
    onstopcharacter,
    radius = $bindable(24),
    growAmount = $bindable(10),
    polygonCount = 0,
    canCompletePolygon = false,
    nudgeAmount = $bindable(10),
    oncompletepolygon,
    onapplycrop,
    onapplysplit,
    onapplyreslice,
    hasReslicePreview = false,
    onstopstyle,
    showNudge = false,
    onnudge,
  }: {
    tool: string;
    characters?: GlossaryTerm[];
    characterId?: string;
    busy?: boolean;
    oncharacter?: (id: string) => void;
    onmanagecharacters?: () => void;
    onstopcharacter?: () => void;
    radius?: number;
    growAmount?: number;
    polygonCount?: number;
    canCompletePolygon?: boolean;
    nudgeAmount?: number;
    oncompletepolygon?: () => void;
    onapplycrop?: () => void;
    onapplysplit?: () => void;
    onapplyreslice?: () => void;
    hasReslicePreview?: boolean;
    onstopstyle?: () => void;
    showNudge?: boolean;
    onnudge?: (dx: number, dy: number) => void;
  } = $props();

  const TOOL_INFO: Record<string, { icon: string; label: string; hint: string }> = {
    'assign-character': { icon: 'bi-person-badge', label: 'Assign character', hint: 'Choose a character, then click dialogue or thought regions. Esc stops.' },
    crop: { icon: "bi-crop", label: "Crop", hint: "Drag the crop box, then Apply." },
    split: { icon: "bi-vr", label: "Split page", hint: "Drag the line to where the page should split, then Apply." },
    reslice: { icon: "bi-hr", label: "Reslice strips", hint: "Automatic cuts use solid-color gaps. Click to adjust, then Apply." },
    reorder: { icon: "bi-arrow-down-up", label: "Reorder reading flow", hint: "Click a starting region, then each following region in reading order." },
    brush: { icon: "bi-brush", label: "Mask brush", hint: "Paint over lettering to add it to the mask." },
    erase: { icon: "bi-eraser", label: "Erase mask", hint: "Paint to remove areas from the mask." },
    "mask-grow": { icon: "bi-arrows-angle-expand", label: "Grow mask", hint: "Click one continuous mask section to expand it by the set amount." },
    "bubble-fill": { icon: "bi-paint-bucket", label: "Fill speech bubble", hint: "Click inside an enclosed balloon. Fills it with the sampled background, leaving the outline." },
    "clone-stamp": { icon: "bi-copy", label: "Clone stamp", hint: "Right-click to set the source, click to lock the offset, then drag to paint." },
    blur: { icon: "bi-droplet-half", label: "Blur", hint: "Paint to blend an inpainted patch into the surrounding gradient." },
    restore: { icon: "bi-clock-history", label: "Restore", hint: "Paint the previous saved artwork back with a soft edge." },
    raw: { icon: "bi-image", label: "Paint raw", hint: "Paint the uncleaned prepared pixels back onto the working page." },
    polygon: { icon: "bi-pentagon", label: "Draw polygon", hint: "Click to add points. Shift-click a point to remove it. Enter saves." },
    "style-brush": { icon: "bi-brush-fill", label: "Style brush", hint: "Click other regions to apply the copied style. Esc stops." },
  };
  const info = $derived(TOOL_INFO[tool]);
  const brushTools = ["brush", "erase", "blur", "restore", "raw", "clone-stamp", "bubble-fill"];
  const show = $derived(
    brushTools.includes(tool) ||
      tool === "mask-grow" ||
      tool === "polygon" ||
      tool === "crop" ||
      tool === "split" ||
      tool === "reslice" ||
      tool === "reorder" ||
      tool === "style-brush" ||
      tool === 'assign-character' ||
      showNudge,
  );
</script>

{#if show}
  <div class="tool-options" data-find="tool-options" role="region" aria-label="Tool options" title={info?.hint ?? ''}>
    {#if info}
      <i class={`bi ${info.icon}`} aria-hidden="true"></i><strong>{info.label}</strong><span class="hint">{info.hint}</span>
    {/if}
    <span class="spacer"></span>
    {#if tool === 'assign-character'}
      <label>Speaker<select value={characterId} disabled={busy} onchange={e => oncharacter?.(e.currentTarget.value)} aria-label="Character to assign">
        <option value="">Unknown / clear speaker</option>
        {#each characters as character (character.id)}<option value={character.id}>{character.translation}{character.source ? ` (${character.source})` : ''}</option>{/each}
      </select></label>
      <button type="button" onclick={onmanagecharacters}>Manage characters</button>
      <button type="button" onclick={onstopcharacter}>Done assigning</button>
    {/if}
    {#if brushTools.includes(tool)}
      <div class="brush-size" role="toolbar" aria-label="Brush size">
        <label>Size
          <input type="range" min="2" max="120" bind:value={radius} aria-label="Brush size" />
          <input type="number" min="2" max="120" bind:value={radius} aria-label="Brush size pixels" />
        </label>
        {#each [8, 16, 32] as preset (preset)}
          <button type="button" aria-label={`Brush ${preset} pixels`} aria-pressed={radius === preset} onclick={() => (radius = preset)}>{preset}</button>
        {/each}
      </div>
    {/if}
    {#if tool === "mask-grow"}
      <label>Grow amount
        <input type="number" min="1" max="80" bind:value={growAmount} aria-label="Grow mask by (px)" />
        px
      </label>
    {/if}
    {#if showNudge}
      <button type="button" onclick={() => onnudge?.(-1, 0)}>Nudge left</button>
      <button type="button" onclick={() => onnudge?.(1, 0)}>Nudge right</button>
      <button type="button" onclick={() => onnudge?.(0, -1)}>Nudge up</button>
      <button type="button" onclick={() => onnudge?.(0, 1)}>Nudge down</button>
      <label>Nudge px <input type="number" min="1" max="200" bind:value={nudgeAmount} aria-label="Nudge pixels" /></label>
    {/if}
    {#if tool === "polygon"}
      <span>{polygonCount} points</span>
      <button type="button" aria-label="Save polygon" disabled={!canCompletePolygon} onclick={() => oncompletepolygon?.()}>Save polygon</button>
    {/if}
    {#if tool === "crop"}
      <span>Drag a crop on the page.</span>
      <button type="button" onclick={() => onapplycrop?.()}>Apply crop</button>
    {/if}
    {#if tool === "split"}
      <span>Place the split, then apply.</span>
      <button type="button" onclick={() => onapplysplit?.()}>Apply split</button>
    {/if}
    {#if tool === "reslice"}
      <span>Click to add or remove manual cuts.</span>
      <button type="button" aria-label="Apply reslice cuts" disabled={!hasReslicePreview} onclick={() => onapplyreslice?.()}>Apply reslice cuts</button>
    {/if}
    {#if tool === "reorder"}
      <span>Click a starting region, then each following region in reading order.</span>
    {/if}
    {#if tool === "style-brush"}
      <span>Click regions to apply the copied style.</span>
      <button type="button" onclick={() => onstopstyle?.()}>Stop style brush</button>
    {/if}
    {#if tool === "crop" || tool === "split"}
      <label class="nudge">Nudge px <input type="number" min="1" max="200" bind:value={nudgeAmount} aria-label="Nudge pixels" /></label>
    {/if}
  </div>
{/if}

<style>
  .tool-options {
    position: absolute;
    top: 12px;
    right: 12px;
    z-index: 6;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: min(460px, calc(100% - 80px));
    padding: 8px 14px;
    border: 1px solid var(--hud-line);
    border-radius: 999px;
    background: var(--hud-bg-2);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
    font: 12px Inter, system-ui, sans-serif;
    color: var(--hud-text);
  }
  .tool-options > .bi { color: var(--hud-teal-ink); }
  .tool-options strong { white-space: nowrap; font-weight: 600; }
  .hint { color: var(--hud-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1 1 80px; }
  .spacer { flex: 0 0 8px; }
  .brush-size { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; flex: none; }
  .tool-options input[type="range"] { width: 110px; padding: 0; accent-color: var(--hud-teal-ink); }
  .tool-options label { display: inline-flex; align-items: center; gap: 6px; margin: 0; white-space: nowrap; color: var(--hud-text); }
  .tool-options input[type="number"] { width: 60px; }
  .tool-options button {
    border: 1px solid var(--hud-line);
    background: var(--hud-hover);
    color: var(--hud-text);
    border-radius: 5px;
    padding: 3px 8px;
    font: 500 12px Inter, system-ui, sans-serif;
    letter-spacing: 0;
    text-transform: none;
    white-space: nowrap;
  }
  .tool-options button[aria-pressed="true"] { border-color: var(--hud-teal-ink); color: var(--hud-teal-ink); background: var(--hud-teal-dim); }
</style>
