#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/admin/apps/LLMCommune"
PORT="${LLMCOMMUNE_LARGE_PORT:-8000}"
TRT_PORT="${LLMCOMMUNE_TRT_PORT:-2233}"
WORKER_SSH="${WORKER_SSH:-admin@192.168.1.204}"
WORKER_SSH_OPTS="${WORKER_SSH_OPTS:--o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i /home/admin/.ssh/trtllm_ed25519}"
DRAIN_TIMEOUT_S="${LLMCOMMUNE_LARGE_DRAIN_TIMEOUT_S:-180}"
LOCAL_IDLE_GPU_MEMORY_MIB="${LLMCOMMUNE_LOCAL_IDLE_GPU_MEMORY_MIB:-2048}"
WORKER_IDLE_GPU_MEMORY_MIB="${LLMCOMMUNE_WORKER_IDLE_GPU_MEMORY_MIB:-2048}"

managed_containers=(
  llm-shared
  coder-main-8000
  vllm
  trtllm-multinode
)

kill_patterns=(
  'run_dual_spark_trtllm_'
  "^mpirun .*--port ${PORT}"
  "trtllm-serve .*--port ${PORT}"
  '/opt/hpcx/ompi/bin/orted'
  'trtllm-mn-entrypoint'
  'trtllm-mn-entrypoint.sh'
  'llama-server'
)

listener_pids() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null | sort -u
    return 0
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -Hlnpt "sport = :${port}" 2>/dev/null | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' | sort -u
    return 0
  fi
  return 0
}

published_container_ids() {
  local port="$1"
  docker ps -a --filter "publish=${port}" --format '{{.ID}}'
}

kill_listener_pids() {
  local port="$1"
  while IFS= read -r pid; do
    [[ -n "${pid}" ]] || continue
    kill -9 "${pid}" >/dev/null 2>&1 || true
  done < <(listener_pids "${port}")
}

kill_matches() {
  local pattern="$1"
  while IFS= read -r pid; do
    [[ -n "${pid}" ]] || continue
    [[ "${pid}" == "$$" || "${pid}" == "$PPID" ]] && continue
    kill -9 "${pid}" >/dev/null 2>&1 || true
  done < <(pgrep -f -- "${pattern}" || true)
}

remove_managed_containers() {
  local port
  for name in "${managed_containers[@]}"; do
    docker rm -f "${name}" >/dev/null 2>&1 || true
  done
  for port in "${PORT}" "${TRT_PORT}"; do
    while IFS= read -r stale_id; do
      [[ -n "${stale_id}" ]] || continue
      docker rm -f "${stale_id}" >/dev/null 2>&1 || true
    done < <(published_container_ids "${port}")
  done
}

gpu_compute_pid_count() {
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    echo 0
    return 0
  fi
  nvidia-smi --query-compute-apps=pid --format=csv,noheader,nounits 2>/dev/null | awk 'NF { count += 1 } END { print count + 0 }'
}

max_gpu_memory_mib() {
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    echo 0
    return 0
  fi
  nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | awk '
    BEGIN { max = 0 }
    NF {
      value = $1 + 0
      if (value > max) max = value
    }
    END { print max + 0 }
  '
}

processes_alive() {
  local pattern
  for pattern in "${kill_patterns[@]}"; do
    if pgrep -f -- "${pattern}" >/dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}

clear_state() {
  ! published_container_ids "${PORT}" | grep -q . \
    && ! published_container_ids "${TRT_PORT}" | grep -q . \
    && ! listener_pids "${PORT}" | grep -q . \
    && ! listener_pids "${TRT_PORT}" | grep -q . \
    && ! processes_alive \
    && [[ "$(gpu_compute_pid_count)" == "0" ]] \
    && [[ "$(max_gpu_memory_mib)" -le "${1}" ]]
}

