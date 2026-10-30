<script lang="ts">
  import "./studio-controls.css";
  import { defaultTextPath, pathFrame } from "$lib/textPath";
  import type { LineRow } from "$lib/types";
  import type { FittedLayout, TextPath } from "$lib/workflow";

  /**
   * Type on paths: the text flows along each path in turn, one line per path, so it can follow
   * ruled lines or other strokes in the art. Lines are drawn on the page; each has its own
   * start and flip.
   */
  let {
    line,
    paths,
    layout,
    pageWidth,
    pageHeight,
    drawing = false,
    disabled = false,
    onchange,
    ondraw,
  }: {
    line: LineRow;
    paths: TextPath[];
    layout?: FittedLayout;
    pageWidth?: number;
    pageHeight?: number;
    drawing?: boolean;
    disabled?: boolean;
    onchange: (paths: TextPath[]) => void;
    /** Start (true) or cancel (false) drawing a new line on the page. */
    ondraw?: (on: boolean) => void;
  } = $props();

  const box = $derived({ x: line.x ?? 0, y: line.y ?? 0, w: line.w ?? 0.2, h: line.h ?? 0.1 });
  const lengths = $derived(
    paths.map((p) =>
      pageWidth && pageHeight ? (pathFrame(p.points.map((q) => ({ x: q.x * pageWidth, y: q.y * pageHeight })), !!p.flip)?.length ?? 0) * (1 - (p.offset ?? 0)) : 0,
    ),
  );
  const used = $derived(new Set((layout?.onPath ? layout.rows : []).map((r) => r.path ?? 0)));
  const total = $derived(Math.round(lengths.reduce((a, b) => a + b, 0)));
  const needed = $derived(layout?.onPath ? Math.round(layout.rows.reduce((a, r) => a + r.width, 0)) : 0);

  function update(i: number, patch: Partial<TextPath>) {
    onchange(paths.map((p, k) => (k === i ? { ...p, ...patch } : p)));
  }
  /** A copy of the last line one line-height lower: quick for evenly ruled paper. */
  function addBelow() {
    const last = paths.at(-1);
    if (!last) return onchange([{ points: defaultTextPath(box) }]);
    const prev = paths.at(-2);
    const step = prev
      ? last.points[0].y - prev.points[0].y
      : layout && pageHeight
        ? (layout.size * (layout.dpi / 72) * (layout.style.leading || 1.2)) / pageHeight
        : box.h / 4;
    onchange([...paths, { ...last, points: last.points.map((p) => ({ x: p.x, y: p.y + (step || box.h / 4) })) }]);
  }
</script>

<section class="sec" data-find="text-path">
  <h3>Type on paths</h3>
  <label><input type="checkbox" checked={paths.length > 0} {disabled} onchange={(e) => onchange(e.currentTarget.checked ? [{ points: defaultTextPath(box) }] : [])} /> Set text along paths</label>
  {#if paths.length}
    <p class="panel-hint">
      The text fills line 1, then line 2 and so on, at one size; a new paragraph starts a new line and an empty one skips a line.
      Drag the orange handles to shape a line, double-click a line to add a point, Shift-click a handle to remove it.
      Each line exports to Photoshop as its own type-on-a-path layer.
    </p>
    {#if layout?.onPath && layout.overflow}
      <p class="tp-overflow" role="alert">
        The text doesn't fit: at the {layout.size} pt minimum it needs about {needed} px of line, and the lines have {total} px.
        Add or lengthen lines, shorten the text, or lower Minimum size in Style. Until it fits, the rest runs off the last line and the region is left out of PNG exports; the PSD still has it as type.
      </p>
    {/if}
    <ol class="tp-lines">
      {#each paths as path, i}
        <li class:unused={layout?.onPath && !used.has(i)}>
          <span class="tp-name">Line {i + 1} <small>{Math.round(lengths[i])} px{#if layout?.onPath && !used.has(i)} · empty{/if}</small></span>
          <span class="tp-order">
            <button type="button" title="Move up" aria-label={`Move line ${i + 1} up`} disabled={disabled || i === 0}
              onclick={() => onchange(paths.map((p, k) => (k === i - 1 ? paths[i] : k === i ? paths[i - 1] : p)))}><i class="bi bi-arrow-up" aria-hidden="true"></i></button>
            <button type="button" title="Remove line" aria-label={`Remove line ${i + 1}`} {disabled}
              onclick={() => onchange(paths.filter((_, k) => k !== i))}><i class="bi bi-trash" aria-hidden="true"></i></button>
          </span>
          <span class="tp-controls">
            <label title="Run the text the other way, on the other side of the line"><input type="checkbox" checked={!!path.flip} {disabled} onchange={(e) => update(i, { flip: e.currentTarget.checked || undefined })} /> Flip</label>
            <label class="tp-offset" title="Where the text starts along this line">Start
              <input type="range" min="0" max="90" step="1" {disabled} value={Math.round((path.offset ?? 0) * 100)}
                onchange={(e) => update(i, { offset: Number(e.currentTarget.value) / 100 || undefined })} />
            </label>
          </span>
        </li>
      {/each}
    </ol>
    <div class="control-row">
      {#if drawing}
        <button type="button" onclick={() => ondraw?.(false)}>Cancel drawing</button>
      {:else}
        <button type="button" {disabled} onclick={() => ondraw?.(true)}><i class="bi bi-pencil" aria-hidden="true"></i> Draw a line</button>
        <button type="button" {disabled} onclick={addBelow}>Add line below</button>
      {/if}
    </div>
    {#if drawing}
      <p class="panel-hint" role="status">Click along the art to place points; double-click or press Enter to finish, Esc to cancel.</p>
    {/if}
  {/if}
</section>

<style>
  .tp-overflow { margin: 0; padding: 6px 8px; border: 1px solid var(--hud-danger); border-radius: 4px; color: var(--hud-danger); font-size: 12px; }
  .tp-lines { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  .tp-lines li {
    display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 8px; align-items: center;
    padding: 5px 8px; border: 1px solid var(--hud-line); border-radius: 4px; font-size: 12px;
  }
  .tp-lines li.unused { opacity: .65; }
  .tp-name small { color: var(--hud-muted); margin-left: 4px; }
  .tp-order { display: flex; gap: 4px; }
  .tp-order button { padding: 2px 6px; }
  .tp-controls { grid-column: 1 / -1; display: flex; gap: 10px; align-items: center; }
  .tp-offset { display: flex; gap: 6px; align-items: center; flex: 1; }
  .tp-offset input { flex: 1; min-width: 0; }
</style>
