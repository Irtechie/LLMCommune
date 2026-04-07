#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/admin/apps/LLMCommune"
LANE_ID="${LANE_ID:?LANE_ID is required}"
PORT="${PORT:?PORT is required}"
CONTAINER_NAME="${CONTAINER_NAME:?CONTAINER_NAME is required}"
SLOT_LABEL="${SLOT_LABEL:?SLOT_LABEL is required}"
MODEL_PATH="${MODEL_PATH:?MODEL_PATH is required}"
MMPROJ_PATH="${MMPROJ_PATH:-}"
DOCKER_IMAGE="${DOCKER_IMAGE:-container-deepseek32b-server-llama:latest}"
SERVER_BIN="${SERVER_BIN:-/opt/llama/build/bin/llama-server}"
NATIVE_SERVER_BIN="${NATIVE_SERVER_BIN:-}"
CTX_SIZE="${CTX_SIZE:-32768}"
STARTUP_RETRIES="${STARTUP_RETRIES:-3}"
RETRY_BACKOFF_SECS="${RETRY_BACKOFF_SECS:-5}"
STATE_PATH="$ROOT/workspace/runtime/${LANE_ID}_slot.json"
LOG_PATH="$ROOT/workspace/runtime/${LANE_ID}_server.log"

if [[ ! -e "$MODEL_PATH" ]]; then
  echo "Model not found: $MODEL_PATH" >&2
  exit 1
fi

if [[ -n "$MMPROJ_PATH" && ! -e "$MMPROJ_PATH" ]]; then
  echo "mmproj not found: $MMPROJ_PATH" >&2
  exit 1
fi

CONTAINER_MODEL_PATH="$MODEL_PATH"
if [[ "$CONTAINER_MODEL_PATH" == /mnt/models/* ]]; then
  CONTAINER_MODEL_PATH="/models/${CONTAINER_MODEL_PATH#/mnt/models/}"
fi

CONTAINER_MMPROJ_PATH="$MMPROJ_PATH"
if [[ -n "$CONTAINER_MMPROJ_PATH" && "$CONTAINER_MMPROJ_PATH" == /mnt/models/* ]]; then
  CONTAINER_MMPROJ_PATH="/models/${CONTAINER_MMPROJ_PATH#/mnt/models/}"
fi

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
  local deadline=$((SECONDS + 30))
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

cleanup_port_state() {
  while IFS= read -r stale_id; do
    [[ -n "$stale_id" ]] || continue
    docker rm -f "$stale_id" >/dev/null 2>&1 || true
  done < <(docker ps -a --filter "publish=${PORT}" --format '{{.ID}}')

  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    kill "$pid" >/dev/null 2>&1 || true
  done < <(listener_pids)

  if [[ -f "$ROOT/workspace/runtime/${LANE_ID}_server.pid" ]]; then
    local pid
    pid="$(cat "$ROOT/workspace/runtime/${LANE_ID}_server.pid" 2>/dev/null || true)"
    if [[ -n "$pid" ]]; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
    rm -f "$ROOT/workspace/runtime/${LANE_ID}_server.pid"
  fi

  wait_for_port_release >/dev/null 2>&1 || true
}

launch_container() {
  local mmproj_args=()
  if [[ -n "$CONTAINER_MMPROJ_PATH" ]]; then
    mmproj_args+=(--mmproj "$CONTAINER_MMPROJ_PATH")
  fi
  docker run -d \
    --name "$CONTAINER_NAME" \
    --label "llmcommune.lane=${LANE_ID}" \
    --label "llmcommune.slot_owner=${SLOT_LABEL}" \
    --gpus all \
    -p "${PORT}:${PORT}" \
    -v /mnt/models:/models \
    --entrypoint "$SERVER_BIN" \
    "$DOCKER_IMAGE" \
    --host 0.0.0.0 \
    --port "${PORT}" \
    --model "${CONTAINER_MODEL_PATH}" \
    "${mmproj_args[@]}" \
    --ctx-size "${CTX_SIZE}" \
    --parallel 1 \
    --n-gpu-layers -1 \
    --flash-attn on >/dev/null
}

launch_native() {
  local mmproj_args=()
  if [[ -n "$MMPROJ_PATH" ]]; then
    mmproj_args+=(--mmproj "$MMPROJ_PATH")
  fi
  mkdir -p "$(dirname "$LOG_PATH")"
  nohup "$NATIVE_SERVER_BIN" \
    --host 0.0.0.0 \
    --port "${PORT}" \
    --model "${MODEL_PATH}" \
    "${mmproj_args[@]}" \
    --ctx-size "${CTX_SIZE}" \
    --parallel 1 \
    --n-gpu-layers -1 \
    --flash-attn on \
    >"$LOG_PATH" 2>&1 &
  echo $! >"$ROOT/workspace/runtime/${LANE_ID}_server.pid"
}

attempt=1
while [[ "$attempt" -le "$STARTUP_RETRIES" ]]; do
  cleanup_port_state
  if [[ -n "$NATIVE_SERVER_BIN" ]]; then
    launch_native
  else
    launch_container
  fi
  if [[ $? -eq 0 ]]; then
    break
  fi
  if [[ "$attempt" -ge "$STARTUP_RETRIES" ]]; then
    exit 1
  fi
  sleep "$RETRY_BACKOFF_SECS"
  attempt=$((attempt + 1))
done

python3 - "$STATE_PATH" "$LANE_ID" "$PORT" "$SLOT_LABEL" "$MODEL_PATH" "$MMPROJ_PATH" "$CONTAINER_NAME" <<'PY'
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
    "mmproj_path": sys.argv[6],
    "container_name": sys.argv[7],
    "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
}
state_path.parent.mkdir(parents=True, exist_ok=True)
state_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

echo "LLMCommune lane launched:"
echo " - lane: ${LANE_ID}"
echo " - endpoint: http://127.0.0.1:${PORT}/v1/models"
echo " - model: ${MODEL_PATH}"
