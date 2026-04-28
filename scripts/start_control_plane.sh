#!/usr/bin/env bash
# start_control_plane.sh — Unified startup for the LLMCommune control plane.
# Starts: LLMCommune controller (:4000), Alpha synapse (:4001), Alpha-Gamenator synapse (:4100), Alpha node worker
# Does NOT start any LLMs — watchdog manages those separately.
# Idempotent: safe to re-run while services are already running.
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}!${NC} $*"; }
err()  { echo -e "${RED}✗${NC} $*"; }

ensure_service() {
  local svc="$1"
  local label="$2"
  if systemctl --user is-active --quiet "$svc"; then
    ok "$label already running"
  else
    warn "$label not running — starting..."
    systemctl --user start "$svc"
    sleep 2
    if systemctl --user is-active --quiet "$svc"; then
      ok "$label started"
    else
      err "$label failed to start"; systemctl --user status "$svc" --no-pager -l | tail -10
    fi
  fi
}

echo ""
echo "━━━ LLMCommune Control Plane Startup ━━━"
echo ""

ensure_service llmcommune-controller.service "LLMCommune controller (:4000)"
ensure_service alpha-synapse.service          "Alpha synapse         (:4001)"
ensure_service alpha-gamenator-synapse.service "Alpha-Gamenator synapse (:4100)"
ensure_service alpha-node.service               "Alpha node worker"
ensure_service alpha-cortex-ui.service        "Alpha cortex-ui       (:8080)"

echo ""
echo "━━━ Service Status ━━━"
systemctl --user status llmcommune-controller.service alpha-synapse.service alpha-gamenator-synapse.service \
  --no-pager -l --output=short-iso 2>&1 | grep -E 'Loaded|Active|Main|ago' | head -20

echo ""
echo "Dashboard:  http://192.168.1.203:4000/dashboard"
echo "Cortex UI:  http://192.168.1.203:8080"
echo ""
