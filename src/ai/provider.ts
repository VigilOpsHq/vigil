import axios from 'axios';
import { SystemSnapshot, AIDecision } from '../types';
import type { Diagnosis } from '../diagnose/types';
import { error, info } from '../logger';
import { autoAllowedExamples, systemctlAvailable } from '../executor';

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

function monitorPrompt(): string {
  return `You are Vigil, an autonomous DevOps agent monitoring a Linux VPS.
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

Allowed commands for AUTO_FIX — Vigil cannot run anything else on its own:
${autoAllowedExamples().map((c) => `- ${c}`).join('\n')}
${systemctlAvailable() ? '' : '\nThere is no systemctl here: never suggest a systemctl command. If a host service such as nginx is down, choose ALERT.\n'}
SUGGEST is only for installing or removing packages (sudo apt update | upgrade -y | install -y <pkg> | remove -y <pkg>).
Anything else — docker rm, docker compose, editing files — Vigil cannot run even with approval:
choose ALERT and put the exact command in the message for the operator to run themselves.
Containers in the "created" state that were never started are usually leftovers of a deploy; never suggest removing a running container.

Restarts:
- A container in the "restarting" state is already being restarted by Docker. Never AUTO_FIX a docker restart for it.
- When the investigation shows a container crashing on startup (a config, dependency, env or code error), a restart repeats the same crash: choose ALERT, name the cause from the errors, and say what to change.
- Base your diagnosis on the "Investigation" section: the first error in the latest start is usually the cause, the later ones are consequences.`;
}

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

export async function escalateForMonitoring(snapshot: SystemSnapshot, diagnoses: Diagnosis[] = []): Promise<AIDecision | null> {
  if (!aiEnabled) {
    info('[ai] No provider configured — skipping escalation');
    return null;
  }

  const snapshotSummary = buildMonitoringPrompt(snapshot, diagnoses);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      info(`[ai] Escalating to ${aiProvider()} (attempt ${attempt + 1})`);

      const response = await axios.post(
        ENDPOINT,
        {
          model: MODEL,
          messages: [
            { role: 'system', content: monitorPrompt() },
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

function buildMonitoringPrompt(snapshot: SystemSnapshot, diagnoses: Diagnosis[] = []): string {
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

  for (const d of diagnoses) {
    const e = d.evidence;
    lines.push('');
    lines.push(`=== Investigation: ${e.container} ===`);
    lines.push(`  state ${e.state}${e.exitCode !== null ? `, exit ${e.exitCode}` : ''}${e.oomKilled ? ', OOM-killed' : ''}, ${e.restartCount} restarts, image ${e.image}${e.imageArch ? ` (${e.imageArch}, server ${e.hostArch})` : ''}`);
    if (d.findings.length) lines.push(`  Known pattern: ${d.findings.map((f) => `${f.title} — ${f.cause}`).join(' | ')}`);
    if (e.errors.length) lines.push(`  Errors in the latest start, in order:\n${e.errors.slice(0, 6).map((x) => `    - ${x.slice(0, 300)}`).join('\n')}`);
    const tail = (e.lastCycle.length ? e.lastCycle : e.logTail).slice(-30).join('\n');
    if (tail) lines.push(`  Log of the latest start (secrets removed):\n${tail.slice(-3000)}`);
    const sized = Object.entries(e.fileSizes).map(([f, n]) => `${f} (${n} bytes)`);
    if (sized.length) lines.push(`  Changed files: ${sized.join(', ')}`);
    if (e.gaps.length) lines.push(`  Could not read: ${e.gaps.join(', ')}`);
  }

  return lines.join('\n');
}
