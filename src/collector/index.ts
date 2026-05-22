import { exec } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import {
  SystemSnapshot, ContainerStatus, DiskStatus,
  MemoryStatus, NginxStatus, HealthCheckResult,
} from '../types';
import { error } from '../logger';

const execAsync = promisify(exec);

const HEALTH_CHECK_URLS: string[] = (process.env.HEALTH_CHECK_URLS ?? '')
  .split(',').map((u) => u.trim()).filter(Boolean);

const EXCLUDED_CONTAINERS: string[] = (process.env.EXCLUDED_CONTAINERS ?? '')
  .split(',').map((c) => c.trim()).filter(Boolean);

async function getContainers(): Promise<ContainerStatus[]> {
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

async function getDisk(): Promise<DiskStatus> {
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

async function getMemory(): Promise<MemoryStatus> {
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

async function getNginx(): Promise<NginxStatus> {
  if (process.platform !== 'linux') return { running: true };
  try {
    const { stdout } = await execAsync(
      `nsenter -t 1 -m -u -i -n -p -- /usr/bin/systemctl is-active nginx`
    );
    return { running: stdout.trim() === 'active' };
  } catch {
    return { running: false };
  }
}

async function checkHealth(url: string): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    const response = await axios.get(url, { timeout: 5000 });
    return {
      url,
      statusCode: response.status,
      healthy: response.status >= 200 && response.status < 400,
      responseTimeMs: Date.now() - start,
    };
  } catch (err) {
    const statusCode = axios.isAxiosError(err) && err.response ? err.response.status : null;
    return { url, statusCode, healthy: false, responseTimeMs: Date.now() - start };
  }
}

async function getHealthChecks(): Promise<HealthCheckResult[]> {
  return Promise.all(HEALTH_CHECK_URLS.map(checkHealth));
}

export async function collect(): Promise<SystemSnapshot> {
  const [containers, disk, memory, nginx, healthChecks] = await Promise.all([
    getContainers(), getDisk(), getMemory(), getNginx(), getHealthChecks(),
  ]);
  return { timestamp: new Date(), containers, disk, memory, nginx, healthChecks };
}