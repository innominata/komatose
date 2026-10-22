import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { pageStepStamp, type PageData } from "../src/lib/workflow";

const repo = process.cwd();
process.env.SCAN_ROOT = await mkdtemp(join(tmpdir(), "scan-director-"));
process.env.DATABASE_URL = join(process.env.SCAN_ROOT, "data/test.db");
await symlink(join(repo, "ocr"), join(process.env.SCAN_ROOT, "ocr"));
process.env.SCAN_WORKFLOW_PYTHON = join(repo, ".venv-workflow/bin/python");
process.env.LLAMASWAP_URL = "http://director.fixture/v1";
// The read stage's region-extent check runs the real text detector; it is covered by
// director-region-extent.test.ts with a fake one, so these workflow fixtures turn it off.
process.env.SCAN_DIRECTOR_REGION_EXTENT = "0";
process.env.LLAMASWAP_API_KEY = "fixture";
const { sqlite } = await import("../src/lib/server/db");
const { getDoc, putDoc } = await import("../src/lib/server/workflowStore");
const {
  cleanComplete,
  cleanBlockers,
  snapshotPage,
  recordPageChange,
  undoDirectorChange,
} = await import("../src/lib/server/directorState");
const { directorOverview } = await import("../src/lib/server/directorService");
const { withDirector } = await import("../src/lib/server/directorAudit");
const { createJob, appendJobLog, listJobs, updateJob } =
  await import("../src/lib/server/jobs");

sqlite
  .prepare(
    "INSERT INTO users(id,username,password_hash,role,created_at) VALUES('u','User','x','admin',1)",
  )
  .run();
sqlite
  .prepare(
    "INSERT INTO series(id,slug,title,created_at,updated_at) VALUES('s','s','Series',1,1)",
  )
  .run();
sqlite
  .prepare(
    "INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES('e','s','e','Episode',1,1)",
  )
  .run();
