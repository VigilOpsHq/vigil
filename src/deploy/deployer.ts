import { exec } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import deployConfig, { AppDeployConfig } from './deploy.config';
import { log, info, error } from '../logger';

const execAsync = promisify(exec);

export interface DeployResult {
  success: boolean;
  message: string;
  duration?: number;
}


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(cmd: string): Promise<{ stdout: string; stderr: string }> {
  info(`[deploy] $ ${cmd}`);
  return execAsync(cmd, { timeout: 120_000 });
}

async function getCurrentImageId(config: AppDeployConfig): Promise<string | null> {
  try {
    // Get the image ID of the currently running container for this service
    const { stdout } = await run(
      `docker compose -f ${config.composePath} images -q ${config.service}`
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function waitForHealthy(
  url: string,
  timeoutSeconds: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const interval = 5000; // check every 5s

  info(`[deploy] Waiting up to ${timeoutSeconds}s for ${url} to be healthy...`);

  while (Date.now() < deadline) {
    try {
      const res = await axios.get(url, { timeout: 4000 });
      if (res.status >= 200 && res.status < 400) {
        return true;
      }
    } catch {
      // not ready yet
    }
    await sleep(interval);
  }

  return false;
}

async function rollback(
  appName: string,
  config: AppDeployConfig,
  previousImageId: string | null
): Promise<void> {
  info(`[deploy] Rolling back ${appName}...`);

  try {
    if (previousImageId) {
      // Retag the old image back as latest so compose picks it up
      await run(`docker tag ${previousImageId} ${config.image}:latest`);
    }

    await run(
      `docker compose -f ${config.composePath} up -d --no-build --pull=never ${config.service}`
    );

    info(`[deploy] Rollback of ${appName} complete`);
  } catch (err) {
    error(`[deploy] Rollback of ${appName} failed`, err);
  }
}


export async function deploy(appName: string): Promise<DeployResult> {
  const config = deployConfig[appName];

  if (!config) {
    return {
      success: false,
      message: `Unknown app "${appName}". Check deploy.config.ts.`,
    };
  }

  const startedAt = Date.now();
  info(`[deploy] Starting deploy: ${appName}`);

  const previousImageId = await getCurrentImageId(config);
  info(`[deploy] Current image ID: ${previousImageId ?? 'none'}`);

  try {
    info(`[deploy] Pulling ${config.image}...`);
    await run(`docker compose -f ${config.composePath} pull ${config.service}`);

    info(`[deploy] Starting new container for ${appName}...`);
    await run(`docker compose -f ${config.composePath} up -d ${config.service}`);

    const healthy = await waitForHealthy(
      config.healthCheckUrl,
      config.healthCheckTimeout
    );

    const duration = Math.round((Date.now() - startedAt) / 1000);

    if (healthy) {
      log({
        trigger: 'manual',
        action: `deploy ${appName}`,
        result: 'success',
        message: `${appName} deployed successfully in ${duration}s`,
      });

      return {
        success: true,
        message: `${appName} deployed successfully in ${duration}s`,
        duration,
      };
    }

    error(`[deploy] Health check failed for ${appName} after ${duration}s`);

    if (config.rollbackOnFailure) {
      await rollback(appName, config, previousImageId);

      log({
        trigger: 'manual',
        action: `deploy ${appName}`,
        result: 'failed',
        message: `${appName} deploy failed (health check) — rolled back to previous version`,
      });

      return {
        success: false,
        message: `${appName} deploy failed — health check did not pass in ${config.healthCheckTimeout}s. Rolled back to previous version.`,
        duration,
      };
    }

    log({
      trigger: 'manual',
      action: `deploy ${appName}`,
      result: 'failed',
      message: `${appName} deploy failed (health check) — no rollback configured`,
    });

    return {
      success: false,
      message: `${appName} deploy failed — health check did not pass. No rollback configured.`,
      duration,
    };
  } catch (err) {
    const duration = Math.round((Date.now() - startedAt) / 1000);
    const message = err instanceof Error ? err.message : String(err);

    error(`[deploy] Deploy of ${appName} threw an error`, err);

    if (config.rollbackOnFailure && previousImageId) {
      await rollback(appName, config, previousImageId);
    }

    log({
      trigger: 'manual',
      action: `deploy ${appName}`,
      result: 'failed',
      message: `${appName} deploy error: ${message}`,
    });

    return {
      success: false,
      message: `${appName} deploy failed with error: ${message}`,
      duration,
    };
  }
}

export function listApps(): string[] {
  return Object.keys(deployConfig);
}
