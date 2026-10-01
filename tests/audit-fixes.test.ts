import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = await mkdtemp(join(tmpdir(), "scan-audit-"));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, "data");
process.env.DATABASE_URL = join(root, "data", "test.db");

after(() => rm(root, { recursive: true, force: true }));

test("stored notes and critiques drop event handlers and unsafe URLs", async () => {
  const { renderSafeMarkdown, sanitizeHtml } = await import("../src/lib/safeMarkdown");
  const html = renderSafeMarkdown(
    `<img src=x onerror="document.body.dataset.audit='STORED_NOTES_XSS'"> [click](javascript:alert(1))`,
  );
  assert.doesNotMatch(html, /onerror/i);
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /<img/i);
  assert.match(renderSafeMarkdown("**bold** and [docs](https://example.com)"), /<strong>bold<\/strong>/);
  assert.match(renderSafeMarkdown("**bold** and [docs](https://example.com)"), /href="https:\/\/example.com"/);
  assert.equal(sanitizeHtml('<a href="javascript:alert(1)">x</a>'), "<a>x</a>");
});

test("draft keys include the account so shared browsers do not replay another user's work", async () => {
  const { chapterDraftKey, maskDraftKey } = await import("../src/lib/draftKeys");
  assert.equal(chapterDraftKey("user-a", "ep-1"), "scan.drafts.user-a.ep-1");
  assert.notEqual(chapterDraftKey("user-a", "ep-1"), chapterDraftKey("user-b", "ep-1"));
  assert.equal(maskDraftKey("user-a", "ep-1", "page-1"), "scan.mask.user-a.ep-1.page-1");
});

test("export completion depends on the requested artifact", async () => {
  const { exportRequiresCompletion, groupReadinessIssues } = await import("../src/lib/workflow");
  assert.equal(exportRequiresCompletion("png", false), true);
  assert.equal(exportRequiresCompletion("png", true), false);
  assert.equal(exportRequiresCompletion("english", false), false);
  assert.equal(exportRequiresCompletion("json", true), false);
  const grouped = groupReadinessIssues([
    { code: "review", message: "Approve the English translation", imageId: "p1", pageLabel: "Page 1", regionLabel: "Page 1 · region 1" },
    { code: "review", message: "Approve the English translation", imageId: "p1", pageLabel: "Page 1", regionLabel: "Page 1 · region 2" },
    { code: "font", message: "Select an uploaded font", imageId: "p2", pageLabel: "Page 2", regionLabel: "Page 2 · region 1" },
  ]);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].count, 2);
  assert.deepEqual(grouped[0].regionLabels, ["Page 1 · region 1", "Page 1 · region 2"]);
});

test("login throttle blocks repeated failures and uses a dummy hash for unknown users", async () => {
  const {
    LOGIN_THROTTLE_LIMIT,
    dummyPasswordHash,
    loginThrottleKey,
    loginThrottleStatus,
    recordLoginFailure,
    resetLoginThrottle,
    clearLoginFailures,
  } = await import("../src/lib/server/loginThrottle");
  const { verifyPassword } = await import("../src/lib/server/auth");
  resetLoginThrottle();
  const key = loginThrottleKey("nobody", "203.0.113.8");
  assert.equal(loginThrottleStatus(key).blocked, false);
  for (let i = 0; i < LOGIN_THROTTLE_LIMIT; i++) recordLoginFailure(key);
  assert.equal(loginThrottleStatus(key).blocked, true);
  assert.ok(loginThrottleStatus(key).retryAfterMs > 0);
  clearLoginFailures(key);
  assert.equal(loginThrottleStatus(key).blocked, false);
  assert.equal(await verifyPassword("wrong-password", dummyPasswordHash()), false);
});

test("first-run setup creates only one administrator under concurrent requests", async () => {
  const { createFirstAdmin, AlreadyInitializedError, userCount } = await import("../src/lib/server/auth");
  const { db } = await import("../src/lib/server/db");
  const { users } = await import("../src/lib/server/db/schema");
  assert.equal(await userCount(), 0);
  const results = await Promise.allSettled([
    createFirstAdmin("owner-one", "password"),
    createFirstAdmin("owner-two", "password"),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].status === "rejected" && rejected[0].reason instanceof AlreadyInitializedError);
  assert.equal(await userCount(), 1);
  const rows = await db.select().from(users);
  assert.equal(rows.filter((row) => row.role === "admin").length, 1);
});

