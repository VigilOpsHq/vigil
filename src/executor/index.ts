import { exec } from 'child_process';
import { promisify } from 'util';
import { ExecutionResult } from '../types';
import { error } from '../logger';

const execAsync = promisify(exec);

const AUTO_ALLOWED: RegExp[] = [
  /^docker restart [a-zA-Z0-9][a-zA-Z0-9_.-]+$/,
  /^docker image prune -f$/,
  /^docker system prune -f(?: --volumes=false)?$/,
  /^systemctl restart nginx$/,
  /^systemctl reload nginx$/,
];

const APPROVAL_ONLY: RegExp[] = [
  /^sudo apt update$/,
  /^sudo apt upgrade -y$/,
  /^sudo apt install -y [a-zA-Z0-9][a-zA-Z0-9\-_.]*(?:\s+[a-zA-Z0-9][a-zA-Z0-9\-_.]*)*$/,
  /^sudo apt remove -y [a-zA-Z0-9][a-zA-Z0-9\-_.]*$/,
];

export function isSafeCommand(command: string, approved = false): boolean {
  const c = command.trim();
  const patterns = approved ? [...AUTO_ALLOWED, ...APPROVAL_ONLY] : AUTO_ALLOWED;
  return patterns.some((pattern) => pattern.test(c));
}

export function needsApproval(command: string): boolean {
  const c = command.trim();
  return !isSafeCommand(c) && APPROVAL_ONLY.some((pattern) => pattern.test(c));
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
