import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ExecutionResult } from '../types';
import { error } from '../logger';

const execAsync = promisify(exec);

const DOCKER_AUTO: RegExp[] = [
  /^docker restart [a-zA-Z0-9][a-zA-Z0-9_.-]+$/,
  /^docker image prune -f$/,
  /^docker system prune -f(?: --volumes=false)?$/,
];

const SYSTEMCTL_AUTO: RegExp[] = [
  /^systemctl restart nginx$/,
  /^systemctl reload nginx$/,
];

const APPROVAL_ONLY: RegExp[] = [
  /^sudo apt update$/,
  /^sudo apt upgrade -y$/,
  /^sudo apt install -y [a-zA-Z0-9][a-zA-Z0-9\-_.]*(?:\s+[a-zA-Z0-9][a-zA-Z0-9\-_.]*)*$/,
  /^sudo apt remove -y [a-zA-Z0-9][a-zA-Z0-9\-_.]*$/,
];

let systemd: boolean | null = null;

/**
 * Whether `systemctl` can reach the host's services from here.
 *
 * Vigil usually runs in a container, where there is no systemd: every `systemctl restart nginx`
 * failed, and the AI kept choosing it because the prompt listed it as allowed. Detected once
 * from /run/systemd/system; VIGIL_SYSTEMCTL=true|false overrides.
 */
export function systemctlAvailable(): boolean {
  if (systemd === null) {
    const forced = process.env.VIGIL_SYSTEMCTL?.trim().toLowerCase();
    systemd = forced === 'true' ? true : forced === 'false' ? false : fs.existsSync('/run/systemd/system');
  }
  return systemd;
}

function autoAllowed(): RegExp[] {
  return systemctlAvailable() ? [...DOCKER_AUTO, ...SYSTEMCTL_AUTO] : DOCKER_AUTO;
}

/** The commands Vigil may run on its own here, as the AI should be told them. */
export function autoAllowedExamples(): string[] {
  const docker = ['docker restart <container_name>', 'docker image prune -f', 'docker system prune -f --volumes=false'];
  return systemctlAvailable() ? [...docker, 'systemctl restart nginx', 'systemctl reload nginx'] : docker;
}

export function isSafeCommand(command: string, approved = false): boolean {
  const c = command.trim();
  const patterns = approved ? [...autoAllowed(), ...APPROVAL_ONLY] : autoAllowed();
  return patterns.some((pattern) => pattern.test(c));
}

export function needsApproval(command: string): boolean {
  const c = command.trim();
  return !isSafeCommand(c) && APPROVAL_ONLY.some((pattern) => pattern.test(c));
}

/**
 * Whether Vigil could run this at all, with or without approval. A command that fails this
 * must never be offered for approval — approving it would only be refused (`docker rm …`).
 */
export function canEverRun(command: string): boolean {
  return isSafeCommand(command, true);
}

export async function execute(command: string, approved = false): Promise<ExecutionResult> {
  if (!isSafeCommand(command, approved)) {
    error(`Blocked unsafe command: ${command}`);
    return { success: false, output: '', error: `Command not in allowlist: "${command}"` };
  }
  try {
    const { stdout, stderr } = await execAsync(command, { timeout: 30_000 });
    return { success: true, output: (stdout + stderr).trim() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    error(`Command failed: ${command}`, err);
    return { success: false, output: '', error: message };
  }
}
