// Telegram webhook for the official VigilOps bot.
//
// Licensed under FSL-1.1-MIT (see website/LICENSE.md): use and self-host freely,
// but not as a competing product or service. Converts to MIT after two years.
import type { RequestContext } from '../lib/env';
import { HttpError } from '../lib/http';

const safeHeader = (request: Request, name: string) => request.headers.get(name) ?? '';
import { requireDb } from '../lib/auth';
import { sendTelegram } from '../lib/telegram';
import { safeEqual } from '../lib/crypto';

interface Update {
  message?: { chat: { id: number; type: string }; text?: string };
}

// POST /api/telegram/webhook  — updates for the official VigilOps bot
export async function telegramWebhook({ request, env }: RequestContext): Promise<Response> {
  const secret = env.CLOUD_TELEGRAM_WEBHOOK_SECRET;
  if (!secret || !env.CLOUD_TELEGRAM_BOT_TOKEN) throw new HttpError(503, 'Bot not configured');
  if (!safeEqual(safeHeader(request, 'X-Telegram-Bot-Api-Secret-Token'), secret)) throw new HttpError(401, 'Unauthorized');

  const update = (await request.json().catch(() => ({}))) as Update;
  const msg = update.message;
  if (!msg?.text || msg.chat.type !== 'private') return new Response('ok');

  const chatId = String(msg.chat.id);
  const reply = (text: string) => sendTelegram(env.CLOUD_TELEGRAM_BOT_TOKEN, chatId, text);
  const [command, arg] = msg.text.trim().split(/\s+/, 2);
  const db = requireDb(env);

  if (command === '/start' && arg) {
    const link = await db
      .prepare('SELECT account_id FROM telegram_links WHERE code = ? AND expires_at > ?')
      .bind(arg, new Date().toISOString())
      .first<{ account_id: string }>();
    if (!link) {
      await reply('This link has expired. Open vigilops.cloud/app and click "Connect Telegram" again.');
      return new Response('ok');
    }
    await db.batch([
      db.prepare('UPDATE accounts SET telegram_chat_id = ? WHERE id = ?').bind(chatId, link.account_id),
      db.prepare('DELETE FROM telegram_links WHERE code = ?').bind(arg),
    ]);
    await reply('✅ Connected to VigilOps Cloud. You will get alerts here when a server goes offline or a scheduled backup is missed.');
    return new Response('ok');
  }

  if (command === '/stop') {
    const { meta } = await db.prepare('UPDATE accounts SET telegram_chat_id = NULL WHERE telegram_chat_id = ?').bind(chatId).run();
    await reply(meta.changes ? 'Disconnected. You will no longer get VigilOps Cloud alerts here.' : 'This chat is not connected.');
    return new Response('ok');
  }

  await reply('To connect this chat, open vigilops.cloud/app and click "Connect Telegram". Send /stop to disconnect.');
  return new Response('ok');
}
