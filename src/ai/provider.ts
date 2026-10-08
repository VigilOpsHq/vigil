import axios from 'axios';
import { SystemSnapshot, AIDecision } from '../types';
import { error, info } from '../logger';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';

const setting = (name: string): string | undefined => process.env[name]?.trim() || undefined;

const API_KEY = setting('AI_API_KEY') ?? setting('DEEPSEEK_API_KEY') ?? '';
const MODEL = setting('AI_MODEL') ?? setting('DEEPSEEK_MODEL') ?? 'deepseek-chat';
const BASE_URL = (setting('AI_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
const ENDPOINT = BASE_URL.endsWith('/chat/completions') ? BASE_URL : `${BASE_URL}/chat/completions`;

export const aiEnabled = Boolean(API_KEY) || BASE_URL !== DEFAULT_BASE_URL;

export function aiProvider(): string {
  try {
    return `${new URL(BASE_URL).hostname} (${MODEL})`;
  } catch {
    return `${BASE_URL} (${MODEL})`;
  }
}

const headers = API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {};

const SYSTEM_PROMPT_MONITOR = `You are Vigil, an autonomous DevOps agent monitoring a Linux VPS.
You are called only when the rule engine cannot resolve an issue automatically.

Your job is to analyse the system snapshot and decide what to do.

You must respond with ONLY valid JSON — no markdown, no explanation outside the JSON.

Response format:
{
  "type": "AUTO_FIX" | "SUGGEST" | "ALERT",
  "command": "<shell command>",
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
- systemctl reload nginx

Installing or removing packages (apt) is never an AUTO_FIX. Use SUGGEST for it,
so a human approves before anything is installed.`;

function validateDecision(raw: unknown): AIDecision | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.type !== 'string') return null;

  if (obj.type === 'AUTO_FIX' || obj.type === 'SUGGEST') {
    if (typeof obj.command !== 'string' || !obj.command.trim()) return null;
    if (typeof obj.message !== 'string' || !obj.message.trim()) return null;
    return {
      type: obj.type,
      command: obj.command.trim(),
      message: obj.message.trim(),
      reasoning: typeof obj.reasoning === 'string' ? obj.reasoning.trim() : '',
    };
  }

  if (obj.type === 'ALERT') {
    return {
      type: 'ALERT',
      message: typeof obj.message === 'string' ? obj.message.trim() : 'Unknown alert',
      reasoning: typeof obj.reasoning === 'string' ? obj.reasoning.trim() : '',
    };
  }

  return null;
}

function parseJson(text: string): unknown {
  const clean = text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error(`no JSON in response: ${clean.slice(0, 200)}`);
    return JSON.parse(clean.slice(start, end + 1));
  }
}

export async function escalateForMonitoring(snapshot: SystemSnapshot): Promise<AIDecision | null> {
  if (!aiEnabled) {
    info('[ai] No provider configured — skipping escalation');
    return null;
  }

  const snapshotSummary = buildMonitoringPrompt(snapshot);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      info(`[ai] Escalating to ${aiProvider()} (attempt ${attempt + 1})`);

      const response = await axios.post(
        ENDPOINT,
        {
          model: MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT_MONITOR },
            { role: 'user', content: `System snapshot:\n\n${snapshotSummary}\n\nWhat should I do?` }
          ],
          temperature: 0.3,
          max_tokens: 1000,
        },
        { headers, timeout: 15_000 }
      );

      const text = response.data?.choices?.[0]?.message?.content ?? '';
      const decision = validateDecision(parseJson(text));

      if (decision) {
        info(`[ai] Decision: ${decision.type}`);
        return decision;
      }

      error(`[ai] Response didn't match the expected format (attempt ${attempt + 1}): ${String(text).slice(0, 300)}`);
    } catch (err) {
      error(`[ai] Call to ${ENDPOINT} failed (attempt ${attempt + 1})`, err);
    }
  }

  return null;
}

export async function escalateForMigration(prompt: string, useReasoning: boolean = true): Promise<string | null> {
  if (!aiEnabled) {
    error('[ai] No provider configured — cannot plan a migration');
    return null;
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      info(`[ai] Planning a migration with ${aiProvider()} (attempt ${attempt + 1})`);

      const config: Record<string, unknown> = {
        model: MODEL,
        messages: [
          {
            role: 'system',
            content: `You are a DevOps architect planning infrastructure migrations.
Consider: minimal downtime, data consistency, service dependencies, rollback safety, cost optimization.
Respond with ONLY valid JSON.`
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 3000,
      };

      if (useReasoning && MODEL.includes('reasoner')) {
        config['reasoning_effort'] = 'high';
      }

      const response = await axios.post(ENDPOINT, config, { headers, timeout: 30_000 });

      const text = response.data?.choices?.[0]?.message?.content ?? '';
      const plan = JSON.stringify(parseJson(text));

      info('[ai] Migration plan generated successfully');
      return plan;
    } catch (err) {
      error(`[ai] Migration planning failed (attempt ${attempt + 1})`, err);
    }
  }

  return null;
}

function buildMonitoringPrompt(snapshot: SystemSnapshot): string {
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
