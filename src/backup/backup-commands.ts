/**
 * Telegram backup commands
 * Allows users to trigger, schedule, and restore database backups via Telegram
 */

import TelegramBot from 'node-telegram-bot-api';
import { executeBackup, listBackups, restoreBackup } from './backup.engine';
import { BackupConfig } from './backup.types';
import { info, error } from '../logger';

const CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? '';

// In-memory backup configs (would be loaded from config file in production)
const backupConfigs: Map<string, BackupConfig> = new Map();
const backupHistory: any[] = [];

/**
 * Register all backup commands with Telegram bot
 */
export function setupBackupCommands(bot: TelegramBot) {
  bot.onText(/\/backup_status(?:\s+(.+))?/, (msg, match) =>
    handleBackupStatus(bot, msg, match)
  );
  bot.onText(/\/trigger_backup(?:\s+(.+))?/, (msg, match) =>
    handleTriggerBackup(bot, msg, match)
  );
  bot.onText(/\/schedule_backup(?:\s+(.+))?/, (msg, match) =>
    handleScheduleBackup(bot, msg, match)
  );
  bot.onText(/\/backup_history(?:\s+(.+))?/, (msg, match) =>
    handleBackupHistory(bot, msg, match)
  );
  bot.onText(/\/restore_backup(?:\s+(.+))?/, (msg, match) =>
    handleRestoreBackup(bot, msg, match)
  );
}

/**
 * /backup_status - Show backup status and available backups
 */
