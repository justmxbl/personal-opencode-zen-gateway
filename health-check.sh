#!/usr/bin/env sh
# HTTP health probe for the OpenCode Zen Gateway (Linux / macOS).
#
# Checks the gateway's /health endpoint (which probes the opencode backend) and
# optionally the /ready endpoint (which does a real completion). If the gateway
# is unreachable, the systemd service is restarted.
#
# Can be run from cron or a systemd timer, for example every 5 minutes:
#   */5 * * * * /opt/opencode-zen-gateway/health-check.sh >> /var/log/ozg-health.log 2>&1

PORT="${PORT:-8899}"
CHECK_READY="${CHECK_READY:-0}"
SERVICE="opencode-zen-gateway"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

restart() {
  log "restarting $SERVICE..."
  if systemctl --user is-enabled "$SERVICE" >/dev/null 2>&1; then
    systemctl --user restart "$SERVICE"
  else
    systemctl restart "$SERVICE"
  fi
}

if command -v curl >/dev/null 2>&1; then
  HTTP_GET() { curl -fsS -m 20 "$1"; }
else
  HTTP_GET() { wget -q -O - -T 20 "$1"; }
fi

BODY="$(HTTP_GET "http://127.0.0.1:$PORT/health" 2>/dev/null)" || {
  log "UNREACHABLE"
  restart
  sleep 15
  HTTP_GET "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && log "recovered" || log "still down"
  exit 0
}

case "$BODY" in
  *'"status":"ok"'*) log "OK $BODY" ;;
  *) log "DEGRADED $BODY"; restart ;;
esac

if [ "$CHECK_READY" = "1" ]; then
  READY="$(HTTP_GET "http://127.0.0.1:$PORT/ready?force=1" 2>/dev/null)" && log "ready $READY" || log "ready FAILED"
fi
