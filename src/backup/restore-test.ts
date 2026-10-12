import { execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import fs from 'fs';
import {
  BACKUP_DIR, DbTarget, containerImage, detectDatabase, ensureLocalCopy,
  formatSize, listBackups, loadDump, parseBackupFile,
} from './engine';
import { info, error } from '../logger';

const execFileAsync = promisify(execFile);

const READY_TIMEOUT_MS = 120_000;
const RESTORE_TIMEOUT_MS = 30 * 60_000;
const SAMPLE_TABLES = 5;

export interface TableCount {
  table: string;
  restored: number;
  live: number | null;
}

export interface RestoreTestResult {
  file: string;
  sizeBytes: number;
  engine: string;
  image: string;
  durationSeconds: number;
  tablesRestored: number;
  tablesLive: number | null;
  counts: TableCount[];
  warnings: string[];
  ok: boolean;
}

const randomName = () => `vigil-restore-test-${crypto.randomBytes(4).toString('hex')}`;
const randomSecret = () => crypto.randomBytes(18).toString('base64url');

async function freeBytes(dir: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('df', ['-Pk', dir]);
    const line = stdout.trim().split('\n').pop() ?? '';
    const available = Number(line.split(/\s+/)[3]);
    return Number.isFinite(available) ? available * 1024 : null;
  } catch {
    return null;
  }
}

/** Run a query inside a container and return raw stdout. */
async function query(target: DbTarget, sql: string, password?: string): Promise<string> {
  const { container, engine, user, database } = target;
  if (engine === 'postgres') {
    const { stdout } = await execFileAsync('docker',
      ['exec', container, 'psql', '-U', user, '-d', database, '-tAc', sql], { maxBuffer: 1 << 22 });
    return stdout.trim();
  }
  if (engine === 'mysql') {
    const pwd = password
      ? `MYSQL_PWD="$3"`
      : `MYSQL_PWD="\${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}"`;
    const { stdout } = await execFileAsync('docker',
      ['exec', container, 'sh', '-c',
        `${pwd} exec "$(command -v mysql || command -v mariadb)" -uroot -N -B -e "$1" "$2"`,
        'sh', sql, database, password ?? ''], { maxBuffer: 1 << 22 });
    return stdout.trim();
  }
  const { stdout } = await execFileAsync('docker',
    ['exec', container, 'mongosh', '--quiet', database, '--eval', sql], { maxBuffer: 1 << 22 });
  return stdout.trim();
}

const COUNT_TABLES = {
  postgres: `SELECT count(*) FROM information_schema.tables
             WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE'`,
  mysql: `SELECT count(*) FROM information_schema.tables WHERE table_schema = DATABASE()`,
  mongodb: `db.getCollectionNames().length`,
};

/** The biggest tables, which are the ones worth counting rows in. */
const BIGGEST_TABLES = {
  postgres: `SELECT quote_ident(schemaname)||'.'||quote_ident(relname) FROM pg_catalog.pg_statio_user_tables
             ORDER BY pg_total_relation_size(relid) DESC LIMIT ${SAMPLE_TABLES}`,
  mysql: `SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()
          ORDER BY data_length DESC LIMIT ${SAMPLE_TABLES}`,
  mongodb: `db.getCollectionNames().slice(0, ${SAMPLE_TABLES}).join('\\n')`,
};

