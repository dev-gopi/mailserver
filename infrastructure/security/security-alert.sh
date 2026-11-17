#!/usr/bin/env bash
set -Eeuo pipefail
severity="${1:?Usage: security-alert.sh <info|notice|warning|critical> <event> <summary>}"
event="${2:?Usage: security-alert.sh <info|notice|warning|critical> <event> <summary>}"
summary="${3:?Usage: security-alert.sh <info|notice|warning|critical> <event> <summary>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec bash "$ROOT/infrastructure/security/send-security-alert.sh" "$severity" mailcore-security "$event" "$summary"
