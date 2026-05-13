import express, { Request, Response, NextFunction } from 'express';
import { deploy, listApps } from '../deploy/deployer';
import { notify } from '../telegram/bot';
import { info, error } from '../logger';

const app = express();
app.use(express.json());

const WEBHOOK_SECRET = process.env.VIGIL_WEBHOOK_SECRET ?? '';
const PORT = parseInt(process.env.WEBHOOK_PORT ?? '3100', 10);

if (!WEBHOOK_SECRET) {
  throw new Error('VIGIL_WEBHOOK_SECRET must be set in .env');
}


function authenticate(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers['x-vigil-token'];

  if (!token || token !== WEBHOOK_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}


app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'vigil' });
});

// Deploy endpoint — called by GitHub Actions after a successful build
// POST /webhook/deploy
// Headers: x-vigil-token: <secret>
// Body: { "app": "token-radar" }
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

// List registered apps
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
