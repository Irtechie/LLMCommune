#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8000}"
SLOT_LABEL="${SLOT_LABEL:-llama33_70b}"
MAX_NUM_TOKENS="${MAX_NUM_TOKENS:-131072}"
MAX_BATCH_SIZE="${MAX_BATCH_SIZE:-1}"
FREE_GPU_MEMORY_FRACTION="${FREE_GPU_MEMORY_FRACTION:-0.9}"
MODEL_SPEC="${MODEL_SPEC:-/mnt/models/nvidia/Llama-3.3-70B-Instruct-FP4/files}"

export PORT SLOT_LABEL MAX_NUM_TOKENS MAX_BATCH_SIZE FREE_GPU_MEMORY_FRACTION MODEL_SPEC
exec /home/admin/apps/LLMCommune/scripts/run_dual_spark_trtllm_common.sh
