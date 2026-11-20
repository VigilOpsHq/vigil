import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Evidence } from './types';
import { distinctErrors, latestCycle, mergeStreams, redact } from './logs';

const execFileAsync = promisify(execFile);

const LOG_LINES = 400;
const MAX_CHANGED_FILES = 300;
/** Files whose size is worth knowing: build caches and generated config, where a 0-byte file breaks boot. */
const SIZE_WORTH_CHECKING = [
  /\/bootstrap\/cache\/[^/]+\.php$/,          // Laravel
  /\/storage\/framework\/[^/]+\.php$/,
  /\/\.next\/(?:BUILD_ID|[^/]+-manifest\.json)$/, // Next.js
  /\/(?:\.env|config\.(?:json|ya?ml|js|php))$/,
  /\.(?:pid|lock)$/,
];
const MAX_SIZE_CHECKS = 12;

async function docker(args: string[], timeout = 15_000): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('docker', args, { timeout, maxBuffer: 16 * 1024 * 1024 });
}

/** Docker's names for CPU architectures, so image and host can be compared. */
export function dockerArch(nodeArch: string): string {
  return ({ x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386', ppc64: 'ppc64le', s390x: 's390x' } as Record<string, string>)[nodeArch] ?? nodeArch;
}

/**
 * Size of a file inside a container, even one stuck restarting where `docker exec` can't run:
 * `docker cp container:path -` streams a tar, and the size is in its first header.
 */
async function readFile(container: string, path: string): Promise<{ size: number; head: Buffer } | null> {
  try {
    const { stdout } = await execFileAsync('docker', ['cp', `${container}:${path}`, '-'],
      { encoding: 'buffer', timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
    const buf = stdout as unknown as Buffer;
    if (buf.length < 512) return null;
    const field = buf.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = parseInt(field, 8);
    if (!Number.isFinite(size)) return null;
    return { size, head: buf.subarray(512, 512 + Math.min(size, 512)) };
  } catch {
    return null;
  }
}

async function fileSize(container: string, path: string): Promise<number | null> {
  return (await readFile(container, path))?.size ?? null;
}

/**
 * Whether the start script was saved with Windows line endings. The kernel then looks for an
 * interpreter called "/bin/sh\r" and reports "no such file or directory" — for a file that is
 * plainly there. Reading the first line is the only way to be sure.
 */
async function scriptHasCrlf(container: string, entrypoint: string[]): Promise<boolean | null> {
  const scripts = entrypoint.filter((p) => p.startsWith('/') && !/^\/(?:usr\/)?bin\/(?:ba|da)?sh$/.test(p)).slice(0, 2);
  for (const script of scripts) {
    const file = await readFile(container, script);
    if (!file || file.head.length === 0) continue;
    const firstLine = file.head.toString('latin1').split('\n')[0];
    if (!firstLine.startsWith('#!')) continue;
    return firstLine.endsWith('\r');
  }
  return null;
}

interface InspectJson {
  State?: { Status?: string; ExitCode?: number; OOMKilled?: boolean; Error?: string; StartedAt?: string; FinishedAt?: string };
  RestartCount?: number;
  HostConfig?: { RestartPolicy?: { Name?: string }; Memory?: number };
  Config?: { Image?: string; Env?: string[]; Entrypoint?: string[] | null; Cmd?: string[] | null };
  Image?: string;
}

const realTime = (t?: string) => (t && !t.startsWith('0001-') ? t : null);

/** Everything worth knowing about why a container is failing. Read-only: nothing is changed. */
export async function gatherEvidence(container: string): Promise<Evidence> {
  const gaps: string[] = [];

  let inspect: InspectJson = {};
  try {
    const { stdout } = await docker(['inspect', container]);
    inspect = (JSON.parse(stdout) as InspectJson[])[0] ?? {};
  } catch (err) {
    throw new Error(`Container "${container}" not found or Docker is unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }

  let imageArch: string | null = null;
  if (inspect.Image) {
    try {
      imageArch = (await docker(['image', 'inspect', '--format', '{{.Architecture}}', inspect.Image])).stdout.trim() || null;
    } catch {
      gaps.push('image architecture');
    }
  }

  // A running container is judged on its current start only: errors from before a fix (or
  // before the last deploy) are history, not evidence.
  const startedAt = realTime(inspect.State?.StartedAt);
  const since = inspect.State?.Status === 'running' && startedAt ? ['--since', startedAt] : [];

  let logTail: string[] = [];
  try {
    const { stdout, stderr } = await docker(['logs', '--timestamps', ...since, '--tail', String(LOG_LINES), container], 20_000);
    logTail = mergeStreams(stdout, stderr).map(redact);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    gaps.push(/does not support reading/.test(msg) ? 'logs (the logging driver does not keep them)' : 'logs');
  }

  let changedFiles: string[] = [];
  try {
    const { stdout } = await docker(['diff', container]);
    changedFiles = stdout.split('\n')
      .filter((l) => /^[AC] /.test(l))
      .map((l) => l.slice(2).trim())
      .slice(0, MAX_CHANGED_FILES);
  } catch {
    gaps.push('changed files');
  }

  const fileSizes: Record<string, number> = {};
  const worthChecking = changedFiles.filter((f) => SIZE_WORTH_CHECKING.some((re) => re.test(f))).slice(0, MAX_SIZE_CHECKS);
  await Promise.all(worthChecking.map(async (f) => {
    const size = await fileSize(container, f);
    if (size !== null) fileSizes[f] = size;
  }));

  const entrypoint = [...(inspect.Config?.Entrypoint ?? []), ...(inspect.Config?.Cmd ?? [])];
  const entrypointCrlf = await scriptHasCrlf(container, entrypoint);

  const lastCycle = latestCycle(logTail);
  const state = inspect.State ?? {};
  return {
    container,
    state: state.Status ?? 'unknown',
    exitCode: typeof state.ExitCode === 'number' ? state.ExitCode : null,
    oomKilled: Boolean(state.OOMKilled),
    restartCount: inspect.RestartCount ?? 0,
    restartPolicy: inspect.HostConfig?.RestartPolicy?.Name || 'no',
    image: inspect.Config?.Image ?? 'unknown',
    imageArch,
    hostArch: dockerArch(os.arch()),
    startedAt,
    finishedAt: realTime(state.FinishedAt),
    dockerError: state.Error?.trim() || null,
    memoryLimitMb: Math.round((inspect.HostConfig?.Memory ?? 0) / 1024 / 1024),
    // Names only: the values are secrets and never leave this function.
    envNames: (inspect.Config?.Env ?? []).map((e) => e.split('=')[0]).filter(Boolean),
    entrypoint,
    entrypointCrlf,
    lastCycle,
    logTail,
    errors: distinctErrors(lastCycle).length > 0 ? distinctErrors(lastCycle) : distinctErrors(logTail),
    changedFiles,
    fileSizes,
    gaps,
  };
}
