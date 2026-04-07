#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/admin/apps/LLMCommune"

bash "$ROOT/scripts/stop_large_lane.sh" >/dev/null 2>&1 || true

export PORT="${PORT:-8000}"
export SLOT_LABEL="${SLOT_LABEL:-llama33_70b}"
export MAX_NUM_TOKENS="${MAX_NUM_TOKENS:-131072}"
export MODEL_SPEC="${MODEL_SPEC:-/mnt/models/nvidia/Llama-3.3-70B-Instruct-FP4/files}"
export DOCKER_IMAGE="${DOCKER_IMAGE:-nvcr.io/nvidia/tensorrt-llm/release:1.2.0rc6}"
export API_READY_TIMEOUT_SECS="${API_READY_TIMEOUT_SECS:-1800}"
export DOCKER_PULL_TIMEOUT_SECS="${DOCKER_PULL_TIMEOUT_SECS:-900}"
export CONTAINER_BOOT_TIMEOUT_SECS="${CONTAINER_BOOT_TIMEOUT_SECS:-240}"
export STARTUP_RETRIES="${STARTUP_RETRIES:-3}"
export NCCL_IB_DISABLE="${NCCL_IB_DISABLE:-1}"

exec bash "$ROOT/scripts/run_dual_spark_trtllm_llama33_70b.sh"
