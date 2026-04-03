#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8000}"
SLOT_LABEL="${SLOT_LABEL:-qwen235}"
MAX_NUM_TOKENS="${MAX_NUM_TOKENS:-131072}"
MAX_BATCH_SIZE="${MAX_BATCH_SIZE:-1}"
FREE_GPU_MEMORY_FRACTION="${FREE_GPU_MEMORY_FRACTION:-0.95}"
MODEL_SPEC="${MODEL_SPEC:-/mnt/models/nvidia/Qwen3-235B-A22B-NVFP4/files}"

export PORT SLOT_LABEL MAX_NUM_TOKENS MAX_BATCH_SIZE FREE_GPU_MEMORY_FRACTION MODEL_SPEC
exec /home/admin/apps/LLMCommune/scripts/run_dual_spark_trtllm_common.sh
