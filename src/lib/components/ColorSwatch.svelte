<script lang="ts">
  import { tick } from "svelte";
  /**
   * A colour swatch whose click samples a colour from the page artwork with an eyedropper.
   *
   * The browser's own picker eyedropper is drawn by the browser, and on scaled displays its
   * magnifier jumps by uneven steps. This one magnifies the page image itself, so the view
   * moves exactly one image pixel at a time; arrow keys nudge the sample by one pixel.
   * While sampling, a colour panel beside the swatch picks a colour by hand instead; Alt-click
   * the swatch, or "System picker" in that panel, for the browser's own picker.
   *
   * Any image marked `data-color-sample` (the Typeset raw crop preview) can be sampled too,
   * only where it is visible: a crop shows part of a larger image inside a clipping box.
   */
  let {
    value,
    oninput,
    onpick,
    disabled = false,
    class: className = "",
    "aria-label": ariaLabel,
  }: {
    value: string;
    /** Every change, from the full picker while it is dragged or from the eyedropper. */
    oninput: (hex: string) => void;
    /** A colour chosen with the eyedropper, which fires no change event of its own. */
    onpick?: (hex: string) => void;
    disabled?: boolean;
    class?: string;
    "aria-label"?: string;
  } = $props();

  /** Image pixels shown on each side of the sampled one. */
  const RADIUS = 7;
  const SIDE = RADIUS * 2 + 1;
  /** Screen size of one magnified image pixel. */
  const CELL = 10;

  let input: HTMLInputElement;
  let dialog = $state<HTMLDialogElement>();
  let loupe = $state<HTMLCanvasElement>();
  let sampling = $state(false);
  /** The cursor, for placing the magnifier. */
  let cursor = $state({ x: 0, y: 0 });
  /** The sampled pixel: which artwork and where in its image. */
  let target = $state<{ img: HTMLImageElement; ix: number; iy: number } | null>(null);
  let hex = $state("");
  const grab = typeof document === "undefined" ? null : document.createElement("canvas");

  /** The part of an element on screen: its box cut down by every ancestor that clips it. */
  function visibleRect(el: HTMLElement) {
    const r = el.getBoundingClientRect();
    let left = Math.max(0, r.left), top = Math.max(0, r.top);
    let right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const style = getComputedStyle(a);
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const c = a.getBoundingClientRect();
      left = Math.max(left, c.left);
      top = Math.max(top, c.top);
      right = Math.min(right, c.right);
      bottom = Math.min(bottom, c.bottom);
    }
    return right > left && bottom > top ? { left, top, right, bottom } : null;
  }

  function artworks() {
    return [...document.querySelectorAll<HTMLImageElement>("img.artwork, img[data-color-sample]")].filter(
      (img) => img.complete && img.naturalWidth > 0 && !!visibleRect(img),
    );
  }

  function start(e: MouseEvent) {
    if (disabled || e.altKey || sampling) return;
    const shown = artworks();
    if (!shown.length) return; // No page to sample from: the full picker opens as usual.
    e.preventDefault();
    sampling = true;
    original = value;
    setHsv(value);
    placePanel();
    target = null;
    hex = "";
    cursor = { x: e.clientX, y: e.clientY };
    void tick().then(() => {
      dialog?.showModal();
      dialog?.focus();
      locate(e.clientX, e.clientY);
    });
  }

  function stop() {
    sampling = false;
    target = null;
    dialog?.close();
    input?.focus();
  }

  function openPicker() {
    stop();
    try {
      input.showPicker();
    } catch {
      input.click();
    }
  }

  /** The artwork pixel under a screen point; the topmost artwork wins. */
  function locate(x: number, y: number) {
    cursor = { x, y };
    const shown = artworks();
    for (let i = shown.length - 1; i >= 0; i--) {
      const img = shown[i];
      const v = visibleRect(img);
      if (!v || x < v.left || x >= v.right || y < v.top || y >= v.bottom) continue;
      const r = img.getBoundingClientRect();
      const ix = Math.min(img.naturalWidth - 1, Math.floor(((x - r.left) / r.width) * img.naturalWidth));
      const iy = Math.min(img.naturalHeight - 1, Math.floor(((y - r.top) / r.height) * img.naturalHeight));
      setTarget(img, ix, iy);
      return;
    }
    setTarget(null, 0, 0);
  }

  function setTarget(img: HTMLImageElement | null, ix: number, iy: number) {
    if (target && img === target.img && ix === target.ix && iy === target.iy) return;
    target = img ? { img, ix, iy } : null;
    draw();
  }

  function nudge(dx: number, dy: number) {
    if (!target) return;
    const { img } = target;
    const ix = Math.max(0, Math.min(img.naturalWidth - 1, target.ix + dx));
    const iy = Math.max(0, Math.min(img.naturalHeight - 1, target.iy + dy));
    setTarget(img, ix, iy);
  }

  /** Copies the pixels around the target and paints them as whole cells, so nothing is resampled. */
  function draw() {
    const out = loupe?.getContext("2d");
    if (!out || !loupe || !grab) return;
    const dpr = devicePixelRatio || 1;
    const cell = Math.max(1, Math.round(CELL * dpr));
    const size = cell * SIDE;
    if (loupe.width !== size) loupe.width = loupe.height = size;
    loupe.style.width = loupe.style.height = `${size / dpr}px`;
    out.fillStyle = "#808080";
    out.fillRect(0, 0, size, size);
    hex = "";
    if (!target) return;
    grab.width = grab.height = SIDE;
    const g = grab.getContext("2d", { willReadFrequently: true });
    if (!g) return;
    g.clearRect(0, 0, SIDE, SIDE);
    g.drawImage(target.img, target.ix - RADIUS, target.iy - RADIUS, SIDE, SIDE, 0, 0, SIDE, SIDE);
    let px: Uint8ClampedArray;
    try {
      px = g.getImageData(0, 0, SIDE, SIDE).data;
    } catch {
      return; // A cross-origin image cannot be read.
    }
    for (let y = 0; y < SIDE; y++)
      for (let x = 0; x < SIDE; x++) {
        const i = (y * SIDE + x) * 4;
        if (!px[i + 3]) continue;
        out.fillStyle = `rgb(${px[i]} ${px[i + 1]} ${px[i + 2]})`;
        out.fillRect(x * cell, y * cell, cell, cell);
      }
    const c = (RADIUS * SIDE + RADIUS) * 4;
    if (px[c + 3]) hex = "#" + [px[c], px[c + 1], px[c + 2]].map((v) => v.toString(16).padStart(2, "0")).join("");
    const line = Math.max(1, Math.round(dpr));
    out.lineWidth = line;
    out.strokeStyle = "#000";
    out.strokeRect(RADIUS * cell - line / 2, RADIUS * cell - line / 2, cell + line, cell + line);
    out.strokeStyle = "#fff";
    out.strokeRect(RADIUS * cell + line / 2, RADIUS * cell + line / 2, cell - line, cell - line);
  }

  function pick() {
    const chosen = hex;
    stop();
    if (!chosen) return;
    oninput(chosen);
    onpick?.(chosen);
  }

  function keydown(e: KeyboardEvent) {
    if ((e.target as HTMLElement).closest?.(".picker-panel")) return;
    const step = e.shiftKey ? 10 : 1;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    if (moves[e.key]) {
      e.preventDefault();
      nudge(...moves[e.key]);
    } else if ((e.key === "Enter" || e.key === " ") && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      pick();
    }
  }

  /** Scrolls whatever sits under the eyedropper, so the page can still be moved while sampling. */
  function wheel(e: WheelEvent) {
    for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
      if (el === dialog || dialog?.contains(el) || !(el instanceof HTMLElement)) continue;
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY + style.overflowX) && (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)) {
        el.scrollBy(e.deltaX, e.deltaY);
        requestAnimationFrame(() => locate(e.clientX, e.clientY));
        return;
      }
    }
  }

  // ── The colour panel shown beside the swatch while sampling ─────────────
  let original = $state("");
  let hue = $state(0);
  let sat = $state(0);
  let val = $state(0);
  let hexDraft = $state("");
  let overPanel = $state(false);
  let panelPos = $state({ left: 0, top: 0 });
  const PANEL_W = 232;
  const PANEL_H = 262;

  function hexToHsv(color: string) {
    const m = /^#?([a-f\d]{6})$/i.exec(color.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
    let h = 0;
    if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
  }
  function hsvToHex(h: number, s: number, v: number) {
    const f = (n: number) => {
      const k = (n + h / 60) % 6;
      return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
    };
    return "#" + [f(5), f(3), f(1)].map((c) => c.toString(16).padStart(2, "0")).join("");
  }
  function setHsv(color: string) {
    const hsv = hexToHsv(color);
    if (hsv) {
      // Greys and black have no hue of their own: keep the slider where it was.
      if (hsv.s > 0 && hsv.v > 0) hue = hsv.h;
      sat = hsv.s;
      val = hsv.v;
    }
    hexDraft = color;
  }
  const panelHex = $derived(hsvToHex(hue, sat, val));

  /** Beside the swatch: below it if there is room, else above; inside the window. */
  function placePanel() {
    const r = input?.getBoundingClientRect();
    if (!r) return;
    const left = Math.min(innerWidth - PANEL_W - 8, Math.max(8, r.right - PANEL_W));
    const top = r.bottom + 8 + PANEL_H < innerHeight ? r.bottom + 8 : Math.max(8, r.top - 8 - PANEL_H);
    panelPos = { left, top };
  }

  /** A colour chosen in the panel: shown live, like dragging in the browser's picker. */
  function panelInput(color: string) {
    hexDraft = color;
    oninput(color);
  }
  /** The end of a drag or an entered value: saved, like the picker's change. */
  function panelCommit() {
    onpick?.(panelHex);
  }
  function svPoint(e: PointerEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    sat = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    val = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
    panelInput(hsvToHex(hue, sat, val));
  }
  function hexEntered() {
    const t = hexDraft.trim();
    const color = (t.startsWith("#") ? t : `#${t}`).toLowerCase();
    if (!hexToHsv(color)) {
      hexDraft = panelHex;
      return;
    }
    setHsv(color);
    oninput(color);
    onpick?.(color);
  }
  function revert() {
    if (original && original !== value) {
      oninput(original);
      onpick?.(original);
    }
    stop();
  }

  const loupeSize = CELL * SIDE;
  const loupeLeft = $derived(cursor.x + 24 + loupeSize > innerWidth ? cursor.x - 24 - loupeSize : cursor.x + 24);
  const loupeTop = $derived(cursor.y + 24 + loupeSize + 28 > innerHeight ? cursor.y - 24 - loupeSize - 28 : cursor.y + 24);