async function handleBackupStatus(bot: TelegramBot, msg: TelegramBot.Message, match: RegExpExecArray | null) {
  try {
    const chatId = msg.chat.id;
    const configs = Array.from(backupConfigs.values());

    if (configs.length === 0) {
      return bot.sendMessage(chatId, '📋 No backup configurations found.\n\nUse /schedule_backup to add one.');
    }

    let message = '📋 *Backup Status*\n\n';

    for (const config of configs) {
      const status = config.enabled ? '✅' : '⏸️';
      const backups = listBackups(config.id);

      message += `${status} ${config.name} (${config.type})\n`;
      message += `  Database: ${config.database} in ${config.container}\n`;

      if (config.schedule) {
        message += `  Schedule: ${config.schedule}\n`;
      }

      if (backups.length > 0) {
        const latest = backups[0] as any;
        message += `  Latest: ${latest.filename} (${latest.size})\n`;
        message += `  Total backups: ${backups.length}\n`;
      } else {
        message += `  No backups yet\n`;
      }

      message += '\n';
    }

    message += '_Commands:_\n';
    message += '/trigger_backup <id> - Run backup now\n';
    message += '/backup_history <id> - View backup history\n';
    message += '/restore_backup <id> - Restore from backup\n';

    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (err) {
    error('[Telegram] Backup status error', err);
    bot.sendMessage(msg.chat.id, '❌ Error getting backup status');
  }
}

/**
 * /trigger_backup <id> - Manually trigger a backup
 */
async function handleTriggerBackup(bot: TelegramBot, msg: TelegramBot.Message, match: RegExpExecArray | null) {
  try {
    const chatId = msg.chat.id;
    const configId = match?.[1]?.trim();

    if (!configId) {
      return bot.sendMessage(
        chatId,
        'Usage: /trigger_backup <config_id>\n\nExample: /trigger_backup mysql_prod'
      );
    }

    const config = backupConfigs.get(configId);
    if (!config) {
      return bot.sendMessage(chatId, `❌ Backup configuration not found: ${configId}`);
    }

    bot.sendMessage(chatId, `⏳ Starting backup: ${config.name}...`);

    const result = await executeBackup(config);

    backupHistory.push({
      timestamp: result.timestamp,
      configId: result.configId,
      status: result.status,
      message: result.message,
    });

    const icon = result.status === 'success' ? '✅' : '❌';
    bot.sendMessage(
      chatId,
      `${icon} *Backup complete*\n\n` +
        `Config: ${config.name}\n` +
        `Status: ${result.status}\n` +
        `${result.size ? `Size: ${result.size}\n` : ''}` +
        `Duration: ${Math.round(result.duration / 1000)}s\n` +
        `${result.error ? `Error: ${result.error}` : 'Message: ' + result.message}`,
      { parse_mode: 'Markdown' }
    );

    info(`[backup] Telegram triggered backup for ${configId}`);
  } catch (err) {
    error('[Telegram] Trigger backup error', err);
    bot.sendMessage(msg.chat.id, '❌ Error triggering backup');
  }
}

/**
 * /schedule_backup <id> <cron> - Setup automatic backup scheduling
 */
async function handleScheduleBackup(bot: TelegramBot, msg: TelegramBot.Message, match: RegExpExecArray | null) {
  try {
    const chatId = msg.chat.id;
    const args = (match?.[1] ?? '').split(/\s+/);
    const configId = args[0];
    const cron = args[1];

    if (!configId || !cron) {
      return bot.sendMessage(
        chatId,
        'Usage: /schedule_backup <config_id> <cron>\n\n' +
          'Examples:\n' +
          '/schedule_backup mysql_prod "0 2 * * *" (daily at 2am)\n' +
          '/schedule_backup postgres_db "0 */6 * * *" (every 6 hours)\n' +
          '/schedule_backup mongodb_app "0 1 * * 0" (weekly Sunday 1am)\n\n' +
          'Cron format: minute hour day month dayofweek'
      );
    }

    const config = backupConfigs.get(configId);
    if (!config) {
      return bot.sendMessage(chatId, `❌ Backup configuration not found: ${configId}`);
    }

    // Update config with schedule
    config.schedule = cron;
    config.enabled = true;
    backupConfigs.set(configId, config);

    bot.sendMessage(
      chatId,
      `✅ *Backup scheduled*\n\n` +
        `Config: ${config.name}\n` +
        `Type: ${config.type}\n` +
        `Database: ${config.database}\n` +
        `Schedule: ${cron}\n` +
        `Retention: ${config.retentionDays} days\n\n` +
        `Your database will be backed up automatically at the scheduled time.\n` +
        `Use /backup_status to check results.`,
      { parse_mode: 'Markdown' }
    );

    info(`[backup] Telegram scheduled backup for ${configId}: ${cron}`);
  } catch (err) {
    error('[Telegram] Schedule backup error', err);
    bot.sendMessage(msg.chat.id, '❌ Error scheduling backup');
  }
}

/**
 * /backup_history <id> - Show backup history
 */
async function handleBackupHistory(bot: TelegramBot, msg: TelegramBot.Message, match: RegExpExecArray | null) {
  try {
    const chatId = msg.chat.id;
    const configId = match?.[1]?.trim();

    if (!configId) {
      const recentHistory = backupHistory.slice(-5).reverse();
      if (recentHistory.length === 0) {
        return bot.sendMessage(chatId, '📜 No backup history yet');
      }

      let message = '📜 *Recent Backups*\n\n';
      recentHistory.forEach((entry: any) => {
        const icon = entry.status === 'success' ? '✅' : '❌';
        message += `${icon} ${entry.configId} - ${entry.status}\n`;
        message += `   ${new Date(entry.timestamp).toLocaleString()}\n\n`;
      });

      return bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    const backups = listBackups(configId);

    if (backups.length === 0) {
      return bot.sendMessage(chatId, `📜 No backups found for: ${configId}`);
    }

    let message = `📜 *Backup History: ${configId}*\n\n`;

    (backups as any[]).forEach((backup) => {
      message +=
        `📦 ${backup.filename}\n` +
        `   Size: ${backup.size}\n` +
        `   Created: ${new Date(backup.created).toLocaleString()}\n\n`;
    });

    message += `Total: ${backups.length} backups\n`;
    message += 'Use /restore_backup <config_id> <filename> to restore';

    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (err) {
    error('[Telegram] Backup history error', err);
    bot.sendMessage(msg.chat.id, '❌ Error getting backup history');
  }
}

/**
 * /restore_backup <id> <filename> - Restore from a backup
 */
async function handleRestoreBackup(bot: TelegramBot, msg: TelegramBot.Message, match: RegExpExecArray | null) {
  try {
    const chatId = msg.chat.id;
    const args = (match?.[1] ?? '').split(/\s+/);
    const configId = args[0];
    const backupFile = args[1];

    if (!configId || !backupFile) {
      return bot.sendMessage(
        chatId,
        'Usage: /restore_backup <config_id> <backup_filename>\n\n' +
          'First, get the filename from /backup_history <config_id>\n' +
          'Example: /restore_backup mysql_prod mysql_prod-1234567890.sql.gz'
      );
    }

    const config = backupConfigs.get(configId);
    if (!config) {
      return bot.sendMessage(chatId, `❌ Backup configuration not found: ${configId}`);
    }

    bot.sendMessage(
      chatId,
      `⚠️ *WARNING: This will overwrite your database!*\n\n` +
        `Config: ${config.name}\n` +
        `Database: ${config.database}\n` +
        `Backup file: ${backupFile}\n\n` +
        `Please confirm with /approve_restore_${configId}_${Date.now()}`,
      { parse_mode: 'Markdown' }
    );

    info(`[backup] Restore requested for ${configId} from ${backupFile}`);
  } catch (err) {
    error('[Telegram] Restore backup error', err);
    bot.sendMessage(msg.chat.id, '❌ Error processing restore request');
  }
}

/**
 * Register a backup configuration
 * Used to populate available backups for commands
 */
export function registerBackupConfig(config: BackupConfig) {
  backupConfigs.set(config.id, config);
  info(`[backup] Registered backup config: ${config.id}`);
}

/**
 * Load all registered backup configs
 */
export function getBackupConfigs(): BackupConfig[] {
  return Array.from(backupConfigs.values());
}

/**
 * Get backup history
 */
export function getBackupHistory() {
  return backupHistory;
}
