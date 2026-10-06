import { migrateTranslationDashes } from './translationDashes';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { DB_PATH, ensureDataDirs } from '../paths';
import * as schema from './schema';
import { migrateWorkflow, migrateWorkflowV2, migrateReviewTranslations, migrateSeriesGlossary, migrateSeriesCredits, migrateEditorHotPath, migrateLinePlacementRevisions } from './workflowMigration';

ensureDataDirs();
mkdirSync(dirname(DB_PATH), { recursive: true });

const client = new Database(DB_PATH);
client.pragma('journal_mode = WAL');
client.pragma('foreign_keys = ON');

client.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS series (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS series_members (
  series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (series_id, user_id)
);
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'raws',
  preview_token TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lines (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  image_id TEXT REFERENCES images(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  line_type TEXT NOT NULL DEFAULT 'plain',
  status TEXT NOT NULL DEFAULT 'none',
  placed INTEGER NOT NULL DEFAULT 0,
  invert INTEGER,
  x REAL,
  y REAL,
  w REAL,
  h REAL,
  sidebar_x REAL,
  sidebar_y REAL,
  sidebar_w REAL,
  sidebar_h REAL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  line_id TEXT NOT NULL REFERENCES lines(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  correction INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  series_id TEXT REFERENCES series(id) ON DELETE CASCADE,
  episode_id TEXT REFERENCES episodes(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_episodes_series ON episodes(series_id);
CREATE INDEX IF NOT EXISTS idx_images_episode ON images(episode_id);
CREATE INDEX IF NOT EXISTS idx_lines_episode ON lines(episode_id);
CREATE INDEX IF NOT EXISTS idx_comments_line ON comments(line_id);
CREATE INDEX IF NOT EXISTS idx_activity_episode ON activity(episode_id);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity(user_id, created_at);
`);

const lineCols = client.pragma('table_info(lines)') as { name: string }[];
if (!lineCols.some((c) => c.name === 'invert')) {
	client.exec('ALTER TABLE lines ADD COLUMN invert INTEGER');
}

const commentCols = client.pragma('table_info(comments)') as { name: string }[];
if (!commentCols.some((c) => c.name === 'correction')) {
	client.exec('ALTER TABLE comments ADD COLUMN correction INTEGER NOT NULL DEFAULT 0');
}

const episodeCols = client.pragma('table_info(episodes)') as { name: string }[];
if (!episodeCols.some((c) => c.name === 'preview_token')) {
	client.exec('ALTER TABLE episodes ADD COLUMN preview_token TEXT');
	client.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_preview_token ON episodes(preview_token)');
}

const imageCols = client.pragma('table_info(images)') as { name: string }[];
if (!imageCols.some((c) => c.name === 'updated_at')) {
	client.exec('ALTER TABLE images ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0');
	client.exec('UPDATE images SET updated_at = created_at WHERE updated_at = 0');
}
if (!imageCols.some((c) => c.name === 'caption')) {
	client.exec("ALTER TABLE images ADD COLUMN caption TEXT NOT NULL DEFAULT ''");
}
if (!imageCols.some((c) => c.name === 'role')) {
	client.exec("ALTER TABLE images ADD COLUMN role TEXT NOT NULL DEFAULT 'page'");
}

const seriesCols = client.pragma('table_info(series)') as { name: string }[];
if (!seriesCols.some((c) => c.name === 'glossary')) {
	client.exec("ALTER TABLE series ADD COLUMN glossary TEXT NOT NULL DEFAULT '[]'");
}
if (!seriesCols.some((c) => c.name === 'credits')) {
	client.exec("ALTER TABLE series ADD COLUMN credits TEXT NOT NULL DEFAULT '{}'");
}
if (!seriesCols.some((c) => c.name === 'created_by')) {
	client.exec('ALTER TABLE series ADD COLUMN created_by TEXT REFERENCES users(id) ON DELETE SET NULL');
}

const userCols = client.pragma('table_info(users)') as { name: string }[];
if (!userCols.some((c) => c.name === 'created_by')) {
	client.exec('ALTER TABLE users ADD COLUMN created_by TEXT REFERENCES users(id) ON DELETE SET NULL');
}
if (!userCols.some((c) => c.name === 'settings')) {
	client.exec("ALTER TABLE users ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'");
}

const sessionCols = client.pragma('table_info(sessions)') as { name: string }[];
if (!sessionCols.some((c) => c.name === 'last_seen_at')) {
	client.exec('ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0');
}
client.exec('CREATE INDEX IF NOT EXISTS idx_activity_user ON activity(user_id, created_at)');

if (!episodeCols.some((c) => c.name === 'glossary')) {
	client.exec("ALTER TABLE episodes ADD COLUMN glossary TEXT NOT NULL DEFAULT '[]'");
}

migrateWorkflow(client);
migrateWorkflowV2(client);
migrateTranslationDashes(client);
migrateReviewTranslations(client);
migrateSeriesGlossary(client);
migrateSeriesCredits(client);
client.exec(`CREATE TABLE IF NOT EXISTS global_font_assets (
 id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, filename TEXT NOT NULL,
 metadata TEXT NOT NULL, created_at INTEGER NOT NULL
)`);
migrateEditorHotPath(client);
migrateLinePlacementRevisions(client);

export const db = drizzle(client, { schema });
export { client as sqlite };
