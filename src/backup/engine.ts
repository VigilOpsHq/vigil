import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { deliverOffsite, fetchFromStorage, notifyText } from './offsite';

const execFileAsync = promisify(execFile);

export const BACKUP_DIR = process.env.BACKUP_DIR ?? '/var/backups/vigil';
const KEEP_DAYS = parseInt(process.env.BACKUP_KEEP_DAYS ?? '7', 10);

export type DbEngine = 'postgres' | 'mysql' | 'mongodb';

export interface DbTarget {
  container: string;
  engine: DbEngine;
  database: string;
  user: string;
}

export interface BackupResult {
  file: string;
  path: string;
  sizeBytes: number;
  durationMs: number;
  offsite: string[];
}

export interface BackupFile {
  file: string;
  container: string;
  database: string;
  createdAt: Date;
  sizeBytes: number;
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
// <container>__<database>__<YYYYMMDD-HHMMSS>[_<tag>].<sql|archive>.gz
const FILE_RE = /^(.+?)__(.+)__(\d{8}-\d{6})(?:_([a-z-]+))?\.(sql|archive)\.gz$/;

function assertName(value: string, label: string): void {
  if (!NAME_RE.test(value)) throw new Error(`Invalid ${label}: "${value}"`);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function detectDatabase(container: string, database?: string): Promise<DbTarget> {
  assertName(container, 'container name');
  if (database) assertName(database, 'database name');

  let inspect: { Config: { Image: string; Env: string[] | null } };
  try {
    const { stdout } = await execFileAsync('docker', ['inspect', '--format', '{{json .}}', container]);
    inspect = JSON.parse(stdout);
  } catch {
    throw new Error(`Container "${container}" not found`);
  }

  const image = inspect.Config.Image.toLowerCase();
  const env: Record<string, string> = {};
  for (const kv of inspect.Config.Env ?? []) {
    const i = kv.indexOf('=');
    if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
  }

  if (/postgres|postgis|timescale/.test(image)) {
    const user = env.POSTGRES_USER || 'postgres';
    return { container, engine: 'postgres', user, database: database ?? (env.POSTGRES_DB || user) };
  }
  if (/mysql|mariadb/.test(image)) {
    const db = database ?? (env.MYSQL_DATABASE || env.MARIADB_DATABASE);
    if (!db) throw new Error(`Could not tell which database to back up in "${container}". Pass it: vigil backup ${container} <database>`);
    return { container, engine: 'mysql', user: 'root', database: db };
  }
  if (/mongo/.test(image)) {
    return { container, engine: 'mongodb', user: '', database: database ?? (env.MONGO_INITDB_DATABASE || 'all') };
  }
  throw new Error(`"${container}" (${inspect.Config.Image}) is not a Postgres, MySQL/MariaDB or MongoDB container`);
}

const MYSQL_PWD = 'MYSQL_PWD="${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}"';
const MONGO_AUTH =
  'if [ -n "$MONGO_INITDB_ROOT_USERNAME" ]; then set -- "$@" --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin; fi;';

function dumpArgs(t: DbTarget): string[] {
  switch (t.engine) {
    case 'postgres':
      return ['exec', t.container, 'pg_dump', '-U', t.user, '--clean', '--if-exists', '--no-owner', t.database];
    case 'mysql':
      return ['exec', t.container, 'sh', '-c',
        `${MYSQL_PWD} exec "$(command -v mysqldump || command -v mariadb-dump)" -uroot --single-transaction --routines --triggers "$1"`,
        'sh', t.database];
    case 'mongodb':
      return ['exec', t.container, 'sh', '-c',
        `db="$1"; shift; ${MONGO_AUTH} if [ "$db" != all ]; then set -- "$@" --db "$db"; fi; exec mongodump --archive --gzip --quiet "$@"`,
        'sh', t.database];
  }
}

function restoreArgs(t: DbTarget): string[] {
  switch (t.engine) {
    case 'postgres':
      return ['exec', '-i', t.container, 'psql', '-q', '-v', 'ON_ERROR_STOP=1', '-U', t.user, '-d', t.database];
    case 'mysql':
      return ['exec', '-i', t.container, 'sh', '-c',
        `${MYSQL_PWD} exec "$(command -v mysql || command -v mariadb)" -uroot "$1"`,
        'sh', t.database];
    case 'mongodb':
      return ['exec', '-i', t.container, 'sh', '-c',
        `db="$1"; shift; ${MONGO_AUTH} if [ "$db" != all ]; then set -- "$@" --nsInclude "$db.*"; fi; exec mongorestore --archive --gzip --drop --quiet "$@"`,
        'sh', t.database];
  }
}

function runDocker(args: string[], stdin: NodeJS.ReadableStream | null, stdout: NodeJS.WritableStream | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: [stdin ? 'pipe' : 'ignore', stdout ? 'pipe' : 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    const streams: Promise<void>[] = [];
    if (stdin && child.stdin) streams.push(pipeline(stdin, child.stdin));
    if (stdout && child.stdout) streams.push(pipeline(child.stdout, stdout));

    child.on('error', reject);
    child.on('close', async (code) => {
      try {
        await Promise.all(streams);
      } catch (err) {
        if (code === 0) return reject(err);
      }
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().split('\n').slice(-3).join(' | ') || `exited with code ${code}`));
    });
  });
}

