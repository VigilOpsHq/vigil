---
title: Files and paths
description: Where VigilOps keeps its settings, logs, backups and schedules.
---

## On the server

| Path | Contents | Safe to delete? |
|---|---|---|
| `/opt/vigil/.env` | Settings and secrets | No |
| `/opt/vigil/.env.example` | Reference copy of all settings, refreshed by the installer | Yes |
| `/opt/vigil/docker-compose.yml` | How the VigilOps container runs. Replaced by the installer | No |
| `/opt/vigil/logs/audit.jsonl` | Every action VigilOps took | Yes, but you lose history |
| `/var/backups/vigil/*.sql.gz`, `*.archive.gz` | Database backups | ⚠️ These are your backups |
| `/var/backups/vigil/schedules.json` | Backup schedules. Change them with `vigil backup schedule`, don't edit by hand | No |
| `/var/backups/vigil/cloud.json` | VigilOps Cloud server token, written by `vigil cloud connect` (root only) | Deleting it disconnects the server |
| `/usr/local/bin/vigil` | The `vigil` command | Reinstalled by the installer |

## What to back up for disaster recovery

To rebuild a server's VigilOps setup elsewhere, you only need:

- `/opt/vigil/.env`
- your database backups, ideally already in [off-server storage](/docs/guides/offsite-storage/)
- `/var/backups/vigil/schedules.json`, or just set the schedules again

Everything else is recreated by the installer.

## Inside the container

The container `vigil` runs `ghcr.io/vigilopshq/vigil` with:

| Mount | Why |
|---|---|
| `/var/run/docker.sock` | To see, restart, back up and deploy containers |
| `/opt` (read-only) | To read deploy compose files |
| `/var/backups/vigil` | Backups and schedules |
| `/opt/vigil/logs` → `/app/logs` | Audit log |
| `/etc/localtime` (read-only) | Use the server's time zone for schedules |

It uses the host network, so the webhook on port 3100 is reachable on the server directly.
