#!/usr/bin/env bash
set -euo pipefail
bash /home/admin/apps/LLMCommune/scripts/stop_mini_lane.sh >/dev/null 2>&1 || true
LANE_ID="mini" \
PORT="7999" \
CONTAINER_NAME="qwen36-7999" \
SLOT_LABEL="gguf_qwen36_35b_mini" \
MODEL_PATH="/mnt/models/gguf/Qwen3.6-35B-A3B-Q4_K_M/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf" \
NATIVE_SERVER_BIN="/home/admin/apps/llama.cpp/build-gemma/bin/llama-server" \
CTX_SIZE="32768" \
exec bash /home/admin/apps/LLMCommune/scripts/launch_gguf_lane.sh