import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.SCAN_ROOT = await mkdtemp(join(tmpdir(), "scan-director-warnings-"));
process.env.DATABASE_URL = join(process.env.SCAN_ROOT, "data/test.db");
const { sqlite } = await import("../src/lib/server/db");
const { directorFindingKey, directorPageOutcome } = await import("../src/lib/director");
const { directorOverview, directorWarnings, dismissDirectorWarning, resetDirectorPage } =
  await import("../src/lib/server/directorService");

sqlite.prepare("INSERT INTO users(id,username,password_hash,role,created_at) VALUES('u','User','x','admin',1)").run();
sqlite.prepare("INSERT INTO series(id,slug,title,created_at,updated_at) VALUES('s','s','Series',1,1)").run();
sqlite.prepare("INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES('e','s','e','Episode',1,1)").run();
sqlite.prepare("INSERT INTO images(id,episode_id,filename,original_name,sort_order,width,height,created_at,role) VALUES('p1','e','p1.png','p1.png',1,100,100,1,'page')").run();
sqlite.prepare(`INSERT INTO director_runs(id,episode_id,user_id,scope,image_id,model,proofreader,state,page_ids,recheck_all,message,created_at,updated_at)
  VALUES('r','e','u','page','p1','{}','{}','completed','["p1"]',0,'',1,1)`).run();

const warning = { code: "tight-fit", message: "Lettering is slightly tight", lineId: "l1", stage: "check", severity: "warning" } as const;
const blocker = { code: "overflow", message: "Text overflows", stage: "check", severity: "blocker" } as const;

test("warnings never block a page, but are counted in its detail", () => {
  assert.deepEqual(directorPageOutcome([warning], true), {
    state: "passed",
    detail: "Automated checks passed; human approval is still required · 1 warning to review",
  });
  assert.equal(directorPageOutcome([warning], false).state, "partial");
  assert.deepEqual(directorPageOutcome([warning, blocker], true), { state: "unresolved", detail: "Text overflows" });
});

test("a dismissed warning stays hidden until its content changes", () => {
  sqlite.prepare("INSERT INTO director_pages(episode_id,image_id,state,run_id,findings,updated_at) VALUES('e','p1','passed','r',?,1)")
    .run(JSON.stringify([warning]));
  const [shown] = directorWarnings("e", "p1");
  assert.equal(shown.key, directorFindingKey(warning));
  assert.deepEqual(dismissDirectorWarning("e", "p1", shown.key), { warnings: [] });
  assert.deepEqual(directorOverview("e").pages[0].findings, []);
  const changed = { ...warning, message: "Lettering is very tight" };
  sqlite.prepare("UPDATE director_pages SET findings=? WHERE image_id='p1'").run(JSON.stringify([warning, changed]));
  assert.deepEqual(directorWarnings("e", "p1").map((w) => w.message), [changed.message]);
  assert.throws(() => dismissDirectorWarning("e", "p1", "missing"), /not found/);
});

test("resetting a page forgets its cached stages so the next run redoes them", () => {
  sqlite.prepare("INSERT INTO director_stages(run_id,image_id,stage,state,attempts,input,output,updated_at) VALUES('r','p1','read','passed',1,'f','f',1)").run();
  resetDirectorPage("e", "p1");
  assert.equal((sqlite.prepare("SELECT count(*) n FROM director_stages WHERE image_id='p1'").get() as { n: number }).n, 0);
  assert.equal(directorOverview("e").pages[0].state, "pending");
  sqlite.prepare("UPDATE director_runs SET state='running' WHERE id='r'").run();
  assert.throws(() => resetDirectorPage("e", "p1"), /Pause Director/);
});
