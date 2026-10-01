import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import type { ModelRow } from "../src/lib/modelRegistry";
import { validateManagedLaunch } from "../src/lib/managedModels";

const root = await mkdtemp(join(tmpdir(), "scan-managed-test-"));
Object.assign(process.env, {
  SCAN_ROOT: root,
  SCAN_DATA_DIR: join(root, "data"),
  DATABASE_URL: join(root, "test.db"),
  SCAN_GPU_MODE: "",
  LLAMASWAP_URL: "http://default.invalid/v1",
  LLAMASWAP_API_KEY: "default-secret",
  CUSTOM_LOCAL_KEY: "custom-secret",
});
// Imported after the env above: paths.ts snapshots SCAN_ROOT/DATABASE_URL at load,
// so a static import here would bind this suite to the live database.
const store = await import("../src/lib/server/modelRegistryStore");
const manager = await import("../src/lib/server/managedModels");
const usage = await import("../src/lib/server/modelUsage");
const { modelHttpConfig } = await import("../src/lib/server/modelConnection");
const { assertEngineReady } = await import("../src/lib/server/engineReadiness");
const { registryPickerRows } = await import("../src/lib/server/registryPicker");
const { refreshLiveCatalog } = await import("../src/lib/server/modelCatalogs");
const { runTranslationTask } =
  await import("../src/lib/server/translationTask");
const { chatCompletions } = await import("../src/lib/server/llm");
const { withAssistantHttp } = await import("../src/lib/server/openaiHttp");
const { buildSetupReport } = await import("../src/lib/server/setupReport");
const { qwenModelLabel } = await import("../src/lib/qwenModels");
const executable = join(root, "fake-llama.mjs");
const weights = join(root, "weights.gguf");
await writeFile(weights, "fixture");
await writeFile(
  executable,
  `#!${process.execPath}\nimport {createServer} from 'node:http';
const args=process.argv.slice(2); const flag=n=>args[args.indexOf(n)+1];
if(flag('-a')==='crash') process.exit(2);
createServer((req,res)=> {res.setHeader('content-type','application/json'); res.end(JSON.stringify({data:[{id:flag('-a')==='hang'?'wrong-model':flag('-a')}]}));}).listen(Number(flag('--port')),'127.0.0.1');\n`,
  { mode: 0o755 },
);
const created: string[] = [];
async function freePort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
async function managed(slug: string) {
  const row = store.createLocalHttpRow({ name: slug, slug });
  created.push(row.id);
  return store.updateRegistryRow(row.id, {
    managedLaunch: {
      ...manager.launchPreset("generic"),
      executable,
      modelPath: weights,
      port: await freePort(),
      startOnBoot: true,
    },
  });
}
after(async () => {
  for (const id of created) {
    try {
      manager.operateManagedModel(id, "stop");
      await manager.waitManagedOperation(id);
    } catch {
      /* test reports busy failures */
    }
  }
  await rm(root, { recursive: true, force: true });
});

