/**
 * Backup scheduler
 * Runs backups automatically on cron schedules
 */

import * as cron from 'node-cron';
import { executeBackup } from './backup.engine';
import { BackupConfig } from './backup.types';
import { info, error } from '../logger';
import { notify } from '../telegram/bot';

const activeJobs = new Map<string, cron.ScheduledTask>();

/**
 * Schedule a backup to run automatically
 */
export function scheduleBackup(config: BackupConfig): void {
  if (!config.schedule) {
    return;
  }

  // Cancel existing job if any
  if (activeJobs.has(config.id)) {
    const existing = activeJobs.get(config.id);
    if (existing) {
      existing.stop();
      activeJobs.delete(config.id);
    }
  }

  if (!config.enabled) {
    return;
  }

  try {
    const job = cron.schedule(config.schedule, async () => {
      info(`[backup] Running scheduled backup: ${config.name}`);

      const result = await executeBackup(config);

      if (result.status === 'success') {
        await notify(
          `✅ *Backup completed*: ${config.name}\n` +
            `Size: ${result.size}\n` +
            `Duration: ${Math.round(result.duration / 1000)}s`
        );
        info(`[backup] Scheduled backup succeeded: ${config.id}`);
      } else {
        await notify(
          `❌ *Backup failed*: ${config.name}\n` +
            `Error: ${result.error}`
        );
        error(`[backup] Scheduled backup failed: ${config.id}`, new Error(result.error));
      }
    });

    activeJobs.set(config.id, job);
    info(`[backup] Scheduled backup job: ${config.id} with cron "${config.schedule}"`);
  } catch (err) {
    error(`[backup] Failed to schedule backup: ${config.id}`, err);
  }
}

/**
 * Unschedule a backup
 */
export function unscheduleBackup(configId: string): void {
  const job = activeJobs.get(configId);
  if (job) {
    job.stop();
    activeJobs.delete(configId);
    info(`[backup] Unscheduled backup job: ${configId}`);
  }
}

/**
 * Schedule multiple backups
 */
export function scheduleBackups(configs: BackupConfig[]): void {
  configs.forEach((config) => {
    scheduleBackup(config);
  });
}

/**
 * Get all active backup jobs
 */
export function getActiveJobs(): Map<string, cron.ScheduledTask> {
  return activeJobs;
}

/**
 * Stop all backup jobs
 */
export function stopAllBackups(): void {
  activeJobs.forEach((job) => {
    job.stop();
  });
  activeJobs.clear();
  info('[backup] All backup jobs stopped');
}
