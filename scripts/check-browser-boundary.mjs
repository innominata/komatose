/** Real, isolated boundary operation; synthetic artwork only and no model calls. */
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import sharp from "sharp";
const base = process.env.SCAN_TEST_BASEURL,
  root = process.env.SCAN_TEST_DATA;
assert.ok(base && root, "Run with scripts/test-browser.mjs");
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.SCAN_TEST_CHROMIUM ||
    (existsSync("/usr/bin/chromium")
      ? "/usr/bin/chromium"
      : chromium.executablePath()),
});
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
const page = await context.newPage(),
  api = `${base}/api/episodes/fixture-episode`,
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const modelRequests = [];
page.on("request", (r) => {
  if (r.method() === "POST" && r.url().endsWith("/workflow")) {
    const b = r.postDataJSON();
    if (String(b.action).includes("proofread")) modelRequests.push(b);
  }
});
const state = async () => {
  const r = await context.request.get(`${api}/workflow`);
  assert.ok(r.ok(), await r.text());
  return r.json();
};
const asset = async (bytes) => {
  const hash = createHash("sha256").update(bytes).digest("hex");
  await mkdir(join(root, "workflow/assets"), { recursive: true });
  await writeFile(join(root, "workflow/assets", hash), bytes);
  return hash;
};
let db;
try {
  for (let i = 0; i < 2; i++) {
    const text = i ? "SECOND HALF" : "FIRST HALF",
      y = i ? 50 : 960;
    const bytes = await sharp(
      Buffer.from(
        `<svg width="800" height="1000"><rect width="800" height="1000" fill="white"/><rect x="30" y="100" width="740" height="760" fill="${i ? "#cce0ee" : "#dde9c8"}"/><text x="90" y="${y}" font-family="sans-serif" font-size="32">${text}</text></svg>`,
      ),
    )
      .png()
      .toBuffer();
    const r = await context.request.post(`${api}/images`, {
      multipart: {
        files: {
          name: `boundary-${i}.png`,
          mimeType: "image/png",
          buffer: bytes,
        },
      },
    });
    assert.ok(r.ok(), await r.text());
  }
  let before = await state();
  const selected = before.images.filter((i) =>
    /^boundary-[01]\.png$/.test(i.originalName),
  );
  assert.equal(selected.length, 2);
  const [a, b] = selected;
  for (const image of selected) {
    const response = await context.request.post(`${api}/workflow`, {
      data: { action: "prepare", imageId: image.id },
    });
    assert.ok(response.ok(), await response.text());
  }
  db = new Database(join(root, "scan.db"));
  const baseline = {};
  for (const [i, image] of selected.entries()) {
    const row = db
        .prepare("SELECT * FROM workflow_docs WHERE id=?")
        .get(`page:${image.id}`),
      data = JSON.parse(row.data);
    const cleaned = await asset(
      await sharp({
        create: {
          width: image.width,
          height: image.height,
          channels: 3,
          background: i ? "#a6d8e0" : "#c4e5b7",
        },
      })
        .png()
        .toBuffer(),
    );
    baseline[image.id] = { cleaned, raw: data.prepared };
    const undo = [...JSON.parse(row.undo), data];
    db.prepare(
      "UPDATE workflow_docs SET data=?,undo=?,revision=revision+1,updated_at=? WHERE id=?",
    ).run(
      JSON.stringify({
        ...data,
        cleaned,
        cleanBase: cleaned,
        cleanApproved: true,
        completed: { clean: "done", review: "done" },
      }),
      JSON.stringify(undo),
      Date.now(),
      row.id,
    );
    const lineId = `boundary-r${i}`,
      y = i ? 0.02 : 0.94;
    db.prepare(
      `INSERT INTO lines(id,episode_id,image_id,body,line_type,status,placed,x,y,w,h,sort_order,updated_at,source,source_state) VALUES(?,'fixture-episode',?,?,'plain','approved',1,.1,?,.5,.05,0,?,?,'read')`,
    ).run(
      lineId,
      image.id,
      i ? "Second half" : "First half",
      y,
      Date.now(),
      i ? "後半" : "前半",
    );
    const polygon = [
      { x: 0.1, y },
      { x: 0.6, y },
      { x: 0.6, y: y + 0.05 },
      { x: 0.1, y: y + 0.05 },
    ];
    db.prepare(
      `INSERT INTO workflow_docs(id,episode_id,revision,data,undo,redo,updated_at) VALUES(?,'fixture-episode',1,?,'[]','[]',?)`,
    ).run(
      `region:${lineId}`,
      JSON.stringify({ polygon, geometryApproved: true, locked: true }),
      Date.now(),
    );
  }
  db.prepare(
    `INSERT INTO workflow_jobs(id,episode_id,kind,state,payload,progress,created_at,updated_at) VALUES('boundary-proof','fixture-episode','page-proofread','completed',?,?,?,?)`,
  ).run(
    JSON.stringify({ imageId: a.id, mode: "raw" }),
    JSON.stringify({
      critique: "Synthetic saved reading.",
      snapshot: {
        raw: baseline[a.id].raw,
        imageId: a.id,
        pageLabel: "Original page",
        capturedAt: Date.now(),
      },
    }),
    Date.now(),
    Date.now(),
  );
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.waitForFunction(() => document.body.dataset.studioReady === "1");
  before = await state();
  const index = before.images.findIndex((i) => i.id === a.id);
  await page
    .locator("aside.pages")
    .getByRole("button", { name: `Open page ${index + 1}`, exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Chapter workflow" })
    .getByRole("button", { name: "Typeset", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Move page boundary", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Move page boundary",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  const cut = Math.round(a.height * 0.8),
    input = dialog.getByRole("spinbutton", {
      name: "Boundary position in pixels",
    });
  await input.fill(String(cut));
  await input.press("Tab");
  const apply = dialog.getByRole("button", {
    name: `Move ${a.height - cut}px to next page`,
    exact: true,
  });
  await expect(apply).toBeEnabled({ timeout: 30000 });
  await page.screenshot({ path: "/tmp/komatose-boundary-preview.png" });
  await apply.click();
  await expect(dialog).toHaveCount(0, { timeout: 30000 });
  const after = await state(),
    aa = after.images.find((i) => i.id === a.id),
    bb = after.images.find((i) => i.id === b.id);
  assert.equal(aa.height, cut);
  assert.equal(bb.height, a.height - cut + b.height);
  assert.equal(after.lines.find((l) => l.id === "boundary-r0").imageId, b.id);
  assert.equal(after.lines.find((l) => l.id === "boundary-r0").source, "前半");
  assert.equal(
    after.lines.find((l) => l.id === "boundary-r1").body,
    "Second half",
  );
  const da = JSON.parse(
    db.prepare("SELECT data FROM workflow_docs WHERE id=?").get(`page:${a.id}`)
      .data,
  );
  const dbb = JSON.parse(
    db.prepare("SELECT data FROM workflow_docs WHERE id=?").get(`page:${b.id}`)
      .data,
  );
  assert.equal(da.completed, undefined);
  assert.equal(dbb.completed, undefined);
  assert.ok(da.cleaned && dbb.cleaned);
  const review = after.jobs.find((j) => j.id === "boundary-proof");
  assert.equal(review.progress.pageGeometry.stale, true);
  assert.ok(review.progress.pageGeometry.imageIds.includes(b.id));
  assert.equal(modelRequests.length, 0);
  await expect(
    page
      .getByRole("navigation", { name: "Chapter workflow" })
      .getByRole("button", { name: "Typeset", exact: true }),
  ).toHaveClass(/active/);
  // The same tool remains usable on a narrow screen and on the enlarged neighbor.
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Move page boundary", exact: true })
    .click();
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /Move \d+px to (previous|next) page/ }),
  ).toBeEnabled({ timeout: 30000 });
  const viewport = await dialog.evaluate((el) => ({
    width: el.getBoundingClientRect().width,
    scroll: el.scrollWidth,
    client: el.clientWidth,
  }));
  assert.ok(viewport.width <= 390);
  assert.ok(viewport.scroll <= viewport.client + 1);
  await page.screenshot({ path: "/tmp/komatose-boundary-mobile.png" });
  await dialog.getByRole("button", { name: "Close boundary tool" }).click();
  assert.deepEqual(errors, []);
  console.log("Boundary browser acceptance passed");
} finally {
  db?.close();
  await browser.close();
}
