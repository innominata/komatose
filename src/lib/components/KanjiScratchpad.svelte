<script lang="ts">
  import SourceRomanization from "./SourceRomanization.svelte";

  let {
    disabled = false,
    onread,
    onaccept,
  }: {
    disabled?: boolean;
    onread: (image: string, signal: AbortSignal) => Promise<{ source: string }>;
    onaccept: (text: string) => void;
  } = $props();

  const SIZE = 220;
  let canvas = $state<HTMLCanvasElement>();
  let reading = $state("");
  let error = $state("");
  let busy = $state(false);
  let painted = $state(false);
  let history: ImageData[] = [];
  let painting = false;
  let last: { x: number; y: number } | null = null;
  let abort: AbortController | undefined;

  function ctx() {
    const context = canvas?.getContext("2d");
    if (!context) throw new Error("Kanji pad needs a canvas");
    return context;
  }

  function clearPad(keepHistory = false) {
    if (!canvas) return;
    const context = ctx();
    if (keepHistory) snapshot();
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    painted = false;
    reading = "";
    error = "";
  }

  function snapshot() {
    if (!canvas) return;
    history.push(ctx().getImageData(0, 0, canvas.width, canvas.height));
    if (history.length > 30) history.shift();
  }

  function undo() {
    const prev = history.pop();
    if (!prev || !canvas) return;
    ctx().putImageData(prev, 0, 0);
    const pixels = prev.data;
    painted = false;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] < 250 || pixels[i + 1] < 250 || pixels[i + 2] < 250) {
        painted = true;
        break;
      }
    }
    reading = "";
  }

  function point(e: PointerEvent) {
    if (!canvas) return null;
    const box = canvas.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    return {
      x: ((e.clientX - box.left) / box.width) * canvas.width,
      y: ((e.clientY - box.top) / box.height) * canvas.height,
    };
  }

  function stamp(from: { x: number; y: number }, to: { x: number; y: number }) {
    const context = ctx();
    context.strokeStyle = "#111";
    context.fillStyle = "#111";
    context.lineWidth = 8;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    painted = true;
  }

  function down(e: PointerEvent) {
    if (disabled || busy || e.button !== 0) return;
    const at = point(e);
    if (!at) return;
    e.preventDefault();
    painting = true;
    last = at;
    snapshot();
    stamp(at, at);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function move(e: PointerEvent) {
    if (!painting || !last || disabled || busy) return;
    const at = point(e);
    if (!at) return;
    stamp(last, at);
    last = at;
  }

  function up() {
    painting = false;
    last = null;
  }

  async function read() {
    if (!canvas || !painted) {
      error = "Draw a character first.";
      return;
    }
    abort?.abort();
    abort = new AbortController();
    error = "";
    reading = "";
    busy = true;
    try {
      const result = await onread(canvas.toDataURL("image/png"), abort.signal);
      reading = result.source.trim();
      if (!reading) error = "No character was read. Try a clearer stroke.";
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      error = String(e instanceof Error ? e.message : e);
    } finally {
      busy = false;
    }
  }

  function takeReading() {
    const text = reading;
    reading = "";
    clearPad();
    history = [];
    return text;
  }

  export function rejectReading() {
    reading = "";
    error = "";
  }

  $effect(() => {
    if (!canvas) return;
    canvas.width = SIZE;
    canvas.height = SIZE;
    clearPad();
  });
</script>

<div class="scratchpad">
  <strong>Kanji pad</strong>
  <canvas
    bind:this={canvas}
    width={SIZE}
    height={SIZE}
    aria-label="Draw a kanji"
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={up}
  ></canvas>
  <div class="pad-actions">
    <button type="button" disabled={disabled || busy || !painted} onclick={() => void read()}
      >Read drawing</button
    >
    <button type="button" disabled={disabled || busy || !history.length} onclick={undo}>Undo</button>
    <button type="button" disabled={disabled || busy} onclick={() => { history = []; clearPad(); }}
      >Clear pad</button
    >
  </div>
  {#if busy}<p role="status">Reading drawing…</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if reading}
    <div class="reading">
      <p class="glyph">{reading}</p>
      <SourceRomanization text={reading} />
      <div class="pad-actions">
        <button type="button" class="accept" onclick={() => onaccept(takeReading())}>Accept</button>
        <button type="button" onclick={rejectReading}>Reject</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .scratchpad {
    display: grid;
    gap: 6px;
    margin-top: 8px;
  }
  canvas {
    width: min(220px, 100%);
    height: auto;
    aspect-ratio: 1;
    background: #fff;
    border: 1px solid var(--hud-line, #4a4338);
    border-radius: 2px;
    touch-action: none;
    cursor: crosshair;
  }
  .pad-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .glyph {
    font-family: var(
      --jp-text,
      "Noto Sans JP",
      "Hiragino Sans",
      "Yu Gothic",
      "Noto Sans CJK JP",
      sans-serif
    );
    font-size: 1.4rem;
    font-weight: 400;
    margin: 0;
    color: var(--hud-text, #ecddbd);
  }
  .error {
    color: #ffb5a9;
    margin: 0;
  }
  p {
    margin: 0;
    font-size: 12px;
    color: var(--hud-muted, #9a8f7a);
  }
</style>
