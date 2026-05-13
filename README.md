# Vigil

**Self-hosted AI DevOps agent for your VPS.**

Vigil watches your Docker containers, disk, memory, nginx, and HTTP endpoints. It fixes known issues automatically, escalates unknown ones to Claude AI, and keeps you in the loop via Telegram.

---

## How it works

```
Every 60s:
  1. Collect snapshot — Docker, disk, memory, nginx, HTTP health checks
  2. Rule engine runs first — known issue? fix it immediately, no AI call
  3. Unknown anomaly? — escalate to Claude AI
  4. AI decides: auto-fix, suggest (needs your approval), or alert
  5. Everything logged to logs/audit.jsonl
  6. You get notified on Telegram for anything non-trivial
```

The AI is only called on escalation — roughly 5% of polls. The other 95% is handled by the rule engine at zero cost.

---

## Features

- **Auto-healing** — restarts stopped containers, prunes disk, reloads nginx
- **Crash loop detection** — stops blindly restarting containers that keep dying, escalates to AI instead
- **AI escalation** — sends unknown errors to Claude with full context, gets a reasoned fix back
- **Approval flow** — risky actions come to you on Telegram as `/approve` or `/deny`
- **Deploy from CI/CD** — webhook endpoint lets GitHub Actions trigger deploys with health-check + rollback
- **Deploy from Telegram** — `/deploy myapp` triggers a pull → restart → health-check flow
- **Audit log** — every action logged to `logs/audit.jsonl` with timestamp and reasoning
- **Safety allowlist** — executor only runs commands matching explicit patterns, nothing else

---

## Requirements

- Linux VPS (Ubuntu 20.04+)
- Docker + Docker Compose
- Node.js 20+ (for local dev) or just Docker (for production)
- [Anthropic API key](https://console.anthropic.com) — usage is minimal, ~$1/month
- Telegram bot token — create one via [@BotFather](https://t.me/botfather)

---

## Quick start

```bash
git clone https://github.com/yourorg/vigilops
cd vigilops
npm install
cp .env.example .env
```

Fill in `.env`:

```env
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=7123456789:AAF...
TELEGRAM_CHAT_ID=123456789
HEALTH_CHECK_URLS=https://yourapp.com/health
VIGIL_WEBHOOK_SECRET=your-random-secret
```

Run locally:

```bash
npm run dev
```

Vigil sends a Telegram message on startup. Send `/status` to verify everything is working.

---

## Deploy to VPS

```bash
# On your VPS
git clone https://github.com/yourorg/vigilops /opt/vigil
cd /opt/vigil
cp .env.example .env && nano .env

docker compose up -d --build
docker compose logs -f
```

### Nginx config (optional — for the webhook endpoint)

```nginx
server {
    listen 443 ssl;
    server_name vigil.yourdomain.com;

    ssl_certificate     /etc/ssl/certs/your-cert.pem;
    ssl_certificate_key /etc/ssl/private/your-key.key;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## Registering apps for deploy

Edit `src/deploy/deploy.config.ts`:

```typescript
const deployConfig: Record<string, AppDeployConfig> = {
  'my-api': {
    composePath: '/opt/my-api/docker-compose.yml',
    service: 'app',
    image: 'ghcr.io/yourorg/my-api',
    healthCheckUrl: 'https://api.yourdomain.com/health',
    healthCheckTimeout: 60,
    rollbackOnFailure: true,
  },
};
```

---

## GitHub Actions integration

Add this step to your app's workflow after building and pushing your image:

```yaml
- name: Trigger Vigil deploy
  run: |
    curl -X POST https://vigil.yourdomain.com/webhook/deploy \
      -H "Content-Type: application/json" \
      -H "x-vigil-token: ${{ secrets.VIGIL_WEBHOOK_SECRET }}" \
      -d '{"app": "my-api"}'
```

Vigil pulls the new image, restarts the container, waits for the health check to pass, and notifies you on Telegram. If the health check fails, it rolls back automatically.

---

## Telegram commands

| Command | Description |
|---|---|
| `/status` | Full system snapshot — containers, disk, memory, nginx, health checks |
| `/apps` | List apps registered for deployment |
| `/deploy <appname>` | Manually trigger a deploy |
| `/approve_<id>` | Approve a pending suggested action |
| `/deny_<id>` | Deny a pending suggested action |
| `/help` | Show all commands |

---

## What gets auto-fixed vs alerted

| Condition | Behavior |
|---|---|
| Container exited/stopped | Auto-restart |
| Disk > 85% | Auto-prune Docker images |
| Nginx not running | Auto-restart |
| Container crash loop (3+ restarts in 10min) | Escalate to AI |
| Memory > 90% | Alert only — too risky to auto-fix |
| HTTP health check failing | Alert + escalate to AI |
| Unknown anomaly | Escalate to AI |

All thresholds are configurable via `.env`.

---

## Safety

The executor only runs commands matching an explicit allowlist:

```
docker restart <name>
docker image prune -f
docker system prune -f --volumes=false
systemctl restart nginx
systemctl reload nginx
```

Everything else is blocked — including anything the AI suggests outside this list. The allowlist is in `src/executor/index.ts`.

---

## Audit log

Every action is appended to `logs/audit.jsonl`:

```json
{"timestamp":"2026-05-12T10:30:00.000Z","trigger":"rule","ruleId":"container-down","action":"docker restart my-api","result":"success","message":"Container(s) down — restarting: my-api"}
{"timestamp":"2026-05-12T11:15:00.000Z","trigger":"ai","action":"docker image prune -f","result":"success","message":"Disk at 91%, pruning images to free space"}
```

---

## External monitoring tip

Vigil can't alert you if your VPS goes completely down. Add your health check URLs to [UptimeRobot](https://uptimerobot.com) (free tier) as an external dead-man switch.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT
