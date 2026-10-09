/** Every chapter-studio action: where it lives, where it used to live, and how Find an action opens it. */

export type StudioStage = "prepare" | "translate" | "review" | "clean" | "typeset" | "export";

export type StudioGo = {
  stage?: StudioStage;
  prepView?: "grid" | "page";
  tab?: string;
  subtab?: string;
  tool?: string;
  scope?: "page" | "chapter";
  settings?: string;
  models?: string;
  jobs?: boolean;
  menu?: "more" | "page" | "region" | "view" | "issues" | "keys";
  menuFind?: string;
  kana?: boolean;
};

export type StudioAction = {
  id: string;
  label: string;
  where: string;
  was: string;
  go: StudioGo;
  find: string;
  keywords: string;
};

export const STUDIO_STAGE_ORDER: { id: StudioStage; label: string; icon: string; purpose: string }[] = [
  { id: "prepare", label: "Prepare", icon: "bi-images", purpose: "Get pages in reading order and ready to work on." },
  { id: "translate", label: "Translate", icon: "bi-translate", purpose: "Find the lettering, read the source, draft English." },
  { id: "review", label: "Review", icon: "bi-check2-square", purpose: "Check every line, settle suggestions, approve." },
  { id: "clean", label: "Clean", icon: "bi-eraser", purpose: "Mask the original lettering, remove it, touch up." },
  { id: "typeset", label: "Typeset", icon: "bi-fonts", purpose: "Letter the English in each bubble." },
  { id: "export", label: "Export", icon: "bi-box-arrow-up", purpose: "Resolve what's left, then download or share." },
];

export function studioStepName(stage: StudioStage): string {
  return STUDIO_STAGE_ORDER.find((item) => item.id === stage)?.label ?? stage;
}

let seq = 0;
function A(label: string, where: string, was: string, go: StudioGo = {}, find = "", keywords = ""): StudioAction {
  seq += 1;
  return { id: `a${seq}`, label, where, was, go, find, keywords };
}

const pageMenu = (stage: StudioStage, text: string): StudioGo => ({ stage, menu: "page", menuFind: text });
const regionMenu = (stage: StudioStage, text: string): StudioGo => ({
  stage,
  menu: "region",
  menuFind: text,
  tab: stage === "review" ? "queue" : stage === "translate" ? "regions" : undefined,
});
const set = (settings: string, models?: string): StudioGo => ({ settings, models });
const tr = (extra: StudioGo = {}): StudioGo => ({ stage: "translate", tab: "regions", ...extra });

