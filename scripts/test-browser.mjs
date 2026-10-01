/** Starts and tears down an isolated fixture server. Never uses the live database. */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
const run = (args, env = process.env) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(output)
        : reject(new Error(`Process exited ${code}: ${args.join(" ")}\n${output}`)),
    );
  });
const seed = await run(["--import", "tsx", "scripts/seed-workflow-fixture.ts"]);
const root = seed.trim().split("\n").at(-1);
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
// Source acceptance now launches a real server-side translation job. Keep
// browser acceptance isolated from installed models and external services.
const model = createHttpServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [] }));
  let body = "";
  for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body);
  if (payload.messages?.[0]?.content?.startsWith('You are a Japanese/Korean scanlation proofreader')) {
    const content = payload.messages[1]?.content;
    const images = Array.isArray(content) ? content.filter(part => part.type === 'image_url').length : 0;
    const text = Array.isArray(content) ? content.find(part => part.type === 'text')?.text || '' : '';
    const followUp = /Editor follow-up:/.test(text);
    if (!followUp && images !== 2) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'Page proofreader needs both image attachments' }));
    }
    if (followUp && images < 2) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'Proofreader follow-up needs the original page images' }));
    }
    // Give the browser time to close the running modal before the saved response arrives.
    await new Promise(resolve => setTimeout(resolve, 500));
    return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      critique: followUp
        ? 'Panel 2 SFX is still clipped. Shorten the burst and keep the original meaning.'
        : 'Panel 1, upper right: keep the meaning of the Japanese request.\nTry a shorter English line break, then check the placement.',
    }) } }] }));
  }
  const system = String(payload.messages?.[0]?.content || '');
  if (system.startsWith('You are an independent Japanese/Korean visual transcription reviewer')) {
    return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      status: 'readable', source: '待って', translation: '', answer: 'The crop reads 待って.',
    }) } }] }));
  }
  if (system.startsWith('Translate the supplied')) {
    return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translation: 'Wait!' }) } }] }));
  }
  if (!system.startsWith("You translate")) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: "Unexpected fixture model request" }));
  }
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [
    { i: 0, translation: "Wait!", literal: "wait", reasoning: "Corrected source fixture" },
  ] }) } }] }));
});
await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
const fixtureEnv = {
  ...process.env,
  SCAN_ROOT: root,
  SCAN_DATA_DIR: join(root, "data"),
  DATABASE_URL: join(root, "data", "scan.db"),
  LLAMASWAP_URL: `http://127.0.0.1:${model.address().port}/v1`,
  LLAMASWAP_API_KEY: "browser-fixture",
};
await run(["--import", "tsx", "--eval", `
  const { fixturePasses } = await import("./tests/local-ocr-fixture.ts");
  const { MODEL_TASK_IDS } = await import("./src/lib/modelTasks.ts");
  for (const id of ["qwen3.8-27b-q4", "grok-4.6", "grok-4.5", "gpt-5.4", "composer-2.5"]) await fixturePasses(id, MODEL_TASK_IDS);
`], fixtureEnv);
const log = createWriteStream(join(root, "server.log"));
const dev = spawn(
  process.execPath,
  [
    "node_modules/vite/bin/vite.js",
    "dev",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ],
  {
    env: {
      ...process.env,
      SCAN_ROOT: root,
      SCAN_DATA_DIR: join(root, "data"),
      DATABASE_URL: join(root, "data/scan.db"),
      LLAMASWAP_URL: `http://127.0.0.1:${model.address().port}/v1`,
      LLAMASWAP_API_KEY: "browser-fixture",
      // Hermetic weights: presence gates check real files on disk, and host
      // homedir models must not leak into the fresh fixture (setup lists no
      // local configs unless this fixture configures them itself).
      SCAN_LLM_MODELS_DIR: join(root, "no-weights"),
      SCAN_LLM_MODEL: join(root, "no-weights/qwen.gguf"),
      SCAN_GEMMA4_MODELS_ROOT: join(root, "no-weights/gemma"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
dev.stdout.pipe(log);
dev.stderr.pipe(log);
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (dev.exitCode != null)
      throw new Error(`Fixture server stopped. See ${root}/server.log`);
    try {
      const r = await fetch(`${base}/login`);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready)
    throw new Error(`Fixture server did not start. See ${root}/server.log`);
  console.log(
    await run([process.argv[2] || "scripts/check-browser-workflow.mjs"], {
      ...process.env,
      SCAN_TEST_BASEURL: base,
      SCAN_TEST_DATA: join(root, "data"),
    }),
  );
  console.log(`Fixture data: ${root}; screenshots: /tmp/scan-acceptance`);
} finally {
  dev.kill("SIGTERM");
  await new Promise((resolve) => {
    if (dev.exitCode != null) return resolve();
    dev.once("exit", resolve);
  });
  log.end();
  await new Promise(resolve => model.close(resolve));
}
