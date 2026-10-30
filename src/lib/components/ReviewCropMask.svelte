<script lang="ts">
  import {
    BRUSH_PRESETS,
    REVIEW_BRUSH_MAX,
    REVIEW_CROP_ZOOMS,
    brushSwatchPx,
    shiftBrushWheel,
    type ReviewCropZoom,
  } from "$lib/brush";
  import HelpTip from "./HelpTip.svelte";

  // A fitted crop may be enlarged this much to fill the panel.
  const FIT_UPSCALE = 4;
  // How much of the crop shows through under traced strokes.
  const TRACE_CROP_ALPHA = 0.35;

  let {
    cropUrl,
    maskUrl = "",
    variant = "mask",
    silhouette = false,
    disabled = false,
    expansion = $bindable(3),
    zoom = $bindable<ReviewCropZoom>(1),
    detecting = false,
    autodetect = false,
    ondetect,
    onchange,
  }: {
    cropUrl: string;
    maskUrl?: string;
    /** "mask" marks lettering pixels; "trace" draws ink over a faded crop. */
    variant?: "mask" | "trace";
    /** Mask preview shows the silhouette that will be sent. */
    silhouette?: boolean;
    disabled?: boolean;
    expansion?: number;
    zoom?: ReviewCropZoom;
    detecting?: boolean;
    autodetect?: boolean;
    ondetect?: () => void;
    onchange?: () => void;
  } = $props();

  const trace = $derived(variant === "trace");
  let tool = $state<"brush" | "erase">("brush");
  // The variant is fixed per editor; only the starting size depends on it.
  // svelte-ignore state_referenced_locally
  let radius = $state(variant === "trace" ? 4 : 8);
  let previewSent = $state(false);
  let painted = $state(false);
  let crop = $state<HTMLImageElement>();
  let view = $state<HTMLCanvasElement>();
  let mask = $state<HTMLCanvasElement>();
  let wrapWidth = $state(0);
  let wrapHeight = $state(0);
  let history = $state<ImageData[]>([]);
  let loadGen = 0;
  let autoStarted = false;
  let painting = false;
  let last: { x: number; y: number } | null = null;
  let hover = $state<{ x: number; y: number } | null>(null);
  let hit = $state<HTMLDivElement>();
  const baseScale = $derived.by(() => {
    if (!crop?.naturalWidth || !crop.naturalHeight) return 1;
    // Leave room for the brush margin around the image.
    const maxW = wrapWidth > 0 ? wrapWidth - 24 : crop.naturalWidth;
    const maxH = wrapHeight > 0 ? wrapHeight - 24 : crop.naturalHeight;
    return Math.max(0.05, Math.min(FIT_UPSCALE, maxW / crop.naturalWidth, maxH / crop.naturalHeight));
  });
  const displayW = $derived((crop?.naturalWidth ?? 0) * baseScale * zoom);
  const displayH = $derived((crop?.naturalHeight ?? 0) * baseScale * zoom);
  const displayScale = $derived(
    crop?.naturalWidth && displayW ? displayW / crop.naturalWidth : 1,
  );
  const pad = $derived(Math.ceil(radius * displayScale));
  const cursor = $derived.by(() => {
    if (!hover || !hit || disabled || !displayScale) return null;
    return {
      size: Math.max(4, radius * 2 * displayScale),
      x: pad + hover.x * displayScale,
      y: pad + hover.y * displayScale,
    };
  });

  /** Mask: white marks lettering. Trace: dark strokes on white, the image that is read. */
  export function maskDataUrl() {
    if (!mask) return "";
    if (!trace) return mask.toDataURL("image/png");
    const out = document.createElement("canvas");
    out.width = mask.width;
    out.height = mask.height;
    const outCtx = ctx(out);
    const pixels = ctx(mask).getImageData(0, 0, mask.width, mask.height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const ink = pixels.data[i] > 127 ? 0 : 255;
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = ink;
      pixels.data[i + 3] = 255;
    }
    outCtx.putImageData(pixels, 0, 0);
    return out.toDataURL("image/png");
  }

  export function hasStrokes() {
    return painted;
  }

  function ctx(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Mask editor needs a canvas");
    return context;
  }

  function sizeCanvases(width: number, height: number) {
    if (!view || !mask) return;
    if (view.width === width && view.height === height && mask.width === width) {
      void draw();
      return;
    }
    for (const canvas of [view, mask]) {
      canvas.width = width;
      canvas.height = height;
    }
    const maskCtx = ctx(mask);
    maskCtx.fillStyle = "#000";
    maskCtx.fillRect(0, 0, width, height);
    history = [];
    painted = false;
    void draw();
  }

  function snapshot() {
    if (!mask) return;
    history = [...history.slice(-29), ctx(mask).getImageData(0, 0, mask.width, mask.height)];
  }

  async function draw() {
    if (!view || !mask || !crop?.naturalWidth) return;
    const viewCtx = ctx(view);
    const maskCtx = ctx(mask);
    viewCtx.fillStyle = "#fff";
    viewCtx.fillRect(0, 0, view.width, view.height);
    if (!(previewSent && (trace || silhouette))) {
      viewCtx.globalAlpha = trace ? TRACE_CROP_ALPHA : 1;
      viewCtx.drawImage(crop, 0, 0, view.width, view.height);
      viewCtx.globalAlpha = 1;
    }
    const pixels = maskCtx.getImageData(0, 0, mask.width, mask.height);
    const overlay = viewCtx.getImageData(0, 0, view.width, view.height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const marked = pixels.data[i] > 127;
      if (trace || (previewSent && silhouette)) {
        // Strokes and silhouettes are sent as black on white.
        if (marked) overlay.data[i] = overlay.data[i + 1] = overlay.data[i + 2] = 0;
        continue;
      }
      if (marked) {
        if (previewSent) continue;
        overlay.data[i] = Math.round(overlay.data[i] * 0.55 + 255 * 0.45);
        overlay.data[i + 1] = Math.round(overlay.data[i + 1] * 0.55);
        overlay.data[i + 2] = Math.round(overlay.data[i + 2] * 0.55);
        continue;
      }
      if (previewSent) overlay.data[i] = overlay.data[i + 1] = overlay.data[i + 2] = 255;
    }
    viewCtx.putImageData(overlay, 0, 0);
  }

  async function loadMask(url: string) {
    if (!mask) return;
    const gen = ++loadGen;
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Mask image failed to load"));
      image.src = url;
    });
    if (gen !== loadGen || !mask) return;
    const maskCtx = ctx(mask);
    if (mask.width) snapshot();
    maskCtx.fillStyle = "#000";
    maskCtx.fillRect(0, 0, mask.width, mask.height);
    maskCtx.drawImage(image, 0, 0, mask.width, mask.height);
    painted = true;
    await draw();
  }

  export async function replaceMask(url: string) {
    await loadMask(url);
  }

  function clear() {
    if (!mask) return;
    snapshot();
    const maskCtx = ctx(mask);
    maskCtx.fillStyle = "#000";
    maskCtx.fillRect(0, 0, mask.width, mask.height);
    painted = false;
    onchange?.();
    void draw();
  }

  function point(e: PointerEvent) {
    if (!view?.width || !view.height) return null;
    const box = view.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    return {
      x: ((e.clientX - box.left) / box.width) * view.width,
      y: ((e.clientY - box.top) / box.height) * view.height,
    };
  }

  function stamp(from: { x: number; y: number }, to: { x: number; y: number }) {
    if (!mask) return;
    const maskCtx = ctx(mask);
    maskCtx.strokeStyle = tool === "erase" ? "#000" : "#fff";
    maskCtx.fillStyle = maskCtx.strokeStyle;
    maskCtx.lineWidth = radius * 2;
    maskCtx.lineCap = "round";
    maskCtx.lineJoin = "round";
    maskCtx.beginPath();
    maskCtx.moveTo(from.x, from.y);
    maskCtx.lineTo(to.x, to.y);
    maskCtx.stroke();
    maskCtx.beginPath();
    maskCtx.arc(to.x, to.y, radius, 0, Math.PI * 2);
    maskCtx.fill();
  }

  async function down(e: PointerEvent) {
    if (disabled || e.button !== 0) return;
    const at = point(e);
    if (!at) return;
    e.preventDefault();
    hover = at;
    painting = true;
    last = at;
    snapshot();
    stamp(at, at);
    if (tool === "brush") painted = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    await draw();
  }

  async function move(e: PointerEvent) {
    const at = point(e);
    hover = at;
    if (!painting || !last || !at || disabled) return;
    stamp(last, at);
    last = at;
    await draw();
  }

  function up() {
    if (painting) onchange?.();
    painting = false;
    last = null;
  }

  $effect(() => {
    const url = cropUrl;
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      crop = image;
      sizeCanvases(image.naturalWidth, image.naturalHeight);
      if (maskUrl && !autodetect && !trace) void loadMask(maskUrl);
    };
    image.src = url;
  });

  $effect(() => {
    if (!autodetect || autoStarted || disabled || !crop?.naturalWidth || !mask?.width) return;
    autoStarted = true;
    ondetect?.();
  });

  $effect(() => {
    previewSent;
    silhouette;
    void draw();
  });
