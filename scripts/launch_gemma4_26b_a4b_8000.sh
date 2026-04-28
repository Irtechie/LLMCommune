#!/usr/bin/env bash
set -euo pipefail

bash /home/admin/apps/LLMCommune/scripts/stop_large_lane.sh >/dev/null 2>&1 || true

LANE_ID="large" \
PORT="8000" \
CONTAINER_NAME="gemma4-26b-a4b-8000" \
SLOT_LABEL="gguf_gemma4_26b_a4b_large" \
MODEL_PATH="${MODEL_PATH:-/mnt/models/unsloth/gemma-4-26B-A4B-it-GGUF/files/gemma-4-26B-A4B-it-UD-Q4_K_M.gguf}" \
MMPROJ_PATH="${MMPROJ_PATH:-/mnt/models/unsloth/gemma-4-26B-A4B-it-GGUF/files/mmproj-F16.gguf}" \
NATIVE_SERVER_BIN="${NATIVE_SERVER_BIN:-/home/admin/apps/llama.cpp/build-gemma/bin/llama-server}" \
CTX_SIZE="${CTX_SIZE:-32768}" \
exec bash /home/admin/apps/LLMCommune/scripts/launch_gguf_lane.sh
