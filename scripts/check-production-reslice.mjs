/** Exercises adapter-node's built output against isolated fixture data, never the live chapter. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import sharp from "sharp";
const root = execFileSync(
  process.execPath,
  ["--import", "tsx", "scripts/seed-workflow-fixture.ts"],
  { encoding: "utf8" },
)
  .trim()
  .split("\n")
  .at(-1);
const handler = pathToFileURL(
  resolve(process.argv[2] || "build", "handler.js"),
).href;
const child = spawn(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `import {createServer} from 'node:http'; const {handler}=await import(${JSON.stringify(handler)});createServer((req,res)=>handler(req,res,()=>{res.statusCode=404;res.end();})).listen(0,'127.0.0.1',function(){console.log('PORT='+this.address().port)});`,
  ],
  {
    env: {
      ...process.env,
      NODE_ENV: "production",
      SCAN_ROOT: root,
      SCAN_DATA_DIR: join(root, "data"),
      DATABASE_URL: join(root, "data/scan.db"),
      BODY_SIZE_LIMIT: "8G",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let output = "";
child.stderr.on("data", (b) => process.stderr.write(b));
const db = new Database(join(root, "data/scan.db"));
try {
  const port = await new Promise((resolve, reject) => {
    child.stdout.on("data", (b) => {
      output += b;
      const match = /PORT=(\d+)/.exec(output);
      if (match) resolve(Number(match[1]));
    });
    child.on("exit", (code) =>
      reject(Error(`Fixture server exited ${code}: ${output}`)),
    );
    setTimeout(() => reject(Error("Fixture startup timed out")), 15000).unref();
  });
  const api = `http://127.0.0.1:${port}/api/episodes/fixture-episode`;
  async function request(path, body) {
    const response = await fetch(`${api}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie: "scan_session=fixture-local-session",
        origin: "http://127.0.0.1:3847",
        ...(body instanceof FormData
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(body === undefined
        ? {}
        : { body: body instanceof FormData ? body : JSON.stringify(body) }),
    });
    const data = await response.json();
    assert.ok(response.ok, `${response.status}: ${JSON.stringify(data)}`);
    return data;
  }
  const initial = await request("/workflow");
  const form = new FormData();
  form.append(
    "files",
    new Blob(
      [
        await sharp({
          create: {
            width: 100,
            height: 6000,
            channels: 3,
            background: "#456789",
          },
        })
          .png()
          .toBuffer(),
      ],
      { type: "image/png" },
    ),
    "production-strip.png",
  );
  const upload = await request("/images", form),
    imageId = upload.images[0].id;
  async function finished(id) {
    for (let i = 0; i < 300; i++) {
      const state = await request("/workflow");
      const job = state.jobs.find((j) => j.id === id);
      if (job && !["running", "queued", "cancelling"].includes(job.state))
        return { job, state };
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error("Reslice job timed out");
  }
  // Keep a real separate job marked active: the safety guard must still block it.
  db.prepare(
    "INSERT INTO workflow_jobs(id,episode_id,kind,state,payload,progress,created_at,updated_at) VALUES('fixture-blocker','fixture-episode','mask','running','{}','{}',?,?)",
  ).run(Date.now(), Date.now());
  const blocked = await request("/pages", {
      op: "reslice",
      imageIds: [imageId],
      sizing: "2500",
    }),
    blockedResult = await finished(blocked.jobId);
  assert.equal(blockedResult.job.state, "failed");
  assert.match(blockedResult.job.error, /active chapter jobs/);
  assert.ok(blockedResult.state.images.some((i) => i.id === imageId));
  db.prepare(
    "UPDATE workflow_jobs SET state='cancelled' WHERE id='fixture-blocker'",
  ).run();
  // Retry through the production workflow endpoint. Only this reslice job is active now.
  const retry = await request("/workflow", {
    action: "retry",
    jobId: blocked.jobId,
  });
  const result = await finished(retry.jobId);
  assert.equal(
    result.job.state,
    "completed",
    result.job.error || JSON.stringify(result.job.progress),
  );
  const newPages = result.state.images.filter(
    (i) => !initial.images.some((old) => old.id === i.id),
  );
  assert.equal(
    newPages.reduce((n, i) => n + i.height, 0),
    6000,
  );
  assert.ok(newPages.length >= 3);
  assert.ok(newPages.every((i) => i.height <= 2750));
  assert.deepEqual(
    result.state.images
      .filter((i) => initial.images.some((old) => old.id === i.id))
      .map((i) => i.id),
    initial.images.map((i) => i.id),
  );
  console.log(
    "Production reslice passed: other active jobs remain blocked; a reslice does not block itself; retry preserves artwork.",
  );
} finally {
  db.close();
  child.kill("SIGTERM");
  if (child.exitCode === null) await once(child, "exit");
}
