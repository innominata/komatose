import type Database from "better-sqlite3";

function migrateDirectorAutomationV11(db: Database.Database) {
  if (db.prepare("SELECT 1 FROM schema_versions WHERE version=11").get())
    return;
  db.transaction(() => {
    db.exec(`
      ALTER TABLE director_runs ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE director_runs ADD COLUMN policy TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE director_pages ADD COLUMN stage TEXT;
      ALTER TABLE director_pages ADD COLUMN findings TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE director_pages ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
      CREATE TABLE director_stages (
        run_id TEXT NOT NULL REFERENCES director_runs(id) ON DELETE CASCADE,
        image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
        stage TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        input TEXT NOT NULL, output TEXT, detail TEXT NOT NULL DEFAULT '{}', child_id TEXT,
        updated_at INTEGER NOT NULL, PRIMARY KEY(run_id,image_id,stage)
      );
      CREATE TABLE director_operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES director_runs(id) ON DELETE CASCADE,
        episode_id TEXT NOT NULL, image_id TEXT NOT NULL, label TEXT NOT NULL,
        before_json TEXT NOT NULL, finished INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE director_series (
        series_id TEXT PRIMARY KEY REFERENCES series(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE director_examples (
        id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
        episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
        image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
        line_id TEXT NOT NULL REFERENCES lines(id) ON DELETE CASCADE,
        type_id TEXT NOT NULL, fingerprint TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_director_examples_series ON director_examples(series_id,type_id);
      CREATE TABLE director_memory_assets (
        series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
        hash TEXT NOT NULL, PRIMARY KEY(series_id,hash)
      );
      CREATE TABLE director_created_types (
        series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE, type_id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES director_runs(id), image_id TEXT NOT NULL,
        data TEXT NOT NULL, undone INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(series_id,type_id)
      );
      CREATE TABLE director_classifications (
        line_id TEXT PRIMARY KEY REFERENCES lines(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES director_runs(id), fingerprint TEXT NOT NULL, data TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO schema_versions VALUES(11,?)").run(Date.now());
  })();
}

function migrateDirectorAutomationV12(db: Database.Database) {
  migrateDirectorAutomationV11(db);
  if (db.prepare("SELECT 1 FROM schema_versions WHERE version=12").get())
    return;
  db.transaction(() => {
    // Keep early v2 databases upgradeable without losing the saved evidence.
    db.exec(`
      CREATE TABLE director_created_types_cascade (
        series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE, type_id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES director_runs(id) ON DELETE CASCADE, image_id TEXT NOT NULL,
        data TEXT NOT NULL, undone INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(series_id,type_id)
      );
      INSERT INTO director_created_types_cascade SELECT * FROM director_created_types;
      DROP TABLE director_created_types;
      ALTER TABLE director_created_types_cascade RENAME TO director_created_types;
      CREATE TABLE director_classifications_cascade (
        line_id TEXT PRIMARY KEY REFERENCES lines(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES director_runs(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL, data TEXT NOT NULL
      );
      INSERT INTO director_classifications_cascade SELECT * FROM director_classifications;
      DROP TABLE director_classifications;
      ALTER TABLE director_classifications_cascade RENAME TO director_classifications;
    `);
    db.prepare("INSERT INTO schema_versions VALUES(12,?)").run(Date.now());
  })();
}

export function migrateDirectorAutomation(db: Database.Database) {
  migrateDirectorAutomationV12(db);
  if (db.prepare("SELECT 1 FROM schema_versions WHERE version=13").get())
    return;
  db.transaction(() => {
    db.exec(`CREATE TABLE director_type_descriptions (
      series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
      type_id TEXT NOT NULL, fingerprint TEXT NOT NULL, data TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(series_id,type_id,fingerprint)
    )`);
    db.prepare("INSERT INTO schema_versions VALUES(13,?)").run(Date.now());
  })();
}
