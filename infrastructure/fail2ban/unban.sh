#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$EUID" -eq 0 ]] || { echo 'Run as root' >&2; exit 1; }
: "${1:?Usage: sudo bash infrastructure/fail2ban/unban.sh <jail> <ip>}"
: "${2:?Usage: sudo bash infrastructure/fail2ban/unban.sh <jail> <ip>}"
python3 - "$1" "$2" <<'PY2'
import ipaddress, re, sys
if not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', sys.argv[1]): raise SystemExit('Invalid jail name')
ipaddress.ip_address(sys.argv[2])
PY2
fail2ban-client set "$1" unbanip "$2"