print_state() {
  local label="$1"
  local idle_threshold="$2"
  echo "[debug] ${label} port ${PORT} listeners: $(listener_pids "${PORT}" | tr '\n' ' ' || true)" >&2
  echo "[debug] ${label} port ${TRT_PORT} listeners: $(listener_pids "${TRT_PORT}" | tr '\n' ' ' || true)" >&2
  echo "[debug] ${label} published ${PORT}: $(published_container_ids "${PORT}" | tr '\n' ' ' || true)" >&2
  echo "[debug] ${label} published ${TRT_PORT}: $(published_container_ids "${TRT_PORT}" | tr '\n' ' ' || true)" >&2
  echo "[debug] ${label} gpu_compute_pids: $(gpu_compute_pid_count)" >&2
  echo "[debug] ${label} max_gpu_memory_mib: $(max_gpu_memory_mib) (threshold ${idle_threshold})" >&2
}

reason_codes_json() {
  local idle_threshold="$1"
  local -a codes=()
  if published_container_ids "${PORT}" | grep -q .; then codes+=("published_container_present"); fi
  if published_container_ids "${TRT_PORT}" | grep -q .; then codes+=("trt_published_container_present"); fi
  if listener_pids "${PORT}" | grep -q .; then codes+=("port_listener_present"); fi
  if listener_pids "${TRT_PORT}" | grep -q .; then codes+=("trt_listener_present"); fi
  if processes_alive; then codes+=("launcher_process_present"); fi
  if [[ "$(gpu_compute_pid_count)" != "0" ]]; then codes+=("gpu_compute_busy"); fi
  if [[ "$(max_gpu_memory_mib)" -gt "${idle_threshold}" ]]; then codes+=("gpu_memory_above_idle"); fi
  printf '%s\n' "${codes[@]}" | python3 -c 'import json,sys; print(json.dumps([line.strip() for line in sys.stdin if line.strip()]))'
}

emit_drain_state() {
  local label="$1"
  local idle_threshold="$2"
  local clear=false
  local reason_codes
  if clear_state "${idle_threshold}"; then clear=true; fi
  reason_codes="$(reason_codes_json "${idle_threshold}")"
  printf '{"label":%s,"clear":%s,"reason_codes":%s,"gpu_compute_pid_count":%s,"max_gpu_memory_mib":%s}' \
    "$(printf '%s' "${label}" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')" \
    "${clear}" \
    "${reason_codes}" \
    "$(gpu_compute_pid_count)" \
    "$(max_gpu_memory_mib)"
}

fallback_drain_state() {
  local label="$1"
  local reason_code="$2"
  printf '{"label":%s,"clear":false,"reason_codes":[%s]}' \
    "$(printf '%s' "${label}" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')" \
    "$(printf '%s' "${reason_code}" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')"
}

emit_drain_proof() {
  local status="$1"
  local local_state="$2"
  local worker_state="$3"
  printf 'LLMCOMMUNE_DRAIN_PROOF={"status":%s,"timeout_s":%s,"local":%s,"worker":%s}\n' \
    "$(printf '%s' "${status}" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')" \
    "${DRAIN_TIMEOUT_S}" \
    "${local_state}" \
    "${worker_state}"
}

wait_for_clear_state() {
  local label="$1"
  local idle_threshold="$2"
  local deadline=$((SECONDS + DRAIN_TIMEOUT_S))
  while (( SECONDS < deadline )); do
    if clear_state "${idle_threshold}"; then
      return 0
    fi
    sleep 2
  done
  echo "[error] ${label} did not drain cleanly within ${DRAIN_TIMEOUT_S}s" >&2
  print_state "${label}" "${idle_threshold}"
  return 1
}

remove_managed_containers
kill_listener_pids "${PORT}"
kill_listener_pids "${TRT_PORT}"
for pattern in "${kill_patterns[@]}"; do
  kill_matches "${pattern}"
done

