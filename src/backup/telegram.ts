import TelegramBot from 'node-telegram-bot-api';
import crypto from 'crypto';
import { backupAndNotify, detectDatabase, formatSize, listBackups, restore, restoreTarget } from './engine';
import { describeSchedule, loadSchedules, removeSchedule, setSchedule } from './schedule';

const CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? '';
const CONFIRM_TTL_MS = 10 * 60 * 1000;

const pendingRestores = new Map<string, { file: string; container?: string; expires: number }>();

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function setupBackupCommands(bot: TelegramBot): void {
  const reply = (text: string) => bot.sendMessage(CHAT_ID, text);

  const command = (name: string, handler: (args: string[]) => Promise<unknown>) => {
    bot.onText(new RegExp(`^/${name}(?:@\\w+)?(?:\\s+(.+))?$`), async (msg, match) => {
      if (String(msg.chat.id) !== CHAT_ID) return;
      const args = (match?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
      try {
        await handler(args);
      } catch (err) {
        await reply(`❌ ${errMsg(err)}`);
      }
    });
  };

  command('backup', async ([container, database]) => {
    if (!container) return reply('Usage: /backup <container> [database]\nExample: /backup songdis-postgres');
    await detectDatabase(container, database);
    await reply(`⏳ Backing up ${container}...`);
    await backupAndNotify(container, database).catch(() => undefined);
  });

  command('backups', async ([container]) => {
    const files = listBackups(container).slice(0, 15);
    if (files.length === 0) return reply(container ? `No backups for ${container} yet.` : 'No backups yet. Run /backup <container>');
    const lines = files.map((b) => `• ${b.file}\n  ${formatSize(b.sizeBytes)} — ${b.createdAt.toLocaleString()}`);
    await reply(`🗄 Backups on this server (newest first)\n\n${lines.join('\n')}\n\nRestore: /restore <file>`);
  });

  command('restore', async ([file, container]) => {
    if (!file) return reply('Usage: /restore <file> [container]\nSee files with /backups');
    const target = await restoreTarget(file, container);
    const id = crypto.randomBytes(4).toString('hex');
    pendingRestores.set(id, { file, container, expires: Date.now() + CONFIRM_TTL_MS });
    await bot.sendMessage(
      CHAT_ID,
      `⚠️ Restore will OVERWRITE database "${target.database}" in ${target.container}.\n` +
        `A safety backup of the current data is taken first.\n\nFile: ${file}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Yes, restore', callback_data: `restore:${id}` },
            { text: '❌ Cancel', callback_data: `restore-cancel:${id}` },
          ]],
        },
      }
    );
  });

  command('backup_schedule', async ([container, ...spec]) => {
    if (!container || spec.length === 0) {
      return reply(
        'Usage:\n/backup_schedule <container> daily 02:00\n/backup_schedule <container> hourly\n' +
          '/backup_schedule <container> weekly sun 03:00\n/backup_schedule <container> off'
      );
    }
    if (spec[0].toLowerCase() === 'off') {
      return reply(removeSchedule(container) ? `🗓 Schedule removed for ${container}` : `${container} had no schedule`);
    }
    await detectDatabase(container);
    const s = setSchedule(container, spec);
    await reply(`🗓 ${container} will be backed up ${describeSchedule(s)} (server time).`);
  });

  command('backup_schedules', async () => {
    const schedules = loadSchedules();
    if (schedules.length === 0) return reply('No backup schedules. Add one with /backup_schedule <container> daily 02:00');
    await reply(`🗓 Backup schedules\n\n${schedules.map((s) => `• ${s.container} — ${describeSchedule(s)}`).join('\n')}`);
  });

  bot.on('callback_query', async (query) => {
    const [action, id] = (query.data ?? '').split(':');
    if (action !== 'restore' && action !== 'restore-cancel') return;
    if (String(query.message?.chat.id) !== CHAT_ID) return;

    if (query.message) {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: query.message.chat.id, message_id: query.message.message_id });
    }

    const pending = pendingRestores.get(id);
    pendingRestores.delete(id);
    if (action === 'restore-cancel') return reply('Restore cancelled.');
    if (!pending || pending.expires < Date.now()) return reply('This restore request expired. Send /restore again.');

    await reply(`⏳ Restoring ${pending.file}...`);
    try {
      const { safetyBackup } = await restore(pending.file, pending.container);
      await reply(`✅ Restore complete.\nPrevious data saved as: ${safetyBackup}`);
    } catch (err) {
      await reply(`❌ Restore FAILED: ${errMsg(err)}`);
    }
  });
}
