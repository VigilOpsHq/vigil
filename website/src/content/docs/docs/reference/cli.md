---
title: CLI commands
description: Every vigil command.
---

Run `vigil help` on the server for a short version of this page.

`vigil start`, `vigil stop` and `vigil update` manage the service with Docker Compose. Every other command runs inside the VigilOps container, so it needs the service to be running.

## Service

| Command | What it does |
|---|---|
| `vigil start` | Start VigilOps (`docker compose up -d` in `/opt/vigil`) |
| `vigil stop` | Stop VigilOps |
| `vigil update` | Download the newest image allowed by `VIGIL_TAG` and restart |
| `vigil version` | Show the running version and whether an update is available |

## Server

| Command | What it does |
|---|---|
| `vigil status` | Containers, disk, memory, nginx and health checks |
| `vigil containers` | All containers with ID, state and uptime |
| `vigil logs <container> [lines]` | Last lines of a container's logs (default 50) |
| `vigil restart <container>` | Restart a container |
| `vigil disk` | Disk usage |
| `vigil memory` | Memory usage |
| `vigil health` | Run the health checks from `HEALTH_CHECK_URLS` |

## Backups

| Command | What it does |
|---|---|
| `vigil backup <container> [database]` | Back up a database now |
| `vigil backups [container]` | List backups on this server, newest first |
| `vigil restore <file> [container] [database] [--yes]` | Restore a backup. Takes a safety backup first. `--yes` skips the confirmation |
| `vigil backup schedule <container> <when>` | Schedule backups: `hourly`, `daily HH:MM`, `weekly <day> HH:MM` |
| `vigil backup unschedule <container>` | Remove a schedule |
| `vigil backup schedules` | List schedules |

See [Database backups](/docs/guides/backups/) and [Restoring a backup](/docs/guides/restore/).

## VigilOps Cloud (Pro and Team)

| Command | What it does |
|---|---|
| `vigil cloud connect <token>` | Connect this server using a token from the [dashboard](/app/) |
| `vigil cloud status` | Show which server name and plan it's connected to |
| `vigil cloud backups [container]` | List backups stored in the cloud, from all your servers |
| `vigil cloud disconnect` | Stop sending backups to the cloud. Stored backups are kept |

See [VigilOps Cloud](/docs/guides/cloud/).

## Deploys

| Command | What it does |
|---|---|
| `vigil apps` | List apps registered for deploys |
| `vigil deploy <app>` | Deploy an app with health check and rollback |

See [Deploying apps](/docs/guides/deploys/).

## Exit codes

Commands exit with `0` on success and `1` on failure, so you can use them in scripts:

```bash
vigil backup myapp-postgres || echo "backup failed"
```
