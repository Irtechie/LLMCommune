#!/usr/bin/env bash
set -euo pipefail

PRIMARY_LINK_IP="${PRIMARY_LINK_IP:-169.254.10.1}"
WORKER_LINK_IP="${WORKER_LINK_IP:-169.254.10.2}"
WORKER_SSH="${WORKER_SSH:-admin@192.168.1.204}"
WORKER_SSH_OPTS="${WORKER_SSH_OPTS:--o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i /home/admin/.ssh/trtllm_ed25519}"
DOCKER_IMAGE="${DOCKER_IMAGE:-nvcr.io/nvidia/tensorrt-llm/release:1.0.0rc3}"
CONTAINER_NAME="${CONTAINER_NAME:-trtllm-multinode}"
SLOT_LABEL="${SLOT_LABEL:-shared_trtllm}"
HOSTFILE_PATH="${HOSTFILE_PATH:-$HOME/openmpi-hostfile}"
PORT="${PORT:-8000}"
TRTLLM_HOST="${TRTLLM_HOST:-0.0.0.0}"
STARTUP_RETRIES="${STARTUP_RETRIES:-2}"
RETRY_BACKOFF_SECS="${RETRY_BACKOFF_SECS:-20}"
DOCKER_PULL_TIMEOUT_SECS="${DOCKER_PULL_TIMEOUT_SECS:-600}"
FORCE_DOCKER_PULL="${FORCE_DOCKER_PULL:-0}"
CONTAINER_BOOT_TIMEOUT_SECS="${CONTAINER_BOOT_TIMEOUT_SECS:-180}"
API_READY_TIMEOUT_SECS="${API_READY_TIMEOUT_SECS:-600}"
POST_READY_GRACE_SECS="${POST_READY_GRACE_SECS:-15}"
SKIP_API_WAIT="${SKIP_API_WAIT:-0}"
MAX_NUM_TOKENS="${MAX_NUM_TOKENS:-131072}"
MAX_SEQ_LEN="${MAX_SEQ_LEN:-}"
MAX_BATCH_SIZE="${MAX_BATCH_SIZE:-1}"
FREE_GPU_MEMORY_FRACTION="${FREE_GPU_MEMORY_FRACTION:-0.95}"
UCX_NET_DEVICES="${UCX_NET_DEVICES:-enp1s0f0np0}"
NCCL_IB_HCA="${NCCL_IB_HCA:-rocep1s0f0}"
NCCL_DEBUG="${NCCL_DEBUG:-INFO}"
NCCL_IB_DISABLE="${NCCL_IB_DISABLE:-0}"
MODEL_SPEC="${MODEL_SPEC:?MODEL_SPEC is required}"
EXTRA_SETUP_SCRIPT="${EXTRA_SETUP_SCRIPT:-}"
MPI_SSH_KEY="${MPI_SSH_KEY:-/root/.ssh/trtllm_ed25519}"
HF_OFFLINE="${HF_OFFLINE:-0}"
TIKTOKEN_RS_CACHE_DIR="${TIKTOKEN_RS_CACHE_DIR:-/tmp/harmony-reqs}"
TIKTOKEN_CACHE_DIR="${TIKTOKEN_CACHE_DIR:-/tmp/tiktoken-cache}"
TIKTOKEN_ENCODINGS_BASE="${TIKTOKEN_ENCODINGS_BASE:-/tmp/harmony-reqs}"
TORCH_CUDA_ARCH_LIST="${TORCH_CUDA_ARCH_LIST:-12.0}"
ROOT="${ROOT:-/home/admin/apps/LLMCommune}"
HOST_RUNTIME_ROOT="${HOST_RUNTIME_ROOT:-$ROOT/workspace/jobs/_lanes}"
HOST_SLOT_DIR="${HOST_RUNTIME_ROOT}/${SLOT_LABEL}"
HOST_LOG_PATH="${HOST_SLOT_DIR}/serve-${PORT}.log"
HOST_PID_PATH="${HOST_SLOT_DIR}/serve-${PORT}.pid"
HOST_STATUS_PATH="${HOST_SLOT_DIR}/status-${PORT}.log"
HOST_SLOT_META_PATH="${HOST_SLOT_DIR}/slot.json"
HOST_STARTUP_STATE_PATH="${HOST_SLOT_DIR}/startup-state-${PORT}.json"
HOST_ACTIVE_SLOT_PATH="${HOST_RUNTIME_ROOT}/active_slot.json"
CONTAINER_RUNTIME_ROOT="${CONTAINER_RUNTIME_ROOT:-/workspace_lanes}"
CONTAINER_SLOT_DIR="${CONTAINER_RUNTIME_ROOT}/${SLOT_LABEL}"
CONTAINER_LOG_PATH="${CONTAINER_SLOT_DIR}/serve-${PORT}.log"
CONTAINER_PID_PATH="${CONTAINER_SLOT_DIR}/serve-${PORT}.pid"
CONTAINER_STATUS_PATH="${CONTAINER_SLOT_DIR}/status-${PORT}.log"
SLOT_STARTED_AT="${SLOT_STARTED_AT:-}"
SLOT_READY_AT="${SLOT_READY_AT:-}"
STARTUP_DURATION_S="${STARTUP_DURATION_S:-}"
LAST_PHASE="${LAST_PHASE:-bootstrap}"
PRIMARY_CONTAINER_ID="${PRIMARY_CONTAINER_ID:-}"
WORKER_CONTAINER_ID="${WORKER_CONTAINER_ID:-}"
PERSISTENCE_VALIDATED_AT="${PERSISTENCE_VALIDATED_AT:-}"
POST_READY_GRACE_STARTED_AT="${POST_READY_GRACE_STARTED_AT:-}"
POST_READY_VALIDATED="${POST_READY_VALIDATED:-false}"
PERSISTENCE_VALIDATED="${PERSISTENCE_VALIDATED:-false}"
WORKER_SSH_READY_AT="${WORKER_SSH_READY_AT:-}"
API_READY_AT="${API_READY_AT:-}"
READY_PROBE_COUNT="${READY_PROBE_COUNT:-0}"
PERSISTENCE_PROBE_COUNT="${PERSISTENCE_PROBE_COUNT:-0}"
LAST_READY_PROBE_AT="${LAST_READY_PROBE_AT:-}"
LAST_PERSISTENCE_PROBE_AT="${LAST_PERSISTENCE_PROBE_AT:-}"
LAUNCH_SUBMITTED_AT="${LAUNCH_SUBMITTED_AT:-}"

