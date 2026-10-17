import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { copyFile, link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import Database from 'better-sqlite3';
import * as yazl from 'yazl';
import * as yauzl from 'yauzl';
import { sqlite } from './db';
import { DATA_DIR, IMAGES_DIR } from './paths';
import { WorkflowError } from './workflowStore';
import { episodeDir } from './storage';
import { assertEpisodeIdle, isRegionQueueBusy } from './aiTranslate';
import { canCreateSeries, canUpload, hasSeriesAccess } from './access';
import { lockSeries } from './seriesMaintenance';
import { broadcast } from './realtime';
import type { PublicUser } from '../types';

type Row = Record<string, string | number | null>;
const FORMAT = 'komatose-series-backup';
const VERSION = 2;
const HASH = /^[a-f0-9]{64}$/;
const BACKUPS = join(DATA_DIR, 'series-backups');
// No migration/import compatibility layer: the archive must match this schema exactly.
const selections = {
  series: 'id=?', series_members: 'series_id=?', episodes: 'series_id=?',
  images: 'episode_id IN (SELECT id FROM episodes WHERE series_id=?)',
  lines: 'episode_id IN (SELECT id FROM episodes WHERE series_id=?)',
  comments: 'line_id IN (SELECT l.id FROM lines l JOIN episodes e ON e.id=l.episode_id WHERE e.series_id=?)',
  font_assets: 'series_id=?',
  workflow_docs: "episode_id IN (SELECT id FROM episodes WHERE series_id=?1) OR id='series:'||?1",
  workflow_revisions: "episode_id IN (SELECT id FROM episodes WHERE series_id=?1) OR entity_id='series:'||?1",
  workflow_jobs: 'episode_id IN (SELECT id FROM episodes WHERE series_id=?)',
  job_pages: 'job_id IN (SELECT j.id FROM workflow_jobs j JOIN episodes e ON e.id=j.episode_id WHERE e.series_id=?)',
  suggestions: 'episode_id IN (SELECT id FROM episodes WHERE series_id=?)',
  activity: 'series_id=?1 OR episode_id IN (SELECT id FROM episodes WHERE series_id=?1)',
  director_runs: 'episode_id IN (SELECT id FROM episodes WHERE series_id=?)',
  director_pages: 'episode_id IN (SELECT id FROM episodes WHERE series_id=?)',
  director_events: 'episode_id IN (SELECT id FROM episodes WHERE series_id=?)',
  director_changes: 'episode_id IN (SELECT id FROM episodes WHERE series_id=?)',
  director_assets: 'run_id IN (SELECT r.id FROM director_runs r JOIN episodes e ON e.id=r.episode_id WHERE e.series_id=?)',
  director_stages: 'run_id IN (SELECT r.id FROM director_runs r JOIN episodes e ON e.id=r.episode_id WHERE e.series_id=?)',
  director_operations: 'episode_id IN (SELECT id FROM episodes WHERE series_id=?)',
  director_series: 'series_id=?', director_examples: 'series_id=?', director_memory_assets: 'series_id=?',
  director_created_types: 'series_id=?',
  director_classifications: 'line_id IN (SELECT l.id FROM lines l JOIN episodes e ON e.id=l.episode_id WHERE e.series_id=?)',
} as const;
const tables = [...Object.keys(selections), 'global_font_assets'];
type Snapshot = { tables: Record<string, Row[]> };
type FileEntry = { path: string; size: number; sha256: string };
type Manifest = Snapshot & { format: string; version: number; schema: string; createdAt: number; label: string; imageRoot: string; files: FileEntry[] };
export type SeriesBackup = { id: string; seriesId: string; seriesTitle: string; label: string; createdAt: number; createdBy: string; chapters: number; pages: number; regions: number; bytes: number; safety: boolean };

function schema() {
  return createHash('sha256').update(JSON.stringify(sqlite.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all())).digest('hex');
}
function rowsHash(rows: Row[]) {
  const hash = createHash('sha256');
  for (const row of rows) hash.update(JSON.stringify(row) + '\n');
  return hash.digest('hex');
}
function snapshotHash(saved: Snapshot) {
  return Object.entries(saved.tables).map(([table, rows]) => `${table}:${rowsHash(rows)}`).join('|');
}
function referencedHashes(saved: Snapshot) {
  const hashes = new Set<string>();
  for (const rows of Object.values(saved.tables)) for (const row of rows)
    for (const hash of JSON.stringify(row).match(/[a-f0-9]{64}/g) ?? []) hashes.add(hash);
  return hashes;
}
function directory(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new WorkflowError('Backup not found', 404);
  return join(BACKUPS, id);
}
function seriesDirectory(slug: string) { return join(episodeDir(slug, 'placeholder'), '..'); }

function snapshot(seriesId: string, client = sqlite): Snapshot {
  const result: Snapshot = { tables: {} };
  for (const [table, where] of Object.entries(selections))
    result.tables[table] = (where.includes('?1')
      ? client.prepare(`SELECT * FROM "${table}" WHERE ${where.replaceAll('?1', '@seriesId')} ORDER BY rowid`).all({ seriesId })
      : client.prepare(`SELECT * FROM "${table}" WHERE ${where} ORDER BY rowid`).all(seriesId)) as Row[];
  if (result.tables.series.length !== 1) throw new WorkflowError('Series not found', 404);
  // Shared fonts used in current documents or history travel with the backup.
  const references = referencedHashes(result);
  result.tables.global_font_assets = (client.prepare('SELECT * FROM global_font_assets ORDER BY rowid').all() as Row[])
    .filter(row => references.has(String(row.id)) || references.has(String(row.hash)));
  return result;
}

function idle(seriesId: string) {
  const episodes = sqlite.prepare('SELECT id FROM episodes WHERE series_id=?').all(seriesId) as { id: string }[];
  for (const ep of episodes) {
    assertEpisodeIdle(ep.id);
    if (isRegionQueueBusy(ep.id)) throw new WorkflowError('Finish or cancel series jobs before backing up or restoring.', 409);
  }
  if (sqlite.prepare("SELECT 1 FROM workflow_jobs j JOIN episodes e ON e.id=j.episode_id WHERE e.series_id=? AND j.state IN ('running','queued','cancelling') LIMIT 1").get(seriesId) ||
      sqlite.prepare("SELECT 1 FROM director_runs r JOIN episodes e ON e.id=r.episode_id WHERE e.series_id=? AND r.state IN ('running','pausing','stopping') LIMIT 1").get(seriesId))
    throw new WorkflowError('Finish or cancel series jobs before backing up or restoring.', 409);
}

export async function authorizeSeriesBackup(user: PublicUser, seriesId: string, createdBy?: string) {
  if (!canUpload(user)) throw new WorkflowError('Forbidden', 403);
  const existing = sqlite.prepare('SELECT id FROM series WHERE id=?').get(seriesId);
  if (existing) {
    if (!(await hasSeriesAccess(user, seriesId))) throw new WorkflowError('Forbidden', 403);
  } else if (!canCreateSeries(user) || (user.role !== 'admin' && createdBy !== user.id)) {
    throw new WorkflowError('Forbidden', 403);
  }
}

export async function getSeriesBackup(id: string, user: PublicUser): Promise<SeriesBackup> {
  let metadata: SeriesBackup;
  try { metadata = JSON.parse(await readFile(join(directory(id), 'metadata.json'), 'utf8')); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkflowError('Backup not found', 404);
    throw e;
  }
  await authorizeSeriesBackup(user, metadata.seriesId, metadata.createdBy);
  return metadata;
}

export async function listSeriesBackups(user: PublicUser) {
  let entries: string[];
  try { entries = await readdir(BACKUPS); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  const result: SeriesBackup[] = [];
  for (const id of entries.filter(id => /^[a-f0-9-]{36}$/.test(id))) {
    try { result.push(await getSeriesBackup(id, user)); }
    catch (e) { if (!(e instanceof WorkflowError && [403, 404].includes(e.status))) throw e; }
  }
  return result.sort((a, b) => b.createdAt - a.createdAt);
}

async function tree(root: string, current = root): Promise<string[]> {
  if (!existsSync(current)) return [];
  const files: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new WorkflowError('Series image folders cannot contain symbolic links.');
    if (entry.isDirectory()) files.push(...await tree(root, path));
    else if (entry.isFile()) files.push(relative(root, path).split('\\').join('/'));
    else throw new WorkflowError('Series image folders contain an unsupported file.');
  }
  return files.sort();
}

async function fileDigest(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function validateCurrentAssets(saved: Snapshot, assets: Set<string>) {
  const required = new Set<string>();
  for (const table of ['font_assets', 'global_font_assets', 'director_assets', 'director_memory_assets'])
    for (const row of saved.tables[table]) if (typeof row.hash === 'string') required.add(row.hash);
  const liveDocs = new Set([`series:${saved.tables.series[0].id}`, ...saved.tables.images.map(row => `page:${row.id}`), ...saved.tables.lines.map(row => `region:${row.id}`)]);
  for (const row of saved.tables.workflow_docs.filter(row => liveDocs.has(String(row.id)))) {
    const data = JSON.parse(String(row.data));
    for (const key of ['prepared','original','cleaned','cleanBase','thumbnail','previousArtwork','mask','textMask'])
      if (HASH.test(data[key] ?? '')) required.add(data[key]);
  }
  const credits = JSON.parse(String(saved.tables.series[0].credits));
  for (const value of Object.values(credits) as { hash?: string }[]) if (value?.hash) required.add(value.hash);
  for (const hash of required) if (!assets.has(hash)) throw new WorkflowError(`A referenced artwork or font file is missing (${hash.slice(0, 12)}). The backup was not saved.`);
}

async function saveArchive(manifest: Manifest, zip: yazl.ZipFile | string, userId: string, safety: boolean): Promise<SeriesBackup> {
  const id = randomUUID(), temporary = join(BACKUPS, `.creating-${id}`);
  await mkdir(temporary, { recursive: true });
  try {
    if (typeof zip === 'string') await copyFile(zip, join(temporary, 'backup.zip'));
    else {
      const tableHashes = Object.fromEntries(Object.entries(manifest.tables).map(([table, rows]) => [table, rowsHash(rows)]));
      for (const [table, rows] of Object.entries(manifest.tables))
        zip.addReadStreamLazy(`tables/${table}.jsonl`, { compress: true }, callback => callback(null, Readable.from((async function* () {
          for (const row of rows) yield Buffer.from(JSON.stringify(row) + '\n');
        })())));
      const header = { ...manifest, tables: Object.fromEntries(Object.entries(manifest.tables).map(([table, rows]) => [table, rows.length])), tableHashes };
      zip.addBuffer(Buffer.from(JSON.stringify(header)), 'manifest.json', { compress: true });
      zip.on('error', error => (zip.outputStream as Readable).destroy(error));
      const written = pipeline(zip.outputStream, createWriteStream(join(temporary, 'backup.zip')));
      zip.end({ forceZip64Format: true, comment: '' });
      await written;
    }
    const series = manifest.tables.series[0];
    const metadata: SeriesBackup = { id, seriesId: String(series.id), seriesTitle: String(series.title), label: manifest.label, createdAt: manifest.createdAt, createdBy: userId,
      chapters: manifest.tables.episodes.length, pages: manifest.tables.images.length, regions: manifest.tables.lines.length,
      bytes: (await stat(join(temporary, 'backup.zip'))).size, safety };
    await writeFile(join(temporary, 'metadata.json'), JSON.stringify(metadata));
    await rename(temporary, directory(id));
    return metadata;
  } catch (e) { await rm(temporary, { recursive: true, force: true }); throw e; }
}

async function createLocked(seriesId: string, userId: string, label: string, safety: boolean) {
  idle(seriesId);
  const saved = sqlite.transaction(() => snapshot(seriesId))();
  const imageRoot = seriesDirectory(String(saved.tables.series[0].slug));
  const zip = new yazl.ZipFile(), files: FileEntry[] = [];
  const names = await tree(imageRoot);
  for (const image of saved.tables.images) {
    const chapter = saved.tables.episodes.find(ep => ep.id === image.episode_id)!;
    const name = `${chapter.slug}/${image.filename}`;
    if (!names.includes(name) && !names.includes(`${name}.orig`)) throw new WorkflowError(`Missing page file: ${image.original_name}. The backup was not saved.`);
  }
  const hashes = referencedHashes(saved);
  // Page-organization undo stores geometry/artwork snapshots in files, outside
  // workflow_docs. Retain assets used only by those snapshots as well.
  for (const name of names.filter(name => name.endsWith('/undo.json')))
    for (const hash of (await readFile(join(imageRoot, name), 'utf8')).match(/[a-f0-9]{64}/g) ?? []) hashes.add(hash);
  const assets = new Set([...hashes].filter(hash => existsSync(join(DATA_DIR, 'workflow/assets', hash))));
  validateCurrentAssets(saved, assets);
  const sources = [...names.map(name => ({ name: `images/${name}`, path: join(imageRoot, name) })),
    ...[...assets].sort().map(hash => ({ name: `assets/${hash}`, path: join(DATA_DIR, 'workflow/assets', hash) }))];
  for (const source of sources) {
    const file = { path: source.name, size: (await stat(source.path)).size, sha256: await fileDigest(source.path) };
    files.push(file);
    zip.addReadStreamLazy(source.name, { compress: false, size: file.size }, callback => callback(null, Readable.from((async function* () {
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of createReadStream(source.path)) { hash.update(chunk); size += chunk.length; yield chunk; }
      if (size !== file.size || hash.digest('hex') !== file.sha256) throw new WorkflowError('A series file changed during backup. Try again.', 409);
    })())));
  }
  const manifest: Manifest = { ...saved, format: FORMAT, version: VERSION, schema: schema(), label: label.trim().slice(0, 120) || 'Series backup', createdAt: Date.now(), imageRoot, files };
  // No editor writes/jobs can start while the series lock is held. Also check
  // dependencies such as shared fonts that are edited outside the series.
  if (snapshotHash(snapshot(seriesId)) !== snapshotHash(saved)) throw new WorkflowError('The series changed during backup. Try again.', 409);
  return saveArchive(manifest, zip, userId, safety);
}

export async function createSeriesBackup(seriesId: string, user: PublicUser, label = '') {
  await authorizeSeriesBackup(user, seriesId);
  const release = lockSeries(seriesId, 'backup');
  try { return await createLocked(seriesId, user.id, label, false); }
  finally { release(); }
}

function safePath(path: string) {
  return typeof path === 'string' && !path.includes('\\') && !path.includes('\0') && path.split('/').every(part => part && part !== '.' && part !== '..') &&
    (/^assets\/[a-f0-9]{64}$/.test(path) || path.startsWith('images/') || tables.some(table => path === `tables/${table}.jsonl`));
}

function validateUndoDirectories(value: unknown, imageRoot: string) {
  if (Array.isArray(value)) { for (const item of value) validateUndoDirectories(item, imageRoot); }
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'dir' && (typeof item !== 'string' || !item.startsWith(`${imageRoot}/`) || item.includes('\\') || item.includes('\0') || item.split('/').includes('..')))
        throw new WorkflowError('The backup undo history refers to a folder outside this series.');
      validateUndoDirectories(item, imageRoot);
    }
  }
}

