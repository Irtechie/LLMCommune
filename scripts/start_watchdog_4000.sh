#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/admin/apps/LLMCommune"
LOG_DIR="$ROOT/workspace/runtime"
PID_FILE="$LOG_DIR/watchdog-4000.pid"
LOG_FILE="$LOG_DIR/watchdog-4000.log"

mkdir -p "$LOG_DIR"

if systemctl --user list-unit-files llmcommune-watchdog.service >/dev/null 2>&1; then
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  systemctl --user start llmcommune-watchdog.service
  echo "LLMCommune watchdog service started for :4000"
  exit 0
fi

if [[ -f "$PID_FILE" ]]; then
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${pid:-}" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    echo "LLMCommune watchdog already running for :4000 with pid $pid"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

nohup node "$ROOT/src/watchdog.js" >>"$LOG_FILE" 2>&1 &
pid=$!
echo "$pid" >"$PID_FILE"
sleep 1

if ! kill -0 "$pid" >/dev/null 2>&1; then
  echo "LLMCommune watchdog failed to start; see $LOG_FILE" >&2
  exit 1
fi

echo "LLMCommune watchdog started for :4000 (pid $pid)"
