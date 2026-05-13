import 'dotenv/config';
import { collect } from './collector';
import { evaluate, hasAnomalies } from './rules/engine';
import { escalate } from './ai/brain';
import { execute } from './executor';
import { notify, requestApproval } from './telegram/bot';
import { startWebhookServer } from './webhook/server';
import { log, info, error } from './logger';
import { RestartHistory } from './types';
import crypto from 'crypto';


const restartHistory: RestartHistory = {};
let isRunning = false;

const POLL_SECONDS = parseInt(process.env.POLL_INTERVAL_SECONDS ?? '60', 10);


function recordRestart(containerName: string): void {
  if (!restartHistory[containerName]) {
    restartHistory[containerName] = [];
  }
  restartHistory[containerName].push(Date.now());

  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  restartHistory[containerName] = restartHistory[containerName].filter(
    (t) => t > oneHourAgo
  );
}


async function loop(): Promise<void> {
  if (isRunning) {
    info('Previous poll still running — skipping this tick');
    return;
  }

  isRunning = true;

  try {
    const snapshot = await collect();
    const ruleMatch = evaluate(snapshot, restartHistory);

    if (ruleMatch.matched && ruleMatch.action) {
      const { action } = ruleMatch;

      if (action.tier === 'auto' && action.commands.length > 0) {
        await notify(`🔧 *Auto-fix*: ${action.message}`);

        for (const cmd of action.commands) {
          const result = await execute(cmd);

          if (result.success) {
            await notify(`✅ \`${cmd}\` — done`);
            log({ trigger: 'rule', ruleId: action.ruleId, action: cmd, result: 'success', message: action.message });

            // Track restarts
            const restartMatch = cmd.match(/^docker restart (.+)$/);
            if (restartMatch?.[1]) {
              recordRestart(restartMatch[1]);
            }
          } else {
            await notify(`❌ \`${cmd}\` — failed: ${result.error}`);
            log({ trigger: 'rule', ruleId: action.ruleId, action: cmd, result: 'failed', message: result.error ?? 'unknown' });
          }
        }
      } else if (action.tier === 'suggest' && action.commands.length > 0) {
        const approvalId = crypto.randomBytes(4).toString('hex');
        await requestApproval(approvalId, action.commands, action.message, snapshot);
        log({ trigger: 'rule', ruleId: action.ruleId, action: action.commands.join(' && '), result: 'pending_approval', message: action.message });
      } else if (action.tier === 'alert' || action.commands.length === 0) {
        await notify(`🚨 ${action.message}`);
        log({ trigger: 'rule', ruleId: action.ruleId, result: 'alert', message: action.message });

        // If it's a crash loop, escalate to AI
        if (action.ruleId === 'crash-loop') {
          info('Crash loop detected — escalating to AI');
          const decision = await escalate(snapshot);

          if (!decision) {
            await notify('⚠️ AI escalation failed — manual review required.');
            return;
          }

          if (decision.type === 'AUTO_FIX') {
            const result = await execute(decision.command);
            await notify(
              result.success
                ? `🤖 *AI Auto-fix*: ${decision.message}\n\`${decision.command}\` — done`
                : `🤖 *AI Auto-fix failed*: \`${decision.command}\` — ${result.error}`
            );
            log({ trigger: 'ai', action: decision.command, result: result.success ? 'success' : 'failed', message: decision.message });
          } else if (decision.type === 'SUGGEST') {
            const approvalId = crypto.randomBytes(4).toString('hex');
            await requestApproval(approvalId, [decision.command], `🤖 AI suggests: ${decision.message}`, snapshot);
            log({ trigger: 'ai', action: decision.command, result: 'pending_approval', message: decision.message });
          } else {
            await notify(`🤖 *AI Alert*: ${decision.message}`);
            log({ trigger: 'ai', result: 'alert', message: decision.message });
          }
        }
      }

      return;
    }

    if (!ruleMatch.matched && hasAnomalies(snapshot)) {
      info('Anomaly detected with no matching rule — escalating to AI');
      const decision = await escalate(snapshot);

      if (!decision) {
        await notify('⚠️ Anomaly detected but AI escalation failed — manual review required.');
        return;
      }

      if (decision.type === 'AUTO_FIX') {
        const result = await execute(decision.command);
        await notify(
          result.success
            ? `🤖 *AI Auto-fix*: ${decision.message}\n\`${decision.command}\` — done`
            : `🤖 *AI fix failed*: \`${decision.command}\` — ${result.error}`
        );
        log({ trigger: 'ai', action: decision.command, result: result.success ? 'success' : 'failed', message: decision.message });
      } else if (decision.type === 'SUGGEST') {
        const approvalId = crypto.randomBytes(4).toString('hex');
        await requestApproval(approvalId, [decision.command], `🤖 AI suggests: ${decision.message}`, snapshot);
        log({ trigger: 'ai', action: decision.command, result: 'pending_approval', message: decision.message });
      } else {
        await notify(`🤖 *AI Alert*: ${decision.message}`);
        log({ trigger: 'ai', result: 'alert', message: decision.message });
      }
    }

  } catch (err) {
    error('Unhandled error in main loop', err);
  } finally {
    isRunning = false;
  }
}


async function start(): Promise<void> {
  info(`🟢 Vigil is watching — polling every ${POLL_SECONDS}s`);

  startWebhookServer();

  await notify('🟢 *Vigil started* — I am watching your server.');

  await loop();

  const interval = setInterval(loop, POLL_SECONDS * 1000);

  const shutdown = async (signal: string) => {
    info(`${signal} received — shutting down`);
    clearInterval(interval);
    await notify('🔴 *Vigil stopped* — shutting down gracefully.');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  error('Failed to start Vigil', err);
  process.exit(1);
});