function insertRows(client: Database.Database, table: string, rows: Row[], ignore = false) {
  const columns = (client.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(row => row.name);
  const statement = client.prepare(`INSERT ${ignore ? 'OR IGNORE ' : ''}INTO "${table}" (${columns.map(name => `"${name}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
  for (const row of rows) {
    if (!row || Array.isArray(row) || Object.keys(row).length !== columns.length || columns.some(name => !(name in row)) ||
        Object.values(row).some(value => value !== null && typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))))
      throw new WorkflowError('The backup contains an invalid database record.');
    statement.run(...columns.map(name => row[name]));
  }
}

function validateRows(manifest: Manifest) {
  const client = new Database(':memory:');
  try {
    const definitions = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { sql: string }[];
    for (const row of definitions) client.exec(row.sql);
    client.pragma('foreign_keys = ON');
    for (const user of sqlite.prepare('SELECT id FROM users').all() as { id: string }[])
      client.prepare("INSERT INTO users(id,username,password_hash,role,created_at) VALUES(?,?,'unused','admin',1)").run(user.id, user.id);
    client.transaction(() => {
      client.pragma('defer_foreign_keys = ON');
      for (const table of tables) insertRows(client, table, manifest.tables[table]);
    })();
    const id = String(manifest.tables.series[0].id);
    const selected = snapshot(id, client);
    for (const table of Object.keys(selections))
      if (rowsHash(selected.tables[table]) !== rowsHash(manifest.tables[table])) throw new WorkflowError('The backup contains records outside this series.');
    for (const series of manifest.tables.series) seriesDirectory(String(series.slug));
    for (const ep of manifest.tables.episodes) episodeDir(String(manifest.tables.series[0].slug), String(ep.slug));
    for (const image of manifest.tables.images) {
      if (!safePath(`images/${image.filename}`) || String(image.filename).includes('/')) throw new WorkflowError('Invalid backup page filename.');
      const chapter = manifest.tables.episodes.find(ep => ep.id === image.episode_id)!;
      if (!manifest.files.some(file => file.path === `images/${chapter.slug}/${image.filename}` || file.path === `images/${chapter.slug}/${image.filename}.orig`)) throw new WorkflowError('The backup is missing a page file.');
    }
    validateCurrentAssets(manifest, new Set(manifest.files.filter(file => file.path.startsWith('assets/')).map(file => file.path.slice(7))));
  } catch (e) {
    if (e instanceof WorkflowError) throw e;
    throw new WorkflowError('The backup contains invalid records or references accounts that no longer exist.');
  } finally { client.close(); }
}