worker_output=""
worker_status=0
if ! worker_output="$(ssh ${WORKER_SSH_OPTS} "${WORKER_SSH}" \
  "PORT='${PORT}' TRT_PORT='${TRT_PORT}' DRAIN_TIMEOUT_S='${DRAIN_TIMEOUT_S}' IDLE_GPU_MEMORY_MIB='${WORKER_IDLE_GPU_MEMORY_MIB}' bash -s" <<'EOF'
set -euo pipefail

PORT="${PORT:?}"
TRT_PORT="${TRT_PORT:?}"
DRAIN_TIMEOUT_S="${DRAIN_TIMEOUT_S:-180}"
IDLE_GPU_MEMORY_MIB="${IDLE_GPU_MEMORY_MIB:-2048}"

managed_containers=(
  trtllm-multinode
  llm-shared
  coder-main-8000
  vllm
)

kill_patterns=(
  'run_dual_spark_trtllm_'
  "^mpirun .*--port ${PORT}"
  "trtllm-serve .*--port ${PORT}"
  '/opt/hpcx/ompi/bin/orted'
  'trtllm-mn-entrypoint'
  'trtllm-mn-entrypoint.sh'
)

listener_pids() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null | sort -u
    return 0
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -Hlnpt "sport = :${port}" 2>/dev/null | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' | sort -u
    return 0
  fi
  return 0
}

published_container_ids() {
  local port="$1"
  docker ps -a --filter "publish=${port}" --format '{{.ID}}'
}

kill_listener_pids() {
  local port="$1"
  while IFS= read -r pid; do
    [[ -n "${pid}" ]] || continue
    kill -9 "${pid}" >/dev/null 2>&1 || true
  done < <(listener_pids "${port}")
}

kill_matches() {
  local pattern="$1"
  while IFS= read -r pid; do
    [[ -n "${pid}" ]] || continue
    [[ "${pid}" == "$$" || "${pid}" == "$PPID" ]] && continue
    kill -9 "${pid}" >/dev/null 2>&1 || true
  done < <(pgrep -f -- "${pattern}" || true)
}

remove_managed_containers() {
  local port
  for name in "${managed_containers[@]}"; do
    docker rm -f "${name}" >/dev/null 2>&1 || true
  done
  for port in "${PORT}" "${TRT_PORT}"; do
    while IFS= read -r stale_id; do
      [[ -n "${stale_id}" ]] || continue
      docker rm -f "${stale_id}" >/dev/null 2>&1 || true
    done < <(published_container_ids "${port}")
  done
}

gpu_compute_pid_count() {
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    echo 0
    return 0
  fi
  nvidia-smi --query-compute-apps=pid --format=csv,noheader,nounits 2>/dev/null | awk 'NF { count += 1 } END { print count + 0 }'
}

max_gpu_memory_mib() {
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    echo 0
    return 0
  fi
  nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | awk '
    BEGIN { max = 0 }
    NF {
      value = $1 + 0
      if (value > max) max = value
    }
    END { print max + 0 }
  '
}

processes_alive() {
  local pattern
  for pattern in "${kill_patterns[@]}"; do
    if pgrep -f -- "${pattern}" >/dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}

clear_state() {
  ! published_container_ids "${PORT}" | grep -q . \
    && ! published_container_ids "${TRT_PORT}" | grep -q . \
    && ! listener_pids "${PORT}" | grep -q . \
    && ! listener_pids "${TRT_PORT}" | grep -q . \
    && ! processes_alive \
    && [[ "$(gpu_compute_pid_count)" == "0" ]] \
    && [[ "$(max_gpu_memory_mib)" -le "${IDLE_GPU_MEMORY_MIB}" ]]
}

