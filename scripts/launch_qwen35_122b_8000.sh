#!/usr/bin/env bash
set -euo pipefail

bash /home/admin/apps/LLMCommune/scripts/stop_large_lane.sh >/dev/null 2>&1 || true

LANE_ID="large" PORT="8000" CONTAINER_NAME="llm-shared" SLOT_LABEL="gguf_qwen35_122b_large" MODEL_PATH="${MODEL_PATH:-/mnt/models/gguf/Qwen3.5-122B-A10B-Q4_K_M/Q4_K_M/Qwen3.5-122B-A10B-Q4_K_M-00001-of-00003.gguf}" NATIVE_SERVER_BIN="${NATIVE_SERVER_BIN:-/home/admin/apps/llama.cpp/build-gemma/bin/llama-server}" CTX_SIZE="${CTX_SIZE:-32768}" exec bash /home/admin/apps/LLMCommune/scripts/launch_gguf_lane.sh
