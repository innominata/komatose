/* Mock data for the Chapter Studio mockup. Nothing here talks to the app. */
window.MOCK = (() => {
  const img = (n) => `../../fixtures/test-pages/${String(n).padStart(3, "0")}.jpg`;

  const TYPES = [
    { id: "OT", label: "OT", color: "#9aa5b8" },
    { id: "[]", label: "Box", color: "#f5b85c" },
    { id: "<>", label: "System", color: "#7dd3fc" },
    { id: "()", label: "Thought", color: "#c4a7ff" },
    { id: "ST", label: "ST", color: "#f472b6" },
    { id: '""', label: "Dialogue", color: "#2de2c5" },
    { id: "//", label: "Aside", color: "#a3e635" },
    { id: "note", label: "Note", color: "#fde047" },
    { id: "::", label: "SFX", color: "#fb7185" },
    { id: "plain", label: "Plain", color: "#cbd5e1" },
  ];

  const R = (o) => ({
    status: "needs_review",
    state: "read",
    ocr: 0.95,
    suggestions: [],
    comments: [],
    history: [],
    geometryApproved: false,
    layout: null,
    locked: false,
    textMask: false,
    ...o,
  });

  const pages = [
    {
      n: 1, name: "001.jpg", caption: "Cover. A young doctor's face in grey pencil under a yellow ink splash; title block lower left.",
      done: { translate: true, review: true, clean: true, typeset: false },
      mask: "approved", cleaned: true, cleanApproved: true,
      regions: [
        R({ id: "p1r1", type: "[]", x: 0.373, y: 0.566, w: 0.359, h: 0.371, source: "ブラックジャックによろしく", english: "Give My Regards to Black Jack", status: "approved", ocr: 0.99, geometryApproved: true, layout: { size: 24, dpi: 350, overflow: false, stale: false, rows: ["GIVE MY REGARDS", "TO BLACK JACK"] } }),
        R({ id: "p1r2", type: "[]", x: 0.235, y: 0.571, w: 0.09, h: 0.195, source: "完全版", english: "Complete Edition", status: "approved", ocr: 0.98, geometryApproved: true, layout: { size: 14, dpi: 350, overflow: false, stale: true, rows: ["COMPLETE", "EDITION"] } }),
        R({ id: "p1r3", type: "plain", x: 0.235, y: 0.781, w: 0.058, h: 0.156, source: "佐藤 秀峰", english: "Shuho Sato", status: "approved", ocr: 0.97, geometryApproved: true, layout: { size: 11, dpi: 350, overflow: false, stale: false, rows: ["SHUHO", "SATO"] } }),
      ],
    },
    {
      n: 2, name: "002.jpg", caption: "Title page on black ink texture. Brush-stroke bars left and right; contents list in the centre.",
      done: { translate: true, review: true, clean: false, typeset: false },
      mask: "needs-approval", cleaned: false,
      regions: [
        R({ id: "p2r1", type: "ST", x: 0.421, y: 0.229, w: 0.159, h: 0.027, source: "第一外科編", english: "The First Surgery Arc", status: "approved", ocr: 0.99 }),
        R({ id: "p2r2", type: "[]", x: 0.345, y: 0.376, w: 0.318, h: 0.234, source: "第1話 研修医の夜\n第2話 ウナギとゴッドハンド\n第3話 75歳の値段\n第4話 夏雲\n第5話 外科と内科と医局と斉藤\n第6話 最初のウソ\n第7話 一流のワナ", english: "Ep. 1  The Intern's Night\nEp. 2  Eels and the God Hand\nEp. 3  The Price of 75 Years\nEp. 4  Summer Clouds\nEp. 5  Surgery, Medicine, the Department and Saito\nEp. 6  The First Lie\nEp. 7  A First-Rate Trap", status: "approved", ocr: 0.93 }),
        R({ id: "p2r3", type: "[]", x: 0.345, y: 0.698, w: 0.304, h: 0.24, source: "ブラックジャックによろしく 完全版", english: "Give My Regards to Black Jack — Complete Edition", status: "approved", ocr: 0.98 }),
      ],
    },
    {
      n: 3, name: "003.jpg", caption: "Graduation ceremony at Eiroku University's medical school. A speaker in dark glasses grips the microphone; rows of graduates in suits.",
      done: { translate: false, review: false, clean: false, typeset: false },
      mask: "none", cleaned: false,
      regions: [
        R({ id: "p3r1", type: '""', x: 0.746, y: 0.059, w: 0.097, h: 0.127, source: "８千人……", english: "Eight thousand…", ocr: 0.97,
          comments: [{ user: "mika", body: "Keep the trailing ellipsis — it lingers into the next bubble.", correction: false }],
          history: [{ rev: 2, body: "8,000 people…" }, { rev: 1, body: "" }] }),
        R({ id: "p3r2", type: "[]", x: 0.131, y: 0.122, w: 0.166, h: 0.146, source: "", english: "", state: "unreadable", ocr: null,
          suggestions: [
            { id: "s1", kind: "Hayai OCR v2", body: "毎年８千人が全国に81ある大学医学部を卒業してゆく", translation: "Every year, eight thousand students graduate from the 81 medical schools across the country.", reason: "Reading 1 of 2 · disagreement on one digit" },
            { id: "s2", kind: "PaddleOCR-VL-1.6", body: "毎年８千人が全国に31ある大学医学部を卒業してゆく", translation: "Every year, eight thousand students graduate from the 31 medical schools across the country.", reason: "Reading 2 of 2", stale: false },
          ] }),
        R({ id: "p3r3", type: '""', x: 0.159, y: 0.581, w: 0.166, h: 0.103, source: "君達はその８千人のトップの80人である！", english: "", ocr: 0.94 }),
        R({ id: "p3r4", type: "plain", x: 0.373, y: 0.288, w: 0.304, h: 0.03, source: "永禄大学医学部 卒業式", english: "", state: "ignored", ignoreReason: "Background sign — leave untranslated", status: "needs_review", ocr: 0.91 }),
      ],
    },
    {
      n: 4, name: "004.jpg", caption: "Wide shot of the graduates standing in rows. The speaker's fist in the lower left; chapter title lower right.",
      done: { translate: true, review: false, clean: false, typeset: false },
      mask: "none", cleaned: false,
      regions: [
        R({ id: "p4r1", type: '""', x: 0.552, y: 0.107, w: 0.242, h: 0.381, source: "日本の医療を背負っていくのは君達です!!", english: "You are the ones who will carry the future of medicine in this country on your shoulders!!", ocr: 0.98,
          layout: { size: 10, dpi: 350, overflow: true, stale: false, rows: ["YOU ARE THE ONES", "WHO WILL CARRY", "THE FUTURE OF", "MEDICINE IN THIS", "COUNTRY ON YOUR…"] },
          suggestions: [{ id: "s3", kind: "English revision", body: "It's you who will carry Japanese medicine on your backs!!", reason: "Hy-MT sample 2 · shorter, fits the bubble" }] }),
        R({ id: "p4r2", type: "ST", x: 0.622, y: 0.791, w: 0.276, h: 0.083, source: "第1話 研修医の夜", english: "Chapter 1: The Intern's Night", status: "approved", ocr: 0.99 }),
      ],
    },
    { n: 5, name: "005.jpg", caption: "Over-the-shoulder view of the speaker facing the seated graduates.", done: { translate: true, review: true, clean: true, typeset: true }, mask: "approved", cleaned: false, regions: [] },
    { n: 6, name: "006.jpg", caption: "", done: { translate: false, review: false, clean: false, typeset: false }, mask: "none", regions: [], running: true },
    { n: 7, name: "007.jpg", caption: "", done: { translate: false, review: false, clean: false, typeset: false }, mask: "none", regions: [], running: true },
    { n: 8, name: "008.jpg", caption: "", done: { translate: false, review: false, clean: false, typeset: false }, mask: "none", regions: [] },
    { n: 9, name: "009.jpg", caption: "", done: { translate: false, review: false, clean: false, typeset: false }, mask: "none", regions: [] },
    { n: 10, name: "010.jpg", caption: "", done: { translate: false, review: false, clean: false, typeset: false }, mask: "none", regions: [] },
  ].map((p) => ({ ...p, id: `p${p.n}`, src: img(p.n), w: 1414, h: 2000, role: null }));

  const STAGES = [
    { id: "prepare", label: "Prepare", icon: "bi-images", purpose: "Get pages in reading order and ready to work on." },
    { id: "translate", label: "Translate", icon: "bi-translate", purpose: "Find the lettering, read the source, draft English.", step: "translate" },
    { id: "review", label: "Review", icon: "bi-check2-square", purpose: "Check every line, settle suggestions, approve.", step: "review" },
    { id: "clean", label: "Clean", icon: "bi-eraser", purpose: "Mask the original lettering, remove it, touch up.", step: "clean" },
    { id: "typeset", label: "Typeset", icon: "bi-fonts", purpose: "Letter the English into each bubble.", step: "typeset" },
    { id: "export", label: "Export", icon: "bi-box-arrow-up", purpose: "Resolve what's left, download, share." },
  ];

  const TOOLS = {
    select: { icon: "bi-cursor", label: "Select", key: "V", hint: "Click a region to select it. Drag a selected box or its corners to adjust." },
    crop: { icon: "bi-crop", label: "Crop", hint: "Drag the crop box, then Apply." },
    split: { icon: "bi-vr", label: "Split page", hint: "Drag the line to where the page should split, then Apply." },
    reslice: { icon: "bi-hr", label: "Reslice strips", hint: "The page is stitched with its neighbours. Click white rows to add or remove cuts, then Apply." },
    region: { icon: "bi-bounding-box", label: "Draw region", key: "R", hint: "Drag a box over lettering. Hayai + PaddleOCR-VL read it immediately." },
    "read-area": { icon: "bi-eye", label: "Read area with image model", hint: "Drag a box. The image model reads it directly (no OCR) and creates a reviewable draft." },
    reorder: { icon: "bi-arrow-down-up", label: "Reorder reading flow", key: "O", hint: "With a region selected, click the region that should come next." },
    brush: { icon: "bi-brush", label: "Mask brush", key: "B", hint: "Paint over lettering to add it to the mask." },
    erase: { icon: "bi-eraser", label: "Erase mask", key: "E", hint: "Paint to remove areas from the mask." },
    "mask-grow": { icon: "bi-arrows-angle-expand", label: "Grow mask", key: "G", hint: "Click one continuous mask section to expand it by the set amount." },
    "bubble-fill": { icon: "bi-paint-bucket", label: "Fill speech bubble", key: "F", hint: "Click inside an enclosed balloon. Fills it with the sampled background, leaving the outline." },
    "clone-stamp": { icon: "bi-copy", label: "Clone stamp", key: "C", hint: "Right-click to set the source, click to lock the offset, then drag to paint." },
    blur: { icon: "bi-droplet-half", label: "Blur", key: "L", hint: "Paint to blend an inpainted patch into the surrounding gradient." },
    restore: { icon: "bi-clock-history", label: "Restore", key: "H", hint: "Paint the previous saved artwork back with a soft edge." },
    raw: { icon: "bi-image", label: "Paint raw", key: "S", hint: "Paint the uncleaned prepared pixels back onto the working page." },
    polygon: { icon: "bi-pentagon", label: "Draw polygon", hint: "Click to add points. Shift-click a point to remove it. Enter saves." },
    rectangle: { icon: "bi-square", label: "Draw rectangle", hint: "Drag to replace the selected region's text shape, then it auto-fits." },
    oval: { icon: "bi-circle", label: "Draw oval", hint: "Drag to replace the selected region's text shape, then it auto-fits." },
    "style-brush": { icon: "bi-brush-fill", label: "Style brush", hint: "Copies the selected region's fitted style. Click other regions to apply. Esc stops." },
    "text-mask": { icon: "bi-mask", label: "Text mask brush", key: "B", hint: "Paint black to hide typeset text behind another balloon. White reveals." },
    "text-erase": { icon: "bi-eraser", label: "Erase text mask", key: "E", hint: "Erase restores the text's visibility." },
    zoom: { icon: "bi-zoom-in", label: "Zoom", key: "Z", hint: "Click to zoom in, Alt-click to zoom out." },
  };

  const STAGE_TOOLS = {
    prepare: [["select", "crop", "split", "reslice"], ["zoom"]],
    translate: [["select", "region", "read-area", "reorder"], ["zoom"]],
    review: [["select", "region", "read-area", "reorder"], ["zoom"]],
    clean: [["select"], ["brush", "erase", "mask-grow"], ["bubble-fill", "clone-stamp", "blur", "restore", "raw"], ["polygon"], ["zoom"]],
    typeset: [["select", "style-brush"], ["text-mask", "text-erase"], ["polygon", "rectangle", "oval"], ["zoom"]],
  };
  const TOOL_GROUP_NAMES = {
    clean: ["", "Mask", "Touch up", "Shape", ""],
    typeset: ["", "Text mask", "Text shape", ""],
  };

  const CLEAN_METHODS = [
    { id: "auto", label: "Auto", desc: "Balloon fill for flat areas, Big-LaMa elsewhere", color: "#e8c36a" },
    { id: "big-lama", label: "AnimeManga Big-LaMa", desc: "Best general inpainter for screentone", color: "#ff6b9d" },
    { id: "aot", label: "AOT", desc: "Fast inpainting", color: "#4fd1c5" },
    { id: "lama", label: "Manga LaMa", desc: "CPU ONNX", color: "#f0a050" },
    { id: "telea", label: "OpenCV Telea", desc: "Simple, fast, blurry on texture", color: "#6bcf7f" },
    { id: "flat", label: "Sampled flat fill", desc: "Solid colour sampled from the edge", color: "#8ea4c8" },
    { id: "clone", label: "Clone / patch", desc: "Copies pixels from an offset", color: "#b794f4" },
    { id: "codex", label: "Codex · reconstruct artwork", desc: "Asks for a prompt first · uses Codex allowance", color: "#67e8f9", prompt: true },
    { id: "qwen-image", label: "Qwen-Image 2.1 · reconstruct", desc: "Local, asks for a prompt first", color: "#fbbf24", prompt: true },
    { id: "qwen-edit", label: "Qwen-Image-Edit 2511 · edit", desc: "Local, slower, follows the prompt closely", color: "#f97316", prompt: true, unavailable: "weights not installed" },
  ];

  const ENGINES = [
    "Sugoi v4 · local", "Hy-MT 1.5 · local", "TranslateGemma 12B · local", "Qwen3-VL-8B · local",
    "Grok CLI · billed", "Codex CLI · billed", "Cursor CLI · billed",
  ];

  const DETECTORS = ["Default · CTD + Koharu (Admin)", "CTD", "CTD + Koharu", "RT-DETR + COO + Koharu", "PaddleOCR det"];

  const GLOSSARY = [
    { source: "永禄大学", english: "Eiroku University", kind: "place" },
    { source: "斉藤英二郎", english: "Eijiro Saito", kind: "name" },
    { source: "研修医", english: "intern", kind: "term" },
    { source: "医局", english: "the department", kind: "term" },
  ];

  const JOBS = [
    { id: "j1", kind: "Transcribe", scope: "Chapter", state: "running", message: "Page 7 of 10 · reading region 2 of 5 (Hayai + PaddleOCR-VL)", done: 6, total: 10 },
    { id: "j2", kind: "Page proofreader", scope: "Page 4", state: "completed", message: "Critique ready", critique: true },
    { id: "j3", kind: "Clean", scope: "Page 2", state: "failed", message: "Codex: usage limit reached. Retry later or pick another method." },
    { id: "j4", kind: "Export", scope: "Chapter", state: "completed", message: "DRAFT-black-jack-ch1-png.zip · 18.4 MB", zip: true },
    { id: "j5", kind: "Scene description", scope: "Pages 1–5", state: "completed", message: "5 pages described, setting compacted into chapter summary" },
  ];

  const EXCEPTIONS = [
    { kind: "OCR disagreement", stage: "review", page: 3, region: "p3r2" },
    { kind: "Missing English", stage: "review", page: 3, region: "p3r3" },
    { kind: "Unapproved mask", stage: "clean", page: 2 },
    { kind: "Overflow", stage: "typeset", page: 4, region: "p4r1" },
  ];

  const READINESS = [
    { code: "numbering", stage: "prepare", msg: "Page numbering is stale — renumber after organizing", page: null },
    { code: "credits", stage: "prepare", msg: "Series has post-credits this chapter is missing", page: null },
    { code: "review", stage: "review", msg: "English not approved", page: 3, regions: ["#1", "#3"], fix: "approve-all" },
    { code: "english", stage: "review", msg: "Missing English", page: 3, regions: ["#3"] },
    { code: "source", stage: "review", msg: "Source unreadable, not ignored", page: 3, regions: ["#2"] },
    { code: "review", stage: "review", msg: "English not approved", page: 4, regions: ["#1"], fix: "approve-all" },
    { code: "cleaning", stage: "clean", msg: "Cleaning not approved", page: "2–4", count: 3 },
    { code: "geometry", stage: "typeset", msg: "Bubble geometry awaiting approval", page: 4, regions: ["#1", "#2"], fix: "geometry" },
    { code: "overflow", stage: "typeset", msg: "Text overflows at minimum size", page: 4, regions: ["#1"] },
    { code: "stale", stage: "typeset", msg: "Layout stale after page alignment", page: 1, regions: ["#2"], fix: "keep" },
    { code: "glossary", stage: "review", msg: "Glossary term 研修医 → intern not used", page: 4, severity: "warning" },
  ];

  const CREDIT_LINES = [
    "ブラックジャックによろしく",
    "佐藤秀峰",
    "Give My Regards to Black Jack",
    "SHUHO SATO",
  ];

  return {
    series: { title: "Give My Regards to Black Jack", credits: { pre: { name: "scanlation-credits.png", size: "1414×2000" }, post: { name: "thanks-for-reading.png", size: "1414×2000" } } },
    chapter: { title: "Chapter 1 · The Intern's Night", lang: "japanese", direction: "rtl" },
    TYPES, pages, STAGES, TOOLS, STAGE_TOOLS, TOOL_GROUP_NAMES, CLEAN_METHODS, ENGINES, DETECTORS,
    GLOSSARY, JOBS, EXCEPTIONS, READINESS, CREDIT_LINES,
  };
})();