for (const [id, role, order] of [
  ["p1", "page", 1],
  ["p2", "page", 2],
  ["credit", "post-credits", 3],
] as const)
  sqlite
    .prepare(
      "INSERT INTO images(id,episode_id,filename,original_name,sort_order,width,height,created_at,role) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run(id, "e", `${id}.png`, `${id}.png`, order, 100, 100, 1, role);
const marked: PageData = { cleanApproved: true, cleaned: "asset" };
marked.completed = { clean: pageStepStamp("clean", marked, [], [], []) };
for (const id of ["p1", "credit"]) {
  const doc = getDoc<PageData>(`page:${id}`, {});
  putDoc("e", doc.id, marked, doc.revision);
}

test("page Clean gate and chapter Clean gate use independent story-page prerequisites", () => {
  assert.equal(cleanComplete("e", "p1"), true);
  assert.equal(cleanComplete("e", "p2"), false);
  assert.equal(cleanComplete("e", "credit"), false);
  assert.deepEqual(cleanBlockers("e"), ["p2"]);
  assert.deepEqual(cleanBlockers("e", "p1"), []);
  const overview = directorOverview("e");
  assert.deepEqual(
    overview.pages.map((p) => p.id),
    ["p1", "p2"],
  );
});

test("Director edit undo restores content and keeps human completion and revision history", () => {
  sqlite
    .prepare(
      `INSERT INTO lines(id,episode_id,image_id,body,line_type,status,placed,sort_order,updated_at,updated_by,source,source_state)
    VALUES('l','e','p1','Hello','plain','none',1,0,1,'u','こんにちは','read')`,
    )
    .run();
  const runId = createJob("e", "director", { engine: "fixture", model: "" });
  sqlite
    .prepare(
      `INSERT INTO director_runs(id,episode_id,user_id,scope,image_id,model,proofreader,state,page_ids,message,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      runId,
      "e",
      "u",
      "page",
      "p1",
      "{}",
      "{}",
      "completed",
      '["p1"]',
      "",
      1,
      1,
    );
  const before = snapshotPage("e", "p1");
  sqlite
    .prepare(
      "UPDATE lines SET body='Hi',source='やあ',updated_at=2 WHERE id='l'",
    )
    .run();
  const after = snapshotPage("e", "p1");
  const changeId = recordPageChange(
    runId,
    "e",
    "p1",
    "Edit translation",
    before,
    after,
  )!;
  const historyBefore = (
    sqlite
      .prepare(
        "SELECT count(*) AS n FROM workflow_revisions WHERE episode_id='e'",
      )
      .get() as any
  ).n;
  undoDirectorChange("e", changeId);
  const line = sqlite
    .prepare("SELECT body,source FROM lines WHERE id='l'")
    .get() as any;
  assert.deepEqual(line, { body: "Hello", source: "こんにちは" });
  assert.equal(
    getDoc<PageData>("page:p1", {}).data.completed?.clean,
    marked.completed?.clean,
  );
  assert.ok(
    (
      sqlite
        .prepare(
          "SELECT count(*) AS n FROM workflow_revisions WHERE episode_id='e'",
        )
        .get() as any
    ).n >= historyBefore,
  );
  assert.equal(
    (
      sqlite
        .prepare("SELECT undone FROM director_changes WHERE id=?")
        .get(changeId) as any
    ).undone,
    1,
  );
});

test("Director model audit retains complete prompts and responses independently of Jobs clipping", () => {
  const runId = (
    sqlite
      .prepare(
        "SELECT id FROM director_runs WHERE image_id='p1' ORDER BY created_at DESC LIMIT 1",
      )
      .get() as any
  ).id;
  const prompt = "P".repeat(12000),
    response = "R".repeat(12000);
  withDirector({ runId, episodeId: "e", imageId: "p1" }, () =>
    appendJobLog(runId, { request: prompt, response }),
  );
  const event = sqlite
    .prepare(
      "SELECT detail FROM director_events WHERE run_id=? AND kind='model' ORDER BY id DESC LIMIT 1",
    )
    .get(runId) as any;
  const full = JSON.parse(event.detail);
  assert.equal(full.request.length, 12000);
  assert.equal(full.response.length, 12000);
  const job = listJobs("e").find((item) => item.id === runId)!;
  assert.ok((job.progress.log as any[]).at(-1).request.length < 12000);
  updateJob(runId, "completed", { message: "Fixture complete" });
});

const { getSeries, getEpisode, listLines, listImages } =
  await import("../src/lib/server/queries");
const { saveImageFile } = await import("../src/lib/server/storage");
const { storeAsset } = await import("../src/lib/server/workflowStore");
const { uploadFont } = await import("../src/lib/server/typesetting");
const { createLocalHttpRow, updateRegistryRow } =
  await import("../src/lib/server/modelRegistryStore");
const { fixturePasses, localMaskFixture } = await import("./local-ocr-fixture");
const {
  startDirector,
  stopDirector,
  resumeDirector,
  undoDirector,
  directorOverviewAsync,
  resetDirectorPage,
  directorPreflight,
  recoverDirectorRuns,
} = await import("../src/lib/server/directorService");
const {
  memorySettings,
  saveMemorySettings,
  referenceCandidates,
  loadSeriesMemory,
  memoryFingerprint,
  createDirectorType,
  summarizeTypeDescription,
} = await import("../src/lib/server/directorMemory");
const { directorModel } = await import("../src/lib/server/directorModel");
const { directorPolicy } = await import("../src/lib/director");
const model = createLocalHttpRow({
  name: "Director fixture",
  slug: "director-fixture",
});
await fixturePasses(model.id, [
  "director",
  "vision",
  "proofreadEnglish",
  "pageImageProofread",
]);
const font = (
  await uploadFont(
    "s",
    "Fixture.otf",
    await readFile(
      "/usr/share/fonts/julietaula-montserrat-fonts/Montserrat-Regular.otf",
    ),
  )
).font;
const settings = getDoc<any>("series:s", {});
putDoc(
  null,
  settings.id,
  {
    ...settings.data,
    regionKinds: [
      { id: "plain", label: "Dialogue", color: "#ffffff" },
      { id: "thought", label: "Thought", color: "#cccccc" },
    ],
    style: { fontId: font.id, size: 16, minSize: 8, autoContrast: false },
    regionAi: {
      proofread: { engine: model.id, model: model.slug },
      transcriptionModels: ["missing-reader"],
    },
  },
  settings.revision,
);
const selected = { engine: model.id, model: model.slug };
const user = { id: "u", username: "User", role: "admin" as const };
const requests: {
  purpose: string;
  correction?: string;
  data: any;
  imageCount: number;
  model: string;
  schema: any;
}[] = [];
let respond: (purpose: string, data: any) => any = (purpose, data) => {
  if (purpose === "verify-lettering")
    return { hasLettering: true, reason: "Lettering is visible in the target area." };
  if (purpose === "learn-region-example")
    return {
      cues: "Rounded balloon and short tail indicate dialogue.",
      conflicts: "",
    };
  if (purpose === "summarize-region-type")
    return {
      description:
        "Rounded speech balloon with a short tail; dialogue spoken by a character.",
      conflicts: "",
    };
  if (purpose === "inspect-region-presentation")
    return { observations: data.regions.map((line:any)=>({lineId:line.id,enclosure:"bubble",handwritten:false,letteringVisible:true,role:"speech",reason:"Visible surrounding speech balloon."})) };
  if (purpose === "classify-regions")
    return {
      classifications: data.regions.map((line: any) => ({
        lineId: line.id,
        typeId: "plain",
        newLabel: "",
        parentType: "",
        certain: true,
        reason: "Visible speech balloon.",
        candidateTypeIds: [],
        referenceIds: data.typeDescriptions
          .filter((item: any) => item.typeId === "plain")
          .map((item: any) => item.id),
      })),
    };
  if (purpose === "correct-text") {
    const entry=(line:any)=>data.priorProofread?.split('\n').findLast((text:string)=>text.includes(`Region ${line.id}: Original source: `));
    const missing=data.regions.filter((line:any)=>!entry(line) && !line.source?.trim());
    return {
      reason:"Mapped the raw proofreader's source and English",sourceReviewLineIds:missing.map((line:any)=>line.id),textComplete:!missing.length,
      edits:data.regions.filter((line:any)=>!missing.includes(line)).map((line:any)=>{
        const proof=entry(line);
        const source=proof?.split('Original source: ')[1]?.split('; English:')[0] || line.source || 'こんにちは';
        const later=data.priorProofread?.split('\n').findLast((text:string)=>text.includes(`Region ${line.id}: English shown: `));
        const english=later?.split('English shown: ')[1] || proof?.split('; English: ')[1] || line.english || 'Hello';
        return {lineId:line.id,source:line.source===source && line.sourceState==='read'?null:source,
          english:line.english===english?null:english,reason:'Apply the supplied proofreader answer'};
      }).filter((edit:any)=>edit.source!==null || edit.english!==null),
    };
  }
  if (purpose === "inspect-unreadable-regions")
    return {
      decisions: data.regions.map((line: any) => ({
        lineId: line.id,
        verdict: "text",
        certain: true,
        source: line.source || "こんにちは",
        duplicateOf: "",
        evidence: "Visible lettering in the source crop",
      })),
    };
  if (purpose === "inspect-region-coverage") return { regions: [] };
  if (purpose === "repair-lettering")
    return { needsGeometry: false, needsClassification: false, edits: [] };
  if (purpose === "check-page") return { findings: [] };
  if (purpose === "chapter-consistency") return { issues: [] };
  if (purpose === "plan-balloon-fills")
    return {decisions: data.regions.map((r: any) => ({lineId:r.id,eligible:false,plainBubble:false,borderIntact:false,borderCrossed:false,interiorArtwork:false,reason:"No enclosed balloon in this fixture"}))};
  if (purpose === "inspect-cleaning-mask")
    return {
      safe: true,
      editorSafe: true,
      problem: "none",
      lineIds: [],
      reason: "No damage.",
    };
  if (purpose === "inspect-cleaning")
    return { safe: true, problem: "none", reason: "No damage.", ...(data.scope==='region' && data.regions?.[0]?.bubbleToolsOnly===false ? {artworkDefects:[]} : {}) };
  throw new Error(`Unexpected Director purpose: ${purpose}`);
};
let proofreaderReply: ((mode:string,data:any)=>string)|undefined;
const proofreaderRequests: {mode:string;prompt:string;imageCount:number}[]=[];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith("/models")) return Response.json({ data: [] });
  if (!String(url).endsWith("/chat/completions"))
    return Response.json({}, { status: 503 });
  const payload = JSON.parse(String(init?.body));
  const content = payload.messages?.[1]?.content;
  let input: any;
  try {
    input = JSON.parse(Array.isArray(content) ? content[0].text : content);
  } catch {
    input = {};
  }
  if (input.purpose) {
    const imageCount = Array.isArray(content)
      ? content.filter((part: any) => part.type === "image_url").length
      : 0;
    requests.push({
      ...input,
      imageCount,
      model: payload.model,
      schema: payload.response_format?.json_schema?.schema,
    });
    if (input.purpose === "correct-text") {
      assert.equal(imageCount,0,"Director text correction must use proofreader text, never OCR images");
      assert.ok(input.data.chapter.length <= 12);
      assert.ok(JSON.stringify(input.data.chapter).length <= 6000);
      assert.ok(
        input.data.chapter.every(
          (line: any) =>
            !input.data.regions.some((target: any) => target.id === line.id),
        ),
      );
    }
    if (input.purpose === "classify-regions") {
      assert.equal(
        input.data.examples,
        undefined,
        "individual reference descriptions must not reach classification",
      );
      assert.equal(
        input.data.referenceImageIds,
        undefined,
        "historical crops must not reach classification",
      );
      assert.equal(imageCount, input.data.regions.length + 1);
      assert.ok(
        imageCount <= 5,
        "classification must keep current-page image batches small",
      );
      assert.equal(input.data.imageOrder.length, imageCount);
      assert.ok(
        input.data.imageOrder.every(
          (label: string) => !label.startsWith("reference "),
        ),
      );
      assert.equal(
        new Set(input.data.typeDescriptions.map((item: any) => item.typeId))
          .size,
        input.data.typeDescriptions.length,
      );
      for (const description of input.data.typeDescriptions) {
        assert.ok(description.description.length <= 700);
        assert.ok(description.conflicts.length <= 250);
        assert.equal(description.exampleIds, undefined);
        assert.equal(description.crop, undefined);
      }
    }
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify(await(async()=>{const response=await respond(input.purpose,input.data); if(input.purpose==="inspect-region-coverage" && response?.regions) return {...response,edits:response.edits||[],regions:response.regions.map(({x,y,w,h}:any)=>({x,y,w,h}))};return response;})()),
          },
        },
      ],
    });
  }
  return Response.json({
    choices: [
      {
        message: {
          content: JSON.stringify({
            critique: await (async()=>{
              const system=String(payload.messages?.[0]?.content||'');
              const mode=/continuing a conversation/.test(system)?'follow-up':/Read the raw page/.test(system)?'raw':'critique';
              const job=sqlite.prepare("SELECT payload FROM workflow_jobs WHERE kind='page-proofread' AND state='running' ORDER BY created_at DESC LIMIT 1").get() as any;
              const jobPayload=job?JSON.parse(job.payload):{};
              const rows=(await listLines(jobPayload.imageId ? (sqlite.prepare('SELECT episode_id FROM images WHERE id=?').get(jobPayload.imageId) as any)?.episode_id : 'e')).filter(l=>l.imageId===jobPayload.imageId);
              const prompt=typeof content==='string'?content:JSON.stringify(content);
              proofreaderRequests.push({mode,prompt,imageCount:Array.isArray(content)?content.filter((p:any)=>p.type==='image_url').length:0});
              return proofreaderReply?.(mode,{prompt,rows,jobPayload}) ?? (mode==='critique'?'Source and English are accurate. No visual defects.':rows.map(l=>`Region ${l.id}: Original source: ${l.source||'こんにちは'}; English: ${l.body||'Hello'}`).join('\n'));
            })(),
          }),
        },
      },
    ],
  });
};
async function seedChapter(
  id: string,
  order: number,
  status = "raws",
  fixture?: string,
) {
  sqlite
    .prepare(
      "INSERT INTO episodes(id,series_id,slug,title,sort_order,status,created_at,updated_at) VALUES(?,?,?,?,?,?,1,1)",
    )
    .run(id, "s", id, id, order, status);
  const bytes = fixture
    ? await sharp(await readFile(join(repo, fixture)))
        .resize({ width: 400 })
        .png()
        .toBuffer()
    : await sharp({
        create: { width: 400, height: 500, channels: 3, background: "white" },
      })
        .png()
        .toBuffer();
  const file = await saveImageFile({
    seriesSlug: "s",
    episodeSlug: id,
    sortOrder: 0,
    originalName: "page.png",
    bytes,
    mime: "image/png",
  });
  const imageId = `${id}-page`,
    lineId = `${id}-line`;
  sqlite
    .prepare(
      `INSERT INTO images(id,episode_id,filename,original_name,sort_order,width,height,created_at,updated_at,page_number,caption)
    VALUES(?,?,?,'page.png',0,?,?,1,1,1,'Two people talk')`,
    )
    .run(imageId, id, file.filename, file.width, file.height);
  sqlite
    .prepare(
      `INSERT INTO lines(id,episode_id,image_id,body,line_type,status,placed,x,y,w,h,sort_order,updated_at,updated_by,source,source_state)
    VALUES(?,?,?,'Hello','plain','none',1,.2,.2,.5,.3,0,1,'u','こんにちは','read')`,
    )
    .run(lineId, id, imageId);
  const artwork = await storeAsset(bytes);
  const page = getDoc<any>(`page:${imageId}`, {});
  putDoc(
    id,
    page.id,
    { prepared: artwork, preparedAt: 1, cleanBase: artwork },
    page.revision,
  );
  const region = getDoc<any>(`region:${lineId}`, {});
  putDoc(
    id,
    region.id,
    {
      polygon: [
        { x: 0.2, y: 0.2 },
        { x: 0.7, y: 0.2 },
        { x: 0.7, y: 0.5 },
        { x: 0.2, y: 0.5 },
      ],
      styleFromSeries: true,
    },
    region.revision,
  );
  return {
    episode: (await getEpisode(id))!,
    series: (await getSeries("s"))!,
    imageId,
    lineId,
    artwork,
  };
}
async function waitRun(id: string) {
  for (let i = 0; i < 1200; i++) {
    const row = sqlite
      .prepare("SELECT * FROM director_runs WHERE id=?")
      .get(id) as any;
    if (!["running", "pausing", "stopping", "recovering"].includes(row.state))
      return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Director run timed out ${id}`);
}
async function runPage(
  page: Awaited<ReturnType<typeof seedChapter>>,
  policy?: Partial<import("../src/lib/director").DirectorPolicy>,
) {
  const { runId } = await startDirector({
    ...page,
    user,
    scope: "page",
    imageId: page.imageId,
    model: selected,
    policy,
  });
  const run = await waitRun(runId);
  assert.equal(run.state, "completed", run.message);
  return {
    runId,
    overview: await directorOverviewAsync(page.episode.id, runId),
  };
}

test("v2 runs without Clean completion and never grants human approval", async () => {
  const page = await seedChapter("unattended", 2);
  const result = await runPage(page);
  assert.equal(
    result.overview.pages[0].state,
    "passed",
    result.overview.pages[0].detail,
  );
  const doc = getDoc<any>(`page:${page.imageId}`, {}).data;
  assert.equal(doc.cleanApproved, undefined);
  assert.equal(doc.completed, undefined);
  assert.notEqual((await listLines(page.episode.id))[0].status, "approved");
  assert.notEqual(
    getDoc<any>(`region:${page.lineId}`, {}).data.geometryApproved,
    true,
  );
  assert.ok(getDoc<any>(`region:${page.lineId}`, {}).data.layout?.key);
  assert.equal(
    (
      sqlite
        .prepare(
          "SELECT count(*) n FROM director_stages WHERE run_id=? AND state=?",
        )
        .get(result.runId, "passed") as any
    ).n,
    7,
  );
  const before = requests.length;
  await directorOverviewAsync(page.episode.id);
  assert.equal(requests.length, before, "loading progress does not rerun AI");
});

test("memory uses only finished or handpicked earlier chapters and caches visual learning", async () => {
  const finished = await seedChapter(
    "finished",
    3,
    "done",
    "fixtures/test-pages/001.jpg",
  );
  const draft = await seedChapter(
    "draft",
    4,
    "raws",
    "fixtures/manhwa-pages/001.png",
  );
  const future = await seedChapter("future", 9, "done");
  const target = await seedChapter("memory-target", 5);
  let candidates = await referenceCandidates("s", target.episode);
  assert.ok(candidates.candidates.some((x) => x.id === finished.lineId));
  assert.ok(
    !candidates.candidates.some(
      (x) => x.id === draft.lineId || x.id === future.lineId,
    ),
  );
  const config = memorySettings("s");
  saveMemorySettings("s", config.revision, { episodeIds: [draft.episode.id] });
  candidates = await referenceCandidates("s", target.episode);
  assert.ok(candidates.candidates.some((x) => x.id === draft.lineId));
  const call = directorModel(
    selected,
    directorPolicy(),
    new AbortController().signal,
  );
  const start = requests.filter(
    (x) => x.purpose === "learn-region-example",
  ).length;
  const summaryStart = requests.filter(
    (x) => x.purpose === "summarize-region-type",
  ).length;
  const first = await loadSeriesMemory(
    target.series,
    target.episode,
    call,
    new AbortController().signal,
  );
  assert.equal(first.examples.length, 2, JSON.stringify(first.warnings));
  assert.ok(
    first.descriptions.some(
      (d) => d.typeId === "plain" && d.description && d.exampleIds.length === 2,
    ),
  );
  assert.equal(
    requests.filter((x) => x.purpose === "summarize-region-type").length,
    summaryStart + 1,
  );
  assert.equal(
    requests.filter((x) => x.purpose === "learn-region-example").length,
    start + 2,
  );
  await loadSeriesMemory(
    target.series,
    target.episode,
    call,
    new AbortController().signal,
  );
  assert.equal(
    requests.filter((x) => x.purpose === "learn-region-example").length,
    start + 2,
    "cached examples avoid repeated visual calls",
  );
  assert.equal(
    requests.filter((x) => x.purpose === "summarize-region-type").length,
    summaryStart + 1,
    "unchanged type descriptions are reused without another model call",
  );
  sqlite
    .prepare("UPDATE lines SET source='やあ' WHERE id=?")
    .run(finished.lineId);
  await loadSeriesMemory(
    target.series,
    target.episode,
    call,
    new AbortController().signal,
  );
  assert.equal(
    requests.filter((x) => x.purpose === "learn-region-example").length,
    start + 3,
    "only changed example is refreshed",
  );
  assert.equal(
    requests.filter((x) => x.purpose === "summarize-region-type").length,
    summaryStart + 2,
  );
  const before = await memoryFingerprint("s", target.episode);
  const cfg = memorySettings("s");
  saveMemorySettings("s", cfg.revision, {
    rules: { plain: "Round speech balloon with a tail." },
  });
  assert.notEqual(await memoryFingerprint("s", target.episode), before);
  assert.throws(
    () => saveMemorySettings("s", 0, { episodeIds: ["outside-series"] }),
    /changed/,
  );
  const current = memorySettings("s");
  assert.throws(
    () =>
      saveMemorySettings("s", current.revision, {
        episodeIds: ["outside-series"],
      }),
    /outside/,
  );
});

test("type descriptions compact large cached evidence in bounded text-only batches and refresh only on input changes", async () => {
  const type = { id: "summary-test", label: "Summary test" };
  const examples = Array.from({ length: 12 }, (_, index) => ({
    id: `summary-example-${index}`,
    episodeId: "e",
    imageId: "p1",
    lineId: `summary-example-${index}`,
    typeId: type.id,
    fingerprint: `source-${index}`,
    crop: "PRIVATE-CROP",
    overview: "PRIVATE-OVERVIEW",
    rendered: "PRIVATE-RENDERED",
    cues: "Observable bubble border and typography. ".repeat(45),
    conflicts: "Variant border. ".repeat(20),
  }));
  const calls: any[] = [];
  const call = (async (
    purpose: string,
    system: string,
    data: any,
    images: Buffer[],
    schema: any,
  ) => {
    assert.equal(purpose, "summarize-region-type");
    assert.deepEqual(images, []);
    assert.ok(data.examples.length <= 3);
    assert.ok(JSON.stringify(data).length < 12000);
    assert.ok(!JSON.stringify(data).includes("PRIVATE-"));
    assert.equal(schema.properties.description.maxLength, 1400);
    assert.equal(schema.properties.conflicts.maxLength, 1000);
    assert.match(system, /explicit user rule takes precedence/i);
    calls.push(data);
    return {
      description: `Merged description ${calls.length}`,
      conflicts: "Border varies between examples.",
    };
  }) as import("../src/lib/server/directorModel").DirectorModelCall;
  const signal = new AbortController().signal;
  const summary = await summarizeTypeDescription(
    "s",
    type,
    "Preserve the manual convention",
    examples,
    call,
    signal,
  );
  assert.equal(calls.length, 4);
  assert.equal(calls[0].previousSummary, null);
  assert.equal(calls[1].previousSummary.description, "Merged description 1");
  assert.ok(
    calls.every((c) => c.userRule === "Preserve the manual convention"),
  );
  assert.deepEqual(
    summary.exampleIds,
    examples.map((e) => e.id),
  );
  assert.equal(summary.description, "Merged description 4");
  assert.deepEqual(
    await summarizeTypeDescription(
      "s",
      type,
      "Preserve the manual convention",
      examples,
      call,
      signal,
    ),
    summary,
  );
  assert.equal(
    calls.length,
    4,
    "unchanged descriptions do not require model calls",
  );
  await summarizeTypeDescription(
    "s",
    type,
    "New manual convention",
    examples,
    call,
    signal,
  );
  assert.equal(
    calls.length,
    8,
    "manual rules invalidate the matching type summary",
  );
  await summarizeTypeDescription(
    "s",
    type,
    "New manual convention",
    examples.slice(1),
    call,
    signal,
  );
  assert.equal(
    calls.length,
    12,
    "excluded references invalidate the matching type summary",
  );
  const modified = examples
    .slice(1)
    .map((e, index) =>
      index === 0 ? { ...e, cues: "Changed source cues" } : e,
    );
  await summarizeTypeDescription(
    "s",
    type,
    "New manual convention",
    modified,
    call,
    signal,
  );
  assert.equal(
    calls.length,
    16,
    "changed cached example descriptions are not reused",
  );
  await assert.rejects(
    summarizeTypeDescription(
      "s",
      { id: "failed-summary", label: "Failed" },
      "",
      examples,
      (async () => {
        throw new Error("Summary unavailable");
      }) as import("../src/lib/server/directorModel").DirectorModelCall,
      signal,
    ),
    /Summary unavailable/,
  );
  assert.equal(
    sqlite
      .prepare(
        "SELECT 1 FROM director_type_descriptions WHERE type_id='failed-summary'",
      )
      .get(),
    undefined,
  );
  sqlite
    .prepare(
      "DELETE FROM director_type_descriptions WHERE series_id='s' AND type_id='summary-test'",
    )
    .run();
});

test("visually corrects an existing wrong type, preserves custom styles and supports undo", async () => {
  const page = await seedChapter("wrong-type", 6);
  sqlite
    .prepare("UPDATE lines SET line_type='thought' WHERE id=?")
    .run(page.lineId);
  const region = getDoc<any>(`region:${page.lineId}`, {});
  // Thought defaults to italic and plain dialogue to normal; the region's own fill and size are custom.
  const config = getDoc<any>("series:s", {});
  const savedStyles = config.data.styles;
  putDoc(null, config.id, {
    ...config.data,
    styles: { ...savedStyles, thought: { ...savedStyles?.thought, emphasis: "italic" }, plain: { ...savedStyles?.plain, emphasis: "normal" } },
  }, config.revision);
  const ownStyle = { fontId: font.id, size: 15, minSize: 8, fill: "#335577", emphasis: "italic" };
  putDoc(
    page.episode.id,
    region.id,
    { ...region.data, style: ownStyle, styleFromSeries: undefined },
    region.revision,
  );
  const result = await runPage(page);
  const restored = getDoc<any>("series:s", {});
  putDoc(null, restored.id, { ...restored.data, styles: savedStyles }, restored.revision);
  assert.equal(
    result.overview.pages[0].state,
    "passed",
    result.overview.pages[0].detail,
  );
  assert.equal((await listLines(page.episode.id))[0].lineType, "plain");
  const style = getDoc<any>(`region:${page.lineId}`, {}).data.style;
  assert.equal(style.fill, "#335577");
  assert.equal(style.size, 15);
  assert.equal(style.fontId, font.id);
  assert.equal(style.emphasis, "normal", "the thought default must not follow the region to dialogue");
  assert.ok(
    result.overview.events.some((event) => event.kind === "type:changed"),
  );
  undoDirector({ episodeId: page.episode.id, runId: result.runId });
  assert.equal((await listLines(page.episode.id))[0].lineType, "thought");
});

test("creates and reuses a missing series type with provenance and reversible defaults", async () => {
  const page = await seedChapter("new-type", 6);
  const normal = respond;
  respond = (purpose, data) =>
    purpose === "classify-regions"
      ? {
          classifications: data.regions.map((line: any) => ({
            lineId: line.id,
            typeId: "",
            newLabel: "Radio dialogue",
            parentType: "plain",
            certain: true,
            reason: "Visible jagged radio balloon.",
            referenceIds: [],
            candidateTypeIds: [],
          })),
        }
      : normal(purpose, data);
  try {
    const result = await runPage(page);
    assert.equal(
      result.overview.pages[0].state,
      "passed",
      result.overview.pages[0].detail,
    );
    const id = (await listLines(page.episode.id))[0].lineType;
    assert.equal(id, "radio-dialogue");
    const config = getDoc<any>("series:s", {}).data;
    assert.ok(config.regionKinds.some((kind: any) => kind.id === id));
    const again = createDirectorType(
      "s",
      result.runId,
      page.imageId,
      "Radio dialogue",
      "plain",
      "Same category",
    );
    assert.equal(again, id);
    assert.equal(
      (
        sqlite
          .prepare(
            "SELECT count(*) n FROM director_created_types WHERE type_id=?",
          )
          .get(id) as any
      ).n,
      1,
    );
    const refs = await referenceCandidates("s", page.episode);
    assert.ok(
      !refs.candidates.some((x) => x.imageId === page.imageId),
      "current machine output is not a trusted historical reference",
    );
    undoDirector({ episodeId: page.episode.id, runId: result.runId });
    assert.ok(
      !getDoc<any>("series:s", {}).data.regionKinds.some(
        (kind: any) => kind.id === id,
      ),
    );
  } finally {
    respond = normal;
  }
});

test("ambiguous or locked classification becomes a blocker and never silently passes", async () => {
  const page = await seedChapter("locked-type", 6);
  sqlite
    .prepare("UPDATE lines SET line_type='thought' WHERE id=?")
    .run(page.lineId);
  const region = getDoc<any>(`region:${page.lineId}`, {});
  putDoc(
    page.episode.id,
    region.id,
    { ...region.data, locked: true },
    region.revision,
  );
  const result = await runPage(page);
  assert.equal(result.overview.pages[0].state, "unresolved");
  assert.match(result.overview.pages[0].detail, /locked|layout/i);
  assert.equal((await listLines(page.episode.id))[0].lineType, "thought");
  assert.ok(
    result.overview.pages[0].findings.some((f: any) => f.stage === "classify"),
  );
});

test("outside handwritten speech is corrected to Aside using physical evidence, never treated as bubble dialogue or SFX", async (t) => {
  const originalConfig=getDoc<any>('series:s',{}).data;
  const config=getDoc<any>('series:s',{});
  putDoc('s',config.id,{...config.data,regionKinds:[...config.data.regionKinds,
    {id:'//',label:'Aside'},{id:'::',label:'SFX'}],
    },config.revision);
  const normal=respond;
  try {
    for(const guessed of ['plain','::']) await t.test(guessed,async()=>{
      const page=await seedChapter(`outside-aside-${guessed==='plain'?'dialogue':'sfx'}`,30);
      const region=getDoc<any>(`region:${page.lineId}`,{});
      putDoc(page.episode.id,region.id,{...region.data,detectionKind:'free'},region.revision);
      let classifications=0;
      const start=requests.length;
      respond=(purpose,data)=>{
        const result=normal(purpose,data);
        if(purpose==='inspect-region-presentation') return {observations:[{lineId:page.lineId,enclosure:'none',handwritten:true,letteringVisible:true,role:'speech',reason:'Handwritten speech outside the adjacent bubble; short speaker leader only.'}]};
        if(purpose==='classify-regions') {
          classifications++;
          assert.equal(data.regions[0].detectionKind,'free');
          assert.equal(data.regions[0].presentation.enclosure,'none');
          if(classifications===2) assert.match(data.responseCorrection,/OUTSIDE.*Aside/);
          return {classifications:result.classifications.map((decision:any)=>({...decision,typeId:classifications===1?guessed:'//',referenceIds:[],reason:classifications===1?'Handwritten outside the bubble.':'Aside speech outside the bubble.'}))};
        }
        return result;
      };
      const result=await runPage(page);
      assert.equal(result.overview.pages[0].state,'passed',result.overview.pages[0].detail);
      assert.equal(classifications,2);
      const line=(await listLines(page.episode.id))[0];
      assert.equal(line.lineType,'//');
      assert.equal(getDoc<any>(`region:${line.id}`,{}).data.directorPresentation.enclosure,'none');
      const inspection=requests.slice(start).find(r=>r.purpose==='inspect-region-presentation')!;
      assert.equal(inspection.imageCount,3,'Raw page plus context and exact-target crop');
      assert.equal(inspection.data.imageOrder.length,3);
    });
    await t.test('a contradictory certain classification stops before changing the region',async()=>{
      const page=await seedChapter('outside-aside-rejected',30);
      const region=getDoc<any>(`region:${page.lineId}`,{});
      putDoc(page.episode.id,region.id,{...region.data,detectionKind:'free'},region.revision);
      respond=(purpose,data)=>purpose==='inspect-region-presentation'
        ?{observations:[{lineId:page.lineId,enclosure:'none',handwritten:true,letteringVisible:true,role:'speech',reason:'Outside speech, no enclosing border.'}]}
        :normal(purpose,data);
      const result=await runPage(page);
      assert.equal(result.overview.pages[0].state,'unresolved');
      assert.match(result.overview.pages[0].detail,/OUTSIDE.*Aside/);
      assert.equal((await listLines(page.episode.id))[0].lineType,'plain');
      assert.equal(getDoc<any>(`region:${page.lineId}`,{}).data.directorPresentation,undefined);
    });
    await t.test('outside sound effects keep their own category',async()=>{
      const page=await seedChapter('outside-sfx',30);
      const region=getDoc<any>(`region:${page.lineId}`,{});
      putDoc(page.episode.id,region.id,{...region.data,detectionKind:'free'},region.revision);
      respond=(purpose,data)=>{
        const result=normal(purpose,data);
        if(purpose==='inspect-region-presentation') return {observations:[{lineId:page.lineId,enclosure:'none',handwritten:true,letteringVisible:true,role:'sfx',reason:'Sound effect of footsteps outside the balloons.'}]};
        if(purpose==='classify-regions') return {classifications:result.classifications.map((d:any)=>({...d,typeId:'::',referenceIds:[]}))};
        return result;
      };
      const result=await runPage(page);
      assert.equal(result.overview.pages[0].state,'passed',result.overview.pages[0].detail);
      assert.equal((await listLines(page.episode.id))[0].lineType,'::');
    });
    await t.test('artwork the region check sees no lettering in is excluded before classification',async()=>{
      const page=await seedChapter('outside-shoelaces',30);
      const region=getDoc<any>(`region:${page.lineId}`,{});
      putDoc(page.episode.id,region.id,{...region.data,detectionKind:'free'},region.revision);
      const asked:string[]=[];
      respond=(purpose,data)=>{
        asked.push(purpose);
        if(purpose==='inspect-region-presentation') return {observations:[{lineId:page.lineId,enclosure:'none',handwritten:false,letteringVisible:false,role:'uncertain',reason:'The tight crop shows only shoelaces on a shoe.'}]};
        if(purpose==='verify-lettering') return {hasLettering:false,reason:'White shoelaces crossing a brown sneaker; no characters.'};
        return normal(purpose,data);
      };
      await runPage(page);
      const line=(await listLines(page.episode.id)).find(l=>l.id===page.lineId)!;
      assert.equal(line.sourceState,'ignored');
      assert.equal(getDoc<any>(`region:${page.lineId}`,{}).data.directorDetectionReview?.verdict,'non-text');
      assert.ok(asked.indexOf('verify-lettering')<asked.indexOf('inspect-region-presentation')+2,'checked straight after the region check');
      assert.ok(!asked.slice(asked.indexOf('verify-lettering')).includes('classify-regions'),'excluded artwork is never classified');
    });
    await t.test('a specific cited user rule can override the default aside category',async()=>{
      const page=await seedChapter('outside-explicit-rule',30);
      const region=getDoc<any>(`region:${page.lineId}`,{});
      putDoc(page.episode.id,region.id,{...region.data,detectionKind:'free'},region.revision);
      const saved=memorySettings('s');
      saveMemorySettings('s',saved.revision,{rules:{...saved.data.rules,plain:'All spoken words use Dialogue in this series, including handwritten speech outside balloons.'}});
      respond=(purpose,data)=>{
        const result=normal(purpose,data);
        if(purpose==='inspect-region-presentation') return {observations:[{lineId:page.lineId,enclosure:'none',handwritten:true,letteringVisible:true,role:'speech',reason:'Spoken aside outside any border.'}]};
        if(purpose==='classify-regions') return {classifications:result.classifications.map((d:any)=>({...d,ruleOverride:'plain',reason:'The explicit plain rule includes outside handwritten speech.'}))};
        return result;
      };
      try {
        const result=await runPage(page);
        assert.equal(result.overview.pages[0].state,'passed',result.overview.pages[0].detail);
        assert.equal((await listLines(page.episode.id))[0].lineType,'plain');
        assert.equal(getDoc<any>(`region:${page.lineId}`,{}).data.directorPresentation.enclosure,'none','User style rules do not change the physical enclosure');
      } finally {saveMemorySettings('s',memorySettings('s').revision,{rules:saved.data.rules});}
    });
  } finally {
    respond=normal;
    const current=getDoc<any>('series:s',{});
    putDoc('s',current.id,originalConfig,current.revision);
  }
});

test("visual lettering defects stay blockers after bounded repairs", async () => {
  const page = await seedChapter("visual-blocker", 6);
  const normal = respond;
  let checks = 0;
  respond = (purpose, data) =>
    purpose === "check-page"
      ? (checks++,
        {
          findings: [
            {
              lineId: page.lineId,
              code: "clipped",
              message: "English is clipped",
              evidence: "Right edge is cut off",
              repair: "typeset",
            },
          ],
        })
      : normal(purpose, data);
  try {
    const result = await runPage(page);
    assert.equal(result.overview.pages[0].state, "unresolved");
    assert.equal(checks, 1, "a no-op repair must not trigger another review");
    assert.ok(
      result.overview.pages[0].findings.some((f: any) => f.code === "clipped"),
    );
  } finally {
    respond = normal;
  }
});

test("unreadable page does not stop other chapter pages", async () => {
  const page = await seedChapter("chapter-continues", 6);
  sqlite
    .prepare(
      `INSERT INTO images(id,episode_id,filename,original_name,sort_order,width,height,created_at,updated_at,page_number,caption)
    VALUES('missing-page',?,'missing.png','missing.png',1,100,100,1,1,2,'missing')`,
    )
    .run(page.episode.id);
  const { runId } = await startDirector({
    ...page,
    user,
    scope: "chapter",
    model: selected,
  });
  await waitRun(runId);
  const result = await directorOverviewAsync(page.episode.id, runId);
  assert.equal(
    result.pages.find((p) => p.id === page.imageId)?.state,
    "passed",
  );
  assert.equal(
    result.pages.find((p) => p.id === "missing-page")?.state,
    "unresolved",
  );
});

test("a textless raw upload is visually checked and stays without human completion", async () => {
  const page = await seedChapter("blank-page", 6);
  sqlite.prepare("DELETE FROM lines WHERE episode_id=?").run(page.episode.id);
  const result = await runPage(page);
  assert.equal(
    result.overview.pages[0].state,
    "passed",
    result.overview.pages[0].detail,
  );
  assert.ok(
    result.overview.events.some((event) => event.kind === "page:empty"),
  );
  assert.equal(
    getDoc<any>(`page:${page.imageId}`, {}).data.completed,
    undefined,
  );
});

test("visual detection fills a raw page in series reading order and remains undoable", async () => {
  const masks = await localMaskFixture({ flatClean: true });
  const page = await seedChapter("visual-detection", 6);
  sqlite.prepare("DELETE FROM lines WHERE episode_id=?").run(page.episode.id);
  proofreaderReply=(mode,{rows})=>mode==='critique'?'Source and English are accurate. No visual defects.':rows.map((row:any)=>`Region ${row.id}: Original source: ${row.x!>.5?"右":"左"}; English: Hello`).join('\n');
  const normal = respond;
  respond = (purpose, data) =>
    purpose === "inspect-region-coverage"
      ? {
          regions: [
            { x: 0.1, y: 0.15, w: 0.3, h: 0.3, source: "左", uncertain: false },
            { x: 0.6, y: 0.15, w: 0.3, h: 0.3, source: "右", uncertain: false },
            { x: 0.6, y: 0.15, w: 0.3, h: 0.3, source: "右", uncertain: false },
          ],
        }
      : normal(purpose, data);
  try {
    const result = await runPage(page);
    assert.equal(
      result.overview.pages[0].state,
      "passed",
      result.overview.pages[0].detail,
    );
    const lines = await listLines(page.episode.id);
    assert.equal(
      lines.length,
      2,
      "repeated detections do not create duplicate regions",
    );
    assert.deepEqual(
      lines
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((line) => line.source),
      ["右", "左"],
    );
    assert.ok(
      lines.every(
        (line) =>
          line.body === "Hello" &&
          line.lineType === "plain" &&
          line.status !== "approved",
      ),
    );
    assert.equal(
      getDoc<any>(`page:${page.imageId}`, {}).data.completed,
      undefined,
    );
    undoDirector({ episodeId: page.episode.id, runId: result.runId });
    assert.equal((await listLines(page.episode.id)).length, 0);
  } finally {
    respond = normal;
    proofreaderReply=undefined;
    masks.restore();
  }
});

test("Director adds missed regions to a partially detected page, cleans them, and avoids overlapping duplicates", async () => {
  const masks = await localMaskFixture({ flatClean: true });
  const page = await seedChapter("partial-detection", 6);
  const oldLine = (await listLines(page.episode.id))[0];
  const oldRegion = getDoc<any>(`region:${oldLine.id}`, {}).data;
  sqlite
    .prepare(
      `INSERT INTO lines(id,episode_id,image_id,body,line_type,status,placed,x,y,w,h,sort_order,updated_at,updated_by,source,source_state,ignore_reason)
    VALUES('ignored-missed-text',?,?,'','plain','none',1,.75,.1,.15,.15,1,1,'u','SKIP','ignored','Decoration')`,
    )
    .run(page.episode.id, page.imageId);
  proofreaderReply=(mode,{rows})=>mode==='critique'?'Source and English are accurate. No visual defects.':rows.map((row:any)=>`Region ${row.id}: Original source: ${row.id===page.lineId?"こんにちは":"놓친 글자"}; English: Hello`).join('\n');
  const normal = respond;
  let scans = 0;
  respond = (purpose, data) => {
    if (purpose === "inspect-region-coverage") {
      scans++;
      assert.ok(data.existing.some((r: any) => r.id === oldLine.id));
      assert.equal(data.ignored.length, 1);
      return {
        regions: [
          {
            x: 0.22,
            y: 0.22,
            w: 0.45,
            h: 0.25,
            source: "duplicate existing",
            uncertain: false,
          },
          {
            x: 0.77,
            y: 0.12,
            w: 0.1,
            h: 0.1,
            source: "ignored",
            uncertain: false,
          },
          {
            x: 0.1,
            y: 0.65,
            w: 0.3,
            h: 0.15,
            source: "놓친 글자",
            uncertain: false,
          },
          {
            x: 0.11,
            y: 0.66,
            w: 0.3,
            h: 0.15,
            source: "duplicate new",
            uncertain: false,
          },
        ],
      };
    }
    return normal(purpose, data);
  };
  try {
    const result = await runPage(page);
    assert.equal(
      result.overview.pages[0].state,
      "passed",
      result.overview.pages[0].detail,
    );
    const lines = await listLines(page.episode.id);
    assert.equal(
      lines.length,
      3,
      "only the uncovered lettering creates a new region",
    );
    const added = lines.find(
      (l) => l.id !== oldLine.id && l.sourceState !== "ignored",
    )!;
    assert.equal(added.source, "놓친 글자");
    assert.equal(added.body, "Hello");
    assert.equal(added.lineType, "plain");
    assert.ok(getDoc<any>(`region:${added.id}`, {}).data.layout);
    const existing = lines.find((l) => l.id === oldLine.id)!;
    assert.deepEqual(
      [existing.x, existing.y, existing.w, existing.h],
      [oldLine.x, oldLine.y, oldLine.w, oldLine.h],
    );
    assert.deepEqual(
      getDoc<any>(`region:${oldLine.id}`, {}).data.polygon,
      oldRegion.polygon,
    );
    assert.equal(
      lines.find((l) => l.id === "ignored-missed-text")?.sourceState,
      "ignored",
    );
    const cleanCalls = (await masks.calls()).filter(p=>p.detect);
    assert.equal(cleanCalls.length, 1);
    assert.equal(
      cleanCalls[0].regions.length,
      1,
      "clean only newly found text over the existing artwork",
    );
    assert.deepEqual(cleanCalls[0].regions[0][0], { x: added.x, y: added.y });
    const saved = getDoc<any>(`page:${page.imageId}`, {}).data;
    assert.ok(saved.cleaned);
    assert.equal(saved.previousArtwork, page.artwork);
    assert.equal(saved.pendingCleanRegions, undefined);
    assert.equal(saved.cleanApproved, false);
    assert.equal(saved.completed, undefined);
    assert.ok(
      result.overview.events.some(
        (e) => e.kind === "region:created" && e.detail.lineId === added.id,
      ),
    );
    const second = await runPage(page);
    assert.equal(
      second.overview.pages[0].state,
      "passed",
      second.overview.pages[0].detail,
    );
    assert.equal(scans, 2, "explicit page rechecks repeat coverage inspection");
    assert.equal((await listLines(page.episode.id)).length, 3);
    undoDirector({ episodeId: page.episode.id, runId: second.runId });
    undoDirector({ episodeId: page.episode.id, runId: result.runId });
    assert.equal((await listLines(page.episode.id)).length, 2);
    assert.equal(
      getDoc<any>(`page:${page.imageId}`, {}).data.cleanBase,
      page.artwork,
    );
  } finally {
    respond = normal;
    proofreaderReply=undefined;
    masks.restore();
  }
});

test("final QA can request creation of a missing region without inventing an existing ID", async () => {
  const masks = await localMaskFixture({ flatClean: true });
  const page = await seedChapter("late-missed-text", 6);
  proofreaderReply=(mode,{rows})=>mode==='critique'?'Source and English are accurate. No visual defects.':rows.map((row:any)=>`Region ${row.id}: Original source: ${row.id===page.lineId?"こんにちは":"효과음"}; English: Hello`).join('\n');
  const normal = respond;
  let scans = 0,
    checks = 0;
  respond = (purpose, data) => {
    if (purpose === "inspect-region-coverage") {
      scans++;
      if (scans === 1) return { regions: [] };
      assert.equal(data.findings[0].repair, "detect");
      assert.equal(data.findings[0].lineId, "");
      return {
        regions: [
          {
            x: 0.1,
            y: 0.65,
            w: 0.3,
            h: 0.15,
            source: "효과음",
            uncertain: false,
          },
        ],
      };
    }
    if (purpose === "check-page" && ++checks === 1)
      return {
        findings: [
          {
            lineId: "",
            code: "missing-region",
            message: "Sound effect has no region",
            evidence: "Korean lettering at lower left",
            repair: "detect",
          },
        ],
      };
    return normal(purpose, data);
  };
  try {
    const result = await runPage(page);
    assert.equal(
      result.overview.pages[0].state,
      "passed",
      result.overview.pages[0].detail,
    );
    const added = (await listLines(page.episode.id)).find(
      (l) => l.source === "효과음",
    )!;
    assert.ok(added);
    assert.equal(added.body, "Hello");
    assert.ok(getDoc<any>(`region:${added.id}`, {}).data.layout);
    assert.equal(scans, 2);
    assert.equal(checks, 2);
    assert.equal((await masks.calls()).filter(p=>p.detect).length, 1);
    assert.equal(
      getDoc<any>(`page:${page.imageId}`, {}).data.pendingCleanRegions,
      undefined,
    );
    undoDirector({ episodeId: page.episode.id, runId: result.runId });
    assert.equal((await listLines(page.episode.id)).length, 1);
  } finally {
    respond = normal;
    proofreaderReply=undefined;
    masks.restore();
  }
});

test("a missing region that coverage cannot find becomes a warning instead of failing the page", async () => {
  const page = await seedChapter("phantom-missed-text", 6);
  const normal = respond;
  let checks = 0;
  respond = (purpose, data) => {
    if (purpose === "inspect-region-coverage") return { regions: [], edits: [] };
    if (purpose === "check-page" && ++checks === 1)
      return {
        findings: [
          {
            lineId: "",
            code: "missing-region",
            message: "Speech bubble with an ellipsis has no region",
            evidence: "An ellipsis bubble on the left",
            severity: "blocker",
            repair: "detect",
          },
        ],
      };
    return normal(purpose, data);
  };
  try {
    const result = await runPage(page);
    const state = result.overview.pages[0];
    assert.notEqual(state.state, "unresolved", state.detail);
    assert.equal(checks, 1, "nothing changed, so the page is not reviewed again");
    assert.ok(result.overview.events.some((event) => event.kind === "finding:unconfirmed"));
    const findings = JSON.parse(
      (sqlite.prepare("SELECT findings FROM director_pages WHERE image_id=?").get(page.imageId) as any).findings,
    );
    assert.deepEqual(
      findings.filter((f: any) => f.code === "missing-region").map((f: any) => f.severity),
      ["warning"],
    );
  } finally {
    respond = normal;
  }
});

test("explicit rechecks refresh classification, cleaning and QA while reusing learned examples", async () => {
  const page = await seedChapter("explicit-recheck", 6);
  await runPage(page);
  const count = (purpose: string) =>
    requests.filter((request) => request.purpose === purpose).length;
  const before = {
    classify: count("classify-regions"),
    check: count("check-page"),
    clean: count("inspect-cleaning"),
    learn: count("learn-region-example"),
  };
  const { runId } = await startDirector({
    ...page,
    user,
    scope: "chapter",
    model: selected,
    recheckAll: true,
  });
  await waitRun(runId);
  assert.equal(
    (await directorOverviewAsync(page.episode.id, runId)).pages[0].state,
    "passed",
  );
  assert.equal(count("classify-regions"), before.classify + 1);
  assert.equal(count("check-page"), before.check + 1);
  assert.ok(count("inspect-cleaning") > before.clean, "A recheck cannot bypass cleaning by copying a previous passed stage");
  assert.equal(count("learn-region-example"), before.learn);
  const settings = getDoc<any>("series:s", {});
  putDoc(
    null,
    settings.id,
    { ...settings.data, style: { ...settings.data.style, padding: 9 } },
    settings.revision,
  );
  assert.equal(
    (await directorOverviewAsync(page.episode.id)).pages[0].state,
    "stale",
    "default style changes invalidate QA",
  );
  const current = getDoc<any>("series:s", {});
  putDoc(null, current.id, settings.data, current.revision);
});

test("a passed page that went stale is skipped by a chapter run until Recheck all or a reset", async () => {
  const page = await seedChapter("stale-skip", 41);
  await runPage(page);
  sqlite
    .prepare("UPDATE director_pages SET version=1 WHERE episode_id=?")
    .run(page.episode.id);
  assert.equal((await directorOverviewAsync(page.episode.id)).pages[0].state, "stale");
  await assert.rejects(
    startDirector({ ...page, user, scope: "chapter", model: selected }),
    /already passed Director/,
  );
  resetDirectorPage(page.episode.id, page.imageId);
  const { runId } = await startDirector({ ...page, user, scope: "chapter", model: selected });
  await waitRun(runId);
  assert.equal((await directorOverviewAsync(page.episode.id, runId)).pages[0].state, "passed");
});

test("pause and resume reuse saved stages, and recovery respects explicit stopped states", async () => {
  const page = await seedChapter("resume-page", 6);
  const normal = respond;
  let release!: () => void, entered!: () => void;
  const reached = new Promise<void>((resolve) => (entered = resolve));
  const hold = new Promise<void>((resolve) => (release = resolve));
  respond = async (purpose, data) => {
    if (purpose === "classify-regions") {
      entered();
      await hold;
    }
    return normal(purpose, data);
  };
  const { runId } = await startDirector({
    ...page,
    user,
    scope: "page",
    imageId: page.imageId,
    model: selected,
  });
  await reached;
  stopDirector(page.episode.id, runId);
  release();
  await waitRun(runId);
  assert.equal(
    (
      sqlite
        .prepare("SELECT state FROM director_runs WHERE id=?")
        .get(runId) as any
    ).state,
    "paused",
  );
  respond = normal;
  await resumeDirector({ ...page, user, runId });
  await waitRun(runId);
  const result = await directorOverviewAsync(page.episode.id, runId);
  assert.equal(result.pages[0].state, "passed", result.pages[0].detail);
  assert.ok(
    result.events.some(
      (event) =>
        event.kind === "stage:reused" && event.detail.stage === "prepare",
    ),
  );
  sqlite
    .prepare(
      "UPDATE director_runs SET state='recovering',current_index=0 WHERE id=?",
    )
    .run(runId);
  await recoverDirectorRuns();
  await waitRun(runId);
  assert.equal(
    (
      sqlite
        .prepare("SELECT count(*) n FROM lines WHERE episode_id=?")
        .get(page.episode.id) as any
    ).n,
    1,
  );
  sqlite
    .prepare("UPDATE director_runs SET state='paused' WHERE id=?")
    .run(runId);
  await recoverDirectorRuns();
  assert.equal(
    (
      sqlite
        .prepare("SELECT state FROM director_runs WHERE id=?")
        .get(runId) as any
    ).state,
    "paused",
  );
});

test("text correction keeps surrounding chapter context bounded and preserves complete target regions", async () => {
  const page = await seedChapter("bounded-text-context", 6);
  sqlite
    .prepare(
      `INSERT INTO images(id,episode_id,filename,original_name,sort_order,width,height,created_at,updated_at,page_number,caption)
    VALUES('context-only-page',?,'unused.png','unused.png',1,400,500,1,1,2,'Context only')`,
    )
    .run(page.episode.id);
  const insert =
    sqlite.prepare(`INSERT INTO lines(id,episode_id,image_id,body,line_type,status,placed,x,y,w,h,sort_order,updated_at,updated_by,source,source_state)
    VALUES(?,?,'context-only-page',?,'plain','none',1,.1,.1,.2,.2,?,1,'u',?,'read')`);
  for (let n = 0; n < 30; n++)
    insert.run(
      `context-line-${n}`,
      page.episode.id,
      "Long surrounding English. ".repeat(80),
      n,
      "Long surrounding source. ".repeat(80),
    );
  const normal = respond;
  let checked = false;
  respond = (purpose, data) => {
    if (purpose === "correct-text") {
      checked = true;
      assert.ok(data.chapter.length > 0 && data.chapter.length <= 12);
      assert.ok(JSON.stringify(data.chapter).length <= 6000);
      assert.ok(
        data.chapter.every(
          (item: any) =>
            item.source.length <= 300 &&
            item.english.length <= 300 &&
            item.truncated,
        ),
      );
      assert.equal(data.regions[0].source, "こんにちは");
      assert.equal(data.regions[0].english, "Hello");
    }
    return normal(purpose, data);
  };
  try {
    const result = await runPage(page);
    assert.equal(
      result.overview.pages.find((p) => p.id === page.imageId)?.state,
      "passed",
    );
    assert.ok(checked);
    assert.equal(
      (await listLines(page.episode.id)).find((l) => l.id === "context-line-0")
        ?.body,
      "Long surrounding English. ".repeat(80),
    );
  } finally {
    respond = normal;
  }
});

test("uncertain classification uses new evidence with the chosen Director, not a promoted fallback", async () => {
  const page = await seedChapter("primary-stage-retry", 6);
  const fallback = createLocalHttpRow({
    name: "Repair fallback",
    slug: "repair-fallback",
  });
  await fixturePasses(fallback.id, ["director"]);
  const normal = respond;
  const start = requests.length;
  let classifications = 0;
  respond = (purpose, data) => {
    const result = normal(purpose, data);
    if (purpose === "classify-regions" && ++classifications === 1)
      return {
        classifications: result.classifications.map((item: any) => ({
          ...item,
          certain: false,
          reason: "Needs another look",
        })),
      };
    return result;
  };
  try {
    const result = await runPage(page, {
      fallbacks: [{ engine: fallback.id, model: fallback.slug }],
    });
    assert.equal(
      result.overview.pages[0].state,
      "passed",
      result.overview.pages[0].detail,
    );
    assert.equal(classifications, 2);
    assert.deepEqual(
      requests
        .slice(start)
        .filter((r) => r.purpose === "classify-regions")
        .map((r) => r.model),
      [model.slug, model.slug],
    );
    assert.ok(requests.slice(start).every((r) => r.model !== fallback.slug));
  } finally {
    respond = normal;
  }
});

test("structured Director requests disable Qwen thinking through the HTTP adapter", async () => {
  const row = createLocalHttpRow({
    name: "Qwen request fixture",
    slug: "qwen-request-fixture",
  });
  updateRegistryRow(row.id, { requestPreset: "qwen-thinking" });
  await fixturePasses(row.id, ["director"]);
  const saved = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    bodies.push(payload);
    return Response.json({
      choices: [{ message: { content: '{"answer":"ok"}' } }],
    });
  };
  try {
    const call = directorModel(
      { engine: row.id, model: row.slug },
      directorPolicy(),
      new AbortController().signal,
    );
    const { objectSchema, requiredString } =
      await import("../src/lib/server/directorModel");
    await call(
      "thinking-test",
      "Return JSON",
      {},
      [],
      objectSchema({ answer: requiredString }),
    );
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].model, row.slug);
    assert.deepEqual(bodies[0].chat_template_kwargs, {
      enable_thinking: false,
      reasoning_effort: "none",
    });
  } finally {
    globalThis.fetch = saved;
  }
});

