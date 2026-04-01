#!/usr/bin/env bash
set -euo pipefail

bash /home/admin/apps/LLMCommune/scripts/stop_large_lane.sh >/dev/null 2>&1 || true

LANE_ID="large" \
PORT="8000" \
CONTAINER_NAME="llm-shared" \
SLOT_LABEL="gguf_qwen3_next_80b_large" \
MODEL_PATH="${MODEL_PATH:-/mnt/models/qwen/Qwen3-Next-80B-A3B-Instruct-Q4_K_M/files/Qwen3-Next-80B-A3B-Instruct-Q4_K_M.gguf}" \
CTX_SIZE="${CTX_SIZE:-65536}" \
exec bash /home/admin/apps/LLMCommune/scripts/launch_gguf_lane.sh
