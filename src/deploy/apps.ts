// Apps registered at runtime with `vigil app add`, stored next to backups so the
// container can write them. Code-defined apps in deploy.config.ts still work.
import fs from 'fs';
import path from 'path';
import codeApps, { AppDeployConfig } from './deploy.config';
import { info } from '../logger';

const APPS_FILE = path.join(process.env.BACKUP_DIR ?? '/var/backups/vigil', 'apps.json');

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

function readFileApps(): Record<string, AppDeployConfig> {
  try {
    return JSON.parse(fs.readFileSync(APPS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeFileApps(apps: Record<string, AppDeployConfig>): void {
  fs.mkdirSync(path.dirname(APPS_FILE), { recursive: true });
  fs.writeFileSync(APPS_FILE, JSON.stringify(apps, null, 2));
}

/** Registered apps: file first, then any defined in code. */
export function allApps(): Record<string, AppDeployConfig> {
  return { ...codeApps, ...readFileApps() };
}

export function getApp(name: string): AppDeployConfig | undefined {
  return allApps()[name];
}

export interface AppInput {
  name: string;
  composePath: string;
  service: string;
  image: string;
  healthCheckUrl?: string;
  healthCheckTimeout?: number;
  rollbackOnFailure?: boolean;
}

export function addApp(input: AppInput): AppDeployConfig {
  if (!NAME_RE.test(input.name)) throw new Error(`Invalid app name "${input.name}". Use letters, numbers, dots, dashes or underscores.`);
  if (!input.composePath.startsWith('/')) throw new Error('The compose file needs an absolute path, for example /opt/myapp/docker-compose.yml');
  if (!fs.existsSync(input.composePath)) throw new Error(`No compose file at ${input.composePath}`);
  if (!input.service) throw new Error('Pass the service name from the compose file, for example --service app');
  if (!input.image) throw new Error('Pass the image to pull, for example --image ghcr.io/me/myapp');
  if (input.healthCheckUrl && !/^https?:\/\//.test(input.healthCheckUrl)) throw new Error('The health check must be an http(s) URL');

  const config: AppDeployConfig = {
    composePath: input.composePath,
    service: input.service,
    image: input.image,
    healthCheckUrl: input.healthCheckUrl ?? '',
    healthCheckTimeout: input.healthCheckTimeout ?? 60,
    rollbackOnFailure: input.rollbackOnFailure ?? true,
  };

  const apps = readFileApps();
  apps[input.name] = config;
  writeFileApps(apps);
  info(`[deploy] Registered app: ${input.name}`);
  return config;
}

export function removeApp(name: string): boolean {
  const apps = readFileApps();
  if (!(name in apps)) return false;
  delete apps[name];
  writeFileApps(apps);
  info(`[deploy] Removed app: ${name}`);
  return true;
}
