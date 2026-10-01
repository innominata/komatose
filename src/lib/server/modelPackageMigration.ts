import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomicJson } from './modelPackJournal';

/** Explicit, idempotent migration. Never rewrites probe evidence into a pass. */
export function migrateModelPackages() {
  const root = process.env.SCAN_DATA_DIR || join(process.env.SCAN_ROOT || process.cwd(), 'data');
  const marker = join(root, 'model-packages-migration-v1.json');
  if (existsSync(marker)) return;
  mkdirSync(root, { recursive: true });
  const files = ['models.json', 'model-profiles.json', 'model-defaults.json', 'detector-config.json'];
  const backup = join(root, 'backups', 'model-packages-v1');
  mkdirSync(backup, { recursive: true });
  for (const name of files) if (existsSync(join(root, name)) && !existsSync(join(backup, name))) copyFileSync(join(root, name), join(backup, name));
  const path = join(root, 'models.json');
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    for (const row of saved.rows || []) if (!row.probeHistory?.length) row.probeHistory = Object.values(row.probes || {});
    writeAtomicJson(path, saved);
  }
  writeAtomicJson(marker, { version: 1, at: Date.now(), backup });
}
