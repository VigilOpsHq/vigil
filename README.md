# Vigil

**Self-hosted AI DevOps agent for your VPS.**

Vigil watches your Docker containers, disk, memory, nginx, and HTTP endpoints. It fixes known issues automatically, escalates unknown ones to DeepSeek AI, and keeps you in the loop via Telegram.

---

## How it works

```
Every 60s:
  1. Collect snapshot — Docker, disk, memory, nginx, HTTP health checks
  2. Rule engine runs first — known issue? fix it immediately, no AI call
  3. Unknown anomaly? — escalate to DeepSeek AI
  4. AI decides: auto-fix, suggest (needs your approval), or alert
  5. Everything logged to logs/audit.jsonl
  6. You get notified on Telegram for anything non-trivial
```

The AI is only called on escalation — roughly 5% of polls. The other 95% is handled by the rule engine at near-zero cost.

## Access Methods

Once deployed, control Vigil via:

- **Telegram** — `/status`, `/restart <app>`, `/deploy <app>` from your phone
- **CLI** — `vigil status`, `vigil restart api`, `vigil logs redis` on the VPS
- **HTTP API** — `curl http://localhost:3200/api/status` for automation & scripts

---

## Features

- **Auto-healing** — restarts stopped containers, prunes disk, reloads nginx
- **Crash loop detection** — stops blindly restarting containers that keep dying, escalates to AI instead
- **AI escalation** — sends unknown errors to Gemini with full context, gets a reasoned fix back
- **Approval flow** — risky actions come to you on Telegram as `/approve` or `/deny`
- **Deploy from CI/CD** — webhook endpoint lets GitHub Actions trigger deploys with health-check + rollback
- **Deploy from Telegram** — `/deploy myapp` triggers a pull → restart → health-check flow
- **Audit log** — every action logged to `logs/audit.jsonl` with timestamp and reasoning
- **Safety allowlist** — executor only runs commands matching explicit patterns, nothing else

---

## Requirements

