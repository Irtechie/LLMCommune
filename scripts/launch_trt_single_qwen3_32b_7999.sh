#!/usr/bin/env bash
set -euo pipefail

export LANE_ID="${LANE_ID:-mini}"
export PORT="${PORT:-7999}"
export CONTAINER_NAME="${CONTAINER_NAME:-llm-trt-mini-7999}"
export SLOT_LABEL="${SLOT_LABEL:-qwen3_32b_nvfp4}"
export MODEL_SPEC="${MODEL_SPEC:-/mnt/models/nvidia/Qwen3-32B-NVFP4/files}"
export DOCKER_IMAGE="${DOCKER_IMAGE:-nvcr.io/nvidia/tensorrt-llm/release:1.2.0rc6}"
export MAX_NUM_TOKENS="${MAX_NUM_TOKENS:-32768}"
export MAX_BATCH_SIZE="${MAX_BATCH_SIZE:-1}"
export API_READY_TIMEOUT_SECS="${API_READY_TIMEOUT_SECS:-900}"

exec bash /home/admin/apps/LLMCommune/scripts/run_single_spark_trtllm_common.sh
