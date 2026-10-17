/** Run in the isolated browser fixture server. Model responses are deterministic. */
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
const base = process.env.SCAN_TEST_BASEURL;
assert.ok(base);
let executable = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executable)) {
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    join(homedir(), ".cache/ms-playwright");
  executable =
    readdirSync(cache)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((name) => join(cache, name, "chrome-linux64/chrome"))
      .find((path) => existsSync(path)) || executable;
}
const browser = await chromium.launch({
  executablePath: executable,
  headless: true,
});
try {
  const context = await browser.newContext({
    viewport: { width: 1500, height: 1000 },
  });
  await context.addCookies([
    {
      name: "scan_session",
      value: "fixture-local-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const state = await (
    await context.request.get(`${base}/api/episodes/fixture-episode/workflow`)
  ).json();
  const images = state.images,
    line = state.lines.find((line) => line.imageId === images[0].id);
  const preparedResponse=await context.request.post(`${base}/api/episodes/fixture-episode/workflow`,{data:{action:'prepare',imageId:images[0].id}});
  assert.ok(preparedResponse.ok());
  const previewAsset=(await preparedResponse.json()).doc.data.prepared;
  assert.ok(previewAsset);
  const calls = [];
  let running = false,
    runState = "running",
    runId = "";
  let memory = {
    revision: 0,
    data: {
      episodeIds: [],
      imageIds: [],
      disabled: [],
      rules: {},
      policy: {
        fallbacks: [],
        cleanMethod: "auto",
        cleanFallbackModel: "",
        maskEngine: "auto",
        repairCycles: 3,
      },
    },
    imageChoices: [
      {
        id: "qwen-image-edit-2511-lightning",
        label: "Qwen-Image-Edit 2511 Lightning",
        tasks: ["cleaning"],
      },
      { id: "lama-manga", label: "LaMa Manga", tasks: ["inpaint"] },
    ],
    types: [{ id: "plain", label: "Dialogue", color: "#ffffff" }],
    examples: [],
    descriptions: [
      {
        id: "type:plain",
        typeId: "plain",
        description: "Round white balloon with a speaker tail.",
        conflicts: "Jagged outlines may indicate shouting.",
        exampleIds: ["previous-example"],
        stale: false,
      },
    ],
    eligibleExamples: 0,
    chapters: [{ id: "previous", title: "Previous chapter", status: "done" }],
    pages: [],
    provisionalTypes: [],
  };
  await page.route(
    "**/api/episodes/fixture-episode/director**",
    async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      let result;
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        calls.push(body);
        if (body.action === "memory") {
          memory = {
            ...memory,
            revision: memory.revision + 1,
            data: body.data,
          };
          result = { revision: memory.revision, data: memory.data };
        } else if (body.action === "preflight")
          result = {
            issues: [{ stage: "clean", message: "Choose a mask model" }],
          };
        else {
          if (body.action === "start" || body.action === "retry-blocked") {
            running = true;
            runId = "fixture-director";
            runState = "running";
          }
          if (body.action === "pause") runState = "paused";
          if (body.action === "resume") runState = "running";
          if (body.action === "stop") runState = "cancelled";
          result = { runId };
        }
      } else if (url.searchParams.has("memory")) result = memory;
      else {
        calls.push({ after: Number(url.searchParams.get("after") || 0) });
        result = {
          pages: images.map((image, index) => ({
            id: image.id,
            pageNumber: index + 1,
            clean: false,
            state: running
              ? index === 0
                ? "unresolved"
                : "passed"
              : "pending",
            stage: running ? "classify" : null,
            detail: running ? "Needs review" : "",
            runId: runId || null,
            findings:
              running && index === 0
                ? [
                    {
                      code: "region-type",
                      stage: "classify",
                      lineId: line.id,
                      severity: "blocker",
                      message: "Ambiguous thought balloon",
                    },
                  ]
                : [],
          })),
          runs: runId
            ? [
                {
                  id: runId,
                  scope: "chapter",
                  state: runState,
                  message: "Checking region types",
                  current_index: 1,
                  pageIds: images.map((x) => x.id),
                  model: { engine: "fixture", model: "fixture" },
                  created_at: Date.now(),
                },
              ]
            : [],
          locked: runId && runState === "running",
          models: [
            { id: "fixture", name: "Director fixture", model: "fixture" },
          ],
          changes: [],
          events:
            runId && Number(url.searchParams.get("after") || 0) < 1
              ? [
                  {
                    id: 1,
                    run_id: runId,
                    image_id: images[0].id,
                    kind: "type:changed",
                    created_at: Date.now(),
                    detail: {
                      lineId: line.id,
                      before: "plain",
                      after: "thought",
                      reason: "Cloud-shaped balloon",
                      referenceIds: ["previous-example"],
                      prompt: JSON.stringify({ instructions: Array.from({length:150}, (_,i)=>`Detailed instruction ${i}`) }),
                    },
                  },
                  {
                    id: 2,
                    run_id: runId,
                    image_id: images[0].id,
                    kind: "automation:fallback",
                    created_at: Date.now(),
                    detail: {
                      purpose: "correct-text",
                      from: { engine: "qwen3.8-27b-q4" },
                      to: { engine: "deepseek-flash" },
                      reason: "Qwen timed out after 180 seconds",
                    },
                  },
                  {
                    id: 3,
                    run_id: runId,
                    image_id: images[0].id,
                    kind: "automation:request",
                    created_at: Date.now(),
                    detail: {
                      purpose: "correct-text",
                      model: { engine: "deepseek-flash" },
                      candidate: 1,
                      input: {images:[{imageAsset:previewAsset}]},
                    },
                  },
                  {id:4,run_id:runId,image_id:images[1].id,kind:"stage",created_at:Date.now(),detail:{stage:"second-page-only",attempt:1}},
                  {id:5,run_id:runId,image_id:null,kind:"run",created_at:Date.now(),detail:{state:"completed",message:"Run-wide event"}},
                ]
              : [],
        };
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(result),
      });
    },
  );
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.waitForFunction(() => document.body.dataset.studioReady === "1");
  await page.locator('[data-find="director"]').click();
  const panel = page.getByRole("dialog", { name: "Director mode" });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByText("Checks passed does not mark a page Done."),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: /Run (page|chapter) Director/ }),
  ).toBeEnabled();
  await panel.getByRole("button", { name: "Check setup", exact: true }).click();
  await expect(panel.getByText("clean: Choose a mask model")).toBeVisible();
  await panel
    .getByRole("button", { name: "Director settings", exact: true })
    .click();
  const settings = page.locator('[data-find="settings-drawer"]');
  await expect(panel).toHaveCount(0);
  await expect(settings.locator('[data-find="set-director"]')).toHaveClass(/on/);
  await settings.getByLabel("Previous chapter · human-finished").check();
  await settings
    .getByText("Typing rules and learned descriptions", { exact: true })
    .click();
  await expect(
    settings.getByText(
      "Learned description: Round white balloon with a speaker tail.",
    ),
  ).toBeVisible();
  await expect(
    settings.getByText("Ambiguity: Jagged outlines may indicate shouting."),
  ).toBeVisible();
  await settings.getByText("Unattended run defaults", { exact: true }).click();
  await expect(
    settings.locator("details").filter({
      has: page.locator("summary", { hasText: "Unattended run defaults" }),
    }),
  ).toHaveAttribute("open", "");
  const cleaningFallback = settings.getByLabel("Cleaning fallback model", {
    exact: true,
  });
  await expect(cleaningFallback).toHaveValue("");
  await expect(
    cleaningFallback.locator('option[value="lama-manga"]'),
  ).toHaveCount(0);
  await cleaningFallback.selectOption("qwen-image-edit-2511-lightning");
  await settings.getByRole("button", { name: "Save memory settings" }).click();
  await expect(settings.getByText("Series memory settings saved.")).toBeVisible();
  assert.deepEqual(memory.data.episodeIds, ["previous"]);
  assert.equal(
    memory.data.policy.cleanFallbackModel,
    "qwen-image-edit-2511-lightning",
  );
  await expect(cleaningFallback).toHaveValue("qwen-image-edit-2511-lightning");
  await settings.getByRole("button", {name:"Close settings",exact:true}).click();
  await page.locator('[data-find="director"]').click();
  await panel
    .getByRole("button", { name: /Run (page|chapter) Director/ })
    .click();
  await expect(
    panel.getByRole("button", { name: /Ambiguous thought balloon/ }),
  ).toBeVisible();
  const items = panel.getByRole("region", {name:"Director log items",exact:true});
  const content = panel.getByRole("region", {name:"Director log content",exact:true});
  await expect(items.getByText(/plain → thought/)).toBeVisible();
  await expect(
    items.getByText(
      /fallback from qwen3.8-27b-q4 to deepseek-flash: Qwen timed out/,
    ),
  ).toBeVisible();
  await expect(
    items.getByText(/correct-text: requested deepseek-flash \(fallback\)/),
  ).toBeVisible();
  await expect.poll(() => calls.some((call) => call.after === 5)).toBe(true);
  await expect(items.getByRole("button")).toHaveCount(3);
  await expect(items.getByText(/Director finished|second-page-only/)).toHaveCount(0);
  await items.getByRole("button",{name:/correct-text: requested deepseek-flash/}).click();
  const thumbnail=content.getByRole('button',{name:'Expand Exact model input'});
  await expect(thumbnail).toBeVisible();
  await thumbnail.click();
  const imagePreview=page.getByRole('dialog',{name:'Director log image',exact:true});
  await expect(imagePreview).toBeVisible();
  const expanded=imagePreview.getByRole('img',{name:'Exact model input',exact:true});
  await expect.poll(()=>expanded.evaluate(el=>el.naturalWidth)).toBeGreaterThan(260);
  await expect(imagePreview.getByRole('link',{name:'Open image in new tab ↗'})).toHaveAttribute('href',new RegExp(previewAsset));
  await imagePreview.getByRole('button',{name:'Actual size',exact:true}).click();
  assert.ok(await expanded.evaluate(el=>Math.abs(el.getBoundingClientRect().width-el.naturalWidth)<1));
  await page.keyboard.press('Escape');
  await expect(imagePreview).toHaveCount(0);
  await expect(thumbnail).toBeFocused();
  await thumbnail.click();
  await page.getByRole('button',{name:'Close image preview',exact:true}).click();
  await expect(imagePreview).toHaveCount(0);
  await items.getByRole("button",{name:/plain → thought/}).click();
  await expect(content.getByText(/Detailed instruction 149/)).toBeVisible();
  const listBox=await items.boundingBox(),contentBox=await content.boundingBox();
  assert.ok(contentBox.x>=listBox.x+listBox.width-1,"Content should be to the right of log items");
  assert.ok(await content.evaluate(el=>el.scrollHeight>el.clientHeight),"Content should scroll independently");
  const pollCount=calls.filter(call=>call.after===5).length;
  await expect.poll(()=>calls.filter(call=>call.after===5).length).toBeGreaterThan(pollCount);
  await expect(content.getByText(/Detailed instruction 149/)).toBeVisible();
  await page.screenshot({path:"/tmp/komatose-director-modal-desktop.png"});
  await content.evaluate(el=>el.scrollTop=200);
  assert.equal(await items.evaluate(el=>el.scrollTop),0);
  await panel.getByRole("button",{name:"Page 2",exact:true}).click();
  await expect(panel).toBeVisible();
  await expect(items.getByRole("button")).toHaveCount(1);
  await expect(items.getByText(/second-page-only/)).toBeVisible();
  await expect(content.getByText(/Detailed instruction/)).toHaveCount(0);
  await expect(items.getByText(/plain → thought|Director finished/)).toHaveCount(0);
  await panel.getByRole("button",{name:"Page 1",exact:true}).click();
  await expect(items.getByRole("button")).toHaveCount(3);
  await panel.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Resume", exact: true }),
  ).toBeEnabled();
  await panel.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  await expect(items).toBeVisible();
  await expect(content).toBeVisible();
  const mobilePanel=await panel.boundingBox(),mobileContent=await content.boundingBox();
  assert.ok(mobileContent.x+mobileContent.width<=mobilePanel.x+mobilePanel.width+1);
  await panel.getByRole("button",{name:"Page 2",exact:true}).click();
  await expect(items.getByRole("button")).toHaveCount(1);
  await page.screenshot({path:"/tmp/komatose-director-modal-mobile.png"});
  await panel.getByRole("button",{name:"Page 1",exact:true}).click();
  await page.setViewportSize({width:1500,height:1000});
  await panel.getByRole("button", { name: "Stop", exact: true }).click();
  await panel
    .getByRole("button", { name: /Ambiguous thought balloon/ })
    .click();
  await expect(panel).toHaveCount(0);
  await expect(
    page
      .getByRole("navigation", { name: "Chapter workflow" })
      .getByRole("button", { name: "Typeset", exact: true }),
  ).toHaveClass(/active/);
  const rendering=page.getByRole("checkbox",{name:"Render English text",exact:true});
  await expect(rendering).toBeChecked();
  const overlaysBefore=await page.locator('.text-overlay').count();
  await rendering.uncheck();
  await expect(rendering).not.toBeChecked();
  await expect(page.getByText("Rendering is off. Source, English and layout are retained for review.",{exact:true})).toBeVisible();
  const updated=await (await context.request.get(`${base}/api/episodes/fixture-episode/workflow`)).json();
  assert.equal(updated.regions[line.id].data.renderEnabled,false);
  assert.equal(updated.lines.find(item=>item.id===line.id).body,line.body);
  if(state.regions[line.id]?.data.layout) await expect(page.locator('.text-overlay')).toHaveCount(overlaysBefore-1);
  // Seed provenance only in this isolated fixture, then exercise the normal confirmation API.
  const {default:Database}=await import('better-sqlite3');
  const fixtureDb=new Database(join(process.env.SCAN_TEST_DATA,'scan.db'));
  try {
    const row=fixtureDb.prepare('SELECT data,revision FROM workflow_docs WHERE id=?').get(`region:${line.id}`);
    const data=JSON.parse(row.data);
    data.directorRenderingReview={runId:'fixture-director',duplicateOf:'fixture-keeper',evidence:'Verified duplicate retained for review',reviewed:false};
    fixtureDb.prepare('UPDATE workflow_docs SET data=?,revision=revision+1,updated_at=? WHERE id=?').run(JSON.stringify(data),Date.now(),`region:${line.id}`);
    const reviewState=await (await context.request.get(`${base}/api/episodes/fixture-episode/workflow`)).json();
    assert.ok(reviewState.issues.some(issue=>issue.lineId===line.id&&issue.code==='render-review'));
    const confirmed=await context.request.post(`${base}/api/episodes/fixture-episode/workflow`,{data:{action:'region',id:line.id,expectedRevision:row.revision+1,data:{renderReviewConfirmed:true}}});
    assert.equal(confirmed.status(),200,await confirmed.text());
    assert.equal((await confirmed.json()).doc.data.directorRenderingReview.reviewed,true);
  } finally {fixtureDb.close();}
  // Restoring visibility keeps the saved source/English and layout.
  const restoredState=await (await context.request.get(`${base}/api/episodes/fixture-episode/workflow`)).json();
  const restored=await context.request.post(`${base}/api/episodes/fixture-episode/workflow`,{data:{action:'region',id:line.id,expectedRevision:restoredState.regions[line.id].revision,data:{renderEnabled:true}}});
  assert.equal(restored.status(),200,await restored.text());
  const restoredDoc=(await restored.json()).doc;
  assert.equal(restoredDoc.data.renderEnabled,true);
  const afterRestore=await (await context.request.get(`${base}/api/episodes/fixture-episode/workflow`)).json();
  assert.ok(!afterRestore.issues.some(issue=>issue.lineId===line.id&&issue.code==='render-review'));
  const locked=await context.request.post(`${base}/api/episodes/fixture-episode/workflow`,{data:{action:'region',id:line.id,expectedRevision:restoredDoc.revision,data:{locked:true}}});
  const lockedDoc=(await locked.json()).doc;
  const denied=await context.request.post(`${base}/api/episodes/fixture-episode/workflow`,{data:{action:'region',id:line.id,expectedRevision:lockedDoc.revision,data:{renderEnabled:false}}});
  assert.equal(denied.status(),400);
  assert.match(await denied.text(),/Unlock this layout/);
  const unlocked=await context.request.post(`${base}/api/episodes/fixture-episode/workflow`,{data:{action:'region',id:line.id,expectedRevision:lockedDoc.revision,data:{locked:false}}});
  assert.equal(unlocked.status(),200);
  assert.deepEqual(errors, []);
  console.log("Director browser acceptance passed");
} finally {
  await browser.close();
}
