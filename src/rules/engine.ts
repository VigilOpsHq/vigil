import { SystemSnapshot, RuleMatch, RestartHistory } from '../types';
import { rules } from './rules.config';

export function evaluate(
  snapshot: SystemSnapshot,
  history: RestartHistory
): RuleMatch {
  for (const rule of rules) {
    if (rule.condition(snapshot, history)) {
      return {
        matched: true,
        action: rule.action(snapshot),
      };
    }
  }

  return { matched: false };
}

/**
 * A container that was created but never started is not a failure: compose leaves these behind
 * when a recreate is interrupted, and treating them as "down" sent the same question to the AI
 * every minute. Exited, dead, restarting and paused containers still count.
 */
function troubled(snapshot: SystemSnapshot) {
  return snapshot.containers.filter((c) => c.state !== 'running' && c.state !== 'created');
}

export function hasAnomalies(snapshot: SystemSnapshot): boolean {
  return (
    troubled(snapshot).length > 0 ||
    snapshot.disk.usedPercent > parseInt(process.env.DISK_ALERT_PERCENT ?? '85', 10) ||
    snapshot.memory.usedPercent > parseInt(process.env.MEMORY_ALERT_PERCENT ?? '90', 10) ||
    !snapshot.nginx.running ||
    snapshot.healthChecks.some((h) => !h.healthy)
  );
}

/**
 * What is wrong, without the numbers that move every poll — so the same problem gives the same
 * signature while it lasts, and a new problem gives a new one.
 */
export function anomalySignature(snapshot: SystemSnapshot): string {
  const parts = [
    ...troubled(snapshot).map((c) => `container:${c.name}:${c.state}`).sort(),
    snapshot.disk.usedPercent > parseInt(process.env.DISK_ALERT_PERCENT ?? '85', 10) ? 'disk' : '',
    snapshot.memory.usedPercent > parseInt(process.env.MEMORY_ALERT_PERCENT ?? '90', 10) ? 'memory' : '',
    snapshot.nginx.running ? '' : 'nginx',
    ...snapshot.healthChecks.filter((h) => !h.healthy).map((h) => `health:${h.url}`).sort(),
  ];
  return parts.filter(Boolean).join('|') || 'none';
}
