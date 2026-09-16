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
- **CLI** — `vigil status`, `vigil restart api`, `vigil backup songdis-postgres` on the VPS
- **HTTP API** — `curl http://localhost:3200/api/status` for automation & scripts

---

## Features

- **Auto-healing** — restarts stopped containers, prunes disk, reloads nginx
- **Crash loop detection** — stops blindly restarting containers that keep dying, escalates to AI instead
- **AI escalation** — sends unknown errors to DeepSeek with full context, gets a reasoned fix back
- **Database backups** — `vigil backup <container>` for Postgres/MySQL/MongoDB, with schedules, Telegram alerts, off-server copies and one-command restore
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
docker-compose up -d --build
docker-compose logs -f

# Test
vigil status
```

### Updating Vigil

Vigil has two parts that both need updating: the `vigil` command (runs on the host from `/opt/vigil/dist`) and the background service (runs in the `vigil` container).

```bash
cd /opt/vigil
git pull
npm install
npm run build                 # updates the vigil command
docker-compose up -d --build  # updates the background service
docker-compose logs --tail 30 vigil
```

If you only rebuild one of them, they can get out of sync. For example, a schedule set with `vigil backup schedule` never runs if the container is still on an older version.

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

Back up any Postgres, MySQL/MariaDB or MongoDB container with one command. No config files needed: Vigil reads the container's image and environment variables (`POSTGRES_USER`, `POSTGRES_DB`, `MYSQL_ROOT_PASSWORD`, `MYSQL_DATABASE`, `MONGO_INITDB_ROOT_USERNAME`, ...) to work out the database type, user and database name.

```bash
vigil backup songdis-postgres              # back up now
vigil backups                              # list backups
vigil restore songdis-postgres__songdis__20260916-020000.sql.gz
vigil backup schedule songdis-postgres daily 02:00
```

Or from Telegram: `/backup songdis-postgres`.

### Where backups go

Every backup is saved in up to three places:

| Copy | Where | When |
|---|---|---|
| Server disk | `/var/backups/vigil/` on the host | Always |
| Telegram | Sent as a file to your Vigil chat | When the file is under 50 MB (Telegram's bot limit). Turn off with `BACKUP_SEND_TO_TELEGRAM=false` |
| Object storage | Any S3-compatible bucket: Contabo Object Storage, AWS S3, Backblaze B2, Cloudflare R2, MinIO | When `BACKUP_S3_*` is set |

The server-disk copy makes restores instant. The other copies protect you if the server itself is lost. **A backup that only exists on the same server does not protect you against losing that server**, so set up object storage for anything that matters. If the file is too big for Telegram, storage is the only off-server copy.

File names look like `<container>__<database>__<YYYYMMDD-HHMMSS>.sql.gz` (MongoDB uses `.archive.gz`), for example:

```
/var/backups/vigil/songdis-postgres__songdis__20260916-020000.sql.gz
```

Local backups older than `BACKUP_KEEP_DAYS` (default 7) are deleted automatically. The newest backup of each container is always kept. To expire old copies in object storage, set a lifecycle rule on the bucket.

### Commands

| CLI | Telegram | What it does |
|---|---|---|
| `vigil backup <container> [database]` | `/backup <container> [database]` | Back up now. Pass `database` if the container has several databases or no `*_DATABASE` env var |
| `vigil backups [container]` | `/backups [container]` | List backups on this server, newest first |
| `vigil restore <file> [container] [--yes]` | `/restore <file> [container]` | Restore a backup. Asks for confirmation (a button in Telegram) |
| `vigil backup schedule <container> <when>` | `/backup_schedule <container> <when>` | Back up automatically |
| `vigil backup unschedule <container>` | `/backup_schedule <container> off` | Stop scheduled backups |
| `vigil backup schedules` | `/backup_schedules` | List schedules |

### First-time setup checklist

After installing or updating Vigil, run through this once per server:

```bash
# 1. The background service has the backup scheduler
docker-compose logs vigil | grep "Scheduler started"

