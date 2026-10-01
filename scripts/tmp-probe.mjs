/** Temporary: isolate which regionAi entry fails validateModel. */
import { request } from "@playwright/test";
const base = process.env.SCAN_TEST_BASEURL;
const context = await request.newContext({
  extraHTTPHeaders: { cookie: "scan_session=fixture-local-session" },
});
const api = `${base}/api/episodes/fixture-episode`;
const catalog = await (await context.get(`${base}/api/admin/models`)).json();
console.log("REGISTRY:", JSON.stringify((catalog.rows ?? catalog.models ?? []).map((r) => `${r.id}:${r.access}:${r.cliAdapter ?? ""}`)));
const state = async () => (await context.get(`${api}/workflow`)).json();
const before = await state();
const tasks = ["translate", "vision", "describe", "proofread", "enquire"];
const qwen = Object.fromEntries(tasks.map((t) => [t, { engine: "qwen3.8-27b-q4", model: "" }]));
const variants = {
  "tasks-defaults": { ...qwen, reviewers: [{ engine: "qwen3.8-27b-q4", model: "" }] },
  "tasks-before": { ...before.preferences.regionAi, reviewers: [{ engine: "qwen3.8-27b-q4", model: "" }] },
  "reviewer-qwen-override": { ...qwen, reviewers: [{ engine: "qwen3.8-27b-q4", model: "local-safety-fixture" }] },
  "reviewer-grok46": { ...qwen, reviewers: [{ engine: "grok-4.6", model: "" }] },
  "reviewer-gpt54": { ...qwen, reviewers: [{ engine: "gpt-5.4", model: "" }] },
  "reviewer-composer25": { ...qwen, reviewers: [{ engine: "composer-2.5", model: "" }] },
  "reviewer-grok-adapter": { ...qwen, reviewers: [{ engine: "grok", model: "reviewer-grok-fixture" }] },
  "describe-qwen3vl": { ...qwen, describe: { engine: "qwen3-vl-8b", model: "" }, reviewers: [{ engine: "qwen3.8-27b-q4", model: "" }] },
};
for (const [name, regionAi] of Object.entries(variants)) {
  const current = await state();
  const saved = await context.post(`${api}/workflow`, {
    data: {
      action: "preferences", scope: "series",
      expectedRevision: current.seriesDefaults.revision,
      data: { regionAi },
    },
  });
  console.log(name, saved.status(), (await saved.text()).slice(0, 160));
}
