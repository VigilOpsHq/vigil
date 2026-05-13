import { exec } from 'child_process';
import { promisify } from 'util';
import { ExecutionResult } from '../types';
import { error } from '../logger';

const execAsync = promisify(exec);

const ALLOWED_COMMANDS: RegExp[] = [
  /^docker restart [a-zA-Z0-9][a-zA-Z0-9_.-]+$/,
  /^docker image prune -f$/,
  /^docker system prune -f(?: --volumes=false)?$/,
  /^systemctl restart nginx$/,
  /^systemctl reload nginx$/,
];

export function isSafeCommand(command: string): boolean {
  const trimmed = command.trim();
  return ALLOWED_COMMANDS.some((pattern) => pattern.test(trimmed));
}

export async function execute(command: string): Promise<ExecutionResult> {
  if (!isSafeCommand(command)) {
    error(`Blocked unsafe command: ${command}`);
    return {
      success: false,
      output: '',
      error: `Command not in allowlist: "${command}"`,
    };
  }

  try {
    const { stdout, stderr } = await execAsync(command, { timeout: 30_000 });
    return {
      success: true,
      output: (stdout + stderr).trim(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    error(`Command failed: ${command}`, err);
    return {
      success: false,
      output: '',
      error: message,
    };
  }
}
