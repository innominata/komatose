/** Run with: node scripts/test-browser.mjs scripts/check-browser-setup.mjs */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

const base = process.env.SCAN_TEST_BASEURL;
assert.ok(base, "Run through the isolated browser fixture runner");
let executable = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executable) && !process.env.SCAN_TEST_CHROMIUM) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache/ms-playwright");
  if (existsSync(cache))
    executable = readdirSync(cache)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((name) => join(cache, name, "chrome-linux64/chrome"))
      .find((path) => existsSync(path)) || executable;
}
mkdirSync("/tmp/scan-acceptance", { recursive: true });

/** Screenshots are evidence, not the contract — retry a transient capture error once. */
const shot = async (page, path) => {
  try {
    await page.screenshot({ path });
  } catch {
    await page.waitForTimeout(300);
    await page.screenshot({ path });
  }
};

const browser = await chromium.launch({ executablePath: executable, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1200 } });
  await context.addCookies([{
    name: "scan_session", value: "fixture-local-session", domain: "127.0.0.1", path: "/",
  }]);

  // Install API contract first: every catalog target reports a status and a
  // whitelisted `scripts/…` command; unknown actions are rejected.
  const api = await (await context.request.get(`${base}/api/admin/setup-install`)).json();
  assert.equal(api.ok, true);
  assert.ok(api.targets.length >= 15, `expected the full install catalog, got ${api.targets.length}`);
  for (const target of api.targets) {
    assert.equal(typeof target.installed, "boolean", target.id);
    assert.match(target.command, /scripts\/[\w.-]+\.(py|sh)/, target.id);
    assert.ok(target.blocked === undefined || typeof target.blocked === "boolean", target.id);
  }
  const unknown = await context.request.post(`${base}/api/admin/setup-install`, {
    data: { action: "explode", id: "rtdetr" },
  });
  assert.equal(unknown.status(), 400);

  const page = await context.newPage();
  const pageAlerts = page.locator(".setup-alert");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/admin/models`);

  // Vite dev fully reloads once while optimizing dependencies; wait until the
  // document stays alive before interacting, or clicks land on a dead DOM.
  let stable = false;
  for (let i = 0; i < 12 && !stable; i++) {
    await page.evaluate(() => (window.__stamp = Date.now()));
    await page.waitForTimeout(400);
    stable = Boolean(await page.evaluate(() => window.__stamp));
  }
  assert.ok(stable, "admin models page kept reloading and never settled");

  // ------------------------------------------------------------- overview
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  assert.ok(
    await page.locator(".task-card").count() >= 1,
    "the job pipeline should list task cards",
  );
  await expect(page.getByRole("heading", { name: "Needs attention" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Running now" })).toBeVisible();
  const recheck = page.getByRole("button", { name: /recheck/i });
  await recheck.click();
  await expect(recheck).toBeEnabled();
  await expect(
    page.getByText("Could not load model data", { exact: false }),
  ).toHaveCount(0);
  await shot(page, "/tmp/scan-acceptance/admin-setup-status.png");

  // ----------------------------------------------------------------- tabs
  const navTabs = page.locator("nav.seg");
  for (const label of ["Overview", "Models", "Install", "Jobs & defaults", "Hardware & services", "Guided setup"]) {
    await expect(navTabs.getByRole("link", { name: new RegExp(label, "i") })).toBeVisible();
  }

  // ------------------------------------------- hardware & services + transfer
  await page.goto(`${base}/admin/models/hardware`);
  await expect(page.getByRole("row", { name: /Hayai OCR v2/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /Qwen-Image 2\.1/ })).toContainText("18091");
  await expect(page.getByRole("row", { name: /Qwen-Image-Edit 2511/ })).toContainText("18092");
  await expect(page.getByRole("region", { name: "Transfer named models" })).toBeVisible();
  await expect(pageAlerts).toHaveCount(0);

  // ------------------------------------------------------------ local model
  // Add model → Local model server → generic GGUF. The recipe needs weights,
  // so the dialog waits for a .gguf path instead of failing server-side.
  await page.goto(`${base}/admin/models/list?task=translate`);
  const jobFilter = page.locator("select").filter({ hasText: "Any job" });
  await expect(jobFilter).toHaveValue("translate");
  await page.locator('nav a[href="/admin/models/list"]').click();
  await expect(page).toHaveURL((url) => !url.searchParams.has("task"));
  await expect(jobFilter).toHaveValue("all");
  await jobFilter.selectOption("detect");
  await expect(page).toHaveURL(/[?&]task=detect/);
  await jobFilter.selectOption("all");
  await expect(page).toHaveURL((url) => !url.searchParams.has("task"));

  await page.getByRole("button", { name: /^all\s+\d+$/i }).click();
  const providersLoaded = page.waitForResponse((res) => res.url().includes("/api/admin/remote-providers"));
  const presetsLoaded = page.waitForResponse((res) => res.url().includes("/api/admin/managed-models") && res.request().method() === "GET");
  await page.getByRole("button", { name: /add model/i }).click();
  const dialog = page.getByRole("dialog", { name: /^add model$/i });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /^local model$/i }).click();
  await dialog.getByRole("radio", { name: /Other llama\.cpp model/ }).click();
  await dialog.getByLabel(/^name$/i).fill("Kept name");
  await dialog.getByLabel(/^model id$/i).fill("");
  await providersLoaded;
  await presetsLoaded;
  await expect(dialog.getByLabel(/^name$/i)).toHaveValue("Kept name");
  await dialog.getByLabel(/^name$/i).fill("Setup check model");
  await dialog.getByLabel(/^model id$/i).fill("setup-check-local");
  await expect(dialog.getByRole("button", { name: /^add model$/i })).toBeDisabled();
  await dialog.getByLabel(/^weights/i).fill("~/models/setup-check-local.gguf");
  await expect(dialog.getByRole("button", { name: /^add model$/i })).toBeEnabled();
  await dialog.getByRole("button", { name: /^add model$/i }).click();
  await expect(dialog).toBeHidden();

  const localRow = page.getByRole("row").filter({ hasText: "Setup check model" });
  await expect(localRow).toBeVisible();
  await localRow.click();
  const drawer = page.getByRole("dialog", { name: /^Setup check model$/i });
  await expect(drawer).toBeVisible();
  const panel = drawer.getByRole("region", { name: "Local model editor" });
  await expect(panel).toBeVisible();
  for (const name of ["Generic llama.cpp preset", "Current Qwen preset", "Gemma 4 preset"]) {
    await expect(panel.getByRole("button", { name, exact: true })).toBeEnabled();
  }

  // Loading a preset fills the recipe fields with home-relative paths, and
  // saving (weights first — a recipe needs a model file) gives the row a
  // recipe the drawer round trip re-reads.
  await panel.getByRole("button", { name: /^generic llama\.cpp preset$/i }).click();
  await expect(panel.getByLabel("Model executable", { exact: true })).toHaveValue(/^~\//);
  await panel.getByLabel("Model weights", { exact: true }).fill("~/models/setup-check-local.gguf");
  await panel.getByRole("button", { name: /^save launch settings$/i }).click();
  await expect(panel.getByText(/Saved\. A running model/)).toBeVisible();
  // The saved recipe makes the row managed: lifecycle controls appear.
  await expect(panel.getByRole("button", { name: /^start model$/i })).toBeVisible();
  await shot(page, "/tmp/scan-acceptance/admin-setup-add-local.png");

  // Close → reopen round trip re-mounts the editor from the saved recipe.
  await drawer.getByRole("button", { name: "Close", exact: true }).click();
  await expect(drawer).toBeHidden();
  await localRow.click();
  await expect(
    page.getByRole("dialog", { name: /^Setup check model$/i }).getByLabel("Model executable", { exact: true }),
  ).toHaveValue(/^~\//);

  // Delete removes the operator row after the confirmation dialog.
  page.once("dialog", (dialog) => dialog.accept());
  const openDrawer = page.getByRole("dialog", { name: /^Setup check model$/i });
  await openDrawer.getByRole("button", { name: /delete/i }).click();
  await expect(openDrawer).toBeHidden();
  await expect(localRow).toHaveCount(0);

  // --------------------------------------------------------------- remote
  await page.getByRole("button", { name: /^remote$/i }).click();
  await expect(page.getByText("No models match these filters.")).toBeVisible();
  await page.getByRole("button", { name: /add model/i }).click();
  await dialog.getByRole("button", { name: /^remote api$/i }).click();
  await expect(dialog.getByPlaceholder("https://api.example.com/v1")).toBeVisible();
  await expect(dialog.getByPlaceholder("gpt-5.4")).toBeVisible();
  await dialog.getByPlaceholder("https://api.example.com/v1").fill("https://example.com/v1");
  await dialog.getByPlaceholder("gpt-5.4").fill("fixture-remote");
  await dialog.getByRole("button", { name: /^add/i }).click();
  await expect(dialog).toBeHidden();

  const remoteRow = page.getByRole("row").filter({ hasText: "fixture-remote" });
  await expect(remoteRow).toBeVisible();
  await remoteRow.click();
  const remoteDrawer = page.getByRole("dialog").filter({
    has: page.getByRole("button", { name: /refresh model list/i }),
  });
  await expect(remoteDrawer).toBeVisible();
  await expect(remoteDrawer.getByText("https://example.com/v1").first()).toBeVisible();
  await expect(remoteDrawer.getByText("OPENAI_API_KEY").first()).toBeVisible();
  await expect(remoteDrawer.getByRole("button", { name: /refresh model list/i })).toBeVisible();
  await shot(page, "/tmp/scan-acceptance/admin-setup-remote.png");

  // Delete removes the remote row after the confirmation dialog.
  page.once("dialog", (dialog) => dialog.accept());
  await remoteDrawer.getByRole("button", { name: /delete/i }).click();
  await expect(remoteRow).toHaveCount(0);
  await expect(page.getByText("No models match these filters.")).toBeVisible();
  await expect(pageAlerts).toHaveCount(0);

  // ------------------------------------------------------------------ cli
  await page.getByRole("button", { name: /^cli$/i }).click();
  assert.ok(
    (await page.locator("tbody tr.m-row").count()) >= 3,
    "expected the production CLI agent rows in the list",
  );
  await page.getByRole("row").filter({ hasText: "Grok 4.6" }).click();
  const cliDrawer = page.getByRole("dialog", { name: /^Grok 4.6$/i });
  await expect(cliDrawer).toBeVisible();
  await expect(cliDrawer.getByRole("heading", { name: "Command-line agent" })).toBeVisible();
  await expect(cliDrawer.getByText("Found via", { exact: true })).toBeVisible();
  // A saved executable location is registered from the model's panel.
  const cliPath = cliDrawer.getByLabel("Executable", { exact: true });
  await cliPath.fill("/usr/bin/true");
  await cliDrawer.getByRole("button", { name: /save & check/i }).click();
  await expect(cliDrawer.getByText(/saved location/i)).toBeVisible({ timeout: 15000 });
  await shot(page, "/tmp/scan-acceptance/admin-setup-cli.png");
  await cliDrawer.getByRole("button", { name: "Close", exact: true }).click();
  await expect(cliDrawer).toBeHidden();

  // The Add dialog lists every CLI adapter with its discovery state.
  await page.getByRole("button", { name: /add model/i }).click();
  await dialog.getByRole("button", { name: /^cli agent$/i }).click();
  assert.ok(
    (await dialog.locator(".choice").count()) >= 3,
    "the dialog should list the CLI adapters",
  );
  await dialog.getByRole("button", { name: /^close$/i }).click();
  await expect(dialog).toBeHidden();

  // ----------------------------------------------------------- install page
  await page.goto(`${base}/admin/models/install`);
  await expect(page.getByRole("heading", { name: "Install queue" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Bundles" })).toBeVisible();
  await expect(page.locator(".cat-group")).toHaveCount(7);

  // Measured sizes from the catalog show up on the rows.
  const detectGroup = page.locator(".cat-group").filter({
    has: page.locator("h3", { hasText: "Text detection" }),
  });
  const rtdetr = detectGroup
    .locator(".cat-item")
    .filter({ has: page.locator("strong", { hasText: /^RT-DETR$/ }) });
  await expect(rtdetr).toContainText("172 MB");
  await expect(rtdetr).toContainText("600 MB");
  await expect(rtdetr).toContainText("text detection (default)");

  // Blocked rows explain the missing environment instead of failing later.
  const rtdetrStatus = api.targets.find((target) => target.id === "rtdetr");
  if (rtdetrStatus.blocked && !rtdetrStatus.installed) {
    await expect(rtdetr).toContainText(".venv-ocr");
  }

  const chatGroup = page.locator(".cat-group").filter({
    has: page.locator("h3", { hasText: "Chat model" }),
  });
  const chat = chatGroup
    .locator(".cat-item")
    .filter({ has: page.locator("strong", { hasText: /^Qwen 3\.8 27B/ }) });
  await expect(chat).toContainText("13.1 GB");
  await expect(chat).toContainText("16 GB");
  const installButtons = page.getByRole("button", { name: /^install$/i, disabled: false });
  assert.ok(await installButtons.count() >= 1, "a fresh fixture must offer at least one install");
  await expect(pageAlerts).toHaveCount(0);
  await shot(page, "/tmp/scan-acceptance/admin-setup-install.png");

  // ------------------------------------------------------------- guided setup
  await navTabs.getByRole("link", { name: /guided setup/i }).click();
  await expect(page.getByRole("heading", { name: "Set up Komatose on this machine" })).toBeVisible();
  await expect(page.getByText("1. Translation", { exact: true })).toBeVisible();

  assert.deepEqual(errors, []);
  console.log(
    "Setup browser checks passed: overview jobs and attention refresh, hardware services and the transfer card render, " +
    "the Add model dialog adds a local GGUF with a launch recipe that round trips through the drawer, remote rows add and delete, " +
    "CLI panels register a saved executable path, catalog groups show measured sizes and blockers, and guided setup opens.",
  );
} finally {
  await browser.close();
}