test("selected HTTP configuration drives readiness, picker, catalog, Setup and inference without Qwen", async () => {
  const row = store.createLocalHttpRow({
    name: "Other 27B",
    slug: "other-27b",
    baseUrl: "http://custom.invalid/v1",
    apiKeyEnv: "CUSTOM_LOCAL_KEY",
  });
  const cfg = modelHttpConfig(row)!;
  assert.equal(cfg.apiKey, "custom-secret");
  assert.equal(
    modelHttpConfig({
      ...row,
      http: { baseUrl: "http://custom.invalid/v1", apiKeyEnv: "" },
    })!.apiKey,
    "",
  );
  const fetch = globalThis.fetch;
  const hits: Array<{ url: string; auth?: string; body?: any }> = [];
  let up = true;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    hits.push({
      url: target,
      auth: (init?.headers as Record<string, string>)?.authorization,
      body,
    });
    if (target.includes("custom.invalid"))
      return new Response(
        JSON.stringify(
          body
            ? { choices: [{ message: { content: JSON.stringify({items:[{i:0,translation:"Test.",literal:"test",reasoning:"fixture"}]}) } }] }
            : { data: [{ id: "other-27b" }] },
        ),
        { status: up ? 200 : 503 },
      );
    return new Response("{}", { status: up ? 503 : 200 });
  };
  try {
    await assertEngineReady(row.id);
    assert.ok(
      (await registryPickerRows()).find((r) => r.id === row.id)?.available,
    );
    const catalog = await refreshLiveCatalog(`local:${row.id}`);
    assert.deepEqual(
      catalog.models.map((r) => r.id),
      ["other-27b"],
    );
    const { fixturePasses } = await import('./local-ocr-fixture');
    await fixturePasses(row.id, ['translate']);
    await runTranslationTask({engine:row.id, boxes:[{source:'テスト',x:0,y:0,w:1,h:1,lineType:'""',translation:'',literal:'',reasoning:''}], seriesNotes:'', prior:'', pageLabel:'fixture'});
    assert.equal(hits.at(-1)?.body.model, "other-27b");
    assert.equal(hits.at(-1)?.body.chat_template_kwargs, undefined);
    assert.ok(
      hits
        .filter((h) => h.url.includes("custom.invalid"))
        .every((h) => h.auth === "Bearer custom-secret"),
    );
    const { probeModelConnection } =
      await import("../src/lib/server/modelConnection");
    const report = await buildSetupReport({
      rows: [row],
      cli: [],
      env: () => "",
      localBaseUrl: "",
      probeLocal: async () => {
        throw new Error("Global probe must not run");
      },
      probeRow: probeModelConnection,
      installedReview: [],
      installedSpecialists: [],
      proofreadServiceSet: false,
    });
    assert.equal(
      report.items.find((i) => i.id === `local:${row.id}`)?.state,
      "configured",
    );
    up = false;
    await assert.rejects(assertEngineReady(row.id), /503/);
    assert.equal(
      (await registryPickerRows()).find((r) => r.id === row.id)?.available,
      false,
    );
    const failed = await refreshLiveCatalog(`local:${row.id}`);
    assert.match(failed.error!, /503/);
  } finally {
    globalThis.fetch = fetch;
  }
  assert.equal(qwenModelLabel("other-27b"), "other-27b");
});

test("Qwen request options are opt-in; row configuration persists and credentials do not fall through", async () => {
  const row = store.createLocalHttpRow({
    name: "Preset model",
    slug: "preset-model",
    baseUrl: "http://preset.invalid/v1",
  });
  const fetch = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
    );
  };
  try {
    const selected = store.updateRegistryRow(row.id, {
      requestPreset: "qwen-thinking",
    });
    await withAssistantHttp(modelHttpConfig(selected), () =>
      chatCompletions([{ role: "user", content: "hi" }], {}),
    );
    assert.deepEqual(bodies[0].chat_template_kwargs, {
      enable_thinking: true,
      reasoning_effort: "medium",
    });
    assert.equal(
      store.listRegistryRows(true).find((r) => r.id === row.id)?.requestPreset,
      "qwen-thinking",
    );
  } finally {
    globalThis.fetch = fetch;
  }
});

test("launch validation and generic arguments exclude Qwen tuning and conflicting flags", async () => {
  const row = await managed("generic-model");
  const r = row.managedLaunch!;
  const args = manager.managedLaunchArgs(row);
  assert.ok(!args.includes("--mmproj"));
  assert.ok(!args.includes("--spec-type"));
  assert.ok(!args.includes("--reasoning"));
  for (const extraArgs of [
    ["--port=1234"],
    ["-m", "other"],
    ["--api-key", "secret"],
    ["--hf-repo", "other"],
  ])
    assert.throws(
      () => validateManagedLaunch({ ...r, extraArgs }),
      /Unsupported/,
    );
  assert.throws(() => validateManagedLaunch({ ...r, port: 0 }), /port/);
  const other = await managed("other-model");
  assert.throws(
    () =>
      store.updateRegistryRow(other.id, {
        managedLaunch: { ...other.managedLaunch!, port: r.port },
      }),
    /port/,
  );
  const before = store.listRegistryRows().map((item) => item.id);
  assert.throws(
    () =>
      store.createLocalHttpRow({
        name: "clash",
        slug: "clash-port",
        managedLaunch: { ...r, port: r.port },
      }),
    /port/,
  );
  assert.deepEqual(store.listRegistryRows().map((item) => item.id), before);
  const qwen = { ...row, managedLaunch: { ...r, preset: "qwen38" as const } };
  assert.ok(manager.managedLaunchArgs(qwen).includes("--spec-type"));
  assert.ok(!manager.managedLaunchArgs(qwen, 1).includes("--spec-type"));
});

