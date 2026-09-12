/**
 * Vigil HTTP API Server
 * Local API for interacting with Vigil from scripts/automation
 *
 * Usage:
 *   API_PORT=3200 npm run start:api
 *
 * Endpoints:
 *   GET  /api/status            - Full system snapshot
 *   GET  /api/containers        - List containers
 *   GET  /api/containers/:name/logs - Get container logs
 *   POST /api/containers/:name/restart - Restart container
 *   GET  /api/disk              - Disk usage
 *   GET  /api/memory            - Memory usage
 *   GET  /api/health            - Health checks
 *   GET  /api/apps              - List deployable apps
 *   POST /api/apps/:name/deploy - Deploy an app
 */

import express, { Request, Response, NextFunction } from 'express';
import { collect, getContainers, getContainerLogs, getDisk, getMemory, getHealthChecks } from '../collector';
import { execute, isSafeCommand } from '../executor';
import { deploy, listApps } from '../deploy/deployer';
import { info, error } from '../logger';

const app = express();
const PORT = parseInt(process.env.API_PORT ?? '3200', 10);

// Middleware
app.use(express.json());

// Logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  info(`[API] ${req.method} ${req.path}`);
  next();
});

// Error handling middleware
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  error('[API] Error', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});



app.get('/api/status', async (req: Request, res: Response) => {
  try {
    const snapshot = await collect();
    res.json({
      timestamp: snapshot.timestamp.toISOString(),
      containers: snapshot.containers,
      disk: snapshot.disk,
      memory: snapshot.memory,
      nginx: snapshot.nginx,
      healthChecks: snapshot.healthChecks,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get status', message: err instanceof Error ? err.message : String(err) });
  }
});


app.get('/api/containers', async (req: Request, res: Response) => {
  try {
    const containers = await getContainers();
    res.json({ containers });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get containers', message: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * GET /api/containers/:name/logs - Get container logs
 */
app.get('/api/containers/:name/logs', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const lines = parseInt(req.query.lines as string, 10) || 100;

    const result = await getContainerLogs(name, lines);
    res.json({ container: name, lines: result.logs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get logs', message: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * POST /api/containers/:name/restart - Restart container
 */
app.post('/api/containers/:name/restart', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const command = `docker restart ${name}`;

    if (!isSafeCommand(command)) {
      return res.status(403).json({ error: 'Unsafe command blocked', command });
    }

    const result = await execute(command);

    if (result.success) {
      res.json({ success: true, message: `Container ${name} restarted` });
    } else {
      res.status(500).json({ error: 'Failed to restart container', message: result.error });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to restart container', message: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * GET /api/disk - Disk usage
 */
app.get('/api/disk', async (req: Request, res: Response) => {
  try {
    const disk = await getDisk();
    res.json(disk);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get disk usage', message: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * GET /api/memory - Memory usage
 */
app.get('/api/memory', async (req: Request, res: Response) => {
  try {
    const memory = await getMemory();
    res.json(memory);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get memory usage', message: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * GET /api/health - Health checks
 */
app.get('/api/health', async (req: Request, res: Response) => {
  try {
    const checks = await getHealthChecks();
    res.json({ checks });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get health checks', message: err instanceof Error ? err.message : String(err) });
  }
});

// ============================================
// DEPLOYMENT ENDPOINTS
// ============================================

/**
 * GET /api/apps - List deployable apps
 */
app.get('/api/apps', async (req: Request, res: Response) => {
  try {
    const apps = listApps();
    res.json({ apps });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get apps', message: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * POST /api/apps/:name/deploy - Deploy an app
 */
app.post('/api/apps/:name/deploy', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const apps = listApps();

    if (!apps.includes(name)) {
      return res.status(404).json({ error: 'App not found', available: apps });
    }

    const result = await deploy(name);

    if (result.success) {
      res.json({ success: true, message: `Deploy succeeded: ${name}`, duration: result.duration });
    } else {
      res.status(500).json({ error: 'Deploy failed', message: result.message });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to deploy', message: err instanceof Error ? err.message : String(err) });
  }
});

// ============================================
// HEALTH & INFO ENDPOINTS
// ============================================

/**
 * GET /api/ping - Simple health check
 */
app.get('/api/ping', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * GET /api/info - API info
 */
app.get('/api/info', (req: Request, res: Response) => {
  res.json({
    name: 'Vigil',
    version: '1.0.0',
    description: 'Server assistant - monitor and manage infrastructure',
    endpoints: {
      system: ['/api/status', '/api/containers', '/api/disk', '/api/memory', '/api/health'],
      containers: ['/api/containers/:name/logs', '/api/containers/:name/restart'],
      apps: ['/api/apps', '/api/apps/:name/deploy'],
    },
  });
});

// ============================================
// START SERVER
// ============================================

export function startAPIServer() {
  app.listen(PORT, () => {
    info(`[API] Vigil API server listening on http://localhost:${PORT}`);
    info(`[API] Available at: http://localhost:${PORT}/api/ping`);
    info(`[API] Info at: http://localhost:${PORT}/api/info`);
  });
}

export default app;