remote() {
  # Worker TRT containers are ephemeral and can rotate SSH host keys; avoid wedging builder startup on stale known_hosts entries.
  ssh $WORKER_SSH_OPTS "$WORKER_SSH" "$@"
}

log() {
  printf '[trtllm] %s\n' "$*" >&2
}

record_status() {
  mkdir -p "$HOST_SLOT_DIR"
  printf '%s %s\n' "$(date -Is)" "$*" >>"$HOST_STATUS_PATH"
}

write_startup_state() {
  local status="$1"
  local detail="${2:-}"
  local startup_attempt="${3:-}"
  local last_error="${4:-}"
  local state_timestamp
  local error_timestamp=""
  local waiting_on=""
  local phase_group="unknown"
  local startup_elapsed_s=""
  local api_wait_elapsed_s=""
  local persistence_validation_elapsed_s=""
  state_timestamp="$(date -Is)"
  if [[ -n "${last_error// }" ]]; then
    error_timestamp="$state_timestamp"
  fi
  case "$status" in
    starting)
      waiting_on="worker_container"
      phase_group="bootstrap"
      ;;
    worker_container_started)
      waiting_on="primary_container"
      phase_group="container_start"
      ;;
    primary_container_started|worker_ssh_not_ready)
      waiting_on="worker_ssh"
      phase_group="worker_ssh_wait"
      ;;
    worker_ssh_ready|launch_submitted|api_wait|api_not_ready|process_died_after_bind)
      waiting_on="api_ready"
      phase_group="api_wait"
      ;;
    api_ready|post_ready_grace|post_ready_validation_failed)
      waiting_on="persistence_validation"
      phase_group="persistence_validation"
      ;;
    ready)
      waiting_on="none"
      phase_group="ready"
      ;;
    worker_container_start_failed|primary_container_start_failed|server_launch_failed)
      waiting_on="failed"
      phase_group="failed"
      ;;
    *)
      waiting_on=""
      phase_group="unknown"
      ;;
  esac
  if [[ -n "${SLOT_STARTED_AT// }" ]]; then
    startup_elapsed_s="$(python3 - "$SLOT_STARTED_AT" "$state_timestamp" <<'PY'
from datetime import datetime
import sys
start = datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00"))
end = datetime.fromisoformat(sys.argv[2].replace("Z", "+00:00"))
print(max(0.0, round((end - start).total_seconds(), 3)))
PY
)"
  fi
  if [[ -n "${LAUNCH_SUBMITTED_AT// }" ]]; then
    api_wait_elapsed_s="$(python3 - "$LAUNCH_SUBMITTED_AT" "$state_timestamp" <<'PY'
from datetime import datetime
import sys
start = datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00"))
end = datetime.fromisoformat(sys.argv[2].replace("Z", "+00:00"))
print(max(0.0, round((end - start).total_seconds(), 3)))
PY
)"
  fi
  if [[ -n "${POST_READY_GRACE_STARTED_AT// }" ]]; then
    persistence_validation_elapsed_s="$(python3 - "$POST_READY_GRACE_STARTED_AT" "$state_timestamp" <<'PY'
