---
title: Developing locally
description: Run VigilOps from source, build your own image, and work on the docs site.
---

## Requirements

- Node.js 20+
- Docker
- A **separate Telegram bot** for development, so your dev copy doesn't fight your servers for updates

## Run from source

```bash
git clone https://github.com/VigilOpsHq/vigil
cd vigil
npm install
cp .env.example .env          # fill in the test bot token, chat ID and a webhook secret
npm run dev                   # the service
npm run dev:cli -- status     # a CLI command
npm run dev:mcp               # the MCP server
```

Type-check with `npm run lint`, and build with `npm run build`.

On a machine where backups should go somewhere other than `/var/backups/vigil`, set `BACKUP_DIR` in `.env`.

## Build and run your own image

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

This builds `vigil:local` from your checkout instead of pulling the published image. Use it for changes that can't be configured, such as [registering deploy apps](/docs/guides/deploys/).

## Project layout

| Path | What's there |
|---|---|
| `src/index.ts` | The service: monitoring loop, webhook, backup scheduler |
| `src/collector/` | Snapshots: containers, disk, memory, health checks |
| `src/rules/` | Built-in rules and thresholds |
| `src/executor/` | Command allowlist |
| `src/ai/` | DeepSeek escalation |
| `src/backup/` | Backups, restores, schedules, off-server copies |
| `src/update/` | Version checks and self-update |
| `src/telegram/` | Telegram bot |
| `src/cli/` | `vigil` commands |
| `src/deploy/` | Deploys with health check and rollback |
| `src/mcp/` | MCP server |
| `scripts/vigil`, `install.sh` | The host `vigil` command and the installer |
| `website/` | This site |

## Docs site

The website and docs are built with [Astro Starlight](https://starlight.astro.build) in `website/`:

```bash
cd website
npm install
npm run dev        # http://localhost:4321
npm run build      # outputs website/dist
```

Docs pages are Markdown/MDX in `website/src/content/docs/docs/`. The landing page is `website/src/pages/index.astro`. When you change a command or setting, update its docs page in the same pull request.