async function readStreamBuffer(stream: Readable, limit: number) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) { stream.destroy(); throw new WorkflowError('Backup metadata exceeds the supported size.'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readArchive(path: string) {
  let zip: yauzl.ZipFile;
  try { zip = await yauzl.openPromise(path, { autoClose: false, strictFileNames: true, validateEntrySizes: true }); }
  catch { throw new WorkflowError('Choose a complete Komatose series backup ZIP.'); }
  try {
    const entries = new Map<string, yauzl.Entry>();
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName.endsWith('/')) continue;
      if (entries.has(entry.fileName) || (entry.fileName !== 'manifest.json' && !safePath(entry.fileName))) throw new WorkflowError('The backup contains unsafe or duplicate file paths.');
      entries.set(entry.fileName, entry);
    }
    const manifestEntry = entries.get('manifest.json');
    if (!manifestEntry || manifestEntry.uncompressedSize > 256 * 1024 * 1024) throw new WorkflowError('Invalid backup manifest.');
    let manifest: Manifest;
    try { manifest = JSON.parse((await readStreamBuffer(await zip.openReadStreamPromise(manifestEntry), 256 * 1024 * 1024)).toString()); }
    catch { throw new WorkflowError('Invalid backup manifest.'); }
    if (manifest.format !== FORMAT || manifest.version !== VERSION || manifest.schema !== schema())
      throw new WorkflowError('This backup requires the app version that created it. Backup migration is not supported.');
    if (!manifest.tables || Object.keys(manifest.tables).sort().join() !== [...tables].sort().join() ||
        tables.some(table => !Number.isSafeInteger(manifest.tables[table]) || Number(manifest.tables[table]) < 0) || Number(manifest.tables.series) !== 1 ||
        !Array.isArray(manifest.files) || typeof manifest.imageRoot !== 'string' || typeof manifest.label !== 'string' || !Number.isFinite(manifest.createdAt))
      throw new WorkflowError('Invalid backup manifest.');
    const header = manifest as unknown as { tables: Record<string, number>; tableHashes: Record<string, string> };
    if (!header.tableHashes) throw new WorkflowError('Invalid backup table checksums.');
    const rows: Record<string, Row[]> = {};
    for (const table of tables) {
      const entry = entries.get(`tables/${table}.jsonl`);
      if (!entry || !HASH.test(header.tableHashes[table] ?? '')) throw new WorkflowError('The backup is missing saved data.');
      rows[table] = [];
      const lines = createInterface({ input: await zip.openReadStreamPromise(entry), crlfDelay: Infinity });
      try { for await (const line of lines) rows[table].push(JSON.parse(line)); }
      catch { throw new WorkflowError('The backup contains invalid saved data.'); }
      finally { lines.close(); }
      if (rows[table].length !== header.tables[table] || rowsHash(rows[table]) !== header.tableHashes[table]) throw new WorkflowError('The backup is damaged: saved data failed its integrity check.');
    }
    manifest.tables = rows;
    const names = new Set<string>();
    for (const file of manifest.files) {
      if (!safePath(file.path) || (!file.path.startsWith('images/') && !file.path.startsWith('assets/')) || names.has(file.path) || !HASH.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0)
        throw new WorkflowError('Invalid backup file manifest.');
      names.add(file.path);
      const entry = entries.get(file.path);
      if (!entry || entry.uncompressedSize !== file.size) throw new WorkflowError('The backup has missing or damaged files.');
      const stream = await zip.openReadStreamPromise(entry), hash = createHash('sha256');
      for await (const chunk of stream) hash.update(chunk);
      if (hash.digest('hex') !== file.sha256 || (file.path.startsWith('assets/') && file.path.slice(7) !== file.sha256))
        throw new WorkflowError('The backup is damaged: a file failed its integrity check.');
      if (file.path.startsWith('images/') && file.path.endsWith('/undo.json')) {
        let undo: unknown;
        try { undo = JSON.parse((await readStreamBuffer(await zip.openReadStreamPromise(entry), 256 * 1024 * 1024)).toString()); }
        catch { throw new WorkflowError('The backup has invalid page undo history.'); }
        validateUndoDirectories(undo, manifest.imageRoot);
      }
    }
    for (const name of entries.keys()) if (name !== 'manifest.json' && !tables.some(table => name === `tables/${table}.jsonl`) && !names.has(name)) throw new WorkflowError('The backup contains unexpected files.');
    validateRows(manifest);
    if (manifest.tables.workflow_jobs.some(row => ['running','queued','cancelling'].includes(String(row.state))) ||
        manifest.tables.director_runs.some(row => ['running','pausing','stopping'].includes(String(row.state))))
      throw new WorkflowError('Backups cannot contain active jobs. Finish or cancel the jobs before backing up.');
    return { manifest, stream: (name: string) => zip.openReadStreamPromise(entries.get(name)!), close: () => zip.close() };
  } catch (error) { zip.close(); throw error; }
}

