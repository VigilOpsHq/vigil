import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import {
  SystemSnapshot, ContainerStatus, DiskStatus,
  MemoryStatus, NginxStatus, HealthCheckResult,
  ContainerLogs, GpuStatus, GpuInfo,
} from '../types';
import { error } from '../logger';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const HEALTH_CHECK_URLS: string[] = (process.env.HEALTH_CHECK_URLS ?? '')
  .split(',').map((u) => u.trim()).filter(Boolean);

const EXCLUDED_CONTAINERS: string[] = (process.env.EXCLUDED_CONTAINERS ?? '')
  .split(',').map((c) => c.trim()).filter(Boolean);

export async function getContainers(): Promise<ContainerStatus[]> {
  try {
    const { stdout } = await execAsync(
      `docker ps -a --format '{"id":"{{.ID}}","name":"{{.Names}}","state":"{{.State}}","status":"{{.Status}}","runningFor":"{{.RunningFor}}"}'`
    );
    return stdout.trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as ContainerStatus)
      .filter((c) => !EXCLUDED_CONTAINERS.includes(c.name));
  } catch (err) {
    error('Failed to fetch container statuses', err);
    return [];
  }
}

export async function getContainerLogs(name: string, lines: number = 100): Promise<ContainerLogs> {
  const tail = Number.isFinite(lines) ? Math.min(Math.max(Math.trunc(lines), 1), 10_000) : 100;
  try {
    const { stdout, stderr } = await execFileAsync('docker', ['logs', '--tail', String(tail), name]);
    return { name, logs: (stdout + stderr).trim() };
  } catch (err) {
    error(`Failed to fetch logs for container: ${name}`, err);
    return { name, logs: `Error fetching logs: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function getDisk(): Promise<DiskStatus> {
  try {
    const { stdout } = await execAsync(`df -h / | tail -1`);
    const parts = stdout.trim().split(/\s+/);
    return {
      usedPercent: parseInt(parts[4] ?? '0', 10),
      total: parts[1] ?? '?',
      used: parts[2] ?? '?',
      available: parts[3] ?? '?',
    };
  } catch (err) {
    error('Failed to fetch disk status', err);
    return { usedPercent: 0, total: '?', used: '?', available: '?' };
  }
}

export async function getMemory(): Promise<MemoryStatus> {
  try {
    const { stdout } = await execAsync(`free -m | grep Mem`);
    const parts = stdout.trim().split(/\s+/);
    const totalMb = parseInt(parts[1] ?? '0', 10);
    const usedMb = parseInt(parts[2] ?? '0', 10);
    return {
      usedPercent: totalMb > 0 ? Math.round((usedMb / totalMb) * 100) : 0,
      usedMb, totalMb,
      freeMb: parseInt(parts[3] ?? '0', 10),
    };
  } catch (err) {
    error('Failed to fetch memory status', err);
    return { usedPercent: 0, usedMb: 0, totalMb: 0, freeMb: 0 };
  }
}

const HEALTH_TIMEOUT_MS = positive(process.env.HEALTH_CHECK_TIMEOUT_MS, 10_000);
const HEALTH_RETRIES = positive(process.env.HEALTH_CHECK_RETRIES, 2);

function positive(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function getNginx(): Promise<NginxStatus> {
  if (process.platform !== 'linux') return { running: true };

  let reason = 'no response';
  for (let attempt = 1; attempt <= HEALTH_RETRIES; attempt++) {
    if (attempt > 1) await wait(2000);
    try {
      await axios.get('http://localhost', { timeout: HEALTH_TIMEOUT_MS });
      return { running: true };
    } catch (err) {
      if (axios.isAxiosError(err)) {
        if (err.response) return { running: true };
        reason = err.code === 'ECONNREFUSED' ? 'nothing is listening on port 80'
          : err.code === 'ECONNABORTED' ? `no reply within ${HEALTH_TIMEOUT_MS}ms`
          : err.code ?? 'no response';
      }
    }
  }
  return { running: false, reason };
}

async function checkHealth(url: string): Promise<HealthCheckResult> {
  let last: HealthCheckResult = { url, statusCode: null, healthy: false, responseTimeMs: 0 };

  for (let attempt = 1; attempt <= HEALTH_RETRIES; attempt++) {
    if (attempt > 1) await wait(2000);
    const start = Date.now();
    try {
      const response = await axios.get(url, { timeout: HEALTH_TIMEOUT_MS });
      const healthy = response.status >= 200 && response.status < 400;
      last = { url, statusCode: response.status, healthy, responseTimeMs: Date.now() - start, attempts: attempt };
      if (healthy) return last;
    } catch (err) {
      const statusCode = axios.isAxiosError(err) && err.response ? err.response.status : null;
      last = { url, statusCode, healthy: false, responseTimeMs: Date.now() - start, attempts: attempt };
    }
  }
  return last;
}

export async function getHealthChecks(): Promise<HealthCheckResult[]> {
  return Promise.all(HEALTH_CHECK_URLS.map(checkHealth));
}

export async function getGpuStatus(): Promise<GpuStatus> {
  if (process.platform !== 'linux') return { available: false, gpus: [] };
  try {
    const { stdout } = await execAsync(
      `nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits`
    );
    const gpus: GpuInfo[] = stdout.trim().split('\n').filter(Boolean).map((line) => {
      const parts = line.split(',').map((s) => s.trim());
      return {
        index: parseInt(parts[0] ?? '0', 10),
        name: parts[1] ?? 'unknown',
        utilizationPercent: parseInt(parts[2] ?? '0', 10),
        memoryUsedMb: parseInt(parts[3] ?? '0', 10),
        memoryTotalMb: parseInt(parts[4] ?? '0', 10),
        temperatureC: parseInt(parts[5] ?? '0', 10),
        powerW: parseFloat(parts[6] ?? '0'),
      };
    });
    return { available: true, gpus };
  } catch {
    return { available: false, gpus: [] };
  }
}

export async function collect(): Promise<SystemSnapshot> {
  const [containers, disk, memory, nginx, healthChecks] = await Promise.all([
    getContainers(), getDisk(), getMemory(), getNginx(), getHealthChecks(),
  ]);
  return { timestamp: new Date(), containers, disk, memory, nginx, healthChecks };
}
