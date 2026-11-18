#!/usr/bin/env bash
# Staging-only controlled image upgrade with automatic local-image rollback on health failure.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
MODE="${1:---plan}"
case "$MODE" in
  --plan) echo '[PASS] Plan only: capture running image IDs, build/pull updated images, run readiness, restore captured image IDs if readiness fails.'; exit 0 ;;
  --capture) ;;
  --upgrade) ;;
  --rollback) ;;
  *) echo 'Usage: upgrade-rollback-drill.sh [--plan|--capture|--upgrade <snapshot.json>|--rollback <snapshot.json>]' >&2; exit 2 ;;
esac
[[ "${ENVIRONMENT:-}" == staging && "${UPGRADE_ROLLBACK_APPROVED:-NO}" == YES ]] || { echo 'Set ENVIRONMENT=staging and UPGRADE_ROLLBACK_APPROVED=YES' >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { echo 'Docker required' >&2; exit 127; }
command -v python3 >/dev/null 2>&1 || { echo 'Python 3 required' >&2; exit 127; }
REPORT_DIR="$ROOT/infrastructure/reports/security"
mkdir -p "$REPORT_DIR"; chmod 0700 "$REPORT_DIR"
if [[ "$MODE" == --capture ]]; then
  snapshot="$REPORT_DIR/image-state-$(date -u +%Y%m%dT%H%M%SZ).json"
  python3 "$ROOT/infrastructure/upgrade/image-state.py" capture "$snapshot"
  printf '%s\n' "$snapshot"
  exit 0
fi
snapshot="${2:-}"
[[ -n "$snapshot" && -f "$snapshot" && ! -L "$snapshot" ]] || { echo 'A valid image-state JSON snapshot is required' >&2; exit 2; }
if [[ "$MODE" == --rollback ]]; then
  services="$(python3 "$ROOT/infrastructure/upgrade/image-state.py" restore "$snapshot")"
  # shellcheck disable=SC2086
  docker compose up -d --no-build --pull never --force-recreate $services
  bash "$ROOT/infrastructure/tests/production-readiness.sh"
  echo '[PASS] Previous container images restored and readiness checks passed.'
  exit 0
fi
[[ "${BACKUP_VERIFIED:-NO}" == YES && "${UPGRADE_WINDOW:-NO}" == YES ]] || { echo 'Upgrade requires BACKUP_VERIFIED=YES and UPGRADE_WINDOW=YES' >&2; exit 2; }
services="$(python3 "$ROOT/infrastructure/upgrade/image-state.py" restore "$snapshot" | tr '\n' ' ')"
# Capture function also tags old images; restore helper tags the old images back before any upgrade.
if docker compose pull && docker compose up -d --build --remove-orphans; then
  if bash "$ROOT/infrastructure/tests/production-readiness.sh"; then
    echo "[PASS] Staging upgrade passed production-readiness preflight. Rollback snapshot: $snapshot"
    exit 0
  fi
fi
echo '[FAIL] Staging upgrade did not pass readiness; automatically restoring captured image IDs.' >&2
services="$(python3 "$ROOT/infrastructure/upgrade/image-state.py" restore "$snapshot")"
# shellcheck disable=SC2086
docker compose up -d --no-build --pull never --force-recreate $services
bash "$ROOT/infrastructure/tests/production-readiness.sh"
echo '[PASS] Automatic image rollback completed; the attempted upgrade remains failed.' >&2
exit 1