export async function importSeriesBackup(input: Buffer | string, user: PublicUser) {
  if (!canUpload(user)) throw new WorkflowError('Forbidden', 403);
  const temporary = Buffer.isBuffer(input) ? join(BACKUPS, `.import-${randomUUID()}.zip`) : null;
  if (temporary) { await mkdir(BACKUPS, { recursive: true }); await writeFile(temporary, input); }
  let archive: Awaited<ReturnType<typeof readArchive>> | undefined;
  try {
    const path = temporary ?? input as string;
    archive = await readArchive(path);
    await authorizeSeriesBackup(user, String(archive.manifest.tables.series[0].id), user.id);
    return await saveArchive(archive.manifest, path, user.id, false);
  } finally {
    archive?.close();
    if (temporary) await rm(temporary, { force: true });
  }
}

/** Stream the browser File upload to disk rather than buffering a whole ZIP. */
export async function receiveSeriesBackup(request: Request, user: PublicUser) {
  if (!canUpload(user)) throw new WorkflowError('Forbidden', 403);
  if (!request.body) throw new WorkflowError('Choose a series backup ZIP.');
  await mkdir(BACKUPS, { recursive: true });
  const path = join(BACKUPS, `.upload-${randomUUID()}.zip`);
  try {
    await pipeline(Readable.fromWeb(request.body as import('node:stream/web').ReadableStream), createWriteStream(path));
    return await importSeriesBackup(path, user);
  } finally { await rm(path, { force: true }); }
}

