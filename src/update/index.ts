import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { info, error } from '../logger';

const execFileAsync = promisify(execFile);

const REPO = process.env.VIGIL_REPO ?? 'VigilOpsHq/vigil';
const CONTAINER = process.env.VIGIL_CONTAINER ?? 'vigil';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const NOTIFIED_FILE = path.resolve(process.cwd(), 'logs', '.update-notified');
// What the last check found, so CLI commands can mention an update without
// calling GitHub themselves
const LATEST_FILE = path.resolve(process.cwd(), 'logs', '.update-latest');

export interface ReleaseInfo {
  version: string;
  url: string;
  notes: string;
}

export function currentVersion(): string {
  if (process.env.VIGIL_VERSION) return process.env.VIGIL_VERSION.replace(/^v/, '');
  try {
    return require('../../package.json').version;
  } catch {
    return 'dev';
  }
}

function parseSemver(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? m.slice(1).map(Number) : null;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export async function latestRelease(): Promise<ReleaseInfo> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { 'User-Agent': 'vigil-update-check', Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  const body = (await res.json()) as { tag_name: string; html_url: string; body: string | null };
  return { version: body.tag_name.replace(/^v/, ''), url: body.html_url, notes: body.body ?? '' };
}

/**
 * The running container can't replace itself, so a short-lived helper container
 * (same image, with the Docker socket) runs `docker compose pull && up -d` in the
 * host's compose directory and outlives the old Vigil container.
 */
export async function startSelfUpdate(): Promise<void> {
  const { stdout } = await execFileAsync('docker', ['inspect', '--format', '{{json .}}', CONTAINER]);
  const inspect = JSON.parse(stdout) as { Config: { Image: string; Labels: Record<string, string> | null } };
  const labels = inspect.Config.Labels ?? {};
  const dir = labels['com.docker.compose.project.working_dir'] ?? process.env.VIGIL_DIR ?? '/opt/vigil';
  const project = labels['com.docker.compose.project'] ?? 'vigil';

  const child = spawn('docker', [
    'run', '-d', '--rm',
    '--name', `vigil-updater-${Date.now()}`,
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    '-v', `${dir}:${dir}`,
    '-w', dir,
    '--entrypoint', 'sh',
    inspect.Config.Image,
    '-c', `sleep 3 && docker compose -p "${project}" pull && docker compose -p "${project}" up -d`,
  ], { stdio: 'ignore', detached: true });
  child.unref();

  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Could not start updater (exit ${code})`))));
  });
}

export function rememberLatest(release: ReleaseInfo): void {
  try {
    fs.mkdirSync(path.dirname(LATEST_FILE), { recursive: true });
    fs.writeFileSync(LATEST_FILE, JSON.stringify({ ...release, checkedAt: new Date().toISOString() }));
  } catch {
    // A read-only or missing logs directory only costs us the reminder
  }
}

/** The newest release the last check saw, or null if we've never managed one. */
export function cachedLatest(): ReleaseInfo | null {
  try {
    const cached = JSON.parse(fs.readFileSync(LATEST_FILE, 'utf8')) as ReleaseInfo;
    return cached?.version ? cached : null;
  } catch {
    return null;
  }
}

/**
 * One line to print after a command when a newer release is out. Reads the cache
 * written by the daily check, so it costs nothing and works offline.
 */
export function updateNotice(): string | null {
  if (process.env.VIGIL_UPDATE_CHECK === 'false') return null;
  const latest = cachedLatest();
  if (!latest || !isNewer(latest.version, currentVersion())) return null;
  return `\n⬆️  VigilOps ${latest.version} is available (you have ${currentVersion()}) — run: vigil update`;
}

function alreadyNotified(version: string): boolean {
  try {
    return fs.readFileSync(NOTIFIED_FILE, 'utf8').trim() === version;
  } catch {
    return false;
  }
}

function markNotified(version: string): void {
  try {
    fs.mkdirSync(path.dirname(NOTIFIED_FILE), { recursive: true });
    fs.writeFileSync(NOTIFIED_FILE, version);
  } catch (err) {
    error('[update] Could not record notified version', err);
  }
}

export function startUpdateChecker(onUpdateAvailable: (release: ReleaseInfo, current: string) => Promise<void>): void {
  const current = currentVersion();
  if (process.env.VIGIL_UPDATE_CHECK === 'false' || !parseSemver(current)) {
    info(`[update] Update checks off (version ${current})`);
    return;
  }

  const check = async () => {
    try {
      const release = await latestRelease();
      rememberLatest(release);
      if (isNewer(release.version, current) && !alreadyNotified(release.version)) {
        await onUpdateAvailable(release, current);
        markNotified(release.version);
      }
    } catch (err) {
      error('[update] Update check failed', err);
    }
  };

  check();
  setInterval(check, CHECK_INTERVAL_MS);
}
