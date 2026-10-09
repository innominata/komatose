<script lang="ts">
  import type { ImageRow, LineRow } from "$lib/types";
  import { missingRegionCopy, missingRegionCopyLabel } from "$lib/exceptions";
  import { builtinRegionKinds, regionColor, regionKindLabel } from "$lib/regionCatalog";
  import { regionPaintOrder } from "$lib/regionGeometry";
  import { polygonEdgeHandle } from "$lib/textTransform";
  import { interpolateBrushPixels } from "$lib/cloneStamp";
  import { blurSigma } from "$lib/blurBrush";
  import type {
    FittedLayout,
    MaskStroke,
    PageData,
    Point,
    RegionData,
    TextStyle,
    WorkflowDoc,
  } from "$lib/workflow";

  export type StudioDrawing = {
    start: Point;
    end: Point;
    points: Point[];
    vertex?: number;
    revision?: number;
    bounds?: { x: number; y: number; w: number; h: number };
    regionId?: string;
    corner?: number;
    regionRevision?: number;
    rotation?: { initial: number; angle: number; center: Point; style: TextStyle };
    skew?: { axis: "x" | "y"; initial: number; angle: number; center: Point; style: TextStyle };
  };

  type ScrollAction = (node: HTMLElement) => { destroy(): void };

  let {
    page,
    step,
    pageTool,
    tool,
    zoom,
    zooming,
    compare,
    showMask,
    showRegions,
    canEdit,
    canClean,
    busy,
    lineId,
    radius,
    regionLabelScale,
    colorFor = (id) => regionColor(id, builtinRegionKinds()),
    labelFor = (id) => regionKindLabel(id, builtinRegionKinds()),
    speakerLabelFor = () => '',
    pageImage,
    cloneSource = null,
    cloneOffset = null,
    cloneEpoch = 0,
    blurEpoch = 0,
    restoreEpoch = 0,
    onclonesource,
    pageDoc,
    regionDoc,
    selected,
    pageLines,
    strokes,
    drawing = $bindable(null),
    polygonDraft = $bindable([]),
    cropDraft = $bindable(null),
    splitPosition = $bindable(0.5),
    canvasWidth = $bindable(0),
    svgEl = $bindable(),
    prepElement = $bindable(),
    canvasScrollEl = $bindable(),
    reslicePreview,
    selectedPolygon,
    scrollAction,
    regionLayout,
    regionTextMask,
    overlayStyle,
    adjustedBounds,
    rotationCenter,
    rotationAngle,
    skewAngle,
    asset,
    openActions,
    prepDown,
    prepUp,
    prepPoint,
    down,
    move,
    up,
    dragRegion,
    selectLine,
    reorderFromId = "",
    onreorderclick,
    onstylebrush,
    onassigncharacter,
    startRotation,
    rotationKey,
    startSkew,
    skewKey,
    oncompletepolygon,
    onact,
    onnotify,
  }: {
    page: ImageRow | undefined;
    step: string;
    pageTool: string;
    tool: string;
    speakerLabelFor?: (id: string) => string;
    onassigncharacter?: (id: string) => void;
    zoom: number;
    zooming: boolean;
    compare: boolean;
    showMask: boolean;
    showRegions: boolean;
    canEdit: boolean;
    canClean: boolean;
    busy: boolean;
    lineId: string;
    radius: number;
    regionLabelScale: number;
    colorFor?: (id: string) => string;
    labelFor?: (id: string) => string;
    pageImage: string;
    cloneSource?: Point | null;
    cloneOffset?: Point | null;
    cloneEpoch?: number;
    blurEpoch?: number;
    restoreEpoch?: number;
    onclonesource?: (point: Point) => void;
    pageDoc: WorkflowDoc<PageData> | undefined;
    regionDoc: WorkflowDoc<RegionData> | undefined;
    selected: LineRow | undefined;
    pageLines: LineRow[];
    strokes: MaskStroke[];
    drawing?: StudioDrawing | null;
    polygonDraft?: Point[];
    cropDraft?: { start: Point; end: Point } | null;
    splitPosition?: number;
    canvasWidth?: number;
    svgEl?: SVGSVGElement;
    prepElement?: HTMLDivElement;
    canvasScrollEl?: HTMLDivElement;
    reslicePreview: {
      preview: string;
      width: number;
      height: number;
      maxHeight: number;
      cuts: number[];
      forced: number[];
      manualRequired: boolean;
      pages: { id: string; number: number; top: number; height: number }[];
    } | null;
    selectedPolygon: Point[];
    scrollAction: ScrollAction;
    regionLayout: (id: string) => FittedLayout | undefined;
    regionTextMask: (id: string) => string | undefined;
    overlayStyle: (line: LineRow, layout: { style: TextStyle }) => string | undefined;
    adjustedBounds: (d: StudioDrawing) => { x: number; y: number; w: number; h: number };
    rotationCenter: (line: LineRow) => Point;
    rotationAngle: (d: StudioDrawing) => number;
    skewAngle: (d: StudioDrawing) => number;
    asset: (hash?: string) => string;
    openActions: (event: MouseEvent, imageId: string, lineId?: string) => void;
    prepDown: (e: PointerEvent) => void;
    prepUp: () => void;
    prepPoint: (e: PointerEvent) => Point;
    down: (e: PointerEvent) => void;
    move: (e: PointerEvent) => void;
    up: (e: PointerEvent) => void;
    dragRegion: (e: PointerEvent, line: LineRow, corner?: number) => void;
    selectLine: (id: string, origin: "page") => void;
    reorderFromId?: string;
    onreorderclick?: (id: string) => void;
    onstylebrush: (id: string) => void;
    startRotation: (e: PointerEvent) => void;
    rotationKey: (e: KeyboardEvent) => void;
    startSkew: (axis: "x" | "y", e: PointerEvent) => void;
    skewKey: (axis: "x" | "y", e: KeyboardEvent) => void;
    oncompletepolygon: () => void;
    onact: (body: Record<string, unknown>) => unknown;
    onnotify: (text: string) => void;
  } = $props();

  let brushHover = $state<{ x: number; y: number } | null>(null);
  let cloneOverlay: HTMLCanvasElement | undefined = $state();
  let cloneSnapshot: HTMLCanvasElement | null = null;
  let clonePreviewKey = "";
  let clonePainted = 0;
  let blurSnapshot: HTMLCanvasElement | null = null;
  let blurFiltered = $state<HTMLCanvasElement | null>(null);
  let blurMask: HTMLCanvasElement | null = null;
  let blurPreviewKey = "";
  let blurPainted = 0;
  let restoreSnapshot = $state<HTMLCanvasElement | null>(null);
  let restorePreviewKey = "";
  let restorePainted = 0;
  let featherStamp: HTMLCanvasElement | null = null;
  let featherRadius = -1;
  let ovalHover = $state<Point | null>(null);
  const ovalGuides = $derived.by(() => {
    if (step !== "Typeset" || tool !== "oval" || !page) return [];
    const box = drawing;
    const drawingOval = !!(
      box &&
      !box.rotation &&
      !box.skew &&
      box.vertex == null &&
      box.corner == null &&
      !box.regionId
    );
    if (drawingOval && box) {
      return [
        { axis: "h" as const, at: Math.min(box.start.y, box.end.y) },
        { axis: "h" as const, at: Math.max(box.start.y, box.end.y) },
        { axis: "v" as const, at: Math.min(box.start.x, box.end.x) },
        { axis: "v" as const, at: Math.max(box.start.x, box.end.x) },
      ];
    }
    if (!ovalHover) return [];
    return [
      { axis: "h" as const, at: ovalHover.y },
      { axis: "v" as const, at: ovalHover.x },
    ];
  });
  function trackHover(e: PointerEvent) {
    trackBrush(e);
    if (!page || tool !== "oval" || step !== "Typeset" || zooming) {
      ovalHover = null;
      return;
    }
    const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    if (!box.width || !box.height) return;
    ovalHover = {
      x: Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(1, (e.clientY - box.top) / box.height)),
    };
  }
  function trackBrush(e: PointerEvent) {
    if (!page || !["brush", "erase", "clone-stamp", "blur", "restore", "raw"].includes(tool) || zooming) {
      brushHover = null;
      return;
    }
    const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    if (!box.width || !box.height) return;
    brushHover = {
      x: Math.max(0, Math.min(page.width, ((e.clientX - box.left) / box.width) * page.width)),
      y: Math.max(0, Math.min(page.height, ((e.clientY - box.top) / box.height) * page.height)),
    };
  }
  function regionCenter(line: LineRow) {
    return {
      x: (line.x ?? 0) + (line.w ?? 0.2) / 2,
      y: (line.y ?? 0) + (line.h ?? 0.1) / 2,
    };
  }
  function textMaskCss(hash?: string) {
    if (!hash) return "";
    const url = asset(hash);
    return `mask-image:url("${url}");-webkit-mask-image:url("${url}");mask-size:100% 100%;-webkit-mask-size:100% 100%;mask-mode:luminance;-webkit-mask-source-type:luminance`;
  }
  function pagePointFromEvent(e: MouseEvent): Point | null {
    if (!svgEl) return null;
    const box = svgEl.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    return {
      x: Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(1, (e.clientY - box.top) / box.height)),
    };
  }
  function handleContext(e: MouseEvent) {
    if (tool === "clone-stamp" && step === "Clean" && !zooming && page) {
      e.preventDefault();
      e.stopPropagation();
      const point = pagePointFromEvent(e);
      if (point) onclonesource?.(point);
      return;
    }
    if (page) openActions(e, page.id);
  }
  function clearCloneOverlay() {
    if (!cloneOverlay) return;
    const ctx = cloneOverlay.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, cloneOverlay.width, cloneOverlay.height);
  }
  function stampClonePreview(points: Point[]) {
    if (!page || !cloneOverlay || !cloneSnapshot || !cloneOffset) return;
    if (cloneOverlay.width !== page.width || cloneOverlay.height !== page.height) {
      cloneOverlay.width = page.width;
      cloneOverlay.height = page.height;
    }
    const ctx = cloneOverlay.getContext("2d");
    if (!ctx) return;
    const ox = cloneOffset.x * page.width;
    const oy = cloneOffset.y * page.height;
    const pixels = interpolateBrushPixels(points, page.width, page.height);
    for (const dest of pixels) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(dest.x + 0.5, dest.y + 0.5, Math.max(1, radius), 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(cloneSnapshot, ox, oy);
      ctx.restore();
    }
  }
  $effect(() => {
    if (tool !== "clone-stamp" || !page || !pageImage) {
      cloneSnapshot = null;
      clonePreviewKey = "";
      if (tool !== "blur" && tool !== "restore" && tool !== "raw") clearCloneOverlay();
      return;
    }
    const key = `${page.id}:${pageImage}:${page.width}x${page.height}:${cloneEpoch}`;
    if (clonePreviewKey === key && cloneSnapshot) return;
    const src = pageImage;
    const width = page.width;
    const height = page.height;
    const image = new Image();
    image.onload = () => {
      if (pageImage !== src) return;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d")?.drawImage(image, 0, 0, width, height);
      cloneSnapshot = canvas;
      clonePreviewKey = key;
      clearCloneOverlay();
    };
    image.src = src;
  });
  $effect(() => {
    if (tool !== "clone-stamp" || !drawing || !cloneOffset) {
      clonePainted = 0;
      return;
    }
    const pts = drawing.points;
    if (clonePainted >= pts.length) return;
    stampClonePreview(clonePainted === 0 ? pts : pts.slice(clonePainted - 1));
    clonePainted = pts.length;
  });
  function featherStampCanvas(r: number) {
    if (featherStamp && featherRadius === r) return featherStamp;
    const size = r * 2 + 1;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const g = ctx.createRadialGradient(r + 0.5, r + 0.5, 0, r + 0.5, r + 0.5, r);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.25, "rgba(255,255,255,0.84)");
    g.addColorStop(0.5, "rgba(255,255,255,0.5)");
    g.addColorStop(0.75, "rgba(255,255,255,0.16)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    featherStamp = canvas;
    featherRadius = r;
    return canvas;
  }
  function ensureBlurMask() {
    if (!page) return null;
    if (!blurMask || blurMask.width !== page.width || blurMask.height !== page.height) {
      blurMask = document.createElement("canvas");
      blurMask.width = page.width;
      blurMask.height = page.height;
    }
    return blurMask;
  }
  function makeBlurred(snapshot: HTMLCanvasElement, sigma: number) {
    const canvas = document.createElement("canvas");
    canvas.width = snapshot.width;
    canvas.height = snapshot.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(snapshot, 0, 0);
    ctx.filter = `blur(${sigma}px)`;
    ctx.globalCompositeOperation = "source-atop";
    ctx.drawImage(snapshot, 0, 0);
    ctx.filter = "none";
    ctx.globalCompositeOperation = "source-over";
    return canvas;
  }
  function rebuildBlurOverlay() {
    if (!page || !cloneOverlay || !blurFiltered || !blurMask) return;
    if (cloneOverlay.width !== page.width || cloneOverlay.height !== page.height) {
      cloneOverlay.width = page.width;
      cloneOverlay.height = page.height;
    }
    const ctx = cloneOverlay.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, cloneOverlay.width, cloneOverlay.height);
    ctx.drawImage(blurFiltered, 0, 0);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(blurMask, 0, 0);
    ctx.globalCompositeOperation = "source-over";
  }
  function stampBlurPreview(points: Point[]) {
    if (!page || !cloneOverlay || !blurFiltered) return;
    const mask = ensureBlurMask();
    const kernel = featherStampCanvas(Math.max(1, radius));
    const maskCtx = mask?.getContext("2d");
    if (!mask || !kernel || !maskCtx) return;
    const pixels = interpolateBrushPixels(points, page.width, page.height);
    const r = Math.max(1, radius);
    for (const dest of pixels) {
      maskCtx.drawImage(kernel, dest.x - r, dest.y - r);
    }
    rebuildBlurOverlay();
  }
  $effect(() => {
    if (tool !== "blur" || !page || !pageImage) {
      blurSnapshot = null;
      blurFiltered = null;
      blurPreviewKey = "";
      if (tool !== "clone-stamp" && tool !== "restore" && tool !== "raw") clearCloneOverlay();
      return;
    }
    const key = `${page.id}:${pageImage}:${page.width}x${page.height}:${blurEpoch}:${radius}`;
    if (blurPreviewKey === key && blurFiltered) return;
    const src = pageImage;
    const width = page.width;
    const height = page.height;
    const sigma = blurSigma(radius);
    if (blurSnapshot && blurPreviewKey.startsWith(`${page.id}:${pageImage}:${width}x${height}:${blurEpoch}:`)) {
      blurFiltered = makeBlurred(blurSnapshot, sigma);
      blurPreviewKey = key;
      blurPainted = 0;
      const mask = ensureBlurMask();
      mask?.getContext("2d")?.clearRect(0, 0, mask.width, mask.height);
      clearCloneOverlay();
      return;
    }
    const image = new Image();
    image.onload = () => {
      if (pageImage !== src || tool !== "blur") return;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d")?.drawImage(image, 0, 0, width, height);
      blurSnapshot = canvas;
      blurFiltered = makeBlurred(canvas, sigma);
      blurPreviewKey = key;
      blurPainted = 0;
      const mask = ensureBlurMask();
      mask?.getContext("2d")?.clearRect(0, 0, mask.width, mask.height);
      clearCloneOverlay();
    };
    image.src = src;
  });
  $effect(() => {
    if (tool !== "blur" || !drawing) {
      blurPainted = 0;
      return;
    }
    if (!blurFiltered) return;
    const pts = drawing.points;
    if (blurPainted === 0) {
      const mask = ensureBlurMask();
      mask?.getContext("2d")?.clearRect(0, 0, mask.width, mask.height);
      clearCloneOverlay();
    }
    if (blurPainted >= pts.length) return;
    stampBlurPreview(blurPainted === 0 ? pts : pts.slice(blurPainted - 1));
    blurPainted = pts.length;
  });
  function rebuildRestoreOverlay() {
    if (!page || !cloneOverlay || !restoreSnapshot || !blurMask) return;
    if (cloneOverlay.width !== page.width || cloneOverlay.height !== page.height) {
      cloneOverlay.width = page.width;
      cloneOverlay.height = page.height;
    }
    const ctx = cloneOverlay.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, cloneOverlay.width, cloneOverlay.height);
    ctx.drawImage(restoreSnapshot, 0, 0);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(blurMask, 0, 0);
    ctx.globalCompositeOperation = "source-over";
  }
  function stampRestorePreview(points: Point[]) {
    if (!page || !cloneOverlay || !restoreSnapshot) return;
    const mask = ensureBlurMask();
    const kernel = featherStampCanvas(Math.max(1, radius));
    const maskCtx = mask?.getContext("2d");
    if (!mask || !kernel || !maskCtx) return;
    const pixels = interpolateBrushPixels(points, page.width, page.height);
    const r = Math.max(1, radius);
    for (const dest of pixels) {
      maskCtx.drawImage(kernel, dest.x - r, dest.y - r);
    }
    rebuildRestoreOverlay();
  }
  const stampSrc = $derived(
    tool === "restore" && pageDoc?.data.previousArtwork
      ? asset(pageDoc.data.previousArtwork)
      : tool === "raw" && pageDoc?.data.prepared
        ? asset(pageDoc.data.prepared)
        : "",
  );
  const stampTool = $derived(tool === "restore" || tool === "raw");
  $effect(() => {
    if (!stampTool || !page || !stampSrc) {
      restoreSnapshot = null;
      restorePreviewKey = "";
      if (tool !== "clone-stamp" && tool !== "blur") clearCloneOverlay();
      return;
    }
    const key = `${page.id}:${tool}:${stampSrc}:${page.width}x${page.height}:${restoreEpoch}`;
    if (restorePreviewKey === key && restoreSnapshot) return;
    const src = stampSrc;
    const kind = tool;
    const width = page.width;
    const height = page.height;
    const image = new Image();
    image.onload = () => {
      if (stampSrc !== src || tool !== kind) return;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d")?.drawImage(image, 0, 0, width, height);
      restoreSnapshot = canvas;
      restorePreviewKey = key;
      restorePainted = 0;
      const mask = ensureBlurMask();
      mask?.getContext("2d")?.clearRect(0, 0, mask.width, mask.height);
      clearCloneOverlay();
    };
    image.src = src;
  });
  $effect(() => {
    if (!stampTool || !drawing) {
      restorePainted = 0;
      return;
    }
    if (!restoreSnapshot) return;
    const pts = drawing.points;
    if (restorePainted === 0) {
      const mask = ensureBlurMask();
      mask?.getContext("2d")?.clearRect(0, 0, mask.width, mask.height);
      clearCloneOverlay();
    }
    if (restorePainted >= pts.length) return;
    stampRestorePreview(restorePainted === 0 ? pts : pts.slice(restorePainted - 1));
    restorePainted = pts.length;
  });
  const cloneDest = $derived.by(() => {
    if (tool !== "clone-stamp" || !page) return null;
    if (drawing) {
      const last = drawing.points[drawing.points.length - 1] ?? drawing.end;
      return { x: last.x * page.width, y: last.y * page.height };
    }
    return brushHover;
  });
  const cloneSourceCursor = $derived.by(() => {
    if (tool !== "clone-stamp" || !page || !cloneSource) return null;
    if (cloneOffset && cloneDest)
      return { x: cloneDest.x - cloneOffset.x * page.width, y: cloneDest.y - cloneOffset.y * page.height };
    return { x: cloneSource.x * page.width, y: cloneSource.y * page.height };
  });
  function flowPath(from: LineRow, to: LineRow, width: number, height: number) {
    const a = regionCenter(from);
    const b = regionCenter(to);
    const x1 = a.x * width;
    const y1 = a.y * height;
    const x2 = b.x * width;
    const y2 = b.y * height;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const pull = Math.min(48, len * 0.22);
    return `M ${x1} ${y1} Q ${(x1 + x2) / 2 - (dy / len) * pull} ${(y1 + y2) / 2 + (dx / len) * pull} ${x2} ${y2}`;
  }
