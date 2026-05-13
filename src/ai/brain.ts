import Anthropic from '@anthropic-ai/sdk';
import { SystemSnapshot, AIDecision } from '../types';
import { error } from '../logger';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are Vigil, an autonomous DevOps agent monitoring a Linux VPS.
You are called only when the rule engine cannot resolve an issue automatically.

Your job is to analyse the system snapshot and decide what to do.

You must respond with ONLY valid JSON — no markdown, no explanation outside the JSON.

Response format:
{
  "type": "AUTO_FIX" | "SUGGEST" | "ALERT",
  "command": "<shell command>",   // required for AUTO_FIX and SUGGEST
  "message": "<human-readable summary>",
  "reasoning": "<why you made this decision>"
}

Decision rules:
- AUTO_FIX: safe, reversible, low-risk actions (e.g. docker restart, nginx reload, image prune)
- SUGGEST: actions that could have side effects and need human approval
- ALERT: you are not confident enough to suggest a command — just notify the operator

Safety rules you MUST follow:
- NEVER suggest rm -rf or any destructive file deletion
- NEVER suggest database DROP, TRUNCATE, or DELETE operations
- NEVER suggest modifying nginx.conf or any config file
- NEVER suggest exposing new ports
- NEVER suggest pulling or running unknown Docker images
- If in doubt, choose ALERT over AUTO_FIX or SUGGEST

Allowed commands for AUTO_FIX:
- docker restart <container_name>
- docker image prune -f
- docker system prune -f --volumes=false
- systemctl restart nginx
- systemctl reload nginx`;

export async function escalate(snapshot: SystemSnapshot): Promise<AIDecision | null> {
  const snapshotSummary = buildSnapshotSummary(snapshot);

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `System snapshot:\n\n${snapshotSummary}\n\nWhat should I do?`,
        },
      ],
    });

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('');

    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean) as AIDecision;
  } catch (err) {
    error('AI escalation failed', err);
    return null;
  }
}

function buildSnapshotSummary(snapshot: SystemSnapshot): string {
  const lines: string[] = [];

  lines.push(`Timestamp: ${snapshot.timestamp.toISOString()}`);
  lines.push('');

  lines.push('=== Containers ===');
  if (snapshot.containers.length === 0) {
    lines.push('  No containers found');
  } else {
    for (const c of snapshot.containers) {
      lines.push(`  ${c.name} [${c.state}] — ${c.status}`);
    }
  }

  lines.push('');
  lines.push('=== Disk ===');
  lines.push(
    `  ${snapshot.disk.used} used of ${snapshot.disk.total} (${snapshot.disk.usedPercent}% used, ${snapshot.disk.available} free)`
  );

  lines.push('');
  lines.push('=== Memory ===');
  lines.push(
    `  ${snapshot.memory.usedMb}MB used of ${snapshot.memory.totalMb}MB (${snapshot.memory.usedPercent}%)`
  );

  lines.push('');
  lines.push('=== Nginx ===');
  lines.push(`  ${snapshot.nginx.running ? 'running' : 'NOT RUNNING'}`);

  if (snapshot.healthChecks.length > 0) {
    lines.push('');
    lines.push('=== Health Checks ===');
    for (const h of snapshot.healthChecks) {
      lines.push(
        `  ${h.url} → ${h.healthy ? 'healthy' : 'UNHEALTHY'} (${h.statusCode ?? 'no response'}, ${h.responseTimeMs}ms)`
      );
    }
  }

  return lines.join('\n');
}
