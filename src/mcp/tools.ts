import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMigrationTools } from './migration-tools';
import { collect, getContainers, getContainerLogs, getDisk, getMemory, getNginx, getHealthChecks, getGpuStatus } from '../collector';
import { execute, isSafeCommand } from '../executor';
import { deploy, listApps } from '../deploy/deployer';
import { info, error } from '../logger';
import fs from 'fs';
import path from 'path';

const AUDIT_LOG_PATH = path.resolve(process.cwd(), 'logs', 'audit.jsonl');

function readAuditLog(limit: number = 50, sinceHours?: number): Record<string, unknown>[] {
  try {
    if (!fs.existsSync(AUDIT_LOG_PATH)) return [];
    const content = fs.readFileSync(AUDIT_LOG_PATH, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    let entries = lines.map((line) => {
      try { return JSON.parse(line) as Record<string, unknown>; }
      catch { return null; }
    }).filter(Boolean) as Record<string, unknown>[];

    if (sinceHours) {
      const cutoff = Date.now() - sinceHours * 60 * 60 * 1000;
      entries = entries.filter((e) => {
        const ts = new Date(e.timestamp as string).getTime();
        return ts > cutoff;
      });
    }

    return entries.slice(-limit);
  } catch (err) {
    error('Failed to read audit log', err);
    return [];
  }
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    'get_system_snapshot',
    {
      description: 'Get a full system snapshot: Docker containers, disk usage, memory, nginx status, and HTTP health checks. Returns the complete current state of the server.',
      inputSchema: {},
    },
    async () => {
      info('[mcp] get_system_snapshot called');
      const snapshot = await collect();
      const result = {
        timestamp: snapshot.timestamp.toISOString(),
        containers: snapshot.containers.map((c) => ({
          name: c.name, state: c.state, status: c.status, runningFor: c.runningFor,
        })),
        disk: snapshot.disk,
        memory: snapshot.memory,
        nginx: snapshot.nginx,
        healthChecks: snapshot.healthChecks,
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'get_container_status',
    {
      description: 'Get the status of Docker containers. Optionally filter by container name.',
      inputSchema: {
        name: z.string().optional().describe('Container name to filter by. Omit to list all containers.'),
      },
    },
    async ({ name }) => {
      info(`[mcp] get_container_status called${name ? ` for ${name}` : ''}`);
      const containers = await getContainers();
      const filtered = name ? containers.filter((c) => c.name === name) : containers;
      if (name && filtered.length === 0) {
        return { content: [{ type: 'text', text: `No container found with name "${name}".` }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(filtered, null, 2) }] };
    }
  );

  server.registerTool(
    'get_container_logs',
    {
      description: 'Get the recent log output from a Docker container.',
      inputSchema: {
        name: z.string().describe('Container name'),
        lines: z.number().optional().describe('Number of log lines to return (default: 100)'),
      },
    },
    async ({ name, lines }) => {
      info(`[mcp] get_container_logs called for ${name} (${lines ?? 100} lines)`);
      const result = await getContainerLogs(name, lines ?? 100);
      return { content: [{ type: 'text', text: result.logs || 'No logs available.' }] };
    }
  );

  server.registerTool(
    'restart_container',
    {
      description: 'Restart a Docker container. Only works for containers in the safety allowlist (valid container names).',
      inputSchema: {
        name: z.string().describe('Container name to restart'),
      },
    },
    async ({ name }) => {
      const command = `docker restart ${name}`;
      if (!isSafeCommand(command)) {
        return { content: [{ type: 'text', text: `Blocked: "${name}" is not a valid container name pattern.` }] };
      }
      info(`[mcp] restart_container: ${name}`);
      const result = await execute(command);
      return {
        content: [{
          type: 'text',
          text: result.success
            ? `Container "${name}" restarted successfully.`
            : `Failed to restart "${name}": ${result.error}`,
        }],
      };
    }
  );

  server.registerTool(
    'run_health_check',
    {
      description: 'Run an HTTP health check against a URL. Returns status code, response time, and whether the endpoint is healthy.',
      inputSchema: {
        url: z.string().describe('URL to check'),
      },
    },
    async ({ url }) => {
      info(`[mcp] run_health_check: ${url}`);
      const checks = await getHealthChecks();
      const existing = checks.find((c) => c.url === url);
      if (existing) {
        return { content: [{ type: 'text', text: JSON.stringify(existing, null, 2) }] };
      }
      // URL not in configured checks — do an ad-hoc check
      const axios = (await import('axios')).default;
      const start = Date.now();
      try {
        const res = await axios.get(url, { timeout: 5000 });
        const result = {
          url,
          statusCode: res.status,
          healthy: res.status >= 200 && res.status < 400,
          responseTimeMs: Date.now() - start,
        };
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const axiosLib = (await import('axios'));
        const statusCode = axiosLib.isAxiosError(err) && err.response ? err.response.status : null;
        const result = { url, statusCode, healthy: false, responseTimeMs: Date.now() - start };
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
    }
  );

  server.registerTool(
    'get_disk_usage',
    {
      description: 'Get current disk usage for the root filesystem.',
      inputSchema: {},
    },
    async () => {
      info('[mcp] get_disk_usage called');
      const disk = await getDisk();
      return { content: [{ type: 'text', text: JSON.stringify(disk, null, 2) }] };
    }
  );

  server.registerTool(
    'get_memory_usage',
    {
      description: 'Get current memory usage.',
      inputSchema: {},
    },
    async () => {
      info('[mcp] get_memory_usage called');
      const memory = await getMemory();
      return { content: [{ type: 'text', text: JSON.stringify(memory, null, 2) }] };
    }
  );

  server.registerTool(
    'get_gpu_status',
    {
      description: 'Get GPU status including utilization, VRAM usage, temperature, and power draw. Requires nvidia-smi on the host.',
      inputSchema: {},
    },
    async () => {
      info('[mcp] get_gpu_status called');
      const gpu = await getGpuStatus();
      if (!gpu.available) {
        return { content: [{ type: 'text', text: 'No GPU detected or nvidia-smi not available.' }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(gpu, null, 2) }] };
    }
  );

  server.registerTool(
    'get_audit_history',
    {
      description: 'Get the audit log history — records of all actions taken by Vigil (auto-fixes, AI decisions, deploys, approvals).',
      inputSchema: {
        limit: z.number().optional().describe('Max entries to return (default: 50)'),
        hours: z.number().optional().describe('Only show entries from the last N hours'),
      },
    },
    async ({ limit, hours }) => {
      info(`[mcp] get_audit_history called (limit=${limit ?? 50}, hours=${hours ?? 'all'})`);
      const entries = readAuditLog(limit ?? 50, hours);
      if (entries.length === 0) {
        return { content: [{ type: 'text', text: 'No audit entries found.' }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }] };
    }
  );

  server.registerTool(
    'deploy_app',
    {
      description: 'Trigger a deploy for a registered application. Pulls the latest image, restarts the container, waits for health check, and rolls back on failure.',
      inputSchema: {
        app_name: z.string().describe('Name of the app to deploy (use get_deployable_apps to list)'),
      },
    },
    async ({ app_name }) => {
      const available = listApps();
      if (!available.includes(app_name)) {
        return {
          content: [{
            type: 'text',
            text: `Unknown app "${app_name}". Available apps: ${available.join(', ') || 'none registered'}`,
          }],
        };
      }
      info(`[mcp] deploy_app: ${app_name}`);
      const result = await deploy(app_name);
      return {
        content: [{
          type: 'text',
          text: result.success
            ? `Deploy succeeded: ${app_name} — healthy in ${result.duration}s`
            : `Deploy failed: ${app_name} — ${result.message}`,
        }],
      };
    }
  );

  server.registerTool(
    'get_deployable_apps',
    {
      description: 'List all applications registered for deployment with `vigil app add`.',
      inputSchema: {},
    },
    async () => {
      info('[mcp] get_deployable_apps called');
      const apps = listApps();
      return {
        content: [{
          type: 'text',
          text: apps.length > 0
            ? `Deployable apps:\n${apps.map((a) => `  - ${a}`).join('\n')}`
            : 'No apps registered yet. Register one on the server with `vigil app add`.',
        }],
      };
    }
  );

  server.registerTool(
    'execute_safe_command',
    {
      description: 'Execute a command that is in the safety allowlist. Allowed: docker restart, docker image prune, docker system prune, systemctl restart/reload nginx.',
      inputSchema: {
        command: z.string().describe('The shell command to execute'),
      },
    },
    async ({ command }) => {
      if (!isSafeCommand(command)) {
        return {
          content: [{
            type: 'text',
            text: `Blocked: "${command}" is not in the safety allowlist. Allowed patterns:\n- docker restart <name>\n- docker image prune -f\n- docker system prune -f --volumes=false\n- systemctl restart nginx\n- systemctl reload nginx`,
          }],
        };
      }
      info(`[mcp] execute_safe_command: ${command}`);
      const result = await execute(command);
      return {
        content: [{
          type: 'text',
          text: result.success
            ? `Command succeeded:\n${result.output}`
            : `Command failed: ${result.error}`,
        }],
      };
    }
  );

  server.registerTool(
    'notify',
    {
      description: 'Send a notification message to the configured Telegram chat. Use for important alerts that need human attention.',
      inputSchema: {
        message: z.string().describe('Message to send'),
      },
    },
    async ({ message }) => {
      info(`[mcp] notify: ${message}`);
      try {
        // Not telegram/bot: importing it starts a second poller that conflicts with the running service
        const { notifyText } = await import('../backup/offsite');
        await notifyText(`📡 MCP: ${message}`);
        return { content: [{ type: 'text', text: 'Notification sent.' }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Failed to send notification: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    }
  );

  // Register migration orchestration tools (8 new tools)
  registerMigrationTools(server);
  info('[mcp] Migration tools registered (8 tools)');
}
