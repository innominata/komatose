<script lang="ts">
  import type { PaletteId } from "../ToolPalette.svelte";

  type ToolDef = { id: PaletteId; icon: string; title: string; group: string };

  const ALL: Record<string, ToolDef> = {
    select: { id: "select", icon: "bi-cursor", title: "Select (V)", group: "" },
    region: { id: "region", icon: "bi-bounding-box", title: "Draw region (R)", group: "" },
    "read-area": { id: "read-area", icon: "bi-eye", title: "Read area with image model", group: "" },
    reorder: { id: "reorder", icon: "bi-arrow-down-up", title: "Reorder reading flow (O)", group: "" },
    crop: { id: "crop", icon: "bi-crop", title: "Crop", group: "" },
    split: { id: "split", icon: "bi-vr", title: "Split page", group: "" },
    reslice: { id: "reslice", icon: "bi-hr", title: "Reslice strips", group: "" },
    brush: { id: "brush", icon: "bi-brush", title: "Mask brush (B)", group: "Mask" },
    erase: { id: "erase", icon: "bi-eraser", title: "Erase mask (E)", group: "Mask" },
    "mask-grow": { id: "mask-grow", icon: "bi-arrows-angle-expand", title: "Grow mask (G)", group: "Mask" },
    "bubble-fill": { id: "bubble-fill", icon: "bi-paint-bucket", title: "Fill speech bubble (F)", group: "Touch up" },
    "clone-stamp": { id: "clone-stamp", icon: "bi-copy", title: "Clone stamp (C)", group: "Touch up" },
    blur: { id: "blur", icon: "bi-droplet-half", title: "Blur (L)", group: "Touch up" },
    restore: { id: "restore", icon: "bi-clock-history", title: "Restore (H)", group: "Touch up" },
    raw: { id: "raw", icon: "bi-image", title: "Paint raw (S)", group: "Touch up" },
    polygon: { id: "polygon", icon: "bi-pentagon", title: "Draw polygon", group: "Geometry" },
    "style-brush": { id: "style-brush", icon: "bi-brush-fill", title: "Style brush", group: "" },
    rectangle: { id: "rectangle", icon: "bi-square", title: "Draw rectangle", group: "Geometry" },
    oval: { id: "oval", icon: "bi-circle", title: "Draw oval", group: "Geometry" },
    zoom: { id: "zoom", icon: "bi-zoom-in", title: "Zoom (Z)", group: "" },
  };

  let {
    step,
    tool,
    canEdit = true,
    canClean = true,
    canUpload = true,
    showPolygon = false,
    canCopyStyle = false,
    onselect,
  }: {
    step: string;
    tool: string;
    canEdit?: boolean;
    canClean?: boolean;
    canUpload?: boolean;
    showPolygon?: boolean;
    canCopyStyle?: boolean;
    onselect: (id: PaletteId) => void;
  } = $props();

  const tools = $derived.by((): ToolDef[] => {
    const zoom = ALL.zoom;
    if (step === "Prepare")
      return [ALL.select, ...(canUpload ? [ALL.crop, ALL.split, ALL.reslice] : []), zoom];
    if (step === "Translate" || step === "Review")
      return canEdit ? [ALL.select, ALL.region, ALL["read-area"], ALL.reorder, zoom] : [ALL.select, zoom];
    if (step === "Clean")
      return canClean
        ? [
            ALL.select,
            { ...ALL.brush, group: "Mask" },
            ALL.erase,
            ALL["mask-grow"],
            ALL["bubble-fill"],
            ALL["clone-stamp"],
            ALL.blur,
            ALL.restore,
            ALL.raw,
            zoom,
          ]
        : [ALL.select, zoom];
    if (step === "Typeset")
      return canClean
        ? [
            ALL.select,
            ALL["style-brush"],
            { ...ALL.brush, title: "Text mask brush (B)", group: "Text mask" },
            { ...ALL.erase, title: "Erase text mask (E)", group: "Text mask" },
            ...(showPolygon ? [ALL.polygon, ALL.rectangle, ALL.oval] : []),
            zoom,
          ]
        : [ALL.select, zoom];
    return [zoom];
  });

  const groups = $derived.by(() => {
    const out: { name: string; tools: ToolDef[] }[] = [];
    for (const item of tools) {
      const name = item.group;
      const last = out[out.length - 1];
      if (!last || last.name !== name) out.push({ name, tools: [item] });
      else last.tools.push(item);
    }
    return out;
  });
</script>

{#if tools.length}
  <div class="tool-rail" role="toolbar" aria-label="Tools">
    {#each groups as group (group.name + group.tools[0].id)}
      <div class="rail-group" role="group" aria-label={group.name || "Canvas tools"}>
        {#if group.name}<span class="rail-label">{group.name}</span>{/if}
        {#each group.tools as item (item.id + item.title)}
          <button
            type="button"
            class="ed-rail-btn"
            class:active={tool === item.id}
            title={item.title}
            aria-label={item.title}
            aria-pressed={tool === item.id}
            data-find={item.id === "crop" ? "tool-crop" : item.id === "split" ? "tool-split" : item.id === "reslice" ? "tool-reslice" : item.id === "region" ? "tool-region" : item.id === "read-area" ? "tool-read-area" : item.id === "reorder" ? "tool-reorder" : item.id === "style-brush" ? "tool-style-brush" : item.id === "rectangle" ? "tool-rectangle" : ""}
            disabled={(["polygon", "rectangle", "oval"].includes(item.id) && !canClean) ||
              (item.id === "style-brush" && tool !== item.id && !canCopyStyle)}
            onclick={() => onselect(item.id)}
          >
            <i class="bi {item.icon}"></i>
          </button>
        {/each}
      </div>
    {/each}
  </div>
{/if}

<style>
  .tool-rail {
    width: 52px;
    flex: 0 0 52px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
    padding: 8px 4px;
    border-right: 1px solid var(--hud-line);
    background: var(--hud-bg-2);
    overflow: auto;
  }
  .rail-group { display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .rail-label {
    font-size: 9px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--hud-muted);
    text-align: center;
  }
  .ed-rail-btn {
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    border: 1px solid transparent;
    background: transparent;
    color: var(--hud-text);
    border-radius: 6px;
  }
  .ed-rail-btn.active, .ed-rail-btn[aria-pressed="true"] {
    background: var(--hud-teal-dim);
    color: var(--hud-teal);
    border-color: var(--hud-teal);
  }
</style>
