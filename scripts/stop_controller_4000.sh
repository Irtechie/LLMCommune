#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/admin/apps/LLMCommune"
PID_FILE="$ROOT/workspace/runtime/controller-4000.pid"

if systemctl --user list-unit-files llmcommune-controller.service >/dev/null 2>&1; then
  systemctl --user stop llmcommune-controller.service >/dev/null 2>&1 || true
fi

if [[ -f "$PID_FILE" ]]; then
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${pid:-}" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    sleep 1
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$PID_FILE"
fi

pkill -f '/home/admin/apps/LLMCommune/src/index.js' >/dev/null 2>&1 || true
echo "LLMCommune controller stopped"
