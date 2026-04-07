#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/admin/apps/LLMCommune"
PORT="${LLMCOMMUNE_MINI_PORT:-7999}"

listener_pids() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | sort -u
    return 0
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -Hlnpt "sport = :${PORT}" 2>/dev/null | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' | sort -u
    return 0
  fi
  return 0
}

wait_for_port_release() {
  local deadline=$((SECONDS + 90))
  while (( SECONDS < deadline )); do
    local port_open="0"
    if listener_pids | grep -q .; then
      port_open="1"
    fi
    if ! docker ps -a --filter "publish=${PORT}" --format '{{.ID}}' | grep -q . && [[ "$port_open" == "0" ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

for c in coder-deepseek-7999 llm-mini-7999 llm-trt-mini-7999; do
  docker rm -f "$c" >/dev/null 2>&1 || true
done

while IFS= read -r stale_id; do
  [[ -n "$stale_id" ]] || continue
  docker rm -f "$stale_id" >/dev/null 2>&1 || true
done < <(docker ps -a --filter "publish=${PORT}" --format '{{.ID}}')

while IFS= read -r pid; do
  [[ -n "$pid" ]] || continue
  kill "$pid" >/dev/null 2>&1 || true
done < <(listener_pids)

wait_for_port_release >/dev/null 2>&1 || true

rm -f "$ROOT/workspace/runtime/mini_slot.json"
echo "[ok] stopped LLMCommune mini lane on :${PORT}"