</script>

<input
  bind:this={input}
  class={className}
  type="color"
  aria-label={ariaLabel}
  title="Click to pick from the page or choose a colour · Alt-click for the browser's colour picker"
  {value}
  {disabled}
  onclick={start}
  oninput={(e) => oninput(e.currentTarget.value)}
/>

{#if sampling}
  <dialog
    bind:this={dialog}
    class="eyedropper"
    tabindex="-1"
    aria-label="Pick a colour from the page"
    oncancel={(e) => { e.preventDefault(); stop(); }}
    onkeydown={keydown}
    onpointermove={(e) => {
      overPanel = !!(e.target as HTMLElement).closest(".picker-panel, .eyedropper-bar");
      if (!overPanel) locate(e.clientX, e.clientY);
    }}
    onpointerdown={(e) => {
      if ((e.target as HTMLElement).closest(".eyedropper-bar, .picker-panel")) return;
      e.preventDefault();
      if (e.button === 0) {
        locate(e.clientX, e.clientY);
        pick();
      } else stop();
    }}
    oncontextmenu={(e) => e.preventDefault()}
    onclick={(e) => {
      // The swatch may sit in a <label>, whose click would reopen the eyedropper.
      e.stopPropagation();
      if (!(e.target instanceof HTMLButtonElement) && !(e.target as HTMLElement).closest(".picker-panel")) e.preventDefault();
    }}
    onwheel={wheel}
  >
    <div class="eyedropper-bar">
      <span>Click a pixel on the page · arrow keys move one pixel · Enter picks · Esc cancels</span>
      <button type="button" onclick={stop}>Cancel</button>
    </div>
    <div class="picker-panel" role="group" aria-label="Colour picker" data-find="color-panel"
      style:left={`${panelPos.left}px`} style:top={`${panelPos.top}px`} style:width={`${PANEL_W}px`}>
      <div
        class="sv"
        role="slider"
        tabindex="0"
        aria-label="Saturation and brightness"
        aria-valuetext={panelHex}
        aria-valuenow={Math.round(sat * 100)}
        style:background-color={hsvToHex(hue, 1, 1)}
        onpointerdown={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          svPoint(e);
        }}
        onpointermove={(e) => {
          if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) svPoint(e);
        }}
        onpointerup={(e) => {
          if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) panelCommit();
        }}
        onkeydown={(e) => {
          const d = e.shiftKey ? 0.1 : 0.01;
          const moves: Record<string, [number, number]> = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] };
          if (!moves[e.key]) return;
          e.preventDefault();
          sat = Math.max(0, Math.min(1, sat + moves[e.key][0]));
          val = Math.max(0, Math.min(1, val + moves[e.key][1]));
          panelInput(hsvToHex(hue, sat, val));
        }}
        onkeyup={(e) => { if (e.key.startsWith("Arrow")) panelCommit(); }}
      >
        <span class="sv-handle" style:left={`${sat * 100}%`} style:top={`${(1 - val) * 100}%`} style:background={panelHex}></span>
      </div>
      <input
        class="hue"
        type="range"
        min="0"
        max="359"
        step="1"
        aria-label="Hue"
        value={Math.round(hue)}
        oninput={(e) => {
          hue = Number(e.currentTarget.value);
          panelInput(hsvToHex(hue, sat, val));
        }}
        onchange={panelCommit}
      />
      <div class="picker-row">
        <span class="picker-chips" title="Before · now"
          ><span style:background={original}></span><span style:background={value}></span></span
        >
        <input
          class="hex"
          type="text"
          aria-label="Hex colour"
          spellcheck="false"
          maxlength="7"
          bind:value={hexDraft}
          onkeydown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); hexEntered(); }
            else if (e.key === "Escape") { e.preventDefault(); stop(); }
          }}
          onblur={() => { if (hexDraft !== value) hexEntered(); }}
        />
      </div>
      <div class="picker-row">
        <button type="button" onclick={openPicker} title="The browser's own colour picker">System picker</button>
        <button type="button" onclick={revert} disabled={!original || original === value}>Revert</button>
        <button type="button" class="done" onclick={stop}>Done</button>
      </div>
    </div>
    <div class="eyedropper-loupe" class:hidden={overPanel} style:left={`${loupeLeft}px`} style:top={`${loupeTop}px`}>
      <canvas bind:this={loupe}></canvas>
      <div class="eyedropper-value">
        {#if hex}<span class="chip" style:background={hex}></span>{hex}{:else}Not on the page{/if}
      </div>
    </div>
  </dialog>
{/if}

<style>
  .eyedropper {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    max-width: none;
    max-height: none;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: crosshair;
    outline: none;
  }
  .eyedropper::backdrop {
    background: transparent;
  }
  .eyedropper-bar {
    position: absolute;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-radius: 6px;
    background: rgb(20 22 26 / 0.92);
    color: #eee;
    font-size: 12px;
    cursor: default;
    white-space: nowrap;
  }
  .eyedropper-bar button {
    font-size: 12px;
    padding: 2px 8px;
  }
  .eyedropper-loupe {
    position: absolute;
    pointer-events: none;
    border: 1px solid #000;
    box-shadow: 0 0 0 1px #fff, 0 4px 14px rgb(0 0 0 / 0.45);
    background: #222;
  }
  .eyedropper-loupe.hidden {
    display: none;
  }
  .picker-panel {
    position: absolute;
    display: grid;
    gap: 8px;
    padding: 10px;
    border: 1px solid rgb(255 255 255 / 0.12);
    border-radius: 8px;
    background: rgb(20 22 26 / 0.96);
    color: #eee;
    font-size: 12px;
    box-shadow: 0 8px 26px rgb(0 0 0 / 0.45);
    cursor: default;
  }
  .sv {
    position: relative;
    height: 140px;
    border-radius: 4px;
    background-image: linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent);
    cursor: crosshair;
    touch-action: none;
  }
  .sv:focus-visible {
    outline: 2px solid #68dac5;
    outline-offset: 2px;
  }
  .sv-handle {
    position: absolute;
    width: 12px;
    height: 12px;
    margin: -6px 0 0 -6px;
    border: 2px solid #fff;
    border-radius: 50%;
    box-shadow: 0 0 0 1px #000;
    pointer-events: none;
  }
  .hue {
    width: 100%;
    height: 12px;
    margin: 0;
    border-radius: 6px;
    appearance: none;
    background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00);
  }
  .hue::-webkit-slider-thumb {
    appearance: none;
    width: 8px;
    height: 16px;
    border: 2px solid #fff;
    border-radius: 3px;
    background: transparent;
    box-shadow: 0 0 0 1px #000;
  }
  .hue::-moz-range-thumb {
    width: 6px;
    height: 14px;
    border: 2px solid #fff;
    border-radius: 3px;
    background: transparent;
  }
  .picker-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .picker-row button {
    flex: 1;
    font-size: 12px;
    padding: 3px 6px;
  }
  .picker-chips {
    display: inline-flex;
    border: 1px solid #fff;
  }
  .picker-chips span {
    width: 20px;
    height: 22px;
  }
  .hex {
    flex: 1;
    min-width: 0;
    padding: 3px 6px;
    font: 12px ui-monospace, monospace;
  }
  .eyedropper-loupe canvas {
    display: block;
    image-rendering: pixelated;
  }
  .eyedropper-value {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 8px;
    color: #eee;
    font: 12px ui-monospace, monospace;
  }
  .chip {
    width: 14px;
    height: 14px;
    border: 1px solid #fff;
  }
</style>