# 2. The container can see the backup folder (should print [] or your schedules)
docker exec vigil cat /var/backups/vigil/schedules.json

# 3. A real backup works; you should also get a Telegram message
vigil backup <your-db-container>
vigil backups

# 4. Schedule it
vigil backup schedule <your-db-container> daily 02:00

# 5. Check the server's clock, since schedules use server time
date
```

If step 1 prints nothing or step 2 says "No such file", the container is on an older version. Run `docker-compose up -d --build`.

### Time zone

Schedule times follow the server's clock, and many VPS images default to UTC. To run schedules in your local time:

```bash
sudo timedatectl set-timezone Africa/Lagos   # list options: timedatectl list-timezones
docker-compose restart vigil
```

`<when>` is one of:

- `hourly`: every hour, on the hour
- `daily 02:00`: every day at 02:00
- `weekly sun 03:00`: every Sunday at 03:00

Times use the server's clock (Vigil's container shares the host's `/etc/localtime`). Schedules are saved in `/var/backups/vigil/schedules.json`, and the Vigil service runs them. You set them with the commands above, never by editing the file.

Every backup, manual or scheduled, sends a Telegram message:

```
✅ Backup done: songdis-postgres
File: songdis-postgres__songdis__20260916-020000.sql.gz
Size: 48.2 MB in 12s
Copies: server disk, storage (songdis-backups)
Restore: /restore songdis-postgres__songdis__20260916-020000.sql.gz
```

If a backup fails you get `❌ Backup FAILED` with the error, so a missing message never silently means "no backup".

### Restoring

```bash
vigil backups songdis-postgres
vigil restore songdis-postgres__songdis__20260916-020000.sql.gz
```

What happens:

1. Vigil looks for the file in `/var/backups/vigil/`. If it isn't there and object storage is configured, it downloads it.
2. It takes a **safety backup** of the current data (`..._pre-restore.sql.gz`), so a restore can itself be undone.
3. It loads the backup into the database, replacing what's there.

To restore into a different container, for example copying production data into staging:

```bash
vigil restore songdis-postgres__songdis__20260916-020000.sql.gz songdis-staging-postgres
```

To restore a copy you only have in Telegram (for example, after rebuilding the server), download the file from the chat, upload it to the server, then restore:

```bash
scp songdis-postgres__songdis__20260916-020000.sql.gz root@your-server:/var/backups/vigil/
vigil restore songdis-postgres__songdis__20260916-020000.sql.gz
```

### Settings (`.env`, all optional)

```env
BACKUP_DIR=/var/backups/vigil        # where backups are stored on the host
BACKUP_KEEP_DAYS=7                   # delete local backups older than this
BACKUP_SEND_TO_TELEGRAM=true         # send backups under 50 MB to the Telegram chat

# Off-server copies in S3-compatible storage (example: Contabo Object Storage)
BACKUP_S3_ENDPOINT=https://eu2.contabostorage.com
BACKUP_S3_REGION=us-east-1
BACKUP_S3_BUCKET=songdis-backups
BACKUP_S3_ACCESS_KEY=...
BACKUP_S3_SECRET_KEY=...
BACKUP_S3_PREFIX=vigil/my-server     # defaults to vigil/<hostname>
```

For AWS S3, leave `BACKUP_S3_ENDPOINT` empty and set `BACKUP_S3_REGION` to your bucket's region.

### Security notes

- Backups contain your full data. `/var/backups/vigil` is readable only by root on a default Ubuntu install, so keep it that way.
- Anyone in the Telegram chat can download backups sent there. Use a private chat.
- Backup commands in Telegram only respond in the chat set as `TELEGRAM_CHAT_ID`.

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
| `/backup <container> [database]` | Back up a database now |
| `/backups [container]` | List backups on the server |
| `/restore <file> [container]` | Restore a backup (asks for confirmation) |
| `/backup_schedule <container> daily 02:00` | Schedule backups (`hourly`, `daily HH:MM`, `weekly sun HH:MM`, or `off`) |
| `/backup_schedules` | List backup schedules |

See [Database Backups](#database-backups) for details.

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
