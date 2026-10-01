/** Run with: node scripts/test-browser-model-pack.mjs */
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

const baseA = process.env.SCAN_TEST_BASEURL;
const baseB = process.env.SCAN_TEST_BASEURL_B;
assert.ok(baseA && baseB, "Run through scripts/test-browser-model-pack.mjs");

let executable = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executable) && !process.env.SCAN_TEST_CHROMIUM) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache/ms-playwright");
  if (existsSync(cache)) {
    executable = readdirSync(cache)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((name) => join(cache, name, "chrome-linux64/chrome"))
      .find((path) => existsSync(path)) || executable;
  }
}

const HOST_LEAK = /\/home\/inno\b|\/www\/scan\/data\b|SCAN_GPU_MODE=komatose|sk-live|s3cret/;
const PUBLIC_URL = "https://api.example.test/v1";
const PRIVATE_URL = "http://user:s3cret@192.168.200.10/v1?api_key=sk-live";
const PRIVATE_SANITIZED = "http://192.168.200.10/v1";

async function createAdmin(page, base, username, password) {
  await page.goto(`${base}/setup`);
  await page.getByRole("heading", { name: "Create Admin" }).waitFor();
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "Initialize" }).click();
  // A brand-new install lands on /admin/setup (which contains "/setup" in its
  // path): the wait is for leaving the first-run wizard at /setup itself.
  await page.waitForURL((url) => url.pathname !== "/setup");
  await expect(page.getByText(`${username} · admin`)).toBeVisible();
}

async function addRemote(page, base, fields) {
  const res = await page.request.post(`${base}/api/admin/models`, {
    data: { action: "add-remote", ...fields },
  });
  assert.ok(res.ok(), await res.text());
}

async function downloadPack(page, dest) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export pack" }).click(),
  ]);
  await download.saveAs(dest);
  const pack = JSON.parse(await readFile(dest, "utf8"));
  const text = JSON.stringify(pack);
  assert.equal(pack.kind, "komatose.model-pack");
  assert.doesNotMatch(text, HOST_LEAK);
  return pack;
}

function ids(pack) {
  return (pack.models || []).map((item) => item.id).sort();
}

const browser = await chromium.launch({ executablePath: executable, headless: true });
const ctxA = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
const ctxB = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
const pageA = await ctxA.newPage();
const pageB = await ctxB.newPage();
const errors = [];
pageA.on("pageerror", (error) => errors.push(`A: ${error.message}`));
pageB.on("pageerror", (error) => errors.push(`B: ${error.message}`));

const closedPackPath = join(tmpdir(), "komatose-pack-default.json");
const openPackPath = join(tmpdir(), "komatose-pack-private.json");