export async function backup(container: string, database?: string, tag?: string): Promise<BackupResult> {
  const started = Date.now();
  const target = await detectDatabase(container, database);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const ext = target.engine === 'mongodb' ? 'archive' : 'sql';
  const file = `${target.container}__${target.database}__${timestamp()}${tag ? `_${tag}` : ''}.${ext}.gz`;
  const finalPath = path.join(BACKUP_DIR, file);
  const partialPath = `${finalPath}.partial`;

  try {
    const out = fs.createWriteStream(partialPath);
    if (target.engine === 'mongodb') {
      await runDocker(dumpArgs(target), null, out);
    } else {
      const gzip = zlib.createGzip();
      const writing = pipeline(gzip, out);
      await runDocker(dumpArgs(target), null, gzip);
      await writing;
    }
    fs.renameSync(partialPath, finalPath);
  } catch (err) {
    fs.rmSync(partialPath, { force: true });
    throw err;
  }

  const sizeBytes = fs.statSync(finalPath).size;
  const offsite = tag === 'pre-restore' ? [] : await deliverOffsite(finalPath, file, sizeBytes, { container: target.container, database: target.database });
  pruneOldBackups();

  return { file, path: finalPath, sizeBytes, durationMs: Date.now() - started, offsite };
}

export async function backupAndNotify(container: string, database?: string): Promise<BackupResult> {
  try {
    const r = await backup(container, database);
    const copies = r.offsite.length ? `\nCopies: server disk, ${r.offsite.join(', ')}` : '\nCopies: server disk only';
    await notifyText(
      `✅ Backup done: ${container}\nFile: ${r.file}\nSize: ${formatSize(r.sizeBytes)} in ${Math.round(r.durationMs / 1000)}s${copies}\nRestore: /restore ${r.file}`
    );
    return r;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await notifyText(`❌ Backup FAILED: ${container}\n${msg}`);
    throw err;
  }
}

export function listBackups(container?: string): BackupFile[] {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .map((file) => ({ file, m: FILE_RE.exec(file) }))
    .filter((x): x is { file: string; m: RegExpExecArray } => x.m !== null)
    .filter((x) => !container || x.m[1] === container)
    .map(({ file, m }) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, file));
      return { file, container: m[1], database: m[2], createdAt: stat.mtime, sizeBytes: stat.size };
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export function parseBackupFile(file: string): { container: string; database: string } {
  const m = FILE_RE.exec(path.basename(file));
  if (!m) throw new Error(`"${file}" is not a Vigil backup file`);
  return { container: m[1], database: m[2] };
}

/**
 * Which database a backup is restored into: the one named in the file when restoring onto the
 * same container, otherwise the target container's own database (staging has its own name).
 */
export async function restoreTarget(file: string, targetContainer?: string, targetDatabase?: string): Promise<DbTarget> {
  const parsed = parseBackupFile(path.basename(file));
  const container = targetContainer ?? parsed.container;
  const sameContainer = container === parsed.container;
  return detectDatabase(container, targetDatabase ?? (sameContainer ? parsed.database : undefined));
}

export async function restore(file: string, targetContainer?: string, targetDatabase?: string): Promise<{ safetyBackup: string }> {
  const name = path.basename(file);
  const target = await restoreTarget(name, targetContainer, targetDatabase);
  const container = target.container;

  const filePath = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(filePath)) {
    const fetched = await fetchFromStorage(name, filePath);
    if (!fetched) throw new Error(`Backup "${name}" not found on this server or in storage`);
  }

  const safety = await backup(container, target.database, 'pre-restore');

  const input = fs.createReadStream(filePath);
  if (target.engine === 'mongodb') {
    await runDocker(restoreArgs(target), input, null);
  } else {
    const gunzip = zlib.createGunzip();
    const reading = pipeline(input, gunzip);
    try {
      await Promise.all([runDocker(restoreArgs(target), gunzip, null), reading]);
    } catch (err) {
      input.destroy();
      throw err;
    }
  }

  return { safetyBackup: safety.file };
}

export function pruneOldBackups(): string[] {
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  const seen = new Set<string>();
  // listBackups is newest-first, so the first file per container is always kept
  for (const b of listBackups()) {
    const isLatest = !seen.has(b.container);
    seen.add(b.container);
    if (!isLatest && b.createdAt.getTime() < cutoff) {
      fs.rmSync(path.join(BACKUP_DIR, b.file), { force: true });
      removed.push(b.file);
    }
  }
  return removed;
}
