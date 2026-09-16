# VigilOps

**The ops engineer that lives on your server.**

VigilOps is a self-hosted ops agent for Docker servers. It watches your containers, fixes common failures, backs up your databases, and checks with you on Telegram before doing anything risky.

📖 **Documentation:** see [`website/src/content/docs/docs`](website/src/content/docs/docs/) (to be published on the VigilOps website)

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
curl -fsSL https://raw.githubusercontent.com/VigilOpsHq/vigil/main/install.sh | sudo sh
sudo nano /opt/vigil/.env      # Telegram bot token, chat ID, DeepSeek key
vigil start
```

Full steps, including creating the Telegram bot: [Install](website/src/content/docs/docs/install.mdx).

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
| [What is VigilOps?](website/src/content/docs/docs/index.mdx) | [Database backups](website/src/content/docs/docs/guides/backups.mdx) | [CLI commands](website/src/content/docs/docs/reference/cli.md) |
| [Install](website/src/content/docs/docs/install.mdx) | [Restoring a backup](website/src/content/docs/docs/guides/restore.mdx) | [Telegram commands](website/src/content/docs/docs/reference/telegram.md) |
| [First steps](website/src/content/docs/docs/first-steps.mdx) | [Off-server backup storage](website/src/content/docs/docs/guides/offsite-storage.mdx) | [Configuration (.env)](website/src/content/docs/docs/reference/configuration.md) |
| | [Auto-fixes, AI and approvals](website/src/content/docs/docs/guides/auto-fixes.mdx) | [Files and paths](website/src/content/docs/docs/reference/files.md) |
| | [Deploying apps](website/src/content/docs/docs/guides/deploys.mdx) | |
| | [Updating VigilOps](website/src/content/docs/docs/guides/updating.mdx) | |
| | [AI agents (MCP)](website/src/content/docs/docs/guides/mcp.mdx) | |

## Contributing

- [Developing locally](website/src/content/docs/docs/contributing/develop.md)
- [Releasing a version](website/src/content/docs/docs/contributing/release.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)

## License

MIT
