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
sudo nano /opt/vigil/.env      # Telegram bot token, chat ID, DeepSeek key
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

## Documentation

| Getting started | Guides | Reference |
|---|---|---|
| [What is VigilOps?](https://vigilops.cloud/docs/) | [Database backups](https://vigilops.cloud/docs/guides/backups/) | [CLI commands](https://vigilops.cloud/docs/reference/cli/) |
| [Install](https://vigilops.cloud/docs/install/) | [Restoring a backup](https://vigilops.cloud/docs/guides/restore/) | [Telegram commands](https://vigilops.cloud/docs/reference/telegram/) |
| [First steps](https://vigilops.cloud/docs/first-steps/) | [Off-server backup storage](https://vigilops.cloud/docs/guides/offsite-storage/) | [Configuration (.env)](https://vigilops.cloud/docs/reference/configuration/) |
| | [Auto-fixes, AI and approvals](https://vigilops.cloud/docs/guides/auto-fixes/) | [Files and paths](https://vigilops.cloud/docs/reference/files/) |
| | [Deploying apps](https://vigilops.cloud/docs/guides/deploys/) | |
| | [Updating VigilOps](https://vigilops.cloud/docs/guides/updating/) | |
| | [AI agents (MCP)](https://vigilops.cloud/docs/guides/mcp/) | |

## Contributing

- [Developing locally](https://vigilops.cloud/docs/contributing/develop/)
- [Releasing a version](https://vigilops.cloud/docs/contributing/release/)
- [CONTRIBUTING.md](CONTRIBUTING.md)

## License

MIT
