/**
 * Example backup configurations
 * Copy this to backup.config.ts and customize for your databases
 */

import { BackupConfig } from './backup.types';

/**
 * Backup configurations
 * Each config represents one database to back up
 */
const backupConfigs: BackupConfig[] = [
  {
    id: 'mysql_prod',
    name: 'Production MySQL',
    type: 'mysql',
    container: 'mysql',
    database: 'myapp_prod',
    schedule: '0 2 * * *', // Daily at 2:00 AM
    retentionDays: 30,
    enabled: true,
  },

  {
    id: 'postgres_dev',
    name: 'Development PostgreSQL',
    type: 'postgres',
    container: 'postgres_dev',
    database: 'dev_db',
    schedule: '0 6 * * *', // Daily at 6:00 AM
    retentionDays: 7,
    enabled: true,
  },

  {
    id: 'mongodb_analytics',
    name: 'Analytics MongoDB',
    type: 'mongodb',
    container: 'mongodb',
    database: 'analytics',
    schedule: '0 3 * * 0', // Weekly on Sunday at 3:00 AM
    retentionDays: 60,
    enabled: true,
  },

  // Manual backup only (no schedule)
  {
    id: 'mysql_backup_archive',
    name: 'Backup Archive (Manual)',
    type: 'mysql',
    container: 'mysql',
    database: 'archive_db',
    retentionDays: 90,
    enabled: false, // Trigger manually via /trigger_backup
  },
];

export default backupConfigs;
