#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ "$EUID" -eq 0 ]] || { echo 'Run as root' >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo 'systemd required' >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo 'Docker required' >&2; exit 1; }
sed "s|__PROJECT_ROOT__|$ROOT|g" "$ROOT/infrastructure/security/systemd/mailcore-alert-escalation.service" > /etc/systemd/system/mailcore-alert-escalation.service
install -m 0644 "$ROOT/infrastructure/security/systemd/mailcore-alert-escalation.timer" /etc/systemd/system/mailcore-alert-escalation.timer
systemctl daemon-reload
systemctl enable --now mailcore-alert-escalation.timer
systemctl list-timers mailcore-alert-escalation.timer