export function seriesBackupArchivePath(id: string) { return join(directory(id), 'backup.zip'); }

function relocate(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string' && (value === from || value.startsWith(`${from}/`))) return to + value.slice(from.length);
  if (Array.isArray(value)) return value.map(item => relocate(item, from, to));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocate(item, from, to)]));
  return value;
}

type RestoreJournal = { id: string; seriesId: string; currentSlug: string | null; restoredSlug: string; hadCurrentDirectory: boolean };
function journalPaths(journal: RestoreJournal) {
  const work = join(BACKUPS, `.restore-${journal.id}`);
  return { work, staged: join(work, 'images'), previous: join(work, 'previous'),
    current: journal.currentSlug ? seriesDirectory(journal.currentSlug) : null, restored: seriesDirectory(journal.restoredSlug) };
}

async function finishJournal(journal: RestoreJournal) {
  const paths = journalPaths(journal);
  const committed = sqlite.prepare("SELECT 1 FROM activity WHERE id=? AND action='restored_series_backup'").get(journal.id);
  if (!committed) {
    // The new tree was installed iff its staging directory is gone.
    if (!existsSync(paths.staged) && existsSync(paths.restored)) await rm(paths.restored, { recursive: true, force: true });
    if (existsSync(paths.previous) && paths.current) await rename(paths.previous, paths.current);
  }
  await rm(paths.work, { recursive: true, force: true });
}

