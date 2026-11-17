#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ "$EUID" -eq 0 ]] || { echo 'Run as root: sudo bash infrastructure/fail2ban/install.sh' >&2; exit 1; }
export FAIL2BAN_IGNOREIP="${FAIL2BAN_IGNOREIP:-${MAILCORE_FAIL2BAN_IGNOREIP:-127.0.0.1/8 ::1/128}}"
export INSTALL_FAIL2BAN="${INSTALL_FAIL2BAN:-NO}"
exec bash "$ROOT/infrastructure/security/install-fail2ban.sh" --install
