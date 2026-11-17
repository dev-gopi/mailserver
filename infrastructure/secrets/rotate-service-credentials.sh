#!/usr/bin/env bash
# Compatibility wrapper: non-mutating plans or dispatch to guarded single-secret rotators.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="${1:-}"
MODE="${2:---dry-run}"
case "$MODE" in --dry-run|--apply) ;; *) echo 'Mode must be --dry-run or --apply' >&2; exit 2 ;; esac
case "$TARGET" in
  api-db) target=api;; postfix-db) target=postfix;; dovecot-db) target=dovecot;; opendkim-db) target=opendkim;; postgres-admin) target=postgres;; redis) target=redis;;
  *) echo 'Usage: rotate-service-credentials.sh {api-db|postfix-db|dovecot-db|opendkim-db|postgres-admin|redis} [--dry-run|--apply]' >&2; exit 2;;
esac
if [[ "$MODE" == --dry-run ]]; then
  echo "[PASS] Rotation plan only. Target=$TARGET; no secrets or services changed."
  exit 0
fi
[[ "${CONFIRM_ROTATION:-NO}" == YES && "${BACKUP_VERIFIED:-NO}" == YES && "${MAINTENANCE_WINDOW:-NO}" == YES ]] || { echo 'Set CONFIRM_ROTATION=YES, BACKUP_VERIFIED=YES and MAINTENANCE_WINDOW=YES.' >&2; exit 2; }
if [[ "$target" == redis ]]; then
  exec bash "$ROOT/infrastructure/secrets/rotate-redis-secret.sh"
fi
exec bash "$ROOT/infrastructure/secrets/rotate-service-db-secret.sh" "$target"