from datetime import datetime
import sys
start = datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00"))
end = datetime.fromisoformat(sys.argv[2].replace("Z", "+00:00"))
print(max(0.0, round((end - start).total_seconds(), 3)))
PY
)"
  fi
  mkdir -p "$HOST_SLOT_DIR"
  cat >"$HOST_STARTUP_STATE_PATH" <<EOF
{
  "slot_label": "$SLOT_LABEL",
  "port": $PORT,
  "status": "$status",
  "detail": $(printf '%s' "$detail" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
  "phase_group": $(printf '%s' "$phase_group" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "waiting_on": $(printf '%s' "$waiting_on" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "startup_attempt": $(printf '%s' "$startup_attempt" | python3 -c 'import json,sys; text=sys.stdin.read().strip(); print(json.dumps(int(text) if text.isdigit() else text))'),
  "last_error": $(printf '%s' "$last_error" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
  "last_phase": $(printf '%s' "$LAST_PHASE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "last_phase_at": $(printf '%s' "$state_timestamp" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "last_error_at": $(printf '%s' "$error_timestamp" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "started_at": $(printf '%s' "$SLOT_STARTED_AT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "ready_at": $(printf '%s' "$SLOT_READY_AT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "startup_duration_s": $(printf '%s' "$STARTUP_DURATION_S" | python3 -c 'import json,sys; text=sys.stdin.read().strip(); print(json.dumps(float(text) if text else None))'),
  "startup_elapsed_s": $(printf '%s' "$startup_elapsed_s" | python3 -c 'import json,sys; text=sys.stdin.read().strip(); print(json.dumps(float(text) if text else None))'),
  "api_wait_elapsed_s": $(printf '%s' "$api_wait_elapsed_s" | python3 -c 'import json,sys; text=sys.stdin.read().strip(); print(json.dumps(float(text) if text else None))'),
  "persistence_validation_elapsed_s": $(printf '%s' "$persistence_validation_elapsed_s" | python3 -c 'import json,sys; text=sys.stdin.read().strip(); print(json.dumps(float(text) if text else None))'),
  "api_ready_timeout_secs": $API_READY_TIMEOUT_SECS,
  "post_ready_grace_secs": $POST_READY_GRACE_SECS,
  "startup_retries": $STARTUP_RETRIES,
  "persistence_validated_at": $(printf '%s' "$PERSISTENCE_VALIDATED_AT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "post_ready_grace_started_at": $(printf '%s' "$POST_READY_GRACE_STARTED_AT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "post_ready_validated": $(printf '%s' "$POST_READY_VALIDATED" | python3 -c 'import json,sys; t=sys.stdin.read().strip().lower(); print(json.dumps(t in {"1","true","yes","on"}))'),
  "persistence_validated": $(printf '%s' "$PERSISTENCE_VALIDATED" | python3 -c 'import json,sys; t=sys.stdin.read().strip().lower(); print(json.dumps(t in {"1","true","yes","on"}))'),
  "worker_ssh_ready_at": $(printf '%s' "$WORKER_SSH_READY_AT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "api_ready_at": $(printf '%s' "$API_READY_AT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "ready_probe_count": $(printf '%s' "$READY_PROBE_COUNT" | python3 -c 'import json,sys; text=sys.stdin.read().strip(); print(json.dumps(int(text) if text.isdigit() else 0))'),
  "persistence_probe_count": $(printf '%s' "$PERSISTENCE_PROBE_COUNT" | python3 -c 'import json,sys; text=sys.stdin.read().strip(); print(json.dumps(int(text) if text.isdigit() else 0))'),
  "launch_submitted_at": $(printf '%s' "$LAUNCH_SUBMITTED_AT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "log_path": "$HOST_LOG_PATH",
  "status_path": "$HOST_STATUS_PATH",
  "pid_path": "$HOST_PID_PATH",
  "updated_at": "$state_timestamp"
}
EOF
}

write_slot_metadata() {
  local state="$1"
  local active="${2:-false}"
  local detail="${3:-}"
  local startup_attempt="${4:-}"
  local last_error="${5:-}"
  local state_timestamp
  local error_timestamp=""
  state_timestamp="$(date -Is)"
  if [[ -n "${last_error// }" ]]; then
    error_timestamp="$state_timestamp"
  fi
  mkdir -p "$HOST_SLOT_DIR"
  cat >"$HOST_SLOT_META_PATH" <<EOF
{
  "slot_label": "$SLOT_LABEL",
  "port": $PORT,
  "model_spec": "$MODEL_SPEC",
  "docker_image": "$DOCKER_IMAGE",
  "container_name": "$CONTAINER_NAME",
  "state": "$state",
  "active": $active,
  "startup_attempt": $(printf '%s' "$startup_attempt" | python3 -c 'import json,sys; text=sys.stdin.read().strip(); print(json.dumps(int(text) if text.isdigit() else text))'),
  "detail": $(printf '%s' "$detail" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
  "last_error": $(printf '%s' "$last_error" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
  "last_phase": $(printf '%s' "$LAST_PHASE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "last_phase_at": $(printf '%s' "$state_timestamp" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "last_error_at": $(printf '%s' "$error_timestamp" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "started_at": $(printf '%s' "$SLOT_STARTED_AT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "ready_at": $(printf '%s' "$SLOT_READY_AT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "startup_duration_s": $(printf '%s' "$STARTUP_DURATION_S" | python3 -c 'import json,sys; text=sys.stdin.read().strip(); print(json.dumps(float(text) if text else None))'),
  "api_ready_timeout_secs": $API_READY_TIMEOUT_SECS,
  "post_ready_grace_secs": $POST_READY_GRACE_SECS,
  "startup_retries": $STARTUP_RETRIES,
  "persistence_validated_at": $(printf '%s' "$PERSISTENCE_VALIDATED_AT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "post_ready_grace_started_at": $(printf '%s' "$POST_READY_GRACE_STARTED_AT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "post_ready_validated": $(printf '%s' "$POST_READY_VALIDATED" | python3 -c 'import json,sys; t=sys.stdin.read().strip().lower(); print(json.dumps(t in {"1","true","yes","on"}))'),
  "persistence_validated": $(printf '%s' "$PERSISTENCE_VALIDATED" | python3 -c 'import json,sys; t=sys.stdin.read().strip().lower(); print(json.dumps(t in {"1","true","yes","on"}))'),
  "worker_ssh_ready_at": $(printf '%s' "$WORKER_SSH_READY_AT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "api_ready_at": $(printf '%s' "$API_READY_AT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "ready_probe_count": $(printf '%s' "$READY_PROBE_COUNT" | python3 -c 'import json,sys; text=sys.stdin.read().strip(); print(json.dumps(int(text) if text.isdigit() else 0))'),
  "persistence_probe_count": $(printf '%s' "$PERSISTENCE_PROBE_COUNT" | python3 -c 'import json,sys; text=sys.stdin.read().strip(); print(json.dumps(int(text) if text.isdigit() else 0))'),
  "last_ready_probe_at": $(printf '%s' "$LAST_READY_PROBE_AT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "last_persistence_probe_at": $(printf '%s' "$LAST_PERSISTENCE_PROBE_AT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "launch_submitted_at": $(printf '%s' "$LAUNCH_SUBMITTED_AT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "primary_container_id": $(printf '%s' "$PRIMARY_CONTAINER_ID" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "worker_container_id": $(printf '%s' "$WORKER_CONTAINER_ID" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "log_path": "$HOST_LOG_PATH",
  "status_path": "$HOST_STATUS_PATH",
  "pid_path": "$HOST_PID_PATH",
  "startup_state_path": "$HOST_STARTUP_STATE_PATH",
  "updated_at": "$state_timestamp"
}
EOF
}

write_active_slot_metadata() {
  local state="$1"
  local slot_label_value="${2:-$SLOT_LABEL}"
  local detail="${3:-}"
  local startup_attempt="${4:-}"
  local last_error="${5:-}"
  local state_timestamp
  local error_timestamp=""
  state_timestamp="$(date -Is)"
  if [[ -n "${last_error// }" ]]; then
    error_timestamp="$state_timestamp"
  fi
  mkdir -p "$HOST_RUNTIME_ROOT"
  cat >"$HOST_ACTIVE_SLOT_PATH" <<EOF
{
  "slot_label": "$slot_label_value",
  "port": $PORT,
  "model_spec": "$MODEL_SPEC",
  "docker_image": "$DOCKER_IMAGE",
  "state": "$state",
  "startup_attempt": $(printf '%s' "$startup_attempt" | python3 -c 'import json,sys; text=sys.stdin.read().strip(); print(json.dumps(int(text) if text.isdigit() else text))'),
  "detail": $(printf '%s' "$detail" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
  "last_error": $(printf '%s' "$last_error" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
  "last_phase": $(printf '%s' "$LAST_PHASE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "last_phase_at": $(printf '%s' "$state_timestamp" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "last_error_at": $(printf '%s' "$error_timestamp" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "started_at": $(printf '%s' "$SLOT_STARTED_AT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "ready_at": $(printf '%s' "$SLOT_READY_AT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "startup_duration_s": $(printf '%s' "$STARTUP_DURATION_S" | python3 -c 'import json,sys; text=sys.stdin.read().strip(); print(json.dumps(float(text) if text else None))'),
  "api_ready_timeout_secs": $API_READY_TIMEOUT_SECS,
  "post_ready_grace_secs": $POST_READY_GRACE_SECS,
  "startup_retries": $STARTUP_RETRIES,
  "persistence_validated_at": $(printf '%s' "$PERSISTENCE_VALIDATED_AT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "post_ready_grace_started_at": $(printf '%s' "$POST_READY_GRACE_STARTED_AT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "post_ready_validated": $(printf '%s' "$POST_READY_VALIDATED" | python3 -c 'import json,sys; t=sys.stdin.read().strip().lower(); print(json.dumps(t in {"1","true","yes","on"}))'),
  "persistence_validated": $(printf '%s' "$PERSISTENCE_VALIDATED" | python3 -c 'import json,sys; t=sys.stdin.read().strip().lower(); print(json.dumps(t in {"1","true","yes","on"}))'),
  "worker_ssh_ready_at": $(printf '%s' "$WORKER_SSH_READY_AT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "api_ready_at": $(printf '%s' "$API_READY_AT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "ready_probe_count": $(printf '%s' "$READY_PROBE_COUNT" | python3 -c 'import json,sys; text=sys.stdin.read().strip(); print(json.dumps(int(text) if text.isdigit() else 0))'),
  "persistence_probe_count": $(printf '%s' "$PERSISTENCE_PROBE_COUNT" | python3 -c 'import json,sys; text=sys.stdin.read().strip(); print(json.dumps(int(text) if text.isdigit() else 0))'),
  "last_ready_probe_at": $(printf '%s' "$LAST_READY_PROBE_AT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "last_persistence_probe_at": $(printf '%s' "$LAST_PERSISTENCE_PROBE_AT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "launch_submitted_at": $(printf '%s' "$LAUNCH_SUBMITTED_AT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "primary_container_id": $(printf '%s' "$PRIMARY_CONTAINER_ID" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "worker_container_id": $(printf '%s' "$WORKER_CONTAINER_ID" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
  "log_path": "$HOST_LOG_PATH",
  "status_path": "$HOST_STATUS_PATH",
  "startup_state_path": "$HOST_STARTUP_STATE_PATH",
  "updated_at": "$state_timestamp"
}
EOF
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

mark_slot_active() {
  write_slot_metadata "ready" true "api responsive and process alive"
  write_active_slot_metadata "ready" "$SLOT_LABEL" "api responsive and process alive"
  mark_other_slots_inactive
}

run_local_with_timeout() {
  local timeout_secs="$1"
  shift
  timeout "${timeout_secs}" "$@"
}

run_remote_with_timeout() {
  local timeout_secs="$1"
  shift
  remote "timeout ${timeout_secs} $*"
}

docker_image_present_local() {
  docker image inspect "$DOCKER_IMAGE" >/dev/null 2>&1
}

docker_image_present_remote() {
  remote "docker image inspect '$DOCKER_IMAGE' >/dev/null 2>&1"
}

ensure_local_image() {
  if [[ "$FORCE_DOCKER_PULL" == "1" ]]; then
    log "force-pulling local image $DOCKER_IMAGE"
    run_local_with_timeout "$DOCKER_PULL_TIMEOUT_SECS" docker pull "$DOCKER_IMAGE" >/dev/null
    return
  fi
  if docker_image_present_local; then
    log "using cached local image $DOCKER_IMAGE"
    return
  fi
  log "local image missing; pulling $DOCKER_IMAGE"
  run_local_with_timeout "$DOCKER_PULL_TIMEOUT_SECS" docker pull "$DOCKER_IMAGE" >/dev/null
}

ensure_remote_image() {
  if [[ "$FORCE_DOCKER_PULL" == "1" ]]; then
    log "force-pulling remote image $DOCKER_IMAGE"
    run_remote_with_timeout "$DOCKER_PULL_TIMEOUT_SECS" docker pull "'$DOCKER_IMAGE'" >/dev/null
    return
  fi
  if docker_image_present_remote; then
    log "using cached remote image $DOCKER_IMAGE"
    return
  fi
  log "remote image missing; pulling $DOCKER_IMAGE"
  run_remote_with_timeout "$DOCKER_PULL_TIMEOUT_SECS" docker pull "'$DOCKER_IMAGE'" >/dev/null
}

write_hostfile() {
  cat >"$HOSTFILE_PATH" <<EOF
$PRIMARY_LINK_IP
$WORKER_LINK_IP
EOF
}

start_container_here() {
  mkdir -p "$HOST_SLOT_DIR"
  docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
  ensure_local_image
  docker run -d --rm \
    --name "$CONTAINER_NAME" \
    --gpus '"device=all"' \
    --network host \
    --ulimit memlock=-1 \
    --ulimit stack=67108864 \
    --device /dev/infiniband:/dev/infiniband \
    -e UCX_NET_DEVICES="$UCX_NET_DEVICES" \
    -e NCCL_SOCKET_IFNAME="$UCX_NET_DEVICES" \
    -e NCCL_IB_HCA="$NCCL_IB_HCA" \
    -e NCCL_IB_DISABLE="$NCCL_IB_DISABLE" \
    -e NCCL_DEBUG="$NCCL_DEBUG" \
    -e OMPI_MCA_btl_tcp_if_include="$UCX_NET_DEVICES" \
    -e OMPI_MCA_orte_default_hostfile="/etc/openmpi-hostfile" \
    -e OMPI_MCA_rmaps_ppr_n_pernode="1" \
    -e OMPI_ALLOW_RUN_AS_ROOT="1" \
    -e OMPI_ALLOW_RUN_AS_ROOT_CONFIRM="1" \
    -e TIKTOKEN_RS_CACHE_DIR="$TIKTOKEN_RS_CACHE_DIR" \
    -e TIKTOKEN_CACHE_DIR="$TIKTOKEN_CACHE_DIR" \
    -e TIKTOKEN_ENCODINGS_BASE="$TIKTOKEN_ENCODINGS_BASE" \
    -v "$HOME/.cache/huggingface:/root/.cache/huggingface" \
    -v "$HOME/.cache/torch_extensions:/root/.cache/torch_extensions" \
    -v "$HOME/.cache/flashinfer:/root/.cache/flashinfer" \
    -v "$HOME/.ssh:/tmp/.ssh:ro" \
    -v "$HOST_RUNTIME_ROOT:$CONTAINER_RUNTIME_ROOT" \
    -v /mnt/models:/mnt/models \
    "$DOCKER_IMAGE" \
    sh -c "curl -fsSL https://raw.githubusercontent.com/NVIDIA/dgx-spark-playbooks/refs/heads/main/nvidia/trt-llm/assets/trtllm-mn-entrypoint.sh | sh"
}

start_container_remote() {
  remote "mkdir -p '$HOST_SLOT_DIR'"
  remote "docker stop '$CONTAINER_NAME' >/dev/null 2>&1 || true"
  ensure_remote_image
  run_remote_with_timeout "$CONTAINER_BOOT_TIMEOUT_SECS" docker run "-d --rm \
    --name '$CONTAINER_NAME' \
    --gpus '\"device=all\"' \
    --network host \
    --ulimit memlock=-1 \
    --ulimit stack=67108864 \
    --device /dev/infiniband:/dev/infiniband \
    -e UCX_NET_DEVICES='$UCX_NET_DEVICES' \
    -e NCCL_SOCKET_IFNAME='$UCX_NET_DEVICES' \
    -e NCCL_IB_HCA='$NCCL_IB_HCA' \
    -e NCCL_IB_DISABLE='$NCCL_IB_DISABLE' \
    -e NCCL_DEBUG='$NCCL_DEBUG' \
    -e OMPI_MCA_btl_tcp_if_include='$UCX_NET_DEVICES' \
    -e OMPI_MCA_orte_default_hostfile='/etc/openmpi-hostfile' \
    -e OMPI_MCA_rmaps_ppr_n_pernode='1' \
    -e OMPI_ALLOW_RUN_AS_ROOT='1' \
    -e OMPI_ALLOW_RUN_AS_ROOT_CONFIRM='1' \
    -e TIKTOKEN_RS_CACHE_DIR='$TIKTOKEN_RS_CACHE_DIR' \
    -e TIKTOKEN_CACHE_DIR='$TIKTOKEN_CACHE_DIR' \
    -e TIKTOKEN_ENCODINGS_BASE='$TIKTOKEN_ENCODINGS_BASE' \
    -v /home/admin/.cache/huggingface:/root/.cache/huggingface \
    -v /home/admin/.cache/torch_extensions:/root/.cache/torch_extensions \
    -v /home/admin/.cache/flashinfer:/root/.cache/flashinfer \
    -v /home/admin/.ssh:/tmp/.ssh:ro \
    -v '$HOST_RUNTIME_ROOT:$CONTAINER_RUNTIME_ROOT' \
    -v /mnt/models:/mnt/models \
    '$DOCKER_IMAGE' \
    sh -c 'curl -fsSL https://raw.githubusercontent.com/NVIDIA/dgx-spark-playbooks/refs/heads/main/nvidia/trt-llm/assets/trtllm-mn-entrypoint.sh | sh'"
}

stop_container_here() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}

stop_container_remote() {
  remote "docker rm -f '$CONTAINER_NAME' >/dev/null 2>&1 || true" || true
}

prepare_container() {
  docker cp "$HOSTFILE_PATH" "$CONTAINER_NAME:/etc/openmpi-hostfile"
  docker exec "$CONTAINER_NAME" bash -lc "mkdir -p '$CONTAINER_SLOT_DIR'"
  docker exec "$CONTAINER_NAME" bash -lc "mkdir -p /root/.ssh && cp -f /tmp/.ssh/trtllm_ed25519 /root/.ssh/trtllm_ed25519 && cp -f /tmp/.ssh/trtllm_ed25519.pub /root/.ssh/trtllm_ed25519.pub && cp -f /tmp/.ssh/known_hosts /root/.ssh/known_hosts 2>/dev/null || true && chmod 700 /root/.ssh && chmod 600 /root/.ssh/trtllm_ed25519 /root/.ssh/known_hosts 2>/dev/null || true && chmod 644 /root/.ssh/trtllm_ed25519.pub 2>/dev/null || true"
  docker exec "$CONTAINER_NAME" bash -lc "cat >/tmp/extra-llm-api-config.yml <<EOF
print_iter_log: false
kv_cache_config:
  dtype: \"auto\"
  free_gpu_memory_fraction: $FREE_GPU_MEMORY_FRACTION
cuda_graph_config:
  enable_padding: true
EOF"
  if [[ -n "$EXTRA_SETUP_SCRIPT" ]]; then
    docker exec "$CONTAINER_NAME" bash -lc "$EXTRA_SETUP_SCRIPT"
  fi
}

wait_for_worker_ssh() {
  local attempt
  for attempt in $(seq 1 60); do
    if docker exec "$CONTAINER_NAME" bash -lc "python3 -c \"import socket; s=socket.socket(); rc=s.connect_ex(('${WORKER_LINK_IP}',2233)); s.close(); raise SystemExit(0 if rc == 0 else 1)\"" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

launch_server() {
  docker exec "$CONTAINER_NAME" bash -lc "cat >/tmp/start-trtllm-$PORT.sh <<'EOF'
#!/bin/bash
set -euo pipefail
export HF_HOME=/root/.cache/huggingface
export CPATH=/usr/local/cuda/include:\${CPATH:-}
export C_INCLUDE_PATH=/usr/local/cuda/include:\${C_INCLUDE_PATH:-}
export CPLUS_INCLUDE_PATH=/usr/local/cuda/include:\${CPLUS_INCLUDE_PATH:-}
export CUDA_HOME=/usr/local/cuda
export TRITON_PTXAS_PATH=/usr/local/cuda/bin/ptxas
export PATH=/usr/local/cuda/bin:\${PATH:-}
export TIKTOKEN_RS_CACHE_DIR='$TIKTOKEN_RS_CACHE_DIR'
export TIKTOKEN_CACHE_DIR='$TIKTOKEN_CACHE_DIR'
export TIKTOKEN_ENCODINGS_BASE='$TIKTOKEN_ENCODINGS_BASE'
export TORCH_CUDA_ARCH_LIST='$TORCH_CUDA_ARCH_LIST'
MAX_SEQ_LEN_VALUE='${MAX_SEQ_LEN}'
MAX_SEQ_ARGS=()
if [[ -n "\$MAX_SEQ_LEN_VALUE" ]]; then
  MAX_SEQ_ARGS+=(--max_seq_len "\$MAX_SEQ_LEN_VALUE")
fi
if [[ \"$HF_OFFLINE\" == \"1\" ]]; then
  export HF_HUB_OFFLINE=1
  export TRANSFORMERS_OFFLINE=1
fi
exec mpirun \
  --hostfile /etc/openmpi-hostfile \
  -mca plm_rsh_agent 'ssh -p 2233 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes -i $MPI_SSH_KEY' \
  -x HF_HOME \
  -x HF_HUB_OFFLINE \
  -x TRANSFORMERS_OFFLINE \
  -x CPATH \
  -x C_INCLUDE_PATH \
  -x CPLUS_INCLUDE_PATH \
  -x CUDA_HOME \
  -x TRITON_PTXAS_PATH \
  -x PATH \
  -x TIKTOKEN_RS_CACHE_DIR \
  -x TIKTOKEN_CACHE_DIR \
  -x TIKTOKEN_ENCODINGS_BASE \
  -x TORCH_CUDA_ARCH_LIST \
  -x NCCL_IB_DISABLE \
  -x NCCL_SOCKET_IFNAME \
  -x NCCL_IB_HCA \
  -x NCCL_DEBUG \
  trtllm-llmapi-launch trtllm-serve '$MODEL_SPEC' \
    --host '$TRTLLM_HOST' \
    --tp_size 2 \
    --backend pytorch \
    --max_num_tokens $MAX_NUM_TOKENS \
    "\${MAX_SEQ_ARGS[@]}" \
    --max_batch_size $MAX_BATCH_SIZE \
    --extra_llm_api_options /tmp/extra-llm-api-config.yml \
    --port $PORT
EOF
chmod +x /tmp/start-trtllm-$PORT.sh"
  docker exec "$CONTAINER_NAME" bash -lc "pkill -9 -f '^mpirun .*--port $PORT' >/dev/null 2>&1 || true"
  docker exec "$CONTAINER_NAME" bash -lc "pkill -9 -f '^/bin/bash /usr/local/bin/trtllm-llmapi-launch .*--port $PORT' >/dev/null 2>&1 || true"
  docker exec "$CONTAINER_NAME" bash -lc "mkdir -p '$CONTAINER_SLOT_DIR' && rm -f '$CONTAINER_LOG_PATH' '$CONTAINER_PID_PATH'"
  record_status "launch_requested port=$PORT slot=$SLOT_LABEL model=$MODEL_SPEC"
  docker exec -d "$CONTAINER_NAME" bash -lc "echo \$\$ >'$CONTAINER_PID_PATH'; printf '%s launch_started\n' \"\$(date -Is)\" >>'$CONTAINER_STATUS_PATH'; exec /tmp/start-trtllm-$PORT.sh >'$CONTAINER_LOG_PATH' 2>&1 < /dev/null"
  local attempt
  for attempt in $(seq 1 20); do
    if docker exec "$CONTAINER_NAME" bash -lc "kill -0 \$(cat '$CONTAINER_PID_PATH') >/dev/null 2>&1 || pgrep -f '^mpirun .*--port $PORT' >/dev/null"; then
      record_status "launch_submitted port=$PORT slot=$SLOT_LABEL"
      return 0
    fi
    sleep 1
  done
  record_status "launch_failed_to_stick port=$PORT slot=$SLOT_LABEL"
  return 1
}

assert_server_process_alive() {
  if docker exec "$CONTAINER_NAME" bash -lc "kill -0 \$(cat '$CONTAINER_PID_PATH') >/dev/null 2>&1 || pgrep -f '^mpirun .*--port $PORT' >/dev/null"; then
    return 0
  fi
  record_status "server_process_missing port=$PORT slot=$SLOT_LABEL"
  return 1
}

validate_persistent_ready_state() {
  local grace_secs="$POST_READY_GRACE_SECS"
  if [[ "$grace_secs" -lt 1 ]]; then
    grace_secs=1
  fi
  POST_READY_GRACE_STARTED_AT="$(date -Is)"
  PERSISTENCE_PROBE_COUNT="$((PERSISTENCE_PROBE_COUNT + 1))"
  LAST_PERSISTENCE_PROBE_AT="$POST_READY_GRACE_STARTED_AT"
  record_status "post_ready_grace_begin port=$PORT slot=$SLOT_LABEL grace=${grace_secs}s"
  write_startup_state "post_ready_grace" "waiting for persistent ready state through grace window"
  sleep "$grace_secs"
  if ! assert_server_process_alive; then
    record_status "post_ready_process_missing port=$PORT slot=$SLOT_LABEL grace=${grace_secs}s"
    return 1
  fi
  if ! curl -fsS "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1; then
    record_status "post_ready_api_missing port=$PORT slot=$SLOT_LABEL grace=${grace_secs}s"
    return 1
  fi
  PERSISTENCE_VALIDATED_AT="$(date -Is)"
  POST_READY_VALIDATED="true"
  PERSISTENCE_VALIDATED="true"
  record_status "post_ready_grace_passed port=$PORT slot=$SLOT_LABEL grace=${grace_secs}s"
  return 0
}

wait_for_api() {
  local startup_attempt="${1:-}"
  local attempt
  local max_attempts=$(( API_READY_TIMEOUT_SECS / 5 ))
  if [[ "$max_attempts" -lt 1 ]]; then
    max_attempts=1
  fi
  for attempt in $(seq 1 "$max_attempts"); do
    READY_PROBE_COUNT="$attempt"
    LAST_READY_PROBE_AT="$(date -Is)"
    write_startup_state "api_wait" "waiting for API readiness probe ${attempt}/${max_attempts}" "$startup_attempt"
    write_slot_metadata "api_wait" false "waiting for API readiness probe ${attempt}/${max_attempts}" "$startup_attempt"
    write_active_slot_metadata "api_wait" "$SLOT_LABEL" "waiting for API readiness probe ${attempt}/${max_attempts}" "$startup_attempt"
    if curl -fsS "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1; then
      record_status "api_ready port=$PORT slot=$SLOT_LABEL"
      API_READY_AT="$(date -Is)"
      return 0
    fi
    sleep 5
  done
  record_status "api_ready_timeout port=$PORT slot=$SLOT_LABEL"
  return 1
}

complete_startup_after_launch() {
  local startup_attempt="${1:-}"
  LAST_PHASE="api_wait"
  if wait_for_api "$startup_attempt"; then
    sleep 5
    LAST_PHASE="process_liveness_check"
    if ! assert_server_process_alive; then
      log "API answered but server process is no longer alive on :$PORT"
      write_startup_state "process_died_after_bind" "api answered but serve process exited" "$startup_attempt" "process_died_after_bind"
      write_slot_metadata "process_died_after_bind" false "api answered but serve process exited" "$startup_attempt" "process_died_after_bind"
      write_active_slot_metadata "process_died_after_bind" "$SLOT_LABEL" "api answered but serve process exited" "$startup_attempt" "process_died_after_bind"
      show_status
      return 1
    fi
    SLOT_READY_AT="$(date -Is)"
    STARTUP_DURATION_S="$(python3 - "$SLOT_STARTED_AT" "$SLOT_READY_AT" <<'PY'
from datetime import datetime
import sys
start = datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00"))
end = datetime.fromisoformat(sys.argv[2].replace("Z", "+00:00"))
print(max(0.0, round((end - start).total_seconds(), 3)))
PY
)"
    write_startup_state "api_ready" "api responsive; validating persistence" "$startup_attempt"
    write_slot_metadata "api_ready" false "api responsive; validating persistence" "$startup_attempt"
    write_active_slot_metadata "api_ready" "$SLOT_LABEL" "api responsive; validating persistence" "$startup_attempt"
    LAST_PHASE="post_ready_grace"
    if ! validate_persistent_ready_state; then
      log "API answered but persistent-ready validation failed on :$PORT"
      write_startup_state "post_ready_validation_failed" "api answered but did not stay healthy through grace window" "$startup_attempt" "post_ready_validation_failed"
      write_slot_metadata "post_ready_validation_failed" false "api answered but did not stay healthy through grace window" "$startup_attempt" "post_ready_validation_failed"
      write_active_slot_metadata "post_ready_validation_failed" "$SLOT_LABEL" "api answered but did not stay healthy through grace window" "$startup_attempt" "post_ready_validation_failed"
      show_status
      return 1
    fi
    LAST_PHASE="ready"
    log "API is ready on :$PORT"
    record_status "startup_complete port=$PORT slot=$SLOT_LABEL persistence_validated_at=$PERSISTENCE_VALIDATED_AT"
    write_startup_state "ready" "api responsive and process alive through persistence validation" "$startup_attempt"
    mark_slot_active
    curl -fsS "http://127.0.0.1:$PORT/v1/models" || true
    return 0
  fi

  log "API did not become ready on attempt $startup_attempt"
  record_status "api_not_ready attempt=$startup_attempt"
  write_startup_state "api_not_ready" "api did not become ready on attempt $startup_attempt" "$startup_attempt" "api_not_ready"
  write_slot_metadata "api_not_ready" false "api did not become ready on attempt $startup_attempt" "$startup_attempt" "api_not_ready"
  write_active_slot_metadata "api_not_ready" "$SLOT_LABEL" "api did not become ready on attempt $startup_attempt" "$startup_attempt" "api_not_ready"
  show_status
  return 1
}

show_status() {
  docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | grep "$CONTAINER_NAME" || true
  remote "docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | grep '$CONTAINER_NAME' || true"
  if [[ -f "$HOST_STATUS_PATH" ]]; then
    tail -n 40 "$HOST_STATUS_PATH" || true
  fi
  if [[ -f "$HOST_LOG_PATH" ]]; then
    tail -n 120 "$HOST_LOG_PATH" || true
  else
    docker exec "$CONTAINER_NAME" bash -lc "tail -n 120 '$CONTAINER_LOG_PATH'" || true
  fi
}

write_hostfile
attempt=1
while [[ "$attempt" -le "$STARTUP_RETRIES" ]]; do
  SLOT_STARTED_AT="$(date -Is)"
  SLOT_READY_AT=""
  STARTUP_DURATION_S=""
  LAST_PHASE="startup_attempt"
  PRIMARY_CONTAINER_ID=""
  WORKER_CONTAINER_ID=""
  PERSISTENCE_VALIDATED_AT=""
  POST_READY_GRACE_STARTED_AT=""
  POST_READY_VALIDATED="false"
  PERSISTENCE_VALIDATED="false"
  WORKER_SSH_READY_AT=""
  API_READY_AT=""
  READY_PROBE_COUNT="0"
  PERSISTENCE_PROBE_COUNT="0"
  LAST_READY_PROBE_AT=""
  LAST_PERSISTENCE_PROBE_AT=""
  LAUNCH_SUBMITTED_AT=""
  log "startup attempt $attempt/$STARTUP_RETRIES"
  record_status "startup_attempt=$attempt retries=$STARTUP_RETRIES slot=$SLOT_LABEL port=$PORT"
  write_startup_state "starting" "startup attempt $attempt/$STARTUP_RETRIES" "$attempt"
  write_slot_metadata "starting" false "startup attempt $attempt/$STARTUP_RETRIES" "$attempt"
  write_active_slot_metadata "starting" "$SLOT_LABEL" "startup attempt $attempt/$STARTUP_RETRIES" "$attempt"
  stop_container_here
  stop_container_remote
  sleep 5
  LAST_PHASE="worker_container_start"
  log "starting worker container on $WORKER_SSH"
  if ! WORKER_CONTAINER_ID="$(start_container_remote)"; then
    log "worker container start failed on attempt $attempt"
    record_status "worker_container_start_failed attempt=$attempt"
    write_startup_state "worker_container_start_failed" "worker container failed on attempt $attempt" "$attempt" "worker_container_start_failed"
    write_slot_metadata "worker_container_start_failed" false "worker container failed on attempt $attempt" "$attempt" "worker_container_start_failed"
    write_active_slot_metadata "worker_container_start_failed" "$SLOT_LABEL" "worker container failed on attempt $attempt" "$attempt" "worker_container_start_failed"
    show_status
    if [[ "$attempt" -ge "$STARTUP_RETRIES" ]]; then
      exit 1
    fi
    sleep "$RETRY_BACKOFF_SECS"
    attempt=$((attempt + 1))
    continue
  fi
  record_status "worker_container_started attempt=$attempt container_id=$WORKER_CONTAINER_ID"
  write_startup_state "worker_container_started" "worker container started on attempt $attempt" "$attempt"
  write_slot_metadata "worker_container_started" false "worker container started on attempt $attempt" "$attempt"
  write_active_slot_metadata "worker_container_started" "$SLOT_LABEL" "worker container started on attempt $attempt" "$attempt"
  LAST_PHASE="primary_container_start"
  log "starting primary container on $(hostname)"
  if ! PRIMARY_CONTAINER_ID="$(start_container_here)"; then
    log "primary container start failed on attempt $attempt"
    record_status "primary_container_start_failed attempt=$attempt"
    write_startup_state "primary_container_start_failed" "primary container failed on attempt $attempt" "$attempt" "primary_container_start_failed"
    write_slot_metadata "primary_container_start_failed" false "primary container failed on attempt $attempt" "$attempt" "primary_container_start_failed"
    write_active_slot_metadata "primary_container_start_failed" "$SLOT_LABEL" "primary container failed on attempt $attempt" "$attempt" "primary_container_start_failed"
    show_status
    if [[ "$attempt" -ge "$STARTUP_RETRIES" ]]; then
      exit 1
    fi
    sleep "$RETRY_BACKOFF_SECS"
    attempt=$((attempt + 1))
    continue
  fi
  record_status "primary_container_started attempt=$attempt container_id=$PRIMARY_CONTAINER_ID"
  write_startup_state "primary_container_started" "primary container started on attempt $attempt" "$attempt"
  write_slot_metadata "primary_container_started" false "primary container started on attempt $attempt" "$attempt"
  write_active_slot_metadata "primary_container_started" "$SLOT_LABEL" "primary container started on attempt $attempt" "$attempt"
  LAST_PHASE="container_prepare"
  log "preparing primary container"
  prepare_container
  LAST_PHASE="worker_ssh_wait"
  log "waiting for worker SSH on ${WORKER_LINK_IP}:2233"
  if ! wait_for_worker_ssh; then
    log "worker SSH on ${WORKER_LINK_IP}:2233 did not become ready"
    record_status "worker_ssh_not_ready attempt=$attempt"
    write_startup_state "worker_ssh_not_ready" "worker ssh not ready on ${WORKER_LINK_IP}:2233" "$attempt" "worker_ssh_not_ready"
    write_slot_metadata "worker_ssh_not_ready" false "worker ssh not ready on ${WORKER_LINK_IP}:2233" "$attempt" "worker_ssh_not_ready"
    write_active_slot_metadata "worker_ssh_not_ready" "$SLOT_LABEL" "worker ssh not ready on ${WORKER_LINK_IP}:2233" "$attempt" "worker_ssh_not_ready"
    show_status
    if [[ "$attempt" -ge "$STARTUP_RETRIES" ]]; then
      exit 1
    fi
    sleep "$RETRY_BACKOFF_SECS"
    attempt=$((attempt + 1))
    continue
  fi
  WORKER_SSH_READY_AT="$(date -Is)"
  write_startup_state "worker_ssh_ready" "worker ssh ready; launching server" "$attempt"
  write_slot_metadata "worker_ssh_ready" false "worker ssh ready; launching server" "$attempt"
  write_active_slot_metadata "worker_ssh_ready" "$SLOT_LABEL" "worker ssh ready; launching server" "$attempt"
  LAST_PHASE="server_launch"
  log "launching model: $MODEL_SPEC"
  if ! launch_server; then
    log "server process did not stay alive on attempt $attempt"
    record_status "server_launch_failed attempt=$attempt"
    write_startup_state "server_launch_failed" "server process did not stay alive on attempt $attempt" "$attempt" "server_launch_failed"
    write_slot_metadata "server_launch_failed" false "server process did not stay alive on attempt $attempt" "$attempt" "server_launch_failed"
    write_active_slot_metadata "server_launch_failed" "$SLOT_LABEL" "server process did not stay alive on attempt $attempt" "$attempt" "server_launch_failed"
    show_status
    if [[ "$attempt" -ge "$STARTUP_RETRIES" ]]; then
      exit 1
    fi
    sleep "$RETRY_BACKOFF_SECS"
    attempt=$((attempt + 1))
    continue
  fi
  LAUNCH_SUBMITTED_AT="$(date -Is)"
  LAST_PHASE="launch_submitted"
  write_startup_state "launch_submitted" "launch submitted; waiting for API readiness" "$attempt"
  write_slot_metadata "launch_submitted" false "launch submitted; waiting for API readiness" "$attempt"
  write_active_slot_metadata "launch_submitted" "$SLOT_LABEL" "launch submitted; waiting for API readiness" "$attempt"
  if [[ "$SKIP_API_WAIT" == "1" ]]; then
    log "launch submitted for :$PORT; skipping in-script API wait"
    record_status "skip_api_wait port=$PORT slot=$SLOT_LABEL"
    write_startup_state "launch_submitted" "launch submitted; skipping API wait" "$attempt"
    write_slot_metadata "launch_submitted" false "launch submitted; skipping API wait" "$attempt"
    write_active_slot_metadata "launch_submitted" "$SLOT_LABEL" "launch submitted; skipping API wait" "$attempt"
    (
      complete_startup_after_launch "$attempt"
    ) >/dev/null 2>&1 &
    exit 0
  fi
  log "waiting for API on :$PORT"
  if complete_startup_after_launch "$attempt"; then
    exit 0
  fi
  if [[ "$attempt" -ge "$STARTUP_RETRIES" ]]; then
    exit 1
  fi
  sleep "$RETRY_BACKOFF_SECS"
  attempt=$((attempt + 1))
done