export const STUDIO_ACTIONS: StudioAction[] = [
  A("Add images / paste from clipboard", "Prepare › Organize › Add images tile", "Prepare chapter panel", { stage: "prepare", prepView: "grid" }, "upload", "upload import"),
  A("Upload order preview & stitch into strips", "Prepare › Inspector › Upload", "Prepare chapter panel", { stage: "prepare", prepView: "page", tab: "upload" }, "upload-order", "stitch strips"),
  A("Select pages, select a range, select all", "Prepare › Organize grid checkboxes", "Pages sidebar checkboxes (Prepare only)", { stage: "prepare", prepView: "grid" }, "organize"),
  A("Extract selected pages to a new chapter", "Prepare › Organize › select pages › Extract", "Selection bar in Prepare", { stage: "prepare", prepView: "grid" }, "organize", "copy subchapter"),
  A("Delete selected pages", "Prepare › Organize › select pages › Delete", "Selection bar in Prepare", { stage: "prepare", prepView: "grid" }, "organize"),
  A("Reorder pages (drag)", "Prepare › Organize grid", "Move page earlier / later buttons", { stage: "prepare", prepView: "grid" }, "organize", "move order"),
  A("Move page earlier / later", "Page menu › Page, or Prepare › Edit page › Page actions", "Prepare chapter panel · page menu", pageMenu("prepare", "Move page earlier")),
  A("Renumber pages", "Prepare › stale-numbering banner, or Prepare › More", "Prepare chapter panel", { stage: "prepare", menu: "more", menuFind: "Renumber" }, "renumber"),
  A("Combine two consecutive pages into an RTL spread", "Prepare › select two consecutive pages › Combine into spread", "Selection bar in Prepare", { stage: "prepare", prepView: "grid" }, "combine-spread", "centerfold join merge"),
  A("Split spreads", "Prepare › Stage bar", "Prepare chapter panel", { stage: "prepare" }, "split-spreads"),
  A("Auto-crop margins (chapter)", "Prepare › Stage bar", "Prepare chapter panel", { stage: "prepare" }, "auto-crop"),
  A("Auto-crop margins (one page)", "Page menu › Page", "Page context menu (Prepare only)", pageMenu("prepare", "Auto-crop")),
  A("Auto-align pages", "Prepare › Stage bar", "Prepare chapter panel", { stage: "prepare" }, "auto-align"),
  A("Auto-reslice strips", "Prepare › Stage bar", "Prepare chapter panel", { stage: "prepare" }, "auto-reslice"),
  A("Undo page edit", "Prepare › More, or page footer", "Prepare chapter panel", { stage: "prepare", menu: "more", menuFind: "Undo page edit" }),
  A("Generate scene notes for the chapter", "Prepare › Stage bar › Scene notes", "Prepare chapter panel", { stage: "prepare" }, "scene-notes", "describe"),
  A("Generate / refresh scene note for one page", "Prepare › Edit page › Inspector, or Translate › Page & script", "Palette Page group · Page inspector", { stage: "prepare", prepView: "page", tab: "page" }, "describe-page", "describe caption"),
  A("Edit a page's scene note", "Inspector › Page & script (Translate/Review) or Page (Prepare)", "Scene context expander", tr({ tab: "page" }), "refresh-scene", "caption"),
  A("Crop a page", "Prepare › Edit page › Crop tool", "Palette crop tool", { stage: "prepare", prepView: "page", tool: "crop" }, "tool-crop"),
  A("Split a page", "Prepare › Edit page › Split tool", "Palette split tool", { stage: "prepare", prepView: "page", tool: "split" }, "tool-split"),
  A("Reslice strips (manual cuts)", "Prepare › Edit page › Reslice tool", "Palette reslice tool", { stage: "prepare", prepView: "page", tool: "reslice" }, "tool-reslice"),
  A("Apply reslice cuts", "Tool options bar (Reslice tool)", "Palette scissors button", { stage: "prepare", prepView: "page", tool: "reslice" }, "tool-options"),
  A("Nudge page", "Prepare › Edit page › Inspector › Nudge", "Palette Nudge group", { stage: "prepare", prepView: "page", tab: "page" }, "nudge"),
  A("Replace page from image / PSD", "Page menu › Page, or Prepare › Edit page › Page actions", "Page context menu (Prepare)", { stage: "prepare", prepView: "page", tab: "page" }, "replace-file"),
  A("Insert images before / after a page", "Page menu › Page", "Page context menu (Prepare)", pageMenu("prepare", "Insert images before")),
  A("Revert page to original raw", "Page menu › Page · Clean › Finish", "Page context menu (Prepare, Clean)", pageMenu("prepare", "Revert")),
  A("Delete a page", "Page menu › Page", "Palette trash · page context menu", pageMenu("prepare", "Delete page")),
  A("Page info (file, size)", "Prepare › Edit page › Inspector › Page", "Page menu › Page info", { stage: "prepare", prepView: "page", tab: "page" }, "tab-prepare-page"),
  A("Series pre / post credits", "Prepare › Inspector › Credits, or Settings › Series credits", "Prepare chapter panel", { stage: "prepare", tab: "credits" }, "tab-prepare-credits"),
  A("Add credits to this chapter", "Prepare › Organize › credits slot", "Prepare chapter panel", { stage: "prepare", prepView: "grid" }, "add-credits"),
  A("Source language and reading direction", "Settings › Series", "Series language & reading direction", set("series"), "set-series", "japanese korean rtl ltr"),
  A("Chapter DPI", "Settings › Chapter", "Chapter DPI override", set("chapter"), "set-chapter", "density resolution"),

  A("Transcribe page / chapter", "Translate › Stage bar (Page / Whole chapter)", "Chapter menu · Page menu · palette · chapter panel", { stage: "translate" }, "transcribe", "ocr detect"),
  A("Translate page / chapter", "Translate › Stage bar", "Chapter menu · Page menu · palette · chapter panel", { stage: "translate" }, "translate"),
  A("Fill missing source & English", "Translate › Stage bar", "Chapter menu · Page menu · palette · chapter panel", { stage: "translate" }, "fill-missing"),
  A("Retry uncertain image reading (re-read missing / low-certainty)", "Translate › More", "Chapter/Page menus · palette · Optional tools", { stage: "translate", menu: "more", menuFind: "Retry uncertain" }, "more-translate", "reread"),
  A("Refresh scene context", "Translate › More, or Page & script tab", "Palette · page menu", { stage: "translate", menu: "more", menuFind: "Refresh scene" }, "more-translate"),
  A("Remove all blank regions (chapter)", "Translate › More", "Translate chapter panel", { stage: "translate", menu: "more", menuFind: "blank" }, "more-translate"),
  A("Remove all regions on a page", "Translate › More · Page menu › Text", "Page menu", { stage: "translate", menu: "more", menuFind: "Remove all regions" }, "more-translate"),
  A("Stop AI / retry unfinished pages", "Job banner above the canvas · Jobs panel", "Translation status strip", { stage: "translate", jobs: true }, "jobs"),
  A("Translation model (engine + override)", "Translate › model chip", "Translate chapter panel picker", { stage: "translate" }, "translate-model", "engine sugoi"),
  A("Text detector & confidence", "Settings › Text detection (chip in Translate)", "Translate chapter panel", set("detection"), "set-detection", "ctd koharu detector conf"),
  A("Transcribe English text", "Settings › Text detection", "Translate chapter panel", set("detection"), "set-detection"),
  A("Draw region", "Translate/Review › Tool rail (R)", "Palette", { stage: "translate", tool: "region" }, "tool-region"),
  A("Read area with image model", "Translate/Review › Tool rail", "Palette", { stage: "translate", tool: "read-area" }, "tool-read-area", "vision"),
  A("Reorder reading flow", "Translate/Review › Tool rail (O)", "Palette", tr({ tool: "reorder" }), "tool-reorder"),
  A('Assign character to dialogue', 'Review › Tool rail › Assign character', 'Choose a glossary character, then click regions', { stage: 'review', tool: 'assign-character' }, 'tool-assign-character', 'speaker thought character voice'),
  A("Search source & English across the chapter", "Translate › Regions tab › Search", "Translate inspector", tr(), "search"),
  A("Show unresolved regions only", "Translate › Regions tab", "Translate inspector", tr(), "unresolved"),
  A("Import a script / place unplaced lines", "Inspector › Page & script", "Translate inspector expander", tr({ tab: "page" }), "import-script"),
  A("Change region type", "Region card header · region menu › Region type", "Region card · context menu", tr(), "region-type", "dialogue sfx box"),
  A("Review Transcription (council source reading)", "Region card › Source", "Region card · context menu", tr(), "ai-review", "reviewers"),
  A("Kana entry & draw an unreadable kanji", "Region card › Kana & kanji pad", "Region card kana panel", tr({ kana: true }), "kana", "handwriting"),
  A("Glossary chips & SFX hints", "Region card, under the source", "Region card", tr(), "region-card"),
  A("Review Translation (text-only council)", "Region card › English", "Region card · context menu", tr(), "revise"),
  A("Approve & next", "Region card", "Region card", tr(), "approve-next", "approve"),
  A("Mark needs work", "Region card · region menu", "Region card · context menu", tr(), "needs-work"),
  A("Suggest alternative", "Region card · region menu", "Region card · context menu", tr(), "suggest-alt"),
  A("Enquire (chat about a region)", "Region card · region menu", "Region card · context menu", tr(), "enquire", "chat ask"),
  A("Accept / reject suggestions", "Region card › Suggestions", "Suggestion boxes under each card", tr({ subtab: "suggestions" }), "subtab-suggestions"),
  A("Comments & proofreader corrections", "Region card › Comments tab", "Region details expander", tr({ subtab: "comments" }), "subtab-comments"),
  A("Revision history / restore as draft", "Region card › History tab", "Region details expander", tr({ subtab: "history" }), "subtab-history", "revisions"),
  A("Region bounds, split, merge", "Region card › Order & bounds tab", "Region details expander", tr({ subtab: "details" }), "subtab-details"),
  A("Reading order number / set as region 1", "Region card › Order & bounds · region menu", "Order & ignore expander · context menu", tr({ subtab: "details" }), "subtab-details"),
  A("Ignore region with a reason / reopen", "Region menu › Ignore · Order & bounds tab", "Order & ignore expander · context menu", tr({ subtab: "details" }), "subtab-details"),
  A("Read this area again with AI", "Region menu › Text", "Region context menu", regionMenu("translate", "Read this area again")),
  A("Copy source / copy English", "Region menu", "Region context menu", regionMenu("translate", "Copy source")),
  A("Delete region", "Region menu · Order & bounds tab · Delete key", "Region context menu", regionMenu("translate", "Delete region")),

  A("Review translations (go to review)", "Review step", "Translate panel button · palette", { stage: "review", tab: "queue" }, "tab-review-queue", "approve queue"),
  A("Proofread edited English", "Review › Stage bar · Translate › More", "Chapter/Page menus · palette · Optional tools", { stage: "review" }, "proofread-english"),
  A("Proofread entire script", "Review › Stage bar · Translate/Review › More", "Chapter menu", { stage: "review" }, "proofread-script", "whole chapter English text proofreading"),
  A("View / copy scripts and metadata", "Export › Scripts & metadata", "Bilingual script, English script, JSON, font manifest and readiness notes", { stage: "export" }, "export-documents", "scene notes multiple chapters download text"),
  A("Accept all translations", "Review › Stage bar · Export › Quick fixes", "Export panel", { stage: "review" }, "accept-all"),
  A("Copy raw image", "Review › Stage bar · Typeset › More", "Palette Images group", { stage: "review" }, "copy-raw", "clipboard"),
  A("Copy typeset image", "Review › Stage bar · Typeset › More", "Palette Images group", { stage: "review" }, "copy-typeset", "clipboard"),
  A("Page proofreader (raw + typeset images)", "Review › Stage bar · Typeset › More", "Palette Images group", { stage: "review" }, "page-proofreader", "critique"),
  A("Open saved critique", "Jobs bar › Open critique", "Jobs", { jobs: true }, "jobs"),
  A("Extract series terms / accept mined terms", "Review › Glossary tab", "Review chapter panel", { stage: "review", tab: "glossary" }, "extract-terms", "glossary mine"),
  A("Show raw vs typeset", "View bar › Showing raw/typeset", "Palette compare", { stage: "review" }, "view-compare"),
  A("Reading-flow arrows", "Review canvas (with Regions on)", "Review canvas", { stage: "review" }, "view-regions"),

  A("Detect lettering (generate mask)", "Clean › Inspector step 1 · stage bar Next", "Palette magic wand · page menu", { stage: "clean", tab: "clean" }, "detect-lettering", "mask ctd koharu"),
  A("Mask engine & detection padding", "Clean › Inspector step 1", "Clean inspector", { stage: "clean", tab: "clean" }, "clean-mask"),
  A("Approve mask", "Clean › Inspector step 1 · stage bar Next", "Palette · page menu", { stage: "clean", tab: "clean" }, "approve-mask"),
  A("Clear draft strokes", "Clean › step 1 (when drafts exist) · page menu", "Palette · page menu", pageMenu("clean", "Clear draft")),
  A("Mask brush / erase", "Clean › Tool rail (B / E)", "Palette", { stage: "clean", tool: "brush" }, "tool-options", "paint"),
  A("Brush size", "Tool options bar (any brush)", "Floating brush-size toolbar", { stage: "clean", tool: "brush" }, "tool-options"),
  A("Grow mask & grow amount", "Clean › Tool rail (G) · tool options bar", "Palette + floating grow toolbar", { stage: "clean", tool: "mask-grow" }, "tool-options"),
  A("Show mask overlay", "View bar › Mask", "Palette eye · Clean inspector checkbox", { stage: "clean" }, "view-mask"),
  A("Clean with a method (Big-LaMa, AOT, Auto, LaMa, Telea, flat, clone, Codex, Qwen)", "Clean › Inspector step 2", "Palette Inpaint icons · page menu", { stage: "clean", tab: "clean" }, "clean-method", "inpaint"),
  A("Clone / patch offset", "Clean › step 2 (Clone / patch method)", "Clean inspector", { stage: "clean", tab: "clean" }, "clean-method"),
  A("Fill speech bubble", "Clean › Tool rail (F) · step 3", "Palette", { stage: "clean", tab: "clean", tool: "bubble-fill" }, "clean-touchup"),
  A("Clone stamp / Blur / Restore / Paint raw", "Clean › Tool rail · step 3", "Palette", { stage: "clean", tab: "clean", tool: "clone-stamp" }, "clean-touchup"),
  A("Apply cleaning & start new mask (passes)", "Clean › step 4 › Keep result & start another pass", "Palette floppy · page menu", { stage: "clean", tab: "clean" }, "apply-pass"),
  A("Approve cleaned page & next", "Clean › step 4 · stage bar Next", "Palette", { stage: "clean", tab: "clean" }, "approve-clean"),
  A("Undo / redo saved edit", "Page footer (Ctrl+Z / Ctrl+Shift+Z)", "Palette · page menu", { stage: "clean" }, "undo"),
  A("Compare source vs result", "View bar › Showing result/source", "Palette layers button", { stage: "clean" }, "view-compare"),
  A("Compare raw vs cleaned for a region (APNG/GIF)", "Clean › step 4 · region menu", "Region context menu (Clean)", { stage: "clean", tab: "clean", menu: "region", menuFind: "Compare raw" }, "compare-region"),
  A("Save sample raw / clean", "Clean › step 4 · page menu", "Page menu (Clean)", { stage: "clean", tab: "clean", menu: "page", menuFind: "sample" }, "save-sample"),
  A("Cleaning hardware / backend", "Clean › Inspector › Hardware", "Clean inspector footer", { stage: "clean", tab: "clean" }, "clean-finish"),
  A("Fit bubble (SAM) / enclosed interior / SAM points", "Typeset › Shape & mask", "Palette Geometry group · region menu", { stage: "typeset", tab: "shape" }, "fit-bubble", "geometry polygon"),
  A("Trace polygon / set to region bounds / save polygon", "Typeset › Shape & mask", "Palette Geometry group · Geometry rail", { stage: "typeset", tab: "shape", tool: "polygon" }, "bubble-shape"),
  A("Approve geometry / undo geometry", "Typeset › Shape & mask", "Palette Geometry group · region menu", { stage: "typeset", tab: "shape" }, "approve-geometry"),
  A("Mark page complete (was: clear saved history for this step)", "Page footer › Mark page done", "Palette journal-x button in each step", { stage: "translate" }, "mark-done", "complete history"),

  A("Auto-fit all text (page / chapter)", "Typeset › Stage bar", "Palette · page menu · Typeset panel", { stage: "typeset" }, "autofit-all"),
  A("Find & fit bubbles (page / whole chapter)", "Typeset › Stage bar", "Chapter menu", { stage: "typeset" }, "find-fit"),
  A("Keep current layouts", "Typeset › Stage bar · Export › Quick fixes", "Typeset panel · Export", { stage: "typeset" }, "keep-layouts", "stale"),
  A("Reset text to series defaults (page / chapter)", "Typeset › More · page menu", "Chapter menu · page menu · palette · panel", { stage: "typeset", menu: "more", menuFind: "Reset" }, "more-typeset"),
  A("Series type settings (fonts, per-type styles)", "Settings › Typography", "Series menu · Typeset panel", set("typography"), "set-typography", "font upload"),
  A("Style brush (copy style)", "Typeset › Tool rail · Text tab › Copy style", "Palette", { stage: "typeset", tool: "style-brush" }, "tool-style-brush"),
  A("Text mask brush / knock out / clear", "Typeset › Shape & mask tab · rail", "Palette Text group · region menu", { stage: "typeset", tab: "shape", tool: "brush" }, "text-mask", "knockout"),
  A("Draw rectangle / oval / polygon text shape", "Typeset › Geometry rail · Shape & mask tab", "Palette", { stage: "typeset", tab: "shape", tool: "rectangle" }, "tool-rectangle"),
  A("Auto-fit one region / lock layout", "Typeset › Text tab", "Palette Text group · region menu", { stage: "typeset", tab: "text" }, "autofit-region"),
  A("English with manual line breaks", "Typeset › Text tab", "Typeset inspector", { stage: "typeset", tab: "text" }, "autofit-region"),
  A("Font, size, leading, padding, colours, outline", "Typeset › Style tab", "Typeset inspector", { stage: "typeset", tab: "style" }, "style"),
  A("Rotation, skew, Photoshop warp", "Typeset › Style tab › Transform", "Typeset inspector · canvas handles", { stage: "typeset", tab: "style" }, "style"),
  A("Use style for chapter / series category", "Typeset › Style tab › Save this style", "Typeset inspector", { stage: "typeset", tab: "style" }, "style"),
  A("Show text mask", "View bar › Text mask", "Palette eye", { stage: "typeset" }, "view-mask"),
  A("Export page PSD (draft)", "Page menu › Export · Typeset › More", "Page menu", pageMenu("typeset", "PSD")),
  A("Export page as PNG", "Page menu (Clean)", "Page context menu", pageMenu("clean", "Export page as PNG"), "export-page-png", "download"),
  A("Export typeset page as PNG", "Page menu (Typeset)", "Page context menu", pageMenu("typeset", "Export page as PNG"), "export-page-png", "download"),

  A("Export readiness / blockers", "Export › Ready to publish?", "Export panel list", { stage: "export" }, "readiness"),
  A("Approve all geometry", "Export › Quick fixes", "Export panel", { stage: "export" }, "approve-all-geometry"),
  A("Approve everything", "Export › Quick fixes", "Export panel", { stage: "export" }, "approve-everything", "translations geometry cleaning layouts"),
  A("Mark all steps done", "Export › Pages marked done", "Export panel", { stage: "export" }, "mark-all-steps-done", "mark every page complete"),
  ...(["translate", "review", "clean", "typeset"] as const).map(step =>
    A(`Mark all ${studioStepName(step)} done`, "Export › Pages marked done", "Export panel", { stage: "export" }, `mark-all-${step}-done`)),
  A("Pages × steps completion table", "Export › Pages marked done", "(new)", { stage: "export" }, "matrix"),
  A("Format, JPG quality, metadata, draft, Generate ZIP", "Export › Download", "Export panel", { stage: "export" }, "download", "png psd jpg zip"),
  A("Label ZIP as draft", "Export › Download", "Export panel", { stage: "export" }, "draft"),
  A("Public viewer link (enable, copy, new link, disable)", "Export › Public viewer", "Export panel", { stage: "export" }, "viewer", "share preview"),

  A("Next thing to check", "Top bar › Next", "Docbar Next button", {}, "next-issue", "exception"),
  A("See everything left to check", "Top bar › N to check", "(new)", { menu: "issues" }, "issues"),
  A("Jobs (retry, cancel, logs, clear)", "Jobs bar at the bottom", "Jobs panel", { jobs: true }, "jobs"),
  A("AI model settings (all tasks, profiles, reviewers)", "Settings › AI models", "Series menu · panels", set("models", "translate"), "set-models"),
  A("Review Transcription (1–5)", "Settings › AI models › Review Transcription", "AI model settings dialog", set("models", "reviewers"), "set-models"),
  A("Review Translation council (1–5)", "Settings › AI models › Review Translation", "AI model settings dialog", set("models", "revise"), "set-models", "council"),
  A("Transcription models", "Settings › AI models › Transcription", "AI model settings dialog", set("models", "transcription"), "set-models"),
  A("Character aliases & translation preferences", "Settings › Translation guide", "Translate panel › Translation defaults", set("guide"), "set-guide"),
  A("Series terminology (glossary editor)", "Settings › Translation guide", "Translate panel expander", set("guide"), "set-guide"),
  A("Region types & colours", "Settings › Region types & colours · View menu", "View › Region colors…", set("colors"), "set-colors"),
  A("Show / hide pages panel, inspector, jobs", "View menu (⋯)", "View menu", { menu: "view" }, "view-menu"),
  A("Show / hide region outlines", "View bar › Regions", "Palette eye", { stage: "translate" }, "view-regions"),
  A("Zoom in / out / fit", "View bar · View menu", "View menu · zoom tool", { stage: "translate" }, "viewbar"),
  A("Filter pages (to do / done)", "Pages panel", "(new)", { stage: "translate" }, "strip-filter"),
  A("Save status & draft conflicts", "Top bar · conflict banner", "Docbar · conflict boxes", {}, "stepper"),
  A("Keyboard shortcuts", "View menu › Keyboard shortcuts", "(tool titles)", { menu: "keys" }, "keys"),
];

/** Each word must appear somewhere in the label, the new home, the old home, or the keywords. */
export function searchStudioActions(query: string, catalog: StudioAction[] = STUDIO_ACTIONS): StudioAction[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return catalog;
  return catalog.filter((action) => {
    const hay = `${action.label} ${action.where} ${action.was} ${action.keywords}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}
