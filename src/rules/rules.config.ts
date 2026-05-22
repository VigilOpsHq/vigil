import { Rule, SystemSnapshot, RestartHistory } from '../types';

const DISK_ALERT = parseInt(process.env.DISK_ALERT_PERCENT ?? '85', 10);
const MEMORY_ALERT = parseInt(process.env.MEMORY_ALERT_PERCENT ?? '90', 10);
const CRASH_LOOP_THRESHOLD = parseInt(process.env.CRASH_LOOP_THRESHOLD ?? '3', 10);
const CRASH_LOOP_WINDOW_MS =
  parseInt(process.env.CRASH_LOOP_WINDOW_MINUTES ?? '10', 10) * 60 * 1000;


function isInCrashLoop(containerName: string, history: RestartHistory): boolean {
  const timestamps = history[containerName] ?? [];
  const now = Date.now();
  const recent = timestamps.filter((t) => now - t < CRASH_LOOP_WINDOW_MS);
  return recent.length >= CRASH_LOOP_THRESHOLD;
}

function downContainers(snapshot: SystemSnapshot) {
  return snapshot.containers.filter(
    (c) => c.state === 'exited' || c.state === 'dead'
  );
}

function unhealthyChecks(snapshot: SystemSnapshot) {
  return snapshot.healthChecks.filter((h) => !h.healthy);
}


export const rules: Rule[] = [
  {
    id: 'container-down',
    description: 'Restart a stopped/exited container',
    condition: (snapshot, history) => {
      const down = downContainers(snapshot);
      if (down.length === 0) return false;
      return down.every((c) => !isInCrashLoop(c.name, history));
    },
    action: (snapshot) => {
      const down = downContainers(snapshot);
      return {
        tier: 'auto',
        ruleId: 'container-down',
        commands: down.map((c) => `docker restart ${c.name}`),
        message: `Container(s) down — restarting: ${down.map((c) => c.name).join(', ')}`,
      };
    },
  },

  {
    id: 'crash-loop',
    description: 'Container restarted too many times — escalate, do not auto-fix',
    condition: (snapshot, history) => {
      const down = downContainers(snapshot);
      return down.some((c) => isInCrashLoop(c.name, history));
    },
    action: (snapshot) => {
      const down = downContainers(snapshot);
      const looping = down.map((c) => c.name).join(', ');
      return {
        tier: 'alert',
        ruleId: 'crash-loop',
        commands: [],
        message: `🔁 Crash loop detected on: ${looping}. Escalating to AI for diagnosis.`,
      };
    },
  },

  {
    id: 'disk-high',
    description: 'Prune unused Docker images when disk usage crosses threshold',
    condition: (snapshot) => snapshot.disk.usedPercent >= DISK_ALERT,
    action: (snapshot) => ({
      tier: 'auto',
      ruleId: 'disk-high',
      commands: ['docker image prune -f', 'docker system prune -f --volumes=false'],
      message: `Disk at ${snapshot.disk.usedPercent}% (threshold: ${DISK_ALERT}%) — pruning unused Docker images`,
    }),
  },

  {
    id: 'memory-critical',
    description: 'Alert when memory crosses threshold — no auto-fix, too risky',
    condition: (snapshot) => snapshot.memory.usedPercent >= MEMORY_ALERT,
    action: (snapshot) => ({
      tier: 'alert',
      ruleId: 'memory-critical',
      commands: [],
      message: `⚠️ Memory at ${snapshot.memory.usedPercent}% (${snapshot.memory.usedMb}MB / ${snapshot.memory.totalMb}MB). Manual review needed.`,
    }),
  },

  {
    id: 'nginx-down',
    description: 'Alert when nginx is not responding — manual intervention required',
    condition: (snapshot) => !snapshot.nginx.running,
    action: () => ({
      tier: 'alert',
      ruleId: 'nginx-down',
      commands: [],
      message: '🔴 nginx is not responding on port 80. SSH in and check: systemctl status nginx',
    }),
  },

  {
    id: 'health-check-failed',
    description: 'Restart container associated with a failing health check URL',
    condition: (snapshot) => unhealthyChecks(snapshot).length > 0,
    action: (snapshot) => {
      const failed = unhealthyChecks(snapshot);
      return {
        tier: 'alert',
        ruleId: 'health-check-failed',
        commands: [],
        message: `🔴 Health check(s) failing:\n${failed
          .map((h) => `  • ${h.url} → ${h.statusCode ?? 'no response'} (${h.responseTimeMs}ms)`)
          .join('\n')}`,
      };
    },
  },
];
