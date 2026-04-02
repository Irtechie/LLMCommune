#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/admin/apps/LLMCommune"
PORT="${PORT:-7999}"
WORKER_SSH="${WORKER_SSH:-admin@192.168.1.204}"
WORKER_SSH_OPTS="${WORKER_SSH_OPTS:--o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i /home/admin/.ssh/trtllm_ed25519}"

ssh $WORKER_SSH_OPTS "$WORKER_SSH" \
  "bash -lc 'for c in llmcommune-worker-deepseek-7999 coder-deepseek-7999 llm-mini-7999 llm-trt-mini-7999; do docker rm -f \"\$c\" >/dev/null 2>&1 || true; done; while IFS= read -r stale_id; do [[ -n \"\$stale_id\" ]] || continue; docker rm -f \"\$stale_id\" >/dev/null 2>&1 || true; done < <(docker ps -a --filter \"publish=${PORT}\" --format \"{{.ID}}\")'" >/dev/null 2>&1 || true

rm -f "$ROOT/workspace/runtime/worker_mini_slot.json"
echo "[ok] stopped LLMCommune worker mini on gx10 :${PORT}"
