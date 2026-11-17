#!/usr/bin/env bash
# Download one encrypted remote snapshot and run the isolated local restore drill.
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/infrastructure/backup/offsite-common.sh"
load_offsite_config
command -v restic >/dev/null 2>&1 || { echo 'restic is not installed' >&2; exit 127; }
: "${RESTIC_SNAPSHOT_ID:?Set RESTIC_SNAPSHOT_ID to an exact snapshot ID}"
: "${RESTIC_BACKUP_PATH:?Set RESTIC_BACKUP_PATH to the absolute archive path stored in the snapshot}"
: "${DRILL_DATABASE:?Set a NEW isolated DRILL_DATABASE name}"
: "${RESTORE_STAGING_DIR:?Set an empty isolated RESTORE_STAGING_DIR}"
[[ "$RESTIC_SNAPSHOT_ID" =~ ^[a-fA-F0-9]{8,64}$ ]] || { echo 'Invalid Restic snapshot ID' >&2; exit 2; }
[[ "$RESTIC_BACKUP_PATH" == /* && "$RESTIC_BACKUP_PATH" != *$'\n'* ]] || { echo 'RESTIC_BACKUP_PATH must be an absolute path' >&2; exit 2; }

# Confirm that the selected snapshot belongs to this MailCore host/tag and
# that it actually contains the requested archive path before downloading it.
snapshots="$(restic snapshots --json --host "$RESTIC_HOST")"
python3 -c '
import json, sys
wanted, host, tag, path = sys.argv[1:]
items = json.load(sys.stdin)
matches = [item for item in items if item.get("id", "").lower().startswith(wanted.lower())]
if not matches: raise SystemExit("Selected snapshot does not exist for configured host")
if len(matches) != 1: raise SystemExit("Snapshot ID prefix is ambiguous; provide a longer exact ID")
match = matches[0]
if match.get("hostname") != host or tag not in (match.get("tags") or []): raise SystemExit("Selected snapshot is not tagged for this MailCore host")
if path not in (match.get("paths") or []): raise SystemExit("Requested archive path is not recorded in the selected snapshot")
' "$RESTIC_SNAPSHOT_ID" "$RESTIC_HOST" "$MAILCORE_RESTIC_TAG" "$RESTIC_BACKUP_PATH" <<<"$snapshots"

started_at="$(date +%s)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
archive_name="$(basename "$RESTIC_BACKUP_PATH")"
[[ "$archive_name" =~ ^mail-[0-9]{8}T[0-9]{6}Z\.tar\.gz$ ]] || { echo 'Unexpected MailCore backup filename' >&2; exit 2; }
archive="$work/$archive_name"
restic dump "$RESTIC_SNAPSHOT_ID" "$RESTIC_BACKUP_PATH" > "$archive"
restic dump "$RESTIC_SNAPSHOT_ID" "${RESTIC_BACKUP_PATH}.sha256" > "${archive}.sha256"
verify_local_backup "$archive" >/dev/null

export BACKUP_FILE="$archive" DRILL_DATABASE RESTORE_STAGING_DIR
export RESTORE_DB_MODE="${RESTORE_DB_MODE:-auto}"
bash "$ROOT/infrastructure/disaster-recovery/restore-drill.sh"
elapsed="$(( $(date +%s) - started_at ))"
echo "[PASS] Offsite restore drill completed; end_to_end_restore_seconds=$elapsed snapshot=$RESTIC_SNAPSHOT_ID"