</script>

<div class="mask-editor">
  <div class="crop-wrap" bind:clientWidth={wrapWidth} bind:clientHeight={wrapHeight}>
    <div
      bind:this={hit}
      class="crop-hit"
      class:drawing={!disabled}
      style={`padding:${pad}px`}
      role="application"
      aria-label={trace ? "Trace the text over this crop" : "Lettering mask for this crop"}
      use:shiftBrushWheel={{
        enabled: () => !disabled,
        value: () => radius,
        set: (size) => (radius = size),
        min: 1,
        max: REVIEW_BRUSH_MAX,
      }}
      onpointerdown={down}
      onpointermove={move}
      onpointerup={up}
      onpointercancel={up}
      onpointerleave={() => {
        if (!painting) hover = null;
      }}
    >
      <canvas
        bind:this={view}
        class="review-crop"
        style={displayW
          ? `width:${displayW}px;height:${displayH}px`
          : undefined}
      ></canvas>
      {#if cursor}
        <span
          class="brush-cursor"
          class:erase={tool === "erase"}
          style={`width:${cursor.size}px;height:${cursor.size}px;left:${cursor.x}px;top:${cursor.y}px`}
        ></span>
      {/if}
    </div>
  </div>
  <canvas bind:this={mask} hidden></canvas>
  <div class="mask-tools">
    <span class="tool-group" role="group" aria-label="Tool">
      <button
        type="button"
        disabled={disabled || detecting}
        aria-pressed={tool === "brush"}
        title={trace ? "Pen" : "Brush"}
        onclick={() => (tool = "brush")}>{trace ? "Pen" : "Brush"}</button
      >
      <button
        type="button"
        disabled={disabled || detecting}
        aria-pressed={tool === "erase"}
        onclick={() => (tool = "erase")}>Erase</button
      >
      <button
        type="button"
        disabled={disabled || detecting || !history.length}
        aria-label="Undo stroke"
        title="Undo stroke"
        onclick={() => {
          const prior = history.at(-1);
          if (!mask || !prior) return;
          history = history.slice(0, -1);
          ctx(mask).putImageData(prior, 0, 0);
          onchange?.();
          void draw();
        }}>↶</button
      >
      {#if trace}
        <button type="button" disabled={disabled || !painted} onclick={clear}>Clear</button>
      {/if}
    </span>
    <span class="size-group" role="group" aria-label="Brush size">
      {#each BRUSH_PRESETS as size}
        <button
          type="button"
          class="brush-preset"
          disabled={disabled}
          aria-pressed={radius === size}
          aria-label={`Brush ${size} pixels`}
          title={`Brush ${size}px. Shift-scroll adjusts 1px.`}
          onclick={() => (radius = size)}
          ><span
            class="brush-swatch"
            style={`width:${brushSwatchPx(size)}px;height:${brushSwatchPx(size)}px`}
          ></span></button
        >
      {/each}
      <span class="ed-status">{radius}px</span>
    </span>
    <span class="zoom-group" role="group" aria-label="Crop zoom">
      {#each REVIEW_CROP_ZOOMS as amount}
        <button
          type="button"
          aria-pressed={zoom === amount}
          aria-label={`View crop at ${amount}×`}
          title={`View at ${amount}× and send a ${amount}× crop on the next transcription request`}
          onclick={() => (zoom = amount)}>{amount}×</button
        >
      {/each}
    </span>
    <label class="check"
      ><input type="checkbox" bind:checked={previewSent} disabled={disabled} /> Preview sent</label
    >
    {#if !trace}
      <label class="check" title="Padding added around detected text, in pixels"
        >Pad<input
          type="number"
          min="0"
          max="20"
          bind:value={expansion}
          disabled={disabled || detecting}
        /></label
      >
      <button type="button" disabled={disabled || detecting} onclick={() => ondetect?.()}
        >{detecting ? "Detecting…" : "Detect text"}</button
      >
    {/if}
    <HelpTip label={trace ? "Trace help" : "Mask help"}>
      {#if trace}
        Write the text over the faded crop with the pen, one character at a time, in reading order.
        Only your strokes are sent, as black on white, so neat strokes read best. Use this when the
        lettering is too stylized for the readers. Shift-scroll changes pen size by 1px.
      {:else}
        Detection starts automatically and uses the Clean-step text detector inside this crop.
        Brush adds lettering, Erase removes it; brush from the margin around the image to reach the
        edges. Unmasked pixels are sent as white. Shift-scroll changes brush size by 1px.
      {/if}
      Zoom enlarges both the preview and the next transcription request.
    </HelpTip>
  </div>
</div>

<style>
  .mask-editor {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    min-height: 0;
    height: 100%;
  }
  .crop-wrap {
    flex: 1 1 0;
    min-height: 120px;
    overflow: auto;
    background: #111;
    display: grid;
    /* safe: an enlarged crop stays scrollable to its top-left edge. */
    place-items: safe center;
  }
  .crop-hit {
    position: relative;
    display: inline-block;
    background: #1a1a1a;
    touch-action: none;
  }
  .crop-hit.drawing {
    cursor: none;
  }
  .review-crop {
    display: block;
    background: white;
    pointer-events: none;
  }
  .brush-cursor {
    position: absolute;
    box-sizing: border-box;
    border: 1.5px solid #f4f7fb;
    outline: 1px solid #10161f;
    border-radius: 50%;
    pointer-events: none;
    transform: translate(-50%, -50%);
  }
  .brush-cursor.erase {
    border-color: #10161f;
    outline-color: #f4f7fb;
  }
  .mask-tools {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem 0.6rem;
    align-items: center;
    flex-shrink: 0;
  }
  .mask-tools button {
    padding: 0.2rem 0.5rem;
    font-size: 0.8rem;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.8rem;
  }
  .check input[type="number"] {
    width: 3.2rem;
    background: var(--hud-input-bg);
    color: var(--hud-text);
    border: 1px solid var(--hud-line);
    border-radius: 2px;
    padding: 0.1rem 0.3rem;
  }
  .tool-group,
  .zoom-group,
  .size-group {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    align-items: center;
  }
  .mask-tools .brush-preset {
    width: 24px;
    height: 24px;
    padding: 0;
    display: grid;
    place-items: center;
  }
  .brush-swatch {
    display: block;
    border-radius: 50%;
    background: currentColor;
    outline: 1px solid currentColor;
  }
  .ed-status {
    font-size: 0.8rem;
    color: var(--hud-muted);
    margin-left: 0.2rem;
  }
  button[aria-pressed="true"] {
    background: var(--hud-teal-dim);
  }
</style>
