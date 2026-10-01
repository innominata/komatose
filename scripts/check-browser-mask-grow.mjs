import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import sharp from "sharp";

/** Click position of the painted mask island, in page-normalized coordinates. */
const CLICK = { x: 0.78, y: 0.16 };
const GROW_PX = 12;

const base = process.env.SCAN_TEST_BASEURL || "http://127.0.0.1:5188";
let executable = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executable) && !process.env.SCAN_TEST_CHROMIUM) {
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    join(homedir(), ".cache/ms-playwright");
  if (existsSync(cache)) {
    const candidates = readdirSync(cache)
      .filter((n) => /^chromium-\d+$/.test(n))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((n) => join(cache, n, "chrome-linux64/chrome"));
    executable = candidates.find((p) => existsSync(p)) || executable;
  }
}

const browser = await chromium.launch({
  executablePath: executable,
  headless: true,
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
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => {
  errors.push(e.message);
  console.error("PAGE ERROR", e.message);
});

const workflowUrl = `${base}/api/episodes/fixture-episode/workflow`;
const operation = async (data) => {
  const r = await context.request.post(workflowUrl, { data });
  if (!r.ok()) throw new Error(await r.text());
  return r.json();
};
const state = async () => (await context.request.get(workflowUrl)).json();

/** White-pixel half-extents of the mask island around the clicked pixel. */
async function maskExtent(artifact) {
  const r = await context.request.get(
    `${workflowUrl}/assets/${artifact}`,
  );
  if (!r.ok()) throw new Error(`mask asset ${artifact}: ${r.status()}`);
  const { data, info } = await sharp(await r.body())
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cx = Math.round(CLICK.x * info.width);
  const cy = Math.round(CLICK.y * info.height);
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (let y = Math.max(0, cy - 60); y <= Math.min(info.height - 1, cy + 60); y++)
    for (let x = Math.max(0, cx - 60); x <= Math.min(info.width - 1, cx + 60); x++)
      if (data[y * info.width + x] > 127) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
  if (maxX < minX) return null;
  return {
    left: cx - minX,
    right: maxX - cx,
    top: cy - minY,
    bottom: maxY - cy,
  };
}

async function changedPages(before, after) {
  return Object.keys(after.pages).filter(
    (id) => after.pages[id].revision !== before.pages[id]?.revision,
  );
}

async function clearToasts() {
  const dismiss = page.locator(".toasts button");
  for (let i = 0; i < 10 && (await dismiss.count()); i++)
    await dismiss.first().click();
}

try {
  // A saved mask island to click on, on whichever fixture page the sidebar opens.
  for (const imageId of ["fixture-page-0", "fixture-page-1"]) {
    const { doc } = await operation({ action: "prepare", imageId });
    const mask = await operation({
      action: "mask",
      imageId,
      expectedRevision: doc.revision,
      strokes: [{ points: [{ x: CLICK.x, y: CLICK.y }], radius: 8 }],
    });
    for (let i = 0; i < 240; i++) {
      const job = (await state()).jobs.find((j) => j.id === mask.jobId);
      if (job?.state === "completed") break;
      if (job?.state === "failed") throw new Error(`mask job failed: ${job.error ?? ""}`);
      if (i === 239) throw new Error("mask job did not finish");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.getByRole("navigation", { name: "Chapter workflow" }).waitFor();
  await page.locator(".pages > button").first().click();
  await page
    .getByRole("navigation", { name: "Chapter workflow" })
    .getByRole("button", { name: "Clean", exact: true })
    .click();
  const palette = page.getByRole("toolbar", { name: "Tools" });
  const growInput = page.getByLabel("Grow mask by (px)");

  // Picking the tool shows the temporary amount toolbar, like the brush size one.
  await palette.getByRole("button", { name: "Grow mask (G)", exact: true }).click();
  await growInput.waitFor({ state: "visible", timeout: 5000 });
  const defaultAmount = await growInput.inputValue();
  if (defaultAmount !== "10")
    throw new Error(`grow amount should default to 10px, got ${defaultAmount}`);

  // The toolbar is temporary: leaving the tool hides it, picking it again brings it back.
  await palette.getByRole("button", { name: "Select (V)", exact: true }).click();
  await growInput.waitFor({ state: "hidden", timeout: 5000 });
  await palette.getByRole("button", { name: "Grow mask (G)", exact: true }).click();
  await growInput.waitFor({ state: "visible", timeout: 5000 });

  await growInput.fill(String(GROW_PX));
  if ((await growInput.inputValue()) !== String(GROW_PX))
    throw new Error("grow amount input did not accept the new value");

  const svg = page.locator(".canvas-page svg");
  const box = await svg.boundingBox();
  if (!box) throw new Error("canvas svg has no box");
  const cx = box.x + box.width * CLICK.x;
  const cy = box.y + box.height * CLICK.y;

  await clearToasts();
  const clip = {
    x: Math.max(0, cx - 150),
    y: Math.max(0, cy - 150),
    width: 300,
    height: 300,
  };
  const beforeShot = await page.screenshot({ clip });
  const before = await state();

  await page.mouse.click(cx, cy);

  let after = before;
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    after = await state();
    if ((await changedPages(before, after)).length) break;
  }
  const changed = await changedPages(before, after);
  if (!changed.length) {
    const text = await page.locator("body").innerText();
    console.log("UI text after click:\n" + text.slice(0, 1500));
    throw new Error("grow click did not change any page doc");
  }
  const id = changed[0];
  const beforeMask = before.pages[id].data.mask;
  const afterMask = after.pages[id].data.mask;
  if (beforeMask === afterMask) throw new Error("grow click did not replace the mask");

  // The served mask must be wider than before by exactly the amount from the toolbar.
  const extentBefore = await maskExtent(beforeMask);
  const extentAfter = await maskExtent(afterMask);
  console.log("mask extent before:", extentBefore, "after:", extentAfter);
  if (!extentBefore || !extentAfter) throw new Error("clicked mask island not found");
  for (const side of ["left", "right", "top", "bottom"]) {
    const grew = extentAfter[side] - extentBefore[side];
    if (Math.abs(grew - GROW_PX) > 2)
      throw new Error(`mask grew ${grew}px on the ${side}, expected ${GROW_PX}px`);
  }

  const toast = await page.locator(".toasts").innerText().catch(() => "");
  if (!toast.includes(`Grew that mask region by ${GROW_PX}px`))
    throw new Error(`grow notice missing the amount: ${JSON.stringify(toast)}`);

  // The canvas must repaint the grown mask; a silent doc change reads as broken.
  await clearToasts();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const afterShot = await page.screenshot({ clip });
  await mkdir("/tmp/scan-acceptance", { recursive: true }).catch(() => {});
  await writeFile("/tmp/scan-acceptance/mask-grow-before.png", beforeShot).catch(() => {});
  await writeFile("/tmp/scan-acceptance/mask-grow-after.png", afterShot).catch(() => {});
  const rawA = await sharp(beforeShot).raw().toBuffer({ resolveWithObject: true });
  const rawB = await sharp(afterShot).raw().toBuffer({ resolveWithObject: true });
  const stride = rawA.info.channels;
  let differing = 0;
  for (let i = 0; i < rawA.data.length; i += stride)
    for (let c = 0; c < stride; c++)
      if (rawA.data[i + c] !== rawB.data[i + c]) {
        differing++;
        break;
      }
  console.log("pixels changed on screen after grow:", differing);
  if (differing < 50) throw new Error("the mask overlay did not repaint after growing");

  // Clicking off the island explains itself instead of failing silently.
  const off = await state();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const shown = (await page.locator(".toasts").innerText().catch(() => "")) || "(no toasts)";
  if (!shown.includes("Click a painted mask region to grow it"))
    throw new Error(`expected a click-hint toast, saw ${JSON.stringify(shown)}`);
  const unchanged = await changedPages(off, await state());
  if (unchanged.length) throw new Error("an off-mask click still changed the mask");

  if (errors.length) throw new Error(errors.join("\n"));
  console.log("mask grow checks passed");
} finally {
  await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
  await browser.close();
}