test("Director distinguishes request timeouts from cancellation and only uses explicitly configured fallbacks", async () => {
  const fallback = createLocalHttpRow({
    name: "Timeout fallback",
    slug: "timeout-fallback",
  });
  await fixturePasses(fallback.id, ["director"]);
  const saved = globalThis.fetch;
  const models: string[] = [];
  let mode = "timeout";
  const controller = new AbortController();
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    models.push(payload.model);
    if (mode === "cancel") controller.abort();
    if (payload.model === fallback.slug || mode === "success")
      return Response.json({
        choices: [{ message: { content: '{"answer":"ok"}' } }],
      });
    return new Promise((_resolve, reject) => {
      const abort = () =>
        reject(new DOMException("The operation was aborted", "AbortError"));
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  };
  try {
    const { objectSchema, requiredString } =
      await import("../src/lib/server/directorModel");
    const schema = objectSchema({ answer: requiredString });
    const withoutFallback = directorModel(
      selected,
      directorPolicy({ requestTimeoutMs: 1000 }),
      new AbortController().signal,
    );
    await assert.rejects(
      withoutFallback("timeout-test", "Test", {}, [], schema),
      /timed out after 1 seconds during timeout-test/,
    );
    assert.deepEqual(
      models,
      [model.slug],
      "a timeout does not invent a provider or immediately repeat the same request",
    );
    models.length = 0;
    const call = directorModel(
      selected,
      directorPolicy({
        requestTimeoutMs: 1000,
        fallbacks: [{ engine: fallback.id, model: fallback.slug }],
      }),
      new AbortController().signal,
    );
    const result = await call<any>("timeout-fallback", "Test", {}, [], schema);
    assert.equal(result.answer, "ok");
    assert.deepEqual(models, [model.slug, fallback.slug]);
    mode = "success";
    await call("fresh-request", "Test", {}, [], schema);
    assert.deepEqual(
      models,
      [model.slug, fallback.slug, model.slug],
      "a new request starts with the selected Director",
    );
    models.length = 0;
    mode = "cancel";
    const cancelled = directorModel(
      selected,
      directorPolicy({
        fallbacks: [{ engine: fallback.id, model: fallback.slug }],
      }),
      controller.signal,
    );
    await assert.rejects(cancelled("cancel-test", "Test", {}, [], schema), {
      name: "AbortError",
    });
    assert.deepEqual(models, [model.slug], "Stop must never call a fallback");
  } finally {
    globalThis.fetch = saved;
  }
});

test("fallbacks are explicit and malformed outputs get a bounded correction", async () => {
  const fallback = createLocalHttpRow({
    name: "Fallback",
    slug: "fallback-fixture",
  });
  await fixturePasses(fallback.id, ["director"]);
  const saved = globalThis.fetch;
  const models: string[] = [];
  globalThis.fetch = async (url, init) => {
    const payload = JSON.parse(String(init?.body || "{}"));
    models.push(payload.model);
    if (payload.model === model.slug)
      return Response.json({
        choices: [{ message: { content: '{"wrong":true}' } }],
      });
    return Response.json({
      choices: [{ message: { content: '{"answer":"ok"}' } }],
    });
  };
  try {
    const call = directorModel(
      selected,
      directorPolicy({
        fallbacks: [{ engine: fallback.id, model: fallback.slug }],
      }),
      new AbortController().signal,
    );
    const { objectSchema, requiredString } =
      await import("../src/lib/server/directorModel");
    const result = await call<any>(
      "test",
      "Test",
      {},
      [],
      objectSchema({ answer: requiredString }),
    );
    assert.equal(result.answer, "ok");
    assert.deepEqual(models, [model.slug, model.slug, fallback.slug]);
  } finally {
    globalThis.fetch = saved;
  }
});

test("a configured compatible fallback completes QA when the primary proofreader is unavailable", async () => {
  const page = await seedChapter("proofreader-fallback", 6);
  const settings = getDoc<any>("series:s", {});
  putDoc(
    null,
    settings.id,
    {
      ...settings.data,
      regionAi: {
        ...settings.data.regionAi,
        proofread: { engine: "missing-proofreader", model: "" },
      },
    },
    settings.revision,
  );
  try {
    const { runId } = await startDirector({
      ...page,
      user,
      scope: "page",
      imageId: page.imageId,
      model: selected,
      policy: { fallbacks: [selected] },
    });
    await waitRun(runId);
    const result = await directorOverviewAsync(page.episode.id, runId);
    assert.equal(result.pages[0].state, "passed", result.pages[0].detail);
    assert.equal(
      getDoc<any>(`page:${page.imageId}`, {}).data.completed,
      undefined,
    );
  } finally {
    const current = getDoc<any>("series:s", {});
    putDoc(null, current.id, settings.data, current.revision);
  }
});

test("final visual QA rejects findings attributed to a different page", async () => {
  const page = await seedChapter("invalid-qa-id", 6);
  const normal = respond;
  respond = (purpose, data) =>
    purpose === "check-page"
      ? {
          findings: [
            {
              lineId: "another-page-line",
              code: "wrong-type",
              message: "Wrong type",
              evidence: "Balloon shape",
              repair: "classify",
            },
          ],
        }
      : normal(purpose, data);
  try {
    const result = await runPage(page);
    assert.equal(result.overview.pages[0].state, "unresolved");
    assert.match(
      result.overview.pages[0].detail,
      /\$\.findings\[0\]\.lineId must match one of the allowed values/,
    );
  } finally {
    respond = normal;
  }
});

test("undo after an interrupted operation restores committed changes and preserves later edits", async () => {
  const page = await seedChapter("journal", 6);
  const result = await runPage(page);
  const before = snapshotPage(page.episode.id, page.imageId);
  sqlite
    .prepare(
      "INSERT INTO director_operations(run_id,episode_id,image_id,label,before_json) VALUES(?,?,?,?,?)",
    )
    .run(
      result.runId,
      page.episode.id,
      page.imageId,
      "Interrupted edit",
      JSON.stringify(before),
    );
  sqlite.prepare("UPDATE lines SET body='Changed' WHERE id=?").run(page.lineId);
  const { recoverDirectorOperations } =
    await import("../src/lib/server/directorState");
  recoverDirectorOperations(result.runId);
  const change = sqlite
    .prepare(
      "SELECT id FROM director_changes WHERE run_id=? AND label='Interrupted edit'",
    )
    .get(result.runId) as any;
  assert.ok(change);
  recoverDirectorOperations(result.runId);
  assert.equal(
    (
      sqlite
        .prepare(
          "SELECT count(*) n FROM director_changes WHERE run_id=? AND label='Interrupted edit'",
        )
        .get(result.runId) as any
    ).n,
    1,
  );
  sqlite
    .prepare("UPDATE lines SET body='Human correction' WHERE id=?")
    .run(page.lineId);
  assert.throws(
    () => undoDirectorChange(page.episode.id, change.id),
    /changed after Director/,
  );
});

test("cleaning uses a verified mask, preserves outside pixels and never approves its own work", async () => {
  const page = await seedChapter("cleaning-pipeline", 7);
  const doc = getDoc<any>(`page:${page.imageId}`, {});
  putDoc(
    page.episode.id,
    doc.id,
    { prepared: page.artwork, preparedAt: 1, pendingCleanRegions: [page.lineId] },
    doc.revision,
  );
  const mask = await storeAsset(
    await sharp(
      Buffer.from(
        '<svg width="400" height="500"><rect width="400" height="500" fill="black"/><rect x="100" y="120" width="20" height="20" fill="white"/></svg>',
      ),
    )
      .png()
      .toBuffer(),
  );
  const candidate = await storeAsset(
    await sharp({
      create: { width: 400, height: 500, channels: 3, background: "red" },
    })
      .png()
      .toBuffer(),
  );
  const runId = createJob(page.episode.id, "director", {});
  sqlite
    .prepare(
      `INSERT INTO director_runs(id,episode_id,user_id,scope,model,proofreader,state,page_ids,created_at,updated_at,version,policy)
    VALUES(?,?,?,'page',?,?,'running',?,1,1,2,'{}')`,
    )
    .run(
      runId,
      page.episode.id,
      user.id,
      JSON.stringify(selected),
      JSON.stringify(selected),
      JSON.stringify([page.imageId]),
    );
  sqlite
    .prepare(
      "INSERT INTO director_pages(episode_id,image_id,state,run_id,updated_at) VALUES(?,?,'working',?,1)",
    )
    .run(page.episode.id, page.imageId, runId);
  const { runAutomationPage } =
    await import("../src/lib/server/directorAutomation");
  const result = await withDirector(
    { runId, episodeId: page.episode.id, imageId: page.imageId },
    () =>
      runAutomationPage(
        {
          run: {
            id: runId,
            episode_id: page.episode.id,
            model: JSON.stringify(selected),
            proofreader: JSON.stringify(selected),
            policy: "{}",
          },
          ...page,
          user,
          signal: new AbortController().signal,
          authorize: async () => {},
          transcribe: async () => {},
          translationBrief: async () => "Original source: こんにちは. English: Hello.",
          proofread: async () => "No defects",
          imageOperation: async (payload) => ({
            artifact: payload.cmd === "mask" ? mask : candidate,
            result: { method: "fixture" },
          }),
        },
        page.imageId,
      ),
  );
  assert.deepEqual(result.findings, []);
  const saved = getDoc<any>(`page:${page.imageId}`, {}).data;
  assert.equal(saved.cleanApproved, false);
  assert.equal(saved.maskApproved, false);
  assert.equal(saved.completed, undefined);
  const { readAsset } = await import("../src/lib/server/workflowStore");
  const { data, info } = await sharp(await readAsset(saved.cleaned))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => [
    ...data.slice(
      (y * info.width + x) * info.channels,
      (y * info.width + x) * info.channels + 3,
    ),
  ];
  assert.deepEqual(pixel(0, 0), [255, 255, 255]);
  assert.deepEqual(pixel(105, 125), [255, 0, 0]);
  sqlite
    .prepare("UPDATE director_runs SET state='completed' WHERE id=?")
    .run(runId);
  updateJob(runId, "completed", {});
});

test("progressive cleaning fills balloons, checkpoints successes and escalates only failed regions", async (t) => {
  const {cleanDirectorPage} = await import('../src/lib/server/directorCleaning');
  const {readAsset,assetPath} = await import('../src/lib/server/workflowStore');
  const editor = 'qwen-image-edit-2511-lightning';
  await fixturePasses(editor,['cleaning']);
  type Options = {batch?:number[];qwen?:number[];final?:number[];bubble?:boolean;crossed?:boolean;
    damageBubble?:boolean;contradictoryQwen?:boolean;failBatch?:boolean;locked?:boolean;cancelAfterFill?:boolean;noEditor?:boolean;finalDispute?:boolean;failPlan?:boolean;
    persistentFinalDispute?:boolean;finalRegionalSafe?:boolean;finalAffected?:number[];tightPolygon?:boolean;failFinalRegional?:boolean;finalProblem?:'remaining-text'|'artwork-damage';
    plainIndices?:number[];unknownIndices?:number[];typeIndices?:number[];visualPlain?:number[];primary?:string;legacyEditorBubble?:boolean;ghostQwen?:boolean};
  let n=0;
  async function fixture(opts:Options={}) {
    const page=await seedChapter(`progressive-clean-${++n}`,7);
    const ids=[page.lineId,`${page.lineId}-second`,`${page.lineId}-third`];
    const boxes=[{x:.1,y:.1,w:.2,h:.12},{x:.1,y:.4,w:.2,h:.12},{x:.6,y:.7,w:.2,h:.12}];
    for(let i=0;i<ids.length;i++) {
      const b=boxes[i];
      if(i) sqlite.prepare("INSERT INTO lines(id,episode_id,image_id,body,line_type,status,placed,x,y,w,h,sort_order,updated_at,updated_by,source,source_state) VALUES(?,?,?,'Hello','plain','none',1,?,?,?,?,?,1,'u','こんにちは','read')")
        .run(ids[i],page.episode.id,page.imageId,b.x,b.y,b.w,b.h,i);
      else sqlite.prepare('UPDATE lines SET x=?,y=?,w=?,h=? WHERE id=?').run(b.x,b.y,b.w,b.h,ids[i]);
      const doc=getDoc<any>(`region:${ids[i]}`,{});
      const p=opts.tightPolygon?{x:b.x+.02,y:b.y+.02,w:b.w-.04,h:b.h-.04}:b;
      putDoc(page.episode.id,doc.id,{...doc.data,locked:opts.locked && i===2,
        detectionKind:opts.plainIndices?.includes(i)?'bubble':opts.unknownIndices?.includes(i)?'unknown':'free',
        polygon:[{x:p.x,y:p.y},{x:p.x+p.w,y:p.y},{x:p.x+p.w,y:p.y+p.h},{x:p.x,y:p.y+p.h}]},doc.revision);
      if(opts.typeIndices?.includes(i)) sqlite.prepare('UPDATE lines SET line_type=? WHERE id=?').run(i===1?'\"\"':'()',ids[i]);
    }
    const raw=await storeAsset(await sharp(Buffer.from(`<svg width="400" height="500"><rect width="400" height="500" fill="white"/>${boxes.map(b=>`<rect x="${(b.x+.04)*400}" y="${(b.y+.03)*500}" width="28" height="20" fill="black"/>`).join('')}</svg>`)).png().toBuffer());
    const doc=getDoc<any>(`page:${page.imageId}`,{});
    const legacy=opts.legacyEditorBubble?await storeAsset(await sharp({create:{width:400,height:500,channels:3,background:'white'}}).png().toBuffer()):undefined;
    putDoc(page.episode.id,doc.id,{prepared:raw,preparedAt:1,cleanBase:raw,
      ...(legacy?{cleaned:legacy,directorCleaning:{raw,artwork:legacy,regions:{[ids[0]]:{geometry:'legacy',method:editor}}}}:{})},doc.revision);
    const policy=directorPolicy({cleanMethod:opts.primary||'lama-manga',cleanFallbackModel:opts.noEditor?'':editor,repairCycles:3});
    const runId=createJob(page.episode.id,'director',{});
    sqlite.prepare("INSERT INTO director_runs(id,episode_id,user_id,scope,model,proofreader,state,page_ids,created_at,updated_at,version,policy) VALUES(?,?,?,'page',?,?,'running',?,1,1,2,?)")
      .run(runId,page.episode.id,user.id,JSON.stringify(selected),JSON.stringify(selected),JSON.stringify([page.imageId]),JSON.stringify(policy));
    const controller=new AbortController();
    const operations:any[]=[];
    const selections=new Map<string,{targets:number[];full:boolean;expansion?:number}>();
    let candidateStage='';
    let candidateExpansion=0;
    let allowRecovery=false;
    let finalRejected=false;
    const pixel=async (artifact:string,index:number) => {
      const {data,info}=await sharp(await readAsset(artifact)).removeAlpha().raw().toBuffer({resolveWithObject:true});
      const b=boxes[index],x=Math.round((b.x+.06)*400),y=Math.round((b.y+.05)*500);
      return [...data.subarray((y*info.width+x)*info.channels,(y*info.width+x)*info.channels+3)];
    };
    const imageOperation=async(payload:any)=>{
      operations.push(payload);
      controller.signal.throwIfAborted();
      if(opts.cancelAfterFill && payload.cmd==='mask') {controller.abort();controller.signal.throwIfAborted();}
      if(payload.cmd==='mask') {
        const targets=boxes.map((b,i)=>payload.regions.some((poly:any[])=>Math.min(...poly.map(p=>p.x))<=b.x+b.w+.001&&Math.max(...poly.map(p=>p.x))>=b.x-.001&&Math.min(...poly.map(p=>p.y))<=b.y+b.h+.001&&Math.max(...poly.map(p=>p.y))>=b.y-.001)?i:-1).filter(i=>i>=0);
        const svg=`<svg width="400" height="500"><rect width="400" height="500" fill="black"/>${targets.map(i=>{const b=boxes[i];return `<rect x="${b.x*400}" y="${b.y*500}" width="${b.w*400}" height="${b.h*500}" fill="white"/>`}).join('')}</svg>`;
        const artifact=await storeAsset(await sharp(Buffer.from(svg)).png().toBuffer());
        selections.set(assetPath(artifact),{targets,full:!!payload.regionMask,expansion:payload.expansion??0});
        return {artifact,result:{}};
      }
      const base=await readFile(payload.path);
      const selection=payload.cmd==='bubble-fill'?{targets:[0],full:true}:selections.get(payload.mask)!;
      const request=sqlite.prepare("SELECT detail FROM director_events WHERE run_id=? AND kind='clean:request' ORDER BY id DESC LIMIT 1").get(runId) as any;
      candidateExpansion=selection.expansion??0;
      candidateStage=payload.cmd==='bubble-fill'?'bubble':payload.method===editor?'qwen':JSON.parse(request.detail).scope==='one-region'?'final':'batch';
      if(candidateStage==='batch' && opts.failBatch) throw new Error('LaMa worker failed');
      const successful=candidateStage==='bubble'?[0]:candidateStage==='batch'?(opts.batch??[1]):candidateStage==='qwen'?(allowRecovery?[2]:(opts.qwen??[2])):(opts.final??[]);
      // Deliberately alter the entire image: production must constrain model output to the selection.
      const svg=`<svg width="400" height="500"><rect width="400" height="500" fill="red"/>${selection.targets.filter(i=>successful.includes(i)).map(i=>{const b=boxes[i];return `<rect x="${b.x*400}" y="${b.y*500}" width="${b.w*400}" height="${b.h*500}" fill="white"/>`}).join('')}</svg>`;
      const generated=await storeAsset(await sharp(Buffer.from(svg)).png().toBuffer());
      // The real fill tool is local; emulate that locality for the human-click operation.
      let artifact=generated;
      if(payload.cmd==='bubble-fill') {
        const b=boxes[0];
        artifact=await storeAsset(await sharp(base).composite([{input:await sharp({create:{width:80,height:60,channels:3,background:opts.damageBubble?'red':'white'}}).png().toBuffer(),left:40,top:50}]).png().toBuffer());
        return {artifact,result:{changedBounds:b}};
      }
      return {artifact,result:{}};
    };
    const call=(async(purpose:string,_system:string,data:any,images?:Buffer[],schema?:any)=>{
      if(purpose==='plan-balloon-fills' && schema) {
        assert.equal(schema.properties.decisions.items.properties.px,undefined,'The model must not supply fill coordinates');
        assert.equal(schema.properties.decisions.items.properties.py,undefined);
      }
      if(purpose==='plan-balloon-fills' && opts.failPlan) throw new Error('Balloon assessment unavailable');
      if(purpose==='plan-balloon-fills') return {decisions:data.regions.map((r:any)=>({lineId:r.id,eligible:opts.bubble!==false && r.id===ids[0],plainBubble:!!opts.visualPlain?.includes(ids.indexOf(r.id)),borderIntact:true,borderCrossed:!!opts.crossed,interiorArtwork:false,reason:'Visual balloon assessment'}))};
      if(purpose==='verify-lettering')return {hasLettering:true,reason:'Lettering is visible in the target area.'};
      assert.equal(purpose,'inspect-cleaning');
      if(data.scope==='whole-page') {
        assert.deepEqual(data.imageOrder,['current cleaned artwork']);
        assert.ok(data.regions.every((r:any)=>r.source===undefined&&r.english===undefined),'Saved source must not prime the final visual verdict');
        if(images) {
          assert.equal(images.length,1,'The final check must not confuse raw lettering with the cleaned page');
          const saved=getDoc<any>(`page:${page.imageId}`,{}).data;
          assert.deepEqual(images[0],await readAsset(saved.cleaned||saved.cleanBase));
        }
      }
      if(data.method==='final-verification') {
        const reject=!!opts.finalDispute && (!finalRejected || !!opts.persistentFinalDispute);
        finalRejected=true;
        return {safe:!reject,problem:reject?(opts.finalProblem||'artwork-damage'):'none',reason:reject?'Third region needs cleaning review':'All source text removed',
          affectedLineIds:reject?opts.finalAffected?.map(i=>ids[i]):[]};
      }
      if(data.method==='final-regional-verification') {
        if(opts.failFinalRegional) throw new Error('Regional verification unavailable');
        return {safe:!!opts.finalRegionalSafe||data.regions[0].id!==ids[2],problem:!opts.finalRegionalSafe&&data.regions[0].id===ids[2]?'artwork-damage':'none',reason:'Final localized assessment'};
      }
      if(data.mode==='existing') {
        const preserved=(opts.legacyEditorBubble&&data.scope==='region'&&data.regions[0].id!==ids[0]) || (data.method==='existing-artwork-detail' && (await pixel(getDoc<any>(`page:${page.imageId}`,{}).data.cleaned,ids.indexOf(data.regions[0].id))).every(v=>v===255));
        return {safe:!!preserved,problem:preserved?'none':'remaining-text',reason:preserved?'Existing clean retained':'Original lettering remains'};
      }
      const i=ids.indexOf(data.regions[0].id);
      const success=candidateStage==='bubble'?!opts.damageBubble:candidateStage==='batch'?(opts.batch??[1]).includes(i):candidateStage==='qwen'?(allowRecovery?[2]:(opts.qwen??[2])).includes(i):(opts.final??[]).includes(i);
      // Ghosts: the editor leaves a fringe until the mask is grown past the first editor mask.
      if(opts.ghostQwen && candidateStage==='qwen') return {safe:candidateExpansion>11,problem:candidateExpansion>11?'none':'remaining-text',reason:candidateExpansion>11?'Only source lettering removed':'Grey ghosts of the lettering remain'};
      return {safe:success || (candidateStage==='qwen' && opts.contradictoryQwen),problem:success?'none':candidateStage==='bubble'?'artwork-damage':'remaining-text',reason:success?'Only source lettering removed':'Candidate still contains source text or damages intact art'};
    }) as any;
    const ctx:any={run:{id:runId,episode_id:page.episode.id,user_id:user.id,model:JSON.stringify(selected),proofreader:JSON.stringify(selected),policy:JSON.stringify(policy)},series:page.series,episode:page.episode,user,signal:controller.signal,authorize:async()=>{},imageOperation};
    const execute=()=>withDirector({runId,episodeId:page.episode.id,imageId:page.imageId},()=>cleanDirectorPage(ctx,page.imageId,call,0));
    const runFull=async()=>{
      const {runAutomationPage}=await import('../src/lib/server/directorAutomation');
      const normal=respond;let proofreaderCalls=0;
      respond=(purpose,data)=>['inspect-cleaning','plan-balloon-fills'].includes(purpose)?call(purpose,'',data):normal(purpose,data);
      ctx.transcribe=async()=>{};ctx.translationBrief=async()=>"Original source: こんにちは. English: Hello. SFX.";ctx.proofread=async()=>{proofreaderCalls++;return 'No defects';};
      try {
        const result=await withDirector({runId,episodeId:page.episode.id,imageId:page.imageId},()=>runAutomationPage(ctx,page.imageId));
        return {result,proofreaderCalls};
      } finally {respond=normal;}
    };
    return {page,ids,raw,runId,operations,pixel,execute,runFull,recover(){allowRecovery=true},saved:()=>getDoc<any>(`page:${page.imageId}`,{}).data};
  }
  await t.test('human order: fill, batch LaMa, one Qwen on grown lettering; never edit saved balloons again',async()=>{
    const f=await fixture();await f.execute();
    const click=f.operations.find(p=>p.cmd==='bubble-fill');
    assert.equal(click.px,.2,'Use the app-computed normalized region centre');
    assert.equal(click.py,.16,'Never ask the model for page-pixel coordinates');
    assert.deepEqual(f.operations.filter(p=>p.cmd!=='mask').map(p=>p.cmd==='bubble-fill'?'bubble':p.method),['bubble','lama-manga',editor]);
    const batch=f.operations.find(p=>p.cmd==='mask'&&p.detect);
    assert.equal(batch.regions.length,2);
    const qwen=f.operations.find(p=>p.method===editor);
    assert.equal(qwen.task,'cleaning');assert.match(qwen.prompt,/lettering plus a small margin/);
    assert.equal(f.saved().pendingCleanRegions,undefined);
    for(let i=0;i<3;i++) assert.deepEqual(await f.pixel(f.saved().cleaned,i),[255,255,255]);
    const rawPixel=await f.pixel(f.raw,2);assert.deepEqual(rawPixel,[0,0,0]);
    const {data}=await sharp(await readAsset(f.saved().cleaned)).removeAlpha().raw().toBuffer({resolveWithObject:true});
    assert.deepEqual([...data.subarray(0,3)],[255,255,255],'pixels outside selections survive red model output');
    const checkpoint=f.saved().directorCleaning;
    assert.equal(checkpoint.regions[f.ids[0]].method,'bubble-fill');
    assert.equal(checkpoint.regions[f.ids[1]].method,'lama-manga');
    assert.equal(checkpoint.regions[f.ids[2]].method,editor);
    sqlite.prepare("UPDATE director_runs SET state='completed' WHERE id=?").run(f.runId);
    updateJob(f.runId,"completed",{});
    undoDirector({episodeId:f.page.episode.id,runId:f.runId});
    assert.equal(f.saved().cleaned,undefined,'regional saves are undoable');
  });
  await t.test('failed Qwen is discarded before single-region LaMa',async()=>{
    const f=await fixture({qwen:[],final:[2]});await f.execute();
    const attempts=f.operations.filter(p=>p.cmd==='clean');
    // A residue failure earns one wider editor retry before LaMa.
    assert.deepEqual(attempts.map(p=>p.method),['lama-manga',editor,editor,'lama-manga']);
    assert.equal(attempts[1].path,attempts[3].path,'every retry starts from the last verified artwork');
    assert.equal(f.saved().directorCleaning.regions[f.ids[2]].method,'lama-manga');
  });
  await t.test('lettering ghosts get one wider retry of the same method before falling back',async()=>{
    const f=await fixture({ghostQwen:true});await f.execute();
    const attempts=f.operations.filter(p=>p.cmd==='clean');
    assert.deepEqual(attempts.map(p=>p.method),['lama-manga',editor,editor]);
    const masks=f.operations.filter(p=>p.cmd==='mask'&&p.detect&&p.regions.length===1).map(p=>p.expansion);
    assert.ok(masks.includes(11)&&masks.includes(19),`editor masks ${masks}`);
    assert.equal(f.saved().directorCleaning.regions[f.ids[2]].method,editor);
  });
  await t.test('partial failure retains successful pixels and retries only unresolved regions',async()=>{
    const f=await fixture({qwen:[]});await assert.rejects(f.execute(),/Verified regions were saved/);
    assert.deepEqual(f.saved().pendingCleanRegions,[f.ids[2]]);
    assert.deepEqual(await f.pixel(f.saved().cleaned,0),[255,255,255]);
    assert.deepEqual(await f.pixel(f.saved().cleaned,1),[255,255,255]);
    assert.deepEqual(await f.pixel(f.saved().cleaned,2),[0,0,0]);
    const start=f.operations.length;f.recover();await f.execute();
    assert.ok(f.operations.slice(start).filter(p=>p.cmd==='mask').every(p=>p.regions.length===1));
    assert.equal(f.operations.slice(start).filter(p=>p.cmd==='bubble-fill').length,0);
    assert.equal(f.saved().pendingCleanRegions,undefined);
  });
  await t.test('crossed border rejects balloon fill even when marked eligible',async()=>{
    const f=await fixture({crossed:true,batch:[0,1]});await f.execute();
    assert.equal(f.operations.filter(p=>p.cmd==='bubble-fill').length,0);
  });
  await t.test('damaging balloon fill is not saved and is retried with LaMa',async()=>{
    const f=await fixture({damageBubble:true,batch:[0,1]});await f.execute();
    assert.equal(f.saved().directorCleaning.regions[f.ids[0]].method,'lama-manga');
  });
  await t.test('an unavailable balloon assessment falls through to detected-text cleaning',async()=>{
    const f=await fixture({failPlan:true,batch:[0,1]});await f.execute();
    assert.equal(f.operations.filter(p=>p.cmd==='bubble-fill').length,0);
    assert.equal(f.saved().pendingCleanRegions,undefined);
  });
  await t.test('all batch regions pass without requesting Qwen',async()=>{
    const f=await fixture({bubble:false,batch:[0,1,2]});await f.execute();
    assert.equal(f.operations.filter(p=>p.method===editor).length,0);
  });
  await t.test('a primary model error still escalates each uncleaned region',async()=>{
    const f=await fixture({failBatch:true,qwen:[1,2]});await f.execute();
    assert.equal(f.operations.filter(p=>p.method===editor).length,2);
  });
  await t.test('contradictory safe verdict cannot approve remaining source text',async()=>{
    const f=await fixture({qwen:[],contradictoryQwen:true,final:[2]});await f.execute();
    assert.equal(f.saved().directorCleaning.regions[f.ids[2]].method,'lama-manga');
  });
  await t.test('locked raw region stays untouched while other regions are saved',async()=>{
    const f=await fixture({locked:true});await assert.rejects(f.execute(),/still needs attention/);
    assert.deepEqual(await f.pixel(f.saved().cleaned,2),[0,0,0]);
    assert.equal(f.saved().directorCleaning.regions[f.ids[0]].method,'bubble-fill');
    assert.equal(f.saved().directorCleaning.regions[f.ids[1]].method,'lama-manga');
    assert.equal(f.operations.filter(p=>p.method===editor).length,0);
  });
  await t.test('cancellation retains saved fill and does not invoke fallback',async()=>{
    const f=await fixture({cancelAfterFill:true});await assert.rejects(f.execute(),/abort/i);
    assert.equal(f.saved().directorCleaning.regions[f.ids[0]].method,'bubble-fill');
    assert.equal(f.operations.filter(p=>p.method===editor).length,0);
  });
  await t.test('unfinished regional cleaning saves progress and stops before rendered proofreading',async()=>{
    const f=await fixture({qwen:[]});
    const {result,proofreaderCalls}=await f.runFull();
    assert.ok(result.findings.some(f=>f.stage==='clean'));
    assert.equal(proofreaderCalls,0);
    assert.deepEqual(f.saved().pendingCleanRegions,[f.ids[2]]);
  });
  await t.test('final page failure restores the disputed region then sends its whole mask to the editor',async()=>{
    const f=await fixture({finalDispute:true});
    await f.execute();
    assert.equal(f.saved().pendingCleanRegions,undefined);
    assert.equal(f.operations.filter(p=>p.method===editor).length,2,'Initial hard-region repair and final-page repair both use Qwen');
    assert.deepEqual(await f.pixel(f.saved().cleaned,2),[255,255,255]);
    assert.equal(f.saved().directorCleaning.regions[f.ids[0]].method,'bubble-fill');
    assert.equal(f.saved().directorCleaning.regions[f.ids[1]].method,'lama-manga');
    assert.equal(f.saved().directorCleaning.regions[f.ids[2]].method,editor);
  });
  await t.test('a whole-page failure with all regional rechecks passing still invokes the editor',async()=>{
    const f=await fixture({bubble:false,batch:[0,1,2],qwen:[0,1,2],finalDispute:true,finalRegionalSafe:true});
    await f.execute();
    assert.equal(f.operations.filter(p=>p.method===editor).length,3,'Unlocalized final failure retries every editable region once');
    assert.equal(f.saved().pendingCleanRegions,undefined);
  });
  await t.test('whole-page affected IDs override passing local rechecks and preserve other checkpoints',async()=>{
    const f=await fixture({bubble:false,batch:[0,1,2],qwen:[0,2],finalDispute:true,finalRegionalSafe:true,finalAffected:[0,2]});
    await f.execute();
    assert.equal(f.operations.filter(p=>p.method===editor).length,2);
    assert.equal(f.saved().directorCleaning.regions[f.ids[1]].method,'lama-manga');
    assert.equal(f.saved().directorCleaning.regions[f.ids[0]].method,editor);
    assert.equal(f.saved().directorCleaning.regions[f.ids[2]].method,editor);
  });
  await t.test('failed regional localization still escalates the final-page cleaning failure',async()=>{
    const f=await fixture({bubble:false,batch:[0,1,2],qwen:[0,1,2],finalDispute:true,failFinalRegional:true});
    await f.execute();
    assert.equal(f.operations.filter(p=>p.method===editor).length,3);
    assert.equal(f.saved().pendingCleanRegions,undefined);
  });
  await t.test('the editor gets the detected lettering grown a little, never the whole region',async()=>{
    const f=await fixture({bubble:false,batch:[0,1],qwen:[2],tightPolygon:true});
    await f.execute();
    const qwen=f.operations.find(p=>p.method===editor);
    const grown=f.operations.find(p=>p.cmd==='mask'&&p.detect&&p.expansion===11);
    assert.ok(qwen&&grown);
    assert.equal(grown.regionMask,false);
    assert.equal(f.operations.some(p=>p.cmd==='mask'&&p.regionMask&&p.regions.some((poly:any[])=>poly[0].x<.6&&poly[2].x>.8)&&f.operations.indexOf(p)===f.operations.indexOf(qwen)-1),false,
      'A whole-region mask lets the editor repaint the artwork, such as a sign, away with its lettering');
  });
  await t.test('a persistent final failure stops after one recovery pass and restores the disputed region',async()=>{
    const f=await fixture({finalDispute:true,persistentFinalDispute:true});
    await assert.rejects(f.execute(),/Final cleaning verification/);
    assert.deepEqual(f.saved().pendingCleanRegions,[f.ids[2]]);
    assert.deepEqual(await f.pixel(f.saved().cleaned,2),[0,0,0]);
    assert.deepEqual(await f.pixel(f.saved().cleaned,0),[255,255,255]);
    assert.deepEqual(await f.pixel(f.saved().cleaned,1),[255,255,255]);
    assert.equal(f.saved().directorCleaning.regions[f.ids[2]],undefined);
    assert.equal(f.operations.filter(p=>p.method===editor).length,2,'No unbounded final-check retry loop');
  });
  await t.test('a persistent remaining-text verdict retains all saved cleans while flagging verification',async()=>{
    const f=await fixture({bubble:false,batch:[0,1,2],qwen:[0,1,2],finalDispute:true,persistentFinalDispute:true,
      finalRegionalSafe:true,finalAffected:[0,1,2],finalProblem:'remaining-text'});
    await assert.rejects(f.execute(),/Final cleaning verification/);
    for(let i=0;i<3;i++) assert.deepEqual(await f.pixel(f.saved().cleaned,i),[255,255,255],'Final text uncertainty must never paste raw lettering over a saved clean');
    assert.deepEqual(f.saved().pendingCleanRegions,f.ids);
    assert.notEqual(f.saved().cleaned,f.raw);
    const events=sqlite.prepare("SELECT detail FROM director_events WHERE run_id=? AND kind='clean:retry'").all(f.runId) as any[];
    assert.ok(events.some(e=>JSON.parse(e.detail).method==='verification-review'));
    assert.equal(events.some(e=>JSON.parse(e.detail).method==='raw-recovery'),false);
  });
  await t.test('without an editor, try single-region LaMa after batch failure',async()=>{
    const f=await fixture({noEditor:true,final:[2]});await f.execute();
    assert.equal(f.operations.filter(p=>p.method===editor).length,0);
    assert.equal(f.operations.filter(p=>p.cmd==='clean').length,2);
  });
  await t.test('plain bubbles never reach the editor when fill planning and primary cleaning fail',async()=>{
    const f=await fixture({plainIndices:[0,1,2],failPlan:true,failBatch:true,final:[0,1,2],qwen:[0,1,2]});
    await f.execute();
    const cleans=f.operations.filter(p=>p.cmd==='clean');
    assert.equal(cleans.length,4);
    assert.ok(cleans.every(p=>p.method==='lama-manga'));
    assert.equal(f.operations.filter(p=>p.cmd==='mask'&&p.regionMask).length,0,'Bubble retries mask only detected lettering');
    for(const id of f.ids) assert.equal(f.saved().directorCleaning.regions[id].method,'lama-manga');
  });
  await t.test('a selected primary image editor is overridden for bubbles but retained for free lettering',async()=>{
    const f=await fixture({plainIndices:[0,1],primary:editor,bubble:false,batch:[0,1],qwen:[2]});
    await f.execute();
    assert.deepEqual(f.operations.filter(p=>p.cmd==='clean').map(p=>p.method),['lama-manga',editor]);
    assert.equal(f.saved().directorCleaning.regions[f.ids[0]].method,'lama-manga');
    assert.equal(f.saved().directorCleaning.regions[f.ids[1]].method,'lama-manga');
    assert.equal(f.saved().directorCleaning.regions[f.ids[2]].method,editor);
  });
  await t.test('an artwork editor mask protects neighbouring bubbles even before they are cleaned',async()=>{
    const f=await fixture({plainIndices:[1,2],primary:editor,bubble:false,batch:[1,2],qwen:[0]});
    await f.execute();
    const edits=f.operations.filter(p=>p.cmd==='clean');
    assert.deepEqual(edits.map(p=>p.method),[editor,'lama-manga']);
    const firstMask=f.operations.find(p=>p.cmd==='mask');
    assert.equal(firstMask.excludeRegions.length,2,'Uncleaned bubbles must also be protected from artwork editor masks');
    assert.equal(f.saved().directorCleaning.regions[f.ids[1]].method,'lama-manga');
    assert.equal(f.saved().directorCleaning.regions[f.ids[2]].method,'lama-manga');
  });
  await t.test('dialogue and thought labels protect bubbles even when the detector calls them free text',async()=>{
    const f=await fixture({typeIndices:[1,2],bubble:false,batch:[0],final:[1,2],qwen:[1,2]});
    await f.execute();
    assert.ok(f.operations.filter(p=>p.cmd==='clean').every(p=>p.method==='lama-manga'));
  });
  await t.test('confirmed outside lettering cannot be flood-filled or trapped by an old bubble classification',async()=>{
    const f=await fixture({typeIndices:[0],batch:[1,2],qwen:[0]});
    const line=(await listLines(f.page.episode.id)).find(l=>l.id===f.ids[0])!;
    const region=getDoc<any>(`region:${line.id}`,{});
    putDoc(f.page.episode.id,region.id,{...region.data,directorPresentation:{raw:f.raw,box:JSON.stringify([line.x,line.y,line.w,line.h]),source:line.source,
      enclosure:'none',handwritten:true,role:'speech',reason:'Aside outside any balloon.'}},region.revision);
    await f.execute();
    assert.equal(f.operations.filter(p=>p.cmd==='bubble-fill').length,0,'The fill planner must never receive a confirmed outside target');
    assert.equal(f.saved().directorCleaning.regions[line.id].method,editor,'Outside lettering may use the artwork fallback');
    assert.equal(f.saved().directorCleaning.regions[line.id].bubbleToolsOnly,false);
    assert.equal(f.saved().directorCleaning.regions[f.ids[1]].method,'lama-manga');
  });
  await t.test('unknown region geometry stays on LaMa if balloon planning is unavailable',async()=>{
    const f=await fixture({unknownIndices:[0,1,2],failPlan:true,batch:[],final:[0,1,2],qwen:[0,1,2]});
    await f.execute();
    assert.equal(f.operations.filter(p=>p.method===editor).length,0);
  });
  await t.test('a visually identified plain bubble is protected even when flood fill is ineligible',async()=>{
    const f=await fixture({visualPlain:[0],primary:editor,bubble:false,batch:[0],qwen:[1,2]});
    await f.execute();
    assert.equal(f.saved().directorCleaning.regions[f.ids[0]].method,'lama-manga');
    assert.equal(f.saved().directorCleaning.regions[f.ids[0]].bubbleToolsOnly,true,'Remember visual bubble protection across resumed runs');
  });
  await t.test('a final-page rejection cannot escalate plain bubbles to an image editor',async()=>{
    const f=await fixture({plainIndices:[0,1,2],bubble:false,batch:[0,1,2],final:[0,1,2],qwen:[0,1,2],
      finalDispute:true,finalAffected:[0,1,2],finalRegionalSafe:true});
    await f.execute();
    assert.equal(f.operations.filter(p=>p.method===editor).length,0);
    for(const id of f.ids) assert.equal(f.saved().directorCleaning.regions[id].method,'lama-manga');
  });
  await t.test('a failed plain bubble remains pending instead of using the selected image editor',async()=>{
    const f=await fixture({plainIndices:[0,1,2],bubble:false,batch:[0,1],final:[],qwen:[2]});
    await assert.rejects(f.execute(),/still needs attention/);
    assert.equal(f.operations.filter(p=>p.method===editor).length,0);
    assert.deepEqual(f.saved().pendingCleanRegions,[f.ids[2]]);
  });
  await t.test('legacy editor-cleaned bubbles restore their original borders before bubble-tool cleaning',async()=>{
    const f=await fixture({plainIndices:[0],legacyEditorBubble:true,batch:[1,2]});
    await f.execute();
    assert.equal(f.saved().directorCleaning.regions[f.ids[0]].method,'bubble-fill');
    assert.equal(f.operations.filter(p=>p.method===editor).length,0);
    assert.ok((sqlite.prepare("SELECT detail FROM director_events WHERE run_id=? AND kind='clean:retry'").all(f.runId) as any[])
      .some(e=>JSON.parse(e.detail).method==='bubble-recovery'));
  });
});


test("artwork boxed as text is excluded only when a neutral lettering check agrees, and undo restores it",async()=>{
  const {excludeIfNotLettering}=await import('../src/lib/server/directorLettering');
  const page=await seedChapter('shoelace-artwork',32);
  sqlite.prepare('UPDATE lines SET x=?,y=?,w=?,h=?,source=?,body=? WHERE id=?').run(.3,.3,.2,.1,'조사','Investigation',page.lineId);
  const raw=await sharp({create:{width:400,height:300,channels:3,background:'#8a5a3c'}}).png().toBuffer();
  const runId=createJob(page.episode.id,'director',{});
  sqlite.prepare("INSERT INTO director_runs(id,episode_id,user_id,scope,model,proofreader,state,page_ids,created_at,updated_at,version,policy) VALUES(?,?,?,'page',?,?,'running',?,1,1,10,?)")
    .run(runId,page.episode.id,user.id,JSON.stringify(selected),JSON.stringify(selected),JSON.stringify([page.imageId]),JSON.stringify(directorPolicy({})));
  const ctx:any={run:{id:runId},series:page.series,episode:page.episode,user,signal:new AbortController().signal,authorize:async()=>{}};
  const doubt={stage:'Cleaning verification',reason:'Cleaning erased the white shoelaces.'};
  const line=()=>sqlite.prepare('SELECT * FROM lines WHERE id=?').get(page.lineId) as any;
  const asked:string[]=[];
  const answer=(hasLettering:boolean)=>(async(purpose:string,system:string)=>{
    asked.push(purpose);assert.match(system,/Do not assume the target contains text/);
    return {hasLettering,reason:hasLettering?'Hangul strokes are visible.':'Only white shoelaces crossing a brown shoe.'};
  }) as any;
  const toLine=(row:any)=>({...row,imageId:row.image_id,sourceState:row.source_state});
  // Real lettering survives a mistaken doubt.
  assert.equal(await withDirector({runId,episodeId:page.episode.id,imageId:page.imageId},()=>excludeIfNotLettering(ctx,page.imageId,answer(true),raw,toLine(line()),doubt)),false);
  assert.equal(line().source_state,'read');
  // Artwork both checks agree on is a reversible machine exclusion that keeps its text.
  assert.equal(await withDirector({runId,episodeId:page.episode.id,imageId:page.imageId},()=>excludeIfNotLettering(ctx,page.imageId,answer(false),raw,toLine(line()),doubt)),true);
  assert.deepEqual(asked,['verify-lettering','verify-lettering']);
  assert.equal(line().source_state,'ignored');assert.equal(line().source,'조사');assert.match(line().ignore_reason,/shoelaces/);
  const review=getDoc<any>(`region:${page.lineId}`,{}).data.directorDetectionReview;
  assert.equal(review.verdict,'non-text');assert.equal(review.lineRevision,line().revision);
  assert.ok(sqlite.prepare("SELECT 1 FROM director_events WHERE run_id=? AND kind='region:non-text'").get(runId));
  sqlite.prepare("UPDATE director_runs SET state='completed' WHERE id=?").run(runId);
  undoDirector({episodeId:page.episode.id,runId});
  assert.equal(line().source_state,'read');
});

test("outside-lettering close-ups revoke cached halos and invented lines before a passing page verdict",async(t)=>{
  const {cleanDirectorPage}=await import('../src/lib/server/directorCleaning');
  const {readAsset}=await import('../src/lib/server/workflowStore');
  const {digest}=await import('../src/lib/server/directorMemory');
  const editor='qwen-image-edit-2511-lightning';await fixturePasses(editor,['cleaning']);
  for(const mode of ['repair','unstamped','border','reject','preservation','locked'])await t.test(mode,async()=>{
    const page=await seedChapter(`outside-artifact-${mode}`,31);
    const box=[.3,.3,.3,.2], [x,y,w,h]=box;
    sqlite.prepare('UPDATE lines SET x=?,y=?,w=?,h=?,line_type=? WHERE id=?').run(x,y,w,h,'//',page.lineId);
    const polygon=[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];
    const region=getDoc<any>(`region:${page.lineId}`,{});
    putDoc(page.episode.id,region.id,{...region.data,detectionKind:'free',polygon,locked:mode==='locked'},region.revision);
    const svg=(content:string)=>Buffer.from(`<svg width="400" height="300"><rect width="400" height="300" fill="#aaccdd"/><path d="M230 185 L240 210 M${mode==='border'?245:350} 0 V300" stroke="black" stroke-width="3"/>${content}</svg>`);
    const raw=await storeAsset(await sharp(svg('<rect x="116" y="86" width="128" height="68" rx="8" fill="white"/><text x="125" y="132" font-size="36">HEY</text>')).png().toBuffer());
    putDoc(page.episode.id,region.id,{...getDoc<any>(region.id,{}).data,directorPresentation:{enclosure:'none',handwritten:true,role:'speech',reason:'Open sky lettering',raw,box:JSON.stringify(box),source:'こんにちは'}},getDoc<any>(region.id,{}).revision);
    const partial=await storeAsset(await sharp(svg((mode==='border'?'<rect x="243" y="90" width="5" height="60" fill="#aaccdd"/>':'')+'<rect x="116" y="86" width="128" height="68" rx="8" fill="#e6f2f6"/><path d="M130 135 L235 95" stroke="black" stroke-width="3"/>')).png().toBuffer());
    const clean=await storeAsset(await sharp(svg('')).png().toBuffer());
    const doc=getDoc<any>(`page:${page.imageId}`,{});
    putDoc(page.episode.id,doc.id,{prepared:raw,cleaned:partial,directorCleaning:mode==='unstamped'?undefined:{raw,artwork:partial,regions:{[page.lineId]:{geometry:digest({box,polygon}),method:'lama-manga',bubbleToolsOnly:true}}}},doc.revision);
    const policy=directorPolicy({cleanMethod:'lama-manga',cleanFallbackModel:editor});
    const runId=createJob(page.episode.id,'director',{});
    sqlite.prepare("INSERT INTO director_runs(id,episode_id,user_id,scope,model,proofreader,state,page_ids,created_at,updated_at,version,policy) VALUES(?,?,?,'page',?,?,'running',?,1,1,10,?)")
      .run(runId,page.episode.id,user.id,JSON.stringify(selected),JSON.stringify(selected),JSON.stringify([page.imageId]),JSON.stringify(policy));
    const operations:any[]=[],reviews:any[]=[];
    const call=(async(purpose:string,system:string,data:any,images:Buffer[],schema:any)=>{
      if(purpose==='verify-lettering')return {hasLettering:true,reason:'Lettering is visible in the target area.'};
      assert.equal(purpose,'inspect-cleaning');reviews.push(data);
      if(data.scope==='whole-page')return {safe:true,problem:'none',reason:'Tall-page preview appears clear'};
      assert.equal(data.regions[0].source,undefined);assert.equal(data.repairFinding,undefined);assert.equal(data.findings,undefined);
      if(data.check==='residue'){assert.equal(images.length,2);assert.match(system,/No raw source/);assert.ok(!schema.properties.artworkDefects.items.enum.includes('invented-stroke'));}
      else {assert.equal(data.check,'artwork-preservation');assert.equal(images.length,3);assert.match(system,/NEW dark streaks/);assert.ok((await sharp(images[2]).metadata()).width!>700);assert.deepEqual(schema.properties.problem.enum,['none','artwork-damage']);assert.ok(!schema.properties.artworkDefects.items.enum.includes('remaining-lettering'));}
      const bad=data.check==='artwork-preservation'?mode==='preservation':mode==='preservation'?false:data.method==='existing-artwork-detail'||mode==='reject';
      return {safe:true,problem:'none',artworkDefects:bad?[data.check==='residue'?'lettering-outline':'invented-stroke']:[],reason:bad?'Pale lettering halo or new diagonal black streak':'Background continuous; original short speaker leader preserved'};
    })as any;
    const imageOperation=async(payload:any)=>{
      operations.push(payload);
      if(payload.cmd==='mask'){
        // Restoring from raw covers the whole region; the editor repair masks only grown lettering.
        if(!payload.regionMask)assert.equal(payload.detect,true);
        const p=payload.regions[0];
        const artifact=await storeAsset(await sharp(Buffer.from(`<svg width="400" height="300"><rect width="400" height="300" fill="black"/><polygon points="${p.map((q:any)=>`${q.x*400},${q.y*300}`).join(' ')}" fill="white"${payload.detect?` stroke="white" stroke-width="${2*payload.expansion}" stroke-linejoin="round" shape-rendering="crispEdges"`:''}/></svg>`)).png().toBuffer());
        return {artifact,result:{}};
      }
      assert.equal(payload.cmd,'clean');
      assert.deepEqual(await readFile(payload.path),await readAsset(raw),'Repair starts from original lettering rather than its invented streak');
      if(payload.task)assert.match(payload.prompt,/white outlines, shadows and halos/);
      return {artifact:['reject','preservation'].includes(mode)?partial:clean,result:{}};
    };
    const ctx:any={run:{id:runId,episode_id:page.episode.id,policy:JSON.stringify(policy)},series:page.series,episode:page.episode,user,signal:new AbortController().signal,authorize:async()=>{},imageOperation};
    const execute=()=>withDirector({runId,episodeId:page.episode.id,imageId:page.imageId},()=>cleanDirectorPage(ctx,page.imageId,call,0));
    if(['repair','unstamped','border'].includes(mode))await execute();else await assert.rejects(execute(),/still needs attention/);
    const saved=getDoc<any>(`page:${page.imageId}`,{}).data;
    assert.equal(reviews[0].method,mode==='border'?editor:'existing-artwork-detail','Full-page green cannot skip pixel and close-up verification');
    if(mode==='border')assert.ok(sqlite.prepare("SELECT 1 FROM director_events WHERE run_id=? AND kind='clean:damage'").get(runId),'Erased borders veto a passing visual verdict');
    if(['repair','unstamped','border'].includes(mode)){
      assert.equal(saved.pendingCleanRegions,undefined);assert.equal(saved.directorCleaning.regions[page.lineId].method,editor);
      const actual=await sharp(await readAsset(saved.cleaned)).removeAlpha().raw().toBuffer(),expected=await sharp(await readAsset(clean)).removeAlpha().raw().toBuffer();
      assert.ok(actual.reduce((n,v,i)=>Math.max(n,Math.abs(v-expected[i])),0)<=1,'Halo margins cleaned while original leader and panel survive; permit one level of alpha rounding');
    }else{
      assert.equal(saved.cleaned,partial,'Rejected output never overwrites saved pixels');assert.deepEqual(saved.pendingCleanRegions,[page.lineId]);assert.equal(saved.directorCleaning.regions[page.lineId],undefined);
      if(mode==='locked')assert.equal(operations.length,0);
    }
  });
});

test("pixel residue revokes an old clean checkpoint and rechecks connected lobes despite a passing visual verdict",async(t)=>{
  const {cleanDirectorPage}=await import('../src/lib/server/directorCleaning');
  const {cleaningResidueInspector}=await import('../src/lib/server/directorCleaningResidue');
  const {runWorkflowPng}=await import('../src/lib/server/workflowImages');
  const {readAsset}=await import('../src/lib/server/workflowStore');
  const {digest}=await import('../src/lib/server/directorMemory');
  const svg=(content:string)=>Buffer.from(`<svg width="500" height="360"><rect width="500" height="360" fill="#8099aa"/><path d="M220 115 C170 55 60 90 60 170 C60 250 180 285 230 225 C300 285 400 250 400 170 C400 90 290 65 220 115Z" fill="white" stroke="black" stroke-width="4"/>${content}</svg>`);
  for(const mode of ['repair','refused','pending','reject','locked','artwork','crossed'])await t.test(`${mode}: ${mode==='locked'?'a locked remnant becomes pending without editing either lobe':mode==='reject'?'a bad candidate stays rejected even if the visual model says safe':mode==='refused'?'measured geometry permits a strict fill when the model falsely rejects a connected neck':mode==='artwork'||mode==='crossed'?'explicit artwork and border-crossing warnings veto a measured fill':'both overlapping lobes are reverified and saved together'}`,async()=>{
    const fail=!['repair','refused','pending'].includes(mode),locked=mode==='locked';
    const page=await seedChapter(`residue-repair-${mode}`,31);
    const ids=[page.lineId,`${page.lineId}-right`],boxes=[[.17,.36,.22,.16],[.53,.36,.22,.16]];
    const raw=await storeAsset(await sharp(svg('<text x="90" y="180" font-size="28">HELLO</text><text x="270" y="180" font-size="28">OH</text>')).png().toBuffer());
    const partial=await storeAsset(await sharp(svg('<path d="M284 154 Q307 153 306 172 M279 178 Q300 193 320 180" fill="none" stroke="#333" stroke-width="2"/>')).png().toBuffer());
    const checkpoints:any={};
    for(let i=0;i<2;i++){
      const [x,y,w,h]=boxes[i];
      if(i)sqlite.prepare("INSERT INTO lines(id,episode_id,image_id,body,line_type,status,placed,x,y,w,h,sort_order,updated_at,updated_by,source,source_state) VALUES(?,?,?,'Hey','plain','needs_work',1,?,?,?,?,1,1,'u','OH','read')").run(ids[i],page.episode.id,page.imageId,x,y,w,h);
      else sqlite.prepare('UPDATE lines SET x=?,y=?,w=?,h=? WHERE id=?').run(x,y,w,h,ids[i]);
      // The saved left polygon overlaps the right lettering: separate repairs
      // would permanently preserve part of the fragment.
      const polygon=i?[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}]:[{x,y},{x:.68,y},{x:.68,y:y+h},{x,y:y+h}];
      const doc=getDoc<any>(`region:${ids[i]}`,{});
      putDoc(page.episode.id,doc.id,{...doc.data,detectionKind:'bubble',polygon,locked:locked&&i===1},doc.revision);
      checkpoints[ids[i]]={geometry:digest({box:[x,y,w,h],polygon}),method:'lama-manga',bubbleToolsOnly:true};
    }
    const doc=getDoc<any>(`page:${page.imageId}`,{});
    putDoc(page.episode.id,doc.id,{prepared:raw,preparedAt:1,cleaned:partial,pendingCleanRegions:mode==='pending'?[ids[1]]:undefined,directorCleaning:{raw,artwork:partial,regions:checkpoints}},doc.revision);
    const runId=createJob(page.episode.id,'director',{});
    sqlite.prepare("INSERT INTO director_runs(id,episode_id,user_id,scope,model,proofreader,state,page_ids,created_at,updated_at,version,policy) VALUES(?,?,?,'page',?,?,'running',?,1,1,9,'{}')")
      .run(runId,page.episode.id,user.id,JSON.stringify(selected),JSON.stringify(selected),JSON.stringify([page.imageId]));
    const operations:any[]=[],reviews:any[]=[];
    const white=await storeAsset(await sharp({create:{width:500,height:360,channels:3,background:'white'}}).png().toBuffer());
    const imageOperation=async(payload:any)=>{
      operations.push(payload);
      if(payload.cmd==='bubble-fill'&&!fail){assert.equal(payload.excludeRegions.length,0,'Recheck overlapping connected lobes as one group');return runWorkflowPng(payload);}
      return {artifact:payload.cmd==='mask'?white:partial,result:{}};
    };
    const call=(async(purpose:string,_system:string,data:any,images:Buffer[])=>{
      if(purpose==='plan-balloon-fills')return{decisions:data.regions.map((r:any)=>({lineId:r.id,eligible:!['refused','pending'].includes(mode),plainBubble:!['refused','pending'].includes(mode),borderIntact:!['refused','pending'].includes(mode),borderCrossed:mode==='crossed',interiorArtwork:mode==='artwork',reason:mode==='refused'?'Connected neck is mistakenly called an open boundary':'Closed uniform connected bubble'}))};
      if(purpose==='verify-lettering')return {hasLettering:true,reason:'Lettering is visible in the target area.'};
      assert.equal(purpose,'inspect-cleaning');reviews.push(data);
      if(data.scope==='region'){
        assert.equal(images.length,4);assert.equal(data.imageOrder.length,4);
        assert.equal((await sharp(images[3]).metadata()).width,700,'Inspect an enlarged cleaned-only view of the text area');
      }
      return{safe:true,problem:'none',reason:'Visual fixture always says clean'};
    }) as any;
    const ctx:any={run:{id:runId,episode_id:page.episode.id,policy:'{}'},series:page.series,episode:page.episode,user,signal:new AbortController().signal,authorize:async()=>{},imageOperation};
    const execute=()=>withDirector({runId,episodeId:page.episode.id,imageId:page.imageId},()=>cleanDirectorPage(ctx,page.imageId,call,0));
    if(fail)await assert.rejects(execute(),/still needs attention/);else await execute();
    const saved=getDoc<any>(`page:${page.imageId}`,{}).data;
    const check=cleaningResidueInspector(await readAsset(raw),ids.map((id,i)=>({id,box:boxes[i] as [number,number,number,number]})));
    if(fail){
      assert.equal(saved.cleaned,partial);assert.deepEqual(saved.pendingCleanRegions,[ids[1]]);
      assert.equal(saved.directorCleaning.regions[ids[1]],undefined,'A rejected old checkpoint cannot remain trusted');
      assert.equal((await check(await readAsset(saved.cleaned))).length,1);
      if(locked)assert.equal(operations.length,0,'Locked ink cannot trigger an edit through its connected neighbour');
    }else{
      assert.deepEqual(await check(await readAsset(saved.cleaned)),[]);
      assert.equal(saved.pendingCleanRegions,undefined);
      for(const id of ids)assert.equal(saved.directorCleaning.regions[id].method,'bubble-fill');
      assert.equal(operations.filter(p=>p.cmd==='bubble-fill').length,1);
      assert.equal(operations.filter(p=>p.cmd==='clean').length,0,'Use the safe shared fill before LaMa');
    }
    assert.ok((sqlite.prepare("SELECT detail FROM director_events WHERE run_id=? AND kind='clean:residue'").all(runId) as any[]).some(e=>JSON.parse(e.detail).findings[0].lineId===ids[1]));
    assert.ok(reviews.every(r=>r.method!=='existing'||r.scope!=='whole-page'),'The initial false-positive pass is vetoed by pixels before invoking the visual model');
    sqlite.prepare("UPDATE director_runs SET state='completed' WHERE id=?").run(runId);updateJob(runId,'completed',{});
  });
});

