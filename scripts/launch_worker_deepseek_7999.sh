#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/admin/apps/LLMCommune"
PORT="${PORT:-7999}"
WORKER_SSH="${WORKER_SSH:-admin@192.168.1.204}"
WORKER_SSH_OPTS="${WORKER_SSH_OPTS:--o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i /home/admin/.ssh/trtllm_ed25519}"
CONTAINER_NAME="${CONTAINER_NAME:-llmcommune-worker-deepseek-7999}"
SLOT_LABEL="${SLOT_LABEL:-gguf_deepseek_32b_worker_fleet}"
MODEL_PATH="${MODEL_PATH:-/mnt/models/qwen/DeepSeek-R1-Distill-Qwen-32B-Q4_K_M/files/DeepSeek-R1-Distill-Qwen-32B-Q4_K_M.gguf}"
CTX_SIZE="${CTX_SIZE:-32768}"
STARTUP_RETRIES="${STARTUP_RETRIES:-3}"
RETRY_BACKOFF_SECS="${RETRY_BACKOFF_SECS:-5}"
STATE_PATH="$ROOT/workspace/runtime/worker_mini_slot.json"

bash "$ROOT/scripts/stop_worker_mini_7999.sh" >/dev/null 2>&1 || true

ssh $WORKER_SSH_OPTS "$WORKER_SSH" "bash -lc '
set -euo pipefail
if [[ ! -e \"$MODEL_PATH\" ]]; then
  echo \"Model not found: $MODEL_PATH\" >&2
  exit 1
fi
CONTAINER_MODEL_PATH=\"$MODEL_PATH\"
if [[ \"\$CONTAINER_MODEL_PATH\" == /mnt/models/* ]]; then
  CONTAINER_MODEL_PATH=\"/models/\${CONTAINER_MODEL_PATH#/mnt/models/}\"
fi
docker rm -f \"$CONTAINER_NAME\" >/dev/null 2>&1 || true
while IFS= read -r stale_id; do
  [[ -n \"\$stale_id\" ]] || continue
  docker rm -f \"\$stale_id\" >/dev/null 2>&1 || true
done < <(docker ps -a --filter \"publish=${PORT}\" --format \"{{.ID}}\")
attempt=1
while [[ \"\$attempt\" -le \"${STARTUP_RETRIES}\" ]]; do
  if docker run -d \
    --name \"$CONTAINER_NAME\" \
    --label \"llmcommune.fleet=mini\" \
    --label \"llmcommune.slot_owner=$SLOT_LABEL\" \
    --gpus all \
    -p \"${PORT}:${PORT}\" \
    -v /mnt/models:/models \
    --entrypoint /opt/llama/build/bin/llama-server \
    container-deepseek32b-server-llama:latest \
    --host 0.0.0.0 \
    --port \"${PORT}\" \
    --model \"\$CONTAINER_MODEL_PATH\" \
    --ctx-size \"${CTX_SIZE}\" \
    --parallel 1 \
    --n-gpu-layers -1 \
    --flash-attn on >/dev/null; then
    break
  fi
  docker rm -f \"$CONTAINER_NAME\" >/dev/null 2>&1 || true
  while IFS= read -r stale_id; do
    [[ -n \"\$stale_id\" ]] || continue
    docker rm -f \"\$stale_id\" >/dev/null 2>&1 || true
  done < <(docker ps -a --filter \"publish=${PORT}\" --format \"{{.ID}}\")
  if [[ \"\$attempt\" -ge \"${STARTUP_RETRIES}\" ]]; then
    exit 1
  fi
  sleep \"${RETRY_BACKOFF_SECS}\"
  attempt=$((attempt + 1))
done
'"

python3 - "$STATE_PATH" "$PORT" "$SLOT_LABEL" "$MODEL_PATH" "$CONTAINER_NAME" <<'PY'
from pathlib import Path
from datetime import datetime, timezone
import json
import sys

state_path = Path(sys.argv[1])
payload = {
    "lane_id": "worker_mini",
    "host_id": "gx10",
    "port": int(sys.argv[2]),
    "profile_id": sys.argv[3],
    "slot_label": sys.argv[3],
    "model_path": sys.argv[4],
    "container_name": sys.argv[5],
    "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
}
state_path.parent.mkdir(parents=True, exist_ok=True)
state_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

echo "LLMCommune worker mini launched:"
echo " - host: gx10-b041"
echo " - endpoint: http://192.168.1.204:${PORT}/v1/models"
echo " - model: ${MODEL_PATH}"
