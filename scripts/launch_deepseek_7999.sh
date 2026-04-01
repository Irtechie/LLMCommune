#!/usr/bin/env bash
set -euo pipefail

bash /home/admin/apps/LLMCommune/scripts/stop_mini_lane.sh >/dev/null 2>&1 || true

LANE_ID="mini" \
PORT="7999" \
CONTAINER_NAME="coder-deepseek-7999" \
SLOT_LABEL="gguf_deepseek_32b_mini" \
MODEL_PATH="${MODEL_PATH:-/mnt/models/qwen/DeepSeek-R1-Distill-Qwen-32B-Q4_K_M/files/DeepSeek-R1-Distill-Qwen-32B-Q4_K_M.gguf}" \
CTX_SIZE="${CTX_SIZE:-16384}" \
exec bash /home/admin/apps/LLMCommune/scripts/launch_gguf_lane.sh
