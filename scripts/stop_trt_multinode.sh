#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-trtllm-multinode}"
WORKER_SSH="${WORKER_SSH:-admin@192.168.1.204}"
WORKER_SSH_OPTS="${WORKER_SSH_OPTS:--o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i /home/admin/.ssh/trtllm_ed25519}"

docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
ssh $WORKER_SSH_OPTS "$WORKER_SSH" "docker rm -f '$CONTAINER_NAME' >/dev/null 2>&1 || true" >/dev/null 2>&1 || true

echo "[ok] stopped TRT multinode containers for $CONTAINER_NAME"
