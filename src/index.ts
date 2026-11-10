import 'dotenv/config';
import { collect } from './collector';
import { anomalySignature, evaluate, hasAnomalies } from './rules/engine';
import { aiEnabled, escalate } from './ai/brain';
import { canEverRun, execute, needsApproval } from './executor';
import {
  ESCALATION_COOLDOWN_MS, FAILED_COMMAND_COOLDOWN_MS, clearAlerts, hasOpenAlerts,
  recentlyFailed, recentlySucceeded, recordResult, shouldAlert,
} from './memory';
import { notify, requestApproval } from './telegram/bot';
import { startWebhookServer } from './webhook/server';
import { startBackupScheduler } from './backup/schedule';
import { currentVersion, takeUpdateResult } from './update';
import { startCloudHeartbeat } from './cloud';
import { log, info, error } from './logger';
import { RestartHistory, AIDecision, SystemSnapshot } from './types';
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

/** Send an alert unless the same one went out within the cooldown. */
async function alertOnce(key: string, message: string): Promise<void> {
  if (shouldAlert(key)) await notify(message);
}

/**
 * Run a fix unless it failed recently (it will fail again) or just worked (running it again
 * changes nothing). Returns whether it ran.
 */
async function runFix(command: string, origin: { trigger: 'rule' | 'ai'; ruleId?: string; message: string }): Promise<boolean> {
  if (recentlyFailed(command)) {
    await alertOnce(`failed:${command}`,
      `⏸ Not retrying \`${command}\` — it failed within the last ${Math.round(FAILED_COMMAND_COOLDOWN_MS / 3_600_000)}h. ${origin.message}\nThis needs a person.`);
    return false;
  }
  if (recentlySucceeded(command)) return false;

  const result = await execute(command);
  recordResult(command, result.success);
  log({ trigger: origin.trigger, ruleId: origin.ruleId, action: command, result: result.success ? 'success' : 'failed', message: result.success ? origin.message : result.error ?? 'unknown' });

  if (result.success) {
    const restartMatch = command.match(/^docker restart (.+)$/);
    if (restartMatch?.[1]) recordRestart(restartMatch[1]);
  }
  return true;
}

async function handleDecision(
  decision: AIDecision,
  snapshot: SystemSnapshot
): Promise<void> {
  // The AI may name a command Vigil can never run (docker rm, compose…). Asking for approval
  // would only end in "not in allowlist", so it becomes advice for the operator instead.
  if (decision.type !== 'ALERT' && !canEverRun(decision.command)) {
    await alertOnce(`ai:manual:${decision.command}`,
      `🤖 *AI*: ${decision.message}\n\nVigil can't run this itself. If it looks right, run it on the server:\n\`${decision.command}\``);
    log({ trigger: 'ai', action: decision.command, result: 'alert', message: `manual: ${decision.message}` });
    return;
  }

  if (decision.type === 'AUTO_FIX' && needsApproval(decision.command)) {
    if (!shouldAlert(`approval:${decision.command}`)) return;
    const approvalId = crypto.randomBytes(4).toString('hex');
    await requestApproval(approvalId, [decision.command], `🤖 AI wants to run: ${decision.message}`, snapshot);
    log({ trigger: 'ai', action: decision.command, result: 'pending_approval', message: decision.message });
  } else if (decision.type === 'AUTO_FIX') {
    const failedBefore = recentlyFailed(decision.command);
    const ran = await runFix(decision.command, { trigger: 'ai', message: decision.message });
    if (!ran || failedBefore) return;
    const ok = !recentlyFailed(decision.command);
    await notify(ok
      ? `🤖 *AI Auto-fix*: ${decision.message}\n\`${decision.command}\` — done`
      : `🤖 *AI Auto-fix failed*: \`${decision.command}\` — Vigil won't try it again for ${Math.round(FAILED_COMMAND_COOLDOWN_MS / 3_600_000)}h.`);
  } else if (decision.type === 'SUGGEST') {
    if (!shouldAlert(`approval:${decision.command}`)) return;
    const approvalId = crypto.randomBytes(4).toString('hex');
    await requestApproval(approvalId, [decision.command], `🤖 AI suggests: ${decision.message}`, snapshot);
    log({ trigger: 'ai', action: decision.command, result: 'pending_approval', message: decision.message });
  } else {
    await alertOnce(`ai:alert:${anomalySignature(snapshot)}`, `🤖 *AI Alert*: ${decision.message}`);
    log({ trigger: 'ai', result: 'alert', message: decision.message });
  }
}

