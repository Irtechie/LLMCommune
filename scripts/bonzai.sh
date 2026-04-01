#!/usr/bin/env bash
set -euo pipefail

bash /home/admin/apps/LLMCommune/scripts/stop_mini_lane.sh >/dev/null 2>&1 || true
bash /home/admin/apps/LLMCommune/scripts/stop_large_lane.sh >/dev/null 2>&1 || true
exec bash /home/admin/apps/LLMCommune/scripts/launch_coder_next_8000.sh
