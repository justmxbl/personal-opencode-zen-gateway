#!/usr/bin/env sh
# OpenCode Zen Gateway launcher (Linux / macOS).
# Runs the gateway in the foreground. It spawns and supervises `opencode serve`.
set -e
cd "$(dirname "$0")"
exec node gateway.js "$@"
