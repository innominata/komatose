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
  // Each editor is its own service: one record each, on its own port.
  assert.equal(model.port, 18091);
  assert.equal(models.length, 2);
  assert.equal(models[0].port, 18091);
  assert.equal(models[1].port, 18092);
  // A shared dev box may already run a real editor on these ports; the fixture cannot
  // bind them then, so the lifecycle cannot be exercised here.
  if (model.state === "error" && /occupied by/.test(model.error || "")) {
    console.log(`image-edit lifecycle skipped: ${model.error}`);
    await browser.close();
    process.exit(0);
  }
  assert.equal(model.state, "stopped");
  assert.equal(model.id, "qwen-image-2.1");
  assert.equal(model.label, "Qwen-Image 2.1");
  assert.deepEqual(
    model.models.map((row) => [row.id, row.method, row.installed, row.active]),
    [
      ["qwen-image-2.1", "qwen-image", false, false],
      ["qwen-image-edit-2511", "qwen-image-edit", false, false],
    ],
    "Both editors are offered, and the fixture data directory has no weights for either",
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
  const panel = page.locator("table").first();
  const row21 = page.getByRole("row", { name: /Qwen-Image 2\.1/ });
  const row2511 = page.getByRole("row", { name: /Qwen-Image-Edit 2511/ });
  await expect(row21.getByText("Qwen-Image 2.1", { exact: true })).toBeVisible();
  await expect(row2511.getByText("Qwen-Image-Edit 2511", { exact: true })).toBeVisible();
  await expect(row21).toContainText("18091");
  await expect(row2511).toContainText("18092");
  await expect(row21).toContainText("stopped");
  await expect(row2511).toContainText("stopped");
  // Neither editor can start until its own installer has run.
  await expect(row21.getByRole("button", { name: "Start" })).toBeDisabled();
  await expect(row2511.getByRole("button", { name: "Start" })).toBeDisabled();
  // A start without weights is refused with the installer's command in the message.
  for (const [model, script] of [["qwen-image-2.1", "install-image-model"], ["qwen-image-edit-2511", "install-image-edit-model"]]) {
    const refused = await context.request.post(`${base}/api/admin/image-model`, {
      data: { action: "start", model },
    });
    assert.equal(refused.status(), 400);
    assert.match((await refused.json()).error ?? "", new RegExp(`${script}\\.py`));
  }

  // Both cleaning methods are wired into the workflow even while nothing is installed.
  const workflow = `${base}/api/episodes/fixture-episode/workflow`;
  const backend = await (await context.request.get(`${workflow}?backend=1`)).json();
  assert.equal(backend.imageEdit?.["qwen-image"]?.available, false, "The fixture has no image-editor weights");
  assert.equal(backend.imageEdit?.["qwen-image-edit"]?.available, false, "Nor weights for the second editor");
  assert.match(backend.imageEdit?.["qwen-image"]?.reason ?? "", /Qwen-Image 2\.1 is not installed/);
  assert.match(backend.imageEdit?.["qwen-image-edit"]?.reason ?? "", /Qwen-Image-Edit 2511 is not installed/);
  assert.equal(backend.codex?.available, true, "Codex stays offered alongside the local editors");
  const doc = (await (await context.request.get(workflow)).json()).pages["fixture-page-0"];
  for (const method of ["qwen-image", "qwen-image-edit"]) {
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

  assert.deepEqual(errors, []);
  const { mkdir } = await import("node:fs/promises");
  await mkdir("/tmp/scan-acceptance", { recursive: true });
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/scan-acceptance/image-edit-server.png", fullPage: true });
  console.log("Per-editor service rows, API contract, and clean-method wiring checks passed");
} finally {
  await browser.close();
}
