#!/usr/bin/env bash
set -euo pipefail

bash /home/admin/apps/LLMCommune/scripts/stop_large_lane.sh >/dev/null 2>&1 || true

LANE_ID="large" PORT="8000" CONTAINER_NAME="llm-shared" SLOT_LABEL="gguf_gptoss120b_large" MODEL_PATH="${MODEL_PATH:-/mnt/models/gguf/gpt-oss-120b-Q4_K_M/Q4_K_M/gpt-oss-120b-Q4_K_M-00001-of-00002.gguf}" NATIVE_SERVER_BIN="${NATIVE_SERVER_BIN:-/home/admin/apps/llama.cpp/build-gemma/bin/llama-server}" CTX_SIZE="${CTX_SIZE:-32768}" exec bash /home/admin/apps/LLMCommune/scripts/launch_gguf_lane.sh
