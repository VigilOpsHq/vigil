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

const RESULT_FILE = path.resolve(process.cwd(), 'logs', 'update-result.json');

export async function startSelfUpdate(): Promise<void> {
  const { stdout } = await execFileAsync('docker', ['inspect', '--format', '{{json .}}', CONTAINER]);
  const inspect = JSON.parse(stdout) as { Image: string; Config: { Image: string; Labels: Record<string, string> | null } };
  const labels = inspect.Config.Labels ?? {};
  const dir = labels['com.docker.compose.project.working_dir'] ?? process.env.VIGIL_DIR ?? '/opt/vigil';
  const project = labels['com.docker.compose.project'] ?? 'vigil';

  try {
    fs.rmSync(RESULT_FILE, { force: true });
  } catch {
  }

  // The updater outlives this container, so it reports through logs/, which is
  // the same directory on the host and in the VigilOps that comes back up.
  // The log goes to its own file: quoting it into JSON inside sh is a good way
  // to lose the very error we are trying to keep.
  const out = `${dir}/logs/update-result.json`;
  const before = inspect.Image;
  const script =
    `sleep 3; ` +
    `{ docker compose -p "${project}" pull && docker compose -p "${project}" up -d; } > "${out}.log" 2>&1; code=$?; ` +
    `after=$(docker inspect --format '{{.Image}}' ${CONTAINER} 2>/dev/null); ` +
    `printf '{"code":%s,"before":"%s","after":"%s"}' "$code" "${before}" "$after" > "${out}.tmp" && mv "${out}.tmp" "${out}"`;

  const child = spawn('docker', [
    'run', '-d', '--rm',
    '--name', `vigil-updater-${Date.now()}`,
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    '-v', `${dir}:${dir}`,
    '-w', dir,
    '--entrypoint', 'sh',
    inspect.Config.Image,
    '-c', script,
  ], { stdio: 'ignore', detached: true });
  child.unref();

  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Could not start updater (exit ${code})`))));
  });
}

/**
 * Read back what the updater did. An update that changes nothing used to look
 * exactly like one that worked, so say which of the two it was.
 */
export function takeUpdateResult(): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(RESULT_FILE, 'utf8');
  } catch {
    return null;
  }

  let log = '';
  try {
    log = fs.readFileSync(`${RESULT_FILE}.log`, 'utf8');
  } catch {
  }
  try {
    fs.rmSync(RESULT_FILE, { force: true });
    fs.rmSync(`${RESULT_FILE}.log`, { force: true });
  } catch {
  }

  try {
    const r = JSON.parse(raw) as { code: number; before: string; after: string };
    const tail = log.trim().split('\n').slice(-8).join('\n');
    if (r.code !== 0) {
      return `❌ Update failed (exit ${r.code}) — still on ${currentVersion()}.\n\n\`\`\`\n${tail}\n\`\`\`\nOn the server: \`vigil update\``;
    }
    if (r.before && r.after && r.before === r.after) {
      return `ℹ️ Update ran but the image did not change — still ${currentVersion()}.\n\n`
        + `The tag in \`VIGIL_TAG\` already points at this image. Set it to the version you want and run \`vigil update\`.`;
    }
    return `✅ Updated — now running VigilOps ${currentVersion()}.`;
  } catch {
    return null;
  }
}

export function rememberLatest(release: ReleaseInfo): void {
  try {
    fs.mkdirSync(path.dirname(LATEST_FILE), { recursive: true });
    fs.writeFileSync(LATEST_FILE, JSON.stringify({ ...release, checkedAt: new Date().toISOString() }));
  } catch {
  }
}

export function cachedLatest(): ReleaseInfo | null {
  try {
    const cached = JSON.parse(fs.readFileSync(LATEST_FILE, 'utf8')) as ReleaseInfo;
    return cached?.version ? cached : null;
  } catch {
    return null;
  }
}

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
