# VigilOps

**The ops engineer that lives on your server.**

VigilOps is a self-hosted ops agent for Docker servers. It watches your containers, fixes common failures, backs up your databases, and checks with you on Telegram before doing anything risky.

🌐 **Website:** [vigilops.cloud](https://vigilops.cloud) · 📖 **Docs:** [vigilops.cloud/docs](https://vigilops.cloud/docs/) · 💳 **Plans:** [vigilops.cloud/pricing](https://vigilops.cloud/pricing/)

---

## What it does

- **Fixes the usual problems:** restarts stopped containers, clears old Docker images when the disk fills up, restarts apps whose health check fails
- **Backs up databases:** Postgres, MySQL/MariaDB and MongoDB, on a schedule, with copies off the server and restores that take a safety backup first
- **Runs from Telegram:** status, backups, restores, deploys and updates from your phone
- **Asks before anything risky:** only allowlisted commands run; anything uncertain comes to you with Approve / Deny buttons
- **Uses AI when the rules run out:** unusual problems go to DeepSeek for a diagnosis and proposed fix
- **Deploys with rollback:** pull, restart, health check, automatic rollback, triggered from CI or Telegram

Terraform and Ansible **build** your servers. VigilOps keeps them **running**.

## Install

On an Ubuntu or Debian server:

```bash
curl -fsSL https://vigilops.cloud/install.sh | sudo sh
sudo nano /opt/vigil/.env      # your Telegram bot token and chat ID; DeepSeek key optional
vigil start
```

Full steps, including creating the Telegram bot: [Install](https://vigilops.cloud/docs/install/).

## Quick tour

```bash
vigil status                                       # containers, disk, memory, health checks
vigil backup myapp-postgres                        # back up a database now
vigil backup schedule myapp-postgres daily 02:00   # and every night
vigil backups                                      # list backups
vigil restore <file>                               # restore (safety backup taken first)
vigil update                                       # update VigilOps
```

The same things work from Telegram: `/status`, `/backup myapp-postgres`, `/backups`, `/restore <file>`, `/update`.

## VigilOps Cloud (Pro and Team)

The self-hosted version is free and complete. [Pro and Team plans](https://vigilops.cloud/pricing/) add VigilOps Cloud:

- **Managed backup storage:** every backup is also stored by us (Pro 50 GB / 30 days, Team 250 GB / 90 days)
- **Dashboard** at [vigilops.cloud/app](https://vigilops.cloud/app/): every server and backup, with download
- **Alerts from outside your servers:** the official VigilOps bot tells you when a server goes offline or a scheduled backup doesn't arrive
- **Restore anywhere:** `vigil restore` downloads from the cloud, even onto a brand-new server
- **No Telegram setup needed:** your own bot becomes optional

Connect a server with one command, using a token from the dashboard:

```bash
curl -fsSL https://vigilops.cloud/install.sh | sudo sh -s -- --token vo_srv_...   # new server
vigil cloud connect vo_srv_...                                                    # existing server
```

Guide: [VigilOps Cloud](https://vigilops.cloud/docs/guides/cloud/).

## Documentation

| Getting started | Guides | Reference |
|---|---|---|
| [What is VigilOps?](https://vigilops.cloud/docs/) | [VigilOps Cloud](https://vigilops.cloud/docs/guides/cloud/) | [CLI commands](https://vigilops.cloud/docs/reference/cli/) |
| [Install](https://vigilops.cloud/docs/install/) | [Database backups](https://vigilops.cloud/docs/guides/backups/) | [Telegram commands](https://vigilops.cloud/docs/reference/telegram/) |
| [First steps](https://vigilops.cloud/docs/first-steps/) | [Restoring a backup](https://vigilops.cloud/docs/guides/restore/) | [Configuration (.env)](https://vigilops.cloud/docs/reference/configuration/) |
| | [Off-server backup storage](https://vigilops.cloud/docs/guides/offsite-storage/) | [Files and paths](https://vigilops.cloud/docs/reference/files/) |
| | [Auto-fixes, AI and approvals](https://vigilops.cloud/docs/guides/auto-fixes/) | |
| | [Deploying apps](https://vigilops.cloud/docs/guides/deploys/) | |
| | [Updating VigilOps](https://vigilops.cloud/docs/guides/updating/) | |
| | [AI agents (MCP)](https://vigilops.cloud/docs/guides/mcp/) | |

## Repository layout

| Path | What's there |
|---|---|
| `src/` | The agent: monitoring, rules, backups, Telegram bot, CLI, Cloud client |
| `install.sh`, `scripts/vigil` | The installer and the host `vigil` command |
| `website/` | vigilops.cloud: landing page, docs, dashboard, and the Cloudflare Worker behind VigilOps Cloud |

## Contributing

- [Developing locally](https://vigilops.cloud/docs/contributing/develop/)
- [Releasing a version](https://vigilops.cloud/docs/contributing/release/)
- [Website and payments](https://vigilops.cloud/docs/contributing/website/)
- [CONTRIBUTING.md](CONTRIBUTING.md)

Every push runs CI: type checks, builds, the Docker image, and an end-to-end test of VigilOps Cloud (`website/test/cloud-e2e.mjs`).

## License

MIT
