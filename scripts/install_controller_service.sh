#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/admin/apps/LLMCommune"
USER_UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

mkdir -p "$USER_UNIT_DIR" "$ROOT/workspace/runtime"
cp "$ROOT/systemd/llmcommune-controller.service" "$USER_UNIT_DIR/llmcommune-controller.service"
cp "$ROOT/systemd/llmcommune-watchdog.service" "$USER_UNIT_DIR/llmcommune-watchdog.service"

systemctl --user daemon-reload
systemctl --user enable --now llmcommune-controller.service
systemctl --user enable --now llmcommune-watchdog.service

echo "installed user services:"
echo "  $USER_UNIT_DIR/llmcommune-controller.service"
echo "  $USER_UNIT_DIR/llmcommune-watchdog.service"
echo "manage with:"
echo "  systemctl --user status llmcommune-controller.service"
echo "  systemctl --user status llmcommune-watchdog.service"
echo "  systemctl --user restart llmcommune-controller.service"
echo "  systemctl --user restart llmcommune-watchdog.service"
echo "  systemctl --user stop llmcommune-controller.service"
echo "  systemctl --user stop llmcommune-watchdog.service"
