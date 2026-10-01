import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR, ROOT } from "./paths";

export const SERVER_STARTED_AT = Date.now();
const STATUS_FILE = join(DATA_DIR, "logs", "rebuild.status");

export type RebuildPhase = "idle" | "started" | "ready" | "failed";

export async function rebuildStatus(): Promise<{
  startedAt: number;
  phase: RebuildPhase;
}> {
  try {
    const text = (await readFile(STATUS_FILE, "utf8")).trim();
    const [phase] = text.split(/\s+/);
    if (phase === "started" || phase === "ready" || phase === "failed")
      return { startedAt: SERVER_STARTED_AT, phase };
  } catch {
    /* no stamp yet */
  }
  return { startedAt: SERVER_STARTED_AT, phase: "idle" };
}

export async function startRebuild() {
  await mkdir(join(DATA_DIR, "logs"), { recursive: true });
  await writeFile(STATUS_FILE, "started\n");
  const child = spawn("bash", [join(ROOT, "scripts/rebuild.sh")], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.on("error", () => {
    void writeFile(STATUS_FILE, "failed\n");
  });
  child.unref();
  return { startedAt: SERVER_STARTED_AT, phase: "started" as const };
}
