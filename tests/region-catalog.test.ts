import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

const root = await mkdtemp("/tmp/scan-region-catalog-");
process.env.SCAN_DATA_DIR = join(root, "data");
process.env.DATABASE_URL = join(root, "scan.db");

const {
  activeRegionKinds,
  builtinRegionKinds,
  isBuiltinRegionKind,
  isRegionKindId,
  normalizeHex,
  normalizeRegionKinds,
  parseColorMap,
  regionColor,
  regionKindLabel,
  regionKindOptions,
  regionKindUsage,
} = await import("../src/lib/regionCatalog");
const { LINE_COLORS } = await import("../src/lib/lineColors");
const { LINE_TYPES, LINE_TYPE_LABELS } = await import("../src/lib/types");
const { db, sqlite } = await import("../src/lib/server/db");
const { users } = await import("../src/lib/server/db/schema");
const { readUserSettings, saveUserRegionColors } = await import("../src/lib/server/userSettings");

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const CUSTOM = [
  { id: '""', label: "Dialogue", color: "#ff0000" },
  { id: "sfx-2", label: "Impact SFX", color: "#00ff00" },
];

test("built-in kinds mirror the editor's text types and colors", () => {
  const kinds = builtinRegionKinds();
  assert.deepEqual(kinds.map((kind) => kind.id), [...LINE_TYPES]);
  for (const kind of kinds) {
    assert.equal(kind.color, LINE_COLORS[kind.id as keyof typeof LINE_COLORS]);
    assert.equal(kind.label, LINE_TYPE_LABELS[kind.id as keyof typeof LINE_TYPE_LABELS]);
  }
  assert.equal(isBuiltinRegionKind('""'), true);
  assert.equal(isBuiltinRegionKind("sfx-2"), false);
});

test("series kinds accept dynamic ids, reject junk, and fall back on unreadable data", () => {
  assert.deepEqual(
    normalizeRegionKinds(CUSTOM).map((kind) => kind.id),
    ['""', "sfx-2"],
  );
  assert.equal(isRegionKindId("sfx-2"), true);
  assert.equal(isRegionKindId("bad id"), false);
  assert.equal(isRegionKindId(""), false);
  assert.throws(() => normalizeRegionKinds([]), /at least one/);
  assert.throws(() => normalizeRegionKinds([{ id: "sfx-2", label: "SFX", color: "not-a-color" }]), /unique id/);
  assert.throws(() => normalizeRegionKinds([...CUSTOM, CUSTOM[0]]), /unique id/);
  // A series with a broken list still edits using the built-in types.
  assert.deepEqual(activeRegionKinds("garbage"), builtinRegionKinds());
  assert.deepEqual(activeRegionKinds(null), builtinRegionKinds());
  assert.deepEqual(activeRegionKinds(CUSTOM).map((kind) => kind.id), ['""', "sfx-2"]);
});

test("user colors win over the series color, which wins over the built-in color", () => {
  assert.equal(regionColor("sfx-2", CUSTOM), "#00ff00");
  assert.equal(regionColor("sfx-2", CUSTOM, { "sfx-2": "#123456" }), "#123456");
  assert.equal(regionColor('""', CUSTOM), "#ff0000");
  assert.equal(regionColor('""', CUSTOM, { '""': "#abcdef" }), "#abcdef");
  // A dynamic type the series removed still resolves to something drawable.
  assert.equal(regionColor("sfx-2", builtinRegionKinds()), LINE_COLORS.plain);
  assert.equal(regionColor("plain", []), LINE_COLORS.plain);
});

test("labels prefer the series name, then the built-in name, then the raw id", () => {
  assert.equal(regionKindLabel("sfx-2", CUSTOM), "Impact SFX");
  assert.equal(regionKindLabel('""', CUSTOM), "Dialogue");
  assert.equal(regionKindLabel('""', builtinRegionKinds()), LINE_TYPE_LABELS['""']);
  assert.equal(regionKindLabel("sfx-2", builtinRegionKinds()), "sfx-2");
});

test("a removed type stays in the menu so existing regions keep a label", () => {
  assert.deepEqual(
    regionKindOptions(builtinRegionKinds()).map((kind) => kind.id),
    [...LINE_TYPES],
  );
  assert.deepEqual(
    regionKindOptions(CUSTOM, '""').map((kind) => kind.id),
    ['""', "sfx-2"],
  );
  const withRemoved = regionKindOptions(CUSTOM, "::");
  assert.deepEqual(withRemoved.map((kind) => kind.id), ['""', "sfx-2", "::"]);
  assert.equal(withRemoved.at(-1)?.label, LINE_TYPE_LABELS["::"]);
  assert.equal(withRemoved.at(-1)?.color, LINE_COLORS["::"]);
});

test("types still used by saved regions survive removal from the series list", () => {
  // Nothing in use: the series list is returned unchanged.
  assert.equal(regionKindUsage(CUSTOM, []), CUSTOM);
  assert.equal(regionKindUsage(CUSTOM, ['""', "sfx-2"]), CUSTOM);
  // A removed dynamic type keeps a stable id, a fallback label, and a color.
  const usage = regionKindUsage(builtinRegionKinds(), ['""', "sfx-2", "sfx-2", ""]);
  assert.deepEqual(usage.map((kind) => kind.id), [...LINE_TYPES, "sfx-2"]);
  assert.equal(usage.at(-1)?.label, "sfx-2");
  assert.equal(usage.at(-1)?.color, LINE_COLORS.plain);
  // Junk ids never reach the panel.
  assert.deepEqual(regionKindUsage(CUSTOM, ["bad id"]), CUSTOM);
});

test("color maps keep only well-formed ids and hex values", () => {
  assert.deepEqual(parseColorMap({ '""': "#AbCdEf", "sfx-2": "00ff00" }), {
    '""': "#abcdef",
    "sfx-2": "#00ff00",
  });
  assert.deepEqual(parseColorMap({ "bad id": "#ffffff", ok: "nope" }), {});
  assert.deepEqual(parseColorMap(null), {});
  assert.equal(normalizeHex("#FFF"), null);
});

test("per-user region colors round trip through the account settings column", () => {
  db.insert(users).values({
    id: "color-user",
    username: "color-user",
    passwordHash: "unused",
    role: "translator",
    createdAt: 1,
  }).run();
  assert.deepEqual(readUserSettings("color-user").regionColors, {});
  const saved = saveUserRegionColors("color-user", { '""': "#112233", "bad id": "#ffffff" });
  assert.deepEqual(saved.regionColors, { '""': "#112233" });
  assert.deepEqual(readUserSettings("color-user").regionColors, { '""': "#112233" });
  // Saving colors leaves unrelated settings in place.
  sqlite.prepare("UPDATE users SET settings=? WHERE id='color-user'").run(JSON.stringify({ theme: "dark" }));
  saveUserRegionColors("color-user", { "sfx-2": "#445566" });
  assert.deepEqual(JSON.parse(String((sqlite.prepare("SELECT settings FROM users WHERE id='color-user'").get() as { settings: string }).settings)), {
    theme: "dark",
    regionColors: { "sfx-2": "#445566" },
  });
});
