/** Run only with scripts/test-browser.mjs: fake executable, temporary data, no real models. */
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
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
        .map((name) => join(cache, name, "chrome-linux/chrome"))
        .find(existsSync) || executable;
}
const root = await mkdtemp(join(tmpdir(), "scan-managed-browser-"));
const fake = join(root, "fake-llama.mjs");
const weights = join(root, "weights.gguf");
await writeFile(weights, "fixture");
await writeFile(
  fake,
  `#!${process.execPath}\nimport {createServer} from 'node:http';const args=process.argv.slice(2);const flag=n=>args[args.indexOf(n)+1];createServer((req,res)=>res.end(JSON.stringify({data:[{id:flag('-a')}]}))).listen(Number(flag('--port')),'127.0.0.1');`,
  { mode: 0o755 },
);
const socket = createServer();
await new Promise((r) => socket.listen(0, "127.0.0.1", r));
const port = socket.address().port;
await new Promise((r) => socket.close(r));
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
let id = "";
try {
  const anonymous = await browser.newContext();
  assert.equal(
    (
      await anonymous.request.post(`${base}/api/admin/managed-models`, {
        data: { id: "unknown", action: "stop" },
      })
    ).status(),
    401,
  );
  await anonymous.close();
  await page.goto(`${base}/admin/models/list`);
  // Vite dev fully reloads once while optimizing dependencies; wait until the
  // document stays alive before interacting, or clicks land on a dead DOM.
  let stable = false;
  for (let i = 0; i < 12 && !stable; i++) {
    await page.evaluate(() => (window.__stamp = Date.now()));
    await page.waitForTimeout(400);
    stable = Boolean(await page.evaluate(() => window.__stamp));
  }
  assert.ok(stable, "models page kept reloading and never settled");
  // Add model → Local model server → generic GGUF preset. The new row opens in
  // the model drawer, where the launch editor lives.
  // Buttons with icons carry a leading glyph in their accessible name, so icon
  // labels match as substrings rather than exact strings.
  await page.getByRole("button", { name: /add model/i }).click();
  const dialog = page.getByRole("dialog", { name: /^add model$/i });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /^local model$/i }).click();
  await dialog.getByRole("radio", { name: /Other llama\.cpp model/ }).click();
  await dialog.getByLabel(/^name$/i).fill("Browser local fixture");
  await dialog
    .getByLabel(/^model id$/i)
    .fill("browser-managed-fixture");
  // A launch recipe needs weights: the dialog stays blocked until the .gguf
  // path is given, then attaches the generic preset to the new row.
  await expect(dialog.getByRole("button", { name: /^add model$/i })).toBeDisabled();
  await dialog
    .getByLabel(/^weights/i)
    .fill("~/models/browser-managed-fixture.gguf");
  await expect(dialog.getByRole("button", { name: /^add model$/i })).toBeEnabled();
  await dialog.getByRole("button", { name: /^add model$/i }).click();
  await expect(dialog).toBeHidden();

  id = "browser-managed-fixture";
  const row = page.getByRole("row").filter({ hasText: "Browser local fixture" });
  await expect(row).toBeVisible();
  await row.click();
  const drawer = page.getByRole("dialog", { name: "Browser local fixture" });
  await expect(drawer).toBeVisible();
  const panel = drawer.getByRole("region", { name: "Local model editor" });
  await expect(panel).toBeVisible();

  await panel
    .getByRole("button", { name: /^generic llama\.cpp preset$/i })
    .click();
  // Presets carry home-relative paths: the executable input shows `~/…`, never
  // the machine's home directory. The generic preset ships an intentionally
  // empty weights path — the operator fills in their GGUF, which this flow does
  // right below; the unit suite covers `~` weight paths.
  await expect(panel.getByLabel("Model executable", { exact: true })).toHaveValue(/^~\//);
  await expect(panel.getByLabel("Model weights", { exact: true })).toHaveValue("");
  await panel.getByLabel("Model executable", { exact: true }).fill(fake);
  await panel
    .getByLabel("Model weights", { exact: true })
    .fill("/missing/fixture.gguf");
  await panel.getByLabel("Model port", { exact: true }).fill(String(port));
  await panel
    .getByRole("button", { name: /^save launch settings$/i })
    .click();
  await panel.getByRole("button", { name: /^start model$/i }).click();
  await expect(panel.getByText(/Missing weights:/)).toBeVisible({
    timeout: 15000,
  });
  await panel.getByLabel("Model weights", { exact: true }).fill(weights);
  await panel
    .getByRole("button", { name: /^save launch settings$/i })
    .click();
  await panel.getByRole("button", { name: /^start model$/i }).click();
  const state = async () => {
    const data = await (
      await context.request.get(`${base}/api/admin/managed-models`)
    ).json();
    return data.models.find((m) => m.id === id);
  };
  await expect
    .poll(async () => (await state()).state, { timeout: 15000 })
    .toBe("running");
  const pid = (await state()).pid;
  await panel.getByLabel("Model context size", { exact: true }).fill("16384");
  await panel
    .getByRole("button", { name: /^save launch settings$/i })
    .click();
  await expect(
    panel.getByText(/Saved changes pending Restart/i),
  ).toBeVisible();
  assert.equal((await state()).pid, pid);
  await panel
    .getByRole("button", { name: /^restart model$/i })
    .click();
  await expect
    .poll(async () => (await state()).state, { timeout: 15000 })
    .toBe("running");
  assert.notEqual((await state()).pid, pid);
  await expect.poll(async () => (await state()).pendingChanges).toBe(false);
  await mkdir("/tmp/scan-acceptance", { recursive: true });
  await page.screenshot({
    path: "/tmp/scan-acceptance/managed-models.png",
    fullPage: true,
  });
  await panel.getByRole("button", { name: /^stop model$/i }).click();
  await expect
    .poll(async () => (await state()).state, { timeout: 15000 })
    .toBe("stopped");
  await page.reload();
  // Cards start collapsed after a reload: the drawer re-reads the saved recipe.
  stable = false;
  for (let i = 0; i < 12 && !stable; i++) {
    await page.evaluate(() => (window.__stamp = Date.now()));
    await page.waitForTimeout(400);
    stable = Boolean(await page.evaluate(() => window.__stamp));
  }
  assert.ok(stable, "models page kept reloading and never settled");
  const rowAfterReload = page
    .getByRole("row")
    .filter({ hasText: "Browser local fixture" });
  await expect(rowAfterReload).toBeVisible();
  await rowAfterReload.click();
  const drawerAfterReload = page.getByRole("dialog", {
    name: "Browser local fixture",
  });
  await expect(
    drawerAfterReload.getByLabel("Model weights", { exact: true }),
  ).toHaveValue(weights);
  await expect(
    drawerAfterReload.getByLabel("Model context size", { exact: true }),
  ).toHaveValue("16384");
  assert.deepEqual(errors, []);
  console.log("Managed model editor and lifecycle browser checks passed");
} finally {
  if (id) {
    await context.request.post(`${base}/api/admin/managed-models`, {
      data: { id, action: "stop" },
    });
    for (let i = 0; i < 30; i++) {
      const data = await (
        await context.request.get(`${base}/api/admin/managed-models`)
      ).json();
      if (data.models.find((m) => m.id === id)?.state === "stopped") break;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  await browser.close();
  await rm(root, { recursive: true, force: true });
}