test("independent models, pending settings, busy uses, lifecycle locking, stop and verified resident reuse", async () => {
  const a = await managed("managed-a");
  const b = await managed("managed-b");
  manager.operateManagedModel(a.id, "start");
  manager.operateManagedModel(b.id, "start");
  await Promise.all([
    manager.waitManagedOperation(a.id),
    manager.waitManagedOperation(b.id),
  ]);
  assert.equal(manager.managedModelStatus(a).state, "running");
  assert.equal(manager.managedModelStatus(b).state, "running");
  const pid = manager.managedModelStatus(a).pid;
  manager.operateManagedModel(a.id, "start");
  assert.equal(manager.managedModelStatus(a).pid, pid);
  const invalid = store.updateRegistryRow(a.id, {
    managedLaunch: { ...a.managedLaunch!, modelPath: "/missing/new-weights" },
  });
  manager.operateManagedModel(a.id, "restart");
  await manager.waitManagedOperation(a.id);
  assert.equal(
    manager.managedModelStatus(invalid).pid,
    pid,
    "invalid restart must preserve the running process",
  );
  assert.match(manager.managedModelStatus(invalid).error!, /Missing weights/);
  const edited = store.updateRegistryRow(a.id, {
    managedLaunch: { ...a.managedLaunch!, port: await freePort() },
  });
  assert.ok(manager.managedModelStatus(edited).pendingChanges);
  assert.equal(
    modelHttpConfig(edited)!.baseUrl,
    `http://127.0.0.1:${a.managedLaunch!.port}/v1`,
  );
  assert.throws(
    () => store.updateRegistryRow(a.id, { slug: "changed" }),
    /Stop/,
  );
  usage.reserveModelJob(a.id, "queued-test");
  assert.throws(() => manager.operateManagedModel(a.id, "restart"), /busy/);
  usage.releaseModelJob("queued-test");
  const release = usage.acquireModelUse(a.id);
  assert.throws(() => manager.operateManagedModel(a.id, "stop"), /busy/);
  release();
  manager.operateManagedModel(a.id, "restart");
  assert.throws(() => usage.acquireModelUse(a.id), /lifecycle/);
  await manager.waitManagedOperation(a.id);
  assert.equal(manager.managedModelStatus(edited).state, "running");
  assert.equal(
    modelHttpConfig(edited)!.baseUrl,
    `http://127.0.0.1:${edited.managedLaunch!.port}/v1`,
  );
  // Simulate a fresh application process while preserving the resident fixture service.
  (globalThis as any).__managedModels.delete(a.id);
  usage.setEffectiveManagedRow(a.id);
  manager.operateManagedModel(a.id, "start");
  await manager.waitManagedOperation(a.id);
  assert.equal(manager.managedModelStatus(edited).state, "running");
  manager.operateManagedModel(a.id, "stop");
  await manager.waitManagedOperation(a.id);
  assert.equal(manager.managedModelStatus(edited).state, "stopped");
  assert.equal(manager.managedModelStatus(b).state, "running");
});

test("foreign port, missing assets, failed startup, cancellation and identity mismatch fail independently", async () => {
  const foreign = createServer();
  await new Promise<void>((r) => foreign.listen(0, "127.0.0.1", r));
  try {
    const row = await managed("occupied");
    store.updateRegistryRow(row.id, {
      managedLaunch: {
        ...row.managedLaunch!,
        port: (foreign.address() as { port: number }).port,
      },
    });
    manager.operateManagedModel(row.id, "start");
    await manager.waitManagedOperation(row.id);
    assert.match(
      manager.managedModelStatus(store.findRegistryRow(row.id)!).error!,
      /unowned/,
    );
    assert.ok(foreign.listening);
  } finally {
    await new Promise<void>((r) => foreign.close(() => r()));
  }
  const missing = await managed("missing");
  store.updateRegistryRow(missing.id, {
    managedLaunch: { ...missing.managedLaunch!, modelPath: "/missing/weights" },
  });
  manager.operateManagedModel(missing.id, "start");
  await manager.waitManagedOperation(missing.id);
  assert.match(manager.managedModelStatus(missing).error!, /Missing weights/);
  const crash = await managed("crash");
  manager.operateManagedModel(crash.id, "start");
  await manager.waitManagedOperation(crash.id);
  assert.equal(manager.managedModelStatus(crash).state, "error");
  const hang = await managed("hang");
  const abort = new AbortController();
  manager.operateManagedModel(hang.id, "start", abort.signal);
  setTimeout(() => abort.abort(), 700);
  await manager.waitManagedOperation(hang.id);
  assert.equal(manager.managedModelStatus(hang).state, "error");
  assert.equal(usage.activeModelUses(hang.id), 0);
  const resident = await managed("resident");
  manager.operateManagedModel(resident.id, "start");
  await manager.waitManagedOperation(resident.id);
  store.updateRegistryRow(resident.id, {
    managedLaunch: { ...resident.managedLaunch!, contextSize: 16384 },
  });
  (globalThis as any).__managedModels.delete(resident.id);
  usage.setEffectiveManagedRow(resident.id);
  manager.operateManagedModel(resident.id, "start");
  await manager.waitManagedOperation(resident.id);
  assert.match(
    manager.managedModelStatus(store.findRegistryRow(resident.id)!).error!,
    /Restart/,
  );
  // Metadata never contains bearer values.
  for (const file of await readdir(join(root, "data/run")))
    assert.ok(
      !(await readFile(join(root, "data/run", file), "utf8")).includes(
        "default-secret",
      ),
    );
});

