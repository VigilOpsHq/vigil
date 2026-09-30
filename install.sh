#!/bin/sh
# Install or upgrade VigilOps.
#
#   curl -fsSL https://vigilops.cloud/install.sh | sudo sh
#
# The agent starts straight away and watches your containers, disk and memory.
# Alerts are optional: run `vigil setup` afterwards to send them to Telegram.
#
# Unattended installs can pass settings as flags or environment variables.
# Prefer the variables: arguments are visible in `ps` and land in shell history.
set -e

VIGIL_DIR="${VIGIL_DIR:-/opt/vigil}"
REPO="VigilOpsHq/vigil"
RAW="https://raw.githubusercontent.com/$REPO/main"

CLOUD_TOKEN="${VIGIL_CLOUD_TOKEN:-}"
TG_TOKEN="${VIGIL_TELEGRAM_TOKEN:-}"
TG_CHAT="${VIGIL_CHAT_ID:-}"
AI_KEY="${VIGIL_AI_KEY:-}"
NO_START=0

usage() {
  cat <<'EOF'
Install or upgrade VigilOps.

  curl -fsSL https://vigilops.cloud/install.sh | sudo sh

Options (all optional):
  --cloud-token <t>     Connect to VigilOps Cloud (also: --token)
  --telegram-token <t>  Telegram bot token from @BotFather
  --chat-id <id>        Telegram chat to alert. Without it, the installer
                        waits for you to send /start to the bot
  --ai-key <key>        API key for an OpenAI-compatible AI provider
  --no-start            Install and configure, but don't start the agent
  -h, --help            Show this message

Every option has an environment variable, which keeps secrets out of `ps`
and your shell history:

  VIGIL_CLOUD_TOKEN  VIGIL_TELEGRAM_TOKEN  VIGIL_CHAT_ID  VIGIL_AI_KEY

  VIGIL_TELEGRAM_TOKEN=123:AAH... sudo -E sh -c "$(curl -fsSL https://vigilops.cloud/install.sh)"
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --token|--cloud-token) CLOUD_TOKEN="$2"; shift 2 ;;
    --token=*) CLOUD_TOKEN="${1#--token=}"; shift ;;
    --cloud-token=*) CLOUD_TOKEN="${1#--cloud-token=}"; shift ;;
    --telegram-token) TG_TOKEN="$2"; shift 2 ;;
    --telegram-token=*) TG_TOKEN="${1#--telegram-token=}"; shift ;;
    --chat-id) TG_CHAT="$2"; shift 2 ;;
    --chat-id=*) TG_CHAT="${1#--chat-id=}"; shift ;;
    --ai-key) AI_KEY="$2"; shift 2 ;;
    --ai-key=*) AI_KEY="${1#--ai-key=}"; shift ;;
    --no-start) NO_START=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) shift ;;
  esac
done

case "$CLOUD_TOKEN" in
  ""|vo_srv_*) ;;
  *) echo "That does not look like a VigilOps Cloud token (it should start with vo_srv_)" >&2; exit 1 ;;
esac

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root: curl -fsSL https://vigilops.cloud/install.sh | sudo sh" >&2
  exit 1
fi

# ── Settings file ───────────────────────────────────────────────────────────
# Values are written in place so hand-edited settings and comments survive.
env_backup_done=0
backup_env() {
  [ "$env_backup_done" = 1 ] && return 0
  [ -f "$VIGIL_DIR/.env" ] || return 0
  cp "$VIGIL_DIR/.env" "$VIGIL_DIR/.env.bak.$(date +%Y%m%d-%H%M%S)"
  env_backup_done=1
}

set_env() {
  backup_env
  KEY="$1" VAL="$2" awk '
    BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VAL"]; done = 0 }
    $0 ~ "^" k "=" && !done { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$VIGIL_DIR/.env" > "$VIGIL_DIR/.env.tmp"
  mv "$VIGIL_DIR/.env.tmp" "$VIGIL_DIR/.env"
  chmod 600 "$VIGIL_DIR/.env"
}

# Add keys introduced by newer versions, without touching anything already set
merge_env() {
  added=''
  keys=$(grep -o '^[A-Z_][A-Z0-9_]*=' "$VIGIL_DIR/.env.example" | tr -d '=')
  for key in $keys; do
    grep -q "^$key=" "$VIGIL_DIR/.env" && continue
    if [ -z "$added" ]; then
      backup_env
      printf '\n# Added by the installer on %s\n' "$(date +%Y-%m-%d)" >> "$VIGIL_DIR/.env"
    fi
    grep "^$key=" "$VIGIL_DIR/.env.example" | head -1 >> "$VIGIL_DIR/.env"
    added="$added $key"
  done
  [ -n "$added" ] && echo "Added new settings to .env, with their defaults:$added"
  return 0
}

# ── Dependencies ────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
fi

if ! docker compose version >/dev/null 2>&1; then
  say "Installing the Docker Compose plugin..."
  mkdir -p /usr/local/lib/docker/cli-plugins
  curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
fi

say "Setting up $VIGIL_DIR..."
mkdir -p "$VIGIL_DIR/logs" /var/backups/vigil
chmod 700 /var/backups/vigil

if [ -f "$VIGIL_DIR/docker-compose.yml" ] && ! grep -q "ghcr.io/vigilopshq/vigil" "$VIGIL_DIR/docker-compose.yml"; then
  cp "$VIGIL_DIR/docker-compose.yml" "$VIGIL_DIR/docker-compose.yml.bak"
  echo "Saved your old docker-compose.yml as docker-compose.yml.bak"
fi
curl -fsSL "$RAW/docker-compose.yml" -o "$VIGIL_DIR/docker-compose.yml"
curl -fsSL "$RAW/.env.example" -o "$VIGIL_DIR/.env.example"
curl -fsSL "$RAW/scripts/vigil" -o /usr/local/bin/vigil
chmod +x /usr/local/bin/vigil

if [ -f "$VIGIL_DIR/.env" ]; then
  merge_env
else
  cp "$VIGIL_DIR/.env.example" "$VIGIL_DIR/.env"
  chmod 600 "$VIGIL_DIR/.env"
fi

# ── Anything passed in ──────────────────────────────────────────────────────
[ -n "$CLOUD_TOKEN" ] && set_env VIGIL_CLOUD_TOKEN "$CLOUD_TOKEN"
[ -n "$AI_KEY" ] && set_env AI_API_KEY "$AI_KEY"

if [ -n "$TG_TOKEN" ]; then
  if ! curl -fsS "https://api.telegram.org/bot$TG_TOKEN/getMe" 2>/dev/null | grep -q '"ok":[[:space:]]*true'; then
    echo "That Telegram bot token was rejected by Telegram." >&2
    exit 1
  fi
  if [ -z "$TG_CHAT" ]; then
    echo "Waiting for a /start message to the bot (up to 3 minutes)..."
    curl -fsS "https://api.telegram.org/bot$TG_TOKEN/deleteWebhook" >/dev/null 2>&1 || true
    deadline=$(( $(date +%s) + ${VIGIL_SETUP_TIMEOUT:-180} ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
      tick=$(date +%s)
      TG_CHAT=$(curl -fsS "https://api.telegram.org/bot$TG_TOKEN/getUpdates?timeout=25&offset=-1" 2>/dev/null \
        | grep -o '"chat":[[:space:]]*{[[:space:]]*"id":[[:space:]]*-\{0,1\}[0-9]\{1,\}' | head -1 | sed 's/.*"id":[[:space:]]*//')
      [ -n "$TG_CHAT" ] && break
      [ $(( $(date +%s) - tick )) -lt 2 ] && sleep 2
    done
    if [ -z "$TG_CHAT" ]; then
      echo "No message arrived, so the chat ID is unknown. Run \`vigil setup\` on the server to finish." >&2
      exit 1
    fi
  fi
  set_env TELEGRAM_BOT_TOKEN "$TG_TOKEN"
  set_env TELEGRAM_CHAT_ID "$TG_CHAT"
  curl -fsS -X POST "https://api.telegram.org/bot$TG_TOKEN/sendMessage" \
    -d "chat_id=$TG_CHAT" -d "text=VigilOps is installed on $(hostname) and will send alerts here." >/dev/null 2>&1 || true
fi

if [ "$NO_START" = 1 ]; then
  say "Installed. Start it when you're ready:"
  echo "  vigil start"
  exit 0
fi

# ── Start ───────────────────────────────────────────────────────────────────
say "Starting VigilOps..."
cd "$VIGIL_DIR"
docker compose pull
docker compose up -d

# Give the agent a moment to take its first look at the server
sleep 4

if [ "$(docker inspect -f '{{.State.Running}}' vigil 2>/dev/null)" != "true" ]; then
  echo "VigilOps did not start. Its logs:" >&2
  docker compose logs --tail 30 vigil >&2 || true
  exit 1
fi

watched=$(docker ps --format '{{.Names}}\t{{.Status}}' | awk -F'\t' '$1 != "vigil"')
count=$(printf '%s' "$watched" | grep -c . || true)

if [ "$count" -gt 0 ]; then
  say "✅ VigilOps is running and watching $count container$([ "$count" = 1 ] || echo s)."
  printf '\n%s\n' "$watched" | awk -F'\t' 'NF { printf "   %-24s %s\n", $1, $2 }'
else
  say "✅ VigilOps is running."
  echo "   No other containers are running yet. It will pick them up as they start."
fi

if [ -n "$CLOUD_TOKEN" ]; then
  printf '\n   Connected to VigilOps Cloud. Backups from this server will be stored there.\n'
fi

if grep -q '^TELEGRAM_BOT_TOKEN=.\{1,\}' "$VIGIL_DIR/.env"; then
  printf '\n   Alerts go to Telegram. Try sending it /status.\n\n'
else
  printf '\n   Alerts are not configured yet. To get them on Telegram:\n'
  printf '       vigil setup\n\n'
fi
