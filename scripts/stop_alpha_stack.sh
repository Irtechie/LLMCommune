#!/usr/bin/env bash
set -euo pipefail

WORKER_SSH="${WORKER_SSH:-admin@192.168.1.204}"
WORKER_SSH_OPTS="${WORKER_SSH_OPTS:--o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i /home/admin/.ssh/trtllm_ed25519}"

kill_listener_port() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    while IFS= read -r pid; do
      [[ -n "$pid" ]] || continue
      kill -9 "$pid" >/dev/null 2>&1 || true
    done < <(lsof -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null | sort -u)
  fi
}

remove_local_port_containers() {
  local port="$1"
  while IFS= read -r stale_id; do
    [[ -n "$stale_id" ]] || continue
    docker rm -f "$stale_id" >/dev/null 2>&1 || true
  done < <(docker ps -a --filter "publish=${port}" --format '{{.ID}}')
}

ssh $WORKER_SSH_OPTS "$WORKER_SSH" \
  "bash -lc 'for c in trtllm-multinode llm-shared coder-main-8000 vllm coder-deepseek-7999 llm-mini-7999 llm-trt-mini-7999; do docker rm -f \"\$c\" >/dev/null 2>&1 || true; done; while IFS= read -r stale_id; do [[ -n \"\$stale_id\" ]] || continue; docker rm -f \"\$stale_id\" >/dev/null 2>&1 || true; done < <(docker ps -a --filter \"publish=8000\" --format \"{{.ID}}\"); while IFS= read -r stale_id; do [[ -n \"\$stale_id\" ]] || continue; docker rm -f \"\$stale_id\" >/dev/null 2>&1 || true; done < <(docker ps -a --filter \"publish=7999\" --format \"{{.ID}}\")'" >/dev/null 2>&1 || true

for c in trtllm-multinode llm-shared coder-main-8000 vllm coder-deepseek-7999 llm-mini-7999 llm-trt-mini-7999; do
  docker rm -f "$c" >/dev/null 2>&1 || true
done

remove_local_port_containers 8000
remove_local_port_containers 7999

pkill -9 -f '/home/admin/apps/Alpha/apps/synapse/src/index.js' >/dev/null 2>&1 || true
pkill -9 -f '/home/admin/apps/Alpha/scripts/game_run_watchdog.py' >/dev/null 2>&1 || true
pkill -9 -f '/home/admin/apps/Alpha/scripts/launch_synapse' >/dev/null 2>&1 || true

kill_listener_port 4000
kill_listener_port 7999
kill_listener_port 8000

echo "[ok] Alpha stack stopped and Alpha-owned containers removed"
