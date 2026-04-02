#!/usr/bin/env bash
set -euo pipefail

mkdir -p "$HOME/.cache/huggingface/hub"
if [[ ! -e "$HOME/.cache/huggingface/hub/models--openai--gpt-oss-120b" ]]; then
  ln -s /mnt/models/openai/gpt-oss-120b/files/models--openai--gpt-oss-120b \
    "$HOME/.cache/huggingface/hub/models--openai--gpt-oss-120b"
fi

PORT="${PORT:-8000}"
SLOT_LABEL="${SLOT_LABEL:-gpt_oss}"
MAX_NUM_TOKENS="${MAX_NUM_TOKENS:-131072}"
MAX_BATCH_SIZE="${MAX_BATCH_SIZE:-1}"
FREE_GPU_MEMORY_FRACTION="${FREE_GPU_MEMORY_FRACTION:-0.95}"
DOCKER_IMAGE="${DOCKER_IMAGE:-nvcr.io/nvidia/tensorrt-llm/release:1.2.0rc6}"
HF_OFFLINE="${HF_OFFLINE:-1}"
MODEL_SPEC="${MODEL_SPEC:-/mnt/models/openai/gpt-oss-120b/files/models--openai--gpt-oss-120b/snapshots/hf-8b193b0-nim}"
API_READY_TIMEOUT_SECS="${API_READY_TIMEOUT_SECS:-900}"
DOCKER_PULL_TIMEOUT_SECS="${DOCKER_PULL_TIMEOUT_SECS:-900}"
CONTAINER_BOOT_TIMEOUT_SECS="${CONTAINER_BOOT_TIMEOUT_SECS:-240}"
STARTUP_RETRIES="${STARTUP_RETRIES:-3}"
# GPT-OSS on dual GX10s has been most stable on the socket transport path.
UCX_NET_DEVICES="${UCX_NET_DEVICES:-enp1s0f0np0}"
NCCL_IB_DISABLE="${NCCL_IB_DISABLE:-1}"
NCCL_DEBUG="${NCCL_DEBUG:-INFO}"
WORKER_SSH="${WORKER_SSH:-admin@192.168.1.204}"
WORKER_SSH_OPTS="${WORKER_SSH_OPTS:--o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i /home/admin/.ssh/trtllm_ed25519}"
ssh $WORKER_SSH_OPTS "$WORKER_SSH" "mkdir -p /mnt/models/openai/gpt-oss-120b/files" || true
TIKTOKEN_RS_CACHE_DIR="${TIKTOKEN_RS_CACHE_DIR:-/tmp/harmony-reqs}"
TIKTOKEN_CACHE_DIR="${TIKTOKEN_CACHE_DIR:-/tmp/tiktoken-cache}"
TIKTOKEN_ENCODINGS_BASE="${TIKTOKEN_ENCODINGS_BASE:-/tmp/harmony-reqs}"
EXTRA_SETUP_SCRIPT='mkdir -p '"$TIKTOKEN_ENCODINGS_BASE"' '"$TIKTOKEN_CACHE_DIR"' /mnt/models/openai/gpt-oss-120b/files/models--openai--gpt-oss-120b/snapshots; wget -q -nc -P '"$TIKTOKEN_ENCODINGS_BASE"' https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken; wget -q -nc -P '"$TIKTOKEN_ENCODINGS_BASE"' https://openaipublic.blob.core.windows.net/encodings/cl100k_base.tiktoken; cp -f '"$TIKTOKEN_ENCODINGS_BASE"'/o200k_base.tiktoken '"$TIKTOKEN_RS_CACHE_DIR"'/fb374d419588a4632f3f557e76b4b70aebbca790; cp -f '"$TIKTOKEN_ENCODINGS_BASE"'/cl100k_base.tiktoken '"$TIKTOKEN_RS_CACHE_DIR"'/9b5ad71b2ce5302211f9c61530b329a4922fc6a4; cp -f '"$TIKTOKEN_RS_CACHE_DIR"'/fb374d419588a4632f3f557e76b4b70aebbca790 '"$TIKTOKEN_CACHE_DIR"'/fb374d419588a4632f3f557e76b4b70aebbca790; cp -f '"$TIKTOKEN_RS_CACHE_DIR"'/9b5ad71b2ce5302211f9c61530b329a4922fc6a4 '"$TIKTOKEN_CACHE_DIR"'/9b5ad71b2ce5302211f9c61530b329a4922fc6a4'

export PORT SLOT_LABEL MAX_NUM_TOKENS MAX_BATCH_SIZE FREE_GPU_MEMORY_FRACTION DOCKER_IMAGE HF_OFFLINE MODEL_SPEC API_READY_TIMEOUT_SECS DOCKER_PULL_TIMEOUT_SECS CONTAINER_BOOT_TIMEOUT_SECS STARTUP_RETRIES UCX_NET_DEVICES NCCL_IB_DISABLE NCCL_DEBUG EXTRA_SETUP_SCRIPT TIKTOKEN_RS_CACHE_DIR TIKTOKEN_CACHE_DIR TIKTOKEN_ENCODINGS_BASE
exec /home/admin/apps/LLMCommune/scripts/run_dual_spark_trtllm_common.sh
