/** Run only with scripts/test-browser.mjs: isolated app, no real GPU models. */
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
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    join(homedir(), ".cache/ms-playwright");
  if (existsSync(cache))
    executable =
      readdirSync(cache)
        .filter((name) => name.startsWith("chromium-"))
        .flatMap((name) => [
          join(cache, name, "chrome-linux64/chrome"),
          join(cache, name, "chrome-linux/chrome"),
        ])
        .find(existsSync) || executable;
}

const browser = await chromium.launch({
  executablePath: executable,
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
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
page.on("pageerror", (e) => errors.push(e.message));
try {
  const anonymous = await browser.newContext();
  assert.equal(
    (await anonymous.request.get(`${base}/api/admin/review-models`)).status(),
    401,
  );
  assert.equal(
    (
      await anonymous.request.post(`${base}/api/admin/review-models`, {
        data: { id: "paddleocr-vl-1.6", action: "start" },
      })
    ).status(),
    401,
  );
  await anonymous.close();

  const listed = await (
    await context.request.get(`${base}/api/admin/review-models`)
  ).json();
  assert.equal(listed.ok, true);
  // The panel lists the registry; assert the contract it must keep rather than a frozen
  // copy of the registry, which goes stale every time a local model is added or removed.
  const ids = listed.models.map((row) => row.id);
  for (const id of ["hayai-ocr-v2", "manga-ocr", "paddleocr-vl-1.6", "qwen3-vl-8b"])
    assert.ok(ids.includes(id), `${id} is missing from the local review models`);
  assert.ok(
    !ids.includes("qwen3-vl-4b"),
    "The uninstalled Qwen3-VL 4B is gone",
  );
  for (const row of listed.models) {
    assert.equal(typeof row.label, "string");
    assert.equal(typeof row.installed, "boolean");
  }
  assert.equal(
    listed.models.find((row) => row.id === "paddleocr-vl-1.6")?.installed,
    false,
  );

  // The old Admin → Setup page moved to Admin → Models; review server lifecycle
  // now lives in the Services table on Hardware & services.
  await page.goto(`${base}/admin/models/hardware`);
  await expect(page.getByRole("heading", { name: "Hardware & services" })).toBeVisible();
  await expect(page.getByRole("row", { name: /PaddleOCR-VL-1\.6/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /Hayai OCR v2/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /Qwen3-VL/ }).first()).toBeVisible();
  await expect(page.getByText("Qwen3-VL 4B", { exact: true })).toHaveCount(0);
  await expect(page.getByText("not installed").first()).toBeVisible();
  const paddleRow = page.getByRole("row", { name: /PaddleOCR-VL-1\.6/ });
  const start = paddleRow.getByRole("button", { name: "Start", exact: true });
  await expect(start).toBeDisabled();
  const started = await context.request.post(`${base}/api/admin/review-models`, {
    data: { id: "paddleocr-vl-1.6", action: "start" },
  });
  assert.equal(started.status(), 400);
  const body = await started.json();
  assert.match(body.error || "", /not installed/i);
  assert.deepEqual(errors, []);
  const { mkdir } = await import("node:fs/promises");
  await mkdir("/tmp/scan-acceptance", { recursive: true });
  await page.screenshot({
    path: "/tmp/scan-acceptance/review-servers.png",
    fullPage: true,
  });
  console.log("Review server status and lifecycle controls are on Admin → Models → Hardware & services");
} finally {
  await browser.close();
}
