import type Database from "better-sqlite3";
import { mergeGlossaryLists, parseGlossary, serializeGlossary } from "../../glossary";
import { pruneExportJobs, unlinkAssetFiles, unreferencedAssets } from "../exportRetention";

/** Additive, transactional migrations. Existing comments and upload paths remain intact. */
export function migrateWorkflow(db: Database.Database) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_versions(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  if (db.prepare("SELECT 1 FROM schema_versions WHERE version=1").get()) return;
  db.transaction(() => {
    db.exec(`
ALTER TABLE lines ADD COLUMN source TEXT NOT NULL DEFAULT '';
ALTER TABLE lines ADD COLUMN ocr_confidence REAL;
ALTER TABLE lines ADD COLUMN source_state TEXT NOT NULL DEFAULT 'unreadable';
ALTER TABLE lines ADD COLUMN ignore_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE lines ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE images ADD COLUMN page_number INTEGER;
ALTER TABLE images ADD COLUMN dpi REAL NOT NULL DEFAULT 72;
ALTER TABLE episodes ADD COLUMN numbering_stale INTEGER NOT NULL DEFAULT 1;
ALTER TABLE episodes ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
UPDATE lines SET source=COALESCE((SELECT substr(body,9) FROM comments WHERE line_id=lines.id AND body LIKE 'Source: %' ORDER BY created_at DESC LIMIT 1),'');
UPDATE lines SET source_state='read' WHERE source<>'';
CREATE TABLE workflow_docs (
 id TEXT PRIMARY KEY, episode_id TEXT REFERENCES episodes(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}',
 undo TEXT NOT NULL DEFAULT '[]', redo TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL
);
CREATE TABLE workflow_revisions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, episode_id TEXT NOT NULL,
 entity_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX idx_workflow_history ON workflow_revisions(entity_id,revision);
CREATE TABLE font_assets (
 id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
 hash TEXT NOT NULL, filename TEXT NOT NULL, metadata TEXT NOT NULL, created_at INTEGER NOT NULL,
 UNIQUE(series_id,hash)
);
CREATE TABLE suggestions (
 id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
 line_id TEXT NOT NULL REFERENCES lines(id) ON DELETE CASCADE, base_revision INTEGER NOT NULL,
 body TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL,
 UNIQUE(line_id,base_revision,body,kind)
);
CREATE TABLE workflow_jobs (
 id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL, progress TEXT NOT NULL DEFAULT '{}',
 error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_workflow_jobs_episode ON workflow_jobs(episode_id,created_at);
CREATE TABLE job_pages (
 job_id TEXT NOT NULL REFERENCES workflow_jobs(id) ON DELETE CASCADE,
 image_id TEXT NOT NULL, state TEXT NOT NULL, error TEXT, PRIMARY KEY(job_id,image_id)
);
CREATE TRIGGER lines_history BEFORE UPDATE OF body,source,ocr_confidence,source_state,ignore_reason,line_type,status,x,y,w,h,image_id,sort_order ON lines BEGIN
 INSERT INTO workflow_revisions(episode_id,entity_id,revision,data,created_at)
 VALUES(OLD.episode_id,OLD.id,OLD.revision,json_object('body',OLD.body,'source',OLD.source,'status',OLD.status,'sourceState',OLD.source_state,'ignoreReason',OLD.ignore_reason,'lineType',OLD.line_type,'x',OLD.x,'y',OLD.y,'w',OLD.w,'h',OLD.h,'sortOrder',OLD.sort_order),unixepoch()*1000);
END;
CREATE TRIGGER lines_version AFTER UPDATE OF body,source,ocr_confidence,source_state,ignore_reason,line_type,status,x,y,w,h,image_id,sort_order ON lines BEGIN
 UPDATE lines SET revision=OLD.revision+1 WHERE id=NEW.id;
 UPDATE episodes SET revision=revision+1 WHERE id=NEW.episode_id;
END;
CREATE TRIGGER lines_insert_revision AFTER INSERT ON lines BEGIN
 UPDATE episodes SET revision=revision+1 WHERE id=NEW.episode_id;
END;
CREATE TRIGGER lines_delete_revision AFTER DELETE ON lines BEGIN
 UPDATE episodes SET revision=revision+1 WHERE id=OLD.episode_id;
END;
CREATE TRIGGER images_number_insert AFTER INSERT ON images BEGIN
 UPDATE episodes SET numbering_stale=1,revision=revision+1 WHERE id=NEW.episode_id;
END;
CREATE TRIGGER images_number_delete AFTER DELETE ON images BEGIN
 UPDATE episodes SET numbering_stale=1,revision=revision+1 WHERE id=OLD.episode_id;
END;
CREATE TRIGGER images_number_order AFTER UPDATE OF sort_order ON images WHEN NEW.sort_order<>OLD.sort_order BEGIN
 UPDATE episodes SET numbering_stale=1,revision=revision+1 WHERE id=NEW.episode_id;
END;
CREATE TRIGGER images_revision AFTER UPDATE OF width,height,updated_at ON images BEGIN
 UPDATE episodes SET revision=revision+1 WHERE id=NEW.episode_id;
END;
`);
    db.prepare("INSERT INTO schema_versions VALUES(1,?)").run(Date.now());
  })();
}

