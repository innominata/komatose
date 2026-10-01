/** Two isolated empty installs. Never uses the live database or production .env. */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DROP = [
  "LLAMASWAP_URL",
  "LLAMASWAP_API_KEY",
  "LLAMASWAP_MODEL",
  "SCAN_GPU_MODE",
  "GROK_BIN",
  "CODEX_BIN",
  "CURSOR_BIN",
  "CURSOR_AGENT_BIN",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "SCAN_PROOFREAD_SERVICE_URL",
  "SCAN_PROOFREAD_SERVICE_TOKEN",
  "SCAN_REVIEW_MODELS_DIR",
  "SCAN_REVIEW_PYTHON",
  "SCAN_REVIEW_LLAMA_SERVER",
  "SCAN_TRANSLATION_MODELS_DIR",
  "SCAN_TRANSLATION_PYTHON",
  "SCAN_TRANSLATION_LLAMA_SERVER",
  "SCAN_WORKFLOW_PYTHON",
  "PADDLEOCR_PYTHON",
  "DATABASE_URL",
  "SCAN_ROOT",
  "SCAN_DATA_DIR",
  "STUDIO_OPENAI_KEY",
];

function isolatedEnv(root, dataDir) {
  const env = { ...process.env };
  for (const key of DROP) delete env[key];
  env.SCAN_ROOT = root;
  env.SCAN_DATA_DIR = dataDir;
  env.DATABASE_URL = join(dataDir, "scan.db");
  env.HOME = join(root, "home");
  env.PATH = "/usr/bin:/bin";
  return env;
}

async function freePort() {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function startVite(root, dataDir, port) {
  await mkdir(join(root, "home"), { recursive: true });
  await mkdir(dataDir, { recursive: true });
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
      env: isolatedEnv(root, dataDir),
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  dev.stdout.pipe(log);
  dev.stderr.pipe(log);
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (dev.exitCode != null) {
      throw new Error(`Fixture server stopped. See ${root}/server.log`);
    }
    try {
      const res = await fetch(`${base}/setup`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error(`Fixture server did not start. See ${root}/server.log`);
  return { dev, log, base };
}

async function stopVite(server) {
  server.dev.kill("SIGTERM");
  await new Promise((resolve) => {
    if (server.dev.exitCode != null) return resolve();
    server.dev.once("exit", resolve);
  });
  server.log.end();
}

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
        : reject(new Error(`Process exited ${code}: ${args.join(" ")}`)),
    );
  });

const rootA = await mkdtemp(join(tmpdir(), "scan-pack-a-"));
const rootB = await mkdtemp(join(tmpdir(), "scan-pack-b-"));
const dataA = join(rootA, "data");
const dataB = join(rootB, "data");
console.log(`Install A: ${rootA}`);
console.log(`Install B: ${rootB}`);
const portA = await freePort();
const portB = await freePort();
const serverA = await startVite(rootA, dataA, portA);
const serverB = await startVite(rootB, dataB, portB);
try {
  console.log(
    await run(["scripts/check-browser-model-pack.mjs"], {
      ...process.env,
      SCAN_TEST_BASEURL: serverA.base,
      SCAN_TEST_BASEURL_B: serverB.base,
    }),
  );
  console.log(`Install A: ${rootA}`);
  console.log(`Install B: ${rootB}`);
} finally {
  await stopVite(serverA);
  await stopVite(serverB);
}
