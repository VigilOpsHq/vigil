---
title: Configuration (.env)
description: Every setting in /opt/vigil/.env.
---

VigilOps reads its settings from `/opt/vigil/.env`. After changing it, restart with `vigil stop && vigil start`.

[`.env.example`](https://github.com/VigilOpsHq/vigil/blob/main/.env.example) has every setting with comments. The installer puts a copy at `/opt/vigil/.env.example`.

## Telegram

Needed for alerts and commands from your own bot. Optional on servers connected to [VigilOps Cloud](/docs/guides/cloud/), which sends alerts through the official VigilOps bot instead. Without them, suggested actions that need approval are logged but never run.

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from [@BotFather](https://t.me/botfather). Use a different bot on each server |
| `TELEGRAM_CHAT_ID` | The chat VigilOps reports to and accepts commands from. See [Install](/docs/install/) for how to find it |

## VigilOps Cloud

| Variable | Default | Description |
|---|---|---|
| `VIGIL_CLOUD_TOKEN` | — | Server token from the [dashboard](/app/). Set by `install.sh --token`. `vigil cloud connect` stores the token in `/var/backups/vigil/cloud.json` instead; this variable wins if both are set |
| `VIGIL_CLOUD_URL` | `https://vigilops.cloud` | Cloud address. Only change it for development |

## AI

| Variable | Default | Description |
|---|---|---|
| `AI_API_KEY` | — | API key for your provider. Leave it empty to run on rules alone, with no AI calls |
| `AI_BASE_URL` | `https://api.deepseek.com` | Any OpenAI-compatible API. `/chat/completions` is added for you if the URL doesn't already end with it |
| `AI_MODEL` | `deepseek-chat` | Model name, as your provider spells it |

`DEEPSEEK_API_KEY` and `DEEPSEEK_MODEL` still work if you already set them; `AI_API_KEY` and `AI_MODEL` win when both are present.

Providers that work as-is:

| Provider | `AI_BASE_URL` | Example `AI_MODEL` |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| OpenRouter | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4` |
| Together | `https://api.together.xyz/v1` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` |
| Mistral | `https://api.mistral.ai/v1` | `mistral-small-latest` |
| Ollama (local) | `http://localhost:11434/v1` | `llama3.2` |
| vLLM (local) | `http://localhost:8000/v1` | whatever you're serving |

Local models need no key. VigilOps runs with `network_mode: host`, so `localhost` from inside the container is your server.

Anthropic's and Google's own APIs use a different request format, so point them through OpenRouter rather than at their native endpoints.

## Monitoring

| Variable | Default | Description |
|---|---|---|
| `POLL_INTERVAL_SECONDS` | `60` | How often to check the server |
| `EXCLUDED_CONTAINERS` | — | Comma-separated container names to ignore completely |
| `HEALTH_CHECK_URLS` | — | Comma-separated URLs that must answer with 2xx/3xx within 5 seconds |
| `HEALTH_CHECK_CONTAINER_MAP` | — | `URL:container` pairs, comma-separated. Restarts the container when its URL fails |
| `DISK_ALERT_PERCENT` | `85` | Disk usage that triggers Docker image clean-up |
| `MEMORY_ALERT_PERCENT` | `90` | Memory usage that triggers an alert |
| `CRASH_LOOP_THRESHOLD` | `3` | Restarts within the window that count as a crash loop |
| `CRASH_LOOP_WINDOW_MINUTES` | `10` | Crash-loop window |
| `APPROVAL_TIMEOUT_MINUTES` | `10` | How long a suggested action waits for approval before it's denied |

## Backups

| Variable | Default | Description |
|---|---|---|
| `BACKUP_DIR` | `/var/backups/vigil` | Where backups and schedules are stored. If you change it, change the volume in `docker-compose.yml` too |
| `BACKUP_KEEP_DAYS` | `7` | Delete server-disk backups older than this. The newest per container is always kept |
| `BACKUP_SEND_TO_TELEGRAM` | `true` | Send backups up to 50 MB to the Telegram chat |
| `BACKUP_S3_ENDPOINT` | — | S3 endpoint URL. Leave empty for AWS S3 |
| `BACKUP_S3_REGION` | `us-east-1` | Bucket region |
| `BACKUP_S3_BUCKET` | — | Bucket name. Storage uploads are on when bucket and both keys are set |
| `BACKUP_S3_ACCESS_KEY` | — | Access key ID |
| `BACKUP_S3_SECRET_KEY` | — | Secret access key |
| `BACKUP_S3_PREFIX` | `vigil/<hostname>` | Folder inside the bucket |

## Updates

| Variable | Default | Description |
|---|---|---|
| `VIGIL_TAG` | `latest` | Image version to run: `latest`, `1.2` (1.2.x only) or `1.2.3` (exact) |
| `VIGIL_UPDATE_CHECK` | `true` | Check for new releases daily, announce them on Telegram, and remind you after `vigil` commands. Set to `false` to switch both off |

## Webhook and MCP

| Variable | Default | Description |
|---|---|---|
| `VIGIL_WEBHOOK_SECRET` | — | Enables the deploy webhook and is the token CI must send. Generate with `openssl rand -hex 32`. Without it, `/webhook/*` returns 503 |
| `WEBHOOK_PORT` | `3100` | Port for `/health` and the deploy webhook |
| `MCP_MODE` | `stdio` | MCP server mode when started: `stdio`, `http` or `both` |
| `MCP_PORT` | `3200` | Port for MCP HTTP mode |

## Advanced

| Variable | Default | Description |
|---|---|---|
| `VIGIL_REPO` | `VigilOpsHq/vigil` | GitHub repository checked for releases |
| `VIGIL_CONTAINER` | `vigil` | Name of the VigilOps container, used by self-update |
| `VIGIL_DIR` | `/opt/vigil` | Install directory, used by the `vigil` command and self-update |