print_state() {
  echo "[debug] worker port ${PORT} listeners: $(listener_pids "${PORT}" | tr '\n' ' ' || true)" >&2
  echo "[debug] worker port ${TRT_PORT} listeners: $(listener_pids "${TRT_PORT}" | tr '\n' ' ' || true)" >&2
  echo "[debug] worker published ${PORT}: $(published_container_ids "${PORT}" | tr '\n' ' ' || true)" >&2
  echo "[debug] worker published ${TRT_PORT}: $(published_container_ids "${TRT_PORT}" | tr '\n' ' ' || true)" >&2
  echo "[debug] worker gpu_compute_pids: $(gpu_compute_pid_count)" >&2
  echo "[debug] worker max_gpu_memory_mib: $(max_gpu_memory_mib) (threshold ${IDLE_GPU_MEMORY_MIB})" >&2
}

reason_codes_json() {
  local -a codes=()
  if published_container_ids "${PORT}" | grep -q .; then codes+=("published_container_present"); fi
  if published_container_ids "${TRT_PORT}" | grep -q .; then codes+=("trt_published_container_present"); fi
  if listener_pids "${PORT}" | grep -q .; then codes+=("port_listener_present"); fi
  if listener_pids "${TRT_PORT}" | grep -q .; then codes+=("trt_listener_present"); fi
  if processes_alive; then codes+=("launcher_process_present"); fi
  if [[ "$(gpu_compute_pid_count)" != "0" ]]; then codes+=("gpu_compute_busy"); fi
  if [[ "$(max_gpu_memory_mib)" -gt "${IDLE_GPU_MEMORY_MIB}" ]]; then codes+=("gpu_memory_above_idle"); fi
  printf '%s\n' "${codes[@]}" | python3 -c 'import json,sys; print(json.dumps([line.strip() for line in sys.stdin if line.strip()]))'
}

emit_drain_state() {
  local clear=false
  local reason_codes
  if clear_state; then clear=true; fi
  reason_codes="$(reason_codes_json)"
  printf '{"label":"worker","clear":%s,"reason_codes":%s,"gpu_compute_pid_count":%s,"max_gpu_memory_mib":%s}' \
    "${clear}" \
    "${reason_codes}" \
    "$(gpu_compute_pid_count)" \
    "$(max_gpu_memory_mib)"
}

remove_managed_containers
kill_listener_pids "${PORT}"
kill_listener_pids "${TRT_PORT}"
for pattern in "${kill_patterns[@]}"; do
  kill_matches "${pattern}"
done

deadline=$((SECONDS + DRAIN_TIMEOUT_S))
while (( SECONDS < deadline )); do
  if clear_state; then
    echo "LLMCOMMUNE_WORKER_DRAIN_STATE=$(emit_drain_state)"
    exit 0
  fi
  sleep 2
done

echo "[error] worker did not drain cleanly within ${DRAIN_TIMEOUT_S}s" >&2
print_state
echo "LLMCOMMUNE_WORKER_DRAIN_STATE=$(emit_drain_state)"
exit 1
EOF
 )"; then
  worker_status=$?
fi

worker_state="$(printf '%s\n' "${worker_output}" | sed -n 's/^LLMCOMMUNE_WORKER_DRAIN_STATE=//p' | tail -n 1)"
if [[ -z "${worker_state}" ]]; then
  if (( worker_status == 0 )); then
    worker_state="$(fallback_drain_state "worker" "worker_state_missing")"
  else
    worker_state="$(fallback_drain_state "worker" "worker_command_failed")"
  fi
fi

local_status=0
if ! wait_for_clear_state "large lane" "${LOCAL_IDLE_GPU_MEMORY_MIB}"; then
  local_status=$?
fi
local_state="$(emit_drain_state "local" "${LOCAL_IDLE_GPU_MEMORY_MIB}")"
if (( worker_status == 0 && local_status == 0 )); then
  emit_drain_proof "success" "${local_state}" "${worker_state}"
else
  emit_drain_proof "failed" "${local_state}" "${worker_state}"
fi
if (( worker_status != 0 )); then
  exit "${worker_status}"
fi
if (( local_status != 0 )); then
  exit "${local_status}"
fi

rm -f "${ROOT}/workspace/runtime/large_slot.json"
echo "[ok] stopped LLMCommune large lane on :${PORT} after full drain"
