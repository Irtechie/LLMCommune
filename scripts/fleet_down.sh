#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/admin/apps/LLMCommune"

bash "$ROOT/scripts/stop_mini_lane.sh" >/dev/null 2>&1 || true
bash "$ROOT/scripts/stop_worker_mini_7999.sh" >/dev/null 2>&1 || true
rm -f "$ROOT/workspace/runtime/fleet_state.json"

echo "[ok] stopped LLMCommune mini fleet"
