#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/admin/apps/LLMCommune"
PORT="${PORT:-8000}"

for c in llm-shared coder-main-8000 vllm trtllm-multinode; do
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

ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null admin@192.168.1.204 \
  "bash -lc 'for c in trtllm-multinode llm-shared coder-main-8000 vllm; do docker rm -f \"\$c\" >/dev/null 2>&1 || true; done; while IFS= read -r stale_id; do [[ -n \"\$stale_id\" ]] || continue; docker rm -f \"\$stale_id\" >/dev/null 2>&1 || true; done < <(docker ps -a --filter \"publish=${PORT}\" --format \"{{.ID}}\")'" >/dev/null 2>&1 || true

rm -f "$ROOT/workspace/runtime/large_slot.json"
echo "[ok] stopped LLMCommune large lane on :${PORT}"