/** Complete/roll back an interrupted filesystem swap before accepting requests. */
export async function recoverSeriesRestores() {
  if (!existsSync(BACKUPS)) return;
  for (const name of await readdir(BACKUPS)) {
    if (!/^\.restore-[a-f0-9-]{36}$/.test(name)) continue;
    const path = join(BACKUPS, name, 'journal.json');
    if (existsSync(path)) await finishJournal(JSON.parse(await readFile(path, 'utf8')));
    else await rm(join(BACKUPS, name), { recursive: true, force: true });
  }
}

function restoreRows(manifest: Manifest, current: Snapshot | null, actor: PublicUser, operationId: string, safetyBackupId: string | null) {
  const seriesId = String(manifest.tables.series[0].id);
  const oldEpisodes = [...new Set([...(current?.tables.episodes ?? []), ...manifest.tables.episodes].map(ep => ep.id))];
  const oldRevisions = new Map<string, number>();
  for (const table of tables) for (const row of current?.tables[table] ?? [])
    for (const field of ['revision', 'caption_revision']) if (typeof row[field] === 'number') oldRevisions.set(`${table}:${row.id ?? row.series_id}:${field}`, row[field] as number);
  const saved = Object.fromEntries(Object.entries(manifest.tables).map(([table, rows]) => [table, rows.map(row => ({ ...row }))]));
  // Access is installation data: preserve current grants on an existing series.
  if (current) saved.series_members = current.tables.series_members;
  const deltas = new Map<string, number>();
  for (const table of tables.filter(table => table !== 'workflow_revisions')) for (const row of saved[table]) for (const field of ['revision', 'caption_revision']) {
    if (typeof row[field] !== 'number') continue;
    const before = row[field] as number;
    row[field] = Math.max(before, oldRevisions.get(`${table}:${row.id ?? row.series_id}:${field}`) ?? before) + 1;
    if (table === 'lines' && field === 'revision') deltas.set(String(row.id), Number(row[field]) - before);
  }
  for (const suggestion of saved.suggestions) suggestion.base_revision = Number(suggestion.base_revision) + (deltas.get(String(suggestion.line_id)) ?? 0);
  sqlite.prepare("DELETE FROM workflow_docs WHERE id='series:'||?").run(seriesId);
  sqlite.prepare('DELETE FROM series WHERE id=?').run(seriesId);
  // Revisions deliberately have no FK; deletion triggers may add a final snapshot.
  for (const id of oldEpisodes) sqlite.prepare('DELETE FROM workflow_revisions WHERE episode_id=?').run(id);
  sqlite.prepare("DELETE FROM workflow_revisions WHERE entity_id='series:'||?").run(seriesId);
  for (const table of tables) insertRows(sqlite, table, saved[table], table === 'global_font_assets');
  // Insert triggers advance episode revisions/numbering. Restore the saved flags
  // after all child inserts, using fresh revisions to reject stale editor saves.
  for (const episode of saved.episodes) sqlite.prepare('UPDATE episodes SET revision=?,numbering_stale=? WHERE id=?').run(episode.revision, episode.numbering_stale, episode.id);
  sqlite.prepare('INSERT INTO activity(id,series_id,user_id,action,payload,created_at) VALUES(?,?,?,\'restored_series_backup\',?,?)')
    .run(operationId, seriesId, actor.id, JSON.stringify({ label: manifest.label, backupCreatedAt: manifest.createdAt, safetyBackupId }), Date.now());
  if ((sqlite.prepare('PRAGMA foreign_key_check').all() as unknown[]).length) throw new WorkflowError('Restore failed its database integrity check.');
}

