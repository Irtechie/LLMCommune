#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8000}"
SLOT_LABEL="${SLOT_LABEL:-nemotron120}"
MAX_NUM_TOKENS="${MAX_NUM_TOKENS:-65536}"
MAX_BATCH_SIZE="${MAX_BATCH_SIZE:-1}"
FREE_GPU_MEMORY_FRACTION="${FREE_GPU_MEMORY_FRACTION:-0.85}"
DOCKER_IMAGE="${DOCKER_IMAGE:-nvcr.io/nvidia/tensorrt-llm/release:1.3.0rc9}"
API_READY_TIMEOUT_SECS="${API_READY_TIMEOUT_SECS:-1800}"
DOCKER_PULL_TIMEOUT_SECS="${DOCKER_PULL_TIMEOUT_SECS:-900}"
CONTAINER_BOOT_TIMEOUT_SECS="${CONTAINER_BOOT_TIMEOUT_SECS:-240}"
STARTUP_RETRIES="${STARTUP_RETRIES:-3}"
RETRY_BACKOFF_SECS="${RETRY_BACKOFF_SECS:-20}"
MODEL_SPEC="${MODEL_SPEC:-/mnt/models/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4/files}"
TRTLLM_CONFIG_PATH="${TRTLLM_CONFIG_PATH:-/tmp/nemotron-super-v3.yaml}"
EXTRA_SETUP_SCRIPT='cat >/tmp/nemotron-super-v3.yaml <<EOF
tensor_parallel_size: 2
moe_expert_parallel_size: 2
trust_remote_code: true
enable_attention_dp: true
disable_overlap_scheduler: false
kv_cache_config:
  dtype: "auto"
  enable_block_reuse: false
  free_gpu_memory_fraction: '"$FREE_GPU_MEMORY_FRACTION"'
  mamba_ssm_cache_dtype: float16
cuda_graph_config:
  enable_padding: true
  max_batch_size: '"$MAX_BATCH_SIZE"'
moe_config:
  backend: CUTLASS
EOF'

export PORT SLOT_LABEL MAX_NUM_TOKENS MAX_BATCH_SIZE FREE_GPU_MEMORY_FRACTION DOCKER_IMAGE API_READY_TIMEOUT_SECS DOCKER_PULL_TIMEOUT_SECS CONTAINER_BOOT_TIMEOUT_SECS STARTUP_RETRIES RETRY_BACKOFF_SECS MODEL_SPEC TRTLLM_CONFIG_PATH EXTRA_SETUP_SCRIPT
exec /home/admin/apps/LLMCommune/scripts/run_dual_spark_trtllm_common.sh