export function migrateWorkflowV2(db: Database.Database) {
  if (db.prepare("SELECT 1 FROM schema_versions WHERE version=2").get()) return;
  db.transaction(() => {
    db.exec(`
ALTER TABLE comments ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE images ADD COLUMN caption_revision INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER comments_history BEFORE UPDATE OF body,correction ON comments BEGIN
 INSERT INTO workflow_revisions(episode_id,entity_id,revision,data,created_at)
 SELECT episode_id,'comment:'||OLD.id,OLD.revision,json_object('body',OLD.body,'correction',OLD.correction),unixepoch()*1000 FROM lines WHERE id=OLD.line_id;
END;
CREATE TRIGGER comments_version AFTER UPDATE OF body,correction ON comments BEGIN
 UPDATE comments SET revision=OLD.revision+1 WHERE id=NEW.id;
 UPDATE episodes SET revision=revision+1 WHERE id=(SELECT episode_id FROM lines WHERE id=NEW.line_id);
END;
CREATE TRIGGER captions_history BEFORE UPDATE OF caption ON images WHEN NEW.caption<>OLD.caption BEGIN
 INSERT INTO workflow_revisions(episode_id,entity_id,revision,data,created_at) VALUES(OLD.episode_id,'caption:'||OLD.id,OLD.caption_revision,json_object('caption',OLD.caption),unixepoch()*1000);
END;
CREATE TRIGGER captions_version AFTER UPDATE OF caption ON images WHEN NEW.caption<>OLD.caption BEGIN
 UPDATE images SET caption_revision=OLD.caption_revision+1 WHERE id=NEW.id;
 UPDATE episodes SET revision=revision+1 WHERE id=NEW.episode_id;
END;
CREATE TRIGGER lines_deleted_history BEFORE DELETE ON lines BEGIN
 INSERT INTO workflow_revisions(episode_id,entity_id,revision,data,created_at) VALUES(OLD.episode_id,OLD.id,OLD.revision,json_object('body',OLD.body,'source',OLD.source,'status',OLD.status,'sourceState',OLD.source_state,'ignoreReason',OLD.ignore_reason,'lineType',OLD.line_type,'imageId',OLD.image_id,'x',OLD.x,'y',OLD.y,'w',OLD.w,'h',OLD.h,'sortOrder',OLD.sort_order,'deleted',1),unixepoch()*1000);
END;
`);
    db.prepare("INSERT INTO schema_versions VALUES(2,?)").run(Date.now());
  })();
}