let lastEscalation: { signature: string; at: number } | null = null;

async function loop(): Promise<void> {
  if (isRunning) {
    info('Previous poll still running — skipping this tick');
    return;
  }

  isRunning = true;

  try {
    const snapshot = await collect();
    const ruleMatch = evaluate(snapshot, restartHistory);
    const anomalous = hasAnomalies(snapshot);
    let needsEscalation = false;

    // Healthy again after an alert: say so once, and forget the open alerts.
    if (!ruleMatch.matched && !anomalous) {
      lastEscalation = null;
      if (hasOpenAlerts()) {
        clearAlerts();
        await notify('✅ *All clear* — the server is healthy again.');
      }
      return;
    }

    if (ruleMatch.matched && ruleMatch.action) {
      const { action } = ruleMatch;

      if (action.tier === 'auto' && action.commands.length > 0) {
        const runnable = action.commands.filter((c) => !recentlyFailed(c) && !recentlySucceeded(c));

        if (runnable.length > 0) {
          await notify(`🔧 *Auto-fix*: ${action.message}`);
          for (const cmd of action.commands) {
            const failedBefore = recentlyFailed(cmd);
            const ran = await runFix(cmd, { trigger: 'rule', ruleId: action.ruleId, message: action.message });
            if (!ran || failedBefore) continue;
            await notify(recentlyFailed(cmd) ? `❌ \`${cmd}\` — failed. Vigil won't retry it for a while.` : `✅ \`${cmd}\` — done`);
          }
          return;
        }

        // Every fix was already tried and the problem is still here: say so once, and let the
        // AI look at it instead of repeating the same fix every minute.
        await alertOnce(`rule:${action.ruleId}:stuck`, `⚠️ ${action.message}\n\nAlready tried — it is still happening. This needs a person.`);
      }

      else if (action.tier === 'suggest' && action.commands.length > 0) {
        if (!shouldAlert(`rule:${action.ruleId}:approval`)) return;
        const approvalId = crypto.randomBytes(4).toString('hex');
        await requestApproval(approvalId, action.commands, action.message, snapshot);
        log({ trigger: 'rule', ruleId: action.ruleId, action: action.commands.join(' && '), result: 'pending_approval', message: action.message });
        return;
      }

      else if (shouldAlert(`rule:${action.ruleId}`)) {
        await notify(`🚨 ${action.message}`);
        log({ trigger: 'rule', ruleId: action.ruleId, result: 'alert', message: action.message });
      }
      needsEscalation = true;
    }

    if (!ruleMatch.matched && anomalous) {
      info('Anomaly detected with no matching rule — escalating to AI');
      needsEscalation = true;
    }

    if (needsEscalation) {
      if (!aiEnabled) {
        info('No AI provider configured — skipping escalation');
        return;
      }

      // The same problem, already put to the AI: its answer won't change, so don't ask again
      // every minute.
      const signature = anomalySignature(snapshot);
      if (lastEscalation && lastEscalation.signature === signature && Date.now() - lastEscalation.at < ESCALATION_COOLDOWN_MS) {
        return;
      }
      lastEscalation = { signature, at: Date.now() };

      info('Escalating to AI...');
      const decision = await escalate(snapshot);

      if (!decision) {
        await alertOnce('ai:failed', '⚠️ AI escalation failed — manual review required.');
        return;
      }

      await handleDecision(decision, snapshot);
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
  startBackupScheduler();
  startCloudHeartbeat();

  await notify(`🟢 *VigilOps ${currentVersion()} started* — I am watching your server.`);

  // The updater may still be writing its result as this container comes up.
  const reportUpdate = async () => {
    const result = takeUpdateResult();
    if (result) await notify(result);
    return Boolean(result);
  };
  if (!(await reportUpdate())) setTimeout(() => { void reportUpdate(); }, 45_000);

  await loop();

  const interval = setInterval(loop, POLL_SECONDS * 1000);

  const shutdown = async (signal: string) => {
    info(`${signal} received — shutting down`);
    clearInterval(interval);
    await notify('🔴 *VigilOps stopped* — shutting down gracefully.');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  error('Failed to start Vigil', err);
  process.exit(1);
});
