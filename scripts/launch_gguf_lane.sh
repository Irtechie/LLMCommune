#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/admin/apps/LLMCommune"
LANE_ID="${LANE_ID:?LANE_ID is required}"
PORT="${PORT:?PORT is required}"
CONTAINER_NAME="${CONTAINER_NAME:?CONTAINER_NAME is required}"
SLOT_LABEL="${SLOT_LABEL:?SLOT_LABEL is required}"
MODEL_PATH="${MODEL_PATH:?MODEL_PATH is required}"
CTX_SIZE="${CTX_SIZE:-32768}"
STATE_PATH="$ROOT/workspace/runtime/${LANE_ID}_slot.json"

if [[ ! -e "$MODEL_PATH" ]]; then
  echo "Model not found: $MODEL_PATH" >&2
  exit 1
fi

CONTAINER_MODEL_PATH="$MODEL_PATH"
if [[ "$CONTAINER_MODEL_PATH" == /mnt/models/* ]]; then
  CONTAINER_MODEL_PATH="/models/${CONTAINER_MODEL_PATH#/mnt/models/}"
fi

while IFS= read -r stale_id; do
  [[ -n "$stale_id" ]] || continue
  docker rm -f "$stale_id" >/dev/null 2>&1 || true
done < <(docker ps -a --filter "publish=${PORT}" --format '{{.ID}}')

docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

docker run -d \
  --name "$CONTAINER_NAME" \
  --label "llmcommune.lane=${LANE_ID}" \
  --label "llmcommune.slot_owner=${SLOT_LABEL}" \
  --gpus all \
  -p "${PORT}:${PORT}" \
  -v /mnt/models:/models \
  --entrypoint /opt/llama/build/bin/llama-server \
  container-deepseek32b-server-llama:latest \
  --host 0.0.0.0 \
  --port "${PORT}" \
  --model "${CONTAINER_MODEL_PATH}" \
  --ctx-size "${CTX_SIZE}" \
  --parallel 1 \
  --n-gpu-layers -1 \
  --flash-attn on >/dev/null

python3 - "$STATE_PATH" "$LANE_ID" "$PORT" "$SLOT_LABEL" "$MODEL_PATH" "$CONTAINER_NAME" <<'PY'
from pathlib import Path
from datetime import datetime, timezone
import json
import sys

state_path = Path(sys.argv[1])
payload = {
    "lane_id": sys.argv[2],
    "port": int(sys.argv[3]),
    "profile_id": sys.argv[4],
    "slot_label": sys.argv[4],
    "model_path": sys.argv[5],
    "container_name": sys.argv[6],
    "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
}
state_path.parent.mkdir(parents=True, exist_ok=True)
state_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

echo "LLMCommune lane launched:"
echo " - lane: ${LANE_ID}"
echo " - endpoint: http://127.0.0.1:${PORT}/v1/models"
echo " - model: ${MODEL_PATH}"
