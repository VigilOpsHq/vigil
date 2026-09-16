/**
 * Database backup types and interfaces
 */

export type BackupType = 'mysql' | 'postgres' | 'mongodb';
export type BackupStatus = 'pending' | 'in-progress' | 'success' | 'failed';

export interface BackupConfig {
  id: string;
  name: string;
  type: BackupType;
  container: string;
  database: string;
  schedule?: string; // cron format: "0 2 * * *" = daily at 2am
  retentionDays: number; // how many days to keep backups
  enabled: boolean;
}

export interface BackupResult {
  id: string;
  configId: string;
  timestamp: Date;
  status: BackupStatus;
  size?: string; // e.g., "1.2GB"
  duration: number; // milliseconds
  path: string;
  error?: string;
  message: string;
}

export interface BackupSchedule {
  configId: string;
  lastRun?: Date;
  nextRun?: Date;
  isRunning: boolean;
}
