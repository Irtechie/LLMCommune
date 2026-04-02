#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/admin/apps/LLMCommune"
LOG_DIR="$ROOT/workspace/runtime"
PID_FILE="$LOG_DIR/controller-4000.pid"
LOG_FILE="$LOG_DIR/controller-4000.log"

mkdir -p "$LOG_DIR"

if systemctl --user list-unit-files llmcommune-controller.service >/dev/null 2>&1; then
  systemctl --user daemon-reload
  systemctl --user start llmcommune-controller.service
  echo "LLMCommune controller started on :4000 via systemd user service"
  exit 0
fi

if [[ -f "$PID_FILE" ]]; then
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${pid:-}" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    echo "LLMCommune controller already running on :4000 with pid $pid"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

nohup env PORT=4000 node "$ROOT/src/index.js" >>"$LOG_FILE" 2>&1 &
pid=$!
sleep 1

if [[ -z "${pid:-}" ]] || ! kill -0 "$pid" >/dev/null 2>&1; then
  echo "LLMCommune controller failed to start; see $LOG_FILE" >&2
  exit 1
fi

echo "$pid" >"$PID_FILE"

echo "LLMCommune controller started on :4000 (pid $pid)"