test("queued job reservations survive gaps between calls and release on every terminal state", async () => {
  const { sqlite } = await import("../src/lib/server/db");
  const { createJob, updateJob } = await import("../src/lib/server/jobs");
  sqlite
    .prepare(
      "INSERT INTO series(id,slug,title,created_at,updated_at) VALUES('lease-series','lease-series','Test',1,1)",
    )
    .run();
  sqlite
    .prepare(
      "INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES('lease-episode','lease-series','lease','Test',1,1)",
    )
    .run();
  const row = await managed("lease-model");
  for (const terminal of ["completed", "failed", "cancelled", "interrupted"]) {
    const job = createJob("lease-episode", "selection", {
      modelSelections: [{ engine: row.id, model: "" }],
    });
    updateJob(job, "queued", {});
    assert.equal(usage.activeModelUses(row.id), 1);
    assert.throws(() => manager.operateManagedModel(row.id, "stop"), /busy/);
    updateJob(job, terminal, {});
    assert.equal(usage.activeModelUses(row.id), 0);
  }
  const unlock = usage.lockModelLifecycle(row.id);
  assert.throws(
    () => createJob("lease-episode", "selection", { engine: row.id }),
    /lifecycle/,
  );
  unlock();
  assert.equal(usage.activeModelUses(row.id), 0);
  const cfg = modelHttpConfig({ ...row, managedLaunch: null })!;
  await assert.rejects(
    withAssistantHttp(cfg, async () => {
      throw new Error("Cancelled");
    }),
    /Cancelled/,
  );
  assert.equal(usage.activeModelUses(row.id), 0);
});

test("recipes and presets store home-relative paths: ~ on disk, expanded only at launch", async () => {
  const { homedir } = await import("node:os");
  const { expandHomePath, toHomeLaunch, toHomePath } = await import(
    "../src/lib/server/homePath"
  );

  // Shipped presets are served with ~, never this machine's home directory.
  const presets = {
    generic: manager.launchPreset("generic"),
    qwen38: manager.launchPreset("qwen38"),
    gemma4: manager.launchPreset("gemma4"),
  };
  const portable = JSON.stringify(Object.values(presets).map(toHomeLaunch));
  assert.ok(!portable.includes(homedir()), `preset response leaked the home directory: ${portable}`);
  for (const preset of Object.values(presets)) {
    const mapped = toHomeLaunch(preset);
    assert.equal(expandHomePath(mapped.executable), preset.executable);
    assert.equal(expandHomePath(mapped.modelPath), preset.modelPath);
  }
  assert.equal(toHomePath(join(homedir(), "models/x.gguf")), "~/models/x.gguf");
  assert.equal(expandHomePath("~/models/x.gguf"), join(homedir(), "models/x.gguf"));

  // Validation accepts (and keeps) the portable form instead of requiring an
  // absolute path: the expansion happens later, at launch.
  const validated = validateManagedLaunch({
    ...manager.launchPreset("generic"),
    modelPath: "~/models/fixture.gguf",
  });
  assert.equal(validated.modelPath, "~/models/fixture.gguf");

  // What an operator saves (even an absolute home path) is stored as ~.
  const row = await managed("tilde-recipe");
  const updated = store.updateRegistryRow(row.id, {
    managedLaunch: { ...row.managedLaunch!, modelPath: join(homedir(), "models/fixture.gguf") },
  });
  assert.equal(updated.managedLaunch!.modelPath, "~/models/fixture.gguf");
  const onDisk = JSON.parse(await readFile(store.modelsOverlayPath(), "utf8")) as {
    rows: Array<{ id: string; managedLaunch?: { modelPath?: string } }>;
  };
  assert.equal(
    onDisk.rows.find((item) => item.id === row.id)?.managedLaunch?.modelPath,
    "~/models/fixture.gguf",
  );

  // Launch expands again: args carry the absolute path, the error shows ~.
  const homeWeights = join(homedir(), "models/fixture.gguf");
  assert.ok(
    manager.managedLaunchArgs(updated).includes(homeWeights),
    "the launcher must expand ~/ before handing paths to llama-server",
  );
  manager.operateManagedModel(row.id, "start");
  await manager.waitManagedOperation(row.id);
  assert.match(
    manager.managedModelStatus(updated).error!,
    /Missing weights: ~\/models\/fixture\.gguf/,
  );
});

