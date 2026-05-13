import TelegramBot from 'node-telegram-bot-api';
import { PendingApproval, SystemSnapshot } from '../types';
import { execute, isSafeCommand } from '../executor';
import { log, error, info } from '../logger';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? '';
const APPROVAL_TIMEOUT_MS =
  parseInt(process.env.APPROVAL_TIMEOUT_MINUTES ?? '10', 10) * 60 * 1000;

if (!TOKEN || !CHAT_ID) {
  throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set in .env');
}

export const bot = new TelegramBot(TOKEN, { polling: true });


const pendingApprovals = new Map<string, PendingApproval>();


export async function notify(message: string): Promise<void> {
  try {
    await bot.sendMessage(CHAT_ID, message, { parse_mode: 'Markdown' });
  } catch (err) {
    error('Failed to send Telegram notification', err);
  }
}


export async function requestApproval(
  approvalId: string,
  commands: string[],
  message: string,
  snapshot: SystemSnapshot
): Promise<void> {
  const text =
    `⚠️ *Approval Required*\n\n` +
    `${message}\n\n` +
    `Commands:\n${commands.map((c) => `\`${c}\``).join('\n')}\n\n` +
    `Reply /approve_${approvalId} to run or /deny_${approvalId} to cancel.\n` +
    `Auto-denies in ${process.env.APPROVAL_TIMEOUT_MINUTES ?? '10'} minutes.`;

  const timeoutHandle = setTimeout(async () => {
    if (pendingApprovals.has(approvalId)) {
      pendingApprovals.delete(approvalId);
      await notify(`⏱ Approval \`${approvalId}\` timed out — action denied.`);
      log({ trigger: 'approval', action: commands.join(' && '), result: 'timeout', message });
    }
  }, APPROVAL_TIMEOUT_MS);

  pendingApprovals.set(approvalId, {
    id: approvalId,
    commands,
    message,
    snapshot,
    createdAt: new Date(),
    timeoutHandle,
  });

  await notify(text);
}


bot.onText(/\/status/, async () => {
  const { collect } = await import('../collector');
  const snapshot = await collect();

  const containerLines = snapshot.containers.map(
    (c) => `  ${c.state === 'running' ? '🟢' : '🔴'} ${c.name} — ${c.status}`
  );

  const diskIcon = snapshot.disk.usedPercent >= 85 ? '⚠️' : '✅';
  const memIcon = snapshot.memory.usedPercent >= 90 ? '⚠️' : '✅';
  const nginxIcon = snapshot.nginx.running ? '🟢' : '🔴';

  const healthLines = snapshot.healthChecks.map(
    (h) => `  ${h.healthy ? '🟢' : '🔴'} ${h.url} (${h.statusCode ?? 'no response'})`
  );

  const text =
    `📊 *Vigil Status*\n\n` +
    `*Containers*\n${containerLines.join('\n') || '  none'}\n\n` +
    `${diskIcon} *Disk* — ${snapshot.disk.usedPercent}% used (${snapshot.disk.available} free)\n` +
    `${memIcon} *Memory* — ${snapshot.memory.usedPercent}% used (${snapshot.memory.usedMb}MB / ${snapshot.memory.totalMb}MB)\n` +
    `${nginxIcon} *Nginx* — ${snapshot.nginx.running ? 'running' : 'NOT running'}\n\n` +
    (healthLines.length > 0 ? `*Health Checks*\n${healthLines.join('\n')}` : '');

  await notify(text);
});


bot.onText(/\/approve_([a-zA-Z0-9]+)/, async (_, match) => {
  const approvalId = match?.[1];
  if (!approvalId) return;

  const pending = pendingApprovals.get(approvalId);
  if (!pending) {
    await notify(`No pending approval found for ID \`${approvalId}\`.`);
    return;
  }

  clearTimeout(pending.timeoutHandle);
  pendingApprovals.delete(approvalId);

  await notify(`✅ Approved. Running ${pending.commands.length} command(s)...`);

  for (const cmd of pending.commands) {
    if (!isSafeCommand(cmd)) {
      await notify(`🚫 Blocked unsafe command: \`${cmd}\``);
      log({ trigger: 'approval', action: cmd, result: 'failed', message: 'Blocked by safety allowlist after approval' });
      continue;
    }

    const result = await execute(cmd);
    if (result.success) {
      await notify(`✅ \`${cmd}\` — done`);
      log({ trigger: 'approval', action: cmd, result: 'success', message: pending.message });
    } else {
      await notify(`❌ \`${cmd}\` — failed\n\`${result.error}\``);
      log({ trigger: 'approval', action: cmd, result: 'failed', message: result.error ?? 'unknown error' });
    }
  }
});


bot.onText(/\/deny_([a-zA-Z0-9]+)/, async (_, match) => {
  const approvalId = match?.[1];
  if (!approvalId) return;

  const pending = pendingApprovals.get(approvalId);
  if (!pending) {
    await notify(`No pending approval found for ID \`${approvalId}\`.`);
    return;
  }

  clearTimeout(pending.timeoutHandle);
  pendingApprovals.delete(approvalId);

  await notify(`🚫 Denied. No action taken.`);
  log({ trigger: 'approval', action: pending.commands.join(' && '), result: 'denied', message: pending.message });
});

// /help
bot.onText(/\/help/, async () => {
  const text =
    `🤖 *Vigil Commands*\n\n` +
    `/status — current system snapshot\n` +
    `/apps — list deployable apps\n` +
    `/deploy <appname> — deploy an app\n` +
    `/approve_<id> — approve a pending action\n` +
    `/deny_<id> — deny a pending action\n` +
    `/help — show this message`;
  await notify(text);
});

bot.onText(/\/apps/, async () => {
  const { listApps } = await import('../deploy/deployer');
  const apps = listApps();
  const text =
    apps.length > 0
      ? `📦 *Deployable apps:*\n${apps.map((a) => `  • \`${a}\``).join('\n')}`
      : '📦 No apps registered in deploy.config.ts yet.';
  await notify(text);
});

bot.onText(/\/deploy(?:\s+(.+))?/, async (_, match) => {
  const appName = match?.[1]?.trim();

  if (!appName) {
    await notify('Usage: `/deploy <appname>`\nSend `/apps` to see available apps.');
    return;
  }

  const { deploy, listApps } = await import('../deploy/deployer');
  const available = listApps();

  if (!available.includes(appName)) {
    await notify(
      `❌ Unknown app: \`${appName}\`\n` +
      `Available: ${available.map((a) => `\`${a}\``).join(', ')}`
    );
    return;
  }

  await notify(`🚀 *Deploy triggered*: \`${appName}\`\nStarting pull and restart...`);

  const result = await deploy(appName);

  if (result.success) {
    await notify(`✅ *Deploy succeeded*: \`${appName}\`\nHealthy in ${result.duration}s`);
  } else {
    await notify(`❌ *Deploy failed*: \`${appName}\`\n${result.message}`);
  }
});

info('Telegram bot is listening for commands...');