test("revoking a session or series membership closes matching chapter sockets", async () => {
  const realtime = await import("../src/lib/server/realtime");
  const closed: string[] = [];
  const fake = (label: string) =>
    ({
      readyState: 1,
      close(_code?: number, reason?: string) {
        closed.push(`${label}:${reason || ""}`);
      },
    }) as unknown as import("ws").WebSocket;
  const rooms = (globalThis as typeof globalThis & {
    __scanRooms: Map<string, Set<{ ws: import("ws").WebSocket; user: { id: string }; episodeId: string; seriesId: string; sessionId: string }>>;
  }).__scanRooms;
  rooms.set("ep-1", new Set());
  const room = rooms.get("ep-1")!;
  room.add({
    ws: fake("keep"),
    user: { id: "stay" },
    episodeId: "ep-1",
    seriesId: "series-a",
    sessionId: "sess-stay",
  });
  room.add({
    ws: fake("gone"),
    user: { id: "leave" },
    episodeId: "ep-1",
    seriesId: "series-a",
    sessionId: "sess-leave",
  });
  assert.equal(realtime.closeSocketsForSession("sess-leave"), 1);
  assert.ok(closed.includes("gone:session-ended"));
  room.add({
    ws: fake("acl"),
    user: { id: "leave" },
    episodeId: "ep-1",
    seriesId: "series-a",
    sessionId: "sess-2",
  });
  assert.equal(realtime.closeSocketsForSeriesUser("series-a", "leave"), 1);
  assert.ok(closed.includes("acl:access-revoked"));
});

test("duplicate copies current workflow documents with remapped ids", async () => {
  const { sqlite } = await import("../src/lib/server/db");
  const { nid, now } = await import("../src/lib/server/ids");
  const { duplicateEpisode } = await import("../src/lib/server/episodes");
  const t = now();
  const userId = nid();
  const seriesId = nid();
  const episodeId = nid();
  const imageId = nid();
  const lineId = nid();
  sqlite
    .prepare(
      "INSERT INTO users(id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)",
    )
    .run(userId, `dup-user-${userId}`, "x", "admin", t);
  sqlite
    .prepare(
      "INSERT INTO series(id,slug,title,notes,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    )
    .run(seriesId, `dup-${seriesId}`, "Dup series", "", t, t);
  sqlite
    .prepare(
      "INSERT INTO episodes(id,series_id,slug,title,sort_order,status,glossary,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run(episodeId, seriesId, "src", "Source chapter", 0, "raws", "[]", t, t);
  sqlite
    .prepare(
      "INSERT INTO images(id,episode_id,filename,original_name,sort_order,width,height,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run(imageId, episodeId, "1.png", "1.png", 0, 10, 10, t, t);
  sqlite
    .prepare(
      "INSERT INTO lines(id,episode_id,image_id,body,updated_at) VALUES(?,?,?,?,?)",
    )
    .run(lineId, episodeId, imageId, "Hello", t);
  sqlite
    .prepare(
      "INSERT INTO workflow_docs(id,episode_id,revision,data,undo,redo,updated_at) VALUES(?,?,?,?,?,?,?)",
    )
    .run(`chapter:${episodeId}`, episodeId, 2, JSON.stringify({ lang: "japanese" }), "[]", "[]", t);
  sqlite
    .prepare(
      "INSERT INTO workflow_docs(id,episode_id,revision,data,undo,redo,updated_at) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      `page:${imageId}`,
      episodeId,
      3,
      JSON.stringify({ cleaned: "abc", maskDiagnostics: { entries: [{ lineId }] } }),
      "[]",
      "[]",
      t,
    );
  sqlite
    .prepare(
      "INSERT INTO workflow_docs(id,episode_id,revision,data,undo,redo,updated_at) VALUES(?,?,?,?,?,?,?)",
    )
    .run(`region:${lineId}`, episodeId, 4, JSON.stringify({ polygon: [{ x: 1, y: 1 }] }), "[]", "[]", t);

  const result = await duplicateEpisode({
    series: { id: seriesId, slug: `dup-${seriesId}`, title: "Dup series", notes: "", glossary: [], credits: {}, createdBy: null, createdAt: t, updatedAt: t },
    episode: {
      id: episodeId,
      seriesId,
      slug: "src",
      title: "Source chapter",
      sortOrder: 0,
      status: "raws",
      glossary: [],
      createdAt: t,
      updatedAt: t,
    },
    user: { id: userId, username: `dup-user-${userId}`, role: "admin" },
  });
  const docs = sqlite
    .prepare("SELECT id, data FROM workflow_docs WHERE episode_id=? ORDER BY id")
    .all(result.id) as { id: string; data: string }[];
  assert.equal(docs.length, 3);
  assert.ok(docs.some((row) => row.id === `chapter:${result.id}`));
  const page = docs.find((row) => row.id.startsWith("page:"));
  const region = docs.find((row) => row.id.startsWith("region:"));
  assert.ok(page && region);
  const pageData = JSON.parse(page.data) as { maskDiagnostics: { entries: { lineId: string }[] } };
  assert.equal(pageData.maskDiagnostics.entries[0].lineId, region.id.slice("region:".length));
});
