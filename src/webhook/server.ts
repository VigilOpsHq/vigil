import crypto from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import { deploy, listApps } from '../deploy/deployer';
import { notify } from '../telegram/bot';
import { info, error } from '../logger';

const app = express();
app.use(express.json());

const WEBHOOK_SECRET = process.env.VIGIL_WEBHOOK_SECRET ?? '';
const PORT = parseInt(process.env.WEBHOOK_PORT ?? '3100', 10);

const ATTEMPT_WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, { count: number; resetAt: number }>();

function tooManyAttempts(ip: string): boolean {
  const now = Date.now();
  const seen = attempts.get(ip);
  if (!seen || now > seen.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return false;
  }
  seen.count += 1;
  return seen.count > MAX_ATTEMPTS;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, seen] of attempts) if (now > seen.resetAt) attempts.delete(ip);
}, ATTEMPT_WINDOW_MS).unref();

function tokenMatches(token: string): boolean {
  const a = Buffer.from(token);
  const b = Buffer.from(WEBHOOK_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authenticate(req: Request, res: Response, next: NextFunction): void {
  if (!WEBHOOK_SECRET) {
    res.status(503).json({ error: 'Deploy webhook is disabled. Set VIGIL_WEBHOOK_SECRET in .env to enable it.' });
    return;
  }

  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  if (tooManyAttempts(ip)) {
    error(`[webhook] Too many failed attempts from ${ip}`);
    res.status(429).json({ error: 'Too many requests' });
    return;
  }

  const token = req.headers['x-vigil-token'];

  if (typeof token !== 'string' || !tokenMatches(token)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  attempts.delete(ip);

  next();
}

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'vigil' });
});

app.post('/webhook/deploy', authenticate, async (req: Request, res: Response) => {
  const { app: appName } = req.body as { app?: string };

  if (!appName) {
    res.status(400).json({ error: 'Missing "app" in request body' });
    return;
  }

  const available = listApps();
  if (!available.includes(appName)) {
    res.status(404).json({
      error: `Unknown app "${appName}"`,
      available,
    });
    return;
  }

  res.json({ status: 'accepted', message: `Deploy of ${appName} started` });

  info(`[webhook] Deploy triggered for: ${appName}`);
  await notify(`🚀 *Deploy triggered*: \`${appName}\`\nStarting pull and restart...`);

  const result = await deploy(appName);

  if (result.success) {
    await notify(
      `✅ *Deploy succeeded*: \`${appName}\`\n` +
      `Healthy in ${result.duration}s`
    );
  } else {
    await notify(
      `❌ *Deploy failed*: \`${appName}\`\n` +
      `${result.message}`
    );
  }
});

app.get('/webhook/apps', authenticate, (_req: Request, res: Response) => {
  res.json({ apps: listApps() });
});

export function startWebhookServer(): void {
  const server = app.listen(PORT, '0.0.0.0', () => {
    info(`[webhook] Server listening on port ${PORT}`);
  });

  server.on('error', (err) => {
    error('[webhook] Server error', err);
  });
}
