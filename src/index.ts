import 'dotenv/config';
import { collect } from './collector';
import { anomalySignature, evaluate, hasAnomalies } from './rules/engine';
import { aiEnabled, escalate } from './ai/brain';
import { canEverRun, execute, needsApproval } from './executor';
import {
  ESCALATION_COOLDOWN_MS, FAILED_COMMAND_COOLDOWN_MS, clearAlerts, hasOpenAlerts,
  recentlyFailed, recentlySucceeded, recordResult, shouldAlert,
} from './memory';
import { notify, notifyIncident, requestApproval } from './telegram/bot';
import { Diagnosis, diagnosisKey, formatTelegram, investigate, restartCanHelp, saveIncident } from './diagnose';
import { isOneOffJob } from './rules/containers';
import { startWebhookServer } from './webhook/server';
import { startBackupScheduler } from './backup/schedule';
import { currentVersion, takeUpdateResult } from './update';
import { startCloudHeartbeat } from './cloud';
import { log, info, error } from './logger';
import { RestartHistory, AIDecision, SystemSnapshot } from './types';
import crypto from 'crypto';

const restartHistory: RestartHistory = {};
let isRunning = false;

/** The latest diagnosis per container, so a restart it rules out isn't tried again and again. */
const diagnosed = new Map<string, { diagnosis: Diagnosis; at: number }>();
const DIAGNOSIS_TTL_MS = 60 * 60 * 1000;
const MAX_INVESTIGATIONS = 3;

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

const HEALTH_CHECK_CONTAINER_MAP: Record<string, string> = Object.fromEntries(
  (process.env.HEALTH_CHECK_CONTAINER_MAP ?? '').split(',').map((p) => p.trim()).filter(Boolean)
    .map((p) => [p.slice(0, p.lastIndexOf(':')).trim(), p.slice(p.lastIndexOf(':') + 1).trim()])
);

/** Containers worth investigating: failing services, plus apps behind a failing health check. */
function suspects(snapshot: SystemSnapshot): string[] {
  const failing = snapshot.containers
    .filter((c) => (c.state === 'restarting' || c.state === 'exited' || c.state === 'dead') && !isOneOffJob(c))
    .map((c) => c.name);
  const behindChecks = snapshot.healthChecks.filter((h) => !h.healthy)
    .map((h) => HEALTH_CHECK_CONTAINER_MAP[h.url]).filter((n): n is string => Boolean(n));
  return [...new Set([...failing, ...behindChecks])].slice(0, MAX_INVESTIGATIONS);
}

/** Investigate, store and report each suspect. One alert per container and cause. */
async function investigateSuspects(snapshot: SystemSnapshot): Promise<Diagnosis[]> {
  const context = [
    ...snapshot.healthChecks.filter((h) => !h.healthy).map((h) => `health check ${h.url} → ${h.statusCode ?? 'no response'}`),
    snapshot.disk.usedPercent >= parseInt(process.env.DISK_ALERT_PERCENT ?? '85', 10) ? `disk ${snapshot.disk.usedPercent}% full` : '',
    snapshot.memory.usedPercent >= parseInt(process.env.MEMORY_ALERT_PERCENT ?? '90', 10) ? `memory ${snapshot.memory.usedPercent}% used` : '',
  ].filter(Boolean);

  const out: Diagnosis[] = [];
  for (const name of suspects(snapshot)) {
    try {
      const d = await investigate(name, context);
      out.push(d);
      diagnosed.set(name, { diagnosis: d, at: Date.now() });
      saveIncident(d);
      const f = d.findings[0];
      log({ trigger: 'rule', ruleId: 'diagnose', result: 'alert', message: `${name}: ${f ? f.title : `no known pattern — ${d.evidence.errors[0] ?? d.evidence.state}`}` });
      if (shouldAlert(diagnosisKey(d))) await notifyIncident(formatTelegram(d), d.id);
    } catch (err) {
      error(`Investigation of ${name} failed`, err);
    }
  }
  return out;
}

/**
 * Why `docker restart X` should not run, or null when it may. A container Docker is already
 * restarting, or one whose diagnosis says the cause survives a restart, only gets worse for it.
 */
function restartBlocked(command: string, snapshot: SystemSnapshot): string | null {
  const name = /^docker restart (.+)$/.exec(command)?.[1];
  if (!name) return null;
  const known = diagnosed.get(name);
  if (known && Date.now() - known.at < DIAGNOSIS_TTL_MS && !restartCanHelp(known.diagnosis)) {
    return `${name}: ${known.diagnosis.findings[0].title} — a restart cannot fix that`;
  }
  const c = snapshot.containers.find((x) => x.name === name);
  if (c?.state === 'restarting') return `${name} is already in Docker's restart loop — another restart changes nothing`;
  return null;
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
  } else if (decision.type === 'AUTO_FIX' && restartBlocked(decision.command, snapshot)) {
    // The AI asked for a restart a diagnosis (or Docker's own loop) has already ruled out.
    const reason = restartBlocked(decision.command, snapshot)!;
    await alertOnce(`ai:alert:${anomalySignature(snapshot)}`, `🤖 *AI Alert*: ${decision.message}\n\nNot restarting: ${reason}.`);
    log({ trigger: 'ai', action: decision.command, result: 'alert', message: `restart blocked: ${reason}` });
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
        const blocked = action.commands.filter((c) => restartBlocked(c, snapshot));
        const runnable = action.commands.filter((c) => !blocked.includes(c) && !recentlyFailed(c) && !recentlySucceeded(c));

        if (runnable.length > 0) {
          await notify(`🔧 *Auto-fix*: ${action.message}`);
          for (const cmd of runnable) {
            const failedBefore = recentlyFailed(cmd);
            const ran = await runFix(cmd, { trigger: 'rule', ruleId: action.ruleId, message: action.message });
            if (!ran || failedBefore) continue;
            await notify(recentlyFailed(cmd) ? `❌ \`${cmd}\` — failed. Vigil won't retry it for a while.` : `✅ \`${cmd}\` — done`);
          }
          return;
        }

        // Every fix was already tried (or ruled out by a diagnosis) and the problem is still
        // here: say so once, and investigate instead of repeating the same fix every minute.
        if (blocked.length < action.commands.length) {
          await alertOnce(`rule:${action.ruleId}:stuck`, `⚠️ ${action.message}\n\nAlready tried — it is still happening. This needs a person.`);
        }
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
      // The same problem, already investigated: the answer won't change, so don't look again
      // every minute.
      const signature = anomalySignature(snapshot);
      if (lastEscalation && lastEscalation.signature === signature && Date.now() - lastEscalation.at < ESCALATION_COOLDOWN_MS) {
        return;
      }
      lastEscalation = { signature, at: Date.now() };

      // Look first, with or without AI: the evidence is on this server.
      const diagnoses = await investigateSuspects(snapshot);
      const otherTrouble = snapshot.disk.usedPercent >= parseInt(process.env.DISK_ALERT_PERCENT ?? '85', 10)
        || snapshot.memory.usedPercent >= parseInt(process.env.MEMORY_ALERT_PERCENT ?? '90', 10)
        || !snapshot.nginx.running;
      if (diagnoses.length > 0 && diagnoses.every((d) => d.findings.length > 0) && !otherTrouble) {
        info('Every failing container has a diagnosis — not asking the AI');
        return;
      }

      if (!aiEnabled) {
        info('No AI provider configured — skipping escalation');
        return;
      }

      info('Escalating to AI...');
      const decision = await escalate(snapshot, diagnoses);

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
