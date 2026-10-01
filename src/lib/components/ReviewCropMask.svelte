<script lang="ts">
  import {
    BRUSH_PRESETS,
    REVIEW_BRUSH_MAX,
    REVIEW_CROP_ZOOMS,
    brushSwatchPx,
    shiftBrushWheel,
    type ReviewCropZoom,
  } from "$lib/brush";

  const FIT_MAX = 360;

  let {
    cropUrl,
    maskUrl,
    disabled = false,
    expansion = $bindable(3),
    detecting = false,
    autodetect = false,
    ondetect,
  }: {
    cropUrl: string;
    maskUrl: string;
    disabled?: boolean;
    expansion?: number;
    detecting?: boolean;
    autodetect?: boolean;
    ondetect: () => void;
  } = $props();

  let tool = $state<"brush" | "erase">("brush");
  let radius = $state(8);
  let zoom = $state<ReviewCropZoom>(1);
  let previewSent = $state(false);
  let crop = $state<HTMLImageElement>();
  let view = $state<HTMLCanvasElement>();
  let mask = $state<HTMLCanvasElement>();
  let wrapWidth = $state(0);
  let history: ImageData[] = [];
  let loadGen = 0;
  let autoStarted = false;
  let painting = false;
  let last: { x: number; y: number } | null = null;
  let hover = $state<{ x: number; y: number } | null>(null);
  let hit = $state<HTMLDivElement>();
  const baseScale = $derived.by(() => {
    if (!crop?.naturalWidth || !crop.naturalHeight) return 1;
    const maxW = wrapWidth > 0 ? wrapWidth : crop.naturalWidth;
    return Math.min(1, FIT_MAX / crop.naturalHeight, maxW / crop.naturalWidth);
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

  export function maskDataUrl() {
    return mask?.toDataURL("image/png") ?? "";
  }

  function ctx(canvas: HTMLCanvasElement, name: "2d") {
    const context = canvas.getContext(name, { willReadFrequently: true });
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
    const maskCtx = ctx(mask, "2d");
    maskCtx.fillStyle = "#000";
    maskCtx.fillRect(0, 0, width, height);
    history = [];
    void draw();
  }

  function snapshot() {
    if (!mask) return;
    history.push(ctx(mask, "2d").getImageData(0, 0, mask.width, mask.height));
    if (history.length > 30) history.shift();
  }

  async function draw() {
    if (!view || !mask || !crop?.naturalWidth) return;
    const viewCtx = ctx(view, "2d");
    const maskCtx = ctx(mask, "2d");
    viewCtx.fillStyle = "#fff";
    viewCtx.fillRect(0, 0, view.width, view.height);
    viewCtx.drawImage(crop, 0, 0, view.width, view.height);
    const pixels = maskCtx.getImageData(0, 0, mask.width, mask.height);
    const overlay = viewCtx.getImageData(0, 0, view.width, view.height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      if (pixels.data[i] > 127) {
        if (previewSent) continue;
        overlay.data[i] = Math.round(overlay.data[i] * 0.55 + 255 * 0.45);
        overlay.data[i + 1] = Math.round(overlay.data[i + 1] * 0.55);
        overlay.data[i + 2] = Math.round(overlay.data[i + 2] * 0.55);
        continue;
      }
      if (previewSent) {
        overlay.data[i] = 255;
        overlay.data[i + 1] = 255;
        overlay.data[i + 2] = 255;
      }
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
    const maskCtx = ctx(mask, "2d");
    if (mask.width) snapshot();
    maskCtx.fillStyle = "#000";
    maskCtx.fillRect(0, 0, mask.width, mask.height);
    maskCtx.drawImage(image, 0, 0, mask.width, mask.height);
    await draw();
  }

  export async function replaceMask(url: string) {
    await loadMask(url);
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
    const maskCtx = ctx(mask, "2d");
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
      if (maskUrl && !autodetect) void loadMask(maskUrl);
    };
    image.src = url;
  });

  $effect(() => {
    if (!autodetect || autoStarted || disabled || !crop?.naturalWidth || !mask?.width) return;
    autoStarted = true;
    ondetect();
  });

  $effect(() => {
    previewSent;
    void draw();
  });
</script>

<div class="mask-editor">
  <div class="crop-wrap" bind:clientWidth={wrapWidth}>
    <div
      bind:this={hit}
      class="crop-hit"
      class:drawing={!disabled}
      style={`padding:${pad}px`}
      role="application"
      aria-label="Lettering mask for this crop"
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
    <label
      ><input
        type="checkbox"
        bind:checked={previewSent}
        disabled={disabled}
      /> Preview sent crop</label
    >
    <label
      >Detection padding (px)<input
        type="number"
        min="0"
        max="20"
        bind:value={expansion}
        disabled={disabled || detecting}
      /></label
    >
    <span class="zoom-group" role="group" aria-label="Crop zoom">
      {#each REVIEW_CROP_ZOOMS as amount}
        <button
          type="button"
          aria-pressed={zoom === amount}
          aria-label={`View crop at ${amount}×`}
          onclick={() => (zoom = amount)}>{amount}×</button
        >
      {/each}
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
    </span>
    <span class="ed-status">{radius}px</span>
    <button
      type="button"
      disabled={disabled || detecting}
      aria-pressed={tool === "brush"}
      onclick={() => (tool = "brush")}>Brush</button
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
      onclick={() => {
        const prior = history.pop();
        if (!mask || !prior) return;
        ctx(mask, "2d").putImageData(prior, 0, 0);
        void draw();
      }}>Undo stroke</button
    >
    <button type="button" disabled={disabled || detecting} onclick={ondetect}
      >Detect text</button
    >
  </div>
  <p>
    Detection starts automatically and uses the Clean-step text detector inside
    this crop. Zoom the crop if lettering is tiny. Brush from the margin around
    the image to reach the edges. Shift-scroll changes brush size by 1px.
    Unmasked pixels are sent as white.
  </p>
</div>

<style>
  .mask-editor {
    display: grid;
    gap: 0.6rem;
  }
  .crop-wrap {
    overflow: auto;
    max-height: min(70dvh, 640px);
    background: #111;
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
    gap: 0.45rem 0.7rem;
    align-items: center;
  }
  .mask-tools label {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.85rem;
  }
  .mask-tools input[type="number"] {
    width: 4.2rem;
    background: var(--hud-input-bg);
    color: var(--hud-text);
    border: 1px solid var(--hud-line);
    border-radius: 4px;
    padding: 0.2rem 0.35rem;
  }
  .zoom-group,
  .size-group {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    align-items: center;
  }
  .brush-preset {
    width: 28px;
    height: 28px;
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
    font-size: 0.85rem;
    color: var(--hud-muted);
  }
  button[aria-pressed="true"] {
    background: var(--hud-teal-dim);
  }
  p {
    white-space: normal;
    font-size: 0.85rem;
    margin: 0;
  }
</style>
