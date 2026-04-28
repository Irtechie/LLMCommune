#!/usr/bin/env bash
set -euo pipefail

export PORT="${PORT:-8000}"
export SLOT_LABEL="${SLOT_LABEL:-qwen35_35b_a3b_nvfp4}"
export MODEL_SPEC="${MODEL_SPEC:-/mnt/models/nvidia/Qwen3.5-35B-A3B-NVFP4/files}"
export DOCKER_IMAGE="${DOCKER_IMAGE:-nvcr.io/nvidia/tensorrt-llm/release:1.3.0rc9}"
export MAX_NUM_TOKENS="${MAX_NUM_TOKENS:-32768}"
export MAX_BATCH_SIZE="${MAX_BATCH_SIZE:-1}"
export API_READY_TIMEOUT_SECS="${API_READY_TIMEOUT_SECS:-900}"

# Mount patched weight mapper for NVFP4 Qwen3.5 support
export EXTRA_DOCKER_ARGS="${EXTRA_DOCKER_ARGS:-} -v /tmp/qwen3_5_weight_mapper_patched.py:/usr/local/lib/python3.12/dist-packages/tensorrt_llm/_torch/models/checkpoints/hf/qwen3_5_weight_mapper.py:ro"

exec bash /home/admin/apps/LLMCommune/scripts/run_single_spark_trtllm_common.sh
