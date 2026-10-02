/** Run only with scripts/test-browser.mjs: temporary data, no real models. */
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

const base = process.env.SCAN_TEST_BASEURL;
assert.ok(base, "Use the isolated browser fixture runner");
let executable = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executable) && !process.env.SCAN_TEST_CHROMIUM) {
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache/ms-playwright");
  if (existsSync(cache))
    executable =
      readdirSync(cache)
        .filter((name) => name.startsWith("chromium-"))
        .map((name) => join(cache, name, "chrome-linux/chrome"))
        .find(existsSync) || executable;
}

const browser = await chromium.launch({ executablePath: executable, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
await context.addCookies([
  { name: "scan_session", value: "fixture-local-session", domain: "127.0.0.1", path: "/" },
]);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  const anonymous = await browser.newContext();
  assert.equal(
    (
      await anonymous.request.post(`${base}/api/admin/image-model`, {
        data: { action: "start" },
      })
    ).status(),
    401,
  );
  await anonymous.close();

  const status = async () =>
    (await (await context.request.get(`${base}/api/admin/image-model`)).json());
  const { model, models } = await status();
  // 2511 and Lightning share one process and one port.
  assert.equal(model.port, 18092);
  assert.equal(models.length, 2);
  assert.equal(models[0].port, 18092);
  assert.equal(models[1].port, 18092);
  // A shared dev box may already run a real editor on these ports; the fixture cannot
  // bind them then, so the lifecycle cannot be exercised here.
  if (model.state === "error" && /occupied by/.test(model.error || "")) {
    console.log(`image-edit lifecycle skipped: ${model.error}`);
    await browser.close();
    process.exit(0);
  }
  assert.equal(model.state, "stopped");
  assert.equal(model.id, "qwen-image-edit-2511");
  assert.equal(model.label, "Qwen-Image-Edit 2511");
  assert.deepEqual(
    model.models.map((row) => [row.id, row.method, row.installed, row.active]),
    [
      ["qwen-image-edit-2511", "qwen-image-edit", false, false],
      ["qwen-image-edit-2511-lightning", "qwen-image-edit-lightning", false, false],
    ],
    "Both editors are offered, and the fixture data directory has no weights",
  );

  assert.equal(
    (
      await context.request.post(`${base}/api/admin/image-model`, {
        data: { action: "sideways" },
      })
    ).status(),
    400,
  );
  // Naming an unknown model is a rejected request, not a silent fall back to the default.
  assert.equal(
    (
      await context.request.post(`${base}/api/admin/image-model`, {
        data: { action: "start", model: "qwen-image-9" },
      })
    ).status(),
    409,
  );

  await page.goto(`${base}/admin/models/hardware`);
  const row2511 = page.getByRole("row", { name: /Qwen-Image-Edit 2511(?! Lightning)/ });
  const rowLightning = page.getByRole("row", { name: /Qwen-Image-Edit 2511 Lightning/ });
  await expect(row2511.getByText("Qwen-Image-Edit 2511", { exact: true })).toBeVisible();
  await expect(rowLightning.getByText("Qwen-Image-Edit 2511 Lightning", { exact: true })).toBeVisible();
  await expect(row2511).toContainText("18092");
  await expect(rowLightning).toContainText("18092");
  await expect(row2511).toContainText("stopped");
  await expect(rowLightning).toContainText("stopped");
  await expect(row2511.getByRole("button", { name: "Start", exact: true })).toBeDisabled();
  await expect(rowLightning.getByRole("button", { name: "Start", exact: true })).toBeDisabled();
  for (const [model, script] of [
    ["qwen-image-edit-2511", "install-image-edit-model\\.py"],
    ["qwen-image-edit-2511-lightning", "install-image-edit-model\\.py --lightning"],
  ]) {
    const refused = await context.request.post(`${base}/api/admin/image-model`, {
      data: { action: "start", model },
    });
    assert.equal(refused.status(), 400);
    assert.match((await refused.json()).error ?? "", new RegExp(script));
  }

  // Both cleaning methods are wired into the workflow even while nothing is installed.
  const workflow = `${base}/api/episodes/fixture-episode/workflow`;
  const backend = await (await context.request.get(`${workflow}?backend=1`)).json();
  assert.equal(backend.imageEdit?.["qwen-image-edit"]?.available, false, "The fixture has no image-editor weights");
  assert.equal(backend.imageEdit?.["qwen-image-edit-lightning"]?.available, false, "Nor the Lightning LoRA");
  assert.match(backend.imageEdit?.["qwen-image-edit"]?.reason ?? "", /Qwen-Image-Edit 2511 is not installed/);
  assert.match(backend.imageEdit?.["qwen-image-edit-lightning"]?.reason ?? "", /Qwen-Image-Edit 2511 Lightning is not installed/);
  assert.equal(backend.codex?.available, true, "Codex stays offered alongside the local editors");
  const doc = (await (await context.request.get(workflow)).json()).pages["fixture-page-0"];
  for (const method of ["qwen-image-edit", "qwen-image-edit-lightning"]) {
    const refused = await context.request.post(workflow, {
      data: {
        action: "clean",
        imageId: "fixture-page-0",
        expectedRevision: doc.revision,
        method,
      },
    });
    // The method is accepted: the fixture page has no prepared base, so every cleaner stops
    // at the same page-state guard instead of the request being rejected as unknown.
    const message = (await refused.json()).error;
    assert.equal(refused.status(), 400);
    assert.match(message ?? "", /Prepare this page/);
    assert.doesNotMatch(message ?? "", /Invalid method/);
  }

  await rowLightning.getByRole("button", { name: "Qwen-Image-Edit 2511 Lightning" }).click();
  const drawer = page.getByRole("dialog", { name: "Qwen Image Edit 2511 Lightning" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("Installing this also downloads 2511 when those weights are missing.")).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "Who can pick it" })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Install", exact: true })).toBeVisible();

  await page.goto(`${base}/admin/models/install`);
  await expect(page.getByText("Qwen-Image-Edit 2511 Lightning").first()).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Qwen-Image-Edit 2511 Lightning" })).toBeVisible();

  assert.deepEqual(errors, []);
  const { mkdir } = await import("node:fs/promises");
  await mkdir("/tmp/scan-acceptance", { recursive: true });
  await page.screenshot({ path: "/tmp/scan-acceptance/image-edit-server.png", fullPage: true });
  console.log("Per-editor service rows, API contract, and clean-method wiring checks passed");
} finally {
  await browser.close();
}