- Linux VPS (Ubuntu 20.04+)
- Docker + Docker Compose (installation steps provided below)
- Node.js 20+ (for CLI commands, installation steps provided below)
- [DeepSeek API key](https://platform.deepseek.com) — free tier available with generous limits
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
# AI Backend (DeepSeek)
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_MODEL=deepseek-chat

# Telegram notifications
TELEGRAM_BOT_TOKEN=7123456789:AAF...
TELEGRAM_CHAT_ID=123456789

# Health checks (optional)
HEALTH_CHECK_URLS=https://yourapp.com/health
# HEALTH_CHECK_CONTAINER_MAP=https://api.example.com/health:my-api,https://app.example.com/health:my-app

# Webhook security (optional)
VIGIL_WEBHOOK_SECRET=your-random-secret
```

Run locally:

```bash
npm run dev
```

Vigil sends a Telegram message on startup. Send `/status` to verify everything is working.

---

## Deploy to VPS

### Prerequisites (run once)

```bash
# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Install Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Install Node.js (for CLI commands)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify installations
docker --version
docker-compose --version
node --version
npm --version
```

### Deploy Vigil

```bash
# Clone repository
git clone https://github.com/VigilOpsHq/vigil /opt/vigil
cd /opt/vigil

# Install dependencies & build
npm install
npm run build

# Configure environment
cp .env.example .env
nano .env
# Add: DEEPSEEK_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, etc.

# Create CLI command (optional but recommended)
sudo bash -c 'cat > /usr/local/bin/vigil << "EOF"
#!/bin/bash
node /opt/vigil/dist/cli/index.js "$@"
EOF'
sudo chmod +x /usr/local/bin/vigil

# Start Vigil
docker compose up -d --build
docker compose logs -f

# Test
vigil status
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

## Database Backups

Vigil can automatically backup your MySQL, PostgreSQL, and MongoDB databases with Telegram notifications.

### Setup

Create backup configurations in `src/backup/backup.config.ts`:

```typescript
import { BackupConfig } from '../backup/backup.types';

const backupConfigs: BackupConfig[] = [
  {
    id: 'mysql_prod',
    name: 'Production MySQL',
    type: 'mysql',
    container: 'mysql',
    database: 'myapp_prod',
    schedule: '0 2 * * *', // daily at 2am
    retentionDays: 30,
    enabled: true,
  },
  {
    id: 'postgres_dev',
    name: 'Development PostgreSQL',
    type: 'postgres',
    container: 'postgres_dev',
    database: 'dev_db',
    schedule: '0 6 * * *', // daily at 6am
    retentionDays: 7,
    enabled: true,
  },
  {
    id: 'mongodb_analytics',
    name: 'Analytics MongoDB',
    type: 'mongodb',
    container: 'mongodb',
    database: 'analytics',
    retentionDays: 60,
    enabled: false, // manual backups only
  },
];

export default backupConfigs;
```

Then in your startup code (e.g., `src/index.ts`):

```typescript
import backupConfigs from './backup/backup.config';
import { scheduleBackups } from './backup/scheduler';
import { registerBackupConfig } from './backup/backup-commands';

// Load configurations
backupConfigs.forEach(config => registerBackupConfig(config));

// Schedule automatic backups
scheduleBackups(backupConfigs);
```

### Features

- **Manual backups** — Trigger anytime via `/trigger_backup <id>`
- **Scheduled backups** — Automatic backups on cron schedule
- **Retention policy** — Automatically deletes backups older than `retentionDays`
- **Telegram notifications** — Get alerted on backup success/failure
- **Database support** — MySQL (mysqldump), PostgreSQL (pg_dump), MongoDB (mongodump)
- **Compressed storage** — Backups stored as gzip for space efficiency
- **Restore capability** — Restore from any backup via `/restore_backup`

### Backup storage

Backups are stored in `./backups/<config_id>/<backup_id>.sql.gz` by default.

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

### System & Deployment

| Command | Description |
|---|---|
| `/status` | Full system snapshot — containers, disk, memory, nginx, health checks |
| `/apps` | List apps registered for deployment |
| `/deploy <appname>` | Manually trigger a deploy |
| `/approve_<id>` | Approve a pending suggested action |
| `/deny_<id>` | Deny a pending suggested action |
| `/help` | Show all commands |

### Database Backups

| Command | Description |
|---|---|
| `/backup_status` | Show all backup configurations and recent backups |
| `/trigger_backup <id>` | Manually trigger a backup now |
| `/schedule_backup <id> <cron>` | Setup automatic backup scheduling |
| `/backup_history <id>` | View backup history and file sizes |
| `/restore_backup <id> <filename>` | Restore from a backup |

**Backup cron examples:**
- `0 2 * * *` — Daily at 2:00 AM
- `0 */6 * * *` — Every 6 hours
- `0 1 * * 0` — Weekly on Sunday at 1:00 AM
- `0 0 1 * *` — Monthly on the 1st at midnight

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

## MCP Server

Vigil exposes an MCP (Model Context Protocol) server so AI agents like Claude, Cursor, and any MCP-compatible client can directly manage your infrastructure.

### What it does

Any AI agent connected to Vigil's MCP server can:
- **Query system status** — containers, disk, memory, nginx, GPU, health checks
- **Read container logs** — tail logs from any Docker container
- **Restart containers** — safe, allowlist-enforced restarts
- **Run health checks** — ad-hoc HTTP checks against any URL
- **Trigger deploys** — deploy registered apps with health-check + rollback
- **View audit history** — see everything Vigil has done
- **Send notifications** — alert you on Telegram from the agent

### Available MCP Tools

| Tool | Description |
|---|---|
| `get_system_snapshot` | Full system state — containers, disk, memory, nginx, health checks |
| `get_container_status` | Docker container status, optionally filtered by name |
| `get_container_logs` | Recent log output from a container |
| `restart_container` | Restart a Docker container (allowlist enforced) |
| `run_health_check` | HTTP health check against any URL |
| `get_disk_usage` | Root filesystem disk usage |
| `get_memory_usage` | System memory usage |
| `get_gpu_status` | GPU utilization, VRAM, temperature (nvidia-smi) |
| `get_audit_history` | Past actions with timestamps and results |
| `deploy_app` | Deploy a registered app (pull → restart → health check → rollback) |
| `get_deployable_apps` | List apps registered for deployment |
| `execute_safe_command` | Run an allowlisted shell command |
| `notify` | Send a Telegram notification |

### Running the MCP server

**stdio mode** (for Claude Desktop, Cursor, local agents):

```bash
npm run dev:mcp
```

**HTTP mode** (for remote agents, Docker):

```bash
MCP_MODE=http MCP_PORT=3200 npm run start:mcp
```

**Both simultaneously**:

```bash
MCP_MODE=both npm run start:mcp
```

### Connecting from Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vigil": {
      "command": "node",
      "args": ["dist/mcp/index.js"],
      "env": {
        "MCP_MODE": "stdio"
      }
    }
  }
}
```

Or for remote HTTP:

```json
{
  "mcpServers": {
    "vigil": {
      "url": "http://your-vps:3200/mcp"
    }
  }
}
```

### Connecting from Cursor

Settings → MCP Servers → Add:

```json
{
  "name": "Vigil",
  "type": "stdio",
  "command": "node dist/mcp/index.js"
}
```

### Docker (add to docker-compose.yml)

```yaml
services:
  vigil:
    # ... existing config ...
    environment:
      - MCP_MODE=http
      - MCP_PORT=3200
    ports:
      - "3200:3200"
```

### Environment variables

```env
# MCP mode: stdio | http | both
MCP_MODE=stdio

# HTTP port (only used when MCP_MODE includes http)
MCP_PORT=3200
```

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT
