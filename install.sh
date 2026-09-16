#!/bin/sh
# Install or upgrade Vigil:
#   curl -fsSL https://raw.githubusercontent.com/VigilOpsHq/vigil/main/install.sh | sudo sh
set -e

REPO="VigilOpsHq/vigil"
RAW="https://raw.githubusercontent.com/$REPO/main"
VIGIL_DIR="${VIGIL_DIR:-/opt/vigil}"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root: curl -fsSL $RAW/install.sh | sudo sh" >&2
  exit 1
fi

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

if [ ! -f "$VIGIL_DIR/.env" ]; then
  cp "$VIGIL_DIR/.env.example" "$VIGIL_DIR/.env"
  chmod 600 "$VIGIL_DIR/.env"
  say "Almost done. Fill in your settings, then start Vigil:"
  echo "  nano $VIGIL_DIR/.env"
  echo "  vigil start"
  exit 0
fi

say "Starting Vigil..."
cd "$VIGIL_DIR"
docker compose pull
docker compose up -d
sleep 3
vigil version || true
say "Vigil is running. Try: vigil status"
