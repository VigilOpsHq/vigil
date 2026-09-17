import TelegramBot from 'node-telegram-bot-api';
import { currentVersion, isNewer, latestRelease, ReleaseInfo, startSelfUpdate, startUpdateChecker } from './index';

const CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? '';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function setupUpdateCommands(bot: TelegramBot, enabled = true): void {
  const reply = (text: string) => bot.sendMessage(CHAT_ID, text);

  const offerUpdate = (release: ReleaseInfo, current: string) =>
    bot.sendMessage(
      CHAT_ID,
      `⬆️ VigilOps ${release.version} is available (running ${current}).\n\n` +
        `${release.notes.slice(0, 1500)}\n\nRelease notes: ${release.url}`,
      { reply_markup: { inline_keyboard: [[{ text: `⬆️ Update to ${release.version}`, callback_data: 'vigil-update' }]] } }
    ).then(() => undefined);

  bot.onText(/^\/version(?:@\w+)?$/, async (msg) => {
    if (String(msg.chat.id) !== CHAT_ID) return;
    const current = currentVersion();
    try {
      const latest = await latestRelease();
      if (isNewer(latest.version, current)) return offerUpdate(latest, current);
      await reply(`✅ VigilOps ${current} — up to date.`);
    } catch (err) {
      await reply(`VigilOps ${current} (couldn't check for updates: ${errMsg(err)})`);
    }
  });

  const runUpdate = async () => {
    try {
      await startSelfUpdate();
      await reply('⏳ Updating VigilOps — it will restart in a moment and say hello when it is back.');
    } catch (err) {
      await reply(`❌ Update failed to start: ${errMsg(err)}\nOn the server run: vigil update`);
    }
  };

  bot.onText(/^\/update(?:@\w+)?$/, async (msg) => {
    if (String(msg.chat.id) !== CHAT_ID) return;
    await runUpdate();
  });

  bot.on('callback_query', async (query) => {
    if (query.data !== 'vigil-update' || String(query.message?.chat.id) !== CHAT_ID) return;
    if (query.message) {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: query.message.chat.id, message_id: query.message.message_id });
    }
    await runUpdate();
  });

  if (enabled) startUpdateChecker(offerUpdate);
}
