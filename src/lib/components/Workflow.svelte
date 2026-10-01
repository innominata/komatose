<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import "../../styles/editor.scss";
  import { effectiveTranslateModel, isSourceSuggestion, regionAiSettings, reviseCouncil, suggestionMatchesLine, type RegionAiSettings as RegionAiSettingsData } from "$lib/regionAi";
  import { DEFAULT_CHAT_MODEL_ID } from "$lib/modelDefaults";
  import { formatDuration, transcribeSetPageMs } from "$lib/modelEstimate";
  import { providerRunGate } from "$lib/providerCatalog";
  import { copyPngToClipboard } from '$lib/clipboardImage';
  import { lastProofreadPageId } from '$lib/pageProofread';
  import PageProofreadDialog from './PageProofreadDialog.svelte';
  import CleanPromptDialog from "./CleanPromptDialog.svelte";
  import RegionCompareDialog from "./workflow/RegionCompareDialog.svelte";
  import { CODEX_CLEAN_DIALOG, imageEditDialog, modelImageEditDialog } from "$lib/cleanPromptDialog";
  import type { TaskEngine } from "$lib/aiTasks";
  import type { DetectorDefaults, DetectorSetupConfig } from "$lib/detectorSetup";
  import { detectorSetupLabel } from "$lib/detectorSetup";
  import PageInspector from "./PageInspector.svelte";
  import SeriesTypeDialog from "./SeriesTypeDialog.svelte";
  import RegionAiDialog from "./RegionAiDialog.svelte";
  import ReviseEnglishDialog from "./ReviseEnglishDialog.svelte";
  import RegionAiSettings from "./RegionAiSettings.svelte";
  import RegionColorDialog from "./RegionColorDialog.svelte";
  import { type PaletteId } from "./ToolPalette.svelte";
  import JobsPanel from "./JobsPanel.svelte";
  import StudioToasts from "./workflow/StudioToasts.svelte";
  import StudioTopBar from "./workflow/StudioTopBar.svelte";
  import StageBar from "./workflow/StageBar.svelte";
  import StudioBanners from "./workflow/StudioBanners.svelte";
  import TranslationStatus from "./workflow/TranslationStatus.svelte";
  import ToolRail from "./workflow/ToolRail.svelte";
  import ToolOptionsBar from "./workflow/ToolOptionsBar.svelte";
  import ViewBar from "./workflow/ViewBar.svelte";
  import PageFooter from "./workflow/PageFooter.svelte";
  import ActionFinder from "./workflow/ActionFinder.svelte";
  import PrepareOrganize from "./workflow/PrepareOrganize.svelte";
  import StudioSettingsDrawer from "./workflow/StudioSettingsDrawer.svelte";
  import RegionContextMenu from "./workflow/RegionContextMenu.svelte";
  import PagesSidebar from "./workflow/PagesSidebar.svelte";
  import PrepareChapterPanel from "./workflow/PrepareChapterPanel.svelte";
  import TranslateChapterPanel from "./workflow/TranslateChapterPanel.svelte";
  import ExportPanel from "./workflow/ExportPanel.svelte";
  import TranslateInspector from "./workflow/TranslateInspector.svelte";
  import CleanInspector from "./workflow/CleanInspector.svelte";
  import TypesetInspector from "./workflow/TypesetInspector.svelte";
  import RegionGeometryPanel from "./workflow/RegionGeometryPanel.svelte";
  import WorkflowCanvas from "./workflow/WorkflowCanvas.svelte";
  import { draggedRotation, normalizeRotation } from "$lib/textRotation";
  import {
    clampSkew,
    cssDeltaTransform,
    draggedSkew,
    polygonEdgeHandle,
  } from "$lib/textTransform";
  import { pageWriteConflict } from "$lib/pageConflict";
  import { SaveQueue } from "$lib/saveQueue";
  import { chapterDraftKey, maskDraftKey as ownedMaskDraftKey } from "$lib/draftKeys";
  import { mergeRegionDoc } from "$lib/regionUpdates";
  import { PAGE_BRUSH_MAX, PAGE_BRUSH_MIN, brushDeltaFromWheel, nudgeBrush, usesBrushSize } from "$lib/brush";
  import { APP_NAME } from "$lib/brand";
  import { maskRegion } from "$lib/maskRegions";
  import {
    activeRegionKinds,
    parseColorMap,
    regionColor,
    regionKindLabel,
    regionKindUsage,
    type RegionKind,
  } from "$lib/regionCatalog";
  import { regionOval, regionRectangle, bubbleFitPoints } from "$lib/regionGeometry";
  import {
    chapterExceptions,
    exceptionCursorFromView,
    needsTranslationReview,
    nextException,
    nextTranslationReview,
    type ChapterException,
  } from "$lib/exceptions";
  import { STUDIO_STAGE_ORDER, studioStepName, type StudioAction } from "$lib/studioActions";
  import {
    pageStepStamp,
    exportBlockers,
    type PageStep,
    DEFAULT_PREFERENCES,
    deleteRegionNeedsConfirm,
    isBlankRegion,
    usesSourceArtwork,
    pageArtwork,
    pageRawArtwork,
    DEFAULT_STYLE,
    MASK_GROW_DEFAULT,
    styleDiff,
    type Preferences,
    type RegionData,
    type PageData,
    type WorkflowDoc,
    type FontAsset,
    type ReadinessIssue,
    type Point,
    type MaskStroke,
    type TextStyle,
  } from "$lib/workflow";
  import {
    type Series,
    type Episode,
    type ImageRow,
    type LineRow,
    type LineType,
    type TranslateEngineInfo,
    type PublicUser,
    isPageImageOnlyEngine,
  } from "$lib/types";
  import type { CreditKind, SeriesCredits } from "$lib/credits";
  let {
    series,
    episode,
    user,
    canEdit,
    canUpload,
    canClean,
    canRebuild = false,
    engines,
  }: {
    series: Series;
    episode: Episode;
    user: Pick<PublicUser, "id" | "role">;
    canEdit: boolean;
    canUpload: boolean;
    canClean: boolean;
    canRebuild?: boolean;
    engines: TranslateEngineInfo[];
  } = $props();
  type State = {
    images: ImageRow[];
    lines: LineRow[];
    comments: any[];
    pages: Record<string, WorkflowDoc<PageData>>;
    regions: Record<string, WorkflowDoc<RegionData>>;
    fonts: FontAsset[];
    preferences: Preferences;
    chapter: WorkflowDoc<Partial<Preferences>>;
    seriesDefaults: WorkflowDoc<Partial<Preferences>>;
    suggestions: any[];
    jobs: any[];
    issues: ReadinessIssue[];
    previewToken?: string | null;
    gpu?: { mode: string; label?: string; llm?: string; ocr?: string; cleaning?: string };
    credits?: SeriesCredits;
    detectorDefaults?: DetectorDefaults;
    detection?: { setup: DetectorSetupConfig; conf: number; source: "request" | "chapter" | "default"; skipped: string[] };
  };
  let studioState = $state<State | null>(null);
  const blankRegionCount = $derived(studioState?.lines.filter(line => isBlankRegion(line) &&
    !studioState?.suggestions.some(s => s.line_id === line.id && s.state === 'pending' && isSourceSuggestion(s.kind) && !suggestionMatchesLine(s, line))).length ?? 0);
  let actionsMenuEl = $state<HTMLDivElement>();
  let actionsSubmenuEl = $state<HTMLDivElement>();
  let step = $state("Prepare");
  const steps = [
    "Prepare",
    "Translate",
    "Review",
    "Clean",
    "Typeset",
    "Export",
  ];
  let scope = $state<"page" | "chapter">("page");
  let prepView = $state<"grid" | "page">("grid");
  let settingsSection = $state<string | null>(null);
  let modelsTab = $state("");
  let finderOpen = $state(false);
  let finderQuery = $state("");
  let inspectorTab = $state("");
  let detailTab = $state("suggestions");
  let stripFilter = $state<"all" | "todo" | "done">("all");
  let keysOpen = $state(false);
  let moreOpen = $state(false);
  let issuesOpen = $state(false);
  let pageId = $state("");
  let selectedPageIds = $state<string[]>([]);
  let pageSelectionAnchor = "";
  let extractedChapter = $state<{ id: string; title: string; pageCount: number } | null>(null);
  let lineId = $state("");
  let query = $state("");
  let unresolvedOnly = $state(false);
  let error = $state("");
  let toasts = $state<{ id: number; text: string }[]>([]);
  let toastSeq = 0;
  let openMenu = $state<null | "series" | "chapter" | "page" | "view">(null);
  let busy = $state(false);
  const pageSelectionBusy = $derived(busy || (studioState?.jobs.some(job =>
    ["queued", "running", "cancelling"].includes(job.state)) ?? false));
  let saveVersion = $state(0);
  let compare = $state(false);
  let showMask = $state(true);
  let showRegions = $state(true);
  let tool = $state("select");
  let reorderFromId = $state("");
  let radius = $state(8);
  let brushSizeOpen = $state(false);
  let growAmount = $state(MASK_GROW_DEFAULT);
  let growToolbarDismissed = $state(false);
  /** Temporary grow-amount toolbar, like the brush size one: shown while the grow tool is picked. */
  const growToolbarOpen = $derived(
    tool === "mask-grow" && step === "Clean" && canClean && !growToolbarDismissed,
  );
  let paletteAnchor = $state<HTMLDivElement | null>(null);
  let expansion = $state(5);
  let maskEngine = $state<string>("auto");
  let strokes = $state<MaskStroke[]>([]);
  let maskBaseRevision = $state<number | null>(null);
  let maskJobId = $state<string | null>(null);
  let refreshGen = 0;
  let jobsGen = 0;
  let chapterRevision = episode.revision ?? 0;
  let jobsAt = 0;
  let pendingClean = $state<{ method: string; imageId: string; prompt?: string } | null>(null);
  let polygonDraft = $state<Point[]>([]);
  let drawing = $state<{
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
  } | null>(null);
  let svgEl = $state<SVGSVGElement>();
  let canvasWidth = $state(0);
  let canvasScrollEl = $state<HTMLDivElement>();
  let regionStyle = $state<TextStyle>({ ...DEFAULT_STYLE });
  let styleBrush = $state<{ sourceId: string; style: TextStyle } | null>(null);
  const styleBrushQueue: { id: string; style: TextStyle }[] = [];
  let applyingStyleBrush = false;
  let styleFor = "";
  let styleRevision = 0;
  let engineOptions =
    $state<(TranslateEngineInfo & { reason?: string })[]>(engines);
  let engine = $state(engines.find((e) => e.available && !isPageImageOnlyEngine(e.id))?.id ?? DEFAULT_CHAT_MODEL_ID);
  let backend = $state<any>(null);
  let cloneX = $state(40);
  let cloneY = $state(0);
  let cloneSource = $state<Point | null>(null);
  let cloneOffset = $state<Point | null>(null);
  let cloneEpoch = $state(0);
  let blurEpoch = $state(0);
  let restoreEpoch = $state(0);
  let pendingFiles = $state<File[]>([]);
  let stitch = $state(false);
  let duplicateWarning = $state("");
  let jobsPanel = $state<"collapsed" | "shown" | "maximized">("collapsed");
  let jobsFlash = $state(0);
  let waitIntent = $state<"full" | "first" | null>(null);
  let firstTranslateSeen = $state(false);
  const WAIT_UNTIL_DONE = new Set(["clean", "mask", "transcribe", "region-ocr"]);
  const WAIT_UNTIL_FIRST_TRANSLATION = new Set(["selection", "translate", "source-translation"]);
  const JOB_LIVE = new Set(["running", "queued", "cancelling"]);
  const JOB_DONE = new Set(["completed", "failed", "cancelled", "interrupted"]);
  let lineRevSnapshot = new Map<string, number>();
  let waitStartedAt = 0;
  let lastJobsFlashAt = 0;
  let seenJobStates = new Map<string, string>();
  let jobsHydrated = false;
  let waitPtr = $state<{ x: number; y: number } | null>(null);
  let prevTranslateLive = 0;
  let reviewImageBusy = $state(false);
  let proofreadJobId = $state<string | null>(null);
  const proofreadJob = $derived(studioState?.jobs.find(job => job.id === proofreadJobId));
  let reslicePreview = $state<null | {
    preview: string;
    width: number;
    height: number;
    cuts: number[];
    forced: number[];
    imageIds: string[];
    /** Each stitched source page's band, so the canvas can label the boundaries. */
    pages: { id: string; number: number; top: number; height: number }[];
  }>(null);
  let previewCopied = $state(false);
  let pagesOpen = $state(false);
  let inspectorOpen = $state(false);
  let pagesWidth = $state(120);
  let inspectorWidth = $state(384);
  let studioEl = $state<HTMLDivElement>();
  let exportFormat = $state("png");
  let draftExport = $state(false);
  let includeExportMetadata = $state(false);
  let pendingExportDownload = $state<string | null>(null);
  const latestExport = $derived(
    studioState?.jobs.find((job) =>
      job.kind === "export" &&
      job.payload?.format === exportFormat &&
      !!job.payload?.draft === draftExport &&
      job.payload?.includeMetadata === includeExportMetadata,
    ),
  );
  let quality = $state(95);
  let aliases = $state("");
  let translationPrefs = $state("");
  let chapterDpi = $state("");
  let preferenceRevision = 0;
  function openTypeSettings() {
    openMenu = null;
    settingsSection = "typography";
  }
  function openRegionColors() {
    openMenu = null;
    settingsSection = "colors";
  }
  let userRegionColors = $state<Record<string, string>>({});
  let polygonRevision = 0;
  let mergeId = $state("");
  let splitAt = $state(1);
  let history = $state<any[]>([]);
  let boundsDetails = $state<HTMLElement>();
  let commentsDetails = $state<HTMLElement>();
  let commentText = $state(""),
    commentCorrection = $state(false),
    scriptText = $state("");
  let menu = $state<{
    x: number;
    y: number;
    imageId: string;
    lineId?: string;
  } | null>(null);
  let typeSubmenu = $state(false);
  let typeSubmenuPos = $state({ x: 0, y: 0 });
  let pageTool = $state("select");
  let prepElement = $state<HTMLDivElement>();
  let cropDraft = $state<{ start: Point; end: Point } | null>(null);
  let splitPosition = $state(0.5);
  let nudgeAmount = $state(10);
  let zoom = $state(100);
  let pageUndoCount = $state(0);
  let model = $state("");
  // With exactly one available translator, default to it instead of the
  // shipped chat-model default, which a fresh install cannot run yet.
  const aiModels = $derived.by(() => {
    const settings = regionAiSettings(studioState?.preferences.regionAi, { engine, model });
    return { ...settings, translate: effectiveTranslateModel(settings.translate, engineOptions) };
  });
  const translationModel = $derived(aiModels.translate);
  const translateGate = $derived(providerRunGate(aiModels.translate.engine, "translate", engineOptions));
  const enquireGate = $derived(providerRunGate(aiModels.enquire.engine, "advisory", engineOptions));
  const proofreadEnglishGate = $derived(providerRunGate(aiModels.proofread.engine, "proofreadEnglish", engineOptions));
  const translateLabel = $derived(
    `${engineOptions.find((en) => en.id === aiModels.translate.engine)?.label ?? aiModels.translate.engine}${aiModels.translate.model ? ` · ${aiModels.translate.model}` : ""}`,
  );
  const transcriptionLabel = $derived(
    (aiModels.transcriptionModels || [])
      .map((id) => engineOptions.find((en) => en.id === id)?.label ?? id)
      .join(" + ") || "no models selected",
  );
  const transcribeEstimate = $derived.by(() => {
    const ids = aiModels.transcriptionModels || [];
    const medians = ids.map((id) => {
      const row = engineOptions.find((en) => en.id === id) as
        | { estimates?: Record<string, { medianMs?: number; ms?: number }> }
        | undefined;
      return row?.estimates?.vision?.medianMs ?? row?.estimates?.vision?.ms;
    });
    if (!ids.length || medians.some((ms) => ms == null)) return "";
    return formatDuration(transcribeSetPageMs(medians as number[], 8));
  });
  async function saveRegionAi(regionAi: RegionAiSettingsData) {
    if (!studioState) return false;
    const result = await act({
      action: "preferences",
      scope: "series",
      expectedRevision: studioState.seriesDefaults.revision,
      data: { regionAi },
    });
    if (!result?.doc) throw new Error(error || "Could not save.");
    regionAiDialog.setReviewers(regionAi.reviewers);
    const saved = regionAiSettings(regionAi, { engine, model });
    reviseEnglishDialog?.setCouncil(
      reviseCouncil({ ...saved, translate: effectiveTranslateModel(saved.translate, engineOptions) }),
    );
    return true;
  }
  async function saveTranslationModel(next: TaskEngine) {
    if (!studioState || busy || !canEdit) return;
    await saveRegionAi({ ...aiModels, translate: { ...next } });
  }
  async function saveEnquireModel(next: TaskEngine) {
    if (!studioState || busy || !canEdit) return;
    await saveRegionAi({ ...aiModels, enquire: { ...next } });
  }
  let regionAiDialog: RegionAiDialog;
  let regionColorDialog: RegionColorDialog;
  let reviseEnglishDialog: ReviseEnglishDialog;
  let regionAiSettingsDialog: RegionAiSettings;
  let cleanPromptDialog: CleanPromptDialog;
  let regionCompareDialog: RegionCompareDialog;
  /** Raw-vs-cleaned flipbook for one region; the letterer saves or links the image themselves. */
  async function openRegionCompare(line: LineRow) {
    menu = null;
    if (busy) return;
    const id = line.id;
    const ordinal = pageLines.findIndex((l) => l.id === id);
    const regionNumber = ordinal >= 0 ? ordinal + 1 : null;
    const pageName = page?.pageNumber ? `page ${page.pageNumber}` : "page";
    try {
      if (!(await saves.flushAll())) throw new Error("Resolve unsaved drafts first");
    } catch (e) {
      error = String(e);
      return;
    }
    const fresh = studioState?.lines.find((l) => l.id === id) ?? line;
    // The page revision also busts the image cache, so re-opening after another pass refetches.
    const source =
      `${apiBase}/region-ai?lineId=${encodeURIComponent(id)}` +
      `&revision=${fresh.revision ?? 0}&variant=comparison&page=${pageDoc?.revision ?? 0}`;
    void regionCompareDialog.open({
      title: `Raw vs cleaned · ${pageName}, region ${regionNumber ?? "?"}`,
      apngSrc: source,
      gifSrc: `${source}&format=gif`,
      downloadName: `${pageName.replace(" ", "-")}-region-${regionNumber ?? "x"}-raw-vs-clean`,
    });
  }
  function openRegionAi(line: LineRow, mode: "review" | "enquire") {
    menu = null;
    void regionAiDialog.open(line, mode, aiModels.reviewers);
  }
  function openReviseEnglish(line: LineRow) {
    menu = null;
    void reviseEnglishDialog.open(line, reviseCouncil(aiModels));
  }
  async function prepareRegionAi(id: string) {
    if (!(await saves.flushAll())) throw new Error("Resolve unsaved drafts first");
    await refresh();
    const line = studioState?.lines.find(l => l.id === id);
    if (!line) throw new Error("Region no longer exists");
    return line;
  }
  let importInput = $state<HTMLInputElement>();
  let replacementInput = $state<HTMLInputElement>();
  let insertPosition = $state<{ beforeId?: string; afterId?: string }>({});
  let replacementId = "";
  let seriesTerms = $state(series.glossary ?? []);
  async function openActions(
    event: MouseEvent,
    imageId: string,
    targetLine?: string,
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (pageId !== imageId) choosePage(imageId);
    if (targetLine) selectLine(targetLine);
    typeSubmenu = false;
    typeSubmenuPos = { x: 0, y: 0 };
    menu = {
      x: event.clientX,
      y: event.clientY,
      imageId,
      lineId: targetLine,
    };
    await tick();
    if (menu && actionsMenuEl) {
      const rect = actionsMenuEl.getBoundingClientRect();
      menu.x = Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8));
      menu.y = Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8));
    }
  }
  async function openTypeSubmenu(el: HTMLElement) {
    typeSubmenu = true;
    await tick();
    if (!typeSubmenu || !actionsSubmenuEl) return;
    const rect = el.getBoundingClientRect();
    const { width, height } = actionsSubmenuEl.getBoundingClientRect();
    let x = rect.right - 2;
    let y = rect.top - 4;
    if (x + width > window.innerWidth - 8) x = rect.left - width + 2;
    if (y + height > window.innerHeight - 8)
      y = Math.max(8, window.innerHeight - height - 8);
    typeSubmenuPos = { x: Math.max(8, x), y };
  }
  async function regionDetails(line: LineRow, comments = false) {
    selectLine(line.id);
    step = "Translate";
    menu = null;
    detailTab = comments ? "comments" : "details";
    await tick();
    const panel = comments ? commentsDetails : boundsDetails;
    panel?.scrollIntoView({ block: "nearest" });
  }
  async function pageOperation(body: Record<string, unknown>) {
    menu = null;
    busy = true;
    error = "";
    try {
      if (!(await saves.flushAll()))
        throw new Error("Resolve unsaved drafts first");
      const result = await request(`${apiBase}/pages`, body);
      await refresh();
      pageUndoCount = (await request(`${apiBase}/pages`)).undoCount;
      if (result.skipped?.length)
        notify(`${result.skipped.length} pages had no clear gutter. Select Split and click the desired cut on a page.`);
      if (body.op === "add-credits")
        notify(
          result.added
            ? `Added ${result.added} credits page${result.added === 1 ? "" : "s"}.`
            : "Credits already in this chapter.",
        );
      return result;
    } catch (e) {
      error = String(e);
      return null;
    } finally {
      busy = false;
    }
  }
  async function describe(ids?: string[], overwrite = false) {
    menu = null;
    error = "";
    try {
      if (!(await saves.flushAll()))
        throw new Error("Resolve unsaved drafts first");
      await request(`${apiBase}/pages`, {
        op: "describe",
        imageIds: ids,
        overwrite,
        engine: aiModels.describe.engine,
        model: aiModels.describe.model || undefined,
      });
      flashJobs();
      await refresh();
      notify("Scene description started.");
    } catch (e) {
      error = String(e);
    }
  }
  async function rereadMissing(imageId?: string) {
    busy = true;
    error = "";
    try {
      if (!(await saves.flushAll())) throw new Error("Resolve unsaved drafts first");
      const result = await request(`${apiBase}/ai-translate`, {
        action: "reread-missing", imageId, engine: aiModels.vision.engine, model: aiModels.vision.model || undefined,
        lang: studioState!.preferences.lang,
      });
      flashJobs();
      notify(`Rereading ${result.total} segments. ${result.skipped} segments without image bounds skipped.`);
      await refresh();
    } catch (e) { error = String(e); }
    finally { busy = false; }
  }
  async function fillMissing(imageId?: string) {
    busy = true;
    error = "";
    try {
      if (!(await saves.flushAll())) throw new Error("Resolve unsaved drafts first");
      const result = await request(`${apiBase}/ai-translate`, {
        action: "fill-missing", imageId, engine: aiModels.translate.engine, model: aiModels.translate.model || undefined,
        lang: studioState!.preferences.lang,
      });
      flashJobs();
      notify(`Filling ${result.sources} missing sources, ${result.english} empty English drafts, and ${result.suggestions} suggestion translations.`);
      await refresh();
    } catch (e) { error = String(e); }
    finally { busy = false; }
  }
  async function reread(line: LineRow) {
    menu = null;
    error = "";
    try {
      if (!(await saves.flushAll()))
        throw new Error("Resolve unsaved drafts first");
      const current = studioState!.lines.find((l) => l.id === line.id)!;
      await request(`${apiBase}/ai-translate`, {
        imageId: current.imageId,
        lineId: current.id,
        expectedRevision: current.revision,
        x: current.x,
        y: current.y,
        w: current.w,
        h: current.h,
        engine: aiModels.vision.engine,
        model: aiModels.vision.model || undefined,
        lang: studioState!.preferences.lang,
        forceVision: true,
      });
      notify(
        "Image-model reread queued. This region will be updated as a draft; concurrent edits are preserved.",
      );
      await refresh();
    } catch (e) {
      error = String(e);
    }
  }
  async function suggestAlternative(line: LineRow) {
    if (!canEdit || busy || aiRunning) return;
    if (!translateGate.ok) {
      error = translateGate.reason;
      return;
    }
    if (aiModels.enquire.engine && !enquireGate.ok) {
      error = enquireGate.reason;
      return;
    }
    menu = null;
    error = "";
    try {
      if (!(await saves.flushAll()))
        throw new Error("Resolve unsaved drafts first");
      const current = studioState!.lines.find((l) => l.id === line.id)!;
      await request(`${apiBase}/ai-translate`, {
        action: "suggest-alternatives",
        lineId: current.id,
        expectedRevision: current.revision,
        engine: aiModels.translate.engine,
        model: aiModels.translate.model || undefined,
        lang: studioState!.preferences.lang,
      });
      flashJobs();
      notify(
        "Re-translating this line, then asking the Enquire model for localized alternatives. Existing wording stays until you accept one.",
      );
      await refresh();
    } catch (e) {
      error = String(e);
    }
  }
  async function transcribePage(id: string) {
    if (busy || aiRunning) return;
    beginJobFeedback("transcribe");
    busy = true;
    menu = null;
    error = "";
    try {
      if (!(await saves.flushAll()))
        throw new Error("Resolve unsaved drafts first");
      await request(`${apiBase}/ai-transcribe`, {
        imageIds: [id],
        lang: studioState!.preferences.lang,
      });
      await refresh();
      notify("Transcription started. Agreed readings fill source and English. Other readings stay as suggestions.");
    } catch (e) {
      endJobIntent();
      error = String(e);
    } finally {
      busy = false;
    }
  }
  async function copyPageImage(variant: 'raw' | 'typeset') {
    if (!page || reviewImageBusy) return;
    const imageId = page.id;
    reviewImageBusy = true;
    error = '';
    try {
      await copyPngToClipboard(async () => {
        if (!(await saves.flushAll())) throw new Error('Resolve unsaved drafts first');
        const response = await fetch(`${apiBase}/images/${imageId}/review-image?variant=${variant}`, { cache: 'no-store' });
        if (!response.ok) throw new Error((await response.json()).error || 'Could not render page');
        return response.blob();
      });
      notify(`${variant === 'raw' ? 'Raw' : 'Typeset'} page image copied.`);
    } catch (e) { error = String(e); }
    finally { reviewImageBusy = false; }
  }
  async function proofreadPageImages() {
    if (!page || reviewImageBusy || !canEdit) return;
    const imageId = page.id;
    reviewImageBusy = true;
    error = '';
    try {
      if (!(await saves.flushAll())) throw new Error('Resolve unsaved drafts first');
      const existing = studioState?.jobs.find(job => job.kind === 'page-proofread' && job.payload?.imageId === imageId &&
        ['running', 'queued', 'cancelling'].includes(job.state));
      if (existing) proofreadJobId = existing.id;
      else {
        const result = await request(`${apiBase}/page-proofread`, { imageId, model: aiModels.proofread });
        proofreadJobId = result.jobId;
      }
      await refresh();
      notify('The proofreader response will be saved in Jobs. You can close the modal and keep editing.');
    } catch (e) { error = String(e); }
    finally { reviewImageBusy = false; }
  }
  async function translatePage(id: string) {
    if (busy || aiRunning) return;
    if (!translateGate.ok) {
      error = translateGate.reason;
      return;
    }
    beginJobFeedback("translate");
    busy = true;
    menu = null;
    error = "";
    try {
      if (!(await saves.flushAll()))
        throw new Error("Resolve unsaved drafts first");
      await request(`${apiBase}/ai-translate`, {
        imageIds: [id],
        engine: aiModels.translate.engine,
        model: aiModels.translate.model || undefined,
        lang: studioState!.preferences.lang,
      });
      await refresh();
    } catch (e) {
      endJobIntent();
      error = String(e);
    } finally {
      busy = false;
    }
  }
  async function deletePage(id: string) {
    menu = null;
    if (!window.confirm("Delete this page and its regions?")) return;
    try {
      await request(`${apiBase}/images/${id}`, {}, "DELETE");
      await refresh();
    } catch (e) {
      error = String(e);
    }
  }
  function selectPageThumbnail(id: string, range: boolean) {
    if (pageSelectionBusy || !studioState) return;
    const ordered = studioState.images.map(image => image.id);
    const anchor = ordered.indexOf(pageSelectionAnchor);
    const target = ordered.indexOf(id);
    if (target < 0) return;
    const selected = new Set(selectedPageIds);
    if (range && anchor >= 0) {
      for (const page of ordered.slice(Math.min(anchor, target), Math.max(anchor, target) + 1)) selected.add(page);
    } else {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      pageSelectionAnchor = id;
    }
    selectedPageIds = ordered.filter(page => selected.has(page));
    menu = null;
  }
  async function deleteSelectedPages() {
    if (!selectedPageIds.length || pageSelectionBusy) return;
    const ids = [...selectedPageIds];
    if (!window.confirm(`Delete ${ids.length} selected page${ids.length === 1 ? "" : "s"} and all their regions, comments, cleaning and typesetting? This cannot be undone.`)) return;
    const result = await pageOperation({ op: "delete", imageIds: ids });
    if (result) {
      selectedPageIds = [];
      pageSelectionAnchor = "";
      lineId = "";
      for (const id of ids) localStorage.removeItem(maskDraftKey(id));
      choosePage(pageId);
      notify(`Deleted ${result.deletedIds.length} pages.`);
    }
  }
  async function extractSelectedPages() {
    if (!selectedPageIds.length || pageSelectionBusy) return;
    const chapterNumber = window.prompt(`Copy ${selectedPageIds.length} selected pages to a new chapter. The originals will stay here.\n\nChapter number (for example, 12 or 12.5):`);
    if (chapterNumber === null) return;
    const result = await pageOperation({ op: "extract", imageIds: [...selectedPageIds], chapterNumber });
    if (result) {
      extractedChapter = result.chapter;
      selectedPageIds = [];
      pageSelectionAnchor = "";
      notify(`Copied ${result.chapter.pageCount} pages to chapter ${result.chapter.title}.`);
    }
  }
  async function deleteRegion(line: LineRow, confirm = true) {
    menu = null;
    if (
      confirm &&
      !window.confirm(
        "Delete this region? Its text remains in revision history.",
      )
    )
      return;
    try {
      await saves.flush(line.id);
      if (saves.drafts.has(line.id))
        throw new Error("Resolve this draft first");
      await request(`${apiBase}/lines/${line.id}`, {}, "DELETE");
      saves.discard(line.id);
      if (lineId === line.id) lineId = "";
      await refresh();
    } catch (e) {
      error = String(e);
    }
  }
  async function removePageRegions() {
    if (!page || !canEdit || busy) return;
    const count = pageLines.length;
    if (!count) return;
    if (!window.confirm(`Remove all ${count} region${count === 1 ? "" : "s"} on this page? Their text remains in revision history.`))
      return;
    const result = await act({ action: "remove-page-regions", imageId: page.id });
    if (result) {
      for (const id of result.ids ?? []) saves.discard(id);
      if (!studioState?.lines.some((line) => line.id === lineId)) lineId = "";
      notify(`Removed ${result.removed} region${result.removed === 1 ? "" : "s"}.`);
    }
  }
  async function removeBlankRegions() {
    if (!canEdit || busy || aiRunning || !blankRegionCount) return;
    if (!window.confirm(`Remove all ${blankRegionCount} blank regions in this chapter? Only regions with no source or English text will be removed.`)) return;
    const result = await act({ action: "remove-blank-regions" });
    if (result) {
      if (!studioState?.lines.some((line) => line.id === lineId)) lineId = "";
      notify(`Removed ${result.removed} blank region${result.removed === 1 ? "" : "s"}.`);
    }
  }
  async function addComment() {
    if (!selected || !commentText.trim()) return;
    try {
      await request(`${apiBase}/comments`, {
        lineId: selected.id,
        body: commentText,
        correction: commentCorrection,
      });
      commentText = "";
      await refresh();
    } catch (e) {
      error = String(e);
    }
  }
  async function importScript() {
    try {
      if (!(await saves.flushAll()))
        throw new Error("Resolve unsaved drafts first");
      await request(`${apiBase}/import`, { text: scriptText });
      scriptText = "";
      await refresh();
      notify(
        "Script imported. Assign unplaced lines to pages, then draw their text boxes.",
      );
    } catch (e) {
      error = String(e);
    }
  }
  function caption(text: string) {
    if (!page) return;
    saves.queue(
      `caption:${page.id}`,
      { caption: text },
      page.captionRevision ?? 0,
    );
    if (studioState)
      studioState.images = studioState.images.map((p) =>
        p.id === page!.id ? { ...p, caption: text } : p,
      );
  }
  function prepPoint(e: PointerEvent): Point {
    const b = prepElement!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)),
      y: Math.max(0, Math.min(1, (e.clientY - b.top) / b.height)),
    };
  }
  function prepDown(e: PointerEvent) {
    if (e.button !== 0 || busy) return;
    if (zooming) {
      nudgeZoom(e.altKey ? -1 : 1);
      return;
    }
    if (!canUpload) return;
    const point = prepPoint(e);
    if (pageTool === "split") {
      void pageOperation({
        op: "split",
        imageId: page!.id,
        force: true,
        at: point.x,
      });
      return;
    }
    if (pageTool === "reslice" && reslicePreview) {
      const y = Math.round(point.y * reslicePreview.height);
      const near = reslicePreview.cuts.find(
        (c) => Math.abs(c - y) < Math.max(8, reslicePreview!.height * 0.008),
      );
      reslicePreview = {
        ...reslicePreview,
        cuts: near != null
          ? reslicePreview.cuts.filter((c) => c !== near)
          : [...reslicePreview.cuts, y].sort((a, b) => a - b),
      };
      return;
    }
    if (pageTool === "crop") {
      prepElement!.setPointerCapture(e.pointerId);
      cropDraft = { start: point, end: point };
    }
  }
  async function prepUp() {
    if (!cropDraft || !page) return;
    const { start, end } = cropDraft;
    cropDraft = null;
    const x = Math.min(start.x, end.x) * page.width,
      y = Math.min(start.y, end.y) * page.height,
      w = Math.abs(start.x - end.x) * page.width,
      h = Math.abs(start.y - end.y) * page.height;
    if (w >= 16 && h >= 16)
      await pageOperation({ op: "crop", imageId: page.id, x, y, w, h });
  }
  async function replaceFile(file?: File) {
    if (!file) return;
    busy = true;
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`${apiBase}/images/${replacementId}`, {
        method: "PUT",
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await refresh();
      pageUndoCount = (await request(`${apiBase}/pages`)).undoCount;
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
  function insertAt(id: string, before: boolean) {
    menu = null;
    insertPosition = before ? { beforeId: id } : { afterId: id };
    importInput?.click();
  }

  const apiBase = `/api/episodes/${episode.id}`;
  const page = $derived(
    studioState?.images.find((p) => p.id === pageId) ?? studioState?.images[0],
  );
  const regionLabelScale = $derived(page && canvasWidth > 0 ? page.width / canvasWidth : 1);
  const pageDoc = $derived(page ? studioState?.pages[page.id] : undefined);
  const canRestore = $derived(
    !!pageDoc?.data.previousArtwork &&
      pageDoc.data.previousArtwork !== pageArtwork(pageDoc.data),
  );
  const canPaintRaw = $derived(!!pageRawArtwork(pageDoc?.data ?? {}));
  const selected = $derived(studioState?.lines.find((l) => l.id === lineId));
  const regionDoc = $derived(
    selected ? studioState?.regions[selected.id] : undefined,
  );
  const historyStep = $derived<PageStep | null>(
    step === "Review" ? "review" : step === "Clean" ? "clean" : step === "Typeset" ? "typeset" : step === "Translate" ? "translate" : null,
  );
  const pageLines = $derived(
    (studioState?.lines.filter((l) => l.imageId === page?.id) ?? []).sort(
      (a, b) => a.sortOrder - b.sortOrder,
    ),
  );
  const pageMarkedComplete = $derived.by(() => {
    if (!historyStep || !page || !pageDoc || !studioState) return false;
    const comments = (studioState.comments ?? []).filter((comment: { lineId?: string }) =>
      pageLines.some((line) => line.id === comment.lineId),
    );
    const regions = pageLines.map((line) => ({ id: line.id, data: studioState?.regions[line.id]?.data }));
    return pageDoc.data.completed?.[historyStep] === pageStepStamp(historyStep, pageDoc.data, pageLines, comments, regions);
  });
  const hasMaskRegions = $derived(pageLines.some((line) =>
    maskRegion(line, studioState?.regions[line.id]?.data).length >= 3));
  const visibleLines = $derived(
    pageLines.filter(
      (l) =>
        (!query ||
          `${l.source} ${l.body}`
            .toLowerCase()
            .includes(query.toLowerCase())) &&
        (!unresolvedOnly ||
          (l.status !== "approved" && l.sourceState !== "ignored")),
    ),
  );
  const jobPulse = $derived.by(() => {
    const jobs = studioState?.jobs ?? [];
    return {
      running: jobs.filter((j: any) =>
        ["running", "queued"].includes(j.state),
      ).length,
      failed: jobs.filter((j: any) => j.state === "failed").length,
    };
  });
  const waitFullJobs = $derived(
    (studioState?.jobs ?? []).filter(
      (j: any) => WAIT_UNTIL_DONE.has(j.kind) && JOB_LIVE.has(j.state),
    ),
  );
  const translateWaitJobs = $derived(
    (studioState?.jobs ?? []).filter(
      (j: any) =>
        WAIT_UNTIL_FIRST_TRANSLATION.has(j.kind) &&
        ["running", "queued"].includes(j.state),
    ),
  );
  const waitCursor = $derived(
    waitIntent === "full" ||
      waitFullJobs.length > 0 ||
      !!pendingClean ||
      ((waitIntent === "first" || translateWaitJobs.length > 0) && !firstTranslateSeen),
  );
  function onWaitPointer(e: PointerEvent) {
    waitPtr = { x: e.clientX, y: e.clientY };
  }
  function flashJobs() {
    const now = Date.now();
    if (now - lastJobsFlashAt < 350) return;
    lastJobsFlashAt = now;
    jobsFlash += 1;
  }
  function snapshotLineRevisions() {
    lineRevSnapshot = new Map(
      (studioState?.lines ?? []).map((l) => [l.id, l.revision ?? 0]),
    );
    waitStartedAt = Date.now();
  }
  function armFirstTranslateWait() {
    if (firstTranslateSeen && translateWaitJobs.length) return;
    if (!translateWaitJobs.length || !waitStartedAt) {
      firstTranslateSeen = false;
      snapshotLineRevisions();
    }
    waitIntent = "first";
  }
  function beginJobFeedback(kind?: string) {
    flashJobs();
    if (!kind) return;
    waitStartedAt = Date.now();
    if (WAIT_UNTIL_DONE.has(kind)) waitIntent = "full";
    else if (WAIT_UNTIL_FIRST_TRANSLATION.has(kind)) armFirstTranslateWait();
  }
  function endJobIntent() {
    waitIntent = null;
  }
  $effect(() => {
    const jobs = studioState?.jobs ?? [];
    if (!jobsHydrated) {
      seenJobStates = new Map(jobs.map((j: any) => [j.id, j.state]));
      jobsHydrated = studioState != null;
      if (translateWaitJobs.length) firstTranslateSeen = true;
      prevTranslateLive = translateWaitJobs.length;
      return;
    }
    const started = jobs.filter((j: any) => {
      if (!["running", "queued"].includes(j.state)) return false;
      const prev = seenJobStates.get(j.id);
      return prev == null || !JOB_LIVE.has(prev);
    });
    if (started.length) {
      flashJobs();
      for (const j of started) {
        if (WAIT_UNTIL_DONE.has(j.kind)) waitIntent = "full";
        else if (WAIT_UNTIL_FIRST_TRANSLATION.has(j.kind)) armFirstTranslateWait();
      }
    }
    for (const job of jobs) {
      const prev = seenJobStates.get(job.id);
      if (job.state !== "cancelled" || !prev || !JOB_LIVE.has(prev)) continue;
      const counts = job.progress?.total != null ? ` ${job.progress.completed ?? 0}/${job.progress.total}` : "";
      notify(`${job.kind} cancelled${counts}.`);
    }
    const justFinished = jobs.some((j: any) => {
      if (!WAIT_UNTIL_DONE.has(j.kind) || !JOB_DONE.has(j.state)) return false;
      const prev = seenJobStates.get(j.id);
      return prev == null || JOB_LIVE.has(prev);
    });
    if (waitIntent === "full" && !waitFullJobs.length && justFinished) waitIntent = null;
    if (waitIntent === "first" && translateWaitJobs.length) waitIntent = null;
    const n = translateWaitJobs.length;
    if (n === 0 && prevTranslateLive > 0) {
      firstTranslateSeen = false;
      waitStartedAt = 0;
    }
    prevTranslateLive = n;
    seenJobStates = new Map(jobs.map((j: any) => [j.id, j.state]));
  });
  $effect(() => {
    if (firstTranslateSeen) return;
    const waiting = waitIntent === "first" || translateWaitJobs.length > 0;
    if (!waiting) return;
    const lines = studioState?.lines ?? [];
    const lineChanged = lines.some((l) => {
      const prev = lineRevSnapshot.get(l.id);
      if (prev == null) return (l.revision ?? 0) > 0 && !!l.body?.trim();
      return (l.revision ?? 0) > prev;
    });
    const jobFinished = (studioState?.jobs ?? []).some(
      (j: any) =>
        WAIT_UNTIL_FIRST_TRANSLATION.has(j.kind) &&
        JOB_DONE.has(j.state) &&
        (j.updated_at ?? 0) >= waitStartedAt,
    );
    if (!lineChanged && !jobFinished) return;
    firstTranslateSeen = true;
    if (waitIntent === "first") waitIntent = null;
    if (translateWaitJobs.length) flashJobs();
  });
  function jobPageLabel(job: any) {
    const imageId =
      job.payload?.imageId ||
      job.payload?.request?.imageId ||
      job.pages?.[0]?.image_id;
    if (!imageId) return "";
    const img = studioState?.images.find((p) => p.id === imageId);
    const page = img?.pageNumber ?? "—";
    const method = job.payload?.method ? ` · ${job.payload.method}` : "";
    return `Page ${page}${method}`;
  }
  const asset = (hash?: string) =>
    hash ? `${apiBase}/workflow/assets/${hash}` : "";
  const hasTypesetCopy = $derived(
    pageLines.some(
      (line) =>
        line.sourceState !== "ignored" &&
        !!studioState?.regions[line.id]?.data.layout,
    ),
  );
  const showSourceArtwork = $derived(
    usesSourceArtwork(step, compare, hasTypesetCopy),
  );
  const pageImage = $derived(
    page
      ? (pageDoc?.data.preparedAt !== page.updatedAt
          ? `/api/images/${page.id}?v=${page.updatedAt}`
          : showSourceArtwork
            ? asset(pageDoc?.data.prepared)
            : asset(pageDoc?.data.cleaned || pageDoc?.data.cleanBase || pageDoc?.data.prepared)) ||
          `/api/images/${page.id}?v=${page.updatedAt}`
      : "",
  );
  const selectedPolygon = $derived(
    regionDoc?.data.polygon?.length
      ? regionDoc.data.polygon
      : selected
        ? regionRectangle(selected)
        : [],
  );
  const drafts = $derived.by(() => {
    void saveVersion;
    return [...saves.drafts];
  });
  const saves = new SaveQueue(
    chapterDraftKey(user.id, episode.id),
    async (id, d) => {
      const commentId = id.startsWith("comment:") ? id.slice(8) : null;
      const captionId = id.startsWith("caption:") ? id.slice(8) : null;
      const res = await fetch(
        commentId
          ? `${apiBase}/comments/${commentId}`
          : captionId
            ? `${apiBase}/pages`
            : `${apiBase}/lines/${id}`,
        {
          method: captionId ? "POST" : "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...d.patch,
            ...(!commentId && !captionId && "body" in d.patch &&
              ["Clean", "Translate", "Review", "Typeset"].includes(step) ? { refit: true } : {}),
            ...(captionId ? { op: "caption", imageId: captionId } : {}),
            expectedRevision: d.revision,
          }),
          keepalive: true,
        },
      );
      const data = await res.json();
      if (!res.ok)
        throw Object.assign(new Error(data.error), { current: data.current });
      if (commentId) {
        if (studioState)
          studioState.comments = studioState.comments.map((c) =>
            c.id === commentId
              ? { ...data.comment, ...saves.drafts.get(id)?.patch }
              : c,
          );
        return { revision: data.comment.revision };
      }
      if (captionId) {
        if (studioState)
          studioState.images = studioState.images.map((p) =>
            p.id === captionId
              ? { ...data.image, ...saves.drafts.get(id)?.patch }
              : p,
          );
        return { revision: data.image.captionRevision };
      }
      if (studioState)
        studioState.lines = studioState.lines.map((l) =>
          l.id === id ? { ...data.line, ...saves.drafts.get(id)?.patch } : l,
        );
      if (data.doc) {
        applyRegionDoc(data.doc);
        if (selected?.id === id) {
          styleRevision = data.doc.revision;
          regionStyle = { ...inheritedStyle(data.line.lineType), ...data.doc.data.style };
        }
      }
      return { revision: data.line.revision };
    },
    () => {
      saveVersion += 1;
    },
  );
  async function request(path: string, body?: unknown, method = "POST", signal?: AbortSignal) {
    const res = await fetch(path, {
      signal,
      method: body === undefined ? "GET" : method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await res.json();
    if (!res.ok)
      throw Object.assign(new Error(data.error || "Request failed"), {
        status: res.status,
        current: data.current,
      });
    return data;
  }
  let backendRecheckTimers: ReturnType<typeof setTimeout>[] = [];
  async function loadBackend() {
    try {
      backend = await request(`${apiBase}/workflow?backend=1`);
      return backend;
    } catch (e) {
      error = String(e);
      return null;
    }
  }
  /** Big-LaMa loads on startup, so the first probe can land before it is
   *  resident. Re-check at 5s and 10s until it reports available. */
  function recheckBackendWhenUnavailable() {
    for (const timer of backendRecheckTimers) clearTimeout(timer);
    backendRecheckTimers = [5000, 10000].map((delay) =>
      setTimeout(() => {
        if (!backend?.bigLama) void loadBackend();
      }, delay),
    );
  }
  function maskDraftKey(imageId = pageId) {
    return ownedMaskDraftKey(user.id, episode.id, imageId);
  }
  function persistMaskDraft(imageId = pageId, revision = pageDoc?.revision ?? maskBaseRevision) {
    if (!imageId) return;
    if (!strokes.length) {
      localStorage.removeItem(maskDraftKey(imageId));
      return;
    }
    localStorage.setItem(
      maskDraftKey(imageId),
      JSON.stringify({ strokes, revision }),
    );
  }
  function adoptPageDoc(imageId: string, doc: WorkflowDoc<PageData>) {
    if (studioState) studioState.pages[imageId] = doc;
    if (strokes.length) {
      maskBaseRevision = doc.revision;
      persistMaskDraft(imageId, doc.revision);
    } else {
      maskBaseRevision = null;
    }
  }
  function noteMaskCompletion(jobs: { id: string; state: string; payload?: { request?: { strokes?: unknown } } }[]) {
    if (!maskJobId) return;
    const j = jobs.find((job) => job.id === maskJobId);
    if (
      j?.state === "completed" &&
      JSON.stringify(j.payload?.request?.strokes) === JSON.stringify(strokes)
    ) {
      strokes = [];
      maskBaseRevision = null;
      localStorage.removeItem(maskDraftKey());
      maskJobId = null;
    }
  }
  function rememberPoll(data: { revision?: number; jobsAt?: number }) {
    if (Number.isInteger(data.revision)) chapterRevision = data.revision!;
    if (Number.isInteger(data.jobsAt)) jobsAt = data.jobsAt!;
  }
  async function refreshJobs() {
    const gen = ++jobsGen;
    const data = await request(
      `${apiBase}/workflow?jobs=1&revision=${chapterRevision}&jobsAt=${jobsAt}`,
    );
    if (gen !== jobsGen || !studioState) return;
    if (data.unchanged) return;
    if ((data.revision ?? 0) !== chapterRevision) {
      await refresh();
      return;
    }
    rememberPoll(data);
    noteMaskCompletion(data.jobs ?? []);
    studioState.jobs = data.jobs ?? [];
  }
  async function refresh() {
    const gen = ++refreshGen;
    const data = await request(`${apiBase}/workflow`);
    if (gen !== refreshGen) return;
    rememberPoll(data);
    noteMaskCompletion(data.jobs ?? []);
    data.lines = data.lines.map((l: LineRow) => ({
      ...l,
      ...saves.drafts.get(l.id)?.patch,
    }));
    data.comments = (data.comments ?? []).map((c: any) => ({
      ...c,
      ...saves.drafts.get(`comment:${c.id}`)?.patch,
    }));
    data.images = data.images.map((p: ImageRow) => ({
      ...p,
      ...saves.drafts.get(`caption:${p.id}`)?.patch,
    }));
    studioState = data;
    selectedPageIds = selectedPageIds.filter(id => data.images.some((image: ImageRow) => image.id === id));
    if (!pageId || !data.images.some((p: ImageRow) => p.id === pageId))
      pageId = data.images[0]?.id ?? "";
    tryPendingClean();
  }
  function applyRegionDoc(doc: WorkflowDoc<RegionData>) {
    if (!studioState) return;
    const regions = mergeRegionDoc(studioState.regions, doc);
    if (regions === studioState.regions) return;
    refreshGen += 1;
    const lineId = doc.id.startsWith("region:") ? doc.id.slice(7) : "";
    const overflow = !!doc.data.layout?.overflow;
    const missing = doc.data.layout?.missingGlyphs ?? [];
    studioState.regions = regions;
    studioState.issues = (studioState.issues ?? []).flatMap((issue) => {
      if (issue.lineId !== lineId) return [issue];
      if (issue.code === "stale" || issue.code === "layout") return [];
      if (issue.code === "geometry") return doc.data.geometryApproved ? [] : [issue];
      if (issue.code === "overflow") return overflow ? [issue] : [];
      if (issue.code === "glyphs") return missing.length ? [issue] : [];
      return [issue];
    });
  }
  async function act(body: Record<string, unknown>) {
    error = "";
    busy = true;
    try {
      if (!(await saves.flushAll()))
        throw new Error("Resolve unsaved text before continuing");
      const acceptedLineId =
        body.action === "suggestion" && body.decision === "accept" && typeof body.id === "string"
          ? studioState?.suggestions.find((s) => s.id === body.id)?.line_id
          : undefined;
      let result;
      try {
        result = await request(`${apiBase}/workflow`, body);
      } catch (e) {
        const current = pageWriteConflict<WorkflowDoc<PageData>>(e);
        const imageId = String(body.imageId || page?.id || "");
        if (
          !current ||
          !imageId ||
          !["mask", "clean", "bubble-fill", "clone-brush", "blur-brush", "restore-brush", "raw-brush", "page", "apply-clean"].includes(String(body.action))
        )
          throw e;
        adoptPageDoc(imageId, current);
        result = await request(`${apiBase}/workflow`, {
          ...body,
          expectedRevision: current.revision,
        });
      }
      if (result?.jobId) {
        if (body.action === "export") pendingExportDownload = result.jobId;
        flashJobs();
      }
      const regionDoc =
        result?.doc &&
        (body.action === "region" || body.action === "fit") &&
        typeof result.doc.id === "string" &&
        result.doc.id.startsWith("region:")
          ? (result.doc as WorkflowDoc<RegionData>)
          : null;
      if (regionDoc) applyRegionDoc(regionDoc);
      else await refresh();
      if (
        result?.doc &&
        body.action === "preferences" &&
        body.scope !== "series"
      )
        preferenceRevision = result.doc.revision;
      if (result?.doc && body.id === selected?.id && body.action === "fit")
        styleRevision = result.doc.revision;
      if (acceptedLineId) await refitAfterText(acceptedLineId);
      return result;
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
      return null;
    } finally {
      busy = false;
    }
  }
  function pageSavedHistory(history: "undo" | "redo") {
    if (step !== "Clean" || !canClean || busy || !pageDoc) return;
    if (history === "undo" && !pageDoc.canUndo) return;
    if (history === "redo" && !pageDoc.canRedo) return;
    void act({
      action: "page",
      imageId: pageId,
      expectedRevision: pageDoc.revision,
      data: {},
      history,
    });
  }
  $effect(() => {
    if (!pendingExportDownload) return;
    const job = studioState?.jobs.find((job) => job.id === pendingExportDownload);
    if (job?.state === "completed" && job.progress?.artifact) {
      // Clear before clicking so polling and websocket updates download only once.
      pendingExportDownload = null;
      const link = document.createElement("a");
      link.download = job.progress.filename || "export.zip";
      link.href = `${asset(job.progress.artifact)}?download=${encodeURIComponent(link.download)}`;
      document.body.append(link);
      link.click();
      link.remove();
    } else if (job && ["failed", "cancelled", "interrupted"].includes(job.state)) {
      pendingExportDownload = null;
    }
  });
  function edit(line: LineRow, patch: Record<string, unknown>) {
    saves.queue(line.id, patch, line.revision ?? 0, "body" in patch ? 150 : 400);
    if (studioState)
      studioState.lines = studioState.lines.map((l) =>
        l.id === line.id ? { ...l, ...patch } : l,
      );
    if (studioState && patch.status === "approved")
      studioState.suggestions = studioState.suggestions.map((s) =>
        s.line_id === line.id && s.state === "pending"
          ? { ...s, state: "rejected" }
          : s,
      );
  }
  const canChangeType = $derived(canEdit || canClean);
  const regionKinds = $derived(activeRegionKinds(studioState?.seriesDefaults.data.regionKinds));
  /** Series types plus ids saved regions still use, so removed types stay colorable. */
  const colorKinds = $derived(
    regionKindUsage(
      regionKinds,
      (studioState?.lines ?? []).map((line) => line.lineType),
    ),
  );
  const canEditSeriesKinds = $derived(user.role === "admin" || series.createdBy === user.id);
  function colorFor(id: string) {
    return regionColor(id, regionKinds, userRegionColors);
  }
  function labelFor(id: string) {
    return regionKindLabel(id, regionKinds);
  }
  async function saveUserRegionColors(colors: Record<string, string>) {
    const data = await request("/api/me/settings", { regionColors: colors }, "PUT");
    userRegionColors = parseColorMap(data.regionColors);
  }
  async function saveSeriesKinds(kinds: RegionKind[] | null) {
    const result = await act({
      action: "preferences",
      scope: "series",
      expectedRevision: studioState?.seriesDefaults.revision ?? 0,
      data: { regionKinds: kinds },
    });
    if (!result?.doc) throw new Error(error || "Could not save series region types");
  }
  async function setLineType(line: LineRow, lineType: string) {
    if (!canChangeType || busy || line.lineType === lineType) return;
    edit(line, { lineType });
    const region = studioState?.regions[line.id];
    const hasLayout = !!region?.data.layout;
    if (canClean && (step === "Typeset" || (hasLayout && !region?.data.locked))) {
      await resetRegionStyle({ ...line, lineType: lineType as LineType });
      return;
    }
    if (hasLayout && canEdit && !region?.data.locked) {
      const result = await act({
        action: "fit",
        id: line.id,
        expectedRevision: region.revision,
        resetStyle: true,
      });
      if (result?.doc && selected?.id === line.id) {
        styleRevision = result.doc.revision;
        regionStyle = { ...inheritedStyle(lineType), ...result.doc.data.style };
      }
      return;
    }
    if (selected?.id === line.id) {
      regionStyle = {
        ...inheritedStyle(lineType),
        ...region?.data.style,
      };
    }
  }
  function selectLine(id: string, origin: "page" | "list" | "nav" = "nav") {
    const l = studioState?.lines.find((row) => row.id === id);
    if (l?.imageId && l.imageId !== pageId) choosePage(l.imageId);
    lineId = id;
    void tick().then(() => {
      if (["Translate", "Review"].includes(step) && origin !== "list")
        scrollInspectorToCard(id);
      if (origin !== "page") scrollCanvasToRegion(l);
    });
  }
  function scrollInspectorToCard(id: string) {
    const card = document.getElementById(`region-card-${id}`);
    const panel = card?.closest(".bilingual");
    if (!card || !(panel instanceof HTMLElement)) return;
    const cardRect = card.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    if (cardRect.top >= panelRect.top && cardRect.bottom <= panelRect.bottom)
      return;
    panel.scrollTo({
      top: Math.max(
        0,
        panel.scrollTop +
          cardRect.top -
          panelRect.top -
          Math.max(0, (panel.clientHeight - cardRect.height) / 2),
      ),
    });
  }
  function scrollCanvasToRegion(line: LineRow | undefined) {
    const scroller = canvasScrollEl;
    if (!scroller || !page || !line || line.imageId !== page.id) return;
    const canvas = scroller.querySelector(".canvas-page");
    if (!(canvas instanceof HTMLElement)) return;
    const padLeft = parseFloat(getComputedStyle(scroller).paddingLeft) || 0;
    const padTop = parseFloat(getComputedStyle(scroller).paddingTop) || 0;
    const left = padLeft + (line.x ?? 0) * canvas.offsetWidth;
    const top = padTop + (line.y ?? 0) * canvas.offsetHeight;
    const w = (line.w ?? 0.2) * canvas.offsetWidth;
    const h = (line.h ?? 0.1) * canvas.offsetHeight;
    scroller.scrollTo({
      left: Math.max(0, left + w / 2 - scroller.clientWidth / 2),
      top: Math.max(0, top + h / 2 - scroller.clientHeight / 2),
      behavior: "smooth",
    });
  }
  async function decideSuggestion(
    id: string,
    decision: "accept" | "reject",
    force = false,
  ) {
    await act({
      action: "suggestion",
      translationModel: aiModels.translate,
      id,
      decision,
      force,
    });
  }
  function choosePage(id: string) {
    scope = "page";
    if (step === "Prepare") prepView = "page";
    if (pageId && strokes.length) persistMaskDraft(pageId);
    maskJobId = null;
    pageId = id;
    if (selected?.imageId !== id) lineId = "";
    polygonDraft = [];
    cloneSource = null;
    cloneOffset = null;
    history = [];
    const img = studioState?.images.find((p) => p.id === id);
    const doc = studioState?.pages[id];
    if (
      img &&
      canClean &&
      ["Clean", "Typeset"].includes(step) &&
      (!doc?.data.prepared || doc.data.preparedAt !== img.updatedAt)
    )
      void act({ action: "prepare", imageId: id });
    try {
      const saved = JSON.parse(localStorage.getItem(maskDraftKey(id)) || "[]");
      strokes = Array.isArray(saved) ? saved : (saved.strokes ?? []);
      maskBaseRevision = strokes.length ? (doc?.revision ?? 0) : null;
      if (strokes.length) persistMaskDraft(id, maskBaseRevision);
    } catch {
      strokes = [];
      maskBaseRevision = null;
    }
  }
  $effect(() => {
    const revision = pageDoc?.revision;
    if (!strokes.length) {
      if (maskBaseRevision != null) maskBaseRevision = null;
      return;
    }
    if (revision == null || maskBaseRevision === revision) return;
    maskBaseRevision = revision;
    persistMaskDraft(page?.id, revision);
  });
  $effect(() => {
    if (selected && selected.id !== styleFor) {
      styleFor = selected.id;
      styleRevision = regionDoc?.revision ?? 0;
      regionStyle = {
        ...inheritedStyle(selected.lineType),
        ...regionDoc?.data.style,
      };
    }
  });
  function nextIssue() {
    void goToNextException();
  }
  function defaultTool(next: string) {
    if (next === "Clean" && canClean) return "brush";
    return "select";
  }
  async function switchStep(next: string) {
    step = next;
    inspectorTab = "";
    moreOpen = false;
    await saves.flushAll();
    choosePalette(defaultTool(next), { showBrushSize: false });
    pageTool = "select";
    polygonDraft = [];
    error = "";
    if (next === "Review") compare = false;
    if (
      ["Clean", "Typeset"].includes(next) &&
      page &&
      (!pageDoc?.data.prepared || pageDoc.data.preparedAt !== page.updatedAt)
    )
      await act({ action: "prepare", imageId: page.id });
    if (["Clean", "Typeset"].includes(next) && !backend) {
      await loadBackend();
      recheckBackendWhenUnavailable();
    }
  }
  function coords(e: PointerEvent): Point {
    const r = svgEl!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  }
  function hitDraftIndex(p: Point) {
    if (!svgEl) return -1;
    const r = svgEl.getBoundingClientRect();
    return polygonDraft.findIndex(
      (v) => Math.hypot((v.x - p.x) * r.width, (v.y - p.y) * r.height) <= 12,
    );
  }
  function startPolygon() {
    if (!selected || !canClean || regionDoc?.data.locked) return;
    showRegions = true;
    tool = "polygon";
    pageTool = "select";
    polygonDraft = [];
    polygonRevision = regionDoc?.revision ?? 0;
  }
  function cancelPolygon() {
    if (tool !== "polygon") return;
    polygonDraft = [];
    tool = "select";
  }
  async function rectanglePolygon() {
    if (!selected || !canClean || busy || regionDoc?.data.locked) return;
    const id = selected.id;
    const result = await act({
      action: "region",
      id,
      expectedRevision: regionDoc?.revision ?? 0,
      data: { polygon: regionRectangle(selected), geometryApproved: true },
    });
    if (!result?.doc) return;
    if (result.doc.data.layout && selected?.id === id) {
      styleRevision = result.doc.revision;
      regionStyle = { ...inheritedStyle(selected.lineType), ...result.doc.data.style };
    }
    cancelPolygon();
  }
  async function saveDrawnShape(kind: "rectangle" | "oval", start: Point, end: Point) {
    if (!selected || !canClean || regionDoc?.data.locked) return;
    const bounds = {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      w: Math.abs(end.x - start.x),
      h: Math.abs(end.y - start.y),
    };
    if (bounds.w < 0.005 || bounds.h < 0.002) return;
    const id = selected.id;
    const result = await act({
      action: "region",
      id,
      expectedRevision: regionDoc?.revision ?? 0,
      data: {
        polygon: kind === "oval" ? regionOval(bounds) : regionRectangle(bounds),
        geometryApproved: true,
      },
    });
    if (!result?.doc) return;
    if (result.doc.data.layout && selected?.id === id) {
      styleRevision = result.doc.revision;
      regionStyle = { ...inheritedStyle(selected.lineType), ...result.doc.data.style };
    }
    tool = "select";
  }
  async function completePolygon() {
    if (tool !== "polygon" || !selected || !canClean || busy) return;
    if (polygonDraft.length < 3) {
      notify("A saved polygon needs at least three points.");
      return;
    }
    const id = selected.id;
    const result = await act({
      action: "region",
      id,
      expectedRevision: polygonRevision,
      data: { polygon: polygonDraft, geometryApproved: true },
    });
    if (!result?.doc) return;
    if (result.doc.data.layout && selected?.id === id) {
      styleRevision = result.doc.revision;
      regionStyle = { ...inheritedStyle(selected.lineType), ...result.doc.data.style };
    }
    polygonDraft = [];
    tool = "select";
  }
  function down(e: PointerEvent) {
    if (!page || e.button !== 0 || busy) return;
    if (zooming) {
      nudgeZoom(e.altKey ? -1 : 1);
      return;
    }
    if (
      ![
        "region",
        "read-area",
        "place-line",
        "brush",
        "erase",
        "bubble-fill",
        "clone-stamp",
        "blur",
        "restore",
        "raw",
        "mask-grow",
        "polygon",
        "rectangle",
        "oval",
      ].includes(tool)
    )
      return;
    e.preventDefault();
    if (tool === "bubble-fill" || tool === "mask-grow") {
      if (!canClean) return;
      void clickCleanTool(coords(e));
      return;
    }
    if (tool === "clone-stamp") {
      if (!canClean) return;
      if (!cloneSource) {
        notify("Right-click to set the clone source.");
        return;
      }
      const p = coords(e);
      if (!cloneOffset) cloneOffset = { x: p.x - cloneSource.x, y: p.y - cloneSource.y };
      svgEl!.setPointerCapture(e.pointerId);
      drawing = { start: p, end: p, points: [p] };
      return;
    }
    if (tool === "blur") {
      if (!canClean) return;
      const p = coords(e);
      svgEl!.setPointerCapture(e.pointerId);
      drawing = { start: p, end: p, points: [p] };
      return;
    }
    if (tool === "restore") {
      if (!canClean) return;
      if (!canRestore) {
        notify("Nothing to restore. Save a cleaning pass first.");
        return;
      }
      const p = coords(e);
      svgEl!.setPointerCapture(e.pointerId);
      drawing = { start: p, end: p, points: [p] };
      return;
    }
    if (tool === "raw") {
      if (!canClean) return;
      if (!canPaintRaw) {
        notify("Nothing to paint from the raw page. Clean first, then stamp source pixels back.");
        return;
      }
      const p = coords(e);
      svgEl!.setPointerCapture(e.pointerId);
      drawing = { start: p, end: p, points: [p] };
      return;
    }
    if (tool === "brush" || tool === "erase") setMaskVisibility(true);
    if ((tool === "brush" || tool === "erase") && step === "Typeset" && !selected) {
      notify("Select a region to mask its text.");
      return;
    }
    if (["region", "read-area", "place-line", "polygon", "rectangle", "oval"].includes(tool)) showRegions = true;
    if ((tool === "rectangle" || tool === "oval") && (!selected || regionDoc?.data.locked)) {
      notify(regionDoc?.data.locked
        ? "Unlock this layout before changing its shape."
        : "Select a region to draw its text shape.");
      return;
    }
    const p = coords(e);
    if (tool === "polygon") {
      if (!polygonDraft.length) polygonRevision = regionDoc?.revision ?? 0;
      if (e.shiftKey) {
        const index = hitDraftIndex(p);
        if (index >= 0) polygonDraft = polygonDraft.filter((_, i) => i !== index);
        return;
      }
      if (polygonDraft.length >= 3 && hitDraftIndex(p) === 0) {
        void completePolygon();
        return;
      }
      polygonDraft = [...polygonDraft, p];
      return;
    }
    svgEl!.setPointerCapture(e.pointerId);
    drawing = { start: p, end: p, points: [p] };
  }
  function adjustedBounds(d: NonNullable<typeof drawing>) {
    const b = d.bounds!;
    const dx = d.end.x - d.start.x,
      dy = d.end.y - d.start.y;
    if (d.corner == null)
      return {
        ...b,
        x: Math.max(0, Math.min(1 - b.w, b.x + dx)),
        y: Math.max(0, Math.min(1 - b.h, b.y + dy)),
      };
    const anchor = {
      x: [0, 3].includes(d.corner) ? b.x + b.w : b.x,
      y: d.corner < 2 ? b.y + b.h : b.y,
    };
    return {
      x: Math.min(anchor.x, d.end.x),
      y: Math.min(anchor.y, d.end.y),
      w: Math.max(0.005, Math.abs(anchor.x - d.end.x)),
      h: Math.max(0.005, Math.abs(anchor.y - d.end.y)),
    };
  }
  function dragRegion(e: PointerEvent, l: LineRow, corner?: number) {
    if (e.button !== 0 || (!canEdit && !canClean) || tool !== "select" || busy || studioState?.regions[l.id]?.data.locked) return;
    e.stopPropagation();
    selectLine(l.id, "page");
    svgEl!.setPointerCapture(e.pointerId);
    const p = coords(e);
    drawing = {
      start: p,
      end: p,
      points: [],
      regionId: l.id,
      regionRevision: studioState?.regions[l.id]?.revision ?? 0,
      revision: l.revision,
      corner,
      bounds: { x: l.x ?? 0, y: l.y ?? 0, w: l.w ?? 0.2, h: l.h ?? 0.1 },
    };
  }
  function rotationCenter(l: LineRow): Point {
    const polygon = studioState?.regions[l.id]?.data.polygon;
    if (polygon?.length) return {
      x: (Math.min(...polygon.map(p => p.x)) + Math.max(...polygon.map(p => p.x))) / 2,
      y: (Math.min(...polygon.map(p => p.y)) + Math.max(...polygon.map(p => p.y))) / 2,
    };
    return { x: (l.x ?? 0) + (l.w ?? 0.2) / 2, y: (l.y ?? 0) + (l.h ?? 0.1) / 2 };
  }
  function rotationAngle(d: NonNullable<typeof drawing>) {
    const r = d.rotation!;
    return draggedRotation(r.initial, d.start, d.end, r.center, page!.width, page!.height);
  }
  function skewAngle(d: NonNullable<typeof drawing>) {
    const s = d.skew!;
    return draggedSkew(s.axis, s.initial, d.start, d.end, s.center, page!.width, page!.height);
  }
  function overlayStyle(l: LineRow, layout: { style: TextStyle }) {
    if (drawing?.regionId !== l.id) return undefined;
    if (drawing.rotation)
      return `transform:rotate(${rotationAngle(drawing) - layout.style.rotation}deg);transform-origin:${drawing.rotation.center.x * 100}% ${drawing.rotation.center.y * 100}%`;
    if (drawing.skew) {
      const next = {
        ...drawing.skew.style,
        [drawing.skew.axis === "x" ? "skewX" : "skewY"]: skewAngle(drawing),
      };
      return `transform:${cssDeltaTransform(layout.style, next)};transform-origin:${drawing.skew.center.x * 100}% ${drawing.skew.center.y * 100}%`;
    }
    if (drawing.bounds && drawing.corner == null)
      return `transform:translate(${(adjustedBounds(drawing).x - drawing.bounds.x) * 100}%, ${(adjustedBounds(drawing).y - drawing.bounds.y) * 100}%)`;
    return undefined;
  }
  function startRotation(e: PointerEvent) {
    e.stopPropagation();
    if (e.button !== 0 || !selected || !regionDoc || !canClean || busy || tool !== "select" || regionDoc.data.locked) return;
    e.preventDefault();
    svgEl!.setPointerCapture(e.pointerId);
    const p = coords(e);
    const style = { ...inheritedStyle(selected.lineType), ...regionDoc.data.style };
    drawing = { start: p, end: p, points: [], regionId: selected.id, revision: regionDoc.revision,
      rotation: { initial: style.rotation, angle: style.rotation, center: rotationCenter(selected), style } };
  }
  function startSkew(axis: "x" | "y", e: PointerEvent) {
    e.stopPropagation();
    if (e.button !== 0 || !selected || !regionDoc || !canClean || busy || tool !== "select" || regionDoc.data.locked) return;
    e.preventDefault();
    svgEl!.setPointerCapture(e.pointerId);
    const p = coords(e);
    const style = { ...inheritedStyle(selected.lineType), ...regionDoc.data.style };
    const initial = axis === "x" ? style.skewX : style.skewY;
    drawing = { start: p, end: p, points: [], regionId: selected.id, revision: regionDoc.revision,
      skew: { axis, initial, angle: initial, center: rotationCenter(selected), style } };
  }
  async function savePlacedTransform(
    id: string,
    revision: number,
    style: TextStyle,
    patch: { rotation?: number; skewX?: number; skewY?: number },
  ) {
    const line = studioState?.lines.find(l => l.id === id);
    if (!line) return;
    const result = await act({ action: "transform-text", id, expectedRevision: line.revision,
      expectedRegionRevision: revision, ...patch });
    if (result?.doc) {
      regionStyle = { ...style, ...patch };
      styleRevision = result.doc.revision;
    }
  }
  async function saveRotation(id: string, revision: number, style: TextStyle, angle: number) {
    await savePlacedTransform(id, revision, style, { rotation: angle });
  }

  function rotationKey(e: KeyboardEvent) {
    if (!selected || !regionDoc || busy || !canClean || regionDoc.data.locked) return;
    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const style = { ...inheritedStyle(selected.lineType), ...regionDoc.data.style };
    const angle = normalizeRotation(style.rotation + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 15 : 1));
    void saveRotation(selected.id, regionDoc.revision, style, angle);
  }
  function skewKey(axis: "x" | "y", e: KeyboardEvent) {
    if (!selected || !regionDoc || busy || !canClean || regionDoc.data.locked) return;
    const keys = axis === "x" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const style = { ...inheritedStyle(selected.lineType), ...regionDoc.data.style };
    const stepDeg = e.shiftKey ? 15 : 1;
    const delta = (axis === "x" ? e.key === "ArrowRight" : e.key === "ArrowDown") ? stepDeg : -stepDeg;
    const next = clampSkew((axis === "x" ? style.skewX : style.skewY) + delta);
    void savePlacedTransform(selected.id, regionDoc.revision, style, axis === "x" ? { skewX: next } : { skewY: next });
  }
  function move(e: PointerEvent) {
    if (!drawing) return;
    const p = coords(e);
    if (tool === "rectangle" || tool === "oval") {
      drawing = { ...drawing, end: p };
      return;
    }
    drawing = { ...drawing, end: p, points: [...drawing.points, p] };
  }
  async function up(e: PointerEvent) {
    if (!drawing || !page) return;
    const d = drawing;
    drawing = null;
    if (d.rotation && d.regionId) {
      await saveRotation(d.regionId, d.revision!, d.rotation.style, rotationAngle(d));
      return;
    }
    if (d.skew && d.regionId) {
      const angle = skewAngle(d);
      await savePlacedTransform(d.regionId, d.revision!, d.skew.style,
        d.skew.axis === "x" ? { skewX: angle } : { skewY: angle });
      return;
    }
    if (d.bounds && d.regionId) {
      if (Math.abs(d.end.x - d.start.x) + Math.abs(d.end.y - d.start.y) < 0.002)
        return;
      try {
        if (!(await saves.flushAll()))
          throw new Error("Resolve unsaved drafts before changing bounds");
        if (d.corner == null) {
          const bounds = adjustedBounds(d);
          await request(`${apiBase}/workflow`, { action: "transform-text", id: d.regionId,
            x: bounds.x, y: bounds.y, expectedRevision: d.revision,
            expectedRegionRevision: d.regionRevision });
        } else {
          await request(`${apiBase}/lines/${d.regionId}`,
            { ...adjustedBounds(d), expectedRevision: d.revision }, "PATCH");
        }
        await refresh();
      } catch (e) {
        error = String(e);
      }
      return;
    }
    if (d.vertex != null && selected && regionDoc) {
      const poly = [...selectedPolygon];
      poly[d.vertex] = d.end;
      await act({
        action: "region",
        id: selected.id,
        expectedRevision: d.revision ?? regionDoc.revision,
        data: { polygon: poly, geometryApproved: false },
      });
      return;
    }
    if (tool === "clone-stamp") {
      if (!cloneOffset || !d.points.length) return;
      const result = await act({
        action: "clone-brush",
        imageId: page.id,
        expectedRevision: pageDoc?.revision,
        strokes: [{ points: d.points, radius }],
        offset: [cloneOffset.x, cloneOffset.y],
      });
      if (result) notify("Clone stamp applied. Undo saved edit restores the previous artwork.");
      else cloneEpoch += 1;
      return;
    }
    if (tool === "blur") {
      if (!d.points.length) return;
      const result = await act({
        action: "blur-brush",
        imageId: page.id,
        expectedRevision: pageDoc?.revision,
        strokes: [{ points: d.points, radius }],
      });
      if (result) notify("Blur applied. Undo saved edit restores the previous artwork.");
      else blurEpoch += 1;
      return;
    }
    if (tool === "restore") {
      if (!d.points.length) return;
      const result = await act({
        action: "restore-brush",
        imageId: page.id,
        expectedRevision: pageDoc?.revision,
        strokes: [{ points: d.points, radius }],
      });
      if (result) notify("Restored from the previous save. Undo saved edit restores the previous artwork.");
      else restoreEpoch += 1;
      return;
    }
    if (tool === "raw") {
      if (!d.points.length) return;
      const result = await act({
        action: "raw-brush",
        imageId: page.id,
        expectedRevision: pageDoc?.revision,
        strokes: [{ points: d.points, radius }],
      });
      if (result) notify("Painted raw source pixels. Undo saved edit restores the previous artwork.");
      else restoreEpoch += 1;
      return;
    }
    if (tool === "brush" || tool === "erase") {
      if (step === "Typeset") {
        if (!selected || !regionDoc || !canClean) {
          notify("Select a region to mask its text.");
          return;
        }
        await act({
          action: "text-mask",
          id: selected.id,
          expectedRevision: regionDoc.revision,
          strokes: [{ points: d.points, radius, erase: tool === "erase" }],
        });
        return;
      }
      if (!strokes.length) maskBaseRevision = pageDoc?.revision ?? 0;
      strokes = [
        ...strokes,
        { points: d.points, radius, erase: tool === "erase" },
      ];
      persistMaskDraft(page.id);
      return;
    }
    if (tool === "rectangle" || tool === "oval") {
      await saveDrawnShape(tool, d.start, d.end);
      return;
    }
    if (["region", "read-area", "place-line"].includes(tool)) {
      const x = Math.min(d.start.x, d.end.x),
        y = Math.min(d.start.y, d.end.y),
        w = Math.abs(d.start.x - d.end.x),
        h = Math.abs(d.start.y - d.end.y);
      if (w < 0.005 || h < 0.002) return;
      try {
        if (tool === "read-area") {
          beginJobFeedback("selection");
          try {
            await request(`${apiBase}/ai-translate`, {
              imageId: page.id,
              x,
              y,
              w,
              h,
              forceVision: true,
              engine: aiModels.vision.engine,
              model: aiModels.vision.model || undefined,
              lang: studioState!.preferences.lang,
            });
            notify("Area queued for image-model reading and translation");
            await refresh();
          } catch (e) {
            endJobIntent();
            throw e;
          }
          return;
        }
        if (tool === "place-line" && selected) {
          edit(selected, { imageId: page.id, x, y, w, h, placed: true });
          tool = "select";
          return;
        }
        const data = await request(`${apiBase}/lines`, {
          imageId: page.id,
          body: "",
          x,
          y,
          w,
          h,
          placed: true,
          lineType: '""',
        });
        await refresh();
        inspectorOpen = true;
        selectLine(data.line.id, "page");
        tool = "select";
        try {
          beginJobFeedback("region-ocr");
          await request(`${apiBase}/ai-transcribe`, {
            lineId: data.line.id,
            expectedRevision: data.line.revision,
            lang: studioState!.preferences.lang,
          });
          notify("Transcription started for this region. Matching source will be translated.");
        } catch (ocrError) {
          endJobIntent();
          error = String(ocrError);
        }
      } catch (e) {
        error = String(e);
      }
    }
  }
  async function applyCleaningPass() {
    if (!page || !pageDoc || strokes.length) return;
    const result = await act({
      action: "apply-clean",
      imageId: page.id,
      expectedRevision: pageDoc.revision,
    });
    if (result) {
      maskBaseRevision = null;
      maskJobId = null;
      localStorage.removeItem(maskDraftKey(page.id));
      choosePalette("brush");
      notify("Cleaning applied. Brush or detect remaining text to start the next pass.");
    }
  }
  async function saveCleaningSample() {
    if (!page) return;
    const result = await act({ action: "save-cleaning-sample", imageId: page.id });
    if (result?.id)
      notify(`Saved cleaning sample ${String(result.id).padStart(3, "0")}.`);
  }
  function setCloneSource(p: Point) {
    if (!canClean || busy) return;
    cloneSource = p;
    cloneOffset = null;
    notify("Clone source set. Click the destination, then drag to paint.");
  }
  async function clickCleanTool(p: Point) {
    if (!page || !pageDoc || !canClean || busy) return;
    if (tool === "bubble-fill") {
      const result = await act({
        action: "bubble-fill",
        imageId: page.id,
        expectedRevision: pageDoc.revision,
        px: p.x,
        py: p.y,
      });
      if (result)
        notify("Filled the speech bubble. Undo saved edit restores the previous artwork.");
      return;
    }
    if (!pageDoc.data.mask && !strokes.length) {
      notify("Paint or detect a mask first, then click a mask region to grow it.");
      return;
    }
    const growPx = growAmount;
    const result = await act({
      action: "mask",
      imageId: page.id,
      expectedRevision: pageDoc.revision,
      strokes,
      grow: growPx,
      px: p.x,
      py: p.y,
    });
    if (result) {
      strokes = [];
      maskBaseRevision = null;
      localStorage.removeItem(maskDraftKey(page.id));
      notify(`Grew that mask region by ${growPx}px.`);
    }
  }
  async function applyMask(detect = false) {
    if (!page || !pageDoc) return;
    if (detect && !hasMaskRegions) {
      notify("Define a region before detecting a removal mask.");
      return;
    }
    beginJobFeedback("mask");
    const result = await act({
      action: "mask",
      imageId: page.id,
      expectedRevision: pageDoc.revision,
      detect,
      strokes,
      expansion,
      maskEngine: detect ? maskEngine : undefined,
    });
    if (!result) endJobIntent();
    if (result) {
      maskJobId = result.jobId;
      notify(detect
        ? "Mask detection started. Inspect the result, then approve it."
        : "Saving mask edits. The saved mask will be ready for cleaning automatically.");
    }
    return result;
  }
  function approveMask() {
    if (strokes.length) {
      void applyMask();
      return;
    }
    if (!page || !pageDoc?.data.mask || pageDoc.data.maskApproved) return;
    void act({
      action: "page",
      imageId: page.id,
      expectedRevision: pageDoc.revision,
      data: { maskApproved: true },
    });
  }
  const aiRunning = $derived(studioState?.jobs.some(j =>
    ["transcribe", "translate", "proofread", "review", "selection", "reread", "fill-missing", "suggest", "source-translation", "describe", "reslice", "glossary-mine"].includes(j.kind) &&
    ["running", "queued", "cancelling"].includes(j.state)) ?? false);
  const reviewPendingCount = $derived(
    (studioState?.lines ?? []).filter(needsTranslationReview).length,
  );
  const glossaryMineJob = $derived(studioState?.jobs.find((job) => job.kind === "glossary-mine") ?? null);
  const glossaryModel = $derived(aiModels.enquire ?? null);
  const reviewLines = $derived.by(() => {
    const pages = new Map((studioState?.images ?? []).map((image, i) => [image.id, i]));
    return [...(studioState?.lines ?? [])].sort((a, b) =>
      (pages.get(a.imageId ?? "") ?? Infinity) - (pages.get(b.imageId ?? "") ?? Infinity) ||
      a.sortOrder - b.sortOrder);
  });
  const exceptions = $derived(
    studioState
      ? chapterExceptions({
          images: studioState.images,
          lines: studioState.lines,
          pages: studioState.pages,
          regions: studioState.regions,
          suggestions: studioState.suggestions,
        })
      : [],
  );
  let lastException = $state<ChapterException | null>(null);
  const exceptionCursor = $derived(
    lastException ??
      exceptionCursorFromView({
        images: studioState?.images ?? [],
        pageId: page?.id,
        selected,
        step,
      }),
  );
  const upcomingException = $derived(nextException(exceptions, exceptionCursor));
  async function openException(item: ChapterException) {
    lastException = item;
    scope = "page";
    inspectorOpen = true;
    unresolvedOnly = false;
    if (step !== item.step) await switchStep(item.step);
    if (item.imageId) choosePage(item.imageId);
    if (item.lineId) selectLine(item.lineId);
    else lineId = "";
    if (item.kind === "mask") choosePalette("brush");
  }
  async function goToNextException() {
    if (!upcomingException) {
      notify("Nothing left to review.");
      return;
    }
    await openException(upcomingException);
  }
  const latestTranslation = $derived(studioState?.jobs.find(j => j.kind === "translate" || j.kind === "transcribe"));
  function reviewTranslations(imageId?: string) {
    scope = "page";
    step = "Review";
    unresolvedOnly = false;
    inspectorOpen = true;
    const target = reviewLines.find(l => (!imageId || l.imageId === imageId) &&
      l.sourceState !== "ignored" && l.status !== "approved");
    if (target) selectLine(target.id);
    else if (imageId) choosePage(imageId);
  }
  async function approveAndNext(line: LineRow) {
    lastException = null;
    edit(line, { status: "approved" });
    await saves.flush(line.id);
    if (saves.drafts.has(line.id)) return;
    const next = nextTranslationReview(reviewLines, line.id);
    if (!next) {
      notify("Nothing left to review.");
      return;
    }
    selectLine(next.id);
  }
  async function forgetPageHistory() {
    if (!pageId || busy) return;
    const kind = step === "Review" ? "review" : step === "Clean" ? "clean" : step === "Typeset" ? "typeset" : "translate";
    if (!confirm("Mark this page done for this step? That records it as finished for export and clears the saved undo history for this step. The current text and artwork stay. Editing again reopens it."))
      return;
    const result = await act({ action: "forget-page-history", imageId: pageId, step: kind });
    if (result) notify("Saved history for this step was removed.");
  }
  async function approveCleanedAndNext() {
    const currentId = pageId;
    const doc = pageDoc;
    if (!currentId || !doc) return;
    const result = await act({
      action: "page",
      imageId: currentId,
      expectedRevision: doc.revision,
      data: { cleanApproved: true },
    });
    if (!result) return;
    const images = studioState?.images ?? [];
    const next = images[images.findIndex((image) => image.id === currentId) + 1];
    if (next) choosePage(next.id);
  }
  async function cleanWith(method: string) {
    if (!page || !pageDoc || pendingClean) return;
    let prompt: string | undefined;
    const model = backend?.models?.find((item: { id: string; tasks: string[] }) => item.id === method && item.tasks.includes('cleaning'));
    const dialog = model ? modelImageEditDialog(model.id, model.label) : undefined;
    if (dialog) {
      const next = await cleanPromptDialog.open(dialog);
      if (next == null) return;
      prompt = next;
    }
    if (strokes.length) {
      const result = await applyMask();
      if (!result) return;
      pendingClean = { method, imageId: page.id, prompt };
      tryPendingClean();
      return;
    }
    if (!pageDoc.data.mask) {
      notify("Paint or detect a mask before cleaning.");
      return;
    }
    if (!pageDoc.data.maskApproved) {
      const approved = await act({
        action: "page",
        imageId: page.id,
        expectedRevision: pageDoc.revision,
        data: { maskApproved: true },
      });
      if (!approved) return;
    }
    const doc = studioState?.pages[page.id];
    if (!doc?.data.mask || !doc.data.maskApproved) {
      notify("Paint or detect a mask before cleaning.");
      return;
    }
    beginJobFeedback("clean");
    const result = await act({
      action: "clean",
      imageId: page.id,
      expectedRevision: doc.revision,
      method,
      offset: [cloneX, cloneY],
      ...(prompt ? { prompt } : {}),
    });
    if (!result) endJobIntent();
  }
  function tryPendingClean() {
    if (!pendingClean || busy) return;
    if (maskJobId) {
      const job = studioState?.jobs.find((item) => item.id === maskJobId);
      if (!job || ["running", "queued", "cancelling"].includes(job.state)) return;
      if (job.state !== "completed") {
        pendingClean = null;
        maskJobId = null;
        return;
      }
    }
    const { method, imageId, prompt } = pendingClean;
    const doc = studioState?.pages[imageId];
    if (!doc?.data.mask || !doc.data.maskApproved) return;
    pendingClean = null;
    beginJobFeedback("clean");
    void act({
      action: "clean",
      imageId,
      expectedRevision: doc.revision,
      method,
      offset: [cloneX, cloneY],
      ...(prompt ? { prompt } : {}),
    }).then((result) => {
      if (!result) endJobIntent();
    });
  }
  async function cancelTranslation() {
    const jobs = studioState?.jobs.filter(j =>
      ["transcribe", "translate", "proofread", "review", "selection", "reread", "fill-missing", "suggest", "source-translation", "describe", "glossary-mine"].includes(j.kind) &&
      ["running", "queued"].includes(j.state)) ?? [];
    try {
      // Stopping AI must remain available even when a text draft cannot save.
      for (const job of jobs) await request(`${apiBase}/workflow`, { action: "cancel", jobId: job.id });
      await refresh();
    } catch (e) {
      error = String(e);
    }
  }
  async function runAI(kind: string, imageId?: string) {
    if (busy || aiRunning) return;
    if (kind === "translate" && !translateGate.ok) {
      error = translateGate.reason;
      return;
    }
    if (kind === "proofread" && !proofreadEnglishGate.ok) {
      error = proofreadEnglishGate.reason;
      return;
    }
    beginJobFeedback(kind);
    busy = true;
    error = "";
    try {
      if (!(await saves.flushAll()))
        throw new Error("Resolve unsaved drafts first");
      await request(`${apiBase}/ai-${kind}`, {
        imageId,
        ...(kind !== "transcribe" ? { engine: kind === "proofread" ? aiModels.proofread.engine : aiModels.translate.engine } : {}),
        ...(kind !== "transcribe" ? { model: (kind === "proofread" ? aiModels.proofread.model : aiModels.translate.model) || undefined } : {}),
        lang: studioState?.preferences.lang,
        replace: false,
      });
      await refresh();
      notify(kind === "transcribe"
        ? "Transcription started. Agreed readings fill source and English. Other readings stay as suggestions."
        : kind === "translate"
          ? "Translation started. Existing source text is being translated. Proofreading is not included."
          : "Proofreading started. Suggested changes will appear beside the English.");
    } catch (e) {
      endJobIntent();
      error = String(e);
    } finally {
      busy = false;
    }
  }
  async function upload() {
    if (!pendingFiles.length) return;
    busy = true;
    error = "";
    const form = new FormData();
    pendingFiles.forEach((f) => form.append("files", f));
    form.append("stitch", String(stitch));
    for (const [key, value] of Object.entries(insertPosition))
      if (value) form.append(key, value);
    try {
      const res = await fetch(`${apiBase}/images`, {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      duplicateWarning = (data.warnings || []).join(" · ");
      pendingFiles = [];
      insertPosition = {};
      inspectorTab = "page";
      await refresh();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
  function addFiles(files: File[]) {
    pendingFiles = [...pendingFiles, ...files].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
    duplicateWarning = pendingFiles
      .filter((f, i, a) =>
        a.some((o, j) => j < i && o.name === f.name && o.size === f.size),
      )
      .map((f) => `Possible duplicate: ${f.name}`)
      .join(" · ");
    if (files.length) {
      step = "Prepare";
      inspectorTab = "upload";
      if (!inspectorOpen) {
        inspectorOpen = true;
        persistLayout();
      }
    }
  }
  async function reorder(delta: number) {
    if (!page || !studioState) return;
    const next = [...studioState.images];
    const i = next.findIndex((p) => p.id === page.id),
      j = i + delta;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    try {
      await request(
        `${apiBase}/images`,
        { order: next.map((p, i) => ({ id: p.id, sortOrder: i })) },
        "PATCH",
      );
      await refresh();
    } catch (e) {
      error = String(e);
    }
  }
  function inheritedStyle(lineType: string) {
    return {
      ...DEFAULT_STYLE,
      ...studioState?.seriesDefaults.data.style,
      ...studioState?.seriesDefaults.data.styles?.[lineType],
      ...studioState?.chapter.data.styles?.[lineType],
    };
  }
  async function refitAfterText(id: string) {
    if (!["Clean", "Translate", "Review", "Typeset"].includes(step)) return;
    if (!canClean && !canEdit) return;
    const region = studioState?.regions[id];
    const line = studioState?.lines.find((row) => row.id === id);
    if (!region || !line || region.data.locked) return;
    if (!line?.placed && !region.data.layout) return;
    const fontId = region.data.style?.fontId || inheritedStyle(line.lineType).fontId;
    if (!fontId) return;
    try {
      const result = await request(`${apiBase}/workflow`, {
        action: "fit",
        id,
        expectedRevision: region.revision,
      });
      if (result?.doc && studioState) {
        applyRegionDoc(result.doc);
        if (selected?.id === id) {
          styleRevision = result.doc.revision;
          regionStyle = { ...inheritedStyle(line.lineType), ...result.doc.data.style };
        }
      }
    } catch {
      /* A later save retries; missing fonts and locked layouts stay quiet. */
    }
  }
  async function resetRegionStyle(line: LineRow) {
    if (!canClean || busy) return;
    const expectedRevision = studioState?.regions[line.id]?.revision ?? 0;
    const result = await act(inheritedStyle(line.lineType).fontId ? {
      action: "fit", id: line.id, expectedRevision, resetStyle: true,
    } : {
      action: "region", id: line.id, expectedRevision, data: { style: {} },
    });
    if (result?.doc && selected?.id === line.id) {
      styleRevision = result.doc.revision;
      regionStyle = { ...inheritedStyle(line.lineType), ...result.doc.data.style };
    }
  }
  async function applyStyle(scope = "region") {
    if (!selected || !regionDoc || !canClean || busy || regionDoc.data.locked) return;
    const id = selected.id;
    if (scope === "region") {
      const style = styleDiff(inheritedStyle(selected.lineType), regionStyle);
      const result = await act(regionStyle.fontId ? {
        action: "fit", id, expectedRevision: styleRevision, style,
      } : {
        action: "region", id, expectedRevision: styleRevision, data: { style },
      });
      if (result?.doc && selected?.id === id) {
        styleRevision = result.doc.revision;
        regionStyle = { ...inheritedStyle(selected.lineType), ...result.doc.data.style };
      }
    } else {
      const doc =
        scope === "series" ? studioState!.seriesDefaults : studioState!.chapter;
      await act({
        action: "preferences",
        scope,
        expectedRevision: doc.revision,
        data: {
          styles: { ...doc.data.styles, [selected.lineType]: regionStyle },
        },
      });
    }
  }
  async function paintStyle(id: string) {
    if (step !== "Typeset" || tool !== "style-brush" || !canClean || !styleBrush ||
        (busy && !applyingStyleBrush)) return;
    selectLine(id, "page");
    if (id === styleBrush.sourceId) return;
    if (studioState?.regions[id]?.data.locked) {
      notify("Unlock this layout before applying a style.");
      return;
    }
    // Keep the sampled style for every click, including clicks made while a fit is saving.
    styleBrushQueue.push({ id, style: { ...styleBrush.style } });
    if (applyingStyleBrush) return;
    applyingStyleBrush = true;
    busy = true;
    error = "";
    try {
      while (styleBrushQueue.length) {
        const target = styleBrushQueue.shift()!;
        try {
          if (!(await saves.flushAll())) {
            styleBrushQueue.length = 0;
            throw new Error("Resolve unsaved text before continuing");
          }
          const doc = studioState?.regions[target.id];
          if (!doc) throw new Error("Region no longer exists");
          if (doc.data.locked) {
            notify("Unlock this layout before applying a style.");
            continue;
          }
          const saved = await request(`${apiBase}/workflow`, {
            action: "region", id: target.id, expectedRevision: doc.revision,
            data: { style: target.style },
          });
          try {
            await request(`${apiBase}/workflow`, {
              action: "fit", id: target.id, expectedRevision: saved.doc.revision,
            });
          } finally {
            await refresh();
            if (selected?.id === target.id && regionDoc) {
              styleRevision = regionDoc.revision;
              regionStyle = { ...inheritedStyle(selected.lineType), ...regionDoc.data.style };
            }
          }
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
      }
    } finally {
      applyingStyleBrush = false;
      busy = false;
    }
  }
  const loadedFonts = new Set<string>();
  $effect(() => {
    if (typeof document === "undefined") return;
    for (const f of studioState?.fonts ?? []) {
      if (loadedFonts.has(f.id)) continue;
      loadedFonts.add(f.id);
      const face = new FontFace(`scan-${f.id}`, `url("${asset(f.hash)}")`);
      document.fonts.add(face);
      void face.load().catch(() => {
        notify(`Could not preview ${f.familyName}`);
      });
    }
  });
  function persistJobsPanel() {
    try {
      localStorage.setItem("scan.jobsPanel", jobsPanel);
    } catch {
      /* ignore quota / private mode */
    }
  }
  /** Newest preview request wins, so a page picked mid-stitch cannot be overwritten by the
   *  one it replaced. */
  let reslicePreviewRequest = 0;
  async function loadReslicePreview() {
    if (!studioState?.images.length) return;
    const imgs = studioState.images;
    const idx = page ? imgs.findIndex((p) => p.id === page.id) : 0;
    // The window straddles the current page so a bubble that crosses either file boundary
    // can be moved whole. It also means the stitch opens on the previous page's tail, so the
    // canvas is scrolled to the current page's band and the boundaries are labelled.
    const imageIds = imgs
      .slice(Math.max(0, idx - 1), Math.min(imgs.length, idx + 2))
      .map((p) => p.id);
    const token = ++reslicePreviewRequest;
    try {
      const data = await request(`${apiBase}/pages`, {
        op: "reslice-preview",
        imageIds,
      });
      if (token !== reslicePreviewRequest) return;
      reslicePreview = {
        ...data,
        // Number the markers the way the page sidebar does, so "Page 8" means the page the
        // operator opened and not the chapter's stored, possibly stale, page number.
        pages: (data.pages as { id: string; top: number; height: number }[]).map((entry) => ({
          ...entry,
          number: imgs.findIndex((p) => p.id === entry.id) + 1,
        })),
      };
      await tick();
      const current = data.pages.find((p: { id: string }) => p.id === page?.id);
      if (current) scrollCanvasToStitch(current.top / data.height);
    } catch (e) {
      if (token === reslicePreviewRequest) error = String(e);
    }
  }
  /** Put a stitched-preview fraction at the top of the canvas, clear of the page label. */
  function scrollCanvasToStitch(y: number) {
    const scroller = canvasScrollEl;
    if (!scroller) return;
    const canvas = scroller.querySelector(".canvas-page");
    if (!(canvas instanceof HTMLElement)) return;
    const padTop = parseFloat(getComputedStyle(scroller).paddingTop) || 0;
    scroller.scrollTo({ top: Math.max(0, padTop + y * canvas.offsetHeight - 8) });
  }
  /**
   * The stitched window belongs to one page, so the preview follows the selection: opening
   * the tool loads it, picking another page reloads it, and leaving the tool drops it. That
   * keeps the canvas from showing a strip around a page the operator has moved on from.
   */
  let reslicePreviewFor = $state<string | null>(null);
  $effect(() => {
    const id = step === "Prepare" && pageTool === "reslice" ? (page?.id ?? null) : null;
    if (reslicePreviewFor === id) return;
    reslicePreviewFor = id;
    if (id) void loadReslicePreview();
    else reslicePreview = null;
  });
  async function applyReslice(cuts?: number[]) {
    try {
      await request(`${apiBase}/pages`, {
        op: "reslice",
        imageIds: cuts ? reslicePreview?.imageIds : undefined,
        cuts,
      });
      flashJobs();
      await refresh();
      notify(cuts ? "Manual reslice started." : "Auto-reslice started.");
    } catch (e) {
      error = String(e);
    }
  }
  async function previewShare(body: Record<string, unknown> = {}) {
    const data = await request(`${apiBase}/preview`, body);
    await refresh();
    return data;
  }
  const previewUrl = $derived(
    studioState?.previewToken
      ? `${typeof location !== "undefined" ? location.origin : ""}/p/${studioState.previewToken}`
      : "",
  );
  function persistLayout() {
    try {
      localStorage.setItem(
        "scan.studio.layout",
        JSON.stringify({
          pagesOpen,
          inspectorOpen,
          pagesWidth,
          inspectorWidth,
        }),
      );
    } catch {
      /* ignore */
    }
  }
  function clamp(n: number, min: number, max: number) {
    return Math.max(min, Math.min(max, n));
  }
  function startResize(event: PointerEvent, side: "pages" | "inspector") {
    event.preventDefault();
    const origin = event.clientX;
    const start = side === "pages" ? pagesWidth : inspectorWidth;
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      const dx = e.clientX - origin;
      if (side === "pages") pagesWidth = clamp(start + dx, 80, 280);
      else inspectorWidth = clamp(start - dx, 280, 640);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      persistLayout();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  function notify(text: string) {
    const id = ++toastSeq;
    toasts = [...toasts, { id, text }];
    window.setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id);
    }, 5000);
  }
  function dismissToast(id: number) {
    toasts = toasts.filter((t) => t.id !== id);
  }
  function nudgeZoom(dir: 1 | -1) {
    zoom = clamp(zoom + dir * 10, 30, 2000);
  }
  function typesetRunning() {
    return !!studioState?.jobs?.some(
      (j: any) =>
        j.kind === "typeset-all" && ["queued", "running"].includes(j.state),
    );
  }
  async function fitPage(imageId?: string) {
    if (!canClean || busy || typesetRunning()) return;
    openMenu = null;
    menu = null;
    const id = imageId ?? page?.id;
    if (!id) return;
    const result = await act({ action: "typeset-all", scope: "page", imageId: id });
    if (result) {
      notify("Fitting all text on this page. Locked layouts are skipped.");
    }
  }
  function fitChapter() {
    openMenu = null;
    menu = null;
    void act({ action: "typeset-all", scope: "chapter" }).then((result) => {
      if (!result) return;
      notify("Fitting all text in this chapter. Locked layouts are skipped.");
    });
  }
  async function keepCurrentLayouts() {
    if (!canClean || busy) return;
    const result = await act({ action: "keep-current-layouts" });
    if (result)
      notify(
        `Kept ${result.kept} layout${result.kept === 1 ? "" : "s"} as currently placed. They will not need a refit.`,
      );
  }
  async function saveSeriesType(payload: {
    expectedRevision: number;
    style: TextStyle;
    styles: Record<string, TextStyle>;
  }) {
    const result = await act({
      action: "preferences",
      scope: "series",
      expectedRevision: payload.expectedRevision,
      data: { style: payload.style, styles: payload.styles },
    });
    if (!result?.doc) throw new Error(error || "Could not save series type settings");
    return { revision: result.doc.revision };
  }
  async function uploadSeriesCredit(kind: CreditKind, file: File) {
    error = "";
    busy = true;
    try {
      const body = new FormData();
      body.set("kind", kind);
      body.set("file", file);
      const res = await fetch(`/api/series/${series.id}/credits`, { method: "POST", body });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not save credits page");
      await refresh();
      notify(`Saved series ${kind === "pre" ? "pre-credits" : "post-credits"} page.`);
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
  async function clearSeriesCredit(kind: CreditKind) {
    error = "";
    busy = true;
    try {
      const res = await fetch(`/api/series/${series.id}/credits`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "clear", kind }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not remove credits page");
      await refresh();
      notify(`Removed series ${kind === "pre" ? "pre-credits" : "post-credits"} page.`);
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
  async function uploadSeriesFont(files: File[]) {
    const body = new FormData();
    for (const file of files) body.append("font", file);
    const res = await fetch(`${apiBase}/workflow`, { method: "POST", body });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Could not add font");
    await refresh();
  }
  async function resetStyles(scope: "page" | "chapter") {
    if (!canClean || busy || typesetRunning()) return;
    const label = scope === "page" ? "this page" : "this chapter";
    if (
      !window.confirm(
        `Clear unlocked style overrides on ${label} and refit from series type settings? Locked layouts stay.`,
      )
    )
      return;
    openMenu = null;
    menu = null;
    const result = await act({
      action: "reset-styles",
      scope,
      imageId: scope === "page" ? page?.id : undefined,
    });
    if (!result) return;
    notify(
      `Cleared ${result.cleared ?? 0} overrides${result.locked ? ` · ${result.locked} locked skipped` : ""}.`,
    );
    if (scope === "page") await fitPage();
    else fitChapter();
  }
  function toggleMenu(next: "series" | "chapter" | "page" | "view") {
    openMenu = openMenu === next ? null : next;
  }
  function openAiModelSettings() {
    openMenu = null;
    settingsSection = "models";
  }
  const zooming = $derived(tool === "zoom" || pageTool === "zoom");
  const translateStep = $derived(["Translate", "Review"].includes(step));
  function canvasScroll(node: HTMLElement) {
    const onWheel = (e: WheelEvent) => {
      if (e.shiftKey && (tool === "brush" || tool === "erase" || tool === "clone-stamp" || tool === "blur" || tool === "restore" || tool === "raw")) {
        e.preventDefault();
        radius = nudgeBrush(radius, brushDeltaFromWheel(e), PAGE_BRUSH_MIN, PAGE_BRUSH_MAX);
        return;
      }
      if (!zooming && !e.altKey) return;
      e.preventDefault();
      nudgeZoom(e.deltaY > 0 ? -1 : 1);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return {
      destroy() {
        node.removeEventListener("wheel", onWheel);
      },
    };
  }
  function setMaskVisibility(visible: boolean) {
    showMask = visible;
    if (visible) compare = false;
  }
  function applyPageOrder(ordered: LineRow[]) {
    if (!studioState) return;
    const rank = new Map(ordered.map((line, i) => [line.id, i + 1]));
    studioState.lines = studioState.lines.map((line) =>
      rank.has(line.id) ? { ...line, sortOrder: rank.get(line.id)! } : line,
    );
  }
  async function reorderRegions(afterId: string | null, movedId: string) {
    if (!canEdit || busy || !page) return false;
    try {
      if (!(await saves.flushAll()))
        throw new Error("Resolve unsaved drafts before reordering");
      const data = await request(`${apiBase}/lines`, {
        action: "reorder",
        imageId: page.id,
        regionId: afterId ?? movedId,
        ...(afterId == null ? { first: true } : { nextId: movedId }),
      }, "PATCH");
      if (Array.isArray(data.lines)) applyPageOrder(data.lines);
      else await refresh();
      return true;
    } catch (e) {
      const message = String(e);
      if (/already (next|first)/i.test(message)) return true;
      error = message;
      await refresh().catch(() => {});
      return false;
    }
  }
  async function clickReorder(id: string) {
    if (!canEdit || busy || !page) return;
    selectLine(id, "page");
    if (reorderFromId && reorderFromId !== id) {
      const ok = await reorderRegions(reorderFromId, id);
      if (!ok) return;
    }
    reorderFromId = id;
    notify("Click the next region in reading order.");
  }
  async function setRegionFirst(id: string) {
    menu = null;
    const ok = await reorderRegions(null, id);
    if (!ok) return;
    selectLine(id, "page");
    if (tool === "reorder") {
      reorderFromId = id;
      notify("Click the next region in reading order.");
    }
  }
  function setBrushSizeOpen(open: boolean) {
    brushSizeOpen = open && (step === "Clean" || step === "Typeset") && canClean;
  }

  function choosePalette(id: PaletteId, opts?: { showBrushSize?: boolean }) {
    if (id !== "reorder") reorderFromId = "";
    if (id === "mask-grow") growToolbarDismissed = false;
    if (id === "style-brush") {
      if (tool === id) {
        styleBrush = null;
        tool = "select";
        setBrushSizeOpen(false);
        return;
      }
      const layout = regionDoc?.data.layout;
      if (step !== "Typeset" || !canClean || busy || !selected || !layout) return;
      styleBrush = {
        sourceId: selected.id,
        style: {
          ...layout.style,
          size: layout.size,
          // Preserve the rendered colors instead of recalculating them on each bubble.
          autoContrast: false,
        },
      };
      cancelPolygon();
      drawing = null;
      pageTool = "select";
      tool = id;
      showRegions = true;
      notify(`Copied ${layout.size} pt style. Click regions to apply; press Esc to stop.`);
      setBrushSizeOpen(false);
      return;
    }
    styleBrush = null;
    if (id === "zoom") {
      if (zooming) {
        choosePalette(defaultTool(step));
        pageTool = "select";
        return;
      }
      cancelPolygon();
      tool = "zoom";
      pageTool = "zoom";
      setBrushSizeOpen(false);
      return;
    }
    if (id === "polygon") {
      startPolygon();
      setBrushSizeOpen(false);
      return;
    }
    if (id === "rectangle" || id === "oval") {
      cancelPolygon();
      if (!selected) {
        notify("Select a region to draw its text shape.");
        return;
      }
      if (regionDoc?.data.locked) {
        notify("Unlock this layout before changing its shape.");
        return;
      }
      tool = id;
      showRegions = true;
      setBrushSizeOpen(false);
      return;
    }
    cancelPolygon();
    setBrushSizeOpen(opts?.showBrushSize !== false && usesBrushSize(id));
    if (step === "Prepare") {
      pageTool = id === "crop" || id === "split" || id === "reslice" ? id : "select";
      tool = "select";
      return;
    }
    tool = id;
    if (id === "brush" || id === "erase" || id === "mask-grow") setMaskVisibility(true);
    if (id === "bubble-fill" || id === "clone-stamp" || id === "blur" || id === "restore" || id === "raw") compare = false;
    if (id === "clone-stamp") {
      if (!cloneSource) notify("Right-click to set the clone source, then click and drag to paint.");
    }
    if (id === "blur") {
      setMaskVisibility(false);
      notify("Paint over an inpainted seam. The brush has a soft edge so it blends into the gradient.");
    }
    if (id === "restore") {
      setMaskVisibility(false);
      if (!canRestore)
        notify("Nothing to restore. Save a cleaning pass first, then paint unwanted changes back.");
      else
        notify("Paint over unwanted reconstruction. The feathered brush brings back the previous save.");
    }
    if (id === "raw") {
      setMaskVisibility(false);
      if (!canPaintRaw)
        notify("Nothing to paint from the raw page. Clean first, then stamp uncleaned source pixels back.");
      else
        notify("Paint to copy uncleaned source pixels onto the working page. The brush has a soft edge like Restore.");
    }
    if (id === "reorder") {
      showRegions = true;
      const selectedId = pageLines.some((line) => line.id === lineId) ? lineId : "";
      reorderFromId = selectedId;
      if (selectedId) notify("Click the next region in reading order.");
      else notify("Click a starting region, then click each following region in order.");
    }
  }
  const paletteTool = $derived(
    zooming ? "zoom" : step === "Prepare" ? pageTool : tool,
  );
  const proofreadFollowUp = $derived(
    isPageImageOnlyEngine(aiModels.proofread.engine) &&
      !!page &&
      lastProofreadPageId(studioState?.jobs ?? [], aiModels.proofread.engine) === page.id,
  );
  onMount(() => {
    document.body.dataset.studioReady = "1";
    const narrow = window.matchMedia("(max-width: 760px)").matches;
    try {
      const saved =
        localStorage.getItem("scan.jobsPanel") ||
        (localStorage.getItem("scan.jobsOpen") === "1" ? "shown" : "collapsed");
      if (saved === "shown" || saved === "maximized" || saved === "collapsed")
        jobsPanel = saved;
      const layout = JSON.parse(localStorage.getItem("scan.studio.layout") || "{}");
      if (narrow) {
        pagesOpen = false;
        inspectorOpen = false;
        jobsPanel = "collapsed";
      } else {
        pagesOpen = typeof layout.pagesOpen === "boolean" ? layout.pagesOpen : true;
        inspectorOpen = typeof layout.inspectorOpen === "boolean" ? layout.inspectorOpen : true;
      }
      if (Number.isFinite(layout.pagesWidth))
        pagesWidth = clamp(layout.pagesWidth, 80, 280);
      if (Number.isFinite(layout.inspectorWidth))
        inspectorWidth = clamp(layout.inspectorWidth, 280, 640);
    } catch {
      jobsPanel = "collapsed";
      pagesOpen = !narrow;
      inspectorOpen = !narrow;
    }
    const params = new URLSearchParams(window.location.search);
    const initialStep = params.get("step");
    const initialPage = params.get("page");
    if (initialStep && steps.includes(initialStep)) {
      step = initialStep;
      choosePalette(defaultTool(initialStep), { showBrushSize: false });
    }
    if (initialPage) pageId = initialPage;
    saves.restore();
    void request(`${apiBase}/pages`)
      .then((d) => (pageUndoCount = d.undoCount))
      .catch(() => {});
    void request("/api/me/settings")
      .then((data) => (userRegionColors = parseColorMap(data.regionColors)))
      .catch(() => {});
    void refresh()
      .then(() => {
        preferenceRevision = studioState?.chapter.revision ?? 0;
        aliases = studioState?.preferences.aliases ?? "";
        translationPrefs =
          studioState?.preferences.translationPreferences ?? "";
        chapterDpi = String(studioState?.preferences.dpi ?? "");
        if (initialPage && studioState?.images.some((image) => image.id === initialPage))
          choosePage(initialPage);
        else if (step === "Prepare" && !initialPage) {
          prepView = "grid";
          if (!pageId && studioState?.images[0]) pageId = studioState.images[0].id;
        } else if (pageId || studioState?.images[0])
          choosePage(pageId || studioState!.images[0].id);
        scope = "page";
        if (["Clean", "Typeset"].includes(step)) {
          void loadBackend();
          recheckBackendWhenUnavailable();
        }
        void saves.flushAll();
      })
      .catch((e) => (error = String(e)));
    void request(`/api/ai/engines`)
      .then((data) => {
        engineOptions = data.engines;
        if (!engineOptions.some((e) => e.id === engine && e.available))
          engine = engineOptions.find((e) => e.available && !isPageImageOnlyEngine(e.id))?.id ?? engine;
      })
      .catch(() => {});
    let socket: WebSocket | null = null;
    let stopped = false;
    let reconnect: ReturnType<typeof setTimeout>;
    let refreshTimer: ReturnType<typeof setTimeout>;
    let jobsTimer: ReturnType<typeof setTimeout>;
    let fullRefreshPending = false;
    function scheduleChapterRefresh() {
      fullRefreshPending = true;
      clearTimeout(jobsTimer);
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        fullRefreshPending = false;
        void refresh().catch(() => {});
      }, 100);
    }
    function scheduleJobRefresh() {
      if (fullRefreshPending) return;
      clearTimeout(jobsTimer);
      jobsTimer = setTimeout(() => void refreshJobs().catch(() => {}), 100);
    }
    function connect() {
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?episodeId=${episode.id}`,
      );
      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "glossary:series" && Array.isArray(data.glossary))
            seriesTerms = data.glossary;
          if (data.type === "presence") return;
          if (data.type === "activity") return;
          if (data.type === "line:upsert" && saves.drafts.has(data.line?.id)) return;
          if (data.type === "job:changed") {
            scheduleJobRefresh();
            return;
          }
          if (data.type === "workflow:changed" && String(data.id || "").startsWith("region:")) {
            const id = data.id.slice(7);
            const have = studioState?.regions[id];
            if (busy || (have && have.revision >= data.revision)) return;
            fullRefreshPending = true;
            clearTimeout(jobsTimer);
            clearTimeout(refreshTimer);
            refreshTimer = setTimeout(() => {
              fullRefreshPending = false;
              // The HTTP response can arrive after this event. Do not fetch
              // the whole chapter when that response already applied the edit.
              if ((studioState?.regions[id]?.revision ?? -1) < data.revision)
                void refresh().catch(() => {});
            }, 100);
            return;
          }
          scheduleChapterRefresh();
        } catch {
          /* Polling remains available if the connection drops. */
        }
      };
      socket.onclose = () => {
        if (!stopped) reconnect = setTimeout(connect, 4000);
      };
      socket.onerror = () => socket?.close();
    }
    connect();
    window.addEventListener("beforeunload", saves.beforeUnload);
    const paste = (e: ClipboardEvent) => {
      if (
        (e.target as HTMLElement)?.closest("input,textarea,[contenteditable]")
      )
        return;
      const files = [...(e.clipboardData?.files ?? [])].filter((f) =>
        f.type.startsWith("image/"),
      );
      if (files.length) {
        e.preventDefault();
        addFiles(files);
        step = "Prepare";
      }
    };
    window.addEventListener("paste", paste);
    const timer = setInterval(() => {
      const live = socket?.readyState === WebSocket.OPEN;
      void (live ? refreshJobs() : refresh()).catch(() => {});
    }, 4000);
    return () => {
      stopped = true;
      clearTimeout(reconnect);
      clearTimeout(refreshTimer);
      clearTimeout(jobsTimer);
      for (const recheck of backendRecheckTimers) clearTimeout(recheck);
      backendRecheckTimers = [];
      socket?.close();
      clearInterval(timer);
      window.removeEventListener("paste", paste);
      window.removeEventListener("beforeunload", saves.beforeUnload);
      void saves.flushAll();
    };
  });
  function pageStepDone(imageId: string, kind: PageStep) {
    const doc = studioState?.pages[imageId];
    if (!doc || !studioState) return false;
    const lines = studioState.lines.filter((line) => line.imageId === imageId);
    const comments = (studioState.comments ?? []).filter((comment: { lineId?: string }) =>
      lines.some((line) => line.id === comment.lineId));
    const regions = lines.map((line) => ({ id: line.id, data: studioState?.regions[line.id]?.data }));
    return doc.data.completed?.[kind] === pageStepStamp(kind, doc.data, lines, comments, regions);
  }
  function pageMark(imageId: string): "done" | "check" | "todo" | "running" {
    const jobs = studioState?.jobs ?? [];
    const live = jobs.some((job) => {
      if (!["running", "queued", "cancelling"].includes(job.state)) return false;
      const pages = (job as { pages?: { image_id?: string; imageId?: string; state?: string }[] }).pages ?? [];
      return pages.some((entry) => (entry.image_id || entry.imageId) === imageId && (entry.state === "running" || entry.state === "queued" || !entry.state));
    });
    if (live) return "running";
    const key = ({ Translate: "translate", Review: "review", Clean: "clean", Typeset: "typeset" } as Record<string, PageStep | undefined>)[step];
    if (key && pageStepDone(imageId, key)) return "done";
    const codes: Record<string, string[]> = {
      Review: ["review", "english"],
      Clean: ["cleaning", "prepared"],
      Typeset: ["font", "layout", "stale", "glyphs", "overflow", "geometry"],
      Translate: ["review", "english"],
    };
    if ((studioState?.issues ?? []).some((issue) => issue.imageId === imageId && (codes[step] ?? []).includes(issue.code)))
      return "check";
    return "todo";
  }
  const stageCounts = $derived(Object.fromEntries(STUDIO_STAGE_ORDER.map((stage) => {
    const images = studioState?.images ?? [];
    if (stage.id === "prepare") {
      const stale = studioState?.issues.some((issue) => issue.code === "numbering");
      return [stage.label, `${images.length} pages${stale ? " · renumber" : ""}`];
    }
    if (stage.id === "export") {
      const n = studioState ? exportBlockers(studioState.issues).length : 0;
      return [stage.label, n ? `${n} blocker${n === 1 ? "" : "s"}` : "ready"];
    }
    const done = images.filter((img) => pageStepDone(img.id, stage.id as PageStep)).length;
    return [stage.label, images.length ? `${done}/${images.length}` : ""];
  })) as Record<string, string>);
  const activeTab = $derived(
    inspectorTab ||
      (step === "Prepare" ? "page" : step === "Review" ? "queue" : step === "Clean" ? "clean" : step === "Typeset" ? "text" : "regions"),
  );
  let dismissedJobId = $state("");
  const statusJob = $derived(
    latestTranslation && latestTranslation.id !== dismissedJobId &&
      (aiRunning || ["running", "queued", "failed"].includes(latestTranslation.state))
      ? latestTranslation
      : null,
  );
  const pageNo = $derived(page && studioState ? studioState.images.indexOf(page) + 1 : 0);
  const attentionCount = $derived(
    pageLines.filter((line) => line.sourceState !== "ignored" && (line.status !== "approved" || !line.body.trim())).length,
  );
  function flashFind(find: string) {
    if (!find) return;
    const el = document.querySelector(`[data-find="${CSS.escape(find)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    el.classList.add("studio-flash");
    setTimeout(() => el.classList.remove("studio-flash"), 1400);
  }
  async function goStudioAction(action: StudioAction) {
    finderOpen = false;
    moreOpen = false;
    const go = action.go;
    if (go.stage) {
      const next = studioStepName(go.stage);
      if (step !== next) await switchStep(next);
    }
    if (go.prepView) prepView = go.prepView;
    if (go.scope) scope = go.scope;
    if (go.tab) inspectorTab = go.tab;
    if (go.subtab) detailTab = go.subtab;
    if (go.tool) choosePalette(go.tool as PaletteId);
    if (go.settings) {
      settingsSection = go.settings;
      modelsTab = go.models ?? "";
    }
    if (go.jobs) jobsPanel = "shown";
    if (go.menu === "keys") keysOpen = true;
    if (go.menu === "view") openMenu = "view";
    if (go.menu === "issues") issuesOpen = true;
    if (go.menu === "more") moreOpen = true;
    if ((go.menu === "region" || go.subtab || go.tab === "region" || go.tab === "text" || go.tab === "style" || go.tab === "shape") && pageLines.length && !pageLines.some((line) => line.id === lineId))
      lineId = pageLines[0].id;
    await tick();
    if ((go.menu === "page" || go.menu === "region") && page) {
      menu = {
        x: Math.min(window.innerWidth - 280, 360),
        y: 140,
        imageId: page.id,
        lineId: go.menu === "region" ? (selected?.id || pageLines[0]?.id) : undefined,
      };
    }
    await tick();
    flashFind(action.find);
  }
  async function reorderImages(order: string[]) {
    try {
      await request(`${apiBase}/images`, { order: order.map((id, index) => ({ id, sortOrder: index })) }, "PATCH");
      await refresh();
    } catch (e) {
      error = String(e);
    }
  }
  $effect(() => {
    const lines = pageLines;
    const current = step;
    untrack(() => {
      if (!["Translate", "Review"].includes(current) || !lines.length) return;
      if (lines.some((line) => line.id === lineId)) return;
      lineId = lines[0].id;
    });
  });
  function shiftPage(dir: -1 | 1) {
    if (!studioState) return;
    const index = studioState.images.findIndex((img) => img.id === pageId);
    const next = studioState.images[index + dir];
    if (next) choosePage(next.id);
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      finderOpen = !finderOpen;
      return;
    }
    if (finderOpen) return;
    if ((e.target as HTMLElement)?.closest("input,textarea,select,[contenteditable],dialog"))
      return;
    const shortcut = e.ctrlKey || e.metaKey;
    if ((e.key === "z" || e.key === "Z") && shortcut) {
      e.preventDefault();
      if (!e.repeat) pageSavedHistory(e.shiftKey ? "redo" : "undo");
      return;
    }
    if ((e.key === "y" || e.key === "Y") && shortcut && !e.shiftKey) {
      e.preventDefault();
      if (!e.repeat) pageSavedHistory("redo");
      return;
    }
    if (e.key === "Escape") {
      menu = null;
      openMenu = null;
      cropDraft = null;
      if (tool === "polygon") {
        if (polygonDraft.length >= 3) void completePolygon();
        else cancelPolygon();
        return;
      }
      if (tool === "rectangle" || tool === "oval") {
        drawing = null;
        tool = "select";
        return;
      }
      if (tool === "reorder" && reorderFromId) {
        reorderFromId = "";
        return;
      }
      pageTool = "select";
      tool = "select";
      reorderFromId = "";
      return;
    }
    if (e.key === "Enter" && tool === "polygon") {
      e.preventDefault();
      void completePolygon();
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && !shortcut && !e.altKey) {
      if (e.repeat || !selected || !canEdit) return;
      if ((tool === "polygon" && polygonDraft.length) || drawing) return;
      e.preventDefault();
      const pendingSource = !!studioState?.suggestions.some((s) =>
        s.line_id === selected.id && s.state === "pending" && isSourceSuggestion(s.kind) && !suggestionMatchesLine(s, selected));
      void deleteRegion(selected, deleteRegionNeedsConfirm(selected, {
        draft: saves.drafts.get(selected.id)?.patch,
        pendingSource,
      }));
      return;
    }
    if (e.key === "v" || e.key === "V") {
      cancelPolygon();
      tool = "select";
      pageTool = "select";
      reorderFromId = "";
    }
    if ((e.key === "z" || e.key === "Z") && !e.ctrlKey && !e.metaKey) {
      choosePalette("zoom");
    }
    if ((e.key === "b" || e.key === "B") && step === "Clean" && canClean)
      choosePalette("brush");
    if ((e.key === "e" || e.key === "E") && step === "Clean" && canClean)
      choosePalette("erase");
    if ((e.key === "f" || e.key === "F") && step === "Clean" && canClean)
      choosePalette("bubble-fill");
    if ((e.key === "c" || e.key === "C") && step === "Clean" && canClean)
      choosePalette("clone-stamp");
    if ((e.key === "l" || e.key === "L") && step === "Clean" && canClean)
      choosePalette("blur");
    if ((e.key === "h" || e.key === "H") && step === "Clean" && canClean)
      choosePalette("restore");
    if ((e.key === "s" || e.key === "S") && !e.ctrlKey && !e.metaKey && step === "Clean" && canClean)
      choosePalette("raw");
    if ((e.key === "g" || e.key === "G") && step === "Clean" && canClean)
      choosePalette("mask-grow");
    if ((e.key === "r" || e.key === "R") && canEdit && ["Translate", "Review"].includes(step))
      tool = "region";
    if ((e.key === "o" || e.key === "O") && canEdit && ["Translate", "Review"].includes(step))
      choosePalette("reorder");
  }}
  onclick={(e) => {
    if (openMenu && !(e.target as HTMLElement).closest(".ed-menu"))
      openMenu = null;
  }}
/>
<svelte:head><title>{episode.title} · {series.title} · {APP_NAME}</title></svelte:head>
<input
  hidden
  bind:this={importInput}
  type="file"
  multiple
  accept="image/*"
  onchange={(e) => {
    addFiles([...(e.currentTarget.files ?? [])]);
    step = "Prepare";
    e.currentTarget.value = "";
  }}
/>
<input
  hidden
  bind:this={replacementInput}
  type="file"
  accept=".psd,image/*"
  onchange={(e) => {
    void replaceFile(e.currentTarget.files?.[0]);
    e.currentTarget.value = "";
  }}
/>
<div
  class="studio editor-workspace"
  class:wait-cursor={waitCursor}
  class:has-wait-ptr={waitCursor && !!waitPtr}
  bind:this={studioEl}
  onpointermove={onWaitPointer}
  onpointerenter={onWaitPointer}
  onpointerleave={() => {
    waitPtr = null;
  }}
>
  {#if waitCursor && waitPtr}
    <div
      class="wait-ptr"
      aria-hidden="true"
      style="left: {waitPtr.x}px; top: {waitPtr.y}px"
    ></div>
  {/if}
  <RegionContextMenu
    bind:menu
    bind:typeSubmenu
    {typeSubmenuPos}
    bind:pageTool
    bind:strokes
    bind:menuEl={actionsMenuEl}
    bind:submenuEl={actionsSubmenuEl}
    target={studioState?.lines.find((l) => l.id === menu?.lineId)}
    regionDoc={menu?.lineId ? studioState?.regions[menu.lineId] : undefined}
    {pageDoc}
    pageId={page?.id ?? ""}
    {step}
    {canEdit}
    {canUpload}
    {canClean}
    {canChangeType}
    {busy}
    {aiRunning}
    fitting={typesetRunning()}
    {hasMaskRegions}
    {backend}
    psdHref={menu ? `${apiBase}/images/${menu.imageId}/psd?draft=1` : ""}
    pngHref={menu && (step === "Clean" || step === "Typeset")
      ? `${apiBase}/images/${menu.imageId}/png?variant=${step === "Clean" ? "clean" : "typeset"}`
      : ""}
    {regionKinds}
    ops={{
      openTypeSubmenu,
      saveRotation,
      savePlacedTransform,
      inheritedStyle,
      act,
      reread,
      edit,
      suggestAlternative,
      openRegionAi,
      openReviseEnglish,
      regionDetails,
      deleteRegion,
      setRegionFirst,
      setLineType,
      selectLine,
      switchStep,
      pageOperation,
      loadReslicePreview,
      insertAt,
      reorder,
      deletePage,
      describe,
      transcribePage,
      translatePage,
      rereadMissing,
      fillMissing,
      applyMask,
      approveMask,
      applyCleaningPass,
      cleanWith,
      compareRegion: (line: LineRow) => void openRegionCompare(line),
      saveCleaningSample: () => void saveCleaningSample(),
      fitPage,
      resetStyles,
      replaceFile: (imageId) => {
        replacementId = imageId;
        menu = null;
        replacementInput?.click();
      },
    }}
  />
  <StudioTopBar
    {series}
    {episode}
    {page}
    {step}
    counts={stageCounts}
    {canRebuild}
    chapterSelected={scope === "chapter"}
    onrebuild={() => saves.flushAll()}
    onswitch={(next) => { if (next === "Prepare") prepView = "grid"; void switchStep(next); }}
    exceptionCount={exceptions.length}
    exceptionLabel={upcomingException ? `${exceptions.length} to check · ${upcomingException.label}` : "Nothing to check"}
    onnextexception={() => void goToNextException()}
    onissues={() => (issuesOpen = !issuesOpen)}
    unsaved={drafts.length}
    onsettings={() => (settingsSection = settingsSection ?? "chapter")}
    bind:openMenu
    {pagesOpen}
    {inspectorOpen}
    jobsOpen={jobsPanel !== "collapsed"}
    {zoom}
    ontogglepane={(pane) => {
      if (pane === "pages") { pagesOpen = !pagesOpen; persistLayout(); }
      else if (pane === "inspector") { inspectorOpen = !inspectorOpen; persistLayout(); }
      else jobsPanel = jobsPanel === "collapsed" ? "shown" : "collapsed";
    }}
    onzoom={nudgeZoom}
    onresetzoom={() => (zoom = 100)}
    onshortcuts={() => (keysOpen = true)}
  >
    <button class="ed-btn" type="button" data-find="palette" aria-label="Find an action" onclick={() => (finderOpen = true)}><i class="bi bi-search" aria-hidden="true"></i><span class="txt">Find an action</span><kbd aria-hidden="true">Ctrl K</kbd></button>
  </StudioTopBar>
  <StudioToasts {error} {toasts} ondismisserror={() => (error = "")} ondismiss={dismissToast} />
  {#if issuesOpen}
    <div class="issues-pop" role="menu">
      {#each exceptions as item (item.id ?? item.label)}
        <button type="button" role="menuitem" onclick={() => { issuesOpen = false; void openException(item); }}>{item.label}</button>
      {:else}
        <p>Nothing to check.</p>
      {/each}
    </div>
  {/if}
  {#if !studioState}<p class="empty">Loading chapter…</p>{:else}
    <div class="studio-body">
      <PagesSidebar
        open={pagesOpen}
        width={pagesWidth}
        images={studioState.images}
        pages={studioState.pages}
        assetBase={apiBase}
        issues={studioState.issues}
        pageId={page?.id ?? ""}
        seriesTitle={series.title}
        filter={stripFilter}
        mark={pageMark}
        onfilter={(next) => (stripFilter = next)}
        onpage={choosePage}
        oncontextmenu={openActions}
        onhide={() => { pagesOpen = false; persistLayout(); }}
        onshow={() => { pagesOpen = true; persistLayout(); }}
        onresize={(e) => startResize(e, "pages")}
      />
      <div class="ed-main">
        <StageBar
          {step}
          {scope}
          pageLabel={page ? `Page ${pageNo}` : "Page"}
          showScope={step !== "Export" && step !== "Prepare" && step !== "Clean"}
          note={step === "Translate" && scope === "chapter" ? "Chapter transcribe skips pages that already have regions. To re-detect one page, delete its junk boxes and transcribe that page." : ""}
          onscope={(next) => (scope = next)}
        >
          {#if step === "Prepare"}
            <div class="seg" data-find="prep-view">
              <button type="button" class:on={prepView === "grid"} onclick={() => (prepView = "grid")}><i class="bi bi-grid-3x3-gap" aria-hidden="true"></i> Organize</button>
              <button type="button" class:on={prepView === "page"} onclick={() => (prepView = "page")}><i class="bi bi-file-image" aria-hidden="true"></i> Edit page</button>
            </div>
            <span class="vsep"></span>
            <span class="group-label">Whole chapter</span>
            <button type="button" class="ed-btn" data-find="split-spreads" disabled={busy || !canUpload} onclick={() => pageOperation({ op: "split" })}>Split spreads</button>
            <button type="button" class="ed-btn" data-find="auto-crop" disabled={busy || !canUpload} onclick={() => pageOperation({ op: "auto-crop" })}>Auto-crop</button>
            <button type="button" class="ed-btn" data-find="auto-align" disabled={busy || !canUpload} onclick={() => pageOperation({ op: "auto-align" })}>Auto-align</button>
            <button type="button" class="ed-btn" data-find="auto-reslice" disabled={busy || aiRunning || !canUpload} onclick={() => applyReslice()}>Auto-reslice</button>
          {:else if step === "Translate"}
            <button type="button" class="ed-btn primary" data-find="transcribe" aria-label={scope === "chapter" ? "Transcribe chapter" : "Transcribe page"} disabled={busy || !canUpload || (scope === "page" && !page)} onclick={() => scope === "chapter" || !page ? runAI("transcribe") : transcribePage(page.id)}><i class="bi bi-chat-square-text" aria-hidden="true"></i> Transcribe</button>
            <button type="button" class="ed-btn" data-find="translate" aria-label={scope === "chapter" ? "Translate chapter" : "Translate page"} disabled={busy || !canUpload || !translateGate.ok || (scope === "page" && !page)} title={translateGate.reason || undefined} onclick={() => scope === "chapter" || !page ? runAI("translate") : translatePage(page.id)}><i class="bi bi-translate" aria-hidden="true"></i> Translate</button>
            <button type="button" class="ed-btn" data-find="fill-missing" aria-label="Fill missing source &amp; English" title="Transcribe empty sources and fill empty English. Never overwrites." disabled={busy || !canEdit} onclick={() => fillMissing(scope === "page" ? page?.id : undefined)}><i class="bi bi-plus-square" aria-hidden="true"></i> Fill missing</button>
          {:else if step === "Review"}
            <button type="button" class="ed-btn" data-find="proofread-english" aria-label="Proofread edited English" disabled={busy || !canUpload || !proofreadEnglishGate.ok} title={proofreadEnglishGate.reason || undefined} onclick={() => runAI("proofread")}><i class="bi bi-spellcheck" aria-hidden="true"></i> Proofread English</button>
            <button type="button" class="ed-btn" data-find="accept-all" disabled={!canEdit || busy} onclick={async () => { const result = await act({ action: "approve-all-translations" }); if (result) notify(`Accepted ${result.approved} translation${result.approved === 1 ? "" : "s"}.`); }}><i class="bi bi-check2-all" aria-hidden="true"></i> Accept all translations</button>
          {:else if step === "Clean"}
            {@const maskDone = !!pageDoc?.data.maskApproved}
            {@const cleaned = !!pageDoc?.data.cleaned}
            {@const cleanApproved = !!page && pageStepDone(page.id, "clean")}
            <ol class="pipeline" data-find="clean-pipeline">
              {#each [["Mask", maskDone ? "done" : "now"], ["Remove", cleaned ? "done" : maskDone ? "now" : ""], ["Touch up", cleaned ? "now" : ""], ["Approve", cleanApproved ? "done" : ""]] as [label, state], i}
                <li class={state}><span>{#if state === "done"}<i class="bi bi-check" aria-hidden="true"></i>{:else}{i + 1}{/if}</span>{label}</li>
              {/each}
            </ol>
            <span class="vsep"></span>
            <span class="group-label">Next</span>
            {#if !maskDone && !pageDoc?.data.mask}
              <button type="button" class="ed-btn primary" data-find="detect-lettering" disabled={busy || !canClean} onclick={() => applyMask(true)}>Detect lettering</button>
            {:else if !maskDone}
              <button type="button" class="ed-btn primary" data-find="approve-mask" disabled={busy || !canClean} onclick={() => approveMask()}>Approve mask</button>
            {:else}
              <button type="button" class="ed-btn primary" data-find="approve-clean" disabled={busy || !canClean} onclick={() => approveCleanedAndNext()}>Approve cleaned &amp; next</button>
            {/if}
          {:else if step === "Typeset"}
            <button type="button" class="ed-btn primary" data-find="autofit-all" disabled={!canClean || busy || typesetRunning()} onclick={() => scope === "chapter" ? fitChapter() : fitPage()}><i class="bi bi-textarea-resize" aria-hidden="true"></i> {scope === "chapter" ? "Auto-fit chapter" : "Auto-fit all text"}</button>
            <button type="button" class="ed-btn" data-find="find-fit" disabled={!canClean || busy || typesetRunning()} onclick={() => scope === "chapter" ? fitChapter() : fitPage()}><i class="bi bi-bounding-box-circles" aria-hidden="true"></i> Find &amp; fit bubbles</button>
            <button type="button" class="ed-btn" data-find="keep-layouts" title="Accept stale placements instead of refitting" disabled={!canClean || busy} onclick={() => keepCurrentLayouts()}><i class="bi bi-pin-angle" aria-hidden="true"></i> Keep current layouts</button>
          {:else if step === "Export"}
            <span class="group-label">{exportBlockers(studioState.issues).length} items block a finished export · drafts and scripts can export now</span>
          {/if}
          {#if step !== "Export"}
            <button type="button" class="ed-btn ghost" data-find={`more-${step.toLowerCase()}`} onclick={() => (moreOpen = !moreOpen)}>More <i class="bi bi-chevron-down" aria-hidden="true"></i></button>
          {/if}
          {#snippet right()}
            {#if statusJob}
              <TranslationStatus
                job={statusJob}
                {canEdit}
                {canUpload}
                {busy}
                {aiRunning}
                onstop={() => cancelTranslation()}
                onretry={() => act({ action: "retry", jobId: statusJob.id })}
                onreview={() => reviewTranslations()}
                ondismiss={() => (dismissedJobId = statusJob.id)}
              />
            {/if}
            {#if step === "Translate" || step === "Review"}
              <button type="button" class="model-chip" data-find="detector-chip" title="Text detector for this chapter" onclick={() => (settingsSection = "detection")}><i class="bi bi-bounding-box-circles" aria-hidden="true"></i> {studioState?.detection ? `${detectorSetupLabel(studioState.detection.setup)} · ${studioState.detection.conf.toFixed(2)}` : "Text detector"}</button>
              <button type="button" class="model-chip" data-find="translate-model" aria-label="AI model settings…" title="Translation model for this chapter" onclick={() => (settingsSection = "models")}><i class="bi bi-cpu" aria-hidden="true"></i> {translateLabel} <i class="bi bi-chevron-down" aria-hidden="true"></i></button>
            {:else if step === "Typeset"}
              <button type="button" class="model-chip" data-find="type-settings-chip" onclick={openTypeSettings}><i class="bi bi-fonts" aria-hidden="true"></i> Series type settings</button>
            {/if}
          {/snippet}
        </StageBar>
        {#if moreOpen}
          <div class="more-menu" role="menu">
            {#if step === "Prepare"}
              <button type="button" role="menuitem" data-find="scene-notes" disabled={busy || aiRunning || !canUpload} onclick={() => { moreOpen = false; void describe(undefined, true); }}>Scene notes</button>
              <button type="button" role="menuitem" data-find="renumber" onclick={() => { moreOpen = false; void act({ action: "renumber" }); }}>Renumber pages</button>
              <button type="button" role="menuitem" disabled={busy || !pageUndoCount} onclick={() => { moreOpen = false; pageOperation({ op: "undo" }); }}>Undo page edit</button>
            {:else if step === "Translate" || step === "Review"}
              <button type="button" role="menuitem" disabled={busy || !canEdit} onclick={() => { moreOpen = false; void rereadMissing(scope === "page" ? page?.id : undefined); }}>Retry uncertain image reading</button>
              <button type="button" role="menuitem" disabled={busy || !canUpload} onclick={() => { moreOpen = false; void describe(page ? [page.id] : undefined, true); }}>Refresh scene context</button>
              <button type="button" role="menuitem" disabled={!canEdit || busy || !blankRegionCount} onclick={() => { moreOpen = false; void removeBlankRegions(); }}>Remove all blank regions</button>
              <button type="button" role="menuitem" disabled={!canEdit || busy || !page} onclick={() => { moreOpen = false; void removePageRegions(); }}>Remove all regions on this page</button>
              {#if step === "Translate"}
                <button type="button" role="menuitem" disabled={busy || !proofreadEnglishGate.ok} onclick={() => { moreOpen = false; void runAI("proofread"); }}>Proofread edited English</button>
              {:else}
                <button type="button" role="menuitem" data-find="copy-raw" disabled={!page} onclick={() => { moreOpen = false; page && copyPageImage("raw"); }}>Copy raw image</button>
                <button type="button" role="menuitem" data-find="copy-typeset" disabled={!page} onclick={() => { moreOpen = false; page && copyPageImage("typeset"); }}>Copy typeset image</button>
                <button type="button" role="menuitem" data-find="page-proofreader" disabled={!page} onclick={() => { moreOpen = false; void proofreadPageImages(); }}>Page proofreader</button>
              {/if}
            {:else if step === "Clean"}
              <button type="button" role="menuitem" disabled={busy || !canClean} onclick={() => { moreOpen = false; void applyMask(true); }}>Detect lettering again</button>
              <button type="button" role="menuitem" disabled={busy || !canClean} onclick={() => { moreOpen = false; void approveMask(); }}>Approve mask</button>
              <button type="button" role="menuitem" onclick={() => { moreOpen = false; void saveCleaningSample(); }}>Save sample raw / clean</button>
              <button type="button" role="menuitem" disabled={!page} onclick={() => { moreOpen = false; page && pageOperation({ op: "revert", imageId: page.id }); }}>Revert to original raw</button>
            {:else if step === "Typeset"}
              <button type="button" role="menuitem" disabled={!canClean || busy} onclick={() => { moreOpen = false; void resetStyles(scope === "chapter" ? "chapter" : "page"); }}>Reset {scope === "chapter" ? "chapter" : "page"} to series defaults</button>
              <button type="button" role="menuitem" disabled={!page} onclick={() => { moreOpen = false; page && copyPageImage("raw"); }}>Copy raw image</button>
              <button type="button" role="menuitem" disabled={!page} onclick={() => { moreOpen = false; page && copyPageImage("typeset"); }}>Copy typeset image</button>
              <button type="button" role="menuitem" disabled={!page} onclick={() => { moreOpen = false; void proofreadPageImages(); }}>Page proofreader</button>
            {/if}
          </div>
        {/if}
        <StudioBanners
          numberingStale={step === "Prepare" && studioState.issues.some((issue) => issue.code === "numbering")}
          onrenumber={() => act({ action: "renumber" })}
        >
          {#snippet selection()}
            {#if step === "Prepare" && canUpload && selectedPageIds.length && prepView !== "grid"}
              <div class="page-selection-actions" role="region" aria-label="Selected page actions">
                <strong>{selectedPageIds.length} selected</strong>
                <button class="ed-btn" disabled={pageSelectionBusy} onclick={extractSelectedPages}>Extract to chapter…</button>
                <button class="ed-btn danger" disabled={pageSelectionBusy} onclick={deleteSelectedPages}>Delete selected pages…</button>
                <button class="ed-btn" onclick={() => { selectedPageIds = []; pageSelectionAnchor = ""; }}>Clear selection</button>
              </div>
            {/if}
            {#if extractedChapter}
              <div class="page-selection-actions" role="status">
                <span>Copied {extractedChapter.pageCount} pages to chapter {extractedChapter.title}. Original pages kept.</span>
                <a href={`/series/${series.id}/episodes/${extractedChapter.id}`}>Open chapter {extractedChapter.title}</a>
                <button class="ed-btn" aria-label="Dismiss extraction result" onclick={() => (extractedChapter = null)}>×</button>
              </div>
            {/if}
          {/snippet}
          {#snippet conflicts()}
            {#each drafts.filter(([, d]) => d.error) as [id, d]}
              <div class="draft-conflict">
                <strong>{d.error}</strong>
                <p>Your unpublished draft and the saved version both exist. Compare them before choosing.</p>
                <p>Your draft: {JSON.stringify(d.patch)}</p>
                {#if d.conflict}<p>Current saved version: {JSON.stringify(d.conflict)}</p>
                  <button onclick={() => saves.retry(id, (d.conflict as LineRow).revision)}>Save my draft over this reviewed version</button>
                {:else}<button onclick={() => saves.retry(id)}>Retry save</button>{/if}
                <button onclick={() => { saves.discard(id); void refresh(); }}>Keep the saved version</button>
              </div>
            {/each}
          {/snippet}
        </StudioBanners>
        {#if step === "Prepare" && prepView === "grid"}
          <PrepareOrganize
            images={studioState.images}
            assetBase={apiBase}
            pages={studioState.pages}
            selectedIds={selectedPageIds}
            selectionDisabled={pageSelectionBusy}
            {canUpload}
            {busy}
            numberingStale={studioState.issues.some((issue) => issue.code === "numbering")}
            credits={studioState.credits ?? series.credits}
            seriesId={series.id}
            onopen={choosePage}
            onselect={selectPageThumbnail}
            onselectall={(selected) => {
              selectedPageIds = selected ? studioState!.images.map((image) => image.id) : [];
              pageSelectionAnchor = "";
            }}
            onreorder={reorderImages}
            onaddfiles={addFiles}
            onaddcredits={() => pageOperation({ op: "add-credits" })}
            onextract={extractSelectedPages}
            ondelete={deleteSelectedPages}
          />
        {:else if step === "Export"}
          <section class="prepare">
              <ExportPanel
                images={studioState.images}
                pageDocs={studioState.pages}
                stepDone={pageStepDone}
                issues={studioState.issues}
                {canEdit}
                {canClean}
                {busy}
                {pendingExportDownload}
                bind:exportFormat
                bind:quality
                bind:includeExportMetadata
                bind:draftExport
                bind:previewCopied
                {previewUrl}
                {latestExport}
                downloadHref={latestExport?.progress?.artifact ? `${asset(latestExport.progress.artifact)}?download=${encodeURIComponent(latestExport.progress.filename || "export.zip")}` : ""}
                downloadName={latestExport?.progress?.filename || "ZIP"}
                onapprovegeometry={async () => {
                  const result = await act({ action: "approve-all-geometry" });
                  if (result) notify(`Approved geometry for ${result.approved} region${result.approved === 1 ? "" : "s"}.`);
                }}
                onapprovetranslations={async () => {
                  const result = await act({ action: "approve-all-translations" });
                  if (result) notify(`Accepted ${result.approved} translation${result.approved === 1 ? "" : "s"}.`);
                }}
                onkeeplayouts={keepCurrentLayouts}
                onmarkall={async () => {
                  if (!confirm("Mark every page complete in Translate, Review, Clean, and Typeset? The current text, artwork, and revision history stay."))
                    return;
                  const result = await act({ action: "mark-all-complete" });
                  if (result) notify(`Marked ${result.pages} page${result.pages === 1 ? "" : "s"} complete.`);
                }}
                onexport={() => act({ action: "export", format: exportFormat, draft: draftExport, quality, includeMetadata: includeExportMetadata })}
                onpreviewshare={previewShare}
                onissue={(issue) => {
                  if (issue.imageId) choosePage(issue.imageId);
                  if (issue.lineId) selectLine(issue.lineId);
                  step =
                    issue.code === "numbering" || issue.code === "credits"
                      ? "Prepare"
                      : ["cleaning", "prepared"].includes(issue.code)
                        ? "Clean"
                        : ["font", "layout", "stale", "glyphs", "overflow", "geometry"].includes(issue.code)
                          ? "Typeset"
                          : "Review";
                }}
              />
          </section>
        {:else}
          <div class="canvas-column">
          <ToolOptionsBar
            tool={paletteTool}
            bind:radius
            bind:growAmount
            polygonCount={polygonDraft.length}
            canCompletePolygon={polygonDraft.length >= 3}
            oncompletepolygon={() => void completePolygon()}
            onapplyreslice={() => void applyReslice()}
            hasReslicePreview={!!reslicePreview?.cuts.length}
            onstopstyle={() => (styleBrush = null)}
          />
          <div class="canvas-and-panel">
            <ToolRail
              {step}
              tool={paletteTool}
              {canEdit}
              {canClean}
              {canUpload}
              showPolygon={!!selected && step === "Typeset"}
              canCopyStyle={!!selected && !!regionDoc?.data.layout && !busy}
              onselect={choosePalette}
            />
            <div class="canvas-stage">
            <WorkflowCanvas
              {page}
              {step}
              {pageTool}
              {tool}
              {zoom}
              {zooming}
              {compare}
              {showMask}
              {showRegions}
              {canEdit}
              {canClean}
              {busy}
              {lineId}
              {radius}
              {regionLabelScale}
              {colorFor}
              {labelFor}
              {pageImage}
              {cloneSource}
              {cloneOffset}
              {cloneEpoch}
              {blurEpoch}
              {restoreEpoch}
              onclonesource={setCloneSource}
              {pageDoc}
              {regionDoc}
              {selected}
              {pageLines}
              {strokes}
              bind:drawing
              bind:polygonDraft
              bind:cropDraft
              bind:splitPosition
              bind:canvasWidth
              bind:svgEl
              bind:prepElement
              bind:canvasScrollEl
              {reslicePreview}
              {selectedPolygon}
              scrollAction={canvasScroll}
              regionLayout={(id: string) => studioState?.regions[id]?.data.layout}
              regionTextMask={(id: string) => studioState?.regions[id]?.data.textMask}
              {overlayStyle}
              {adjustedBounds}
              {rotationCenter}
              {rotationAngle}
              {skewAngle}
              {asset}
              {openActions}
              {prepDown}
              {prepUp}
              {prepPoint}
              {down}
              {move}
              {up}
              {dragRegion}
              {selectLine}
              {reorderFromId}
              onreorderclick={clickReorder}
              onstylebrush={paintStyle}
              {startRotation}
              {rotationKey}
              {startSkew}
              {skewKey}
              oncompletepolygon={completePolygon}
              onact={act}
              onnotify={notify}
            />
            <ViewBar
              pageIndex={page ? studioState.images.indexOf(page) + 1 : 0}
              pageCount={studioState.images.length}
              {showRegions}
              {showMask}
              {compare}
              maskLabel={step === "Typeset" ? "Display text mask" : "Display mask"}
              compareLabel={step === "Review" ? (compare ? "Show typeset" : "Show raw") : compare ? "Show result" : "Compare source"}
              {zoom}
              showRegionsToggle={step !== "Prepare"}
              showMaskToggle={step === "Clean" || step === "Typeset"}
              showCompareToggle={step !== "Prepare"}
              onpage={shiftPage}
              onregions={() => (showRegions = !showRegions)}
              onmask={() => setMaskVisibility(!(showMask && !compare))}
              oncompare={() => (compare = !compare)}
              onzoom={(next) => { zoom = next === "fit" ? 100 : clamp(next, 25, 2000); }}
            />
            </div>
          </div>
          <PageFooter
            pageNumber={page ? studioState.images.indexOf(page) + 1 : "—"}
            info={!page
              ? "No page"
              : step === "Translate" || step === "Review"
                ? `${pageLines.length} region${pageLines.length === 1 ? "" : "s"}`
                : step === "Clean"
                  ? `mask ${pageDoc?.data.maskApproved ? "approved" : pageDoc?.data.mask ? "needs approval" : "not detected"} · ${pageDoc?.data.cleaned ? "cleaned" : "not cleaned"}`
                  : `${page.width} × ${page.height}`}
            attention={step === "Translate" || step === "Review" ? attentionCount : 0}
            done={!!page && ["Translate", "Review", "Clean", "Typeset"].includes(step) && pageStepDone(page.id, step.toLowerCase() as PageStep)}
            stepLabel={step}
            {canEdit}
            {busy}
            showMark={["Translate", "Review", "Clean", "Typeset"].includes(step)}
            onundo={() => pageSavedHistory("undo")}
            onredo={() => pageSavedHistory("redo")}
            onmark={() => void forgetPageHistory()}
            onnext={() => shiftPage(1)}
          />
          </div>
        {/if}
      </div>
      {#if step !== "Export" && inspectorOpen}
      <div
        class="splitter"
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        aria-label="Resize inspector"
        onpointerdown={(e) => startResize(e, "inspector")}
        ondblclick={() => { inspectorOpen = false; persistLayout(); }}
      ></div>
      <aside class="bilingual" style={`width:${inspectorWidth}px`}>
        <div class="page-commands">
          <div class="pane-title">
            <span>Inspector</span>
            <button class="icon-btn" type="button" title="Hide inspector" aria-label="Hide inspector" onclick={() => { inspectorOpen = false; persistLayout(); }}><i class="bi bi-chevron-bar-right" aria-hidden="true"></i></button>
          </div>
          <div class="insp-tabs" role="tablist" aria-label="Inspector">
            {#if step === "Prepare"}
              <button type="button" role="tab" aria-selected={activeTab === "page"} data-find="tab-prepare-page" onclick={() => (inspectorTab = "page")}>Page {pageNo}</button>
              <button type="button" role="tab" aria-selected={activeTab === "upload"} data-find="tab-upload" onclick={() => (inspectorTab = "upload")}>Upload{#if pendingFiles.length} <span class="badge">{pendingFiles.length}</span>{/if}</button>
              <button type="button" role="tab" aria-selected={activeTab === "credits"} data-find="tab-credits" onclick={() => (inspectorTab = "credits")}>Credits</button>
            {:else if step === "Translate"}
              <button type="button" role="tab" aria-selected={activeTab === "regions"} onclick={() => (inspectorTab = "regions")}>Regions <span class="badge">{pageLines.length}</span></button>
              <button type="button" role="tab" aria-selected={activeTab === "page"} data-find="tab-page-script" onclick={() => (inspectorTab = "page")}>Page &amp; script</button>
            {:else if step === "Review"}
              <button type="button" role="tab" aria-selected={activeTab === "queue"} data-find="tab-review-queue" onclick={() => (inspectorTab = "queue")}>To review <span class="badge">{reviewLines.length}</span></button>
              <button type="button" role="tab" aria-selected={activeTab === "page"} onclick={() => (inspectorTab = "page")}>Page &amp; script</button>
              <button type="button" role="tab" aria-selected={activeTab === "glossary"} data-find="tab-glossary" onclick={() => (inspectorTab = "glossary")}>Glossary</button>
            {:else if step === "Clean"}
              <button type="button" role="tab" aria-selected={activeTab === "clean"} onclick={() => (inspectorTab = "clean")}>Clean page {pageNo}</button>
            {:else if step === "Typeset"}
              <button type="button" role="tab" aria-selected={activeTab === "text"} data-find="tab-text" onclick={() => (inspectorTab = "text")}>Text</button>
              <button type="button" role="tab" aria-selected={activeTab === "style"} data-find="tab-style" onclick={() => (inspectorTab = "style")}>Style</button>
              <button type="button" role="tab" aria-selected={activeTab === "shape"} data-find="tab-shape" onclick={() => (inspectorTab = "shape")}>Shape &amp; mask</button>
            {/if}
          </div>
        </div>
        {#if step === "Prepare" && activeTab === "upload"}
          {@render prepareSettings("upload")}
        {:else if step === "Prepare" && activeTab === "credits"}
          {@render prepareSettings("credits")}
        {:else if step === "Prepare"}
          <PageInspector
            image={page ?? null}
            index={page ? studioState.images.indexOf(page) : -1}
            total={studioState.images.length}
            {canEdit}
            canDescribe={canUpload}
            canDelete={false}
            canRetranslate={false}
            describing={busy || aiRunning}
            oncaption={caption}
            ondescribe={() => page && describe([page.id], true)}
            onreplace={page && canUpload ? () => { replacementId = page.id; replacementInput?.click(); } : undefined}
            ondelete={() => deletePage(page!.id)}
            onretranslate={() => translatePage(page!.id)}
          />
          <section class="sec">
            <h3>Scene notes model</h3>
            <RegionAiSettings
              settings={studioState.preferences.regionAi}
              fallback={{ engine, model }}
              engines={engineOptions}
              tasks={["describe"]}
              disabled={!canEdit || busy}
              onsave={saveRegionAi}
            />
          </section>
          <section class="sec" data-find="nudge">
            <h3>Nudge page</h3>
            <div class="nudge">
              <button type="button" class="icon-only" aria-label="Nudge up" title="Nudge up" disabled={busy || !page} onclick={() => page && pageOperation({ op: "nudge", imageId: page.id, dx: 0, dy: -nudgeAmount })}><i class="bi bi-arrow-up" aria-hidden="true"></i></button>
              <button type="button" class="icon-only" aria-label="Nudge left" title="Nudge left" disabled={busy || !page} onclick={() => page && pageOperation({ op: "nudge", imageId: page.id, dx: -nudgeAmount, dy: 0 })}><i class="bi bi-arrow-left" aria-hidden="true"></i></button>
              <input type="number" min="1" max="200" bind:value={nudgeAmount} aria-label="Nudge pixels" title="Pixels" />
              <button type="button" class="icon-only" aria-label="Nudge right" title="Nudge right" disabled={busy || !page} onclick={() => page && pageOperation({ op: "nudge", imageId: page.id, dx: nudgeAmount, dy: 0 })}><i class="bi bi-arrow-right" aria-hidden="true"></i></button>
              <button type="button" class="icon-only" aria-label="Nudge down" title="Nudge down" disabled={busy || !page} onclick={() => page && pageOperation({ op: "nudge", imageId: page.id, dx: 0, dy: nudgeAmount })}><i class="bi bi-arrow-down" aria-hidden="true"></i></button>
            </div>
          </section>
          {#if pageTool === "reslice"}
            <p>Cut on white rows so bubbles and art that crossed the old file boundary stay on one page. Click to add or remove a cut, then apply from the palette.</p>
          {/if}
        {:else if step === "Review" && activeTab === "glossary"}
          {@render translationSettings("glossary")}
        {:else if step === "Translate" || step === "Review"}
          <TranslateInspector
            {colorFor}
            view={step === "Review" ? (activeTab === "page" ? "page" : "queue") : activeTab === "page" ? "page" : "regions"}
            queueLines={reviewLines}
            bind:subtab={detailTab}
            page={page ?? null}
            images={studioState.images}
            {canEdit}
            {canChangeType}
            {busy}
            {aiRunning}
            bind:scriptText
            bind:query
            bind:unresolvedOnly
            unplaced={studioState.lines.filter((l) => !l.placed || !l.imageId)}
            searchHits={studioState.lines
              .filter((l) => `${l.source} ${l.body}`.toLowerCase().includes(query.toLowerCase()))
              .map((line) => ({
                line,
                pageNumber: studioState!.images.find((p) => p.id === line.imageId)?.pageNumber ?? "—",
              }))}
            {visibleLines}
            {pageLines}
            {lineId}
            sourceLabel={studioState.preferences.lang === "japanese" ? "Japanese source" : "Korean source"}
            japanese={studioState.preferences.lang === "japanese"}
            suggestions={studioState.suggestions.filter((s) => {
              if (s.state !== "pending") return false;
              const line = studioState!.lines.find((l) => l.id === s.line_id);
              return !line || !suggestionMatchesLine(s, line);
            })}
            regionOverflow={(id) => !!studioState!.regions[id]?.data.layout?.overflow}
            glossary={seriesTerms}
            {regionKinds}
            {selected}
            comments={studioState.comments.filter((c) => selected && c.lineId === selected.id)}
            bind:history
            bind:commentText
            bind:commentCorrection
            bind:splitAt
            bind:mergeId
            bind:commentsEl={commentsDetails}
            bind:boundsEl={boundsDetails}
            oncaption={caption}
            ondescribe={() => page && describe([page.id], true)}
            onimportscript={importScript}
            onplace={(id) => {
              lineId = id;
              tool = "place-line";
              notify("Draw the box for this line on the selected page.");
            }}
            onnextissue={nextIssue}
            onselect={selectLine}
            onactions={openActions}
            onsettype={setLineType}
            onedit={edit}
            onreview={(line) => openRegionAi(line, "review")}
            onrevise={openReviseEnglish}
            onenquire={(line) => openRegionAi(line, "enquire")}
            onapprove={approveAndNext}
            onsuggest={suggestAlternative}
            ondecide={decideSuggestion}
            onreaddrawing={async (line, image, signal) =>
              request(
                `${apiBase}/region-ai`,
                {
                  action: "read-drawing",
                  lineId: line.id,
                  expectedRevision: line.revision,
                  image,
                },
                "POST",
                signal,
              )}
            oncommentinput={(comment, body) => {
              saves.queue(`comment:${comment.id}`, { body }, comment.revision ?? 0);
              studioState!.comments = studioState!.comments.map((c) =>
                c.id === comment.id ? { ...c, body } : c,
              );
            }}
            ondeletecomment={async (id) => {
              try {
                await request(`${apiBase}/comments/${id}`, {}, "DELETE");
                saves.discard(`comment:${id}`);
                await refresh();
              } catch (e) {
                error = String(e);
              }
            }}
            onaddcomment={addComment}
            onsplit={() =>
              act({
                action: "split",
                id: selected!.id,
                at: splitAt,
                expectedRevision: selected!.revision,
              })}
            onmerge={() =>
              act({
                action: "merge",
                id: selected!.id,
                otherId: mergeId,
                expectedRevision: selected!.revision,
                otherRevision: studioState!.lines.find((l) => l.id === mergeId)?.revision,
              })}
            onshowhistory={async () =>
              (history = (await request(`${apiBase}/workflow?history=${selected!.id}`)).history)}
            onrestore={(h) => {
              const old = JSON.parse(h.data);
              const patch = Object.fromEntries(
                ["body", "source", "sourceState", "ignoreReason", "lineType", "x", "y", "w", "h", "sortOrder"]
                  .filter((key) => key in old)
                  .map((key) => [key, old[key]]),
              );
              edit(selected!, { ...patch, status: "needs_work" });
            }}
          />
        {:else if step === "Clean"}
          <CleanInspector
            {showMask}
            bind:expansion
            bind:maskEngine
            strokeCount={strokes.length}
            maskApproved={!!pageDoc?.data.maskApproved}
            bind:cloneX
            bind:cloneY
            {backend}
            {pageDoc}
            ontogglemask={setMaskVisibility}
            {canClean}
            {busy}
            hasMaskRegions={pageLines.length > 0}
            ondetect={() => void applyMask(true)}
            onapprovemask={() => void approveMask()}
            onclean={(method) => void cleanWith(method)}
            onapplypass={() => void applyCleaningPass()}
            onapproveclean={() => void approveCleanedAndNext()}
            onclearstrokes={() => (strokes = [])}
          />
        {:else if step === "Typeset"}
          <TypesetInspector
            {selected}
            {regionDoc}
            regionIndex={selected ? pageLines.indexOf(selected) + 1 : 0}
            {canEdit}
            {canClean}
            {canUpload}
            {busy}
            bind:regionStyle
            fonts={studioState.fonts}
            stale={!!selected && studioState.issues.some((issue) => issue.lineId === selected.id && issue.code === "stale")}
            {regionKinds}
            onedit={edit}
            onsettype={setLineType}
            onapplystyle={applyStyle}
            onloadstyle={() => {
              styleRevision = regionDoc!.revision;
              regionStyle = {
                ...inheritedStyle(selected!.lineType),
                ...regionDoc!.data.style,
              };
            }}
            onresetstyle={() => selected && resetRegionStyle(selected)}
            onfit={() => selected && regionDoc && act({ action: "fit", id: selected.id, expectedRevision: regionDoc.revision })}
            tab={activeTab === "style" || activeTab === "shape" ? activeTab : "text"}
            onlock={() => selected && regionDoc && act({ action: "region", id: selected.id, expectedRevision: regionDoc.revision, data: { locked: !regionDoc.data.locked } })}
            onrectangle={() => void rectanglePolygon()}
            onfitbubble={() => selected && page && act({ action: "geometry", imageId: page.id, lineId: selected.id, expectedRevision: pageDoc?.revision ?? 0, method: "opencv" })}
            canSegmentBubble={!!backend?.models?.some((m) => m.tasks.includes("segmentBubble"))}
            onrefinebubble={() => selected && page && act({
              action: "geometry",
              imageId: page.id,
              lineId: selected.id,
              expectedRevision: pageDoc?.revision ?? 0,
              method: backend?.models?.find((m) => m.tasks.includes("segmentBubble"))?.id,
              points: bubbleFitPoints(selected, polygonDraft),
            })}
            onapprovegeometry={() => selected && regionDoc && act({ action: "region", id: selected.id, expectedRevision: regionDoc.revision, data: { geometryApproved: true } })}
          />
        {/if}
        {#if selected && regionDoc && step === "Typeset"}
          <RegionGeometryPanel {regionDoc} />
        {/if}
      </aside>
      {:else if step !== "Export"}
      <button class="edge-tab right" type="button" onclick={() => { inspectorOpen = true; persistLayout(); }}>Inspector</button>
      {/if}
    </div>
    <JobsPanel
      jobs={studioState.jobs}
      mode={jobsPanel}
      flash={jobsFlash}
      pageLabel={jobPageLabel}
      {asset}
      onmode={(m) => {
        jobsPanel = m;
        persistJobsPanel();
      }}
      onretry={(id) => act({ action: "retry", jobId: id })}
      oncancel={(id) => act({ action: "cancel", jobId: id })}
      onclear={() => act({ action: "clear-finished" })}
      onopencritique={(id) => { proofreadJobId = id; }}
    />
    <StudioSettingsDrawer bind:section={settingsSection}>
      {#snippet body(id)}
        {#if id === "chapter"}{@render prepareSettings("defaults")}
        {:else if id === "detection"}{@render translationSettings("detection")}
        {:else if id === "models"}{@render translationSettings("models")}
        {:else if id === "guide"}{@render translationSettings("guide")}
        {:else if id === "credits"}{@render prepareSettings("credits")}
        {:else if id === "typography"}
          <SeriesTypeDialog
            embedded
            fonts={studioState?.fonts ?? []}
            seriesId={series.id}
            revision={studioState?.seriesDefaults.revision ?? 0}
            prefs={studioState?.seriesDefaults.data ?? {}}
            canManage={canUpload || canClean}
            onsave={saveSeriesType}
            onupload={canUpload || canClean ? uploadSeriesFont : undefined}
            onclose={() => (settingsSection = null)}
          />
        {:else if id === "colors"}
          <RegionColorDialog
            embedded
            kinds={colorKinds}
            seriesKinds={regionKinds}
            userColors={userRegionColors}
            seriesCustom={!!studioState?.seriesDefaults.data.regionKinds}
            canEditSeries={canEditSeriesKinds}
            seriesTitle={series.title}
            onclose={() => (settingsSection = null)}
            onsaveuser={saveUserRegionColors}
            onsaveseries={saveSeriesKinds}
          />
        {/if}
      {/snippet}
    </StudioSettingsDrawer>
  {/if}
{#snippet prepareSettings(section: "full" | "upload" | "credits" | "defaults")}
  {#if studioState}
    <PrepareChapterPanel
      {section}
      {canUpload}
      {canEdit}
      {busy}
      {aiRunning}
      hasPage={!!page}
      {pageUndoCount}
      {duplicateWarning}
      numberingStale={studioState.issues.some((issue) => issue.code === "numbering")}
      bind:pendingFiles
      bind:stitch
      bind:chapterDpi
      preferences={studioState.preferences}
      {engine}
      {model}
      engines={engineOptions}
      seriesId={series.id}
      credits={studioState.credits ?? series.credits}
      images={studioState.images}
      onaddfiles={addFiles}
      onupload={upload}
      onreorder={reorder}
      onrenumber={() => act({ action: "renumber" })}
      onpageop={pageOperation}
      onreslice={() => applyReslice()}
      ondescribe={() => describe(undefined, true)}
      onsaveregionai={saveRegionAi}
      onsaveprefs={(data) => act({ action: "preferences", expectedRevision: studioState!.chapter.revision, data })}
      onsavedpi={() => act({ action: "preferences", expectedRevision: preferenceRevision, data: { dpi: chapterDpi ? Number(chapterDpi) : null } })}
      onuploadcredit={uploadSeriesCredit}
      onclearcredit={clearSeriesCredit}
    />
  {/if}
{/snippet}
{#snippet translationSettings(section: "full" | "models" | "detection" | "guide" | "glossary")}
  {#if studioState}
    <TranslateChapterPanel
      {section}
      {step}
      {canEdit}
      {canUpload}
      {busy}
      {aiRunning}
      {blankRegionCount}
      hasLines={!!studioState.lines.length}
      bind:aliases
      bind:translationPrefs
      preferences={studioState.preferences}
      detectorDefaults={studioState.detectorDefaults}
      detection={studioState.detection}
      {engine}
      {model}
      engines={engineOptions}
      {translationModel}
      visionLabel={`${engineOptions.find((en) => en.id === aiModels.vision.engine)?.label ?? aiModels.vision.engine}${aiModels.vision.model ? ` · ${aiModels.vision.model}` : ""}`}
      translateLabel={`${engineOptions.find((en) => en.id === aiModels.translate.engine)?.label ?? aiModels.translate.engine}${aiModels.translate.model ? ` · ${aiModels.translate.model}` : ""}`}
      {transcriptionLabel}
      {transcribeEstimate}
      {reviewPendingCount}
      {seriesTerms}
      glossaryMine={glossaryMineJob ? {
        jobId: glossaryMineJob.id,
        state: glossaryMineJob.state,
        message: glossaryMineJob.progress?.message,
        terms: glossaryMineJob.progress?.terms ?? [],
      } : null}
      {glossaryModel}
      embeddedModels={section === "models"}
      {modelsTab}
      onclosemodels={() => (settingsSection = null)}
      onsavetranslationmodel={saveTranslationModel}
      onsaveregionai={saveRegionAi}
      onprefs={(data) => act({ action: "preferences", expectedRevision: studioState!.chapter.revision, data })}
      onrunai={runAI}
      onreview={() => reviewTranslations()}
      onremoveblanks={removeBlankRegions}
      onstop={cancelTranslation}
      onrereadmissing={() => rereadMissing()}
      onfillmissing={() => fillMissing()}
      onseriesglossary={async (terms) => {
        try {
          await request(`/api/series/${series.id}`, { glossary: terms }, "PATCH");
          seriesTerms = terms;
        } catch (e) {
          error = String(e);
        }
      }}
      onextractglossary={async () => {
        try {
          if (!(await saves.flushAll())) throw new Error("Resolve unsaved drafts first");
          await act({
            action: "glossary-mine",
            engine: glossaryModel?.engine,
            model: glossaryModel?.model || undefined,
          });
          notify("Extracting series terms from the reviewed script.");
        } catch (e) {
          error = String(e);
        }
      }}
      onglossarymodel={(next) => void saveEnquireModel(next)}
      onglossarydecide={async (source, decision) => {
        if (!glossaryMineJob) return;
        try {
          const result = await act({
            action: "glossary-decide",
            jobId: glossaryMineJob.id,
            decisions: [{ source, decision }],
          });
          if (result?.glossary) seriesTerms = result.glossary;
          await refresh();
        } catch (e) {
          error = String(e);
        }
      }}
      onsavedefaults={() => act({ action: "preferences", expectedRevision: preferenceRevision, data: { aliases, translationPreferences: translationPrefs } })}
      onloaddefaults={() => {
        preferenceRevision = studioState!.chapter.revision;
        aliases = studioState!.preferences.aliases;
        translationPrefs = studioState!.preferences.translationPreferences;
      }}
    />
  {/if}
{/snippet}
<ActionFinder bind:open={finderOpen} bind:query={finderQuery} onpick={(action) => void goStudioAction(action)} />
{#if keysOpen}
  <div class="keys-backdrop" role="presentation" onclick={() => (keysOpen = false)}></div>
  <div class="keys-dialog" role="dialog" aria-label="Keyboard shortcuts" data-find="keys">
    <header>
      <strong>Keyboard shortcuts</strong>
      <button type="button" aria-label="Close keyboard shortcuts" onclick={() => (keysOpen = false)}>×</button>
    </header>
    <ul>
      <li>Ctrl K — Find an action</li>
      <li>V select · R draw region · O reorder · B brush · E erase · G grow mask · Z zoom</li>
      <li>Ctrl Z undo saved edit · Ctrl Shift Z redo</li>
      <li>Escape closes menus and cancels a crop or an unfinished polygon</li>
    </ul>
  </div>
{/if}
  <SeriesTypeDialog
    fonts={studioState?.fonts ?? []}
    seriesId={series.id}
    revision={studioState?.seriesDefaults.revision ?? 0}
    prefs={studioState?.seriesDefaults.data ?? {}}
    canManage={canUpload || canClean}
    onsave={saveSeriesType}
    onupload={canUpload || canClean ? uploadSeriesFont : undefined}
  />
  <RegionColorDialog
    bind:this={regionColorDialog}
    kinds={colorKinds}
    seriesKinds={regionKinds}
    userColors={userRegionColors}
    seriesCustom={!!studioState?.seriesDefaults.data.regionKinds}
    canEditSeries={canEditSeriesKinds}
    seriesTitle={series.title}
    onsaveuser={saveUserRegionColors}
    onsaveseries={saveSeriesKinds}
  />
</div>

<style>
  .page-selection-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--ed-line, var(--hud-line));
    background: var(--ed-panel, var(--hud-bg-2));
    font-size: 12px;
  }
  .page-selection-actions a {
    color: var(--ed-active, var(--hud-teal));
  }
  .page-selection-actions .danger {
    color: var(--ed-danger, #ff5d73);
  }
  .translation-help {
    margin: 0.4rem 0;
    font-size: 0.8rem;
    color: var(--ed-muted);
  }

  .menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1000;
  }
  .actions-menu {
    position: fixed;
    z-index: 1001;
    width: 240px;
    max-width: calc(100vw - 16px);
    max-height: calc(100vh - 16px);
    overflow: auto;
    background: var(--hud-bg-2);
    border: 1px solid var(--hud-line);
    border-radius: 2px;
    padding: 4px;
    box-shadow: 0 12px 40px #0009;
    display: flex;
    flex-direction: column;
    gap: 1px;
    font-size: 12px;
  }
  .actions-menu button,
  .actions-menu a,
  .actions-submenu button {
    text-align: left;
    padding: 3px 7px;
    font-size: 12px;
    line-height: 1.35;
    min-height: 24px;
    flex-shrink: 0;
  }
  .actions-menu strong {
    padding: 3px 7px;
    font-size: 11px;
    line-height: 1.3;
    color: var(--ed-muted);
  }
  .menu-flyout {
    position: relative;
  }
  .menu-flyout > button {
    width: 100%;
  }
  .menu-flyout > button::after {
    content: "›";
    float: right;
    opacity: 0.7;
  }
  .actions-submenu {
    position: fixed;
    z-index: 1002;
    width: 160px;
    max-width: calc(100vw - 16px);
    max-height: calc(100vh - 16px);
    overflow: auto;
    padding: 4px;
    background: var(--hud-bg-2);
    border: 1px solid var(--hud-line);
    border-radius: 2px;
    box-shadow: 0 12px 40px #0009;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .actions-submenu button.active {
    color: var(--accent);
  }
  .region-type-bar,
  .region-type-field {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin: 0.35rem 0 0.55rem;
    font-size: 0.78rem;
    color: var(--ed-muted, var(--hud-muted));
  }
  .region-type-bar select,
  .region-type-field select {
    min-width: 8.5rem;
    font-size: 0.82rem;
  }
  .line-heading .region-type-field {
    margin: 0;
  }
  .prepare-canvas {
    flex: 1;
    min-height: 0;
    overflow: auto;
    background: var(--hud-canvas);
    max-width: none;
  }
  .studio {
    --panel: var(--ed-panel, var(--hud-bg-2));
    --line: var(--ed-line, var(--hud-line));
    --ink: var(--ed-text, var(--hud-text));
    --accent: var(--ed-active);
    font-family: "Inter", system-ui, sans-serif;
    font-size: 12px;
  }
  .studio.wait-cursor,
  .studio.wait-cursor :global(*) {
    cursor: wait !important;
  }
  .studio.wait-cursor.has-wait-ptr,
  .studio.wait-cursor.has-wait-ptr :global(*) {
    cursor: none !important;
  }
  .wait-ptr {
    position: fixed;
    top: 0;
    left: 0;
    width: 48px;
    height: 48px;
    margin: -24px 0 0 -24px;
    border: 8px solid var(--hud-line);
    border-top-color: var(--hud-teal);
    border-radius: 50%;
    animation: jobspin 0.8s linear infinite;
    pointer-events: none;
    z-index: 10000;
  }
  .workspace-tabs {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 10px;
    min-height: 32px;
    background: var(--hud-bg);
    border-bottom: 1px solid var(--line);
    flex-shrink: 0;
  }
  .workspace-label {
    color: var(--ed-muted);
    font-size: 11px;
  }
  .workspace-tabs .ed-btn {
    border: 0;
    border-radius: 0;
    background: transparent;
    min-height: 31px;
    padding: 5px 12px;
    border-bottom: 2px solid transparent;
  }
  .workspace-tabs .ed-btn.active {
    background: var(--hud-teal-dim);
    color: var(--hud-teal);
    border-bottom-color: var(--accent);
  }
  .ed-docbar .ed-btn {
    background: transparent;
    border: 0;
    padding: 4px 8px;
  }
  .ed-docbar .ed-btn:hover {
    background: var(--ed-hover);
  }
  .bilingual h2 {
    font:
      700 12px "Rajdhani", sans-serif;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 14px 0 8px;
  }
  .bilingual details {
    margin: 8px 0;
    padding: 8px;
  }
  .panel-hint {
    font-size: 11px;
    color: var(--ed-muted);
  }
  button:focus-visible,
  select:focus-visible,
  input:focus-visible,
  textarea:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  a {
    color: var(--accent);
  }
  .ed-steps {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
    overflow: auto;
  }
  .save-studioState {
    margin-left: auto;
    color: var(--ed-muted, var(--hud-muted));
    font-size: 12px;
    flex-shrink: 0;
  }
  .bar-menu .ed-menu-panel {
    left: 0;
    right: auto;
    min-width: 248px;
    z-index: 1100;
  }
  .menu-rule {
    display: block;
    height: 1px;
    margin: 4px 6px;
    background: var(--ed-line, var(--hud-line));
  }
  .zoom-tool,
  .zoom-tool :global(*) {
    cursor: zoom-in !important;
  }
  button,
  input,
  select,
  textarea {
    font: inherit;
  }
  button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid rgba(244, 247, 251, 0.18);
    background: rgba(255, 255, 255, 0.04);
    color: var(--hud-text);
    font-family: Inter, system-ui, sans-serif;
    font-weight: 500;
    font-size: 12.5px;
    line-height: 1.3;
    letter-spacing: 0;
    text-transform: none;
    white-space: nowrap;
    border-radius: 5px;
    padding: 5px 10px;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    background: var(--hud-teal-dim);
    border-color: var(--hud-teal);
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  button.primary {
    background: var(--hud-teal);
    color: #04201b;
    border-color: var(--hud-teal);
    font-weight: 600;
  }
  button.primary:hover:not(:disabled) {
    background: #5cf0d8;
    color: #04201b;
  }
  button.ghost {
    background: transparent;
    border-color: transparent;
  }
  button.ghost:hover:not(:disabled) {
    border-color: rgba(244, 247, 251, 0.18);
    background: rgba(255, 255, 255, 0.05);
  }
  button.icon-only {
    padding: 5px 7px;
  }
  .vsep {
    width: 1px;
    align-self: stretch;
    background: var(--hud-line);
    margin: 2px 4px;
  }
  .group-label {
    font-size: 10.5px;
    color: var(--hud-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .seg {
    display: inline-flex;
    border: 1px solid rgba(244, 247, 251, 0.18);
    border-radius: 5px;
    overflow: hidden;
    flex: none;
  }
  .seg button {
    border: 0;
    border-radius: 0;
    background: transparent;
    padding: 5px 10px;
    font-size: 12px;
    color: var(--hud-muted);
  }
  .seg button + button {
    border-left: 1px solid var(--hud-line);
  }
  .seg button.on {
    background: var(--hud-teal-dim);
    color: var(--hud-teal);
  }
  input,
  textarea,
  select {
    background: rgba(8, 10, 14, 0.7);
    border: 1px solid rgba(244, 247, 251, 0.18);
    border-radius: 4px;
    color: var(--ink);
    padding: 5px 7px;
    font-size: 12.5px;
    width: 100%;
  }
  input:focus,
  textarea:focus,
  select:focus {
    outline: none;
    border-color: var(--hud-teal);
  }
  textarea {
    resize: vertical;
  }
  input[type="checkbox"] {
    width: auto;
  }
  input[type="color"] {
    height: 34px;
  }
  label {
    display: block;
    color: var(--hud-muted);
    font-size: 12px;
    margin: 8px 0;
  }
  label input,
  label textarea,
  label select {
    display: block;
    margin-top: 3px;
  }
  label:has(input[type="checkbox"]) {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .control-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin: 10px 0;
  }
  .control-row select,
  .control-row input {
    width: auto;
    max-width: 210px;
  }
  .control-row label {
    margin: 0;
  }
  .notice,
  .draft-conflict {
    padding: 12px 24px;
    background: var(--hud-teal-dim);
    flex-shrink: 0;
  }
  .notice {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
  }
  .notice-body,
  .job-error {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font:
      12px/1.45 ui-monospace,
      monospace;
  }
  .notice-body {
    flex: 1;
    min-width: 0;
  }
  .error,
  .draft-conflict {
    background: #48262e;
  }
  .warning {
    color: #ffc283;
  }
  .studio-body {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    position: relative;
    overflow: hidden;
  }
  .canvas-column {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .canvas-stage {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .ed-main {
    position: relative;
    min-width: 0;
  }
  .ed-main > .prepare,
  .ed-main > :global(.organize) {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .more-menu {
    position: absolute;
    z-index: 30;
    top: 50px;
    left: 210px;
    display: flex;
    flex-direction: column;
    min-width: 250px;
    padding: 4px;
    background: #171d28;
    border: 1px solid rgba(244, 247, 251, 0.18);
    border-radius: 7px;
    box-shadow: 0 14px 44px rgba(0, 0, 0, 0.65);
  }
  .more-menu button {
    text-align: left;
    background: transparent;
    color: var(--hud-text);
    border: 0;
    border-radius: 4px;
    padding: 5px 9px;
  }
  .more-menu button:hover:not(:disabled) {
    background: var(--hud-teal-dim);
  }
  .insp-tabs {
    display: flex;
    gap: 2px;
    padding: 4px 8px 0;
    border-bottom: 1px solid var(--hud-line);
  }
  .insp-tabs button {
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--hud-muted);
    padding: 7px 10px;
    border-bottom: 2px solid transparent;
    font-size: 12.5px;
    gap: 5px;
  }
  .insp-tabs button:hover:not(:disabled) {
    background: transparent;
    color: var(--hud-text);
  }
  .insp-tabs button[aria-selected="true"] {
    color: var(--hud-text);
    border-bottom-color: var(--hud-teal);
  }
  :global(.studio .badge) {
    display: inline-block;
    min-width: 16px;
    padding: 0 5px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.1);
    color: var(--hud-text);
    font-size: 10.5px;
    text-align: center;
    line-height: 16px;
  }
  .icon-btn {
    border: 0;
    background: transparent;
    color: var(--hud-muted);
    padding: 3px 5px;
    border-radius: 4px;
  }
  .icon-btn:hover:not(:disabled) {
    color: var(--hud-text);
    background: rgba(255, 255, 255, 0.07);
  }
  .sec {
    padding: 12px 14px;
    border-bottom: 1px solid var(--hud-line);
    display: grid;
    gap: 8px;
  }
  .sec h3 {
    margin: 0;
    font: 700 12.5px Rajdhani, sans-serif;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--hud-text);
  }
  .sec > :global(button) {
    justify-self: start;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    border: 1px solid rgba(244, 247, 251, 0.18);
    border-radius: 5px;
    background: rgba(255, 255, 255, 0.04);
    color: var(--hud-text);
    font: 500 12px Inter, system-ui, sans-serif;
    letter-spacing: 0;
    text-transform: none;
  }
  .sec > :global(button:hover:not(:disabled)) {
    border-color: var(--hud-teal);
    background: var(--hud-teal-dim);
  }
  .bilingual :global(.page-meta textarea) {
    font-size: 12.5px;
  }
  .bilingual :global(.page-meta .ed-btn) {
    justify-self: start;
    padding: 3px 8px;
    border: 1px solid rgba(244, 247, 251, 0.18);
    border-radius: 5px;
    background: rgba(255, 255, 255, 0.04);
    color: var(--hud-text);
    font: 500 12px Inter, system-ui, sans-serif;
    letter-spacing: 0;
    text-transform: none;
  }
  .bilingual :global(.page-meta .ed-btn:hover:not(:disabled)) {
    border-color: var(--hud-teal);
    background: var(--hud-teal-dim);
  }
  .nudge {
    display: grid;
    grid-template-columns: repeat(3, 38px);
    grid-template-rows: repeat(3, 32px);
    gap: 3px;
    justify-content: start;
  }
  .nudge > :nth-child(1) { grid-column: 2; }
  .nudge > :nth-child(2) { grid-column: 1; grid-row: 2; }
  .nudge > input { grid-column: 2; grid-row: 2; text-align: center; padding: 2px; }
  .nudge > :nth-child(4) { grid-column: 3; grid-row: 2; }
  .nudge > :nth-child(5) { grid-column: 2; grid-row: 3; }
  .nudge button { justify-content: center; }
  .pipeline {
    display: flex;
    gap: 3px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .pipeline li {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px 3px 4px;
    border-radius: 999px;
    font-size: 12px;
    color: var(--hud-muted);
    border: 1px solid var(--hud-line);
  }
  .pipeline li span {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 10.5px;
    border: 1px solid rgba(244, 247, 251, 0.18);
  }
  .pipeline li.done { color: #5ee39a; border-color: rgba(94, 227, 154, 0.35); }
  .pipeline li.done span { background: #5ee39a; color: #03220f; border-color: #5ee39a; }
  .pipeline li.now { color: var(--hud-teal); border-color: rgba(45, 226, 197, 0.5); background: var(--hud-teal-dim); }
  .pipeline li.now span { border-color: var(--hud-teal); }
  .issues-pop {
    position: absolute;
    z-index: 40;
    top: 48px;
    right: 120px;
    width: min(360px, 80vw);
    max-height: 50vh;
    overflow: auto;
    padding: 8px;
    background: var(--hud-bg);
    border: 1px solid var(--hud-line);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
  }
  .issues-pop button {
    display: block;
    width: 100%;
    text-align: left;
    background: transparent;
    color: var(--hud-text);
    border: 0;
    padding: 6px 8px;
  }
  .model-chip {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  :global(.studio-flash) {
    animation: studio-flash 1.4s ease-out;
  }
  @keyframes studio-flash {
    0%, 35% { box-shadow: 0 0 0 3px var(--hud-teal); }
    100% { box-shadow: 0 0 0 0 transparent; }
  }
  .keys-backdrop {
    position: fixed;
    inset: 0;
    z-index: 70;
    background: rgba(0, 0, 0, 0.35);
  }
  .keys-dialog {
    position: fixed;
    z-index: 71;
    top: 80px;
    left: 50%;
    transform: translateX(-50%);
    width: min(480px, 92vw);
    padding: 16px;
    background: var(--hud-bg);
    border: 1px solid var(--hud-line);
    color: var(--hud-text);
  }
  .keys-dialog header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .keys-dialog ul { margin: 12px 0 0; padding-left: 18px; }
  .keys-dialog li { margin: 6px 0; }
  .pages {
    flex: 0 0 auto;
    border-right: 1px solid var(--line);
    padding: 6px;
    min-height: 0;
    overflow: auto;
    background: var(--ed-panel, var(--hud-bg-2));
  }
  .pane-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 8px 0 12px;
    font: 600 10.5px Rajdhani, sans-serif;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--hud-muted);
  }
  .pages button {
    position: relative;
    display: block;
    width: 100%;
    text-align: left;
    margin: 0 0 6px;
    padding: 4px;
    background: var(--hud-bg);
    border-color: var(--line);
  }
  .pages button.selected {
    border-color: var(--accent);
  }
  .pages img {
    width: 100%;
    height: 72px;
    object-fit: contain;
    background: var(--hud-canvas);
  }
  .pages span {
    display: block;
    padding-top: 3px;
    font-size: 11px;
  }
  .pages i {
    position: absolute;
    right: 6px;
    top: 6px;
    color: #eeba7c;
  }
  .splitter {
    flex: 0 0 3px;
    cursor: col-resize;
    background: transparent;
  }
  .splitter:hover,
  .splitter:active {
    background: var(--accent);
  }
  .edge-tab {
    position: absolute;
    top: 40%;
    z-index: 5;
    writing-mode: vertical-rl;
    padding: 10px 4px;
    border: 1px solid var(--line);
    background: var(--ed-panel, var(--hud-bg-2));
    color: var(--ed-muted, var(--hud-muted));
    font-size: 11px;
  }
  .edge-tab.left {
    left: 0;
    border-radius: 0 4px 4px 0;
  }
  .edge-tab.right {
    right: 0;
    border-radius: 4px 0 0 4px;
  }
  .tools-dock {
    box-sizing: border-box;
    flex: 0 0 78px;
    min-width: 78px;
    min-height: 0;
    align-self: stretch;
    display: flex;
  }
  .tools-dock.tools-inset {
    margin-left: 22px;
  }
  .tools-dock.tools-floating {
    flex: 0 0 0;
    min-width: 0;
    width: 0;
    margin: 0;
    overflow: visible;
  }
  .ed-main {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .job-spinner {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--hud-teal);
    font-size: 12px;
  }
  .job-spinner .spin,
  :global(.spin) {
    width: 12px;
    height: 12px;
    border: 2px solid var(--hud-line);
    border-top-color: var(--hud-teal);
    border-radius: 50%;
    animation: jobspin 0.8s linear infinite;
  }
  @keyframes jobspin {
    to {
      transform: rotate(360deg);
    }
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
  .page-commands {
    position: sticky;
    top: 0;
    z-index: 3;
    background: #141922;
  }
  .prepare,
  .export {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 16px 20px;
    max-width: none;
    width: 100%;
    display: flex;
    flex-direction: column;
  }
  h1 {
    font-size: 26px;
    margin: 0 0 8px;
    letter-spacing: -0.5px;
  }
  h2 {
    font-size: 15px;
    margin: 20px 0 10px;
  }
  p {
    color: var(--hud-muted);
  }
  .upload {
    padding: 24px;
    border: 1px dashed var(--hud-teal);
    background: var(--hud-teal-dim);
    max-width: 700px;
  }
  .upload input {
    margin-top: 14px;
  }
  .upload-list {
    padding: 18px;
    background: var(--panel);
  }
  .upload-list > div {
    display: flex;
    gap: 12px;
    align-items: center;
    margin: 5px;
  }
  .settings {
    max-width: 700px;
    padding: 16px 0;
  }
  .prepare-preview {
    max-width: 600px;
    max-height: 550px;
    object-fit: contain;
  }
  .canvas-and-panel {
    display: flex;
    flex: 1;
    min-height: 0;
    position: relative;
  }
  .canvas-scroll {
    flex: 1;
    min-width: 0;
    overflow: auto;
    background: var(--hud-canvas);
    padding: 16px;
  }
  .canvas-scroll.zoom-mode {
    overflow: hidden;
  }
  .canvas-page {
    position: relative;
    width: 100%;
    background: white;
    line-height: 0;
    -webkit-user-select: none;
    user-select: none;
  }
  .artwork {
    width: 100%;
    display: block;
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
  .text-overlay {
    pointer-events: none;
  }
  .canvas-page svg .ignored {
    opacity: 0.35;
  }
  .region-label text {
    fill: #10161f;
    font: 600 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .bilingual {
    flex: 0 0 auto;
    padding: 0;
    overflow: auto;
    overflow-anchor: none;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    background: #141922;
    border-left: 1px solid var(--hud-line);
    min-height: 0;
  }
  .style-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
  }
  .geometry {
    border-top: 1px solid var(--line);
    margin-top: 20px;
  }
  pre {
    white-space: pre-wrap;
    word-break: break-word;
    background: var(--hud-bg);
    padding: 10px;
    font-size: 12px;
  }
  .issues {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 5px;
    max-width: 800px;
  }
  .issues button {
    text-align: left;
  }
  .jobs {
    flex-shrink: 0;
    border-top: 1px solid var(--line);
    padding: 8px 22px;
    background: var(--hud-bg-2);
  }
  .jobs.open {
    max-height: 42vh;
    overflow: auto;
  }
  .jobs-toggle {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 4px 0;
    background: none;
    border: 0;
    border-radius: 0;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .jobs-toggle:hover {
    background: transparent;
  }
  .jobs h2 {
    margin: 0;
    font-size: 15px;
  }
  .jobs-toggle span {
    color: var(--hud-muted);
    font-size: 12px;
  }
  .jobs-chevron {
    margin-left: auto;
  }
  .job {
    border-top: 1px solid var(--hud-line);
    padding: 8px 0;
    font-size: 12px;
  }
  .job-meta {
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
  }
  .job-error {
    margin-top: 8px;
    color: #ffc283;
  }
  .search-results {
    display: flex;
    flex-direction: column;
    gap: 5px;
    max-height: 200px;
    overflow: auto;
  }
  .empty {
    padding: 35px;
    color: var(--hud-muted);
  }
  .download {
    margin-left: auto;
  }
  details {
    padding: 10px;
    border: 1px solid var(--line);
    margin: 12px 0;
  }
  details summary {
    cursor: pointer;
    font-weight: 600;
  }
  @media (max-width: 760px) {
    .pages img {
      height: 56px;
    }
    .prepare,
    .export {
      padding: 18px;
    }
    .studio-body :global(.pages) {
      position: absolute;
      inset: 0 auto 0 0;
      z-index: 20;
      max-width: min(72vw, 220px);
      box-shadow: 8px 0 24px rgba(0, 0, 0, 0.35);
    }
    .studio-body :global(.pages + .splitter) {
      display: none;
    }
    .tools-dock:not(.tools-floating) {
      position: absolute;
      inset: 0 auto 0 0;
      z-index: 19;
      flex: 0 0 56px;
      min-width: 56px;
      box-shadow: 8px 0 24px rgba(0, 0, 0, 0.28);
    }
    .tools-dock.tools-inset {
      margin-left: 0;
    }
    .bilingual {
      position: absolute;
      inset: 0 0 0 auto;
      z-index: 20;
      max-width: min(92vw, 400px);
      width: min(92vw, 400px) !important;
      box-shadow: -8px 0 24px rgba(0, 0, 0, 0.35);
    }
    .studio-body > .splitter {
      display: none;
    }
  }
</style>

<RegionAiSettings
  bind:this={regionAiSettingsDialog}
  showTrigger={false}
  settings={aiModels}
  fallback={{ engine, model } as TaskEngine}
  engines={engineOptions}
  disabled={!canEdit || busy}
  onsave={async (regionAi) => {
    return saveRegionAi(regionAi);
  }}
/>
<RegionAiDialog imageBase={`${apiBase}/region-ai`} bind:this={regionAiDialog} engines={engineOptions} defaultModel={aiModels.enquire}
  prepare={prepareRegionAi}
  currentLines={studioState?.lines ?? []}
  jobs={studioState?.jobs ?? []}
  lang={studioState?.preferences.lang ?? "japanese"}
  glossary={seriesTerms}
  onedit={edit}
  onopensettings={() => void regionAiSettingsDialog.open()}
  call={async (body, signal) => {
    const result = await request(`${apiBase}/region-ai`, body, "POST", signal);
    await refresh(); return result;
  }}
  suggestions={studioState?.suggestions ?? []}
  decide={async (id, decision, force) => {
    if (!(await saves.flushAll())) throw new Error("Resolve unsaved drafts first");
    const acceptedLineId = decision === "accept"
      ? studioState?.suggestions.find((s) => s.id === id)?.line_id
      : undefined;
    await request(`${apiBase}/workflow`, { action: "suggestion", id, decision, force, translationModel: aiModels.translate });
    await refresh();
    if (acceptedLineId) await refitAfterText(acceptedLineId);
  }} />
<ReviseEnglishDialog bind:this={reviseEnglishDialog} engines={engineOptions}
  prepare={prepareRegionAi}
  currentLines={studioState?.lines ?? []}
  onopensettings={() => void regionAiSettingsDialog.open("revise")}
  call={async (body, signal) => {
    const result = await request(`${apiBase}/region-ai`, body, "POST", signal);
    await refresh(); return result;
  }}
  suggestions={studioState?.suggestions ?? []}
  decide={async (id, decision, force) => {
    if (!(await saves.flushAll())) throw new Error("Resolve unsaved drafts first");
    const acceptedLineId = decision === "accept"
      ? studioState?.suggestions.find((s) => s.id === id)?.line_id
      : undefined;
    await request(`${apiBase}/workflow`, { action: "suggestion", id, decision, force, translationModel: aiModels.translate });
    await refresh();
    if (acceptedLineId) await refitAfterText(acceptedLineId);
  }} />

<PageProofreadDialog
  job={proofreadJob}
  {asset}
  onclose={() => { proofreadJobId = null; }}
  onattachpage={async (variant) => {
    const imageId = String(proofreadJob?.payload?.imageId || page?.id || '');
    if (!imageId) throw new Error('This critique has no page to attach.');
    if (!(await saves.flushAll())) throw new Error('Resolve unsaved drafts first');
    const response = await fetch(`${apiBase}/images/${imageId}/review-image?variant=${variant}`, { cache: 'no-store' });
    if (!response.ok) throw new Error((await response.json()).error || 'Could not render page');
    return response.blob();
  }}
  onfollowup={async (prompt, images) => {
    if (!proofreadJobId) return;
    const result = await request(`${apiBase}/page-proofread`, {
      followUpOf: proofreadJobId,
      prompt,
      images,
    });
    await refresh();
    proofreadJobId = result.jobId;
    notify('Follow-up sent. The new critique is saved in Jobs.');
  }}
/>
<CleanPromptDialog bind:this={cleanPromptDialog} />
<RegionCompareDialog bind:this={regionCompareDialog} />