test("adopted generated types prevent destructive undo and roll back the whole undo transaction", async () => {
  const page = await seedChapter("adopted-type", 8);
  const result = await runPage(page);
  const id = createDirectorType(
    "s",
    result.runId,
    page.imageId,
    "Electronic display",
    "plain",
    "Visible screen text",
  );
  const other = await seedChapter("other-adopted", 8);
  sqlite
    .prepare("UPDATE lines SET line_type=? WHERE id=?")
    .run(id, other.lineId);
  const before = snapshotPage(page.episode.id, page.imageId);
  assert.throws(
    () => undoDirector({ episodeId: page.episode.id, runId: result.runId }),
    /adopted elsewhere/,
  );
  assert.deepEqual(snapshotPage(page.episode.id, page.imageId), before);
});

test("concurrent starts claim only one chapter run and changing approval alone does not stale checks", async () => {
  const page = await seedChapter("concurrent-start", 8);
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      startDirector({
        ...page,
        user,
        scope: "page",
        imageId: page.imageId,
        model: selected,
      }),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const run = (
    results.find(
      (result) => result.status === "fulfilled",
    ) as PromiseFulfilledResult<any>
  ).value;
  await waitRun(run.runId);
  const before = (await directorOverviewAsync(page.episode.id)).pages[0].state;
  assert.equal(before, "passed");
  const doc = getDoc<any>(`page:${page.imageId}`, {});
  putDoc(
    page.episode.id,
    doc.id,
    { ...doc.data, cleanApproved: true, completed: { clean: "human-stamp" } },
    doc.revision,
  );
  assert.equal(
    (await directorOverviewAsync(page.episode.id)).pages[0].state,
    "passed",
  );
});

