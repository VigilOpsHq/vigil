import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { info, error } from '../logger';

const CLOUD_URL = (process.env.VIGIL_CLOUD_URL || 'https://vigilops.cloud').replace(/\/+$/, '');
const BACKUP_DIR = process.env.BACKUP_DIR ?? '/var/backups/vigil';
const CONFIG_FILE = path.join(BACKUP_DIR, 'cloud.json');
const HEARTBEAT_MS = 5 * 60 * 1000;

export interface CloudStatus {
  server: { id: string; name: string };
  plan: string | null;
  limits: { servers: number; storageBytes: number; retentionDays: number } | null;
}

export function cloudToken(): string | null {
  if (process.env.VIGIL_CLOUD_TOKEN) return process.env.VIGIL_CLOUD_TOKEN.trim();
  try {
    const { token } = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return typeof token === 'string' ? token : null;
  } catch {
    return null;
  }
}

export const cloudEnabled = () => Boolean(cloudToken());

async function request(pathname: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
  const token = init.token ?? cloudToken();
  if (!token) throw new Error('Not connected to VigilOps Cloud. Run: vigil cloud connect <token>');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('User-Agent', `vigilops-agent/${process.env.VIGIL_VERSION ?? 'dev'}`);
  const res = await fetch(`${CLOUD_URL}${pathname}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `VigilOps Cloud returned ${res.status}`);
  }
  return res;
}

async function schedulesForCloud() {
  const { loadSchedules } = await import('../backup/schedule');
  return loadSchedules().map((s) => ({ container: s.container, every: s.every, time: s.time, day: s.day }));
}

export async function heartbeat(token?: string): Promise<CloudStatus> {
  const res = await request('/api/agent/heartbeat', {
    method: 'POST',
    token,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      version: process.env.VIGIL_VERSION ?? 'dev',
      hostname: os.hostname(),
      // getTimezoneOffset() is minutes *behind* UTC; the cloud wants minutes ahead
      utcOffsetMinutes: -new Date().getTimezoneOffset(),
      schedules: await schedulesForCloud(),
    }),
  });
  return (await res.json()) as CloudStatus;
}

export async function connect(token: string): Promise<CloudStatus> {
  if (!/^vo_srv_[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('That does not look like a VigilOps Cloud server token (vo_srv_...)');
  const status = await heartbeat(token);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ token, connectedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  return status;
}

export function disconnect(): boolean {
  if (!fs.existsSync(CONFIG_FILE)) return false;
  fs.rmSync(CONFIG_FILE);
  return true;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

async function readChunk(fd: fs.promises.FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await fd.read(buf, read, length - read, position + read);
    if (bytesRead === 0) break;
    read += bytesRead;
  }
  return buf.subarray(0, read);
}

export async function uploadBackup(filePath: string, file: string, meta: { container: string; database: string }): Promise<void> {
  const size = fs.statSync(filePath).size;
  const start = await request('/api/agent/backups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ container: meta.container, database: meta.database, file, size, sha256: await sha256File(filePath) }),
  });
  const { id, partSize, parts } = (await start.json()) as { id: string; partSize: number; parts: number };

  const fd = await fs.promises.open(filePath, 'r');
  try {
    const uploaded: { partNumber: number; etag: string }[] = [];
    for (let n = 1; n <= parts; n++) {
      const chunk = await readChunk(fd, (n - 1) * partSize, partSize);
      let lastErr: unknown;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await request(`/api/agent/backups/${id}/parts/${n}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(chunk.length) },
            body: chunk,
          });
          uploaded.push((await res.json()) as { partNumber: number; etag: string });
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, attempt * 2000));
        }
      }
      if (lastErr) throw lastErr;
    }
    await request(`/api/agent/backups/${id}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts: uploaded }),
    });
  } catch (err) {
    await request(`/api/agent/backups/${id}/abort`, { method: 'POST' }).catch(() => undefined);
    throw err;
  } finally {
    await fd.close();
  }
}

export async function downloadBackup(file: string, destPath: string): Promise<boolean> {
  if (!cloudEnabled()) return false;
  const partial = `${destPath}.partial`;
  try {
    const res = await request(`/api/agent/backups/file/${encodeURIComponent(file)}`);
    if (!res.body) return false;
    await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(partial));
    fs.renameSync(partial, destPath);
    return true;
  } catch (err) {
    fs.rmSync(partial, { force: true });
    error('[cloud] Download failed', err);
    return false;
  }
}

export interface CloudBackup {
  file: string;
  container: string;
  database_name: string;
  size_bytes: number;
  completed_at: string;
}

export async function listCloudBackups(container?: string): Promise<CloudBackup[]> {
  const qs = container ? `?container=${encodeURIComponent(container)}` : '';
  const res = await request(`/api/agent/backups${qs}`);
  return ((await res.json()) as { backups: CloudBackup[] }).backups;
}

export function startCloudHeartbeat(): void {
  const beat = async () => {
    if (!cloudEnabled()) return;
    try {
      await heartbeat();
    } catch (err) {
      error('[cloud] Heartbeat failed', err);
    }
  };
  if (cloudEnabled()) info(`[cloud] Connected to ${CLOUD_URL}`);
  beat();
  setInterval(beat, HEARTBEAT_MS);
}
