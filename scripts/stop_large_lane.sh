#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/admin/apps/LLMCommune"
PORT="${LLMCOMMUNE_LARGE_PORT:-8000}"
WORKER_SSH="${WORKER_SSH:-admin@192.168.1.204}"
WORKER_SSH_OPTS="${WORKER_SSH_OPTS:--o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i /home/admin/.ssh/trtllm_ed25519}"

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

wait_for_local_port_release() {
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

for c in llm-shared coder-main-8000 vllm trtllm-multinode; do
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

ssh $WORKER_SSH_OPTS "$WORKER_SSH" \
  "bash -lc 'for c in trtllm-multinode llm-shared coder-main-8000 vllm; do docker rm -f \"\$c\" >/dev/null 2>&1 || true; done; while IFS= read -r stale_id; do [[ -n \"\$stale_id\" ]] || continue; docker rm -f \"\$stale_id\" >/dev/null 2>&1 || true; done < <(docker ps -a --filter \"publish=${PORT}\" --format \"{{.ID}}\"); for _ in \$(seq 1 90); do if ! ss -Hlnpt \"sport = :${PORT}\" 2>/dev/null | grep -q .; then exit 0; fi; sleep 1; done; exit 0'" >/dev/null 2>&1 || true

wait_for_local_port_release >/dev/null 2>&1 || true

rm -f "$ROOT/workspace/runtime/large_slot.json"
echo "[ok] stopped LLMCommune large lane on :${PORT}"