test("custom local reviewers use live access metadata; remote reviewers still need an explicit Run", async () => {
  const { isOnDemandReviewer } = await import("../src/lib/regionAi");
  const { validateReviewers } = await import("../src/lib/server/regionAi");
  const local = store.createLocalHttpRow({
    name: "Local reviewer",
    slug: "local-review-fixture",
    baseUrl: "http://review.invalid/v1",
  });
  const remote = store.createRemoteHttpRow({
    name: "Remote reviewer",
    slug: "remote-review-fixture",
    baseUrl: "http://remote.invalid/v1",
    apiKeyEnv: "REMOTE_KEY",
  });
  const localRef = { engine: local.id, model: "" };
  const remoteRef = { engine: remote.id, model: "" };
  assert.equal(isOnDemandReviewer(localRef, store.listRegistryRows()), false);
  assert.equal(isOnDemandReviewer(remoteRef, store.listRegistryRows()), true);
  assert.deepEqual(validateReviewers([localRef]), [localRef]);
  assert.throws(() => validateReviewers([remoteRef]), /Run button/);
});

test("komatose GPU mode refuses a chat launch port reserved for OCR review", async () => {
  const row = await managed("review-port-collision");
  const previous = process.env.SCAN_GPU_MODE;
  process.env.SCAN_GPU_MODE = "komatose";
  try {
    assert.throws(
      () =>
        store.updateRegistryRow(row.id, {
          managedLaunch: { ...row.managedLaunch!, port: 18081 },
        }),
      /PaddleOCR-VL-1.6/,
    );
  } finally {
    if (previous === undefined) delete process.env.SCAN_GPU_MODE;
    else process.env.SCAN_GPU_MODE = previous;
  }
});

test('a diagnostic holds its model until parsing finishes and releases it on failure', async () => {
  const { probeModelRow } = await import('../src/lib/server/modelProbe');
  const row = await managed('diagnostic-lease');
  manager.operateManagedModel(row.id, 'start');
  await manager.waitManagedOperation(row.id);
  let finish!: () => void;
  const pending = probeModelRow(row, 'translate', {
    translate: async () => { await new Promise<void>(resolve => { finish = resolve; }); throw new Error('fixture parse failure'); },
  });
  while (!finish) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(usage.activeModelUses(row.id) > 0);
  assert.throws(() => manager.operateManagedModel(row.id, 'stop'), /busy/);
  finish();
  assert.equal((await pending).ok, false);
  assert.equal(usage.activeModelUses(row.id), 0);
});

test("a stopped managed model loads when a task needs it and unloads after idle", async () => {
  const { probeModelConnection } = await import("../src/lib/server/modelConnection");
  process.env.SCAN_MANAGED_IDLE_SECONDS = "0.3";
  const row = store.createLocalHttpRow({ name: "On demand", slug: "on-demand-model" });
  created.push(row.id);
  try {
    const launched = store.updateRegistryRow(row.id, {
      managedLaunch: {
        ...manager.launchPreset("generic"),
        executable,
        modelPath: weights,
        port: await freePort(),
        startOnBoot: false,
      },
    });
    assert.equal(manager.managedModelStatus(launched).state, "stopped");
    const ready = await probeModelConnection(launched);
    assert.equal(ready.available, true);
    assert.match(ready.reason || "", /loads on demand/);
    await manager.ensureManagedModel(launched.id);
    assert.equal(manager.managedModelStatus(launched).state, "running");
    usage.acquireModelUse(launched.id, undefined, true)();
    const deadline = Date.now() + 5000;
    while (manager.managedModelStatus(launched).state !== "stopped" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(manager.managedModelStatus(launched).state, "stopped");

    manager.operateManagedModel(launched.id, "start");
    await manager.waitManagedOperation(launched.id);
    usage.acquireModelUse(launched.id, undefined, true)();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(manager.managedModelStatus(launched).state, "running");
  } finally {
    delete process.env.SCAN_MANAGED_IDLE_SECONDS;
  }
});
