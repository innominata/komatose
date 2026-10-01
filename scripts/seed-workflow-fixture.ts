/** Isolated browser fixture; never points at the live database. */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
const root = await mkdtemp("/tmp/scan-browser-");
process.env.SCAN_DATA_DIR = join(root, "data");
process.env.DATABASE_URL = join(root, "data", "scan.db");
const { db } = await import("../src/lib/server/db/index");
const { users, series, episodes, images, lines, sessions } =
  await import("../src/lib/server/db/schema");
const { saveImageFile } = await import("../src/lib/server/storage");
await db
  .insert(users)
  .values({
    id: "browser-user",
    username: "fixture",
    passwordHash: "unused",
    role: "admin",
    createdAt: 1,
  });
await db
  .insert(series)
  .values({
    id: "fixture-series",
    slug: "fixture-series",
    title: "The Lantern Keeper",
    createdAt: 1,
    updatedAt: 1,
  });
await db
  .insert(episodes)
  .values({
    id: "fixture-episode",
    seriesId: "fixture-series",
    slug: "chapter-1",
    title: "Chapter 1",
    createdAt: 1,
    updatedAt: 1,
  });
await db
  .insert(sessions)
  .values({
    id: "fixture-local-session",
    userId: "browser-user",
    expiresAt: Date.now() + 86400000,
    lastSeenAt: Date.now(),
  });
for (let i = 0; i < 2; i++) {
  const art = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1100"><rect width="800" height="1100" fill="#eeece3"/><rect x="40" y="40" width="720" height="475" fill="#788b8e" stroke="#20292c" stroke-width="6"/><path d="M40 490 L200 190 L320 370 L480 140 L760 490Z" fill="#39494c"/><path d="M440 500 L500 300 L560 500Z" fill="#263536"/><circle cx="499" cy="284" r="27" fill="#e1d7b8"/><ellipse cx="625" cy="180" rx="100" ry="90" fill="white" stroke="black" stroke-width="3"/><ellipse cx="170" cy="170" rx="100" ry="75" fill="white" stroke="black" stroke-width="3"/><rect x="40" y="550" width="720" height="510" fill="#cfccc0" stroke="#20292c" stroke-width="6"/><path d="M40 1000 L280 620 L500 1050Z" fill="#849193"/><circle cx="450" cy="745" r="100" fill="#ddd1b7" stroke="#253d41" stroke-width="6"/><path d="M345 700 Q390 550 540 660 L570 790 L490 680 L360 740Z" fill="#253d41"/><path d="M280 1060 Q320 805 455 850 Q590 870 650 1060Z" fill="#293d40"/><ellipse cx="190" cy="715" rx="105" ry="100" fill="white" stroke="black" stroke-width="3"/></svg>`,
  );
  const saved = await saveImageFile({
    seriesSlug: "fixture-series",
    episodeSlug: "chapter-1",
    sortOrder: i,
    originalName: `upload-${i + 1}.png`,
    bytes: await sharp(art).png().toBuffer(),
    mime: "image/png",
  });
  await db
    .insert(images)
    .values({
      id: `fixture-page-${i}`,
      episodeId: "fixture-episode",
      ...saved,
      originalName: `upload-${i + 1}.png`,
      sortOrder: i,
      createdAt: i + 1,
      updatedAt: i + 1,
    });
  for (const [n, x, y, w, h, source, body] of [
    [0, 0.656, 0.082, 0.25, 0.164, "ここで待って。", "Wait here."],
    [1, 0.087, 0.086, 0.25, 0.137, "本当に行くの？", "Are you really going?"],
    [
      2,
      0.106,
      0.56,
      0.263,
      0.182,
      "夜明けまでに戻る。",
      "I will be back before dawn.",
    ],
  ] as const) {
    await db
      .insert(lines)
      .values({
        id: `fixture-line-${i}-${n}`,
        episodeId: "fixture-episode",
        imageId: `fixture-page-${i}`,
        source,
        sourceState: "read",
        ocrConfidence: 0.92,
        body,
        lineType: '""',
        status: "needs_work",
        placed: true,
        x,
        y,
        w,
        h,
        sortOrder: n,
        updatedAt: 1,
      });
  }
}
await writeFile(
  "/tmp/scan-browser-env.json",
  JSON.stringify({
    root,
    data: process.env.SCAN_DATA_DIR,
    db: process.env.DATABASE_URL,
  }),
);
// The chat rows ship as setup presets, not seeds: an operator adds them on
// their machine. The fixture stands in for that machine, and its model
// endpoint is the harness's mock at LLAMASWAP_URL.
await mkdir(process.env.SCAN_DATA_DIR!, { recursive: true });
await writeFile(
  join(process.env.SCAN_DATA_DIR!, "models.json"),
  JSON.stringify({
    rows: [
      {
        id: "qwen3.8-27b-q4",
        name: "Qwen 3.8 27B",
        slug: "qwen3.8-27b-q4",
        access: "local_http",
        seeded: false,
      },
      // The operator's machine also has the billed CLI agents installed, so
      // preferences may name them as reviewers and paid Run models.
      {
        id: "grok-4.6",
        name: "Grok 4.6",
        slug: "grok-4.6",
        access: "cli",
        cliAdapter: "grok",
        seeded: false,
      },
      {
        id: "grok-4.5",
        name: "Grok 4.5",
        slug: "grok-4.5",
        access: "cli",
        cliAdapter: "grok",
        seeded: false,
      },
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        slug: "gpt-5.4",
        access: "cli",
        cliAdapter: "codex",
        seeded: false,
      },
      {
        id: "composer-2.5",
        name: "Composer 2.5",
        slug: "composer-2.5",
        access: "cli",
        cliAdapter: "cursor",
        seeded: false,
      },
    ],
    catalogs: [],
  }),
);
console.log(root);