try {
  await createAdmin(pageA, baseA, "pack-admin", "pack-pass");
  await addRemote(pageA, baseA, {
    id: "studio-public",
    name: "Studio public",
    slug: "gpt-4o",
    baseUrl: PUBLIC_URL,
    apiKeyEnv: "STUDIO_OPENAI_KEY",
  });
  await addRemote(pageA, baseA, {
    id: "lan-gpt4o",
    name: "LAN GPT-4o",
    slug: "gpt-4o",
    baseUrl: PRIVATE_URL,
    apiKeyEnv: "STUDIO_OPENAI_KEY",
  });

  // Chat rows are per-machine now (added in Setup, not seeded), so a portable
  // profile references rows the pack can carry to the destination.
  const saved = await pageA.request.post(`${baseA}/api/model-profiles`, {
    data: {
      action: "save",
      name: "LAN work",
      selections: {
        translate: { engine: "lan-gpt4o", model: "" },
        proofread: { engine: "studio-public", model: "" },
        reviewers: [],
        transcriptionModels: ["studio-public"],
      },
    },
  });
  assert.ok(saved.ok(), await saved.text());

  // Pack export/import lives on Hardware & services under "Move to another
  // machine" (the old /admin/setup page now only points at Admin → Models).
  await pageA.goto(`${baseA}/admin/models/hardware`);
  await expect(pageA.getByRole("heading", { name: "Hardware & services" })).toBeVisible();
  await expect(pageA.getByText("This pack will include 1 model and 1 profile.")).toBeVisible();
  await expect(pageA.getByRole("checkbox", { name: "Include private network endpoints" })).not.toBeChecked();
  await expect(pageA.getByText("Excluded private or local endpoints")).toBeVisible();
  await expect(pageA.locator(".pack-list").filter({ hasText: "lan-gpt4o" })).toContainText("192.168.200.10");
  await expect(pageA.getByText("Profiles that need models on the destination")).toBeVisible();
  await expect(pageA.getByText(/LAN work:/)).toContainText("LAN GPT-4o");
  await expect(pageA.getByText(/LAN work:/)).toContainText("private");
  await expect(pageA.getByText("Private endpoints in this pack")).toHaveCount(0);

  const closed = await downloadPack(pageA, closedPackPath);
  assert.deepEqual(ids(closed), ["studio-public"]);
  assert.equal(closed.profiles.some((item) => item.name === "LAN work"), true);
  assert.equal(JSON.stringify(closed).includes("192.168.200.10"), false);
  assert.equal(closed.models.some((item) => item.id === "lan-gpt4o"), false);

  await pageA.getByRole("checkbox", { name: "Include private network endpoints" }).check();
  await expect(pageA.getByText("This pack will include 2 models and 1 profile.")).toBeVisible();
  await expect(pageA.getByText("Private endpoints in this pack")).toBeVisible();
  await expect(pageA.locator(".pack-list").filter({ hasText: "lan-gpt4o" })).toContainText(PRIVATE_SANITIZED);
  await expect(pageA.getByText("Profiles that need models on the destination")).toHaveCount(0);
  await expect(pageA.getByText("Excluded private or local endpoints")).toHaveCount(0);

  const open = await downloadPack(pageA, openPackPath);
  assert.deepEqual(ids(open), ["lan-gpt4o", "studio-public"]);
  const lan = open.models.find((item) => item.id === "lan-gpt4o");
  assert.equal(lan?.http?.baseUrl, PRIVATE_SANITIZED);
  assert.equal(JSON.stringify(open).includes("s3cret"), false);
  assert.equal(JSON.stringify(open).includes("sk-live"), false);
  assert.equal(JSON.stringify(open).includes("user:"), false);

  await createAdmin(pageB, baseB, "pack-admin-b", "pack-pass");
  await pageB.goto(`${baseB}/admin/models/hardware`);
  await pageB.getByRole("heading", { name: "Hardware & services" }).waitFor();
  await addRemote(pageB, baseB, {
    id: "studio-public",
    name: "Studio public",
    slug: "gpt-4o",
    baseUrl: PUBLIC_URL,
    apiKeyEnv: "STUDIO_OPENAI_KEY",
  });

  await pageB.locator('input[type="file"][accept*="json"]').setInputFiles(openPackPath);
  await expect(pageB.getByText("Conflicts")).toBeVisible();
  await expect(pageB.getByText("Choose skip or rename")).toBeVisible();
  const conflict = pageB.locator(".pack-conflict").filter({ hasText: "studio-public" });
  await expect(conflict).toBeVisible();
  await expect(pageB.getByRole("button", { name: "Apply import" })).toBeDisabled();
  await conflict.getByLabel("Skip", { exact: true }).check();
  await expect(pageB.getByRole("button", { name: "Apply import" })).toBeEnabled();
  await pageB.getByRole("button", { name: "Apply import" }).click();
  await expect(pageB.getByText(/Imported 1 models and 1 profiles/)).toBeVisible();
  // Imported rows land in the Models list; the drawer shows their endpoint.
  await pageB.goto(`${baseB}/admin/models/list`);
  await expect(pageB.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
  const importedRow = pageB.locator("tr.m-row").filter({ hasText: "LAN GPT-4o" });
  await expect(importedRow).toBeVisible();
  await importedRow.click();
  const drawer = pageB.getByRole("dialog", { name: "LAN GPT-4o" });
  await expect(drawer).toContainText(PRIVATE_SANITIZED);

  if (errors.length) throw new Error(errors.join("\n"));
  console.log("model-pack private-endpoint export/import browser checks passed");
} finally {
  await browser.close();
}
