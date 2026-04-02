#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/admin/apps/LLMCommune"

bash "$ROOT/scripts/stop_alpha_stack.sh"
bash "$ROOT/scripts/start_controller_4000.sh"

echo "[ok] LLMCommune now owns :4000"
