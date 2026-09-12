import axios from 'axios';
import { SystemSnapshot, AIDecision } from '../types';
import { error, info } from '../logger';

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? '';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';

const SYSTEM_PROMPT_MONITOR = `You are Vigil, an autonomous DevOps agent monitoring a Linux VPS.
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

/**
 * Call DeepSeek for AI decision-making on system issues
 * Used for continuous monitoring and healing
 */
export async function escalateForMonitoring(snapshot: SystemSnapshot): Promise<AIDecision | null> {
  const snapshotSummary = buildMonitoringPrompt(snapshot);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      info(`[deepseek] Escalating for monitoring (attempt ${attempt + 1})`);

      const response = await axios.post(
        'https://api.deepseek.com/chat/completions',
        {
          model: DEEPSEEK_MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT_MONITOR },
            { role: 'user', content: `System snapshot:\n\n${snapshotSummary}\n\nWhat should I do?` }
          ],
          temperature: 0.3,
          max_tokens: 1000,
        },
        {
          headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` },
          timeout: 15_000
        }
      );

      const text = response.data?.choices?.[0]?.message?.content ?? '';
      const clean = text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);
      const decision = validateDecision(parsed);

      if (decision) {
        info(`[deepseek] Decision: ${decision.type}`);
        return decision;
      }

      error(`[deepseek] Invalid response format (attempt ${attempt + 1}): ${clean}`);
    } catch (err) {
      error(`[deepseek] API call failed (attempt ${attempt + 1})`, err);
    }
  }

  return null;
}

/**
 * Call DeepSeek for migration planning (uses reasoning effort)
 * For complex multi-step workflows that need deep analysis
 */
export async function escalateForMigration(prompt: string, useReasoning: boolean = true): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      info(`[deepseek] Escalating for migration planning (attempt ${attempt + 1})`);

      const config: Record<string, unknown> = {
        model: DEEPSEEK_MODEL,
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

      // Use reasoning model for complex migration logic if available
      if (useReasoning && DEEPSEEK_MODEL.includes('reasoner')) {
        config['reasoning_effort'] = 'high';
      }

      const response = await axios.post(
        'https://api.deepseek.com/chat/completions',
        config,
        {
          headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` },
          timeout: 30_000
        }
      );

      const text = response.data?.choices?.[0]?.message?.content ?? '';
      const clean = text.replace(/```json|```/g, '').trim();

      // Verify it's valid JSON
      JSON.parse(clean);

      info(`[deepseek] Migration plan generated successfully`);
      return clean;
    } catch (err) {
      error(`[deepseek] Migration planning failed (attempt ${attempt + 1})`, err);
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
