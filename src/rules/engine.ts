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

export function hasAnomalies(snapshot: SystemSnapshot): boolean {
  return (
    snapshot.containers.some((c) => c.state !== 'running') ||
    snapshot.disk.usedPercent > parseInt(process.env.DISK_ALERT_PERCENT ?? '85', 10) ||
    snapshot.memory.usedPercent > parseInt(process.env.MEMORY_ALERT_PERCENT ?? '90', 10) ||
    !snapshot.nginx.running ||
    snapshot.healthChecks.some((h) => !h.healthy)
  );
}
