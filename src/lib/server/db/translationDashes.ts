import type Database from "better-sqlite3";
import { TRANSLATION_DASHES } from "../../translationText";

/** Enforce at the storage boundary for imports, AI, edits and suggestion acceptance. */
export function migrateTranslationDashes(db: Database.Database) {
  if (db.prepare("SELECT 1 FROM schema_versions WHERE version=3").get()) return;
  const normalized = (column: string) => TRANSLATION_DASHES.reduce(
    (sql, dash) => `replace(${sql},char(${dash.codePointAt(0)}),'-')`, column);
  db.transaction(() => {
    db.exec(`
      CREATE TRIGGER lines_ascii_dashes_insert AFTER INSERT ON lines
      WHEN NEW.body != ${normalized("NEW.body")}
      BEGIN
        UPDATE lines SET body=${normalized("NEW.body")} WHERE id=NEW.id;
      END;
      CREATE TRIGGER lines_ascii_dashes_update AFTER UPDATE OF body ON lines
      WHEN NEW.body != ${normalized("NEW.body")}
      BEGIN
        UPDATE lines SET body=${normalized("NEW.body")} WHERE id=NEW.id;
      END;
      UPDATE lines SET body=${normalized("body")} WHERE body != ${normalized("body")};
      INSERT INTO schema_versions(version,applied_at) VALUES(3,unixepoch()*1000);
    `);
  })();
}