test("deleting a chapter removes Director evidence without blocking chapter deletion", async () => {
  const page = await seedChapter("delete-director-chapter", 10);
  const { runId } = await runPage(page);
  createDirectorType(
    "s",
    runId,
    page.imageId,
    "Handwritten note",
    "plain",
    "Handwritten letter in a panel",
  );
  const before = sqlite
    .prepare("SELECT * FROM director_created_types WHERE run_id=?")
    .get(runId);
  const { migrateDirectorAutomation } =
    await import("../src/lib/server/directorMigration");
  sqlite.prepare("DELETE FROM schema_versions WHERE version=12").run();
  migrateDirectorAutomation(sqlite);
  migrateDirectorAutomation(sqlite);
  assert.deepEqual(
    sqlite
      .prepare("SELECT * FROM director_created_types WHERE run_id=?")
      .get(runId),
    before,
    "upgrade retains existing evidence and is idempotent",
  );
  assert.doesNotThrow(() =>
    sqlite.prepare("DELETE FROM episodes WHERE id=?").run(page.episode.id),
  );
  assert.equal(
    sqlite.prepare("SELECT 1 FROM director_runs WHERE id=?").get(runId),
    undefined,
  );
  assert.equal(
    sqlite
      .prepare("SELECT 1 FROM director_created_types WHERE run_id=?")
      .get(runId),
    undefined,
  );
  assert.equal(
    sqlite
      .prepare("SELECT 1 FROM director_classifications WHERE run_id=?")
      .get(runId),
    undefined,
  );
});