export async function restoreSeriesBackup(id: string, user: PublicUser) {
  const metadata = await getSeriesBackup(id, user);
  const release = lockSeries(metadata.seriesId, 'restore');
  let journal: RestoreJournal | undefined;
  let archive: Awaited<ReturnType<typeof readArchive>> | undefined;
  try {
    idle(metadata.seriesId);
    archive = await readArchive(seriesBackupArchivePath(id));
    const { manifest } = archive;
    if (manifest.tables.series[0].id !== metadata.seriesId) throw new WorkflowError('Backup series identity does not match.');
    const existing = sqlite.prepare('SELECT slug FROM series WHERE id=?').get(metadata.seriesId) as { slug: string } | undefined;
    const current = existing ? snapshot(metadata.seriesId) : null;
    const restoredSlug = String(manifest.tables.series[0].slug);
    if (sqlite.prepare('SELECT 1 FROM series WHERE slug=? AND id<>?').get(restoredSlug, metadata.seriesId)) throw new WorkflowError('Another series uses the saved series folder name.', 409);
    const restoredPath = seriesDirectory(restoredSlug);
    if (existsSync(restoredPath) && existing?.slug !== restoredSlug) throw new WorkflowError('The saved series folder already exists. Its files were left untouched.', 409);
    const operationId = randomUUID();
    const work = join(BACKUPS, `.restore-${operationId}`);
    await mkdir(join(work, 'images'), { recursive: true });
    journal = { id: operationId, seriesId: metadata.seriesId, currentSlug: existing?.slug ?? null, restoredSlug, hadCurrentDirectory: !!existing && existsSync(seriesDirectory(existing.slug)) };
    const paths = journalPaths(journal);
    // The journal is written only after extraction; before that, recovery can
    // safely discard an abandoned staging directory without touching live files.
    for (const file of manifest.files) {
      const stream = await archive.stream(file.path);
      if (file.path.startsWith('assets/')) {
        const target = join(DATA_DIR, 'workflow/assets', file.path.slice(7));
        await mkdir(join(DATA_DIR, 'workflow/assets'), { recursive: true });
        if (existsSync(target) && await fileDigest(target) !== file.sha256) throw new WorkflowError('An existing artwork asset is damaged. Restore stopped before changing the series.');
        if (!existsSync(target)) {
          const temporary = join(work, file.path.slice(7));
          await pipeline(stream, createWriteStream(temporary));
          try { await link(temporary, target); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await fileDigest(target) !== file.sha256) throw error;
          }
          await rm(temporary);
        } else stream.destroy();
      } else {
        const name = file.path.slice(7), target = join(paths.staged, name);
        await mkdir(join(target, '..'), { recursive: true });
        if (name.endsWith('/undo.json')) await writeFile(target, JSON.stringify(relocate(JSON.parse((await readStreamBuffer(stream, 256 * 1024 * 1024)).toString()), manifest.imageRoot, restoredPath)));
        else await pipeline(stream, createWriteStream(target));
      }
    }
    const safety = current ? await createLocked(metadata.seriesId, user.id, `Before restoring: ${metadata.label}`, true) : null;
    idle(metadata.seriesId);
    if (current && snapshotHash(snapshot(metadata.seriesId)) !== snapshotHash(current)) throw new WorkflowError('The series changed during restore. Try again.', 409);
    await writeFile(join(work, 'journal.tmp'), JSON.stringify(journal));
    await rename(join(work, 'journal.tmp'), join(work, 'journal.json'));
    await mkdir(IMAGES_DIR, { recursive: true });
    if (journal.hadCurrentDirectory) await rename(paths.current!, paths.previous);
    await rename(paths.staged, paths.restored);
    sqlite.transaction(() => restoreRows(manifest, current, user, operationId, safety?.id ?? null))();
    await finishJournal(journal);
    journal = undefined;
    for (const ep of [...(current?.tables.episodes ?? []), ...manifest.tables.episodes])
      broadcast(String(ep.id), { type: 'workflow:changed', id: `chapter:${ep.id}`, revision: 0 });
    return { seriesId: metadata.seriesId, safetyBackupId: safety?.id ?? null };
  } catch (e) {
    if (journal) {
      const paths = journalPaths(journal);
      if (existsSync(join(paths.work, 'journal.json'))) await finishJournal(journal);
      else await rm(paths.work, { recursive: true, force: true });
    }
    throw e;
  } finally { archive?.close(); release(); }
}
