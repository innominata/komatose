/**
 * One-shot: copy fonts from /www/scan's library into komatose's shared font library.
 * Run: node --import tsx --env-file=.env scripts/import-scan-fonts.mjs
 */
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { uploadFont, listFonts } from "../src/lib/server/typesetting.ts";

const SCAN_DB = process.env.SCAN_SOURCE_DB || "/www/scan/data/scan.db";
const SCAN_ASSETS = process.env.SCAN_SOURCE_ASSETS || "/www/scan/data/workflow/assets";

const scanDb = new Database(SCAN_DB, { readonly: true });
const byHash = new Map();
for (const row of scanDb
  .prepare("SELECT filename, hash, metadata FROM global_font_assets")
  .all()) {
  byHash.set(row.hash, row);
}
for (const row of scanDb
  .prepare("SELECT filename, hash, metadata FROM font_assets")
  .all()) {
  if (!byHash.has(row.hash)) byHash.set(row.hash, row);
}

console.log(`Importing ${byHash.size} unique fonts into shared library…`);
let added = 0;
let duplicates = 0;
let failed = 0;
const failures = [];

for (const row of byHash.values()) {
  const path = join(SCAN_ASSETS, row.hash);
  try {
    await access(path);
    const bytes = await readFile(path);
    const result = await uploadFont(null, row.filename, bytes);
    const meta = JSON.parse(row.metadata);
    if (result.duplicate) {
      duplicates++;
      console.log(`  duplicate  ${row.filename}`);
    } else {
      added++;
      console.log(
        `  added      ${row.filename}  (${meta.familyName} · ${meta.subfamilyName})`,
      );
    }
  } catch (e) {
    failed++;
    const message = e instanceof Error ? e.message : String(e);
    failures.push({ filename: row.filename, error: message });
    console.log(`  FAILED     ${row.filename}: ${message}`);
  }
}

const now = listFonts(null);
console.log(`\nDone. added=${added} duplicates=${duplicates} failed=${failed}`);
console.log(`Shared library now has ${now.length} fonts.`);
if (failures.length) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f.filename}: ${f.error}`);
  process.exitCode = 1;
}
