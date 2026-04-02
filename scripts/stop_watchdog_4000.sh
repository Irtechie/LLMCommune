#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/admin/apps/LLMCommune"
LOG_DIR="$ROOT/workspace/runtime"
WATCHDOG_PID_FILE="$LOG_DIR/watchdog-4000.pid"

if systemctl --user list-unit-files llmcommune-watchdog.service >/dev/null 2>&1; then
  systemctl --user stop llmcommune-watchdog.service >/dev/null 2>&1 || true
fi

if [[ -f "$WATCHDOG_PID_FILE" ]]; then
  pid="$(cat "$WATCHDOG_PID_FILE" 2>/dev/null || true)"
  if [[ -n "${pid:-}" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    sleep 1
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$WATCHDOG_PID_FILE"
fi

pkill -f '/home/admin/apps/LLMCommune/src/watchdog.js' >/dev/null 2>&1 || true
echo "LLMCommune watchdog stopped"
