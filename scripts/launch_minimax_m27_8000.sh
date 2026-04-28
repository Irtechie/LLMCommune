#!/usr/bin/env bash
set -euo pipefail

bash /home/admin/apps/LLMCommune/scripts/stop_large_lane.sh >/dev/null 2>&1 || true

LANE_ID="large" PORT="8000" CONTAINER_NAME="llm-shared" SLOT_LABEL="gguf_minimax_m27_large" MODEL_PATH="${MODEL_PATH:-/mnt/models/unsloth/MiniMax-M2.7-GGUF/UD-IQ4_XS/MiniMax-M2.7-UD-IQ4_XS-00001-of-00004.gguf}" NATIVE_SERVER_BIN="${NATIVE_SERVER_BIN:-/home/admin/apps/llama.cpp/build-gemma/bin/llama-server}" CTX_SIZE="${CTX_SIZE:-16384}" exec bash /home/admin/apps/LLMCommune/scripts/launch_gguf_lane.sh
