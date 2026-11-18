#!/usr/bin/env bash
# Convenience wrapper to rotate both monitoring credentials serially.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE="${1:---dry-run}"
case "$MODE" in
  --dry-run)
    echo '[PASS] Plan: rotate Prometheus scrape token, then Grafana admin password; each rotation performs consumer checks and rollback.'
    exit 0 ;;
  --apply)
    [[ "${CONFIRM_ROTATION:-NO}" == YES && "${BACKUP_VERIFIED:-NO}" == YES && "${MAINTENANCE_WINDOW:-NO}" == YES ]] || { echo 'Set CONFIRM_ROTATION=YES, BACKUP_VERIFIED=YES and MAINTENANCE_WINDOW=YES.' >&2; exit 2; }
    export CONFIRM_ROTATION=YES BACKUP_VERIFIED=YES MAINTENANCE_WINDOW=YES
    bash "$ROOT/infrastructure/secrets/rotate-monitoring-secret.sh" prometheus_scrape_token
    bash "$ROOT/infrastructure/secrets/rotate-monitoring-secret.sh" grafana_admin_password
    echo '[PASS] Both monitoring credentials rotated successfully.' ;;
  *) echo 'Usage: rotate-monitoring-credentials.sh [--dry-run|--apply]' >&2; exit 2 ;;
esac
