import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { gatherEvidence } from './evidence';
import { runPlaybooks } from './playbooks';
import { Diagnosis, Evidence, Finding } from './types';

export type { Diagnosis, Evidence, Finding } from './types';

const INCIDENT_DIR = path.resolve(process.cwd(), 'logs', 'incidents');
const KEEP_INCIDENTS = 100;

/** Investigate one container: gather evidence, match it against the playbooks. Changes nothing. */
export async function investigate(container: string, context: string[] = []): Promise<Diagnosis> {
  const evidence = await gatherEvidence(container);
  return {
    id: `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`,
    host: os.hostname(),
    createdAt: new Date().toISOString(),
    evidence,
    findings: runPlaybooks(evidence),
    context,
  };
}

/** Same problem, same key — so the alert for it goes out once, not every poll. */
export function diagnosisKey(d: Diagnosis): string {
  return `diag:${d.evidence.container}:${d.findings[0]?.id ?? d.evidence.errors[0]?.slice(0, 80) ?? d.evidence.state}`;
}

/** Whether a restart could plausibly fix this. False when a playbook says the cause survives it. */
export function restartCanHelp(d: Diagnosis): boolean {
  return d.findings.length === 0 || d.findings[0].restartHelps;
}

// ── Storage ─────────────────────────────────────────────────────────────────────────────────

export function saveIncident(d: Diagnosis): void {
  try {
    fs.mkdirSync(INCIDENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(INCIDENT_DIR, `${d.id}.json`), JSON.stringify(d, null, 2));
    const files = fs.readdirSync(INCIDENT_DIR).filter((f) => f.endsWith('.json')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_INCIDENTS))) fs.rmSync(path.join(INCIDENT_DIR, f), { force: true });
  } catch {
    // Not being able to store an incident must not stop the alert.
  }
}

export function loadIncident(id: string): Diagnosis | null {
  if (!/^[a-z0-9]+$/.test(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(INCIDENT_DIR, `${id}.json`), 'utf8')) as Diagnosis;
  } catch {
    return null;
  }
}

/** Newest first. */
export function listIncidents(limit = 20, container?: string): Diagnosis[] {
  try {
    return fs.readdirSync(INCIDENT_DIR).filter((f) => f.endsWith('.json')).sort().reverse()
      .map((f) => loadIncident(f.replace(/\.json$/, '')))
      .filter((d): d is Diagnosis => d !== null && (!container || d.evidence.container === container))
      .slice(0, limit);
  } catch {
    return [];
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────────────────────

function stateLine(e: Evidence): string {
  const parts = [e.state];
  if (e.exitCode !== null && e.state !== 'running') parts.push(`exit ${e.exitCode}`);
  if (e.oomKilled) parts.push('OOM-killed');
  if (e.restartCount > 0) parts.push(`${e.restartCount} restarts`);
  return parts.join(', ');
}

const html = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** `code` spans in playbook text become <code>; everything else is escaped. */
const inline = (s: string) => html(s).replace(/`([^`]+)`/g, '<code>$1</code>');

/** The Telegram alert, as HTML. Short: the full detail is one tap away. */
export function formatTelegram(d: Diagnosis): string {
  const e = d.evidence;
  const f = d.findings[0];
  const lines: string[] = [];
  if (f) {
    lines.push(`🔎 <b>${html(e.container)}</b>: ${inline(f.title)}`);
    lines.push(`<i>${html(stateLine(e))}</i>`);
    lines.push('');
    lines.push(inline(f.cause));
    if (f.evidence.length > 0) {
      lines.push('');
      lines.push('<b>Evidence</b>');
      for (const ev of f.evidence.slice(0, 4)) lines.push(`• ${inline(ev)}`);
    }
    lines.push('');
    lines.push('<b>Fix now</b>');
    for (const step of f.fixNow) lines.push(`• ${inline(step)}`);
    if (f.commands?.length) lines.push(`<pre>${html(f.commands.join('\n'))}</pre>`);
    lines.push('');
    lines.push(`<b>So it doesn't happen again</b>\n${inline(f.permanentFix)}`);
    if (!f.restartHelps) lines.push('\n<i>Vigil will not restart it: a restart cannot fix this.</i>');
  } else {
    lines.push(`🔎 <b>${html(e.container)}</b> is failing — no known pattern matched`);
    lines.push(`<i>${html(stateLine(e))}</i>`);
    if (e.errors.length > 0) {
      lines.push('');
      lines.push('<b>First error in the latest start</b>');
      lines.push(`<pre>${html(e.errors[0].slice(0, 600))}</pre>`);
      if (e.errors.length > 1) lines.push(`…and ${e.errors.length - 1} more`);
    } else if (e.gaps.length > 0) {
      lines.push(`\nCould not read: ${html(e.gaps.join(', '))}`);
    }
  }
  lines.push('');
  lines.push('Tap <b>Fix prompt</b> to hand this to Cursor or Claude Code.');
  const text = lines.join('\n');
  return text.length > 3900 ? `${text.slice(0, 3880)}…` : text;
}

