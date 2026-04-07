#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/admin/apps/LLMCommune"
LANE_ID="${LANE_ID:-large}"
PORT="${PORT:-8000}"
SLOT_LABEL="${SLOT_LABEL:?SLOT_LABEL is required}"
MODEL_SPEC="${MODEL_SPEC:?MODEL_SPEC is required}"
DOCKER_IMAGE="${DOCKER_IMAGE:-nvcr.io/nvidia/tensorrt-llm/release:1.2.0rc6}"
if [[ "$LANE_ID" == "mini" ]]; then
  CONTAINER_NAME="${CONTAINER_NAME:-llm-trt-mini-7999}"
else
  CONTAINER_NAME="${CONTAINER_NAME:-llm-shared}"
fi
MAX_NUM_TOKENS="${MAX_NUM_TOKENS:-32768}"
MAX_BATCH_SIZE="${MAX_BATCH_SIZE:-1}"
FREE_GPU_MEMORY_FRACTION="${FREE_GPU_MEMORY_FRACTION:-0.92}"
FORCE_DOCKER_PULL="${FORCE_DOCKER_PULL:-0}"
DOCKER_PULL_TIMEOUT_SECS="${DOCKER_PULL_TIMEOUT_SECS:-900}"
API_READY_TIMEOUT_SECS="${API_READY_TIMEOUT_SECS:-600}"
STARTUP_RETRIES="${STARTUP_RETRIES:-3}"
RETRY_BACKOFF_SECS="${RETRY_BACKOFF_SECS:-15}"
HOST_RUNTIME_ROOT="${HOST_RUNTIME_ROOT:-$ROOT/workspace/jobs/_lanes}"
HOST_SLOT_DIR="${HOST_RUNTIME_ROOT}/${SLOT_LABEL}"
HOST_LOG_PATH="${HOST_SLOT_DIR}/serve-${PORT}.log"
HOST_STATUS_PATH="${HOST_SLOT_DIR}/status-${PORT}.log"
HOST_SLOT_META_PATH="${HOST_SLOT_DIR}/slot.json"
HOST_ACTIVE_SLOT_PATH="${HOST_RUNTIME_ROOT}/active_slot.json"
CONTAINER_RUNTIME_ROOT="${CONTAINER_RUNTIME_ROOT:-/workspace_lanes}"
CONTAINER_SLOT_DIR="${CONTAINER_RUNTIME_ROOT}/${SLOT_LABEL}"
CONTAINER_LOG_PATH="${CONTAINER_SLOT_DIR}/serve-${PORT}.log"
HF_HOME_HOST="${HF_HOME_HOST:-$HOME/.cache/huggingface}"
TORCH_EXTENSIONS_HOST="${TORCH_EXTENSIONS_HOST:-$HOME/.cache/torch_extensions}"
FLASHINFER_HOST="${FLASHINFER_HOST:-$HOME/.cache/flashinfer}"
TIKTOKEN_RS_CACHE_DIR="${TIKTOKEN_RS_CACHE_DIR:-/tmp/harmony-reqs}"
TIKTOKEN_CACHE_DIR="${TIKTOKEN_CACHE_DIR:-/tmp/tiktoken-cache}"
TIKTOKEN_ENCODINGS_BASE="${TIKTOKEN_ENCODINGS_BASE:-/tmp/harmony-reqs}"
TORCH_CUDA_ARCH_LIST="${TORCH_CUDA_ARCH_LIST:-12.0}"

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
    if [[ "$port_open" == "0" ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

log() {
  printf '[trtllm-single] %s\n' "$*" >&2
}

record_status() {
  mkdir -p "$HOST_SLOT_DIR"
  printf '%s %s\n' "$(date -Is)" "$*" >>"$HOST_STATUS_PATH"
}

write_slot_state() {
  local state="$1"
  local active="$2"
  local detail="${3:-}"
  local updated_at
  updated_at="$(date -Is)"
  mkdir -p "$HOST_SLOT_DIR"
  python3 - "$HOST_SLOT_META_PATH" "$HOST_ACTIVE_SLOT_PATH" "$SLOT_LABEL" "$PORT" "$MODEL_SPEC" "$DOCKER_IMAGE" "$state" "$active" "$detail" "$HOST_LOG_PATH" "$HOST_STATUS_PATH" "$updated_at" <<'PY'
from pathlib import Path
import json
import sys

slot_path = Path(sys.argv[1])
active_path = Path(sys.argv[2])
slot_label = sys.argv[3]
port = int(sys.argv[4])
model_spec = sys.argv[5]
docker_image = sys.argv[6]
state = sys.argv[7]
active = sys.argv[8].lower() in {"1", "true", "yes", "on"}
detail = sys.argv[9]
log_path = sys.argv[10]
status_path = sys.argv[11]
updated_at = sys.argv[12]

payload = {
    "slot_label": slot_label,
    "port": port,
    "model_spec": model_spec,
    "docker_image": docker_image,
    "state": state,
    "active": active,
    "detail": detail,
    "log_path": log_path,
    "status_path": status_path,
    "updated_at": updated_at,
}
slot_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
active_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY
}

mark_other_slots_inactive() {
  mkdir -p "$HOST_RUNTIME_ROOT"
  local slot_dir
  for slot_dir in "$HOST_RUNTIME_ROOT"/*; do
    [[ -d "$slot_dir" ]] || continue
    [[ "$(basename "$slot_dir")" == "$SLOT_LABEL" ]] && continue
    [[ "$(basename "$slot_dir")" == "synapse" ]] && continue
    cat >"$slot_dir/slot.json" <<EOF
{
  "slot_label": "$(basename "$slot_dir")",
  "port": $PORT,
  "state": "inactive",
  "active": false,
  "superseded_by": "$SLOT_LABEL",
  "updated_at": "$(date -Is)"
}
EOF
  done
}

docker_image_present_local() {
  docker image inspect "$DOCKER_IMAGE" >/dev/null 2>&1
}

ensure_local_image() {
  if [[ "$FORCE_DOCKER_PULL" == "1" ]]; then
    log "force-pulling local image $DOCKER_IMAGE"
    timeout "${DOCKER_PULL_TIMEOUT_SECS}" docker pull "$DOCKER_IMAGE" >/dev/null
    return
  fi
  if docker_image_present_local; then
    log "using cached local image $DOCKER_IMAGE"
    return
  fi
  log "local image missing; pulling $DOCKER_IMAGE"
  timeout "${DOCKER_PULL_TIMEOUT_SECS}" docker pull "$DOCKER_IMAGE" >/dev/null
}

cleanup_failed_container() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}

launch_container() {
  mkdir -p "$HOST_SLOT_DIR" "$HF_HOME_HOST" "$TORCH_EXTENSIONS_HOST" "$FLASHINFER_HOST"
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  ensure_local_image
  docker run -d --rm \
    --name "$CONTAINER_NAME" \
    --label "llmcommune.lane=${LANE_ID}" \
    --label "llmcommune.slot_owner=${SLOT_LABEL}" \
    --gpus all \
    --network host \
    --ulimit memlock=-1 \
    --ulimit stack=67108864 \
    -e HF_HOME=/root/.cache/huggingface \
    -e CPATH=/usr/local/cuda/include \
    -e C_INCLUDE_PATH=/usr/local/cuda/include \
    -e CPLUS_INCLUDE_PATH=/usr/local/cuda/include \
    -e CUDA_HOME=/usr/local/cuda \
    -e TRITON_PTXAS_PATH=/usr/local/cuda/bin/ptxas \
    -e TIKTOKEN_RS_CACHE_DIR="$TIKTOKEN_RS_CACHE_DIR" \
    -e TIKTOKEN_CACHE_DIR="$TIKTOKEN_CACHE_DIR" \
    -e TIKTOKEN_ENCODINGS_BASE="$TIKTOKEN_ENCODINGS_BASE" \
    -e TORCH_CUDA_ARCH_LIST="$TORCH_CUDA_ARCH_LIST" \
    -v "$HF_HOME_HOST:/root/.cache/huggingface" \
    -v "$TORCH_EXTENSIONS_HOST:/root/.cache/torch_extensions" \
    -v "$FLASHINFER_HOST:/root/.cache/flashinfer" \
    -v "$HOST_RUNTIME_ROOT:$CONTAINER_RUNTIME_ROOT" \
    -v /mnt/models:/mnt/models \
    "$DOCKER_IMAGE" \
    bash -lc "mkdir -p '$CONTAINER_SLOT_DIR' && cat >/tmp/extra-llm-api-config.yml <<'EOF'
print_iter_log: false
kv_cache_config:
  dtype: \"auto\"
  free_gpu_memory_fraction: $FREE_GPU_MEMORY_FRACTION
cuda_graph_config:
  enable_padding: true
EOF
exec trtllm-llmapi-launch trtllm-serve '$MODEL_SPEC' \
  --backend pytorch \
  --tp_size 1 \
  --host 0.0.0.0 \
  --port '$PORT' \
  --max_num_tokens '$MAX_NUM_TOKENS' \
  --max_batch_size '$MAX_BATCH_SIZE' \
  --extra_llm_api_options /tmp/extra-llm-api-config.yml \
  >>'$CONTAINER_LOG_PATH' 2>&1"
}

wait_for_api_ready() {
  local deadline=$((SECONDS + API_READY_TIMEOUT_SECS))
  while (( SECONDS < deadline )); do
    if curl -fsS "http://127.0.0.1:${PORT}/v1/models" >/dev/null 2>&1; then
      return 0
    fi
    if ! docker ps --format '{{.Names}}' | grep -Fx "$CONTAINER_NAME" >/dev/null 2>&1; then
      return 1
    fi
    sleep 5
  done
  return 1
}

attempt=1
while [[ "$attempt" -le "$STARTUP_RETRIES" ]]; do
  if [[ "$LANE_ID" == "mini" ]]; then
    bash "$ROOT/scripts/stop_mini_lane.sh" >/dev/null 2>&1 || true
  else
    bash "$ROOT/scripts/stop_large_lane.sh" >/dev/null 2>&1 || true
  fi
  if ! wait_for_port_release >/dev/null 2>&1; then
    write_slot_state "failed" false "port ${PORT} did not clear before launch attempt ${attempt}"
    record_status "port ${PORT} did not clear before launch attempt ${attempt}"
    if [[ "$attempt" -ge "$STARTUP_RETRIES" ]]; then
      exit 1
    fi
    sleep "$RETRY_BACKOFF_SECS"
    attempt=$((attempt + 1))
    continue
  fi

  write_slot_state "starting" false "launching single-box TRT lane attempt ${attempt}/${STARTUP_RETRIES}"
  record_status "launch requested for $MODEL_SPEC attempt=${attempt}"

  if ! launch_container >/dev/null; then
    write_slot_state "failed" false "container launch failed on attempt ${attempt}"
    record_status "container launch failed on attempt ${attempt}"
    if [[ "$attempt" -ge "$STARTUP_RETRIES" ]]; then
      exit 1
    fi
    sleep "$RETRY_BACKOFF_SECS"
    attempt=$((attempt + 1))
    continue
  fi

  record_status "container launched; waiting for API attempt=${attempt}"
  if wait_for_api_ready; then
    write_slot_state "ready" true "api responsive and process alive"
    mark_other_slots_inactive
    record_status "runtime ready on :${PORT}"
    log "single-box TRT lane ready for ${MODEL_SPEC} on :${PORT}"
    exit 0
  fi

  cleanup_failed_container
  write_slot_state "failed" false "runtime did not become ready on attempt ${attempt}"
  record_status "runtime did not become ready on attempt ${attempt}"
  if [[ "$attempt" -ge "$STARTUP_RETRIES" ]]; then
    exit 1
  fi
  sleep "$RETRY_BACKOFF_SECS"
  attempt=$((attempt + 1))
done

exit 1
