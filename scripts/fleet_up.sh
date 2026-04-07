#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/admin/apps/LLMCommune"
STATE_PATH="$ROOT/workspace/runtime/fleet_state.json"
QWEN_LAUNCHER="${QWEN_LAUNCHER:-$ROOT/scripts/launch_trt_single_qwen3_30b_a3b_7999.sh}"
WORKER_LAUNCHER="${WORKER_LAUNCHER:-$ROOT/scripts/launch_worker_deepseek_7999.sh}"
QWEN_BASE_URL="${QWEN_BASE_URL:-http://127.0.0.1:7999}"
DEEPSEEK_BASE_URL="${DEEPSEEK_BASE_URL:-http://192.168.1.204:7999}"
READY_TIMEOUT_SECS="${READY_TIMEOUT_SECS:-1200}"

wait_for_models() {
  local url="$1"
  local label="$2"
  local deadline=$((SECONDS + READY_TIMEOUT_SECS))
  while (( SECONDS < deadline )); do
    if curl -fsS "${url}/v1/models" >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  echo "Timed out waiting for ${label} at ${url}" >&2
  return 1
}

bash "$ROOT/scripts/stop_large_lane.sh" >/dev/null 2>&1 || true
bash "$ROOT/scripts/fleet_down.sh" >/dev/null 2>&1 || true
bash "$ROOT/scripts/stop_mini_lane.sh" >/dev/null 2>&1 || true

bash "$QWEN_LAUNCHER"
wait_for_models "$QWEN_BASE_URL" "spark qwen mini"

bash "$WORKER_LAUNCHER"
wait_for_models "$DEEPSEEK_BASE_URL" "gx10 deepseek mini"

python3 - "$STATE_PATH" <<'PY'
from pathlib import Path
from datetime import datetime, timezone
import json
import sys

state_path = Path(sys.argv[1])
payload = {
    "fleet_id": "mini_qwen30_deepseek32",
    "mode": "mini_pool",
    "state": "ready",
    "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
}
state_path.parent.mkdir(parents=True, exist_ok=True)
state_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

echo "[ok] LLMCommune fleet up:"
echo " - spark qwen: ${QWEN_BASE_URL}"
echo " - gx10 deepseek: ${DEEPSEEK_BASE_URL}"