/** Keep existing suggestions and allow distinct English translations of one reading. */
export function migrateReviewTranslations(db: Database.Database) {
  if (db.prepare("SELECT 1 FROM schema_versions WHERE version=4").get()) return;
  db.transaction(() => {
    db.exec(`
CREATE TABLE suggestions_with_translations (
 id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
 line_id TEXT NOT NULL REFERENCES lines(id) ON DELETE CASCADE, base_revision INTEGER NOT NULL,
 body TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL,
 translation TEXT NOT NULL DEFAULT '',
 UNIQUE(line_id,base_revision,body,kind,translation)
);
INSERT INTO suggestions_with_translations(id,episode_id,line_id,base_revision,body,reason,kind,state,created_at)
 SELECT id,episode_id,line_id,base_revision,body,reason,kind,state,created_at FROM suggestions;
DROP TABLE suggestions;
ALTER TABLE suggestions_with_translations RENAME TO suggestions;
`);
    db.prepare("INSERT INTO schema_versions VALUES(4,?)").run(Date.now());
  })();
}

/** Fold per-chapter glossaries into the series list. Episode column is left unused. */
export function migrateSeriesGlossary(db: Database.Database) {
  if (db.prepare("SELECT 1 FROM schema_versions WHERE version=5").get()) return;
  db.transaction(() => {
    const seriesRows = db.prepare("SELECT id, glossary FROM series").all() as { id: string; glossary: string }[];
    const episodeRows = db.prepare("SELECT series_id, glossary FROM episodes").all() as { series_id: string; glossary: string }[];
    const bySeries = new Map<string, string[]>();
    for (const row of episodeRows) {
      const list = bySeries.get(row.series_id) ?? [];
      list.push(row.glossary);
      bySeries.set(row.series_id, list);
    }
    const update = db.prepare("UPDATE series SET glossary=? WHERE id=?");
    for (const row of seriesRows) {
      const merged = mergeGlossaryLists(
        parseGlossary(row.glossary),
        ...(bySeries.get(row.id) ?? []).map((raw) => parseGlossary(raw)),
      );
      update.run(serializeGlossary(merged), row.id);
    }
    db.prepare("INSERT INTO schema_versions VALUES(5,?)").run(Date.now());
  })();
}

/** Series pre/post credits templates and per-page role. */
export function migrateSeriesCredits(db: Database.Database) {
  if (db.prepare("SELECT 1 FROM schema_versions WHERE version=6").get()) return;
  db.transaction(() => {
    const seriesCols = db.pragma("table_info(series)") as { name: string }[];
    if (!seriesCols.some((c) => c.name === "credits"))
      db.exec("ALTER TABLE series ADD COLUMN credits TEXT NOT NULL DEFAULT '{}'");
    const imageCols = db.pragma("table_info(images)") as { name: string }[];
    if (!imageCols.some((c) => c.name === "role"))
      db.exec("ALTER TABLE images ADD COLUMN role TEXT NOT NULL DEFAULT 'page'");
    db.prepare("INSERT INTO schema_versions VALUES(6,?)").run(Date.now());
  })();
}

/** Lookups for the editor poll, plus one kept export per chapter. */
export function migrateEditorHotPath(db: Database.Database) {
  if (db.prepare("SELECT 1 FROM schema_versions WHERE version=7").get()) return;
  const hashes = db.transaction(() => {
    db.exec(`
CREATE INDEX IF NOT EXISTS idx_workflow_docs_episode ON workflow_docs(episode_id, id, data);
CREATE INDEX IF NOT EXISTS idx_workflow_revisions_episode ON workflow_revisions(episode_id);
CREATE INDEX IF NOT EXISTS idx_suggestions_episode ON suggestions(episode_id, created_at);
`);
    const removed = pruneExportJobs(db);
    db.prepare("INSERT INTO schema_versions VALUES(7,?)").run(Date.now());
    return removed.hashes;
  })();
  unlinkAssetFiles(unreferencedAssets(db, hashes));
}