async function countRows(target: DbTarget, table: string, password?: string): Promise<number | null> {
  try {
    const sql = target.engine === 'mongodb'
      ? `db.getCollection(${JSON.stringify(table)}).countDocuments()`
      : target.engine === 'postgres'
        ? `SELECT count(*) FROM ${table}`
        : `SELECT count(*) FROM \`${table}\``;
    const out = await query(target, sql, password);
    const n = Number(out.split('\n')[0]);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function waitReady(target: DbTarget, password: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = '';
  while (Date.now() < deadline) {
    try {
      if (target.engine === 'postgres') {
        await execFileAsync('docker', ['exec', target.container, 'pg_isready', '-U', target.user, '-d', target.database]);
      } else if (target.engine === 'mysql') {
        await query(target, 'SELECT 1', password);
      } else {
        await query(target, 'db.runCommand({ ping: 1 }).ok');
      }
      return;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(`The test database never became ready: ${last.split('\n').pop()}`);
}

function startArgs(name: string, image: string, source: DbTarget, secret: string): string[] {
  const base = ['run', '-d', '--rm', '--name', name, '--network', 'none'];
  if (source.engine === 'postgres') {
    base.push('-e', `POSTGRES_PASSWORD=${secret}`, '-e', `POSTGRES_USER=${source.user}`,
      '-e', `POSTGRES_DB=${source.database}`);
  } else if (source.engine === 'mysql') {
    base.push('-e', `MYSQL_ROOT_PASSWORD=${secret}`, '-e', `MYSQL_DATABASE=${source.database}`);
  }
  base.push(image);
  return base;
}

/**
 * Restore a backup into a throwaway container and report what arrived.
 * The copy is isolated: own container, no network, no volume, removed at the end.
 */
export async function restoreTest(fileOrContainer: string, opts: { keep?: boolean } = {}): Promise<RestoreTestResult> {
  const started = Date.now();
  const warnings: string[] = [];

  const known = listBackups();
  const match = known.find((b) => b.file === fileOrContainer);
  const file = match ?? listBackups(fileOrContainer)[0];
  if (!file) {
    throw new Error(`No backup found for "${fileOrContainer}". Run: vigil backups`);
  }

  const { container: sourceContainer } = parseBackupFile(file.file);
  const source = await detectDatabase(sourceContainer);
  const image = await containerImage(sourceContainer);
  const filePath = await ensureLocalCopy(file.file);
  const sizeBytes = fs.statSync(filePath).size;

  const free = await freeBytes(BACKUP_DIR);
  if (free !== null && free < sizeBytes * 2) {
    throw new Error(
      `Not enough free disk to test this restore: ${formatSize(free)} free, about ${formatSize(sizeBytes * 2)} needed`
    );
  }

  const name = randomName();
  const secret = randomSecret();
  const target: DbTarget = { ...source, container: name };

  info(`[restore-test] Starting ${image} as ${name}`);
  await execFileAsync('docker', startArgs(name, image, source, secret));

  try {
    await waitReady(target, secret);

    info(`[restore-test] Loading ${file.file} (${formatSize(sizeBytes)})`);
    await Promise.race([
      loadDump(target, filePath),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Restore timed out')), RESTORE_TIMEOUT_MS)),
    ]);

    const tablesRestored = Number((await query(target, COUNT_TABLES[source.engine], secret)).split('\n')[0]) || 0;

    let tablesLive: number | null = null;
    try {
      tablesLive = Number((await query(source, COUNT_TABLES[source.engine])).split('\n')[0]);
    } catch {
      warnings.push('Could not read the live database to compare against, so only the restored side was checked.');
    }

    const tables = (await query(target, BIGGEST_TABLES[source.engine], secret))
      .split('\n').map((t) => t.trim()).filter(Boolean).slice(0, SAMPLE_TABLES);

    const counts: TableCount[] = [];
    for (const table of tables) {
      const restored = await countRows(target, table, secret);
      const live = tablesLive === null ? null : await countRows(source, table);
      if (restored !== null) counts.push({ table, restored, live });
    }

    if (tablesRestored === 0) warnings.push('The restore produced no tables at all.');
    if (tablesLive !== null && tablesRestored !== tablesLive) {
      warnings.push(`The live database has ${tablesLive} tables, the restored copy has ${tablesRestored}.`);
    }
    for (const c of counts) {
      if (c.live !== null && c.restored === 0 && c.live > 0) {
        warnings.push(`${c.table} is empty in the restored copy but has ${c.live} rows live.`);
      }
    }

    const ok = tablesRestored > 0 && !warnings.some((w) => w.includes('no tables') || w.includes('is empty'));
    return {
      file: file.file, sizeBytes, engine: source.engine, image,
      durationSeconds: Math.round((Date.now() - started) / 1000),
      tablesRestored, tablesLive, counts, warnings, ok,
    };
  } finally {
    if (opts.keep) {
      info(`[restore-test] Leaving ${name} running (--keep). Remove it with: docker rm -f ${name}`);
    } else {
      await execFileAsync('docker', ['rm', '-f', name]).catch((err) => {
        error(`[restore-test] Could not remove ${name}`, err);
      });
    }
  }
}
