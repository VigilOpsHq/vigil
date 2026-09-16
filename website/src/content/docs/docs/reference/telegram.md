---
title: Telegram commands
description: Every command the VigilOps Telegram bot understands.
---

Send these to your VigilOps bot. Backup and update commands only respond in the chat set as `TELEGRAM_CHAT_ID`.

## Server

| Command | What it does |
|---|---|
| `/status` | Containers, disk, memory, nginx and health checks |
| `/help` | Buttons for the most-used commands |

## Backups

| Command | What it does |
|---|---|
| `/backup <container> [database]` | Back up a database now |
| `/backups [container]` | List backups on the server (newest 15) |
| `/restore <file> [container]` | Restore a backup. Asks you to confirm with a button. The confirmation expires after 10 minutes |
| `/backup_schedule <container> <when>` | Schedule backups: `hourly`, `daily HH:MM`, `weekly <day> HH:MM` |
| `/backup_schedule <container> off` | Remove a schedule |
| `/backup_schedules` | List schedules |

## Deploys

| Command | What it does |
|---|---|
| `/apps` | List registered apps |
| `/deploy <app>` | Deploy an app with health check and rollback |

## Approvals

| Command | What it does |
|---|---|
| `/approve_<id>` | Approve a suggested action (same as the **Approve** button) |
| `/deny_<id>` | Deny a suggested action (same as the **Deny** button) |

## Updates

| Command | What it does |
|---|---|
| `/version` | Show the running version. Offers an **Update** button if a newer release exists |
| `/update` | Update to the newest release allowed by `VIGIL_TAG` |

## Messages VigilOps sends on its own

| When | Message |
|---|---|
| VigilOps starts or stops | `🟢 VigilOps 1.2.4 started` / `🔴 VigilOps stopped` |
| A rule fixes something | `🔧 Auto-fix: ...` followed by each command's result |
| A problem needs attention | `🚨 ...` and, with AI enabled, the AI's diagnosis |
| An action needs your approval | `⚠️ Approval Required` with **Approve** / **Deny** buttons |
| A backup finishes or fails | `✅ Backup done: ...` / `❌ Backup FAILED: ...`, plus the file if under 50 MB |
| A new release is out (once a day at most) | `⬆️ VigilOps x.y.z is available` with an **Update** button |
