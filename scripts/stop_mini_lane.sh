#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/admin/apps/LLMCommune"
PORT="${PORT:-7999}"

for c in coder-deepseek-7999 llm-mini-7999 llm-trt-mini-7999; do
  docker rm -f "$c" >/dev/null 2>&1 || true
done

while IFS= read -r stale_id; do
  [[ -n "$stale_id" ]] || continue
  docker rm -f "$stale_id" >/dev/null 2>&1 || true
done < <(docker ps -a --filter "publish=${PORT}" --format '{{.ID}}')

if command -v lsof >/dev/null 2>&1; then
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    kill "$pid" >/dev/null 2>&1 || true
  done < <(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | sort -u)
fi

rm -f "$ROOT/workspace/runtime/mini_slot.json"
echo "[ok] stopped LLMCommune mini lane on :${PORT}"
