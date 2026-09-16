/**
 * Database backup engine
 * Handles MySQL, PostgreSQL, and MongoDB backups
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { info, error } from '../logger';
import { BackupConfig, BackupResult, BackupStatus } from './backup.types';

const execAsync = promisify(exec);
const BACKUP_DIR = path.resolve(process.cwd(), 'backups');

// Ensure backup directory exists
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

/**
 * Execute a backup for a database
 */
export async function executeBackup(config: BackupConfig): Promise<BackupResult> {
  const startTime = Date.now();
  const timestamp = new Date();
  const backupId = `${config.id}-${timestamp.getTime()}`;
  const backupPath = path.join(BACKUP_DIR, `${config.id}`, `${backupId}.sql.gz`);

  // Create directory for this config
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });

  try {
    info(`[backup] Starting ${config.type} backup for ${config.name}`);

    let command = '';

    switch (config.type) {
      case 'mysql':
        command = buildMySQLBackup(config, backupPath);
        break;
      case 'postgres':
        command = buildPostgresBackup(config, backupPath);
        break;
      case 'mongodb':
        command = buildMongoDBBackup(config, backupPath);
        break;
    }

    await execAsync(command, { timeout: 5 * 60 * 1000 }); // 5 minute timeout

    // Get file size
    const stats = fs.statSync(backupPath);
    const sizeGB = (stats.size / (1024 ** 3)).toFixed(2);

    const result: BackupResult = {
      id: backupId,
      configId: config.id,
      timestamp,
      status: 'success',
      size: `${sizeGB}GB`,
      duration: Date.now() - startTime,
      path: backupPath,
      message: `✅ Backup successful: ${config.name} (${sizeGB}GB)`,
    };

    info(`[backup] ${result.message}`);
    cleanOldBackups(config);
    return result;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    error(`[backup] Backup failed for ${config.name}`, err);

    return {
      id: backupId,
      configId: config.id,
      timestamp,
      status: 'failed',
      duration: Date.now() - startTime,
      path: backupPath,
      error: errorMsg,
      message: `❌ Backup failed: ${config.name} — ${errorMsg}`,
    };
  }
}

/**
 * List all backups for a config
 */
export function listBackups(configId: string): BackupResult[] {
  const configDir = path.join(BACKUP_DIR, configId);

  if (!fs.existsSync(configDir)) {
    return [];
  }

  const files = fs.readdirSync(configDir);
  const backups = files
    .filter((f) => f.endsWith('.sql.gz'))
    .map((f) => {
      const stats = fs.statSync(path.join(configDir, f));
      const sizeGB = (stats.size / (1024 ** 3)).toFixed(2);
      return {
        filename: f,
        size: `${sizeGB}GB`,
        created: new Date(stats.birthtimeMs),
        path: path.join(configDir, f),
      };
    })
    .sort((a, b) => b.created.getTime() - a.created.getTime());

  return backups as any;
}

/**
 * Restore from a backup
 */
export async function restoreBackup(configId: string, backupFile: string, config: BackupConfig): Promise<BackupResult> {
  const startTime = Date.now();
  const backupPath = path.join(BACKUP_DIR, configId, backupFile);

  if (!fs.existsSync(backupPath)) {
    return {
      id: `restore-${Date.now()}`,
      configId,
      timestamp: new Date(),
      status: 'failed',
      duration: Date.now() - startTime,
      path: backupPath,
      error: 'Backup file not found',
      message: `❌ Restore failed: backup file not found`,
    };
  }

  try {
    info(`[backup] Restoring ${config.name} from ${backupFile}`);

    let command = '';

    switch (config.type) {
      case 'mysql':
        command = buildMySQLRestore(config, backupPath);
        break;
      case 'postgres':
        command = buildPostgresRestore(config, backupPath);
        break;
      case 'mongodb':
        command = buildMongoDBRestore(config, backupPath);
        break;
    }

    await execAsync(command, { timeout: 10 * 60 * 1000 }); // 10 minute timeout

    return {
      id: `restore-${Date.now()}`,
      configId,
      timestamp: new Date(),
      status: 'success',
      duration: Date.now() - startTime,
      path: backupPath,
      message: `✅ Restore successful: ${config.name}`,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    error(`[backup] Restore failed for ${config.name}`, err);

    return {
      id: `restore-${Date.now()}`,
      configId,
      timestamp: new Date(),
      status: 'failed',
      duration: Date.now() - startTime,
      path: backupPath,
      error: errorMsg,
      message: `❌ Restore failed: ${config.name} — ${errorMsg}`,
    };
  }
}

/**
 * Delete old backups based on retention policy
 */
function cleanOldBackups(config: BackupConfig): void {
  const configDir = path.join(BACKUP_DIR, config.id);
  const cutoffTime = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;

  if (!fs.existsSync(configDir)) return;

  const files = fs.readdirSync(configDir);

  files.forEach((file) => {
    const filePath = path.join(configDir, file);
    const stats = fs.statSync(filePath);

    if (stats.birthtimeMs < cutoffTime) {
      fs.unlinkSync(filePath);
      info(`[backup] Deleted old backup: ${file}`);
    }
  });
}

// ============================================
// MYSQL BACKUP/RESTORE
// ============================================

function buildMySQLBackup(config: BackupConfig, outputPath: string): string {
  // Assumes Docker container with mysqldump
  return `docker exec ${config.container} mysqldump -u root -p"$MYSQL_ROOT_PASSWORD" ${config.database} | gzip > ${outputPath}`;
}

function buildMySQLRestore(config: BackupConfig, backupPath: string): string {
  return `gunzip -c ${backupPath} | docker exec -i ${config.container} mysql -u root -p"$MYSQL_ROOT_PASSWORD" ${config.database}`;
}

// ============================================
// POSTGRESQL BACKUP/RESTORE
// ============================================

function buildPostgresBackup(config: BackupConfig, outputPath: string): string {
  // Assumes Docker container with pg_dump
  return `docker exec ${config.container} pg_dump -U postgres ${config.database} | gzip > ${outputPath}`;
}

function buildPostgresRestore(config: BackupConfig, backupPath: string): string {
  return `gunzip -c ${backupPath} | docker exec -i ${config.container} psql -U postgres -d ${config.database}`;
}

// ============================================
// MONGODB BACKUP/RESTORE
// ============================================

function buildMongoDBBackup(config: BackupConfig, outputPath: string): string {
  // Assumes Docker container with mongodump
  const dumpDir = outputPath.replace('.sql.gz', '_dump');
  return `docker exec ${config.container} mongodump --db ${config.database} --archive=/tmp/backup.archive && docker cp ${config.container}:/tmp/backup.archive - | gzip > ${outputPath}`;
}

function buildMongoDBRestore(config: BackupConfig, backupPath: string): string {
  return `gunzip -c ${backupPath} | docker exec -i ${config.container} mongorestore --archive --db ${config.database}`;
}