/** Plain text for the terminal. */
export function formatText(d: Diagnosis): string {
  const e = d.evidence;
  const out: string[] = [];
  out.push(`\n🔎 ${e.container} — ${stateLine(e)}`);
  out.push(`   image: ${e.image}${e.imageArch ? ` (${e.imageArch}, server ${e.hostArch})` : ''}`);
  if (d.findings.length === 0) {
    out.push('\nNo known pattern matched.');
  }
  for (const [i, f] of d.findings.entries()) {
    out.push(`\n${i === 0 ? 'DIAGNOSIS' : 'ALSO POSSIBLE'}: ${f.title} (${f.confidence} confidence)`);
    out.push(`\n  ${f.cause}`);
    if (f.evidence.length) out.push(`\n  Evidence:\n${f.evidence.map((x) => `    • ${x}`).join('\n')}`);
    out.push(`\n  Fix now:\n${f.fixNow.map((x) => `    • ${x}`).join('\n')}`);
    if (f.commands?.length) out.push(`\n${f.commands.map((c) => `    $ ${c}`).join('\n')}`);
    out.push(`\n  So it doesn't happen again:\n    ${f.permanentFix}`);
    if (i === 0 && !f.restartHelps) out.push('\n  A restart will not fix this.');
  }
  if (e.errors.length) out.push(`\nERRORS IN THE LATEST START\n${e.errors.map((x) => `  • ${x}`).join('\n')}`);
  if (e.gaps.length) out.push(`\nCould not read: ${e.gaps.join(', ')}`);
  out.push(`\nIncident ${d.id} — \`vigil diagnose ${e.container} --prompt\` prints a prompt for your coding agent.\n`);
  return out.join('\n');
}

/**
 * A prompt for the user's coding agent (Cursor, Claude Code, Copilot…), which has the repository
 * but not the server. It gets everything Vigil knows, with secrets already removed, and is asked
 * for the code change that stops this from happening again.
 */
export function fixPrompt(d: Diagnosis): string {
  const e = d.evidence;
  const f = d.findings[0];
  const fence = (s: string) => `\`\`\`\n${s.replace(/```/g, "'''")}\n\`\`\``;
  const parts: string[] = [];

  parts.push(`# Production incident: \`${e.container}\` is down`);
  parts.push(`VigilOps, the monitoring agent on the production server (${d.host}), investigated this on ${d.createdAt}. You have this repository but not the server. Find the cause in the code, Dockerfile, start script or deploy config, and make the change that stops it from happening again. Do not change production data, and don't guess at secrets — the logs below have them removed.`);

  parts.push('## Container');
  parts.push([
    `- State: ${stateLine(e)}`,
    `- Image: \`${e.image}\`${e.imageArch ? ` (built for ${e.imageArch}; server is ${e.hostArch})` : ''}`,
    `- Restart policy: ${e.restartPolicy}${e.memoryLimitMb ? `, memory limit ${e.memoryLimitMb} MB` : ''}`,
    e.entrypoint.length ? `- Starts with: \`${e.entrypoint.join(' ').slice(0, 300)}\`` : '',
    e.startedAt ? `- Last started: ${e.startedAt}` : '',
  ].filter(Boolean).join('\n'));

  if (f) {
    parts.push(`## Vigil's diagnosis (${f.confidence} confidence)`);
    parts.push(`**${f.title}.** ${f.cause}`);
    if (f.evidence.length) parts.push(`Evidence:\n${f.evidence.map((x) => `- ${x}`).join('\n')}`);
    parts.push(`Suggested permanent fix: ${f.permanentFix}`);
    parts.push(`The server itself will be fixed separately with:\n${f.fixNow.map((x) => `- ${x}`).join('\n')}`);
    if (d.findings.length > 1) parts.push(`Also possible: ${d.findings.slice(1).map((x) => x.title).join('; ')}.`);
  } else {
    parts.push('## Diagnosis');
    parts.push('No known failure pattern matched. Work it out from the errors and log below.');
  }

  if (e.errors.length) {
    parts.push('## Errors in the latest start, in order (the first is usually the cause)');
    parts.push(fence(e.errors.join('\n')));
  }

  const excerpt = (e.lastCycle.length ? e.lastCycle : e.logTail).slice(-80).join('\n');
  if (excerpt) {
    parts.push('## Log of the latest start');
    parts.push(fence(excerpt.length > 8000 ? `…${excerpt.slice(-8000)}` : excerpt));
  }

  const interesting = Object.entries(e.fileSizes);
  if (interesting.length || e.changedFiles.length) {
    parts.push('## Files changed inside the container since it was created');
    const sized = interesting.map(([p, s]) => `- ${p} — ${s} bytes`);
    const rest = e.changedFiles.filter((p) => !(p in e.fileSizes)).slice(0, 25).map((p) => `- ${p}`);
    parts.push([...sized, ...rest].join('\n'));
  }

  if (e.envNames.length) {
    parts.push('## Environment variables set in the container (names only)');
    parts.push(e.envNames.filter((n) => !/^(PATH|HOSTNAME|HOME|PHP_|PHPIZE_|GPG_KEYS|NODE_VERSION|YARN_VERSION)/.test(n)).sort().join(', '));
  }
  if (d.context.length) {
    parts.push('## Also happening on the server');
    parts.push(d.context.map((c) => `- ${c}`).join('\n'));
  }
  if (e.gaps.length) parts.push(`_Vigil could not read: ${e.gaps.join(', ')}._`);

  parts.push('## What to do');
  parts.push([
    '1. Find the root cause in this repository. Say which file and line, and why it leads to the errors above.',
    '2. Make the smallest change that fixes it for good. If it is configuration on the server (an env var, a volume), say exactly what to set instead of changing code.',
    '3. Tell me how to roll it out and how to check it worked.',
  ].join('\n'));

  return parts.join('\n\n');
}
