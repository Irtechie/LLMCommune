#!/usr/bin/env bash
set -euo pipefail

bash /home/admin/apps/LLMCommune/scripts/stop_mini_lane.sh >/dev/null 2>&1 || true

LANE_ID="mini" \
PORT="7999" \
CONTAINER_NAME="gemma4-31b-7999" \
SLOT_LABEL="gguf_gemma4_31b_mini" \
MODEL_PATH="${MODEL_PATH:-/mnt/models/google/gemma-4-31B-it-GGUF/files/gemma-4-31B-it-Q4_K_M.gguf}" \
NATIVE_SERVER_BIN="${NATIVE_SERVER_BIN:-/home/admin/apps/llama.cpp/build-gemma/bin/llama-server}" \
CTX_SIZE="${CTX_SIZE:-32768}" \
exec bash /home/admin/apps/LLMCommune/scripts/launch_gguf_lane.sh