test("compact description cache upgrades existing Director databases without losing examples", async () => {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE schema_versions(version INTEGER PRIMARY KEY, applied_at INTEGER);
      INSERT INTO schema_versions VALUES(11,1),(12,1);
      CREATE TABLE series(id TEXT PRIMARY KEY);
      INSERT INTO series VALUES('upgrade-series');
      CREATE TABLE director_examples(id TEXT PRIMARY KEY,data TEXT);
      INSERT INTO director_examples VALUES('saved-example','trusted evidence');`);
    const { migrateDirectorAutomation } =
      await import("../src/lib/server/directorMigration");
    migrateDirectorAutomation(db);
    assert.deepEqual(db.prepare("SELECT * FROM director_examples").all(), [
      { id: "saved-example", data: "trusted evidence" },
    ]);
    db.prepare(
      "INSERT INTO director_type_descriptions VALUES('upgrade-series','plain','fingerprint','{}',1)",
    ).run();
    migrateDirectorAutomation(db);
    assert.equal(
      (
        db
          .prepare("SELECT count(*) AS n FROM director_type_descriptions")
          .get() as any
      ).n,
      1,
    );
    assert.ok(
      db.prepare("SELECT 1 FROM schema_versions WHERE version=13").get(),
    );
    db.exec("DELETE FROM series WHERE id='upgrade-series'");
  } finally {
    db.close();
  }
});

const letteringPatch = (patch: Record<string, unknown>) => ({
  fontId: null,
  size: null,
  leading: null,
  padding: null,
  align: null,
  emphasis: null,
  rotation: null,
  outlineWidth: null,
  fill: null,
  outline: null,
  ...patch,
});

test("lettering QA applies a concrete style repair before requesting a second review", async () => {
  const page = await seedChapter("lettering-style-repair", 6);
  const normal = respond;
  let checks = 0,
    repairs = 0;
  respond = (purpose, data) => {
    if (purpose === "check-page" && ++checks === 1)
      return {
        findings: [
          {
            lineId: page.lineId,
            code: "weak-shout",
            message: "Shout needs larger bold lettering",
            evidence: "Source is a prominent shout",
            repair: "typeset",
          },
        ],
      };
    if (purpose === "repair-lettering") {
      repairs++;
      assert.ok(data.fonts.some((item: any) => item.id === font.id));
      return {
        needsGeometry: false,
        needsClassification: false,
        edits: [
          {
            lineId: page.lineId,
            style: letteringPatch({ size: 20, minSize: 20, emphasis: "bold" }),
            reason: "Match the source shout",
          },
        ],
      };
    }
    return normal(purpose, data);
  };
  try {
    const result = await runPage(page);
    assert.equal(
      result.overview.pages[0].state,
      "passed",
      result.overview.pages[0].detail,
    );
    const region = getDoc<any>(`region:${page.lineId}`, {}).data;
    assert.equal(region.style.emphasis, "bold");
    assert.equal(region.layout.size, 20);
    assert.notEqual(region.style.minSize, 20, "Director changed the minimum size");
    assert.equal(checks, 2);
    assert.equal(repairs, 1);
    assert.equal(
      (
        sqlite
          .prepare(
            "SELECT detail FROM director_stages WHERE run_id=? AND stage='check'",
          )
          .get(result.runId) as any
      ).detail,
      "{}",
    );
    undoDirector({ episodeId: page.episode.id, runId: result.runId });
    assert.equal(
      getDoc<any>(`region:${page.lineId}`, {}).data.style,
      undefined,
    );
  } finally {
    respond = normal;
  }
});

test("an unchanged lettering result stays blocked instead of accepting a stochastic second pass", async () => {
  const page = await seedChapter("lettering-no-progress", 6);
  const normal = respond;
  let checks = 0;
  respond = (purpose, data) => {
    if (purpose === "check-page")
      return {
        findings:
          ++checks === 1
            ? [
                {
                  lineId: page.lineId,
                  code: "placement",
                  message: "Lettering is misplaced",
                  evidence: "Text is too close to the edge",
                  repair: "typeset",
                },
              ]
            : [],
      };
    if (purpose === "repair-lettering")
      return {
        needsGeometry: false,
        needsClassification: false,
        edits: [
          {
            lineId: page.lineId,
            style: letteringPatch({ size: 16 }),
            reason: "No actual change",
          },
        ],
      };
    return normal(purpose, data);
  };
  try {
    const result = await runPage(page);
    assert.equal(result.overview.pages[0].state, "unresolved");
    assert.equal(checks, 1);
    assert.ok(
      result.overview.pages[0].findings.some(
        (finding: any) => finding.code === "placement",
      ),
    );
    assert.equal(
      listJobs(page.episode.id).filter((job) => job.kind === "page-proofread" && job.payload.mode === "critique")
        .length,
      1,
    );
    // Simulate a crash after checkpointing the failure but before marking the
    // stage blocked. Recovery must also honor that terminal working checkpoint.
    sqlite
      .prepare(
        "UPDATE director_stages SET state='working' WHERE run_id=? AND stage='check'",
      )
      .run(result.runId);
    sqlite
      .prepare(
        "UPDATE director_runs SET state='interrupted',current_index=0 WHERE id=?",
      )
      .run(result.runId);
    await resumeDirector({ ...page, user, runId: result.runId });
    await waitRun(result.runId);
    assert.equal(checks, 1);
    sqlite
      .prepare(
        "UPDATE director_runs SET state='interrupted',current_index=0 WHERE id=?",
      )
      .run(result.runId);
    await resumeDirector({ ...page, user, runId: result.runId });
    await waitRun(result.runId);
    const resumed = await directorOverviewAsync(page.episode.id, result.runId);
    assert.equal(resumed.pages[0].state, "unresolved");
    assert.ok(
      resumed.pages[0].findings.some(
        (finding: any) => finding.code === "placement",
      ),
    );
    assert.equal(
      checks,
      1,
      "recovery must retain a terminal no-progress finding",
    );
    assert.equal(
      listJobs(page.episode.id).filter((job) => job.kind === "page-proofread" && job.payload.mode === "critique")
        .length,
      1,
    );
  } finally {
    respond = normal;
  }
});

for (const stage of ["translate", "typeset"] as const) {
  test(`failed ${stage} stops before final proofreading without repeating identical work`, async () => {
    const page = await seedChapter(`prerequisite-${stage}`, 6);
    const normal = respond;
    const start = requests.length;
    if (stage === "translate") sqlite.prepare("UPDATE lines SET body='' WHERE id=?").run(page.lineId);
    if (stage === "typeset") {
      const region = getDoc<any>(`region:${page.lineId}`, {});
      putDoc(
        page.episode.id,
        region.id,
        { ...region.data, locked: true, style: { fontId: "missing-font" } },
        region.revision,
      );
    }
    respond = (purpose, data) =>
      purpose === "correct-text" && stage === "translate"
        ? {
            reason: "Unable to verify the source",
            sourceReviewLineIds: [page.lineId],
            textComplete: false,
            edits: [],
          }
        : normal(purpose, data);
    try {
      const result = await runPage(page);
      assert.equal(result.overview.pages[0].state, "unresolved");
      assert.ok(
        result.overview.pages[0].findings.some(
          (finding: any) => finding.stage === stage,
        ),
      );
      assert.equal(
        listJobs(page.episode.id).filter((job) => job.kind === "page-proofread" && job.payload.mode === "critique")
          .length,
        0,
      );
      assert.equal(
        requests
          .slice(start)
          .filter((request) => request.purpose === "check-page").length,
        0,
      );
      const row = sqlite
        .prepare(
          "SELECT attempts FROM director_stages WHERE run_id=? AND stage=?",
        )
        .get(result.runId, stage) as any;
      assert.equal(row.attempts, 1);
    } finally {
      respond = normal;
    }
  });
}

test("Director reuses saved scene context without a separate scene-description request", async () => {
  const page = await seedChapter("saved-scene-context", 6);
  const normal = respond;
  let scene = "";
  respond = (purpose, data) => {
    if (purpose === "correct-text") scene = data.scene;
    assert.notEqual(purpose, "describe-scene");
    return normal(purpose, data);
  };
  try {
    const result = await runPage(page);
    assert.equal(result.overview.pages[0].state, "passed");
    assert.equal(scene, "Two people talk");
    sqlite.prepare("UPDATE images SET caption='' WHERE id=?").run(page.imageId);
    const second = await runPage(page);
    assert.equal(
      second.overview.pages[0].state,
      "passed",
      second.overview.pages[0].detail,
    );
    assert.equal(
      (
        sqlite
          .prepare("SELECT caption FROM images WHERE id=?")
          .get(page.imageId) as any
      ).caption,
      "",
    );
  } finally {
    respond = normal;
  }
});

test("rebuilding learned memory relearns every referenced type on the next run, once", async () => {
  const config = getDoc<any>("series:s", {});
  putDoc(null, config.id, {
    ...config.data,
    regionKinds: [...config.data.regionKinds, { id: "relearn-test", label: "Relearn caption", color: "#cccccc" }],
  }, config.revision);
  const reference = await seedChapter("relearn-reference", 30, "done");
  sqlite.prepare("UPDATE lines SET line_type='relearn-test' WHERE id=?").run(reference.lineId);
  const page = await seedChapter("relearn-target", 31);
  const settings = memorySettings("s");
  saveMemorySettings("s", settings.revision, {}, true);
  const learned = (from: number) =>
    requests.slice(from).filter((request) => request.purpose === "learn-region-example");
  const start = requests.length;
  await runPage(page);
  assert.ok(
    learned(start).some((request) => request.data.type.id === "relearn-test"),
    "a type nobody was unsure about is still learned after a rebuild",
  );
  const { relearnPending } = await import("../src/lib/server/directorMemory");
  assert.equal(relearnPending("s"), false, "the rebuild request is used once");
});

test("uncertain classification learns only relevant conventions and rechecks only uncertain regions", async () => {
  const config = getDoc<any>("series:s", {});
  putDoc(
    null,
    config.id,
    {
      ...config.data,
      regionKinds: [
        ...config.data.regionKinds,
        { id: "lazy-test", label: "Rare caption", color: "#eeeeee" },
        { id: "unused-test", label: "Unrelated type", color: "#dddddd" },
      ],
    },
    config.revision,
  );
  for (const [name, type] of [
    ["lazy-a", "lazy-test"],
    ["lazy-b", "lazy-test"],
    ["unused-a", "unused-test"],
  ]) {
    const reference = await seedChapter(name, 20, "done");
    sqlite
      .prepare("UPDATE lines SET line_type=? WHERE id=?")
      .run(type, reference.lineId);
  }
  const page = await seedChapter("lazy-classification-target", 21);
  sqlite
    .prepare("UPDATE lines SET line_type='lazy-test' WHERE id=?")
    .run(page.lineId);
  sqlite
    .prepare(
      `INSERT INTO lines(id,episode_id,image_id,body,line_type,status,placed,x,y,w,h,sort_order,updated_at,updated_by,source,source_state)
    VALUES(?,?,?,'Hello','plain','none',1,.2,.6,.5,.2,1,1,'u','こんにちは','read')`,
    )
    .run(`${page.lineId}-certain`, page.episode.id, page.imageId);
  const normal = respond;
  const start = requests.length;
  const batches: string[][] = [];
  respond = (purpose, data) => {
    if (purpose === "classify-regions") {
      batches.push(data.regions.map((line: any) => line.id));
      const result = normal(purpose, data);
      return {
        classifications: result.classifications.map((decision: any) =>
          decision.lineId === page.lineId
            ? {
                ...decision,
                typeId: "lazy-test",
                certain: batches.length > 1,
                candidateTypeIds: ["lazy-test"],
                referenceIds: data.typeDescriptions
                  .filter(
                    (description: any) => description.typeId === "lazy-test",
                  )
                  .map((description: any) => description.id),
                reason: "Needs the rare-caption convention",
              }
            : decision,
        ),
      };
    }
    return normal(purpose, data);
  };
  try {
    const result = await runPage(page);
    assert.equal(
      result.overview.pages[0].state,
      "passed",
      result.overview.pages[0].detail,
    );
    assert.equal(batches.length, 2);
    assert.deepEqual(batches[1], [page.lineId]);
    const learning = requests
      .slice(start)
      .filter((request) => request.purpose === "learn-region-example");
    assert.equal(learning.length, 2);
    assert.ok(
      learning.every((request) => request.data.type.id === "lazy-test"),
    );
    const count = learning.length;
    await runPage(page);
    assert.equal(
      requests
        .slice(start)
        .filter((request) => request.purpose === "learn-region-example").length,
      count,
    );
  } finally {
    respond = normal;
    const current = getDoc<any>(config.id, {});
    putDoc(null, config.id, config.data, current.revision);
  }
});

test("mixed review findings produce one text pass, classification pass, cleaning pass and refit", async () => {
  const masks = await localMaskFixture({ flatClean: true });
  const page = await seedChapter("mixed-repair-plan", 22);
  proofreaderReply=(mode,{rows})=>mode==='critique'?'Specific source/render discrepancy':rows.map((r:any)=>`Region ${r.id}: Original source: ${r.source||'こんにちは'}; English: ${r.body||'Hello'}`).join('\n');
  const normal = respond;
  let checks = 0,
    scans = 0;
  const afterReview: Record<string, number> = {};
  respond = (purpose, data) => {
    if (checks > 0) afterReview[purpose] = (afterReview[purpose] || 0) + 1;
    if (purpose === "inspect-region-coverage" && ++scans > 1) return { regions: [] };
    if (purpose === "repair-geometry")
      return {
        edits: [
          {
            lineId: page.lineId,
            x: 0.25,
            y: 0.2,
            w: 0.45,
            h: 0.3,
            polygon: [
              { x: 0.25, y: 0.2 },
              { x: 0.7, y: 0.2 },
              { x: 0.7, y: 0.5 },
              { x: 0.25, y: 0.5 },
            ],
            reason: "Tighten the region around lettering",
          },
        ],
      };
    if (purpose === "check-page" && ++checks === 1)
      return {
        textChanges: false,
        findings: ["text", "classify", "geometry", "detect", "typeset"].map(
          (repair) => ({
            lineId: repair === "detect" ? "" : page.lineId,
            code: repair,
            message: `Repair ${repair}`,
            evidence: "Specific source/render discrepancy",
            repair,
          }),
        ),
      };
    return normal(purpose, data);
  };
  try {
    const result = await runPage(page);
    assert.equal(
      result.overview.pages[0].state,
      "passed",
      result.overview.pages[0].detail,
    );
    assert.equal(afterReview["correct-text"], 2, "One planned repair plus direct application of the next frontier critique");
    assert.equal(afterReview["classify-regions"], 1);
    assert.equal(afterReview["repair-geometry"], 1);
    assert.equal(afterReview["inspect-cleaning-mask"], undefined);
    assert.equal(afterReview["inspect-cleaning"], 2, "Verify existing region and final page without recleaning already clear artwork");
    assert.equal(checks, 2);
    assert.equal(
      (
        sqlite
          .prepare(
            "SELECT count(*) n FROM director_events WHERE run_id=? AND kind='typeset:result'",
          )
          .get(result.runId) as any
      ).n,
      2,
    );
  } finally {
    respond = normal;
    proofreaderReply=undefined;
    masks.restore();
  }
});

test("English-only repairs do not reclassify unchanged source regions", async () => {
  const page = await seedChapter("english-only-repair", 23);
  proofreaderReply=(mode,{rows})=>mode==='critique'?'Omitted greeting':rows.map((r:any)=>`Region ${r.id}: Original source: ${r.source||'こんにちは'}; English: ${r.body||'Hello'}`).join('\n');
  const normal = respond;
  let checks = 0,
    classifications = 0;
  respond = (purpose, data) => {
    if (purpose === "classify-regions") classifications++;
    if (purpose === "check-page" && ++checks === 1)
      return {
        findings: [
          {
            lineId: page.lineId,
            code: "english",
            message: "English needs correction",
            evidence: "Omitted greeting",
            repair: "text",
          },
        ],
      };
    if (purpose === "correct-text" && checks > 0)
      return {
        sourceReviewLineIds: [],
        textComplete: true,
        reason: "Corrected greeting",
        edits: [
          {
            lineId: page.lineId,
            source: null,
            english: "Hello there",
            reason: "Complete the English",
          },
        ],
      };
    return normal(purpose, data);
  };
  try {
    const result = await runPage(page);
    assert.equal(
      result.overview.pages[0].state,
      "passed",
      result.overview.pages[0].detail,
    );
    assert.equal(classifications, 1);
    assert.equal(checks, 2);
    assert.equal((await listLines(page.episode.id))[0].body, "Hello there");
  } finally {
    respond = normal;
    proofreaderReply=undefined;
  }
});

test("classification uncertainty without new reference evidence blocks without an identical retry", async () => {
  const config = getDoc<any>("series:s", {});
  putDoc(
    null,
    config.id,
    {
      ...config.data,
      regionKinds: [
        ...config.data.regionKinds,
        {
          id: "empty-memory-test",
          label: "No references yet",
          color: "#eeeeee",
        },
      ],
    },
    config.revision,
  );
  const page = await seedChapter("classification-no-evidence", 24);
  const normal = respond;
  const start = requests.length;
  respond = (purpose, data) => {
    const result = normal(purpose, data);
    if (purpose === "classify-regions")
      return {
        classifications: result.classifications.map((item: any) => ({
          ...item,
          typeId: "empty-memory-test",
          certain: false,
          candidateTypeIds: ["empty-memory-test"],
          reason: "No trusted convention",
        })),
      };
    return result;
  };
  try {
    const result = await runPage(page);
    assert.equal(result.overview.pages[0].state, "unresolved");
    assert.equal(
      requests
        .slice(start)
        .filter((request) => request.purpose === "classify-regions").length,
      1,
    );
    assert.equal(
      requests
        .slice(start)
        .filter((request) => request.purpose === "learn-region-example").length,
      0,
    );
    assert.equal(
      listJobs(page.episode.id).filter((job) => job.kind === "page-proofread" && job.payload.mode === "critique")
        .length,
      0,
    );
  } finally {
    respond = normal;
    const current = getDoc<any>(config.id, {});
    putDoc(null, config.id, config.data, current.revision);
  }
});

test("invalid lettering edits roll back the whole repair and retain the original finding", async () => {
  const page = await seedChapter("lettering-atomic-repair", 25);
  const normal = respond;
  let checks = 0;
  respond = (purpose, data) => {
    if (purpose === "check-page")
      return {
        findings:
          ++checks === 1
            ? [
                {
                  lineId: page.lineId,
                  code: "bold",
                  message: "Shout needs emphasis",
                  evidence: "Bold source lettering",
                  repair: "typeset",
                },
              ]
            : [],
      };
    if (purpose === "repair-lettering")
      return {
        needsGeometry: false,
        needsClassification: false,
        edits: [page.lineId, "another-page-line"].map((lineId) => ({
          lineId,
          style: letteringPatch({ emphasis: "bold" }),
          reason: "Add emphasis",
        })),
      };
    return normal(purpose, data);
  };
  try {
    const result = await runPage(page);
    assert.equal(result.overview.pages[0].state, "unresolved");
    assert.equal(
      getDoc<any>(`region:${page.lineId}`, {}).data.style,
      undefined,
    );
    assert.ok(
      result.overview.pages[0].findings.some(
        (finding: any) => finding.code === "bold",
      ),
    );
    assert.equal(checks, 1);
  } finally {
    respond = normal;
  }
});

test("previous Director passes become stale, while interrupted v2 runs still resume through automation", async () => {
  const page = await seedChapter("previous-director-version", 26);
  const first = await runPage(page);
  sqlite
    .prepare("UPDATE director_pages SET version=2 WHERE episode_id=?")
    .run(page.episode.id);
  assert.equal(
    (await directorOverviewAsync(page.episode.id, first.runId)).pages[0].state,
    "stale",
  );
  sqlite
    .prepare(
      "UPDATE director_runs SET version=2,state='interrupted',current_index=0 WHERE id=?",
    )
    .run(first.runId);
  sqlite
    .prepare("DELETE FROM director_stages WHERE run_id=? AND stage='check'")
    .run(first.runId);
  await resumeDirector({ ...page, user, runId: first.runId });
  await waitRun(first.runId);
  const result = await directorOverviewAsync(page.episode.id, first.runId);
  assert.equal(result.pages[0].state, "passed", result.pages[0].detail);
  assert.equal(
    getDoc<any>(`page:${page.imageId}`, {}).data.cleanApproved,
    undefined,
  );
});

test("lettering QA can route a wrongly typed region through one targeted classification repair", async () => {
  const page = await seedChapter("lettering-type-route", 27);
  sqlite
    .prepare("UPDATE lines SET line_type='thought' WHERE id=?")
    .run(page.lineId);
  const normal = respond;
  let checks = 0,
    classifications = 0;
  respond = (purpose, data) => {
    if (purpose === "check-page" && ++checks === 1)
      return {
        findings: [
          {
            lineId: page.lineId,
            code: "wrong-style",
            message: "Spoken dialogue uses a thought style",
            evidence: "A speaker tail is visible",
            repair: "typeset",
          },
        ],
      };
    if (purpose === "repair-lettering")
      return { needsGeometry: false, needsClassification: true, edits: [] };
    if (purpose === "classify-regions") {
      classifications++;
      const result = normal(purpose, data);
      return classifications === 1
        ? {
            classifications: result.classifications.map((item: any) => ({
              ...item,
              typeId: "thought",
              referenceIds: [],
            })),
          }
        : result;
    }
    return normal(purpose, data);
  };
  try {
    const result = await runPage(page);
    assert.equal(
      result.overview.pages[0].state,
      "passed",
      result.overview.pages[0].detail,
    );
    assert.equal((await listLines(page.episode.id))[0].lineType, "plain");
    assert.equal(classifications, 2);
    assert.equal(checks, 2);
  } finally {
    respond = normal;
  }
});

async function addDubiousDetection(
  page: Awaited<ReturnType<typeof seedChapter>>,
  options: { body?: string; separate?: boolean } = {},
) {
  const id = `${page.imageId}-dubious`;
  const x = options.separate ? 0.1 : 0.4,
    y = options.separate ? 0.65 : 0.22;
  const w = 0.4,
    h = 0.28;
  sqlite
    .prepare(
      `INSERT INTO lines(id,episode_id,image_id,body,line_type,status,placed,x,y,w,h,sort_order,updated_at,updated_by,source,source_state)
    VALUES(?,?,?,?,'plain','needs_work',1,?,?,?,?,1,1,'u','','unreadable')`,
    )
    .run(id, page.episode.id, page.imageId, options.body || "", x, y, w, h);
  const region = getDoc<any>(`region:${id}`, {});
  putDoc(
    page.episode.id,
    region.id,
    {
      polygon: [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ],
      styleFromSeries: true,
    },
    region.revision,
  );
  return id;
}

async function savedRawProofread(page:Awaited<ReturnType<typeof seedChapter>>,critique:string,mode:'raw'|'critique'='raw') {
  const {capturePageImages}=await import('../src/lib/server/pageImages');
  const capture=await capturePageImages(page.series,page.episode,page.imageId,false);
  const raw=await storeAsset(capture.raw);
  const id=createJob(page.episode.id,'page-proofread',{imageId:page.imageId,mode,...selected});
  updateJob(id,'completed',{snapshot:{raw,imageId:page.imageId,pageLabel:'Page 1',capturedAt:Date.now()},critique});
  return id;
}

test('saved Proofread Raw resolves unreadable ellipsis without Director OCR or overlapping rediscovery',async()=>{
  const masks=await localMaskFixture({flatClean:true});
  const page=await seedChapter('frontier-cached-ellipsis',40);
  sqlite.prepare("UPDATE lines SET source='',body='',source_state='unreadable' WHERE id=?").run(page.lineId);
  const parent=await savedRawProofread(page,`Region ${page.lineId}: Original source: …; English: ...`);
  const normal=respond,start=requests.length,pstart=proofreaderRequests.length;
  respond=(purpose,data)=>purpose==='inspect-region-coverage'?{regions:[{x:.3,y:.25,w:.2,h:.1}]}:normal(purpose,data);
  try {
    const result=await runPage(page);
    assert.equal(result.overview.pages[0].state,'passed',result.overview.pages[0].detail);
    const lines=await listLines(page.episode.id);
    assert.equal(lines.length,1,'A tighter box inside an existing region must not create a duplicate');
    assert.equal(lines[0].source,'…');assert.equal(lines[0].body,'...');assert.equal(lines[0].sourceState,'read');
    assert.ok(result.overview.events.some(e=>e.kind==='critique:reused'&&e.detail.jobId===parent));
    assert.deepEqual(proofreaderRequests.slice(pstart).map(r=>r.mode),['critique']);
    assert.equal(requests.slice(start).filter(r=>r.purpose==='inspect-unreadable-regions'||r.purpose==='detect-and-read').length,0);
    assert.ok(requests.slice(start).filter(r=>r.purpose==='correct-text').every(r=>r.imageCount===0));
  } finally {respond=normal;masks.restore();}
});

test('a Director cannot classify a frontier-read sound effect as non-text artwork',async()=>{
  const masks=await localMaskFixture({flatClean:true});
  const page=await seedChapter('frontier-sfx-not-artwork',40);
  const id=await addDubiousDetection(page,{separate:true});
  const evidence="The sound effect 스윽 is a stylized onomatopoeia with motion lines.";
  await savedRawProofread(page,`Region ${page.lineId}: Original source: こんにちは; English: Hello\nRegion ${id}: ${evidence} English: Slide...`);
  const normal=respond;let mappings=0;
  proofreaderReply=()=>`Region ${id}: Original source: 스윽; English: Slide...`;
  respond=(purpose,data)=>purpose==='correct-text' && ++mappings===1?{textComplete:true,sourceReviewLineIds:[],reason:'Wrong motion-line interpretation',edits:[],exclusions:[{lineId:id,verdict:'non-text',duplicateOf:'',evidence}]}:normal(purpose,data);
  try {
    const result=await runPage(page);
    assert.equal(result.overview.pages[0].state,'passed',result.overview.pages[0].detail);
    const line=(await listLines(page.episode.id)).find(l=>l.id===id)!;
    assert.equal(line.sourceState,'read');assert.equal(line.source,'스윽');assert.equal(line.body,'Slide...');
    assert.equal(result.overview.events.filter(e=>e.kind==='region:excluded'&&e.detail.lineId===id).length,0);
    assert.ok(result.overview.events.some(e=>e.kind==='proofreader:question'&&e.detail.lineId===id));
  } finally {respond=normal;proofreaderReply=undefined;masks.restore();}
});

test('an English critique cannot replace mandatory raw proofreading even for a populated draft',async()=>{
  const page=await seedChapter('frontier-raw-required',40);
  await savedRawProofread(page,'Old English critique only','critique');
  const pstart=proofreaderRequests.length;
  proofreaderReply=(mode,{rows})=>mode==='critique'?'The translation is accurate.':rows.map((r:any)=>`Region ${r.id}: Original source: 덜컥; English: Clunk!`).join('\n');
  try {
    const result=await runPage(page);
    assert.equal(result.overview.pages[0].state,'passed',result.overview.pages[0].detail);
    assert.deepEqual(proofreaderRequests.slice(pstart).map(r=>r.mode),['raw','critique']);
    const line=(await listLines(page.episode.id))[0];assert.equal(line.source,'덜컥');assert.equal(line.body,'Clunk!');
    const events=result.overview.events;
    assert.ok(events.findIndex(e=>e.kind==='proofreader:images'&&e.detail.mode==='raw')<events.findIndex(e=>e.kind==='automation:request'&&e.detail.purpose==='correct-text'));
  } finally {proofreaderReply=undefined;}
});

test('proofreader context crops preserve balloon context on tall pages and clamp page edges',async()=>{
  const {proofreaderRegionCrop}=await import('../src/lib/server/directorMemory');
  const raw=await sharp({create:{width:400,height:2000,channels:3,background:'white'}}).png().toBuffer();
  const crop=await proofreaderRegionCrop(raw,{x:0.69,y:0.19,w:0.11,h:0.012});
  const meta=await sharp(crop).metadata();
  assert.ok(meta.width!>=140,'A narrow text box needs room for the whole balloon');
  assert.ok(meta.height!>=120,'A punctuation row needs vertical balloon context too');
  assert.ok(meta.height!<200,'Padding must use pixels, not a large fraction of a tall page');
  for(const x of [0,0.99]) {
    const edge=await sharp(await proofreaderRegionCrop(raw,{x,y:0.99,w:0.01,h:0.01})).metadata();
    assert.ok(edge.width!>0 && edge.height!>0,'Context crops must stay within the page');
  }
});

test('an unlabelled page transcript with one labelled follow-up does not trigger crop questions for other regions',async()=>{
  const page=await seedChapter('frontier-mixed-transcript',40);
  const id=await addDubiousDetection(page,{separate:true});
  sqlite.prepare("UPDATE lines SET source='스윽',body='Swish.',source_state='read' WHERE id=?").run(id);
  const parent=await savedRawProofread(page,'Top bubble: こんにちは → Hello\nLower sound effect: 스윽 → Swish.');
  const follow=createJob(page.episode.id,'page-proofread',{imageId:page.imageId,followUpOf:parent,prompt:`Confirm region ${page.lineId}`,...selected});
  updateJob(follow,'completed',{critique:`Region ${page.lineId}: Original source: こんにちは; English: Hello`});
  const normal=respond,pstart=proofreaderRequests.length;
  try {
    const result=await runPage(page);
    assert.equal(result.overview.pages[0].state,'passed',result.overview.pages[0].detail);
    assert.deepEqual(proofreaderRequests.slice(pstart).map(r=>r.mode),['critique']);
    assert.equal(result.overview.events.filter(e=>e.kind==='proofreader:question').length,0);
    assert.equal((await listLines(page.episode.id)).find(line=>line.id===id)!.source,'스윽');
  } finally {respond=normal;}
});

test('normal region transcription supplies competing readings for page-transcript correlation before any crop follow-up',async()=>{
  const {localOcrFixture}=await import('./local-ocr-fixture');
  const restoreOcr=await localOcrFixture();
  const masks=await localMaskFixture({flatClean:true});
  const page=await seedChapter('frontier-ocr-correlation',40);
  sqlite.prepare("UPDATE lines SET source='',body='',source_state='unreadable' WHERE id=?").run(page.lineId);
  const doc=getDoc<any>(`series:${page.series.id}`,{});
  putDoc(null,doc.id,{...doc.data,regionAi:{...doc.data.regionAi,
    transcriptionModels:['hayai-ocr-v2','paddleocr-vl-1.6'],transcriptionDecider:null,translate:selected}},doc.revision);
  await fixturePasses(model.id,['translate']);
  await savedRawProofread(page,'Top panel sound effect: Korean 스윽. Suggested English: SWOOSH or SLIDE.');
  const normal=respond,fetchBefore=globalThis.fetch,pstart=proofreaderRequests.length;
  const reads:string[]=[];
  let mappings=0;
  globalThis.fetch=async(url,init)=>{
    if(String(url).startsWith('http://ocr.fixture/')) {
      const paddle=String(url).includes('paddleocr');
      reads.push(paddle?'paddle':'hayai');
      return Response.json(paddle?{choices:[{message:{content:'스윽!'}}]}:{source:'스윽'});
    }
    const payload=JSON.parse(String(init?.body||'{}'));
    if(payload.response_format?.json_schema?.name==='ocr_translate')
      return Response.json({choices:[{message:{content:JSON.stringify({translation:'Swish.'})}}]});
    return fetchBefore(url,init);
  };
  respond=(purpose,data)=>{
    if(purpose!=='correct-text') return normal(purpose,data);
    mappings++;
    if(data.phase==='critique') return {textComplete:true,sourceReviewLineIds:[],reason:'No text defects',edits:[]};
    assert.deepEqual(reads.slice().sort(),['hayai','paddle'],'Both normal recognizers run before transcript mapping');
    const region=data.regions.find((r:any)=>r.id===page.lineId);
    assert.deepEqual(region.transcriptionCandidates.map((c:any)=>c.source).sort(),['스윽','스윽!']);
    assert.match(data.priorProofread,/스윽/);
    if(mappings===1) return {textComplete:false,sourceReviewLineIds:[page.lineId],reason:'Need to correlate the unlabelled sound effect',edits:[]};
    assert.match(data.critique,/ENTIRE saved page transcript/);
    return {textComplete:true,sourceReviewLineIds:[],reason:'OCR locates the reading in the saved transcript',edits:[
      {lineId:page.lineId,source:'스윽',english:'SLIDE',reason:'Select the proofreader reading and suggested English'}]};
  };
  try {
    const result=await runPage(page);
    assert.equal(result.overview.pages[0].state,'passed',result.overview.pages[0].detail+' '+JSON.stringify(result.overview.events.filter(e=>e.kind==='transcription:fallback'))+' '+JSON.stringify(listJobs(page.episode.id).filter(j=>j.kind==='region-ocr')));
    const job=listJobs(page.episode.id).find(j=>j.kind==='region-ocr');
    assert.equal(job?.state,'completed',job?.error||JSON.stringify(job?.progress));
    assert.deepEqual(proofreaderRequests.slice(pstart).map(r=>r.mode),['critique']);
    assert.equal(result.overview.events.filter(e=>e.kind==='text:correlate').length,1);
    assert.equal(result.overview.events.filter(e=>e.kind==='proofreader:question').length,0);
    const line=(await listLines(page.episode.id))[0];
    assert.equal(line.source,'스윽');assert.equal(line.body,'SLIDE');assert.equal(line.sourceState,'read');
  } finally {
    respond=normal;globalThis.fetch=fetchBefore;masks.restore();restoreOcr();
    putDoc(null,doc.id,doc.data,getDoc(doc.id,{}).revision);
  }
});

test('a missing raw reading is queried as a region follow-up, then frontier translation critique is applied and refitted',async()=>{
  const masks=await localMaskFixture({flatClean:true});
  const page=await seedChapter('frontier-region-question',40);
  const id=await addDubiousDetection(page,{separate:true});
  const parent=await savedRawProofread(page,`Region ${page.lineId}: Original source: こんにちは; English: Hello`);
  const normal=respond,pstart=proofreaderRequests.length;
  let checks=0,critiques=0;
  proofreaderReply=(mode)=>mode==='follow-up'?`Region ${id}: Original source: 스윽; English: Swish.`:
    mode==='critique'?(++critiques===1?`In region ${id}, replace Swish. with Slide...`:'The adjusted translation is accurate.'):'unexpected raw request';
  respond=(purpose,data)=>{
    if(purpose==='correct-text' && data.critique.includes('replace Swish.')) return {textComplete:true,sourceReviewLineIds:[],reason:'Apply frontier critique',edits:[{lineId:id,source:null,english:'Slide...',reason:'The proofreader requested this localization'}]};
    if(purpose==='check-page') {checks++;if(data.critique.includes('replace Swish.')) return {findings:[],textChanges:true};assert.equal(data.regions.find((r:any)=>r.id===id).english,'Slide...','Apply the frontier correction before the final visual QA');return {findings:[],textChanges:false};}
    return normal(purpose,data);
  };
  try {
    const result=await runPage(page);
    assert.equal(result.overview.pages[0].state,'passed',result.overview.pages[0].detail);
    const line=(await listLines(page.episode.id)).find(l=>l.id===id)!;
    assert.equal(line.source,'스윽');assert.equal(line.body,'Slide...');
    const follow=listJobs(page.episode.id).find(j=>j.payload.followUpOf===parent)!;
    assert.ok(follow);assert.match(String(follow.payload.prompt),/source and your recommended English translation/);
    assert.match(String(follow.payload.prompt),new RegExp(id));
    // Neutral: the question must not assume the detected region holds text.
    assert.match(String(follow.payload.prompt),/Is there lettering inside that target area, or is it artwork/);
    assert.doesNotMatch(String(follow.payload.prompt),/Clarification needed|unreadable|empty|normalized|Current proofreader guidance/);
    const sent=proofreaderRequests.slice(pstart);
    assert.deepEqual(sent.map(r=>r.mode),['follow-up','critique','critique']);
    assert.equal(sent[0].imageCount,2,'Follow-up API gets the whole raw page and the region crop');
    assert.match(sent[0].prompt,/Previous critique/);
    assert.ok(result.overview.events.some(e=>e.kind==='proofreader:question'&&e.detail.lineId===id&&e.detail.parentJobId===parent&&e.detail.crop));
    assert.equal(result.overview.events.filter(e=>e.kind==='typeset:result').length,2);
    assert.equal(checks,2,'The first critique is applied directly; the visual QA only says it asks for a text change');
    assert.equal((await listLines(page.episode.id)).length,2);
    const again=await runPage(page);
    assert.equal(again.overview.pages[0].state,'passed',again.overview.pages[0].detail);
    assert.equal((await listLines(page.episode.id)).find(l=>l.id===id)!.body,'Slide...',
      'A later run must retain the proofreader-approved revision instead of reverting to the first raw translation');
  } finally {respond=normal;proofreaderReply=undefined;masks.restore();}
});

test('a genuinely unreadable frontier answer stops after one question without Director OCR or rendered critique',async()=>{
  const page=await seedChapter('frontier-cannot-read',40);
  const id=await addDubiousDetection(page,{separate:true});
  await savedRawProofread(page,`Region ${page.lineId}: Original source: こんにちは; English: Hello\nRegion ${id}: I cannot read the source.`);
  const normal=respond,pstart=proofreaderRequests.length,start=requests.length;
  proofreaderReply=()=>`Region ${id}: I cannot read this source reliably. Do not guess.`;
  respond=(purpose,data)=>purpose==='correct-text'?{textComplete:false,sourceReviewLineIds:[id],reason:'The frontier proofreader cannot read this source',edits:[]}:normal(purpose,data);
  try {
    const result=await runPage(page);
    assert.equal(result.overview.pages[0].state,'unresolved');
    assert.ok(result.overview.pages[0].findings.some((f:any)=>f.stage==='translate'));
    assert.deepEqual(proofreaderRequests.slice(pstart).map(r=>r.mode),['follow-up']);
    assert.equal((await listLines(page.episode.id)).find(l=>l.id===id)!.source,'');
    assert.equal(requests.slice(start).filter(r=>r.purpose==='inspect-unreadable-regions').length,0);
    assert.equal(requests.slice(start).filter(r=>r.purpose==='check-page').length,0);
  } finally {respond=normal;proofreaderReply=undefined;}
});

test('a Director-generated source not quoted by the proofreader is corrected by local correlation before a crop question',async()=>{
  const page=await seedChapter('frontier-no-invented-source',40);
  await savedRawProofread(page,`Region ${page.lineId}: Original source: 덜컥; English: Clunk!`);
  const normal=respond;let mappings=0;
  proofreaderReply=()=>`Region ${page.lineId}: Original source: 덜컥; English: Clunk!`;
  respond=(purpose,data)=>purpose==='correct-text'?{textComplete:true,sourceReviewLineIds:[],reason:'Map the original',edits:[{lineId:page.lineId,source:++mappings===1?'없는글':'덜컥',english:'Clunk!',reason:'Source mapping'}]}:normal(purpose,data);
  try {
    const result=await runPage(page);
    assert.equal(result.overview.pages[0].state,'passed',result.overview.pages[0].detail);
    assert.equal(mappings,3, "Initial mapping, local correlation, and direct critique application");
    assert.equal((await listLines(page.episode.id))[0].source,'덜컥');
    assert.ok(result.overview.events.some(e=>e.kind==='text:correlate'));
    assert.equal(result.overview.events.filter(e=>e.kind==='proofreader:question').length,0);
    assert.equal(result.overview.events.filter(e=>e.kind==='edit'&&e.detail.after?.source==='없는글').length,0);
  } finally {respond=normal;proofreaderReply=undefined;}
});

for(const verdict of ['non-text','duplicate'] as const) {
  test(`only explicit frontier evidence can exclude an empty ${verdict} detection`,async()=>{
    const page=await seedChapter(`frontier-exclude-${verdict}`,40);
    const id=await addDubiousDetection(page);
    const evidence=verdict==='non-text'?'This region is non-text artwork.':`This region is a duplicate of ${page.lineId}.`;
    await savedRawProofread(page,`Region ${page.lineId}: Original source: こんにちは; English: Hello\nRegion ${id}: ${evidence}`);
    const normal=respond;
    respond=(purpose,data)=>purpose==='correct-text'?{textComplete:true,sourceReviewLineIds:[],reason:'Apply proofreader classification',edits:[],exclusions:[{lineId:id,verdict,duplicateOf:verdict==='duplicate'?page.lineId:'',evidence}]}:normal(purpose,data);
    try {
      const result=await runPage(page);
      assert.equal(result.overview.pages[0].state,'passed',result.overview.pages[0].detail);
      const line=(await listLines(page.episode.id)).find(l=>l.id===id)!;
      assert.equal(line.sourceState,'ignored');assert.match(line.ignoreReason||'',/Proofreader/);
      assert.equal((await listLines(page.episode.id)).length,2);
      assert.equal(getDoc<any>(`page:${page.imageId}`,{}).data.pendingCleanRegions,undefined);
      undoDirector({episodeId:page.episode.id,runId:result.runId});
      assert.equal((await listLines(page.episode.id)).find(l=>l.id===id)!.sourceState,'unreadable');
    } finally {respond=normal;}
  });
}


test("invalid classification IDs are rejected by the request schema and corrected before applying decisions", async () => {
  const page = await seedChapter("classification-bound-ids", 29);
  const normal = respond;
  const start = requests.length;
  let calls = 0;
  respond = (purpose, data) => {
    const result = normal(purpose, data);
    return purpose === "classify-regions" && ++calls === 1
      ? {
          classifications: result.classifications.map((decision: any) => ({
            ...decision,
            lineId: "}, {",
          })),
        }
      : result;
  };
  try {
    const result = await runPage(page);
    assert.equal(
      result.overview.pages[0].state,
      "passed",
      result.overview.pages[0].detail,
    );
    assert.equal(calls, 2);
    const request = requests
      .slice(start)
      .find((request) => request.purpose === "classify-regions")!;
    assert.deepEqual(
      request.schema.properties.classifications.items.properties.lineId.enum,
      [page.lineId],
    );
    assert.equal(request.schema.properties.classifications.minItems, 1);
  } finally {
    respond = normal;
  }
});

test('an empty Dialogue type ID gets a targeted correction before it can roll back other classifications',async()=>{
  const page=await seedChapter('empty-dialogue-id',30);
  const other=await addDubiousDetection(page);
  sqlite.prepare("UPDATE lines SET source='はい',body='Yes',source_state='read' WHERE id=?").run(other);
  sqlite.prepare("UPDATE lines SET line_type='thought' WHERE id=?").run(page.lineId);
  const config=getDoc<any>('series:s',{}),original=config.data;
  putDoc('s',config.id,{...original,regionKinds:[...original.regionKinds,{id:'\"\"',label:'Bubble dialogue'}]},config.revision);
  const normal=respond,start=requests.length;
  let calls=0;
  respond=(purpose,data)=>{
    const result=normal(purpose,data);
    if(purpose!=='classify-regions')return result;
    calls++;
    if(calls===2)assert.match(data.responseCorrection,/empty typeId is only valid.*two literal quote/);
    return {classifications:result.classifications.map((decision:any)=>({...decision,
      typeId:decision.lineId===other?(calls===1?'':'\"\"'):'plain',referenceIds:[]}))};
  };
  try {
    const result=await runPage(page);
    assert.equal(result.overview.pages[0].state,'passed',result.overview.pages[0].detail);
    assert.equal(calls,2);
    const lines=await listLines(page.episode.id);
    assert.equal(lines.find(l=>l.id===page.lineId)!.lineType,'plain','Keep the valid decision from the same batch');
    assert.equal(lines.find(l=>l.id===other)!.lineType,'\"\"');
    const contract=requests.slice(start).find(r=>r.purpose==='classify-regions')!.schema;
    assert.ok(contract.properties.classifications.items.properties.typeId.enum.includes('\"\"'));
  } finally {
    respond=normal;
    const current=getDoc<any>('series:s',{});putDoc('s',current.id,original,current.revision);
  }
});

test('Director schema diagnostics identify the exact nested field and repair the response once',async()=>{
  const {validateTaskOutput}=await import('../src/lib/modelTasks');
  const {contractViolation,matchesContract}=await import('../src/lib/jsonContract');
  const {directorModel,objectSchema}=await import('../src/lib/server/directorModel');
  const {directorPolicy,currentDirectorPresentation}=await import('../src/lib/director');
  const coordinates=objectSchema({decisions:{type:'array',minItems:1,items:objectSchema({px:{type:'number',minimum:0,maximum:1}})}});
  const pixels={decisions:[{px:300}]};
  assert.equal(contractViolation(pixels,coordinates),'$.decisions[0].px must be <= 1; received 300');
  assert.equal(matchesContract(pixels,coordinates),false);
  assert.throws(()=>validateTaskOutput('director',pixels,coordinates),/\$\.decisions\[0\]\.px.*<= 1.*300/);
  assert.match(contractViolation({decisions:[{}]},coordinates)!,/\$\.decisions\[0\]\.px is required/);
  assert.match(contractViolation({decisions:[{px:.3,py:.4}]},coordinates)!,/\$\.decisions\[0\]\.py is not allowed/);
  assert.doesNotThrow(()=>validateTaskOutput('director',{decisions:[{px:.3}]},coordinates));
  const normal=respond,start=requests.length;
  let calls=0;
  respond=(purpose,data)=>purpose==='fill-contract-regression'?{decisions:[{px:++calls===1?300:.3}]}:normal(purpose,data);
  try {
    const call=directorModel(selected,directorPolicy(),new AbortController().signal);
    assert.deepEqual(await call('fill-contract-regression','Test',{},[],coordinates),{decisions:[{px:.3}]});
    const correction=requests.slice(start).find(r=>r.correction)!;
    assert.match(correction.correction!,/\$\.decisions\[0\]\.px.*<= 1.*300/);
    assert.equal(calls,2);
  } finally {respond=normal;}
  const page=await seedChapter('presentation-validity',30);
  const line=(await listLines(page.episode.id))[0];
  const evidence:any={raw:page.artwork,box:JSON.stringify([line.x,line.y,line.w,line.h]),source:line.source,enclosure:'none',handwritten:true,role:'speech',reason:'Outside lettering'};
  assert.equal(currentDirectorPresentation({...line,source:'Corrected OCR'}, {directorPresentation:evidence},page.artwork),evidence,'OCR corrections do not change the physical enclosure');
  assert.equal(currentDirectorPresentation({...line,x:line.x!+.1},{directorPresentation:evidence},page.artwork),undefined,'Moving a region invalidates its observation');
  assert.equal(currentDirectorPresentation(line,{directorPresentation:evidence},'other-raw'),undefined);
});

test("duplicate classification IDs receive one explicit correction, never positional reassignment", async () => {
  const page = await seedChapter("classification-duplicate-ids", 29);
  const id = await addDubiousDetection(page);
  sqlite
    .prepare(
      "UPDATE lines SET source='はい',body='Yes',source_state='read' WHERE id=?",
    )
    .run(id);
  const normal = respond;
  let calls = 0;
  respond = (purpose, data) => {
    const result = normal(purpose, data);
    if (purpose === "classify-regions") {
      calls++;
      if (calls === 1)
        return {
          classifications: result.classifications.map((decision: any) => ({
            ...decision,
            lineId: page.lineId,
          })),
        };
      assert.match(data.responseCorrection, /without duplicates/);
    }
    return result;
  };
  try {
    const result = await runPage(page);
    assert.equal(
      result.overview.pages[0].state,
      "passed",
      result.overview.pages[0].detail,
    );
    assert.equal(calls, 2);
    assert.equal(
      (await listLines(page.episode.id)).find((line) => line.id === id)!.source,
      "はい",
    );
  } finally {
    respond = normal;
  }
});

test("empty text edits are corrected by the schema instead of raising a misleading erasure error", async () => {
  const page = await seedChapter("text-nonempty-contract", 29);
  const normal = respond;
  const start = requests.length;
  let calls = 0;
  respond = (purpose, data) =>
    purpose === "correct-text" && ++calls === 1
      ? {
          sourceReviewLineIds: [],
          textComplete: true,
          reason: "Blank edit",
          edits: [
            {
              lineId: page.lineId,
              source: "",
              english: "",
              reason: "No change",
            },
          ],
        }
      : normal(purpose, data);
  try {
    const result = await runPage(page);
    assert.equal(
      result.overview.pages[0].state,
      "passed",
      result.overview.pages[0].detail,
    );
    assert.equal(calls, 3, "The final frontier critique also receives a text-only mapping pass");
    assert.equal((await listLines(page.episode.id))[0].source, "こんにちは");
    const request = requests
      .slice(start)
      .find((request) => request.purpose === "correct-text")!;
    assert.equal(
      request.schema.properties.edits.items.properties.source.minLength,
      1,
    );
    assert.deepEqual(
      request.schema.properties.edits.items.properties.lineId.enum,
      [page.lineId],
    );
  } finally {
    respond = normal;
  }
});

test("false textComplete claims get a correction and leave genuine missing translations blocked", async () => {
  const page = await seedChapter("text-false-completion", 29);
  sqlite.prepare("UPDATE lines SET body='' WHERE id=?").run(page.lineId);
  const normal = respond;
  let calls = 0;
  respond = (purpose, data) => {
    if (purpose === "correct-text") {
      if (++calls === 2)
        assert.match(data.responseCorrection, /textComplete=true contradicts/);
      return {
        sourceReviewLineIds: [],
        textComplete: calls === 1,
        reason: "Cannot verify English",
        edits: [],
      };
    }
    return normal(purpose, data);
  };
  try {
    const result = await runPage(page);
    assert.equal(result.overview.pages[0].state, "unresolved");
    assert.equal(calls, 4, "One schema correction, local correlation, and mapping of the frontier follow-up");
    assert.equal((await listLines(page.episode.id))[0].body, "");
    assert.equal(
      listJobs(page.episode.id).filter((job) => job.kind === "page-proofread" && job.payload.mode === "critique")
        .length,
      0,
    );
  } finally {
    respond = normal;
  }
});

test('a provisional machine exclusion is restored from the raw proofreader before cleaning',async()=>{
  const masks=await localMaskFixture({flatClean:true});
  const page=await seedChapter('frontier-restore-machine',40);
  sqlite.prepare("UPDATE lines SET source='',body='',source_state='ignored',ignore_reason='Old machine mistake' WHERE id=?").run(page.lineId);
  const row=(await listLines(page.episode.id))[0];
  const doc=getDoc<any>(`region:${page.lineId}`,{});
  putDoc(page.episode.id,doc.id,{...doc.data,directorDetectionReview:{runId:'old',lineRevision:row.revision,verdict:'non-text',duplicateOf:'',evidence:'Old machine mistake'}},doc.revision);
  await savedRawProofread(page,`Region ${page.lineId}: Original source: 스윽; English: Slide...`);
  try {
    const result=await runPage(page);
    assert.equal(result.overview.pages[0].state,'passed',result.overview.pages[0].detail);
    const restored=(await listLines(page.episode.id))[0];
    assert.equal(restored.id,page.lineId);assert.equal(restored.sourceState,'read');assert.equal(restored.source,'스윽');assert.equal(restored.body,'Slide...');
    assert.equal(getDoc<any>(`region:${page.lineId}`,{}).data.directorDetectionReview,undefined);
    assert.equal((await listLines(page.episode.id)).length,1);
    assert.equal((await masks.calls()).filter(p=>p.detect).length,1);
  } finally {masks.restore();}
});

test('a human exclusion remains protected when the proofreader reports text there',async()=>{
  const page=await seedChapter('frontier-human-exclusion',40);
  const id=await addDubiousDetection(page,{separate:true});
  sqlite.prepare("UPDATE lines SET source_state='ignored',ignore_reason='Human decision',revision=revision+1 WHERE id=?").run(id);
  await savedRawProofread(page,`Region ${page.lineId}: Original source: こんにちは; English: Hello\nRegion ${id}: Original source: 스윽; English: Slide...`);
  const normal=respond;let checks=0;
  respond=(purpose,data)=>purpose==='check-page' && ++checks===1?{findings:[{lineId:id,code:'source',repair:'detect',message:'Frontier sees lettering',evidence:'Visible lettering in this region'}]}:normal(purpose,data);
  try {
    const result=await runPage(page);
    assert.equal(result.overview.pages[0].state,'unresolved');
    assert.equal((await listLines(page.episode.id)).find(l=>l.id===id)!.sourceState,'ignored');
    assert.match(result.overview.pages[0].detail,/human-ignored/);
  } finally {respond=normal;}
});

test('an old raw response for different source pixels is not reused',async()=>{
  const page=await seedChapter('frontier-stale-raw',40);
  await savedRawProofread(page,'Old raw page reading');
  const changed=await storeAsset(await sharp({create:{width:400,height:500,channels:3,background:'#fafafa'}}).png().toBuffer());
  const doc=getDoc<any>(`page:${page.imageId}`,{});
  putDoc(page.episode.id,doc.id,{...doc.data,prepared:changed,cleanBase:changed},doc.revision);
  const start=proofreaderRequests.length;
  const result=await runPage(page);
  assert.equal(result.overview.pages[0].state,'passed',result.overview.pages[0].detail);
  assert.deepEqual(proofreaderRequests.slice(start).map(r=>r.mode),['raw','critique']);
});

test('a textless page without regions does not request transcription or raw proofreading',async()=>{
  const page=await seedChapter('frontier-blank-page',40);
  sqlite.prepare('DELETE FROM lines WHERE episode_id=?').run(page.episode.id);
  const start=proofreaderRequests.length;
  const result=await runPage(page);
  assert.equal(result.overview.pages[0].state,'passed',result.overview.pages[0].detail);
  assert.equal(proofreaderRequests.slice(start).length,0);
  assert.ok(result.overview.events.some(e=>e.kind==='page:empty'));
  assert.equal(result.overview.events.filter(e=>e.kind==='read:fallback').length,0);
});

test('initial visual coverage can repair region geometry without reading or translating text',async()=>{
  const page=await seedChapter('frontier-initial-geometry',40);
  const normal=respond;
  respond=(purpose,data)=>purpose==='inspect-region-coverage'?{regions:[],edits:[{lineId:page.lineId,x:.25,y:.22,w:.4,h:.2,
    polygon:[{x:.25,y:.22},{x:.65,y:.22},{x:.65,y:.42},{x:.25,y:.42}],reason:'Exclude a decorative face while enclosing the lettering'}]}:normal(purpose,data);
  try {
    const result=await runPage(page);
    assert.equal(result.overview.pages[0].state,'passed',result.overview.pages[0].detail);
    const line=(await listLines(page.episode.id))[0];
    assert.equal(line.x,.25);assert.equal(line.w,.4);assert.equal(line.source,'こんにちは');
    assert.ok(result.overview.changes.some((c:any)=>c.label==='Repair region geometry'));
  } finally {respond=normal;}
});


for (const fontId of ["", "missing-font"]) {
  test(`Director repairs ${fontId ? "unavailable" : "empty"} font choices and can undo them`, async () => {
    const page = await seedChapter(`repair-font-${fontId || "empty"}`, 32);
    const region = getDoc<any>(`region:${page.lineId}`, {});
    const style = { fontId, size: 14, minSize: 8, fill: "#123456" };
    putDoc(
      page.episode.id,
      region.id,
      { ...region.data, style, styleFromSeries: undefined },
      region.revision,
    );
    const result = await runPage(page);
    assert.equal(
      result.overview.pages[0].state,
      "passed",
      result.overview.pages[0].detail,
    );
    const repaired = getDoc<any>(region.id, {}).data;
    assert.equal(repaired.style.fontId, font.id);
    assert.equal(repaired.style.size, 14);
    assert.equal(repaired.style.fill, "#123456");
    assert.ok(
      result.overview.events.some((e) => e.kind === "lettering:changed"),
    );
    undoDirector({ episodeId: page.episode.id, runId: result.runId });
    assert.deepEqual(getDoc<any>(region.id, {}).data.style, style);
  });
}

test("unsupported ellipsis uses equivalent dots in the selected font and is undoable", async () => {
  const punctuationFont = (
    await uploadFont(
      "s",
      "Symbols.otf",
      await readFile("/usr/share/fonts/urw-base35/StandardSymbolsPS.otf"),
    )
  ).font;
  const page = await seedChapter("repair-punctuation", 32);
  sqlite.prepare("UPDATE lines SET body='Hello…' WHERE id=?").run(page.lineId);
  const region = getDoc<any>(`region:${page.lineId}`, {});
  putDoc(
    page.episode.id,
    region.id,
    {
      ...region.data,
      style: { fontId: punctuationFont.id },
      styleFromSeries: undefined,
    },
    region.revision,
  );
  const result = await runPage(page);
  assert.equal(
    result.overview.pages[0].state,
    "passed",
    result.overview.pages[0].detail,
  );
  assert.equal((await listLines(page.episode.id))[0].body, "Hello...");
  assert.equal(
    getDoc<any>(region.id, {}).data.style.fontId,
    punctuationFont.id,
  );
  undoDirector({ episodeId: page.episode.id, runId: result.runId });
  assert.equal((await listLines(page.episode.id))[0].body, "Hello…");
});

for (const persistent of [false, true]) {
  test(`invalid QA IDs are ${persistent ? "bounded and blocked" : "corrected without another proofreader call"}`, async () => {
    const page = await seedChapter(`qa-invalid-${persistent}`, 32);
    const normal = respond,
      start = requests.length;
    let checks = 0;
    respond = (purpose, data) =>
      purpose === "check-page" && (++checks === 1 || persistent)
        ? {
            findings: [
              {
                lineId: "not-a-page-region",
                code: "translation",
                message: "Needs correction",
                evidence: "Wrong wording",
                repair: "text",
              },
            ],
          }
        : normal(purpose, data);
    try {
      const result = await runPage(page);
      assert.equal(
        result.overview.pages[0].state,
        persistent ? "unresolved" : "passed",
      );
      assert.equal(checks, 2);
      assert.equal(
        listJobs(page.episode.id).filter((job) => job.kind === "page-proofread" && job.payload.mode === "critique")
          .length,
        1,
      );
      const calls = requests
        .slice(start)
        .filter((request) => request.purpose === "check-page");
      assert.ok(calls[1].correction || calls[1].data.responseCorrection);
      assert.ok(
        calls[0].schema.properties.findings.items.properties.lineId.enum.includes(
          page.lineId,
        ),
      );
      assert.equal(calls[0].schema.properties.findings.maxItems, 200);
    } finally {
      respond = normal;
    }
  });
}

test("partial cleaning verifies aligned crops of pending regions before committing pixels", async () => {
  const masks = await localMaskFixture({ flatClean: true });
  const page = await seedChapter("partial-mask-scope", 33);
  const id = await addDubiousDetection(page);
  const freeDoc=getDoc<any>(`region:${id}`,{});
  putDoc(page.episode.id,freeDoc.id,{...freeDoc.data,detectionKind:'free'},freeDoc.revision);
  const normal = respond, start=requests.length;
  let inspections=0;
  respond=(purpose,data)=>{
    if(purpose==='inspect-cleaning' && data.mode==='candidate') {
      inspections++;
      assert.deepEqual(data.regions.map((r:any)=>r.id),[id]);
      assert.equal(data.regions[0].source,'こんにちは');
      assert.equal(data.scope,'region');
      assert.deepEqual(data.imageOrder,['raw source','last verified working artwork','candidate cleaned artwork','enlarged candidate text area — must contain no lettering fragments']);
    }
    return normal(purpose,data);
  };
  try {
    const result=await runPage(page);
    assert.equal(result.overview.pages[0].state,'passed',result.overview.pages[0].detail);
    assert.equal(inspections,2,'Inspect the batch candidate and the exact regional pixels to commit');
    assert.ok(requests.slice(start).filter(r=>r.purpose==='inspect-cleaning' && r.data.mode==='candidate').every(r=>r.imageCount===4));
    assert.equal((await masks.calls()).filter(p=>p.detect).length,1);
  } finally {respond=normal;masks.restore();}
});

test("an empty font and unsupported punctuation can be repaired together", async () => {
  const punctuationFont = (
    await uploadFont(
      "s",
      "Symbols.otf",
      await readFile("/usr/share/fonts/urw-base35/StandardSymbolsPS.otf"),
    )
  ).font;
  const page = await seedChapter("repair-combined-font", 34);
  sqlite.prepare("UPDATE lines SET body='Hello…' WHERE id=?").run(page.lineId);
  const region = getDoc<any>(`region:${page.lineId}`, {});
  putDoc(
    page.episode.id,
    region.id,
    { ...region.data, style: { fontId: "" }, styleFromSeries: undefined },
    region.revision,
  );
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO series(id,slug,title,created_at,updated_at) VALUES('font-other','font-other','Other',1,1)",
    )
    .run();
  sqlite
    .prepare("UPDATE font_assets SET series_id='font-other' WHERE id=?")
    .run(font.id);
  try {
    const result = await runPage(page);
    assert.equal(
      result.overview.pages[0].state,
      "passed",
      result.overview.pages[0].detail,
    );
    assert.equal((await listLines(page.episode.id))[0].body, "Hello...");
    assert.equal(
      getDoc<any>(region.id, {}).data.style.fontId,
      punctuationFont.id,
    );
  } finally {
    sqlite
      .prepare("UPDATE font_assets SET series_id='s' WHERE id=?")
      .run(font.id);
  }
});

test("explicit translation-only uncertainty does not trigger source rereading", async () => {
  const page = await seedChapter("translation-only-uncertain", 34);
  const normal = respond;
  let readings = 0,
    translations = 0;
  respond = (purpose, data) => {
    if (purpose === "correct-text") {
      translations++;
      return {
        reason: "Source is verified; English remains ambiguous",
        sourceReviewLineIds: [],
        textComplete: false,
        edits: [],
      };
    }
    if (purpose === "inspect-unreadable-regions") readings++;
    return normal(purpose, data);
  };
  try {
    const result = await runPage(page);
    assert.equal(result.overview.pages[0].state, "passed", result.overview.pages[0].detail);
    assert.equal(readings, 0);
    assert.equal(translations, 2);
    assert.equal(
      listJobs(page.episode.id).filter((job) => job.kind === "page-proofread" && job.payload.mode === "critique")
        .length,
      1,
    );
  } finally {
    respond = normal;
  }
});

async function populatedRenderingDuplicate(
  page: Awaited<ReturnType<typeof seedChapter>>,
) {
  const id = await addDubiousDetection(page);
  sqlite
    .prepare(
      "UPDATE lines SET source='こんにちは',body='Hello',source_state='read',x=.3,y=.25,w=.2,h=.1 WHERE id=?",
    )
    .run(id);
  const doc = getDoc<any>(`region:${id}`, {});
  putDoc(
    page.episode.id,
    doc.id,
    {
      ...doc.data,
      polygon: [
        { x: 0.3, y: 0.25 },
        { x: 0.5, y: 0.25 },
        { x: 0.5, y: 0.35 },
        { x: 0.3, y: 0.35 },
      ],
    },
    doc.revision,
  );
  return id;
}

test("Director turns duplicate rendering off, retains text/layout and supports undo", async () => {
  const page = await seedChapter("duplicate-rendering", 40);
  const id = await populatedRenderingDuplicate(page);
  const normal = respond,
    start = requests.length;
  let checks = 0;
  respond = (purpose, data) => {
    if (purpose === "check-page" && ++checks === 1)
      return {
        findings: [
          {
            lineId: id,
            code: "duplicate-region",
            message: "Duplicate English appears twice",
            evidence: "The source contains this utterance once",
            repair: "text",
          },
        ],
      };
    if (purpose === "check-page") {
      assert.equal(
        data.regions.find((r: any) => r.id === id).renderEnabled,
        false,
      );
      return { findings: [] };
    }
    if (purpose === "review-region-rendering")
      return {
        decisions: [
          {
            lineId: id,
            certain: true,
            duplicateOf: page.lineId,
            evidence:
              "Both boxes cover the same single utterance; keeper is complete",
          },
        ],
      };
    return normal(purpose, data);
  };
  try {
    const result = await runPage(page);
    assert.equal(
      result.overview.pages[0].state,
      "passed",
      result.overview.pages[0].detail,
    );
    assert.equal(checks, 2);
    const line = (await listLines(page.episode.id)).find(
      (line) => line.id === id,
    )!;
    assert.equal(line.source, "こんにちは");
    assert.equal(line.body, "Hello");
    assert.equal(line.sourceState, "read");
    const doc = getDoc<any>(`region:${id}`, {});
    assert.equal(doc.data.renderEnabled, false);
    assert.ok(
      doc.data.layout?.svg,
      "Keep the original layout for review/restoration",
    );
    assert.equal(doc.data.directorRenderingReview.duplicateOf, page.lineId);
    assert.equal(doc.data.directorRenderingReview.reviewed, false);
    const { capturePageImages } = await import("../src/lib/server/pageImages");
    const { renderPage, finishedPsd } =
      await import("../src/lib/server/finishedExport");
    const { readPsd } = await import("ag-psd");
    const capture = await capturePageImages(
      page.series,
      page.episode,
      page.imageId,
    );
    assert.equal(capture.page.regions.length, 2);
    const rendered = await renderPage(capture.page);
    assert.equal(
      rendered.layouts.length,
      1,
      "PNG, previews and PSD must all omit hidden lettering",
    );
    const psd = readPsd(
      await finishedPsd(
        {
          ...capture.page,
          source: {
            ...capture.page.source,
            original: capture.page.source.prepared,
          },
        },
        rendered,
      ),
      {
        skipLayerImageData: true,
        skipCompositeImageData: true,
        skipThumbnail: true,
      },
    );
    assert.equal(psd.children!.filter((layer) => layer.text).length, 1);
    const { readiness } = await import("../src/lib/server/workflowService");
    const issues = readiness(
      page.series,
      page.episode,
      await listImages(page.episode.id),
      await listLines(page.episode.id),
    );
    assert.ok(
      issues.some(
        (issue) => issue.lineId === id && issue.code === "render-review",
      ),
    );
    assert.ok(
      !issues.some(
        (issue) =>
          issue.lineId === id &&
          ["layout", "font", "glyphs", "overflow"].includes(issue.code),
      ),
    );
    assert.equal(
      requests.slice(start).filter((r) => r.purpose === "correct-text" && r.data.phase !== "critique").length,
      1,
      "Duplicate rendering must not trigger an extra translation repair",
    );
    undoDirector({ episodeId: page.episode.id, runId: result.runId });
    assert.notEqual(getDoc<any>(`region:${id}`, {}).data.renderEnabled, false);
    assert.equal(
      (await listLines(page.episode.id)).find((line) => line.id === id)!.body,
      "Hello",
    );
  } finally {
    respond = normal;
  }
});

for (const protection of [
  "locked",
  "human-reviewed",
  "different-source",
  "separate-utterance",
  "uncertain",
  "self-keeper",
] as const) {
  test(`duplicate rendering protects ${protection} regions`, async () => {
    const page = await seedChapter(`duplicate-protected-${protection}`, 40);
    const id = await populatedRenderingDuplicate(page);
    const doc = getDoc<any>(`region:${id}`, {});
    if (protection === "locked") {
      const { fitRegion } = await import("../src/lib/server/workflowService");
      await fitRegion(page.series, page.episode, id, doc.revision);
      const fitted = getDoc<any>(doc.id, {});
      putDoc(
        page.episode.id,
        doc.id,
        { ...fitted.data, locked: true },
        fitted.revision,
      );
    }
    if (protection === "human-reviewed")
      putDoc(
        page.episode.id,
        doc.id,
        {
          ...doc.data,
          renderEnabled: true,
          directorRenderingReview: {
            runId: "old",
            duplicateOf: page.lineId,
            evidence: "Earlier review",
            reviewed: true,
          },
        },
        doc.revision,
      );
    if (protection === "different-source")
      sqlite.prepare("UPDATE lines SET source='別の文' WHERE id=?").run(id);
    if (protection === "separate-utterance")
      sqlite.prepare("UPDATE lines SET x=.75,y=.75 WHERE id=?").run(id);
    const normal = respond;
    respond = (purpose, data) => {
      if (purpose === "check-page")
        return {
          findings: [
            {
              lineId: id,
              code: "duplicate-region",
              message: "Suspected duplicate",
              evidence: "Needs verification",
              repair: "render",
            },
          ],
        };
      if (purpose === "review-region-rendering")
        return {
          decisions: [
            {
              lineId: id,
              certain: protection !== "uncertain",
              duplicateOf:
                protection === "uncertain"
                  ? ""
                  : protection === "self-keeper"
                    ? id
                    : page.lineId,
              evidence: "Review result",
            },
          ],
        };
      return normal(purpose, data);
    };
    try {
      const result = await runPage(page);
      assert.equal(result.overview.pages[0].state, "unresolved");
      assert.notEqual(
        getDoc<any>(`region:${id}`, {}).data.renderEnabled,
        false,
      );
      assert.equal((await listLines(page.episode.id)).length, 2);
      assert.equal(
        (await listLines(page.episode.id)).find((line) => line.id === id)!.body,
        "Hello",
      );
    } finally {
      respond = normal;
    }
  });
}


for (const previouslyHidden of [false, true]) {
  test(`duplicate review can keep the smaller correct region (previously hidden: ${previouslyHidden})`, async () => {
    const page = await seedChapter(`duplicate-better-keeper-${previouslyHidden}`, 40);
    const smaller = await populatedRenderingDuplicate(page);
    if (previouslyHidden) {
      const doc = getDoc<any>(`region:${smaller}`, {});
      putDoc(page.episode.id, doc.id, {...doc.data, renderEnabled: false,
        directorRenderingReview: {runId: "old", duplicateOf: page.lineId,
          evidence: "Wrong previous choice", reviewed: false}}, doc.revision);
    }
    const normal = respond;
    let checks = 0;
    respond = (purpose, data) => {
      if (purpose === "check-page") {
        if (++checks === 1) return {findings: [{lineId: previouslyHidden ? page.lineId : smaller,
          code: previouslyHidden ? "placement" : "duplicate-region", repair: "render", message: "Wrong member cited",
          evidence: "Large box includes a chibi face; smaller box covers lettering"}]};
        return {findings: []};
      }
      if (purpose === "review-region-rendering") {
        assert.equal(data.candidates.length, 2);
        assert.ok(data.candidates.every((r: any) => r.box && r.polygon));
        return {decisions: [{lineId: page.lineId, duplicateOf: smaller,
          certain: true, evidence: "Keep tight lettering region; hide large decorated region"}]};
      }
      return normal(purpose, data);
    };
    try {
      const result = await runPage(page);
      assert.equal(result.overview.pages[0].state, "passed", result.overview.pages[0].detail);
      assert.equal(getDoc<any>(`region:${page.lineId}`, {}).data.renderEnabled, false);
      assert.notEqual(getDoc<any>(`region:${smaller}`, {}).data.renderEnabled, false);
      assert.equal((await listLines(page.episode.id)).length, 2);
      assert.equal((await listLines(page.episode.id)).find(l => l.id === smaller)!.body, "Hello");
    } finally { respond = normal; }
  });
}

for (const mode of ["raw", "critique"] as const) {
  test(`translation uses matching saved ${mode} proofreading and defers readable uncertainty`, async () => {
    const page = await seedChapter(`translation-guidance-${mode}`, 40);
    const { capturePageImages } = await import("../src/lib/server/pageImages");
    const capture = await capturePageImages(page.series, page.episode, page.imageId, false);
    const {storeAsset} = await import("../src/lib/server/workflowStore");
    const raw = await storeAsset(capture.raw);
    const job = createJob(page.episode.id, "page-proofread", {imageId: page.imageId, mode, ...selected});
    updateJob(job, "completed", {snapshot: {raw}, critique: "The top sound effect TAP is acceptable. Preserve it."});
    const normal = respond;
    let translations = 0, sourceReviews = 0;
    respond = (purpose, data) => {
      if (purpose === "correct-text") {
        translations++;
        if(mode==="raw") assert.match(data.priorProofread, /TAP is acceptable/);
        else assert.match(data.priorProofread, /こんにちは/);
        return {textComplete: false, sourceReviewLineIds: translations===1?[page.lineId]:[],
          reason: "Could be Tap or Tap tap; wording needs proofreading", edits: []};
      }
      if (purpose === "inspect-unreadable-regions") sourceReviews++;
      if (purpose === "check-page") assert.match(data.translationReview.reason, /Tap tap/);
      return normal(purpose, data);
    };
    try {
      const result = await runPage(page);
      assert.equal(result.overview.pages[0].state, "passed", result.overview.pages[0].detail);
      assert.equal(translations, mode==="raw"?4:3, "Retry correlation locally before any necessary region question");
      assert.equal(sourceReviews, 0);
      assert.equal(listJobs(page.episode.id).filter(j => j.kind === "page-proofread").length, 3,
        "Reuse initial guidance and request exactly one rendered-page proofread");
    } finally {respond = normal;}
  });
}

test("first translation requests raw proofreading once and uses it before rendered review", async () => {
  const page = await seedChapter("translation-first-raw-proofread", 40);
  sqlite.prepare("UPDATE lines SET body='' WHERE id=?").run(page.lineId);
  const normal = respond;
  let translated = false;
  respond = (purpose, data) => {
    if (purpose === "correct-text") {
      assert.ok(data.priorProofread && data.priorProofread !== "No matching saved proofreading");
      assert.equal(listJobs(page.episode.id).filter(j => j.kind === "page-proofread" && j.state === "completed" && j.payload.mode === "raw").length, 1);
      translated = true;
      return {textComplete: true, sourceReviewLineIds: [], reason: "Draft based on raw proofread",
        edits: [{lineId: page.lineId, source: null, english: "Hello", reason: "Translate the original"}]};
    }
    return normal(purpose, data);
  };
  try {
    const result = await runPage(page);
    assert.equal(result.overview.pages[0].state, "passed", result.overview.pages[0].detail);
    assert.equal(translated, true);
    assert.deepEqual(listJobs(page.episode.id).filter(j => j.kind === "page-proofread").map(j => j.payload.mode).sort(), ["critique", "raw"]);
  } finally { respond = normal; }
});
