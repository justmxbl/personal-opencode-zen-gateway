#!/usr/bin/env sh
# Installs the OpenCode Zen Gateway as a systemd user service (Linux / macOS).
#
#   systemctl --user status opencode-zen-gateway
#   journalctl --user -u opencode-zen-gateway -f
#
# Run with sudo to install system-wide instead:
#   sudo ./install-service.sh --system

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node || true)"

if [ -z "$NODE" ]; then
  echo "node was not found on PATH. Install Node.js 18+ first." >&2
  exit 1
fi

SCOPE="--user"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SYSTEMCTL="systemctl --user"

if [ "$1" = "--system" ]; then
  SCOPE="--system"
  UNIT_DIR="/etc/systemd/system"
  SYSTEMCTL="systemctl"
fi

mkdir -p "$UNIT_DIR"
sed "s|__DIR__|$DIR|g; s|__NODE__|$NODE|g" \
  "$DIR/opencode-zen-gateway.service" > "$UNIT_DIR/opencode-zen-gateway.service"

$SYSTEMCTL daemon-reload
$SYSTEMCTL enable --now opencode-zen-gateway.service

echo ""
echo "Installed systemd service 'opencode-zen-gateway' ($SCOPE)."
echo "Gateway: http://127.0.0.1:8899/v1"
echo "Health:  curl http://127.0.0.1:8899/health"
echo "Logs:    journalctl $SCOPE -u opencode-zen-gateway -f"