</script>

<div class="canvas-scroll" class:zoom-mode={zooming} bind:this={canvasScrollEl} use:scrollAction>
  {#if page && step === "Prepare"}
    <div
      bind:this={prepElement}
      class="canvas-page prepare-page"
      class:zoom-tool={zooming}
      style={pageTool === "reslice" && reslicePreview ? `aspect-ratio:${reslicePreview.width}/${reslicePreview.height};width:${zoom}%` : `aspect-ratio:${page.width}/${page.height};width:${zoom}%`}
      role="application"
      aria-label="Page preparation canvas"
      oncontextmenu={(e) => openActions(e, page.id)}
      onpointerdown={prepDown}
      onpointermove={(e) => {
        splitPosition = prepPoint(e).x;
        if (cropDraft)
          cropDraft = { ...cropDraft, end: prepPoint(e) };
      }}
      onpointerup={() => prepUp()}
      onpointercancel={() => (cropDraft = null)}
    >
      <img
        class="artwork"
        src={pageTool === "reslice" && reslicePreview
          ? reslicePreview.preview
          : pageImage || `/api/images/${page.id}?v=${page.updatedAt}`}
        alt={page.originalName}
        draggable="false"
      />
      {#if pageTool === "split"}<div
          style={`position:absolute;left:${splitPosition * 100}%;top:0;height:100%;border-left:2px dashed #ff7050;pointer-events:none`}
        ></div>{/if}
      {#if pageTool === "reslice" && reslicePreview}
        {#each reslicePreview.pages as entry, i}
          {#if i > 0 && entry.id !== page.id}
            <div
              class="reslice-page-edge"
              style={`top:${(entry.top / reslicePreview.height) * 100}%`}
            >
              <span class="reslice-page-label">Page {entry.number} starts</span>
            </div>
          {/if}
        {/each}
        {#each reslicePreview.pages as entry}
          {#if entry.id === page.id}
            <div
              class="reslice-current-band"
              style={`top:${(entry.top / reslicePreview.height) * 100}%;height:${(entry.height / reslicePreview.height) * 100}%`}
            >
              <span class="reslice-page-label current">This page · {entry.number}</span>
            </div>
          {/if}
        {/each}
        {#each reslicePreview.cuts as cut}
          <div
            class="reslice-cut"
            class:forced={reslicePreview.forced.includes(cut)}
            style={`top:${(cut / reslicePreview.height) * 100}%`}
          ></div>
        {/each}
        <p class="reslice-hint">Automatic cuts only use solid-color gaps. Target slice height: {reslicePreview.maxHeight}px. {reslicePreview.manualRequired ? "Safe splits are ready. Oversized pages need manual splitting." : "Click to adjust cuts, then Apply."} Orange marks manual cuts through artwork.</p>
      {/if}
      {#if cropDraft}<div
          style={`position:absolute;left:${Math.min(cropDraft.start.x, cropDraft.end.x) * 100}%;top:${Math.min(cropDraft.start.y, cropDraft.end.y) * 100}%;width:${Math.abs(cropDraft.start.x - cropDraft.end.x) * 100}%;height:${Math.abs(cropDraft.start.y - cropDraft.end.y) * 100}%;border:2px solid #68dac5;background:#68dac533;pointer-events:none`}
        ></div>{/if}
    </div>
  {:else if page}<div
      class="canvas-page"
      bind:clientWidth={canvasWidth}
      class:zoom-tool={zooming}
      class:brush-tool={!zooming && (tool === "brush" || tool === "erase" || tool === "clone-stamp" || tool === "blur" || tool === "restore" || tool === "raw")}
      class:click-tool={!zooming && (tool === "bubble-fill" || tool === "mask-grow")}
      class:style-brush-tool={tool === "style-brush"}
      style={`aspect-ratio:${page.width}/${page.height};width:${zoom}%`}
      oncontextmenu={handleContext}
      role="group"
    >
      <img
        class="artwork"
        src={pageImage}
        alt={`Page ${page.pageNumber ?? page.originalName}`}
        draggable="false"
      />
      {#if step === "Clean" && (tool === "clone-stamp" || tool === "blur" || tool === "restore" || tool === "raw")}
        <canvas
          bind:this={cloneOverlay}
          class="clone-preview"
          width={page.width}
          height={page.height}
        ></canvas>
      {/if}
      {#if (step === "Typeset" || step === "Review") && !compare}{#each pageLines.filter((l) => l.sourceState !== "ignored" && !(["polygon", "rectangle", "oval"].includes(tool) && selected?.id === l.id)) as l}{@const layout =
            regionLayout(l.id)}{#if layout}<img
              class="text-overlay"
              style={[overlayStyle(l, layout), textMaskCss(regionTextMask(l.id))].filter(Boolean).join(";")}
              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(layout.svg)}`}
              alt=""
            />{/if}{/each}{/if}
      <svg
        bind:this={svgEl}
        viewBox={`0 0 ${page.width} ${page.height}`}
        role="application"
        aria-label="Page regions and cleaning mask"
        onpointerdown={down}
        onpointermove={(e) => {
          trackHover(e);
          move(e);
        }}
        onpointerup={up}
        onpointercancel={() => (drawing = null)}
        onlostpointercapture={() => (drawing = null)}
        onpointerleave={() => {
          brushHover = null;
          ovalHover = null;
        }}
      >
        {#if step === "Clean" && showMask && !compare}
          <defs>
            <mask id="removal-mask" maskUnits="userSpaceOnUse" x="0" y="0" width={page.width} height={page.height} style="mask-type: luminance">
              <rect width={page.width} height={page.height} fill="black" />
              {#if pageDoc?.data.mask}
                <image href={asset(pageDoc.data.mask)} width={page.width} height={page.height} />
              {/if}
              {#each [...strokes, ...(drawing && ["brush", "erase"].includes(tool) ? [{ points: drawing.points, radius, erase: tool === "erase" }] : [])] as stroke}
                <polyline points={stroke.points.map((p) => `${Math.min(page!.width - 1, Math.floor(p.x * page!.width))},${Math.min(page!.height - 1, Math.floor(p.y * page!.height))}`).join(" ")}
                  fill="none" stroke={stroke.erase ? "black" : "white"} stroke-width={Math.floor(stroke.radius) * 2} stroke-linecap="round" stroke-linejoin="round" />
                {#each stroke.points as p}
                  <circle cx={Math.min(page.width - 1, Math.floor(p.x * page.width))} cy={Math.min(page.height - 1, Math.floor(p.y * page.height))} r={Math.floor(stroke.radius)} fill={stroke.erase ? "black" : "white"} />
                {/each}
              {/each}
            </mask>
          </defs>
          <rect width={page.width} height={page.height} fill="#ff405c" opacity=".5" mask="url(#removal-mask)" pointer-events="none" />
        {/if}
        {#if step === "Typeset" && showMask && !compare && selected && (regionDoc?.data.textMask || (drawing && ["brush", "erase"].includes(tool)))}
          <defs>
            <mask id="text-conceal-mask" maskUnits="userSpaceOnUse" x="0" y="0" width={page.width} height={page.height} style="mask-type: luminance">
              <rect width={page.width} height={page.height} fill="black" />
              {#if regionDoc?.data.textMask}
                <image href={asset(regionDoc.data.textMask)} width={page.width} height={page.height} style="filter: invert(1)" />
              {/if}
              {#if drawing && ["brush", "erase"].includes(tool)}
                <polyline
                  points={drawing.points.map((p) => `${Math.min(page!.width - 1, Math.floor(p.x * page!.width))},${Math.min(page!.height - 1, Math.floor(p.y * page!.height))}`).join(" ")}
                  fill="none"
                  stroke={tool === "erase" ? "black" : "white"}
                  stroke-width={Math.floor(radius) * 2}
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
                {#each drawing.points as p}
                  <circle
                    cx={Math.min(page.width - 1, Math.floor(p.x * page.width))}
                    cy={Math.min(page.height - 1, Math.floor(p.y * page.height))}
                    r={Math.floor(radius)}
                    fill={tool === "erase" ? "black" : "white"}
                  />
                {/each}
              {/if}
            </mask>
          </defs>
          <rect width={page.width} height={page.height} fill="#6c4ce0" opacity=".4" mask="url(#text-conceal-mask)" pointer-events="none" />
        {/if}
        {#if brushHover && (tool === "brush" || tool === "erase" || tool === "blur" || tool === "restore" || tool === "raw")}
          <circle
            cx={brushHover.x}
            cy={brushHover.y}
            r={Math.max(1, radius)}
            fill="none"
            stroke="#10161f"
            stroke-width="3"
            vector-effect="non-scaling-stroke"
            pointer-events="none"
          />
          <circle
            cx={brushHover.x}
            cy={brushHover.y}
            r={Math.max(1, radius)}
            fill="none"
            stroke={tool === "restore" ? "#ffd28a" : tool === "raw" ? "#7ee0c8" : tool === "blur" ? "#9ec8ff" : "#f4f7fb"}
            stroke-width="1.25"
            vector-effect="non-scaling-stroke"
            pointer-events="none"
          />
          {#if tool === "blur" || tool === "restore" || tool === "raw"}
            <circle
              cx={brushHover.x}
              cy={brushHover.y}
              r={Math.max(1, radius * 0.35)}
              fill="none"
              stroke={tool === "restore" ? "#ffd28a" : tool === "raw" ? "#7ee0c8" : "#9ec8ff"}
              stroke-width="1"
              stroke-opacity="0.7"
              vector-effect="non-scaling-stroke"
              pointer-events="none"
            />
          {/if}
        {/if}
        {#if tool === "clone-stamp" && cloneSourceCursor}
          <circle
            cx={cloneSourceCursor.x}
            cy={cloneSourceCursor.y}
            r={Math.max(1, radius)}
            fill="none"
            stroke="#123e38"
            stroke-width="3"
            vector-effect="non-scaling-stroke"
            pointer-events="none"
          />
          <circle
            cx={cloneSourceCursor.x}
            cy={cloneSourceCursor.y}
            r={Math.max(1, radius)}
            fill="none"
            stroke="#62e5ce"
            stroke-width="1.25"
            vector-effect="non-scaling-stroke"
            pointer-events="none"
          />
          <line
            x1={cloneSourceCursor.x - 5}
            y1={cloneSourceCursor.y}
            x2={cloneSourceCursor.x + 5}
            y2={cloneSourceCursor.y}
            stroke="#62e5ce"
            stroke-width="1.25"
            vector-effect="non-scaling-stroke"
            pointer-events="none"
          />
          <line
            x1={cloneSourceCursor.x}
            y1={cloneSourceCursor.y - 5}
            x2={cloneSourceCursor.x}
            y2={cloneSourceCursor.y + 5}
            stroke="#62e5ce"
            stroke-width="1.25"
            vector-effect="non-scaling-stroke"
            pointer-events="none"
          />
        {/if}
        {#if tool === "clone-stamp" && cloneDest}
          <circle
            cx={cloneDest.x}
            cy={cloneDest.y}
            r={Math.max(1, radius)}
            fill="none"
            stroke="#10161f"
            stroke-width="3"
            vector-effect="non-scaling-stroke"
            pointer-events="none"
          />
          <circle
            cx={cloneDest.x}
            cy={cloneDest.y}
            r={Math.max(1, radius)}
            fill="none"
            stroke="#f4f7fb"
            stroke-width="1.25"
            vector-effect="non-scaling-stroke"
            pointer-events="none"
          />
        {/if}
        {#if showRegions && step === "Review" && pageLines.length > 1}
          <defs>
            <marker id="region-flow-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0.6 L8,4 L0,7.4 Z" fill="#000" fill-opacity="0.25" />
            </marker>
          </defs>
          {#each pageLines.slice(0, -1) as l, i}
            <path
              class="flow-arrow"
              class:active={tool === "reorder"}
              class:from-pick={reorderFromId === l.id}
              d={flowPath(l, pageLines[i + 1], page.width, page.height)}
              fill="none"
              stroke="#000"
              stroke-width={reorderFromId === l.id ? 3 : 1.75}
              stroke-opacity="0.25"
              marker-end="url(#region-flow-arrow)"
              vector-effect="non-scaling-stroke"
              pointer-events="none"
            />
          {/each}
        {/if}
        {#each showRegions ? regionPaintOrder(pageLines) : [] as painted (painted.line.id)}
          {@const l = painted.line}
          {@const i = painted.index}
          {@const color = colorFor(l.lineType)}
          {@const overflow = !!regionLayout(l.id)?.overflow}
          {@const missing = step === "Review" ? missingRegionCopy(l) : null}
          {@const missingSource = missing === "source" || missing === "both"}
          {@const missingEnglish = missing === "english" || missing === "both"}
          {@const selectedRegion = lineId === l.id}
          {@const speaker = speakerLabelFor(l.id)}
          {@const label = `${i + 1} · ${labelFor(l.lineType)}${speaker && ['Review', 'Translate'].includes(step) ? ` · ${speaker}` : ''}`}
          {@const labelWidth = label.length * 6.6 + 12}
          <g
            class:ignored={l.sourceState === "ignored"}
            class:reorder-pick={reorderFromId === l.id}
            class:overflow
            class:missing-copy={!!missing}
            ><rect
              x={(l.x ?? 0) * page.width}
              y={(l.y ?? 0) * page.height}
              width={(l.w ?? 0.2) * page.width}
              height={(l.h ?? 0.1) * page.height}
              fill={lineId === l.id || reorderFromId === l.id ? `${color}18` : "transparent"}
              stroke={reorderFromId === l.id ? "#f0c14b" : overflow ? "#e24c4c" : missing ? "#f0c14b" : color}
              stroke-opacity="0.8"
              stroke-width={lineId === l.id || reorderFromId === l.id ? 3 : 1.5}
              stroke-dasharray={reorderFromId === l.id ? "6 4" : undefined}
              vector-effect="non-scaling-stroke"
              pointer-events={["select", "reorder", "style-brush", 'assign-character'].includes(tool) ? "all" : "none"}
              role="button"
              tabindex="0"
              aria-label={`Region ${i + 1}, ${labelFor(l.lineType)}${speaker ? `, speaker ${speaker}` : ''}${overflow ? ", text overflow" : ""}${missing ? `, ${missingRegionCopyLabel(missing)}` : ""}`}
              aria-invalid={overflow || undefined}
              aria-describedby={selectedRegion ? `region-label-${l.id}` : undefined}
              aria-pressed={lineId === l.id}
              oncontextmenu={(e) => {
                e.stopPropagation();
                openActions(e, page.id, l.id);
              }}
              onpointerdown={(e) => {
                if (tool === "reorder" || tool === "style-brush" || tool === 'assign-character') {
                  e.stopPropagation();
                  return;
                }
                dragRegion(e, l);
              }}
              onclick={(e) => {
                e.stopPropagation();
                if (tool === "reorder") onreorderclick?.(l.id);
                else if (tool === "style-brush") onstylebrush(l.id);
                else if (tool === 'assign-character') onassigncharacter?.(l.id);
                else selectLine(l.id, "page");
              }}
              onkeydown={(e) => {
                if (e.key !== "Enter") return;
                if (tool === "reorder") onreorderclick?.(l.id);
                else if (tool === "style-brush") onstylebrush(l.id);
                else if (tool === 'assign-character') onassigncharacter?.(l.id);
                else selectLine(l.id, "page");
              }}
            />
            <g
              class="region-num"
              pointer-events="none"
              aria-hidden="true"
              transform={`translate(${(l.x ?? 0) * page.width} ${(l.y ?? 0) * page.height}) scale(${regionLabelScale})`}
            >
              <circle r="10" fill={color} stroke="#000" stroke-opacity="0.35" />
              <text y="3.8" text-anchor="middle">{i + 1}</text>
            </g>
            {#if selectedRegion || (tool === 'assign-character' && speaker)}
              <clipPath id={`region-label-clip-${l.id}`}>
                <rect
                  x={(l.x ?? 0) * page.width}
                  y={(l.y ?? 0) * page.height}
                  width={(l.w ?? 0.2) * page.width}
                  height={(l.h ?? 0.1) * page.height}
                />
              </clipPath>
              <g clip-path={`url(#region-label-clip-${l.id})`} pointer-events="none" aria-hidden="true">
                <g
                  class="region-label"
                  transform={`translate(${(l.x ?? 0) * page.width} ${((l.y ?? 0) + (l.h ?? 0.1)) * page.height - 15 * regionLabelScale}) scale(${regionLabelScale})`}
                >
                  <rect width={labelWidth - 4} height="15" fill={color} />
                  <text id={`region-label-${l.id}`} x="4" y="11">{label}</text>
                </g>
              </g>
            {/if}
            {#if overflow || missingSource || missingEnglish}
              <g
                class="region-flags"
                transform={`translate(${Math.min(page.width - 4 * regionLabelScale, ((l.x ?? 0) + (l.w ?? 0.2)) * page.width)} ${Math.max(0, (l.y ?? 0) * page.height)}) scale(${regionLabelScale})`}
                pointer-events="none"
              >
                {#if overflow}
                  <g class="region-error">
                    <title>Text overflow</title>
                    <circle cx="-11" cy="11" r="9" fill="#e24c4c" />
                    <text x="-11" y="15.5" text-anchor="middle">!</text>
                  </g>
                {/if}
                {#if missingSource}
                  <g class="region-missing" transform={`translate(${overflow ? -22 : 0} 0)`}>
                    <title>No source text</title>
                    <circle cx="-11" cy="11" r="9" fill="#f0c14b" stroke="#10161f" stroke-width="1.5" />
                    <text x="-11" y="15.5" text-anchor="middle">S</text>
                  </g>
                {/if}
                {#if missingEnglish}
                  <g
                    class="region-missing"
                    transform={`translate(${(overflow ? -22 : 0) + (missingSource ? -22 : 0)} 0)`}
                  >
                    <title>No English text</title>
                    <circle cx="-11" cy="11" r="9" fill="#ff9f43" stroke="#10161f" stroke-width="1.5" />
                    <text x="-11" y="15.5" text-anchor="middle">E</text>
                  </g>
                {/if}
              </g>
            {/if}</g
          >{/each}
        {#if showRegions && selected && canEdit && ["Translate", "Review"].includes(step)}
          {#each [[selected.x ?? 0, selected.y ?? 0], [(selected.x ?? 0) + (selected.w ?? 0.2), selected.y ?? 0], [(selected.x ?? 0) + (selected.w ?? 0.2), (selected.y ?? 0) + (selected.h ?? 0.1)], [selected.x ?? 0, (selected.y ?? 0) + (selected.h ?? 0.1)]] as [x, y], corner}
            <rect
              x={x * page.width - 5}
              y={y * page.height - 5}
              width="10"
              height="10"
              fill={colorFor(selected.lineType)}
              role="button"
              tabindex="0"
              aria-label={`Resize region corner ${corner + 1}`}
              onpointerdown={(e) =>
                dragRegion(e, selected!, corner)}
            />
          {/each}
        {/if}
        {#if showRegions && selected && regionDoc && canClean && !regionDoc.data.locked && tool === "select" && ["Translate", "Review", "Typeset"].includes(step)}
          {@const rotating = drawing?.rotation && drawing.regionId === selected.id ? drawing : null}
          {@const center = rotationCenter(selected)}
          <g transform={rotating ? `rotate(${rotationAngle(rotating) - rotating.rotation!.initial} ${center.x * page.width} ${center.y * page.height})` : undefined}>
            <circle
              cx={((selected.x ?? 0) + (selected.w ?? 0.2) / 2) * page.width}
              cy={(selected.y ?? 0) * page.height}
              r="8" fill="#62e5ce" stroke="#123e38" stroke-width="2"
              vector-effect="non-scaling-stroke" style="cursor: grab"
              role="button" tabindex="0" aria-label="Rotate placed text"
              onpointerdown={startRotation} onkeydown={rotationKey}
              onclick={(e) => e.stopPropagation()}>
              <title>Drag to rotate text. Arrow keys rotate 1°; Shift rotates 15°.</title>
            </circle>
          </g>
          {#if rotating}<text x={center.x * page.width} y={(selected.y ?? 0) * page.height - 15}
            fill="#62e5ce" text-anchor="middle" pointer-events="none">{rotationAngle(rotating)}°</text>{/if}
        {/if}
        {#if showRegions && drawing?.bounds}{@const bounds =
            adjustedBounds(drawing)}<rect
            x={bounds.x * page.width}
            y={bounds.y * page.height}
            width={bounds.w * page.width}
            height={bounds.h * page.height}
            fill={`${colorFor(selected?.lineType ?? "plain")}33`}
            stroke={colorFor(selected?.lineType ?? "plain")}
            stroke-width="2"
            vector-effect="non-scaling-stroke"
            pointer-events="none"
          />{/if}
        {#if showRegions && selected && step === "Typeset"}{@const pts = tool === "polygon" ? polygonDraft : selectedPolygon}{#if pts.length}<polygon
            points={pts
              .map(
                (p) => `${p.x * page!.width},${p.y * page!.height}`,
              )
              .join(" ")}
            fill="none"
            stroke="#57b9ff"
            stroke-width="2"
            vector-effect="non-scaling-stroke"
            pointer-events="none"
          />{/if}{#each pts as p, i}<circle
              cx={(drawing?.vertex === i ? drawing.end.x : p.x) *
                page.width}
              cy={(drawing?.vertex === i ? drawing.end.y : p.y) *
                page.height}
              r={tool === "polygon" && i === 0 ? 7 : 5}
              fill="#57b9ff"
              pointer-events={["style-brush", "bubble-fill", "mask-grow", "clone-stamp", "blur", "restore", "raw"].includes(tool) ? "none" : undefined}
              role="button"
              tabindex="0"
              aria-label={tool === "polygon" && i === 0
                ? "Close polygon"
                : `Move polygon point ${i + 1}`}
              onpointerdown={(e) => {
                e.stopPropagation();
                if (!canClean || busy || !["select", "polygon"].includes(tool)) return;
                if (e.shiftKey) {
                  if (tool === "polygon") polygonDraft = polygonDraft.filter((_, n) => n !== i);
                  else if (selectedPolygon.length > 3) void onact({
                    action: "region", id: selected!.id, expectedRevision: regionDoc!.revision,
                    data: { polygon: selectedPolygon.filter((_, n) => n !== i), geometryApproved: false },
                  });
                  else onnotify("A saved polygon needs at least three points.");
                  return;
                }
                if (tool === "polygon") {
                  if (i === 0 && polygonDraft.length >= 3) void oncompletepolygon();
                  return;
                }
                if (tool !== "select") return;
                svgEl!.setPointerCapture(e.pointerId);
                drawing = {
                  start: p,
                  end: p,
                  points: [],
                  vertex: i,
                  revision: regionDoc?.revision,
                };
              }}
            />{/each}{/if}
        {#if showRegions && selected && regionDoc && canClean && !regionDoc.data.locked && tool === "select" && step === "Typeset"}
          {@const skewing = drawing?.skew && drawing.regionId === selected.id ? drawing : null}
          {@const right = polygonEdgeHandle(selectedPolygon, "right")}
          {@const bottom = polygonEdgeHandle(selectedPolygon, "bottom")}
          <polygon
            points={`${right.x * page.width},${right.y * page.height - 8} ${right.x * page.width + 8},${right.y * page.height} ${right.x * page.width},${right.y * page.height + 8} ${right.x * page.width - 8},${right.y * page.height}`}
            fill="#62e5ce" stroke="#123e38" stroke-width="2"
            vector-effect="non-scaling-stroke" style="cursor: ns-resize"
            role="button" tabindex="0" aria-label="Skew placed text vertically"
            onpointerdown={(e) => startSkew("y", e)} onkeydown={(e) => skewKey("y", e)}
            onclick={(e) => e.stopPropagation()}>
            <title>Drag the right edge up or down to skew vertically. Arrow keys change 1°; Shift changes 15°.</title>
          </polygon>
          <polygon
            points={`${bottom.x * page.width - 8},${bottom.y * page.height} ${bottom.x * page.width},${bottom.y * page.height + 8} ${bottom.x * page.width + 8},${bottom.y * page.height} ${bottom.x * page.width},${bottom.y * page.height - 8}`}
            fill="#62e5ce" stroke="#123e38" stroke-width="2"
            vector-effect="non-scaling-stroke" style="cursor: ew-resize"
            role="button" tabindex="0" aria-label="Skew placed text horizontally"
            onpointerdown={(e) => startSkew("x", e)} onkeydown={(e) => skewKey("x", e)}
            onclick={(e) => e.stopPropagation()}>
            <title>Drag the bottom edge left or right to skew horizontally. Arrow keys change 1°; Shift changes 15°.</title>
          </polygon>
          {#if skewing}<text
            x={(skewing.skew!.axis === "x" ? bottom.x : right.x) * page.width}
            y={(skewing.skew!.axis === "x" ? bottom.y : right.y) * page.height + (skewing.skew!.axis === "x" ? 22 : 0)}
            fill="#62e5ce" text-anchor="middle" pointer-events="none">{skewing.skew!.axis === "x" ? "H" : "V"} {skewAngle(skewing)}°</text>{/if}
        {/if}
        {#if drawing && ["region", "read-area", "place-line", "rectangle"].includes(tool)}<rect
            x={Math.min(drawing.start.x, drawing.end.x) *
              page.width}
            y={Math.min(drawing.start.y, drawing.end.y) *
              page.height}
            width={Math.abs(drawing.start.x - drawing.end.x) *
              page.width}
            height={Math.abs(drawing.start.y - drawing.end.y) *
              page.height}
            fill="#5be1c733"
            stroke="#62e5ce"
            pointer-events="none"
          />{/if}
        {#if drawing && tool === "oval"}<ellipse
            cx={((drawing.start.x + drawing.end.x) / 2) * page.width}
            cy={((drawing.start.y + drawing.end.y) / 2) * page.height}
            rx={(Math.abs(drawing.end.x - drawing.start.x) / 2) * page.width}
            ry={(Math.abs(drawing.end.y - drawing.start.y) / 2) * page.height}
            fill="#5be1c733"
            stroke="#62e5ce"
            pointer-events="none"
          />{/if}
        {#if ovalGuides.length}
          <g class="construction-guides" pointer-events="none">
            {#each ovalGuides as guide}
              {#each ['guide-outline', 'guide-highlight'] as layer}
              {#if guide.axis === "h"}
                <line
                  class={layer}
                  x1="0"
                  y1={guide.at * page.height}
                  x2={page.width}
                  y2={guide.at * page.height}
                />
              {:else}
                <line
                  class={layer}
                  x1={guide.at * page.width}
                  y1="0"
                  x2={guide.at * page.width}
                  y2={page.height}
                />
              {/if}
              {/each}
            {/each}
          </g>
        {/if}
      </svg>
    </div>{:else}<p class="empty">
      Add images in Prepare to begin.
    </p>{/if}
</div>

<style>
  .canvas-scroll {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    scrollbar-gutter: stable;
    display: flex;
    background: var(--hud-canvas);
    padding: 18px 18px 64px;
  }
  .canvas-scroll.zoom-mode {
    overflow: hidden;
  }
  .canvas-page {
    position: relative;
    width: 100%;
    flex: none;
    margin: auto;
    box-shadow: 0 6px 30px rgba(0, 0, 0, 0.6);
    background: white;
    line-height: 0;
    -webkit-user-select: none;
    user-select: none;
  }
  .artwork {
    width: 100%;
    display: block;
  }
  .clone-preview {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }
  .canvas-page svg,
  .text-overlay {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    touch-action: none;
  }
  .canvas-page svg {
    overflow: visible;
  }
  .text-overlay {
    pointer-events: none;
  }
  .canvas-page svg .ignored {
    opacity: 0.35;
  }
  .flow-arrow {
    stroke-linecap: round;
  }
  .reorder-pick {
    filter: drop-shadow(0 0 4px #f0c14b88);
  }
  .region-label text {
    fill: #000;
    font: 600 10px Inter, system-ui, sans-serif;
  }
  .region-num text {
    fill: #000;
    font: 700 10.5px Inter, system-ui, sans-serif;
  }
  .region-error text {
    fill: #fff;
    font: 700 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .region-missing {
    filter: drop-shadow(0 1px 1px #0008);
  }
  .region-missing text {
    fill: #10161f;
    font: 700 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .reslice-cut {
    position: absolute;
    left: 0;
    width: 100%;
    border-top: 2px dashed #68dac5;
    pointer-events: none;
  }
  .reslice-cut.forced {
    border-top-color: #ff7050;
  }
  /* The preview stitches the surrounding pages, so label where each one starts and tint the
     band belonging to the page the operator actually opened the tool on. */
  .reslice-page-edge {
    position: absolute;
    left: 0;
    width: 100%;
    border-top: 1px solid rgba(104, 218, 197, 0.55);
    pointer-events: none;
  }
  .reslice-current-band {
    position: absolute;
    left: 0;
    width: 100%;
    background: rgba(104, 218, 197, 0.07);
    border-top: 1px solid rgba(104, 218, 197, 0.75);
    border-bottom: 1px solid rgba(104, 218, 197, 0.75);
    pointer-events: none;
  }
  .reslice-page-label {
    position: absolute;
    top: 0;
    left: 0;
    padding: 1px 6px;
    background: rgba(16, 22, 31, 0.85);
    color: #9fe9d8;
    font: 700 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .reslice-page-label.current {
    color: #10161f;
    background: #68dac5;
  }
  .reslice-hint {
    position: absolute;
    left: 8px;
    bottom: 8px;
    margin: 0;
    padding: 6px 8px;
    background: var(--hud-panel);
    font-size: 12px;
    pointer-events: none;
  }
  .zoom-tool,
  .zoom-tool :global(*) {
    cursor: zoom-in !important;
  }
  .brush-tool,
  .brush-tool :global(*) {
    cursor: none;
  }
  .click-tool,
  .click-tool :global(*) {
    cursor: crosshair;
  }
  .style-brush-tool,
  .style-brush-tool :global(*) {
    cursor: crosshair;
  }
  .construction-guides line {
    stroke-linecap: square;
    vector-effect: non-scaling-stroke;
  }
  .construction-guides .guide-outline { stroke: #10131a; stroke-width: 5; }
  .construction-guides .guide-highlight { stroke: #fff34d; stroke-width: 2; stroke-dasharray: 9 5; }
  .empty {
    padding: 35px;
    color: var(--hud-muted);
  }
</style>
