#!/usr/bin/env bash
set -euo pipefail

bash /home/admin/apps/LLMCommune/scripts/stop_large_lane.sh >/dev/null 2>&1 || true

LANE_ID="large" \
PORT="8000" \
CONTAINER_NAME="llm-shared" \
SLOT_LABEL="gguf_gemma4_31b_large" \
MODEL_PATH="${MODEL_PATH:-/mnt/models/google/gemma-4-31B-it-GGUF/files/gemma-4-31B-it-Q4_K_M.gguf}" \
MMPROJ_PATH="${MMPROJ_PATH:-/mnt/models/google/gemma-4-31B-it-GGUF/files/mmproj-gemma-4-31B-it-f16.gguf}" \
NATIVE_SERVER_BIN="${NATIVE_SERVER_BIN:-/home/admin/apps/llama.cpp/build-gemma/bin/llama-server}" \
CTX_SIZE="${CTX_SIZE:-262144}" \
exec bash /home/admin/apps/LLMCommune/scripts/launch_gguf_lane.sh
