#!/usr/bin/env bash
# Backward-compatible entry point; the plural script is canonical.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec bash "$ROOT/infrastructure/backup/archive-audit-logs.sh" "$@"
