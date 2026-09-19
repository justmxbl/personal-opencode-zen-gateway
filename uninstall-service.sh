#!/usr/bin/env sh
# Removes the OpenCode Zen Gateway systemd service (Linux / macOS).

set -e

if [ "$1" = "--system" ]; then
  SYSTEMCTL="systemctl"
  UNIT_DIR="/etc/systemd/system"
else
  SYSTEMCTL="systemctl --user"
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
fi

$SYSTEMCTL disable --now opencode-zen-gateway.service 2>/dev/null || true
rm -f "$UNIT_DIR/opencode-zen-gateway.service"
$SYSTEMCTL daemon-reload

echo "Removed systemd service 'opencode-zen-gateway'."
